import { AzureCliCredential, InteractiveBrowserCredential, TokenCredential } from '@azure/identity';

export const FABRIC_SCOPE  = 'https://api.fabric.microsoft.com/.default';
export const POWERBI_SCOPE = 'https://analysis.windows.net/powerbi/api/.default';

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
