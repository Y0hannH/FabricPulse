import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';

import type {
  BulkMaintenanceProgress,
  ExtToLakehouseMsg,
  Lakehouse,
  LakehouseState,
  LakehouseTable,
  LakehouseToExtMsg,
  Tenant,
  Workspace,
} from '../models/types';
import type { FabricApiService } from '../services/fabricApi';
import type { NotificationLog } from '../services/notificationLog';
import type { StorageService } from '../services/storageService';

// Utility ─────────────────────────────────────────────────────────────────────

function getNonce(): string {
  return crypto.randomBytes(16).toString('hex');
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
function isUuid(s: string): boolean {
  return UUID_RE.test(s);
}

interface MaintenanceOptions {
  vOrder: boolean;
  vacuum: boolean;
  vacuumRetention?: string;
}

/** How a followed maintenance job ended — the four Fabric terminal statuses,
 *  plus: could not start (Error), no final status in time (Timeout), no job id
 *  to follow (Untracked), panel closed while following (Disposed). */
type MaintenanceOutcome =
  'Completed' | 'Failed' | 'Cancelled' | 'Deduped' | 'Error' | 'Timeout' | 'Untracked' | 'Disposed';

const TERMINAL_JOB_STATUSES = new Set(['Completed', 'Failed', 'Cancelled', 'Deduped']);

/** How long a maintenance job is followed before giving up on its final status.
 *  Was 5 minutes: shorter than an Optimize or Vacuum on a large table, which left
 *  statuses stuck although the job did finish in Fabric. */
const MAINTENANCE_FOLLOW_MS = 2 * 60 * 60_000;

function describeMaintenance(o: MaintenanceOptions): string {
  const parts = ['Optimize'];
  if (o.vOrder) parts.push('V-Order');
  if (o.vacuum) parts.push('Vacuum');
  return parts.join(' + ');
}

// ─────────────────────────────────────────────────────────────────────────────

export class LakehousePanel {
  public static currentPanel: LakehousePanel | undefined;
  private static readonly VIEW_TYPE = 'fabricPulseLakehouse';

  private readonly panel: vscode.WebviewPanel;
  private readonly disposables: vscode.Disposable[] = [];

  // Panel state
  private tenants: Tenant[] = [];
  private currentTenantId = '';
  private workspaces: Workspace[] = [];
  private lakehouses: Lakehouse[] = [];
  private selectedWorkspaceId = '';
  private expandedLakehouseId = '';
  private tables: LakehouseTable[] = [];
  private isLoading = false;
  private disposed = false;
  /** Cache table counts per lakehouse after first expand */
  private tableCounts = new Map<string, number>();
  /** Cache computed table sizes — key: `${lakehouseId}:${schema.table}` */
  private tableSizes = new Map<string, number>();
  /** Set to true to cancel an in-progress computeOverviewBatch loop. */
  private overviewBatchCancelled = false;
  /** Bulk maintenance in progress, per lakehouse. Held here rather than in the
   *  webview so reopening the Overview picks the progress back up. */
  private bulkRuns = new Map<string, BulkMaintenanceProgress>();

  // ─── Factory ────────────────────────────────────────────────────────────────

  public static createOrShow(
    extensionUri: vscode.Uri,
    fabricApi: FabricApiService,
    storage: StorageService,
    context: vscode.ExtensionContext,
    notifications: NotificationLog,
  ): LakehousePanel {
    const column = vscode.window.activeTextEditor?.viewColumn ?? vscode.ViewColumn.One;

    if (LakehousePanel.currentPanel) {
      LakehousePanel.currentPanel.panel.reveal(column);
      return LakehousePanel.currentPanel;
    }

    const webviewUri = vscode.Uri.joinPath(extensionUri, 'src', 'webview');
    const panel = vscode.window.createWebviewPanel(
      LakehousePanel.VIEW_TYPE,
      '🗄️ Lakehouses',
      column,
      {
        enableScripts: true,
        retainContextWhenHidden: true,
        localResourceRoots: [webviewUri],
      },
    );

    LakehousePanel.currentPanel = new LakehousePanel(
      panel,
      extensionUri,
      fabricApi,
      storage,
      context,
      notifications,
    );
    return LakehousePanel.currentPanel;
  }

  // ─── Constructor ─────────────────────────────────────────────────────────────

  private constructor(
    panel: vscode.WebviewPanel,
    private readonly extensionUri: vscode.Uri,
    private readonly fabricApi: FabricApiService,
    private readonly storage: StorageService,
    private readonly context: vscode.ExtensionContext,
    private readonly notifications: NotificationLog,
  ) {
    this.panel = panel;

    this.tenants = this.context.globalState.get<Tenant[]>('fabricPulse.tenants', []);
    if (this.tenants.length > 0) {
      this.currentTenantId = this.tenants[0].id;
    }

    this.panel.webview.html = this.buildHtml();

    this.panel.webview.onDidReceiveMessage(
      (msg: LakehouseToExtMsg) => this.handleMessage(msg),
      null,
      this.disposables,
    );

    this.panel.onDidDispose(() => this.dispose(), null, this.disposables);
  }

  // ─── Public ──────────────────────────────────────────────────────────────────

  public async refresh(): Promise<void> {
    if (this.isLoading || !this.currentTenantId) {
      this.postState();
      return;
    }

    this.isLoading = true;
    this.postState();

    const cfg = vscode.workspace.getConfiguration('fabricPulse');
    const blacklist = cfg.get<string[]>('blacklistedWorkspaces', []).map((s) => s.toLowerCase());
    const isBlacklisted = (ws: { id: string; displayName: string }) =>
      blacklist.includes(ws.id.toLowerCase()) || blacklist.includes(ws.displayName.toLowerCase());

    try {
      // Fetch workspaces
      const rawWorkspaces = await this.fabricApi.getWorkspaces(this.currentTenantId);
      this.workspaces = rawWorkspaces
        .filter((ws) => !isBlacklisted(ws))
        .map((ws) => ({
          ...ws,
          isFavorite: this.storage.isWorkspaceFavorite(ws.id),
        }));
      this.postState();

      // Fetch lakehouses
      const filteredWorkspaces = this.selectedWorkspaceId
        ? this.workspaces.filter((w) => w.id === this.selectedWorkspaceId)
        : this.workspaces;

      const allLakehouses: Lakehouse[] = [];

      for (let i = 0; i < filteredWorkspaces.length; i++) {
        if (i > 0) await new Promise((r) => setTimeout(r, 500));
        const ws = filteredWorkspaces[i];
        try {
          const lhs = await this.fabricApi.getLakehouses(this.currentTenantId, ws.id);
          for (const lh of lhs) {
            lh.workspaceName = ws.displayName;
            lh.isFavorite = this.storage.isLakehouseFavorite(lh.id);
            allLakehouses.push(lh);
          }
        } catch (err) {
          console.warn(
            `[FabricPulse] Error fetching lakehouses for workspace ${ws.displayName}:`,
            err,
          );
        }
      }

      this.lakehouses = allLakehouses;

      // Apply cached table counts
      for (const lh of this.lakehouses) {
        const cached = this.tableCounts.get(lh.id);
        if (cached !== undefined) lh.tableCount = cached;
      }

      // If a lakehouse was expanded, re-fetch its tables
      if (this.expandedLakehouseId) {
        const lh = this.lakehouses.find((l) => l.id === this.expandedLakehouseId);
        if (lh) {
          try {
            const fetched = await this.fetchTables(lh);
            // Guard against the expansion changing during the fetch
            if (this.expandedLakehouseId === lh.id) {
              this.tables = fetched;
              this.enrichTablesWithMaintenance(lh.id);
              this.applyCachedSizes(lh.id);
            }
          } catch (err) {
            console.warn('[FabricPulse] Error fetching tables:', err);
            if (this.expandedLakehouseId === lh.id) this.tables = [];
          }
        } else {
          this.expandedLakehouseId = '';
          this.tables = [];
        }
      }
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      this.post({ type: 'toast', message: msg, level: 'error' });
    } finally {
      this.isLoading = false;
      this.postState();
    }
  }

  public reloadTenants(): void {
    this.tenants = this.context.globalState.get<Tenant[]>('fabricPulse.tenants', []);
    if (this.tenants.length > 0 && !this.currentTenantId) {
      this.currentTenantId = this.tenants[0].id;
    }
    this.postState();
  }

  // ─── Message handling ────────────────────────────────────────────────────────

  private validateMsg(msg: LakehouseToExtMsg): boolean {
    const fail = (reason: string) => {
      console.warn(`[FabricPulse][Lakehouse] Invalid message (${msg.type}): ${reason}`);
      return false;
    };

    switch (msg.type) {
      case 'selectTenant':
        if (!isUuid(msg.tenantId)) return fail('bad tenantId');
        break;
      case 'selectWorkspace':
        if (msg.workspaceId && !isUuid(msg.workspaceId)) return fail('bad workspaceId');
        break;
      case 'toggleFavorite':
      case 'expandLakehouse':
        if (!isUuid(msg.lakehouseId) || !isUuid(msg.workspaceId)) return fail('bad id');
        break;
      case 'openInFabric':
        if (!isUuid(msg.lakehouseId) || !isUuid(msg.workspaceId) || !isUuid(msg.tenantId))
          return fail('bad UUID');
        break;
      case 'runMaintenance':
      case 'computeTableSize':
        if (!isUuid(msg.lakehouseId) || !isUuid(msg.workspaceId)) return fail('bad id');
        if (typeof msg.tableName !== 'string' || msg.tableName.length > 256)
          return fail('bad tableName');
        break;
      case 'copyConnectionString':
        if (typeof msg.connectionString !== 'string' || msg.connectionString.length > 1024)
          return fail('bad connectionString');
        break;
      case 'openOverview':
        if (!isUuid(msg.lakehouseId) || !isUuid(msg.workspaceId)) return fail('bad id');
        break;
      case 'computeOverviewBatch':
        if (!isUuid(msg.lakehouseId) || !isUuid(msg.workspaceId)) return fail('bad id');
        if (!Array.isArray(msg.tables) || msg.tables.length > 1000) return fail('bad tables');
        for (const t of msg.tables) {
          if (typeof t.name !== 'string' || t.name.length > 256) return fail('bad table name');
          if (t.schema !== undefined && (typeof t.schema !== 'string' || t.schema.length > 128))
            return fail('bad schema');
        }
        break;
      case 'cancelOverviewBatch':
        break;
      case 'cancelBulkMaintenance':
        if (!isUuid(msg.lakehouseId)) return fail('bad id');
        break;
      case 'runBulkMaintenance':
        if (!isUuid(msg.lakehouseId) || !isUuid(msg.workspaceId)) return fail('bad id');
        if (!Array.isArray(msg.tables) || msg.tables.length === 0 || msg.tables.length > 1000)
          return fail('bad tables');
        for (const t of msg.tables) {
          if (typeof t.name !== 'string' || t.name.length > 256) return fail('bad table name');
          if (t.schema !== undefined && (typeof t.schema !== 'string' || t.schema.length > 128))
            return fail('bad schema');
        }
        if (typeof msg.vOrder !== 'boolean' || typeof msg.vacuum !== 'boolean')
          return fail('bad maintenance options');
        break;
    }
    return true;
  }

  private async handleMessage(msg: LakehouseToExtMsg): Promise<void> {
    if (!this.validateMsg(msg)) return;

    switch (msg.type) {
      case 'ready':
        await this.refresh();
        break;

      case 'refresh':
        await this.refresh();
        break;

      case 'selectTenant':
        this.currentTenantId = msg.tenantId;
        this.workspaces = [];
        this.lakehouses = [];
        this.selectedWorkspaceId = '';
        this.expandedLakehouseId = '';
        this.tables = [];
        await this.refresh();
        break;

      case 'selectWorkspace':
        this.selectedWorkspaceId = msg.workspaceId;
        this.expandedLakehouseId = '';
        this.tables = [];
        await this.refresh();
        break;

      case 'toggleFavorite': {
        const isFav = this.storage.isLakehouseFavorite(msg.lakehouseId);
        if (isFav) {
          this.storage.removeLakehouseFavorite(msg.lakehouseId);
        } else {
          this.storage.addLakehouseFavorite(this.currentTenantId, msg.workspaceId, msg.lakehouseId);
        }
        const lh = this.lakehouses.find((l) => l.id === msg.lakehouseId);
        if (lh) lh.isFavorite = !isFav;
        this.postState();
        break;
      }

      case 'expandLakehouse': {
        if (this.expandedLakehouseId === msg.lakehouseId) {
          // Toggle collapse
          this.expandedLakehouseId = '';
          this.tables = [];
          this.postState();
          break;
        }
        const targetLh = this.lakehouses.find((l) => l.id === msg.lakehouseId);
        if (!targetLh) break;
        this.expandedLakehouseId = msg.lakehouseId;
        this.isLoading = true;
        this.postState();
        try {
          const fetched = await this.fetchTables(targetLh);
          // A newer expand/collapse superseded this one — discard the result
          if (this.expandedLakehouseId !== msg.lakehouseId) break;
          this.tables = fetched;
          this.enrichTablesWithMaintenance(msg.lakehouseId);
          this.applyCachedSizes(msg.lakehouseId);
          // Cache table count
          this.tableCounts.set(msg.lakehouseId, this.tables.length);
          targetLh.tableCount = this.tables.length;
        } catch (err: unknown) {
          if (this.expandedLakehouseId === msg.lakehouseId) this.tables = [];
          this.post({
            type: 'toast',
            message: err instanceof Error ? err.message : String(err),
            level: 'error',
          });
        } finally {
          this.isLoading = false;
          this.postState();
        }
        break;
      }

      case 'collapseLakehouse':
        this.expandedLakehouseId = '';
        this.tables = [];
        this.postState();
        break;

      case 'copyConnectionString':
        await vscode.env.clipboard.writeText(msg.connectionString);
        this.post({
          type: 'toast',
          message: 'Connection string copied to clipboard',
          level: 'success',
          log: false,
        });
        break;

      case 'runMaintenance':
        // Not awaited: the job is followed until it ends (toasts + live status).
        void this.maintainTable(
          this.currentTenantId,
          msg.workspaceId,
          msg.lakehouseId,
          { name: msg.tableName, schema: msg.schemaName },
          { vOrder: msg.vOrder, vacuum: msg.vacuum, vacuumRetention: msg.vacuumRetention },
          false,
        );
        break;

      case 'computeTableSize': {
        try {
          const size = await this.fabricApi.getTableSize(
            this.currentTenantId,
            msg.workspaceId,
            msg.lakehouseId,
            msg.tableName,
            msg.schemaName,
          );
          const key = msg.schemaName ? `${msg.schemaName}.${msg.tableName}` : msg.tableName;
          this.tableSizes.set(`${msg.lakehouseId}:${key}`, size);
          this.storage.upsertTableSize(msg.lakehouseId, key, size);
          const t = this.tables.find(
            (tbl) => (tbl.schema ? `${tbl.schema}.${tbl.name}` : tbl.name) === key,
          );
          if (t) t.sizeBytes = size;
          this.postState();
        } catch (err: unknown) {
          this.post({
            type: 'toast',
            message: err instanceof Error ? err.message : String(err),
            level: 'error',
          });
        } finally {
          this.post({
            type: 'sizeComputed',
            tableName: msg.tableName,
            schemaName: msg.schemaName,
          });
        }
        break;
      }

      case 'openInFabric': {
        const url = `https://app.fabric.microsoft.com/groups/${msg.workspaceId}/lakehouses/${msg.lakehouseId}`;
        await vscode.env.openExternal(vscode.Uri.parse(url));
        break;
      }

      case 'openOverview': {
        const lh = this.lakehouses.find((l) => l.id === msg.lakehouseId);
        if (!lh) break;
        try {
          // Reuse already-fetched tables if this lakehouse is expanded, else fetch
          let tables: LakehouseTable[];
          if (this.expandedLakehouseId === msg.lakehouseId && this.tables.length > 0) {
            tables = this.tables.map((t) => ({ ...t }));
          } else {
            tables = await this.fetchTables(lh);
          }
          this.enrichTablesWithMaintenance(msg.lakehouseId, tables);
          // Merge storage sizes (persisted) with in-memory cache
          const stored = this.storage.getTableSizes(msg.lakehouseId);
          for (const t of tables) {
            const key = t.schema ? `${t.schema}.${t.name}` : t.name;
            const inMem = this.tableSizes.get(`${msg.lakehouseId}:${key}`);
            const onDisk = stored.get(key);
            if (inMem !== undefined) t.sizeBytes = inMem;
            else if (onDisk !== undefined) t.sizeBytes = onDisk;
          }
          this.post({ type: 'overviewReady', lakehouseId: msg.lakehouseId, allTables: tables });
          // A bulk run survives closing the Overview: resume its progress bar.
          const bulkRun = this.bulkRuns.get(msg.lakehouseId);
          if (bulkRun) this.postBulkProgress(bulkRun);
        } catch (err: unknown) {
          this.post({
            type: 'toast',
            message: err instanceof Error ? err.message : String(err),
            level: 'error',
          });
        }
        break;
      }

      case 'computeOverviewBatch': {
        this.overviewBatchCancelled = false;
        const total = msg.tables.length;
        for (let i = 0; i < msg.tables.length; i++) {
          if (this.disposed) return;
          if (this.overviewBatchCancelled) {
            this.post({
              type: 'overviewBatchProgress',
              tableKey: '',
              sizeBytes: 0,
              done: i,
              total,
              cancelled: true,
            });
            break;
          }
          const t = msg.tables[i];
          const key = t.schema ? `${t.schema}.${t.name}` : t.name;
          try {
            const size = await this.fabricApi.getTableSize(
              this.currentTenantId,
              msg.workspaceId,
              msg.lakehouseId,
              t.name,
              t.schema,
            );
            this.tableSizes.set(`${msg.lakehouseId}:${key}`, size);
            this.storage.upsertTableSize(msg.lakehouseId, key, size);
            if (this.expandedLakehouseId === msg.lakehouseId) {
              const tbl = this.tables.find(
                (tb) => (tb.schema ? `${tb.schema}.${tb.name}` : tb.name) === key,
              );
              if (tbl) {
                tbl.sizeBytes = size;
                this.postState();
              }
            }
            this.post({
              type: 'overviewBatchProgress',
              tableKey: key,
              sizeBytes: size,
              done: i + 1,
              total,
            });
          } catch (err) {
            console.warn(`[FabricPulse] Failed to compute size for ${key}:`, err);
            this.post({
              type: 'overviewBatchProgress',
              tableKey: key,
              sizeBytes: -1,
              done: i + 1,
              total,
            });
          }
        }
        break;
      }

      case 'cancelOverviewBatch':
        this.overviewBatchCancelled = true;
        break;

      case 'runBulkMaintenance':
        if (this.bulkRuns.has(msg.lakehouseId)) {
          this.post({
            type: 'toast',
            message:
              'Bulk maintenance is already running on this lakehouse — stop it or wait for it to finish.',
            level: 'warning',
          });
          break;
        }
        // Not awaited: a bulk run can take hours, and progress is pushed as it goes.
        void this.runBulkMaintenance(msg);
        break;

      case 'cancelBulkMaintenance': {
        const run = this.bulkRuns.get(msg.lakehouseId);
        if (run && !run.stopping) {
          run.stopping = true; // workers stop taking tables; running jobs finish
          this.postBulkProgress(run);
        }
        break;
      }
    }
  }

  // ─── Table maintenance ───────────────────────────────────────────────────

  /** Triggers maintenance on one table and follows the job to its end. Every
   *  status change is persisted and pushed to both the Tables panel and the
   *  Overview, so neither has to be reopened to see a job finish.
   *
   *  bulk=false (one table): the start and the outcome are toasts.
   *  bulk=true: nothing is toasted per table — the progress bar covers it — but
   *  failures go to the notification history, with their reason. */
  private async maintainTable(
    tenantId: string,
    workspaceId: string,
    lakehouseId: string,
    table: { name: string; schema?: string },
    options: MaintenanceOptions,
    bulk: boolean,
  ): Promise<MaintenanceOutcome> {
    const desc = describeMaintenance(options);
    const key = table.schema ? `${table.schema}.${table.name}` : table.name;

    let jobInstanceId: string | undefined;
    try {
      const result = await this.fabricApi.triggerTableMaintenance(
        tenantId,
        workspaceId,
        lakehouseId,
        table.name,
        {
          schemaName: table.schema,
          vOrder: options.vOrder,
          vacuum: options.vacuum,
          vacuumRetention: options.vacuumRetention,
        },
      );
      jobInstanceId = result.jobInstanceId;
    } catch (err: unknown) {
      const reason = err instanceof Error ? err.message : String(err);
      // Recorded as a failure (it used to leave no trace) so the table shows up
      // under the Overview's "Failed" filter and can be re-run from there.
      this.setMaintenanceStatus(lakehouseId, key, `${desc} — Failed`, reason);
      const text = `${desc} could not start on "${key}": ${reason}`;
      if (bulk) this.notifications.add('error', 'Lakehouses', text);
      else this.post({ type: 'toast', message: text, level: 'error' });
      return 'Error';
    }

    this.setMaintenanceStatus(lakehouseId, key, `${desc} — InProgress`);
    if (!bulk)
      this.post({ type: 'toast', message: `${desc} triggered for "${key}"`, level: 'success' });

    // No job id to follow (the API answered 202 without one): the status stays
    // InProgress, as it always has in that case.
    if (!jobInstanceId) return 'Untracked';

    return this.followMaintenanceJob(
      tenantId,
      workspaceId,
      lakehouseId,
      jobInstanceId,
      key,
      desc,
      bulk,
    );
  }

  private async followMaintenanceJob(
    tenantId: string,
    workspaceId: string,
    lakehouseId: string,
    jobInstanceId: string,
    key: string,
    desc: string,
    bulk: boolean,
  ): Promise<MaintenanceOutcome> {
    // Tighter for a single table, which the user is watching; looser in bulk,
    // where up to maintenanceConcurrency jobs are followed at once.
    const intervalMs = bulk ? 10_000 : 5_000;
    const deadline = Date.now() + MAINTENANCE_FOLLOW_MS;
    let lastStatus = 'InProgress';

    while (Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, intervalMs));
      if (this.disposed) return 'Disposed';

      let job: Awaited<ReturnType<FabricApiService['getJobInstance']>>;
      try {
        job = await this.fabricApi.getJobInstance(
          tenantId,
          workspaceId,
          lakehouseId,
          jobInstanceId,
        );
      } catch (err) {
        console.warn(`[FabricPulse] Error polling maintenance job ${jobInstanceId}:`, err);
        continue; // transient errors shouldn't stop tracking
      }

      if (job.status !== lastStatus) {
        lastStatus = job.status;
        this.setMaintenanceStatus(lakehouseId, key, `${desc} — ${job.status}`, job.failureReason);
      }

      if (TERMINAL_JOB_STATUSES.has(job.status)) {
        // Deduped: Fabric dropped it because the same job was already running.
        const ok = job.status === 'Completed' || job.status === 'Deduped';
        const text = `${desc} on "${key}": ${job.status}${job.failureReason ? ` — ${job.failureReason}` : ''}`;
        if (!bulk) this.post({ type: 'toast', message: text, level: ok ? 'success' : 'error' });
        else if (!ok) this.notifications.add('error', 'Lakehouses', text);
        return job.status as MaintenanceOutcome;
      }
    }

    this.setMaintenanceStatus(lakehouseId, key, `${desc} — Timeout (still running?)`);
    const text = `${desc} on "${key}": no final status after ${MAINTENANCE_FOLLOW_MS / 3_600_000} h — it may still be running in Fabric`;
    if (bulk) this.notifications.add('warning', 'Lakehouses', text);
    else this.post({ type: 'toast', message: text, level: 'warning' });
    return 'Timeout';
  }

  /** Runs maintenance over many tables with at most maintenanceConcurrency jobs
   *  running at once. Previously every table was triggered back to back without
   *  waiting for any job to end, so 200 tables meant 200 concurrent Spark jobs on
   *  the capacity — the likely source of the failures seen in bulk runs.
   *
   *  A pool rather than fixed batches: the next table starts as soon as any job
   *  ends. Same ceiling on the capacity as batches of that size, without every
   *  batch waiting on its slowest table. */
  private async runBulkMaintenance(
    msg: Extract<LakehouseToExtMsg, { type: 'runBulkMaintenance' }>,
  ): Promise<void> {
    const tenantId = this.currentTenantId;
    const lakehouseName =
      this.lakehouses.find((l) => l.id === msg.lakehouseId)?.displayName ?? msg.lakehouseId;
    const options: MaintenanceOptions = {
      vOrder: msg.vOrder,
      vacuum: msg.vacuum,
      vacuumRetention: msg.vacuumRetention,
    };
    const configured = vscode.workspace
      .getConfiguration('fabricPulse')
      .get<number>('maintenanceConcurrency', 15);
    const concurrency = Math.max(1, Math.min(50, Math.floor(configured) || 15));

    const queue = [...msg.tables];
    const run: BulkMaintenanceProgress = {
      lakehouseId: msg.lakehouseId,
      desc: describeMaintenance(options),
      total: queue.length,
      queued: queue.length,
      running: 0,
      completed: 0,
      failed: 0,
      unknown: 0,
      concurrency,
      stopping: false,
      finished: false,
    };
    /** Jobs started but no longer followed because the panel closed. */
    let interrupted = 0;

    this.bulkRuns.set(msg.lakehouseId, run);
    this.postBulkProgress(run);

    const worker = async (): Promise<void> => {
      while (queue.length > 0 && !run.stopping && !this.disposed) {
        const table = queue.shift()!;
        run.queued--;
        run.running++;
        this.postBulkProgress(run);

        let outcome: MaintenanceOutcome;
        try {
          outcome = await this.maintainTable(
            tenantId,
            msg.workspaceId,
            msg.lakehouseId,
            table,
            options,
            true,
          );
        } catch (err) {
          console.warn('[FabricPulse] Unexpected bulk maintenance error:', err);
          outcome = 'Error';
        }

        run.running--;
        switch (outcome) {
          case 'Completed':
          case 'Deduped':
            run.completed++;
            break;
          case 'Failed':
          case 'Cancelled':
          case 'Error':
            run.failed++;
            break;
          case 'Timeout':
          case 'Untracked':
            run.unknown++;
            break;
          case 'Disposed':
            interrupted++;
            break;
        }
        this.postBulkProgress(run);
      }
    };

    try {
      await Promise.all(Array.from({ length: Math.min(concurrency, run.total) }, () => worker()));
    } finally {
      run.finished = true;
      this.bulkRuns.delete(msg.lakehouseId);
      this.postBulkProgress(run);

      const parts = [`${run.completed} completed`];
      if (run.failed) parts.push(`${run.failed} failed`);
      if (run.unknown) parts.push(`${run.unknown} with no final status`);
      if (run.queued) parts.push(`${run.queued} not started`);
      const verb = this.disposed
        ? 'interrupted (Lakehouses panel closed)'
        : run.stopping
          ? 'stopped'
          : 'finished';
      const tail =
        interrupted > 0 ? ` — ${interrupted} job(s) already started keep running in Fabric` : '';
      // post records the toast before checking for disposal, so this summary
      // reaches the notification history even when the panel is already gone.
      this.post({
        type: 'toast',
        level: run.failed || run.unknown || run.queued || interrupted ? 'warning' : 'success',
        message: `Bulk ${run.desc} on "${lakehouseName}" ${verb}: ${parts.join(', ')}${tail}`,
      });
    }
  }

  private postBulkProgress(run: BulkMaintenanceProgress): void {
    this.post({ type: 'bulkMaintenanceProgress', progress: { ...run } });
  }

  /** Persists a table's maintenance status and pushes it to whichever view shows it. */
  private setMaintenanceStatus(
    lakehouseId: string,
    key: string,
    status: string,
    failureReason?: string,
  ): void {
    this.storage.upsertMaintenance(lakehouseId, key, status);
    this.post({
      type: 'maintenanceStatus',
      lakehouseId,
      tableKey: key,
      status,
      at: new Date().toISOString(),
      failureReason,
    });
    if (this.expandedLakehouseId === lakehouseId) {
      this.enrichTablesWithMaintenance(lakehouseId);
      this.postState();
    }
  }

  // ─── Helpers ───────────────────────────────────────────────────────────────

  private enrichTablesWithMaintenance(lakehouseId: string, tables?: LakehouseTable[]): void {
    const target = tables ?? this.tables;
    const maintenances = this.storage.getAllMaintenances(lakehouseId);
    for (const t of target) {
      const key = t.schema ? `${t.schema}.${t.name}` : t.name;
      const m = maintenances.get(key);
      if (m) {
        t.lastMaintenanceAt = m.triggeredAt;
        t.maintenanceStatus = m.status;
      }
    }
  }

  /** Re-applies sizes from storage + in-memory cache to freshly fetched tables. */
  private applyCachedSizes(lakehouseId: string): void {
    // Seed in-memory cache from storage for any sizes not already in memory
    const stored = this.storage.getTableSizes(lakehouseId);
    for (const [key, size] of stored) {
      const mapKey = `${lakehouseId}:${key}`;
      if (!this.tableSizes.has(mapKey)) this.tableSizes.set(mapKey, size);
    }
    for (const t of this.tables) {
      const key = t.schema ? `${t.schema}.${t.name}` : t.name;
      const cached = this.tableSizes.get(`${lakehouseId}:${key}`);
      if (cached !== undefined) t.sizeBytes = cached;
    }
  }

  /** Schema-enabled lakehouses are listed via OneLake (the Fabric List Tables
   *  API does not support them); regular lakehouses use the Fabric API. */
  private fetchTables(lh: Lakehouse): Promise<LakehouseTable[]> {
    return lh.isSchemaEnabled
      ? this.fabricApi.getSchemaLakehouseTables(this.currentTenantId, lh.workspaceId, lh.id)
      : this.fabricApi.getLakehouseTables(this.currentTenantId, lh.workspaceId, lh.id);
  }

  // ─── State ──────────────────────────────────────────────────────────────────

  private postState(): void {
    const state: LakehouseState = {
      tenants: this.tenants,
      currentTenantId: this.currentTenantId,
      workspaces: this.workspaces,
      lakehouses: this.lakehouses,
      selectedWorkspaceId: this.selectedWorkspaceId,
      expandedLakehouseId: this.expandedLakehouseId,
      tables: this.tables,
      isLoading: this.isLoading,
    };
    this.post({ type: 'updateState', state });
  }

  private post(msg: ExtToLakehouseMsg): void {
    // Toasts fade out after a few seconds, so each one is also recorded — before
    // the disposed check, since one the user never got to see matters most.
    // Info toasts are progress chatter ("Loading history…") and aren't kept.
    if (msg.type === 'toast' && msg.level !== 'info' && msg.log !== false) {
      this.notifications.add(msg.level, 'Lakehouses', msg.message);
    }
    if (this.disposed) return;
    this.panel.webview.postMessage(msg);
  }

  // ─── HTML ────────────────────────────────────────────────────────────────────

  private buildHtml(): string {
    const webviewDir = vscode.Uri.joinPath(this.extensionUri, 'src', 'webview');
    const htmlPath = path.join(webviewDir.fsPath, 'lakehouse.html');
    let html = fs.readFileSync(htmlPath, 'utf-8');

    // Read JS inline so VS Code's webview resource-server cache is bypassed entirely.
    // webview.html is always a fresh string assignment — never cached.
    const jsContent = fs.readFileSync(path.join(webviewDir.fsPath, 'lakehouse.js'), 'utf-8');

    const cssUri = this.panel.webview.asWebviewUri(
      vscode.Uri.joinPath(webviewDir, 'dashboard.css'),
    );
    const overviewCssUri = this.panel.webview.asWebviewUri(
      vscode.Uri.joinPath(webviewDir, 'overview.css'),
    );
    const nonce = getNonce();

    const v = Date.now();
    html = html
      .replace(/\{\{CSS_URI\}\}/g, cssUri.toString() + '?v=' + v)
      .replace(/\{\{OVERVIEW_CSS_URI\}\}/g, overviewCssUri.toString() + '?v=' + v)
      .replace('{{JS_INLINE}}', jsContent)
      .replace(/\{\{NONCE\}\}/g, nonce)
      .replace(/\{\{WEBVIEW_CSP_SOURCE\}\}/g, this.panel.webview.cspSource);

    return html;
  }

  // ─── Dispose ─────────────────────────────────────────────────────────────────

  public dispose(): void {
    this.disposed = true;
    LakehousePanel.currentPanel = undefined;
    this.panel.dispose();
    this.disposables.forEach((d) => d.dispose());
    this.disposables.length = 0;
  }
}
