import fetch from 'node-fetch';
import { AuthService } from './authService';
import { Workspace, Pipeline, PipelineRun, RunStatus } from '../models/types';

const BASE_URL = 'https://api.fabric.microsoft.com/v1';
const MAX_RETRIES = 3;

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
      : retrySecs * 1000;

    console.warn(`[FabricPulse] 429 rate limit on ${label} — retrying in ${waitMs}ms (attempt ${attempt + 1}/${MAX_RETRIES})`);
    await sleep(waitMs);
  }

  // Should never reach here but TypeScript requires a return
  return fn();
}

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

export class FabricApiService {
  constructor(private readonly auth: AuthService) {}

  // ─── Internal helpers ───────────────────────────────────────────────────────

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
      }),
      path.split('?')[0],
    );

    if (!response.ok) {
      // If unauthorized, clear the credential so it gets refreshed on next call
      if (response.status === 401) {
        this.auth.clearCredential(tenantId);
      }
      // Don't expose raw API response bodies — they may leak internal details
      throw new Error(`Fabric API error ${response.status} on ${path.split('?')[0]}`);
    }

    return response.json() as Promise<T>;
  }

  /** Follows continuationUri to fetch all pages.
   *  Capped at MAX_PAGES to prevent unbounded memory usage from a runaway API. */
  private async listAll<T>(tenantId: string, path: string): Promise<T[]> {
    const MAX_PAGES = 50;
    const MAX_ITEMS = 5_000;

    const token = await this.auth.getToken(tenantId);
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

      const currentUrl = url; // capture for closure — url is string here (while guard)
      const response = await fetchWithRetry(
        () => fetch(currentUrl, {
          headers: { 'Authorization': `Bearer ${token}` },
        }),
        path.split('?')[0],
      );

      if (!response.ok) {
        // Don't forward raw API error bodies to UI — they may contain internal details
        throw new Error(`Fabric API error ${response.status} on ${path.split('?')[0]}`);
      }

      const data = await response.json() as FabricListResponse<T>;
      results.push(...(data.value ?? []));
      url = data.continuationUri;
      pages++;
    }

    return results;
  }

  // ─── Public API ─────────────────────────────────────────────────────────────

  async getWorkspaces(tenantId: string): Promise<Workspace[]> {
    const items = await this.listAll<FabricWorkspace>(tenantId, '/workspaces');
    return items
      .filter(w => w.type !== 'Personal') // exclude OneLake personal workspaces
      .map(w => ({
        id: w.id,
        displayName: w.displayName,
        tenantId,
      }));
  }

  async getPipelines(tenantId: string, workspaceId: string): Promise<Pipeline[]> {
    const items = await this.listAll<FabricPipeline>(tenantId, `/workspaces/${workspaceId}/dataPipelines`);
    return items.map(p => ({
      id: p.id,
      displayName: p.displayName,
      workspaceId,
      workspaceName: '', // caller fills this in
      tenantId,
    }));
  }

  async getPipelineRuns(
    tenantId: string,
    workspaceId: string,
    pipelineId: string,
  ): Promise<PipelineRun[]> {
    // The jobs/instances endpoint does not support startTime/endTime filters.
    // Fetch all available instances then sort client-side newest-first.
    const path = `/workspaces/${workspaceId}/dataPipelines/${pipelineId}/jobs/instances`;

    const items = await this.listAll<FabricRun>(tenantId, path);

    const runs = items.map(r => {
      const startIso = r.startTimeUtc ? asUtcIso(r.startTimeUtc) : undefined;
      const endIso   = r.endTimeUtc   ? asUtcIso(r.endTimeUtc)   : undefined;
      const start = startIso ? new Date(startIso).getTime() : undefined;
      const end   = endIso   ? new Date(endIso).getTime()   : undefined;
      const durationMs = start !== undefined && end !== undefined ? end - start : undefined;

      return {
        id: r.id,
        pipelineId,
        runId: r.id,
        status: this.normalizeStatus(r.status),
        startTime: startIso ?? new Date().toISOString(),
        endTime: endIso,
        durationMs,
        errorMessage: r.failureReason?.message,
      };
    });

    // Newest first so runs[0] is always the most recent execution
    runs.sort((a, b) => new Date(b.startTime).getTime() - new Date(a.startTime).getTime());
    return runs;
  }

  /** Fetches only the first page of runs and returns the most recent one.
   *  Used by the dashboard to minimise API calls — one request per pipeline
   *  instead of following all pagination pages. */
  async getLastPipelineRun(
    tenantId: string,
    workspaceId: string,
    pipelineId: string,
  ): Promise<PipelineRun | undefined> {
    const path = `/workspaces/${workspaceId}/dataPipelines/${pipelineId}/jobs/instances`;
    const data = await this.request<FabricListResponse<FabricRun>>(tenantId, path);
    const items = data.value ?? [];
    if (items.length === 0) return undefined;

    const runs = items.map(r => {
      const startIso = r.startTimeUtc ? asUtcIso(r.startTimeUtc) : undefined;
      const endIso   = r.endTimeUtc   ? asUtcIso(r.endTimeUtc)   : undefined;
      const start = startIso ? new Date(startIso).getTime() : undefined;
      const end   = endIso   ? new Date(endIso).getTime()   : undefined;
      return {
        id: r.id,
        pipelineId,
        runId: r.id,
        status: this.normalizeStatus(r.status),
        startTime: startIso ?? new Date().toISOString(),
        endTime: endIso,
        durationMs: start !== undefined && end !== undefined ? end - start : undefined,
        errorMessage: r.failureReason?.message,
      };
    });

    runs.sort((a, b) => new Date(b.startTime).getTime() - new Date(a.startTime).getTime());
    return runs[0];
  }

  /** Returns the new job instance ID */
  async triggerPipeline(tenantId: string, workspaceId: string, pipelineId: string): Promise<string> {
    const result = await this.request<{ id: string }>(
      tenantId,
      `/workspaces/${workspaceId}/dataPipelines/${pipelineId}/jobs/instances?jobType=Pipeline`,
      { method: 'POST', body: '{}' },
    );
    return result.id;
  }

  private normalizeStatus(raw: string): RunStatus {
    switch (raw?.toLowerCase()) {
      case 'succeeded':
      case 'completed':   return 'Succeeded';   // jobs/instances API uses "Completed"
      case 'failed':      return 'Failed';
      case 'inprogress':
      case 'in_progress':
      case 'running':     return 'InProgress';
      case 'cancelled':
      case 'canceled':    return 'Cancelled';
      case 'queued':
      case 'dequeued':    return 'Queued';
      default:            return 'NotStarted';
    }
  }
}
