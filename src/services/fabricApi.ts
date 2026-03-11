import fetch from 'node-fetch';
import { AuthService, POWERBI_SCOPE } from './authService';
import { Workspace, Pipeline, PipelineRun, RunStatus } from '../models/types';

const BASE_URL = 'https://api.fabric.microsoft.com/v1';
const POWERBI_BASE_URL = 'https://api.powerbi.com/v1.0/myorg';
const MAX_RETRIES = 3;
const FETCH_TIMEOUT_MS = 30_000;        // 30 s per request — prevents indefinite hangs
const MAX_RETRY_WAIT_MS = 60_000;       // never wait more than 60 s regardless of Retry-After header

/** Ensure a UTC datetime string from the Fabric API has a trailing 'Z'.
 *  The API returns fields named *Utc but omits the timezone designator,
 *  causing JavaScript to parse them as local time instead of UTC. */
function asUtcIso(s: string): string {
  return s.endsWith('Z') ? s : s + 'Z';
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/** Wraps a fetch call with automatic retry on 429 (rate limit).
 *  Reads the Retry-After header (seconds) and waits before retrying.
 *  Falls back to exponential backoff if the header is absent. */
async function fetchWithRetry(
  fn: () => Promise<import('node-fetch').Response>,
  label: string,
): Promise<import('node-fetch').Response> {
  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    const response = await fn();

    if (response.status !== 429) {
      return response;
    }

    if (attempt === MAX_RETRIES) {
      // Return the 429 response so callers can surface the error normally
      return response;
    }

    const retryAfterHeader = response.headers.get('Retry-After');
    const retrySecs = retryAfterHeader ? parseInt(retryAfterHeader, 10) : NaN;
    const waitMs = isNaN(retrySecs)
      ? Math.min(1000 * 2 ** attempt, 30_000) // exponential backoff, capped at 30 s
      : Math.min(retrySecs * 1000, MAX_RETRY_WAIT_MS);

    console.warn(`[FabricPulse] 429 rate limit on ${label} — retrying in ${waitMs}ms (attempt ${attempt + 1}/${MAX_RETRIES})`);
    await sleep(waitMs);
  }

  // Should never reach here but TypeScript requires a return
  throw new Error(`[FabricPulse] fetchWithRetry: exhausted all retries on ${label}`);
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Throws if any of the given ID strings is not a valid UUID.
 *  Prevents path-injection when IDs are interpolated into API URLs. */
function assertUuids(...ids: string[]): void {
  for (const id of ids) {
    if (!UUID_RE.test(id)) {
      throw new Error(`Invalid UUID: ${id}`);
    }
  }
}

/** Validates that a pagination URL returned by the API points to the expected origin.
 *  Prevents SSRF / token exfiltration if an API response is tampered with. */
function isSafeNextUrl(nextUrl: string, expectedBase: string): boolean {
  try {
    const next = new URL(nextUrl);
    const base = new URL(expectedBase);
    return next.origin === base.origin;
  } catch {
    return false;
  }
}

// ─── Response interfaces ─────────────────────────────────────────────────────

interface FabricListResponse<T> {
  value: T[];
  continuationToken?: string;
  continuationUri?: string;
}

interface FabricWorkspace {
  id: string;
  displayName: string;
  type: string;
}

interface FabricPipeline {
  id: string;
  displayName: string;
  type: string;
}

interface FabricRun {
  id: string;
  itemId?: string;
  jobType?: string;
  invokeType?: string;
  status: string;
  // The jobs/instances API returns UTC-suffixed field names
  startTimeUtc?: string;
  endTimeUtc?: string;
  failureReason?: { message?: string; errorCode?: string };
}

/** Power BI REST API refresh history item (different shape from Fabric jobs/instances). */
interface PbiRefreshItem {
  requestId?: string;                 // GUID — used as runId
  id: number | string;                // internal numeric ID
  refreshType?: string;               // 'Scheduled' | 'Manual' | 'ViaEnhancedApi' | …
  startTime?: string;                 // ISO 8601 (already has Z)
  endTime?: string;                   // ISO 8601 (already has Z)
  status: string;                     // 'Completed' | 'Failed' | 'Unknown' | 'Disabled'
  serviceExceptionJson?: string | null; // JSON-encoded error details
}

interface PbiListResponse<T> {
  value: T[];
  '@odata.context'?: string;
  '@odata.nextLink'?: string;  // OData pagination
}

// ─────────────────────────────────────────────────────────────────────────────

export class FabricApiService {
  constructor(private readonly auth: AuthService) {}

  // ─── Internal helpers — Fabric API ────────────────────────────────────────

  private async request<T>(tenantId: string, path: string, options?: { method?: string; body?: string }): Promise<T> {
    const token = await this.auth.getToken(tenantId);
    const url = `${BASE_URL}${path}`;

    const response = await fetchWithRetry(
      () => fetch(url, {
        method: options?.method ?? 'GET',
        headers: {
          'Authorization': `Bearer ${token}`,
          'Content-Type': 'application/json',
        },
        body: options?.body,
        timeout: FETCH_TIMEOUT_MS,
      }),
      path.split('?')[0],
    );

    if (!response.ok) {
      if (response.status === 401) {
        this.auth.clearCredential(tenantId);
      }
      throw new Error(`Fabric API error ${response.status} on ${path.split('?')[0]}`);
    }

    return response.json() as Promise<T>;
  }

  /** Follows continuationUri to fetch all pages.
   *  Capped at MAX_PAGES to prevent unbounded memory usage from a runaway API. */
  private async listAll<T>(tenantId: string, path: string): Promise<T[]> {
    const MAX_PAGES = 50;
    const MAX_ITEMS = 5_000;

    const results: T[] = [];
    let url: string | undefined = `${BASE_URL}${path}`;
    let pages = 0;

    while (url) {
      if (pages >= MAX_PAGES) {
        console.warn(`[FabricPulse] listAll: hit ${MAX_PAGES}-page limit on ${path}, truncating results`);
        break;
      }
      if (results.length >= MAX_ITEMS) {
        console.warn(`[FabricPulse] listAll: hit ${MAX_ITEMS}-item limit on ${path}, truncating results`);
        break;
      }

      // Refresh token on each page to avoid expiry during long pagination sequences
      const token = await this.auth.getToken(tenantId);
      const currentUrl = url;
      const response = await fetchWithRetry(
        () => fetch(currentUrl, {
          headers: { 'Authorization': `Bearer ${token}` },
          timeout: FETCH_TIMEOUT_MS,
        }),
        path.split('?')[0],
      );

      if (!response.ok) {
        if (response.status === 401) {
          this.auth.clearCredential(tenantId);
        }
        throw new Error(`Fabric API error ${response.status} on ${path.split('?')[0]}`);
      }

      const data = await response.json() as FabricListResponse<T>;
      results.push(...(data.value ?? []));
      const nextUri = data.continuationUri;
      url = nextUri && isSafeNextUrl(nextUri, BASE_URL) ? nextUri : undefined;
      pages++;
    }

    return results;
  }

  // ─── Internal helpers — Power BI REST API ─────────────────────────────────

  /** Single-page request against the Power BI REST API (different base URL + scope). */
  private async requestPbi<T>(tenantId: string, path: string, options?: { method?: string; body?: string }): Promise<T> {
    const token = await this.auth.getToken(tenantId, POWERBI_SCOPE);
    const url = `${POWERBI_BASE_URL}${path}`;

    const response = await fetchWithRetry(
      () => fetch(url, {
        method: options?.method ?? 'GET',
        headers: {
          'Authorization': `Bearer ${token}`,
          'Content-Type': 'application/json',
        },
        body: options?.body,
        timeout: FETCH_TIMEOUT_MS,
      }),
      `[PBI] ${path.split('?')[0]}`,
    );

    if (!response.ok) {
      if (response.status === 401) {
        this.auth.clearCredential(tenantId);
      }
      throw new Error(`Power BI API error ${response.status} on ${path.split('?')[0]}`);
    }

    return response.json() as Promise<T>;
  }

  /** Paginated fetch against the Power BI REST API (OData @odata.nextLink). */
  private async listAllPbi<T>(tenantId: string, path: string): Promise<T[]> {
    const MAX_PAGES = 20;
    const MAX_ITEMS = 5_000;

    const results: T[] = [];
    let url: string | undefined = `${POWERBI_BASE_URL}${path}`;
    let pages = 0;

    while (url) {
      if (pages >= MAX_PAGES || results.length >= MAX_ITEMS) break;

      // Refresh token on each page to avoid expiry during long pagination sequences
      const token = await this.auth.getToken(tenantId, POWERBI_SCOPE);
      const currentUrl = url;
      const response = await fetchWithRetry(
        () => fetch(currentUrl, {
          headers: { 'Authorization': `Bearer ${token}` },
          timeout: FETCH_TIMEOUT_MS,
        }),
        `[PBI] ${path.split('?')[0]}`,
      );

      if (!response.ok) {
        if (response.status === 401) {
          this.auth.clearCredential(tenantId);
        }
        throw new Error(`Power BI API error ${response.status} on ${path.split('?')[0]}`);
      }

      const data = await response.json() as PbiListResponse<T>;
      results.push(...(data.value ?? []));
      const nextLink = data['@odata.nextLink'];
      url = nextLink && isSafeNextUrl(nextLink, POWERBI_BASE_URL) ? nextLink : undefined;
      pages++;
    }

    return results;
  }

  // ─── Run-mapping helpers ──────────────────────────────────────────────────

  /** Maps Fabric jobs/instances items → PipelineRun[] (for data pipelines). */
  private _mapRuns(items: FabricRun[], itemId: string): PipelineRun[] {
    const runs = items.map(r => {
      const startIso = r.startTimeUtc ? asUtcIso(r.startTimeUtc) : undefined;
      const endIso   = r.endTimeUtc   ? asUtcIso(r.endTimeUtc)   : undefined;
      const start = startIso ? new Date(startIso).getTime() : undefined;
      const end   = endIso   ? new Date(endIso).getTime()   : undefined;
      const durationMs = start !== undefined && end !== undefined ? end - start : undefined;

      return {
        id: r.id,
        pipelineId: itemId,
        runId: r.id,
        status: this.normalizeStatus(r.status),
        startTime: startIso,
        endTime: endIso,
        durationMs,
        errorMessage: r.failureReason?.message,
      };
    });

    runs.sort((a, b) => (b.startTime ?? '').localeCompare(a.startTime ?? ''));
    return runs;
  }

  /** Maps Power BI refresh history items → PipelineRun[] (for semantic models).
   *  Different field names: startTime/endTime (no Utc suffix),
   *  requestId (GUID), serviceExceptionJson (JSON string). */
  private _mapRefreshHistory(items: PbiRefreshItem[], modelId: string): PipelineRun[] {
    const runs = items.map(r => {
      const startIso = r.startTime ? asUtcIso(r.startTime) : undefined;
      const endIso   = r.endTime   ? asUtcIso(r.endTime)   : undefined;
      const start = startIso ? new Date(startIso).getTime() : undefined;
      const end   = endIso   ? new Date(endIso).getTime()   : undefined;
      const durationMs = start !== undefined && end !== undefined ? end - start : undefined;

      // Parse error from serviceExceptionJson (JSON-encoded string)
      let errorMessage: string | undefined;
      if (r.serviceExceptionJson) {
        try {
          const exc = JSON.parse(r.serviceExceptionJson);
          errorMessage = exc.errorDescription ?? exc.message ?? exc.errorCode ?? 'Unknown error';
        } catch {
          // Raw JSON is malformed — expose a safe summary instead of the raw string
          errorMessage = 'Refresh failed (unparseable error details)';
        }
      }

      const runId = r.requestId ?? String(r.id);

      return {
        id: runId,
        pipelineId: modelId,
        runId,
        status: this.normalizeStatus(r.status),
        startTime: startIso,
        endTime: endIso,
        durationMs,
        errorMessage,
      };
    });

    runs.sort((a, b) => (b.startTime ?? '').localeCompare(a.startTime ?? ''));
    return runs;
  }

  // ─── Public API — Fabric (workspaces, pipelines) ──────────────────────────

  async getWorkspaces(tenantId: string): Promise<Workspace[]> {
    const items = await this.listAll<FabricWorkspace>(tenantId, '/workspaces');
    return items
      .filter(w => w.type !== 'Personal')
      .map(w => ({
        id: w.id,
        displayName: w.displayName,
        tenantId,
      }));
  }

  async getPipelines(tenantId: string, workspaceId: string): Promise<Pipeline[]> {
    assertUuids(workspaceId);
    const items = await this.listAll<FabricPipeline>(tenantId, `/workspaces/${workspaceId}/dataPipelines`);
    return items.map(p => ({
      id: p.id,
      displayName: p.displayName,
      workspaceId,
      workspaceName: '',
      tenantId,
      itemType: 'pipeline' as const,
    }));
  }

  async getSemanticModels(tenantId: string, workspaceId: string): Promise<Pipeline[]> {
    assertUuids(workspaceId);
    const items = await this.listAll<FabricPipeline>(tenantId, `/workspaces/${workspaceId}/semanticModels`);
    return items.map(p => ({
      id: p.id,
      displayName: p.displayName,
      workspaceId,
      workspaceName: '',
      tenantId,
      itemType: 'semanticModel' as const,
    }));
  }

  // ─── Pipeline runs (Fabric jobs/instances) ────────────────────────────────

  async getPipelineRuns(
    tenantId: string,
    workspaceId: string,
    pipelineId: string,
  ): Promise<PipelineRun[]> {
    assertUuids(workspaceId, pipelineId);
    const path = `/workspaces/${workspaceId}/dataPipelines/${pipelineId}/jobs/instances`;
    const items = await this.listAll<FabricRun>(tenantId, path);
    return this._mapRuns(items, pipelineId);
  }

  /** Fetches only the first page of runs and returns the most recent one. */
  async getLastPipelineRun(
    tenantId: string,
    workspaceId: string,
    pipelineId: string,
  ): Promise<PipelineRun | undefined> {
    assertUuids(workspaceId, pipelineId);
    const path = `/workspaces/${workspaceId}/dataPipelines/${pipelineId}/jobs/instances`;
    const data = await this.request<FabricListResponse<FabricRun>>(tenantId, path);
    const items = data.value ?? [];
    if (items.length === 0) return undefined;
    return this._mapRuns(items, pipelineId)[0];
  }

  /** Returns the new job instance ID (or 'triggered' when the API returns 202 with no body). */
  async triggerPipeline(tenantId: string, workspaceId: string, pipelineId: string): Promise<string> {
    assertUuids(workspaceId, pipelineId);
    const token = await this.auth.getToken(tenantId);
    const path = `/workspaces/${workspaceId}/dataPipelines/${pipelineId}/jobs/instances?jobType=Pipeline`;
    const url = `${BASE_URL}${path}`;

    const response = await fetchWithRetry(
      () => fetch(url, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${token}`,
          'Content-Type': 'application/json',
        },
        body: '{}',
        timeout: FETCH_TIMEOUT_MS,
      }),
      path.split('?')[0],
    );

    if (!response.ok) {
      if (response.status === 401) this.auth.clearCredential(tenantId);
      throw new Error(`Fabric API error ${response.status} on ${path.split('?')[0]}`);
    }

    // 202 Accepted — body may contain the job instance id or be empty
    try {
      const body = await response.json() as { id?: string };
      return body.id ?? 'triggered';
    } catch {
      return 'triggered';
    }
  }

  // ─── Semantic model refreshes (Power BI REST API) ─────────────────────────

  /** Full refresh history via Power BI REST API.
   *  GET https://api.powerbi.com/v1.0/myorg/groups/{wsId}/datasets/{modelId}/refreshes */
  async getSemanticModelRuns(
    tenantId: string,
    workspaceId: string,
    modelId: string,
  ): Promise<PipelineRun[]> {
    assertUuids(workspaceId, modelId);
    const path = `/groups/${workspaceId}/datasets/${modelId}/refreshes`;
    const items = await this.listAllPbi<PbiRefreshItem>(tenantId, path);
    return this._mapRefreshHistory(items, modelId);
  }

  /** Fetches only the most recent refresh (single page, $top=1). */
  async getLastSemanticModelRun(
    tenantId: string,
    workspaceId: string,
    modelId: string,
  ): Promise<PipelineRun | undefined> {
    assertUuids(workspaceId, modelId);
    const path = `/groups/${workspaceId}/datasets/${modelId}/refreshes?$top=1`;
    const data = await this.requestPbi<PbiListResponse<PbiRefreshItem>>(tenantId, path);
    const items = data.value ?? [];
    if (items.length === 0) return undefined;
    return this._mapRefreshHistory(items, modelId)[0];
  }

  /** Triggers a semantic model refresh via Power BI REST API.
   *  POST returns 202 Accepted. */
  async triggerSemanticModelRefresh(tenantId: string, workspaceId: string, modelId: string): Promise<string> {
    assertUuids(workspaceId, modelId);
    const token = await this.auth.getToken(tenantId, POWERBI_SCOPE);
    const url = `${POWERBI_BASE_URL}/groups/${workspaceId}/datasets/${modelId}/refreshes`;

    const response = await fetchWithRetry(
      () => fetch(url, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${token}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ notifyOption: 'NoNotification' }),
        timeout: FETCH_TIMEOUT_MS,
      }),
      '[PBI] /groups/.../datasets/.../refreshes',
    );

    if (!response.ok) {
      if (response.status === 401) this.auth.clearCredential(tenantId);
      throw new Error(`Power BI API error ${response.status} on refresh trigger`);
    }

    // 202 Accepted — body may contain requestId or be empty
    try {
      const body = await response.json() as { requestId?: string };
      return body.requestId ?? 'triggered';
    } catch {
      return 'triggered';
    }
  }

  // ─── Status normalization ─────────────────────────────────────────────────

  private normalizeStatus(raw: string): RunStatus {
    switch (raw?.toLowerCase()) {
      case 'succeeded':
      case 'completed':   return 'Succeeded';
      case 'failed':      return 'Failed';
      case 'inprogress':
      case 'in_progress':
      case 'running':
      case 'unknown':     return 'InProgress';   // PBI uses "Unknown" for in-progress refreshes
      case 'cancelled':
      case 'canceled':
      case 'disabled':    return 'Cancelled';    // PBI uses "Disabled" for disabled refresh schedules
      case 'queued':
      case 'dequeued':    return 'Queued';
      default:            return 'NotStarted';
    }
  }
}
