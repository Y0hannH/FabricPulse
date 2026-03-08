import { AzureCliCredential, InteractiveBrowserCredential, TokenCredential } from '@azure/identity';

const FABRIC_SCOPE = 'https://api.fabric.microsoft.com/.default';

interface CachedToken {
  token: string;
  expiresAt: number; // unix ms
}

export class AuthService {
  private credentials = new Map<string, TokenCredential>();
  private tokenCache = new Map<string, CachedToken>();

  async getToken(tenantId: string): Promise<string> {
    // Return cached token if still valid (with 60s buffer)
    const cached = this.tokenCache.get(tenantId);
    if (cached && cached.expiresAt > Date.now() + 60_000) {
      return cached.token;
    }

    const credential = await this.getCredential(tenantId);
    const tokenResult = await credential.getToken(FABRIC_SCOPE);

    if (!tokenResult) {
      throw new Error(`Failed to acquire access token for tenant ${tenantId}`);
    }

    this.tokenCache.set(tenantId, {
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

  /** Force re-authentication for a tenant (e.g., after token error) */
  clearCredential(tenantId: string): void {
    this.credentials.delete(tenantId);
    this.tokenCache.delete(tenantId);
  }

  clearAll(): void {
    this.credentials.clear();
    this.tokenCache.clear();
  }
}
