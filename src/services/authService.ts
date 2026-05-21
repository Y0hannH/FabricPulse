import { AzureCliCredential, InteractiveBrowserCredential, TokenCredential } from '@azure/identity';

export const FABRIC_SCOPE  = 'https://api.fabric.microsoft.com/.default';
export const POWERBI_SCOPE = 'https://analysis.windows.net/powerbi/api/.default';
/** OneLake DFS (ADLS Gen2) requires a token in the Storage audience. */
export const ONELAKE_SCOPE = 'https://storage.azure.com/.default';

/** Page shown in the browser tab once the interactive sign-in completes.
 *  MSAL writes this verbatim as the response body; browsers content-sniff the
 *  leading <!DOCTYPE html> and render it. */
function authResultPage(opts: {
  accent: string; glyph: string; title: string; message: string;
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

export class AuthService {
  private credentials = new Map<string, TokenCredential>();
  /** Cache key: `${tenantId}:${scope}` — one entry per (tenant, scope) pair. */
  private tokenCache = new Map<string, CachedToken>();
  /** Deduplicates concurrent getToken calls for the same (tenant, scope). */
  private inflight = new Map<string, Promise<string>>();

  async getToken(tenantId: string, scope = FABRIC_SCOPE): Promise<string> {
    const cacheKey = `${tenantId}:${scope}`;
    // Return cached token if still valid (with 60s buffer)
    const cached = this.tokenCache.get(cacheKey);
    if (cached && cached.expiresAt > Date.now() + 60_000) {
      return cached.token;
    }

    // If a token request is already in-flight, piggyback on it
    const pending = this.inflight.get(cacheKey);
    if (pending) { return pending; }

    const promise = this._acquireToken(tenantId, scope, cacheKey);
    this.inflight.set(cacheKey, promise);
    try {
      return await promise;
    } finally {
      this.inflight.delete(cacheKey);
    }
  }

  private async _acquireToken(tenantId: string, scope: string, cacheKey: string): Promise<string> {
    const credential = await this.getCredential(tenantId);
    const tokenResult = await credential.getToken(scope);

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

  /** Force re-authentication for a tenant (clears all scopes for that tenant). */
  clearCredential(tenantId: string): void {
    this.credentials.delete(tenantId);
    // Remove all cached tokens for this tenant (across all scopes)
    for (const key of this.tokenCache.keys()) {
      if (key.startsWith(`${tenantId}:`)) {
        this.tokenCache.delete(key);
      }
    }
  }

  clearAll(): void {
    this.credentials.clear();
    this.tokenCache.clear();
  }
}
