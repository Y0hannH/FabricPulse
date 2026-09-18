import * as vscode from 'vscode';
import { AzureCliCredential, InteractiveBrowserCredential, TokenCredential } from '@azure/identity';

export const FABRIC_SCOPE = 'https://api.fabric.microsoft.com/.default';
export const POWERBI_SCOPE = 'https://analysis.windows.net/powerbi/api/.default';
/** OneLake DFS (ADLS Gen2) requires a token in the Storage audience. */
export const ONELAKE_SCOPE = 'https://storage.azure.com/.default';

/** Page shown in the browser tab once the interactive sign-in completes.
 *  MSAL writes this verbatim as the response body; browsers content-sniff the
 *  leading <!DOCTYPE html> and render it. */
function authResultPage(opts: {
  accent: string;
  glyph: string;
  title: string;
  message: string;
}): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>FabricPulse</title>
<style>
  * { margin: 0; padding: 0; box-sizing: border-box; }
  body {
    font-family: -apple-system, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
    background: #1e1e1e; color: #e4e4e4;
    display: flex; align-items: center; justify-content: center; min-height: 100vh;
  }
  .card {
    background: #252526; border: 1px solid #3c3c3c; border-radius: 12px;
    padding: 44px 52px; text-align: center; max-width: 440px;
  }
  .icon {
    width: 60px; height: 60px; margin: 0 auto 22px; border-radius: 50%;
    display: flex; align-items: center; justify-content: center;
    font-size: 32px; line-height: 1;
    background: ${opts.accent}26; color: ${opts.accent};
  }
  h1 { font-size: 19px; font-weight: 600; margin-bottom: 10px; }
  p { font-size: 13.5px; color: #9d9d9d; line-height: 1.55; }
  .brand {
    margin-top: 26px; font-size: 12px; color: #6e6e6e;
    letter-spacing: .6px; text-transform: uppercase;
  }
  .brand a { color: inherit; text-decoration: none; }
  .brand a:hover { color: #9d9d9d; text-decoration: underline; }
</style>
</head>
<body>
  <div class="card">
    <div class="icon">${opts.glyph}</div>
    <h1>${opts.title}</h1>
    <p>${opts.message}</p>
    <div class="brand">⚡ FabricPulse · <a href="https://evolve-data.fr" target="_blank" rel="noopener noreferrer">evolve-data.fr</a></div>
  </div>
</body>
</html>`;
}

const AUTH_SUCCESS_HTML = authResultPage({
  accent: '#3fb950',
  glyph: '✓',
  title: 'Authentication successful',
  message: "You're signed in to Microsoft Fabric. You can close this tab and return to VS Code.",
});

const AUTH_ERROR_HTML = authResultPage({
  accent: '#f85149',
  glyph: '✕',
  title: 'Authentication failed',
  message: 'Something went wrong during sign-in. Close this tab and try again from VS Code.',
});

interface CachedToken {
  token: string;
  expiresAt: number; // unix ms
}

/** Renew this long before the token actually expires. The buffer is generous on
 *  purpose: the renewal (and, when the refresh token is gone, an interactive
 *  sign-in) then happens while the current token is still usable, so a polling
 *  refresh never has to wait on it. */
const EXPIRY_BUFFER_MS = 5 * 60_000;

/** Hard cap on a single token acquisition. Without it, an interactive sign-in
 *  nobody completes leaves the caller awaiting forever — which used to take the
 *  polling loop down with it. */
const ACQUIRE_TIMEOUT_MS = 120_000;

/** An acquisition still running after this long is almost certainly waiting on
 *  the user to finish signing in: time to surface the re-auth banner. */
const INTERACTIVE_HINT_MS = 8_000;

/** Where a token acquisition stands, for the UI to reflect. */
export type AuthPhase = 'idle' | 'pending' | 'failed';

export interface AuthState {
  tenantId: string;
  phase: AuthPhase;
  message?: string;
}

/** Thrown when an acquisition exceeds ACQUIRE_TIMEOUT_MS — almost always an
 *  interactive sign-in left uncompleted in the browser. */
export class AuthTimeoutError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AuthTimeoutError';
  }
}

export class AuthService {
  private credentials = new Map<string, TokenCredential>();
  /** Cache key: `${tenantId}:${scope}` — one entry per (tenant, scope) pair. */
  private tokenCache = new Map<string, CachedToken>();
  /** Deduplicates concurrent getToken calls for the same (tenant, scope). */
  private inflight = new Map<string, Promise<string>>();
  /** Tenants whose credential came from the Azure CLI probe. Tracked so an
   *  expired CLI session can be swapped for the interactive flow. */
  private cliCredentials = new Set<string>();

  private readonly _onDidChangeAuthState = new vscode.EventEmitter<AuthState>();
  /** Fires as an acquisition becomes interactive ('pending'), succeeds ('idle')
   *  or gives up ('failed'). The dashboard turns this into a re-auth banner. */
  readonly onDidChangeAuthState = this._onDidChangeAuthState.event;

  async getToken(tenantId: string, scope = FABRIC_SCOPE): Promise<string> {
    const cacheKey = `${tenantId}:${scope}`;

    const cached = this.tokenCache.get(cacheKey);
    if (cached && cached.expiresAt > Date.now() + EXPIRY_BUFFER_MS) {
      return cached.token;
    }

    // Piggyback on an acquisition already running for this (tenant, scope).
    // Callers can now time out independently, so this also guarantees a timed-out
    // caller never spawns a second browser window for the same sign-in.
    const running = this.inflight.get(cacheKey);
    if (running) {
      return this._withTimeout(running, tenantId);
    }

    const acquisition = this._acquireToken(tenantId, scope, cacheKey);
    this.inflight.set(cacheKey, acquisition);
    // The stored copy outlives callers that time out, so swallow its rejection
    // here — the caller below still receives it through the race.
    void acquisition
      .catch(() => {
        /* surfaced to the awaiting caller */
      })
      .then(() => {
        if (this.inflight.get(cacheKey) === acquisition) {
          this.inflight.delete(cacheKey);
        }
      });

    return this._withTimeout(acquisition, tenantId);
  }

  /** Races an acquisition against ACQUIRE_TIMEOUT_MS and reports its phase.
   *  On timeout the acquisition is deliberately left running: a browser sign-in
   *  the user finishes late still fills the cache for the next call. */
  private async _withTimeout(acquisition: Promise<string>, tenantId: string): Promise<string> {
    let timeoutTimer: ReturnType<typeof setTimeout> | undefined;

    const timeout = new Promise<never>((_, reject) => {
      timeoutTimer = setTimeout(
        () =>
          reject(
            new AuthTimeoutError(
              `Sign-in for tenant ${tenantId} did not complete within ${Math.round(ACQUIRE_TIMEOUT_MS / 1000)}s`,
            ),
          ),
        ACQUIRE_TIMEOUT_MS,
      );
    });

    const hintTimer = setTimeout(
      () =>
        this._emit({
          tenantId,
          phase: 'pending',
          message: 'Waiting for the Microsoft sign-in to complete in your browser.',
        }),
      INTERACTIVE_HINT_MS,
    );

    try {
      const token = await Promise.race([acquisition, timeout]);
      this._emit({ tenantId, phase: 'idle' });
      return token;
    } catch (err: unknown) {
      this._emit({
        tenantId,
        phase: 'failed',
        message: err instanceof Error ? err.message : String(err),
      });
      throw err;
    } finally {
      clearTimeout(hintTimer);
      if (timeoutTimer) clearTimeout(timeoutTimer);
    }
  }

  private _emit(state: AuthState): void {
    this._onDidChangeAuthState.fire(state);
  }

  private async _acquireToken(tenantId: string, scope: string, cacheKey: string): Promise<string> {
    let credential = await this.getCredential(tenantId);

    let tokenResult;
    try {
      tokenResult = await credential.getToken(scope);
    } catch (err) {
      // An Azure CLI session that expired after the initial probe cannot renew
      // itself from here. Drop it and fall back to the interactive flow rather
      // than failing every refresh until the user runs `az login` again.
      if (!this.cliCredentials.has(tenantId)) throw err;
      console.warn(
        `[FabricPulse] Azure CLI credential no longer valid for tenant ${tenantId} — falling back to browser sign-in`,
      );
      this.credentials.delete(tenantId);
      this.cliCredentials.delete(tenantId);
      credential = await this.getCredential(tenantId);
      tokenResult = await credential.getToken(scope);
    }

    if (!tokenResult) {
      throw new Error(`Failed to acquire access token for tenant ${tenantId}`);
    }

    this.tokenCache.set(cacheKey, {
      token: tokenResult.token,
      expiresAt: tokenResult.expiresOnTimestamp,
    });

    return tokenResult.token;
  }

  private async getCredential(tenantId: string): Promise<TokenCredential> {
    if (this.credentials.has(tenantId)) {
      return this.credentials.get(tenantId)!;
    }

    // Try Azure CLI first — no popup, works for devs who did `az login`
    const cliCredential = new AzureCliCredential({ tenantId });
    try {
      await cliCredential.getToken(FABRIC_SCOPE);
      this.credentials.set(tenantId, cliCredential);
      this.cliCredentials.add(tenantId);
      return cliCredential;
    } catch {
      // CLI not available or not logged in → fall back to browser
    }

    // Interactive browser fallback
    const browserCredential = new InteractiveBrowserCredential({
      tenantId,
      redirectUri: 'http://localhost:8765',
      browserCustomizationOptions: {
        successMessage: AUTH_SUCCESS_HTML,
        errorMessage: AUTH_ERROR_HTML,
      },
    });
    this.credentials.set(tenantId, browserCredential);
    return browserCredential;
  }

  /** Drops the cached access token(s) but *keeps* the credential — and with it
   *  the MSAL refresh token — so the next acquisition can still renew silently.
   *  This is the right response to a first 401: the token expired or was
   *  revoked, which says nothing about the sign-in itself. */
  clearAccessToken(tenantId: string, scope?: string): void {
    if (scope) {
      this.tokenCache.delete(`${tenantId}:${scope}`);
      return;
    }
    for (const key of [...this.tokenCache.keys()]) {
      if (key.startsWith(`${tenantId}:`)) {
        this.tokenCache.delete(key);
      }
    }
  }

  /** Force re-authentication for a tenant (clears all scopes for that tenant).
   *  Discards the refresh token too, so the next call needs a full interactive
   *  sign-in — reserve it for a credential proven invalid. */
  clearCredential(tenantId: string): void {
    this.credentials.delete(tenantId);
    this.cliCredentials.delete(tenantId);
    this.clearAccessToken(tenantId);
  }

  /** Renews the token ahead of expiry, off the refresh path. Errors are
   *  swallowed on purpose: a failed silent renewal reaches the user through the
   *  onDidChangeAuthState banner, not by breaking the caller. */
  async prewarm(tenantId: string, scope = FABRIC_SCOPE): Promise<void> {
    try {
      await this.getToken(tenantId, scope);
    } catch (err) {
      console.warn(`[FabricPulse] Token pre-warm failed for tenant ${tenantId}:`, err);
    }
  }

  /** Full re-authentication, behind the dashboard's "Reconnect" action. */
  async signIn(tenantId: string, scope = FABRIC_SCOPE): Promise<void> {
    this.clearCredential(tenantId);
    await this.getToken(tenantId, scope);
  }

  clearAll(): void {
    this.credentials.clear();
    this.cliCredentials.clear();
    this.tokenCache.clear();
  }

  dispose(): void {
    this._onDidChangeAuthState.dispose();
  }
}
