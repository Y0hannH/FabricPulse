// ─── Domain models ───────────────────────────────────────────────────────────

export type ItemType = 'pipeline' | 'semanticModel' | 'notebook' | 'copyJob' | 'dbtJob';

export interface Tenant {
  id: string; // same as tenantId, used as key
  name: string; // user-defined display name
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
  itemType?: ItemType; // 'pipeline' (default) | 'semanticModel' | 'notebook' | 'copyJob' | 'dbtJob'
}

export type RunStatus =
  'Succeeded' | 'Failed' | 'InProgress' | 'Cancelled' | 'Queued' | 'NotStarted';

export interface PipelineRun {
  id: string;
  pipelineId: string;
  runId: string;
  status: RunStatus;
  startTime?: string;
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
  cachedRunCount?: number;
  nextRunAt?: string; // ISO-8601 UTC of the next scheduled run (computed)
  scheduleSummary?: string; // human-readable schedule description (tooltip)
  scheduleEnabled?: boolean; // false when a schedule exists but is paused
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
  startTime?: string;
  endTime?: string;
  durationMs?: number;
  errorMessage?: string;
  createdAt?: string;
  itemType?: string; // 'pipeline' (default) | 'semanticModel' | 'notebook' | 'copyJob' | 'dbtJob'
}

export interface Annotation {
  id?: number;
  pipelineId: string;
  date: string; // ISO date string
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
  itemType?: string; // 'pipeline' (default) | 'semanticModel' | 'notebook' | 'copyJob' | 'dbtJob'
  /** Names captured when the item was starred. The favorites-only refresh path
   *  rebuilds its view from pipeline_runs, so a favorite with no run recorded
   *  yet is absent from it — without these it had no name to persist and wrote
   *  the GUID. Undefined for favorites starred before this was stored. */
  displayName?: string;
  workspaceName?: string;
}

// ─── Lakehouse models ────────────────────────────────────────────────────────

export interface Lakehouse {
  id: string;
  displayName: string;
  description?: string;
  workspaceId: string;
  workspaceName: string;
  tenantId: string;
  sqlEndpointId?: string;
  connectionString?: string;
  sqlEndpointStatus?: 'InProgress' | 'Success' | 'Failed';
  isSchemaEnabled: boolean;
  defaultSchema?: string;
  isFavorite: boolean;
  tableCount?: number; // cached after first expand
}

export interface LakehouseTable {
  name: string;
  type: 'Managed' | 'External';
  format: string;
  location: string;
  schema?: string; // set for schema-enabled lakehouses (discovered via OneLake)
  sizeBytes?: number; // on-disk footprint, computed on demand
  lastMaintenanceAt?: string;
  maintenanceStatus?: string;
}

export interface LakehouseState {
  tenants: Tenant[];
  currentTenantId: string;
  workspaces: Workspace[];
  lakehouses: Lakehouse[];
  selectedWorkspaceId: string;
  expandedLakehouseId: string;
  tables: LakehouseTable[];
  isLoading: boolean;
  error?: string;
}

// Messages sent FROM lakehouse webview TO extension
export type LakehouseToExtMsg =
  | { type: 'ready' }
  | { type: 'refresh' }
  | { type: 'selectTenant'; tenantId: string }
  | { type: 'selectWorkspace'; workspaceId: string }
  | { type: 'toggleFavorite'; lakehouseId: string; workspaceId: string }
  | { type: 'expandLakehouse'; lakehouseId: string; workspaceId: string }
  | { type: 'collapseLakehouse' }
  | { type: 'copyConnectionString'; connectionString: string }
  | {
      type: 'runMaintenance';
      lakehouseId: string;
      workspaceId: string;
      tableName: string;
      schemaName?: string;
      vOrder: boolean;
      vacuum: boolean;
      vacuumRetention?: string;
    }
  | {
      type: 'computeTableSize';
      lakehouseId: string;
      workspaceId: string;
      tableName: string;
      schemaName?: string;
    }
  | { type: 'openInFabric'; lakehouseId: string; workspaceId: string; tenantId: string }
  | { type: 'openOverview'; lakehouseId: string; workspaceId: string }
  | {
      type: 'computeOverviewBatch';
      lakehouseId: string;
      workspaceId: string;
      tables: Array<{ name: string; schema?: string }>;
    }
  | { type: 'cancelOverviewBatch' }
  | {
      type: 'runBulkMaintenance';
      lakehouseId: string;
      workspaceId: string;
      tables: Array<{ name: string; schema?: string }>;
      vOrder: boolean;
      vacuum: boolean;
      vacuumRetention?: string;
    }
  | { type: 'cancelBulkMaintenance'; lakehouseId: string };

/** Live state of a bulk maintenance run, pushed to the Overview. */
export interface BulkMaintenanceProgress {
  lakehouseId: string;
  desc: string; // e.g. 'Optimize + V-Order + Vacuum'
  total: number;
  queued: number; // not started yet
  running: number; // started, no final status yet
  completed: number; // Completed or Deduped
  failed: number; // Failed, Cancelled, or could not start
  unknown: number; // no final status within the follow window, or no job id
  concurrency: number;
  stopping: boolean; // stop requested: no new table starts, running jobs finish
  finished: boolean;
}

// Messages sent FROM extension TO lakehouse webview
export type ExtToLakehouseMsg =
  | { type: 'updateState'; state: LakehouseState }
  | { type: 'sizeComputed'; tableName: string; schemaName?: string }
  | {
      type: 'toast';
      message: string;
      level: 'info' | 'success' | 'error' | 'warning';
      log?: boolean;
    }
  | { type: 'overviewReady'; lakehouseId: string; allTables: LakehouseTable[] }
  | {
      type: 'overviewBatchProgress';
      tableKey: string;
      sizeBytes: number;
      done: number;
      total: number;
      cancelled?: boolean;
    }
  | { type: 'bulkMaintenanceProgress'; progress: BulkMaintenanceProgress }
  /** One table's maintenance status changed (started, progressed, ended). */
  | {
      type: 'maintenanceStatus';
      lakehouseId: string;
      tableKey: string;
      status: string;
      at: string;
      failureReason?: string;
    };

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
  nextRefreshAt: string;
  isFromCache: boolean;
  isLoading: boolean;
  batchProgress?: { done: number; total: number };
  error?: string;
  /** Set while a sign-in is waiting on the user, or after one failed. Drives the
   *  re-auth banner; absent when authentication is healthy. */
  auth?: { phase: 'pending' | 'failed'; message?: string };
}

export interface HistoryData {
  pipeline: Pipeline;
  runs: StoredRun[];
  annotations: Annotation[];
  period: '7d' | '30d' | '90d' | 'all';
  successRate: number;
  totalRuns: number;
  patterns: PatternWarning[];
  lastCachedAt?: string;
}

// ─── Webview ↔ Extension messages ────────────────────────────────────────────

// Messages sent FROM webview TO extension
export type WebviewToExtMsg =
  | { type: 'ready' }
  | { type: 'refresh' }
  | { type: 'selectTenant'; tenantId: string }
  | { type: 'selectWorkspace'; workspaceId: string }
  | { type: 'toggleFavorite'; pipelineId: string; workspaceId: string; itemType?: ItemType }
  | { type: 'toggleWorkspaceFavorite'; workspaceId: string }
  | { type: 'rerunPipeline'; pipelineId: string; workspaceId: string; itemType?: ItemType }
  | { type: 'refreshPipeline'; pipelineId: string; workspaceId: string; itemType?: ItemType }
  | { type: 'copyRunId'; runId: string }
  | {
      type: 'openInFabric';
      pipelineId: string;
      workspaceId: string;
      tenantId: string;
      itemType?: ItemType;
    }
  | {
      type: 'viewMonitor';
      pipelineId: string;
      workspaceId: string;
      runId?: string;
      itemType?: ItemType;
    }
  | {
      type: 'viewHistory';
      pipelineId: string;
      workspaceId: string;
      pipelineName: string;
      workspaceName: string;
      itemType?: ItemType;
    }
  | { type: 'addTenant' }
  | { type: 'exportHistory'; pipelineId: string }
  | { type: 'fetchPipelineHistory'; pipelineId: string; workspaceId: string; itemType?: ItemType }
  | { type: 'blacklistWorkspace'; workspaceId: string; workspaceName: string }
  | { type: 'setFavoritesOnly'; enabled: boolean }
  | { type: 'reauthenticate' };

// Messages sent FROM extension TO webview (dashboard)
export type ExtToDashMsg =
  | { type: 'updateState'; state: DashboardState }
  /** log: false keeps a pure UI confirmation (e.g. "copied") out of the notification history. */
  | {
      type: 'toast';
      message: string;
      level: 'info' | 'success' | 'error' | 'warning';
      log?: boolean;
    };

// Messages sent FROM extension TO history panel
export type ExtToHistoryMsg =
  | { type: 'historyData'; data: HistoryData }
  | {
      type: 'toast';
      message: string;
      level: 'info' | 'success' | 'error' | 'warning';
      log?: boolean;
    };

// Messages sent FROM history webview TO extension
export type HistoryToExtMsg =
  | { type: 'ready' }
  | { type: 'setPeriod'; period: '7d' | '30d' | '90d' | 'all' }
  | { type: 'addAnnotation'; date: string; note: string }
  | { type: 'exportCsv' }
  | { type: 'exportJson' };
