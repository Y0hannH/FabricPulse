// ─── Domain models ───────────────────────────────────────────────────────────

export interface Tenant {
  id: string;       // same as tenantId, used as key
  name: string;     // user-defined display name
  tenantId: string; // Azure tenant GUID
}

export interface Workspace {
  id: string;
  displayName: string;
  tenantId: string;
  isFavorite?: boolean;
}

export interface Pipeline {
  id: string;
  displayName: string;
  workspaceId: string;
  workspaceName: string;
  tenantId: string;
}

export type RunStatus = 'Succeeded' | 'Failed' | 'InProgress' | 'Cancelled' | 'Queued' | 'NotStarted';

export interface PipelineRun {
  id: string;
  pipelineId: string;
  runId: string;
  status: RunStatus;
  startTime: string;
  endTime?: string;
  durationMs?: number;
  errorMessage?: string;
}

export interface PipelineWithStatus extends Pipeline {
  lastRun?: PipelineRun;
  successRate7d?: number;
  avgDurationMs?: number;
  maxDurationMs?: number;
  minDurationMs?: number;
  isFavorite: boolean;
  alertEnabled: boolean;
  durationThresholdMs?: number;
}

// ─── Storage models ───────────────────────────────────────────────────────────

export interface StoredRun {
  id?: number;
  tenantId: string;
  workspaceId: string;
  pipelineId: string;
  pipelineName: string;
  workspaceName: string;
  runId: string;
  status: string;
  startTime: string;
  endTime?: string;
  durationMs?: number;
  errorMessage?: string;
  createdAt?: string;
}

export interface Annotation {
  id?: number;
  pipelineId: string;
  date: string;  // ISO date string
  note: string;
  createdAt?: string;
}

export interface Favorite {
  id?: number;
  tenantId: string;
  workspaceId: string;
  pipelineId: string;
  alertEnabled: boolean;
  durationThresholdMs?: number;
}

// ─── Pattern detection ────────────────────────────────────────────────────────

export interface PatternWarning {
  type: 'weekday' | 'timerange';
  description: string;
  failureCount: number;
  totalFailures: number;
}

// ─── Panel state ──────────────────────────────────────────────────────────────

export interface DashboardState {
  tenants: Tenant[];
  currentTenantId: string;
  workspaces: Workspace[];
  pipelines: PipelineWithStatus[];
  selectedWorkspaceId: string;
  lastRefreshed: string;
  isFromCache: boolean;
  isLoading: boolean;
  error?: string;
}

export interface HistoryData {
  pipeline: Pipeline;
  runs: StoredRun[];
  annotations: Annotation[];
  period: '7d' | '30d' | '90d' | 'all';
  successRate: number;
  totalRuns: number;
  patterns: PatternWarning[];
}

// ─── Webview ↔ Extension messages ────────────────────────────────────────────

// Messages sent FROM webview TO extension
export type WebviewToExtMsg =
  | { type: 'ready' }
  | { type: 'refresh' }
  | { type: 'selectTenant'; tenantId: string }
  | { type: 'selectWorkspace'; workspaceId: string }
  | { type: 'toggleFavorite'; pipelineId: string; workspaceId: string }
  | { type: 'toggleWorkspaceFavorite'; workspaceId: string }
  | { type: 'rerunPipeline'; pipelineId: string; workspaceId: string }
  | { type: 'refreshPipeline'; pipelineId: string; workspaceId: string }
  | { type: 'copyRunId'; runId: string }
  | { type: 'openInFabric'; pipelineId: string; workspaceId: string; tenantId: string }
  | { type: 'viewHistory'; pipelineId: string; workspaceId: string; pipelineName: string; workspaceName: string }
  | { type: 'addTenant' }
  | { type: 'exportHistory'; pipelineId: string };

// Messages sent FROM extension TO webview (dashboard)
export type ExtToDashMsg =
  | { type: 'updateState'; state: DashboardState }
  | { type: 'toast'; message: string; level: 'info' | 'success' | 'error' | 'warning' };

// Messages sent FROM extension TO history panel
export type ExtToHistoryMsg =
  | { type: 'historyData'; data: HistoryData }
  | { type: 'toast'; message: string; level: 'info' | 'success' | 'error' | 'warning' };

// Messages sent FROM history webview TO extension
export type HistoryToExtMsg =
  | { type: 'ready' }
  | { type: 'setPeriod'; period: '7d' | '30d' | '90d' | 'all' }
  | { type: 'addAnnotation'; date: string; note: string }
  | { type: 'exportCsv' }
  | { type: 'exportJson' };
