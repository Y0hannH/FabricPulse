import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import * as crypto from 'crypto';
import { FabricApiService } from '../services/fabricApi';
import { StorageService } from '../services/storageService';
import { AlertService } from '../services/alertService';
import { ScheduleInfo } from '../services/scheduleService';
import {
  Tenant,
  Workspace,
  PipelineWithStatus,
  PipelineRun,
  DashboardState,
  WebviewToExtMsg,
  ExtToDashMsg,
  ItemType,
} from '../models/types';

// Utility ─────────────────────────────────────────────────────────────────────

/** Cryptographically secure nonce for CSP. Never use Math.random() for nonces. */
function getNonce(): string {
  return crypto.randomBytes(16).toString('hex'); // 128-bit entropy
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
function isUuid(s: string): boolean {
  return UUID_RE.test(s);
}

// ─────────────────────────────────────────────────────────────────────────────

export class DashboardPanel {
  public static currentPanel: DashboardPanel | undefined;
  private static readonly VIEW_TYPE = 'fabricPulseDashboard';

  private readonly _panel: vscode.WebviewPanel;
  private readonly _disposables: vscode.Disposable[] = [];

  // Panel state
  private _tenants: Tenant[] = [];
  private _currentTenantId = '';
  private _workspaces: Workspace[] = [];
  private _pipelines: PipelineWithStatus[] = [];
  private _selectedWorkspaceId = '';
  private _lastRefreshed = '';
  private _nextRefreshAt = '';
  private _isFromCache = false;
  private _isLoading = false;
  private _batchProgress: { done: number; total: number } | undefined = undefined;
  private _disposed = false;
  private _favoritesOnlyMode = false;

  /** itemId → epoch ms of last live API fetch for runs.
   *  Cleared when the workspace or tenant changes so the first load is always live. */
  private _runsFetchedAt = new Map<string, number>();

  /** itemId → last fetched schedule info. Kept across the cache/fetch phases of a
   *  refresh so the "Next Run" column doesn't flicker; cleared on tenant/workspace change. */
  private _schedulesById = new Map<string, ScheduleInfo>();

  // ─── Factory ────────────────────────────────────────────────────────────────

  public static createOrShow(
    extensionUri: vscode.Uri,
    fabricApi: FabricApiService,
    storage: StorageService,
    alertService: AlertService,
    context: vscode.ExtensionContext,
  ): DashboardPanel {
    const column = vscode.window.activeTextEditor?.viewColumn ?? vscode.ViewColumn.One;

    if (DashboardPanel.currentPanel) {
      DashboardPanel.currentPanel._panel.reveal(column);
      return DashboardPanel.currentPanel;
    }

    const webviewUri = vscode.Uri.joinPath(extensionUri, 'src', 'webview');
    const panel = vscode.window.createWebviewPanel(
      DashboardPanel.VIEW_TYPE,
      '⚡ FabricPulse',
      column,
      {
        enableScripts: true,
        retainContextWhenHidden: true,
        localResourceRoots: [webviewUri],
      },
    );

    DashboardPanel.currentPanel = new DashboardPanel(
      panel, extensionUri, fabricApi, storage, alertService, context,
    );
    return DashboardPanel.currentPanel;
  }

  // ─── Constructor ─────────────────────────────────────────────────────────────

  private constructor(
    panel: vscode.WebviewPanel,
    private readonly _extensionUri: vscode.Uri,
    private readonly _fabricApi: FabricApiService,
    private readonly _storage: StorageService,
    private readonly _alertService: AlertService,
    private readonly _context: vscode.ExtensionContext,
  ) {
    this._panel = panel;

    // Load persisted tenants
    this._tenants = this._context.globalState.get<Tenant[]>('fabricPulse.tenants', []);
    if (this._tenants.length > 0) {
      this._currentTenantId = this._tenants[0].id;
    }

    this._panel.webview.html = this._buildHtml();

    this._panel.webview.onDidReceiveMessage(
      (msg: WebviewToExtMsg) => this._handleMessage(msg),
      null,
      this._disposables,
    );

    this._panel.onDidDispose(() => this.dispose(), null, this._disposables);
  }

  // ─── Public ──────────────────────────────────────────────────────────────────

  public setNextRefreshAt(iso: string): void {
    this._nextRefreshAt = iso;
    this._postState();
  }

  public async refresh(force = false): Promise<void> {
    if (this._isLoading) return; // debounce concurrent refreshes

    if (!this._currentTenantId) {
      this._postState();
      return;
    }

    this._isLoading = true;
    this._postState();

    const cfg = vscode.workspace.getConfiguration('fabricPulse');
    const blacklist = (cfg.get<string[]>('blacklistedWorkspaces', [])).map(s => s.toLowerCase());
    const isBlacklisted = (ws: { id: string; displayName: string }) =>
      blacklist.includes(ws.id.toLowerCase()) ||
      blacklist.includes(ws.displayName.toLowerCase());

    try {
      // ── No workspace selected: serve from SQLite cache when possible ──────
      if (!this._selectedWorkspaceId && !force) {
        const cachedWorkspaces = this._storage.getKnownWorkspaces(this._currentTenantId);

        if (cachedWorkspaces.length > 0) {
          // Cache is populated — rebuild the view entirely from SQLite, zero API calls
          this._workspaces = cachedWorkspaces.filter(ws => !isBlacklisted(ws)).map(ws => ({
            ...ws,
            isFavorite: this._storage.isWorkspaceFavorite(ws.id),
          }));

          const cachedItems = this._storage.getKnownPipelines(this._currentTenantId);
          this._pipelines = cachedItems.map(p => {
            const fav = this._storage.getFavorite(p.id);
            const localRun = this._storage.getLastRun(p.id);
            const lastRun: PipelineRun | undefined = localRun
              ? { id: String(localRun.id), pipelineId: p.id, runId: localRun.runId, status: localRun.status as PipelineRun['status'], startTime: localRun.startTime, endTime: localRun.endTime, durationMs: localRun.durationMs, errorMessage: localRun.errorMessage }
              : undefined;
            const { rate } = this._storage.getSuccessRate(p.id, 7);
            const durStats = this._storage.getDurationStats(p.id);
            return {
              ...p,
              itemType: (p.itemType ?? 'pipeline') as ItemType,
              lastRun,
              successRate7d: rate,
              avgDurationMs: durStats.avg,
              maxDurationMs: durStats.max,
              minDurationMs: durStats.min,
              isFavorite: !!fav,
              alertEnabled: fav?.alertEnabled ?? false,
              durationThresholdMs: fav?.durationThresholdMs,
              cachedRunCount: this._storage.getRunCount(p.id),
              ...this._scheduleFields(p.id),
            };
          });

          this._lastRefreshed = new Date().toISOString();
          this._isFromCache = true;

          if (!this._favoritesOnlyMode) {
            // Pure cache mode — no API calls
            await this._alertService.checkAlerts(this._pipelines);
            return; // done — no API calls made
          }

          // Favorites-only mode: show cache immediately, then refresh only stale favorites
          this._postState();

          const pollingMs = cfg.get<number>('pollingInterval', 60) * 1000;
          const favorites = this._storage.getFavorites().filter(f => f.tenantId === this._currentTenantId);
          const wsMap = new Map(this._workspaces.map(w => [w.id, w]));
          const staleFavorites = favorites.filter(f => {
            const lastFetched = this._runsFetchedAt.get(f.pipelineId) ?? 0;
            return (Date.now() - lastFetched) >= pollingMs;
          });

          const favBatchSize = cfg.get<number>('batchSize', 5);
          for (let i = 0; i < staleFavorites.length; i += favBatchSize) {
            const batch = staleFavorites.slice(i, i + favBatchSize);
            await Promise.all(batch.map(async fav => {
              const item = this._pipelines.find(p => p.id === fav.pipelineId);
              let run: PipelineRun | undefined;

              await Promise.all([
                this._fetchSchedule({ id: fav.pipelineId, itemType: fav.itemType as ItemType | undefined }, fav.workspaceId),
                (async () => {
                  try {
                    run = await this._fetchLastRun(fav.workspaceId, fav.pipelineId, fav.itemType as ItemType | undefined);
                    if (run) {
                      this._storage.upsertRunsBatch([{
                        tenantId: this._currentTenantId,
                        workspaceId: fav.workspaceId,
                        pipelineId: fav.pipelineId,
                        pipelineName: item?.displayName ?? fav.pipelineId,
                        workspaceName: wsMap.get(fav.workspaceId)?.displayName ?? fav.workspaceId,
                        runId: run.runId,
                        status: run.status,
                        startTime: run.startTime,
                        endTime: run.endTime,
                        durationMs: run.durationMs,
                        errorMessage: run.errorMessage,
                        itemType: fav.itemType ?? 'pipeline',
                      }]);
                    }
                    this._runsFetchedAt.set(fav.pipelineId, Date.now());
                  } catch (err) {
                    console.warn(`[FabricPulse] Could not fetch run for favorite ${fav.pipelineId}:`, err);
                  }
                })(),
              ]);

              const idx = this._pipelines.findIndex(p => p.id === fav.pipelineId);
              if (idx !== -1) {
                this._pipelines[idx] = {
                  ...this._pipelines[idx],
                  ...(run ? { lastRun: run } : {}),
                  ...this._scheduleFields(fav.pipelineId),
                };
              }
            }));
          }

          this._isFromCache = false;
          this._lastRefreshed = new Date().toISOString();
          await this._alertService.checkAlerts(this._pipelines);
          return;
        }
        // Cache empty (first launch) → fall through to seed it via API
      }

      // ── Workspace selected (or cache empty on first launch) ───────────────
      const rawWorkspaces = await this._fabricApi.getWorkspaces(this._currentTenantId);
      const allWorkspaces = rawWorkspaces.filter(ws => !isBlacklisted(ws));
      if (allWorkspaces.length < rawWorkspaces.length) {
        console.log(`[FabricPulse] Skipping ${rawWorkspaces.length - allWorkspaces.length} blacklisted workspace(s).`);
      }
      this._workspaces = allWorkspaces.map(ws => ({
        ...ws,
        isFavorite: this._storage.isWorkspaceFavorite(ws.id),
      }));
      // Post workspaces immediately so the picker populates before items load
      this._postState();

      const pollingMs    = cfg.get<number>('pollingInterval', 60) * 1000;
      const batchSize    = cfg.get<number>('batchSize', 5);
      const batchDelayMs = cfg.get<number>('batchDelayMs', 2500);
      const batchThreshold = cfg.get<number>('batchThreshold', 10);

      const filteredWorkspaces = (this._selectedWorkspaceId
        ? this._workspaces.filter(w => w.id === this._selectedWorkspaceId)
        : this._workspaces
      ).sort((a, b) => (b.isFavorite ? 1 : 0) - (a.isFavorite ? 1 : 0));

      // ── Phase 1: collect all items (pipelines + semantic models) with cached run data ──
      type ItemMeta = { pipeline: PipelineWithStatus; ws: Workspace };
      const allMeta: ItemMeta[] = [];

      for (let wsIdx = 0; wsIdx < filteredWorkspaces.length; wsIdx++) {
        if (wsIdx > 0) await new Promise(r => setTimeout(r, 500));
        const ws = filteredWorkspaces[wsIdx];

        // Sequential list calls: pipelines first warms up the auth token,
        // then semantic models and notebooks reuse the cached token — avoids parallel auth popups.
        let pipelines: import('../models/types').Pipeline[] = [];
        let models: import('../models/types').Pipeline[] = [];
        let notebooks: import('../models/types').Pipeline[] = [];

        try {
          pipelines = await this._fabricApi.getPipelines(this._currentTenantId, ws.id);
        } catch (err) {
          console.warn(`[FabricPulse] Error fetching pipelines for workspace ${ws.displayName}:`, err);
        }
        try {
          models = await this._fabricApi.getSemanticModels(this._currentTenantId, ws.id);
        } catch (err) {
          console.warn(`[FabricPulse] Error fetching semantic models for workspace ${ws.displayName}:`, err);
        }
        try {
          notebooks = await this._fabricApi.getNotebooks(this._currentTenantId, ws.id);
        } catch (err) {
          console.warn(`[FabricPulse] Error fetching notebooks for workspace ${ws.displayName}:`, err);
        }

        const allItems = [...pipelines, ...models, ...notebooks];

        for (const p of allItems) {
          p.workspaceName = ws.displayName;
          const fav = this._storage.getFavorite(p.id);
          const localRun = this._storage.getLastRun(p.id);
          const lastRun: PipelineRun | undefined = localRun
            ? { id: String(localRun.id), pipelineId: p.id, runId: localRun.runId, status: localRun.status as PipelineRun['status'], startTime: localRun.startTime, endTime: localRun.endTime, durationMs: localRun.durationMs, errorMessage: localRun.errorMessage }
            : undefined;
          const { rate } = this._storage.getSuccessRate(p.id, 7);
          const durStats = this._storage.getDurationStats(p.id);
          allMeta.push({
            ws,
            pipeline: {
              ...p,
              lastRun,
              successRate7d: rate,
              avgDurationMs: durStats.avg,
              maxDurationMs: durStats.max,
              minDurationMs: durStats.min,
              isFavorite: !!fav,
              alertEnabled: fav?.alertEnabled ?? false,
              durationThresholdMs: fav?.durationThresholdMs,
              cachedRunCount: this._storage.getRunCount(p.id),
              ...this._scheduleFields(p.id),
            },
          });
        }
      }

      // Show all items from cache immediately so the UI is populated
      this._pipelines = allMeta.map(m => m.pipeline);
      this._isFromCache = true;
      this._lastRefreshed = new Date().toISOString();
      this._postState();

      // ── Phase 2: fetch fresh runs for stale items, in batches ─────────────
      const staleMeta = allMeta
        .filter(m => {
          if (this._favoritesOnlyMode && !m.pipeline.isFavorite) return false;
          const lastFetched = this._runsFetchedAt.get(m.pipeline.id) ?? 0;
          return (Date.now() - lastFetched) >= pollingMs;
        })
        .sort((a, b) => (b.pipeline.isFavorite ? 1 : 0) - (a.pipeline.isFavorite ? 1 : 0));

      const useBatching = staleMeta.length > batchThreshold;
      const totalBatches = Math.ceil(staleMeta.length / batchSize);

      for (let i = 0; i < staleMeta.length; i += batchSize) {
        if (useBatching && i > 0) {
          await new Promise(r => setTimeout(r, batchDelayMs));
        }

        const batchNum = Math.floor(i / batchSize) + 1;
        if (useBatching) {
          this._batchProgress = { done: batchNum - 1, total: totalBatches };
          this._postState();
        }

        const batch = staleMeta.slice(i, i + batchSize);
        await Promise.all(batch.map(async ({ pipeline, ws }) => {
          let run: PipelineRun | undefined;

          // Runs and schedule are independent calls — fetch them concurrently.
          await Promise.all([
            this._fetchSchedule(pipeline, ws.id),
            (async () => {
              try {
                run = await this._fetchLastRun(ws.id, pipeline.id, pipeline.itemType);
                if (run) {
                  this._storage.upsertRunsBatch([{
                    tenantId: this._currentTenantId,
                    workspaceId: ws.id,
                    pipelineId: pipeline.id,
                    pipelineName: pipeline.displayName,
                    workspaceName: ws.displayName,
                    runId: run.runId,
                    status: run.status,
                    startTime: run.startTime,
                    endTime: run.endTime,
                    durationMs: run.durationMs,
                    errorMessage: run.errorMessage,
                    itemType: pipeline.itemType ?? 'pipeline',
                  }]);
                }
                this._runsFetchedAt.set(pipeline.id, Date.now());
              } catch (err) {
                console.warn(`[FabricPulse] Could not fetch runs for ${pipeline.itemType ?? 'pipeline'} ${pipeline.displayName}:`, err);
              }
            })(),
          ]);

          const idx = this._pipelines.findIndex(x => x.id === pipeline.id);
          if (idx !== -1) {
            this._pipelines[idx] = {
              ...this._pipelines[idx],
              ...(run ? { lastRun: run } : {}),
              ...this._scheduleFields(pipeline.id),
            };
          }
        }));

        if (useBatching) {
          this._batchProgress = { done: batchNum, total: totalBatches };
        }
        this._postState();
      }

      this._batchProgress = undefined;
      this._isFromCache = false;
      this._lastRefreshed = new Date().toISOString();
      await this._alertService.checkAlerts(this._pipelines);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      this._post({ type: 'toast', message: msg, level: 'error' });
    } finally {
      this._isLoading = false;
      this._batchProgress = undefined;
      this._postState();
    }
  }

  public reloadTenants(): void {
    this._tenants = this._context.globalState.get<Tenant[]>('fabricPulse.tenants', []);
    if (this._tenants.length > 0 && !this._currentTenantId) {
      this._currentTenantId = this._tenants[0].id;
    }
    this._postState();
  }

  // ─── Message handling ────────────────────────────────────────────────────────

  /** Runtime validation of webview messages. TypeScript types are erased at
   *  runtime; the webview is a less-trusted context so we validate IDs and
   *  constrain freetext before processing. Returns false if the message is invalid. */
  private _validateMsg(msg: WebviewToExtMsg): boolean {
    const fail = (reason: string) => {
      console.warn(`[FabricPulse] Invalid webview message (${msg.type}): ${reason}`);
      return false;
    };

    switch (msg.type) {
      case 'selectTenant':
        if (!isUuid(msg.tenantId)) return fail('bad tenantId');
        break;

      case 'selectWorkspace':
        if (msg.workspaceId && !isUuid(msg.workspaceId)) return fail('bad workspaceId');
        break;

      case 'toggleWorkspaceFavorite':
        if (!isUuid(msg.workspaceId)) return fail('bad workspaceId');
        break;

      case 'blacklistWorkspace':
        if (!isUuid(msg.workspaceId)) return fail('bad workspaceId');
        if (typeof msg.workspaceName !== 'string' || msg.workspaceName.length > 256) return fail('bad workspaceName');
        break;

      case 'toggleFavorite':
      case 'refreshPipeline':
      case 'fetchPipelineHistory':
      case 'rerunPipeline':
        if (!isUuid(msg.pipelineId) || !isUuid(msg.workspaceId)) return fail('bad pipelineId/workspaceId');
        break;

      case 'openInFabric':
        if (!isUuid(msg.pipelineId) || !isUuid(msg.workspaceId) || !isUuid(msg.tenantId)) return fail('bad UUID');
        break;

      case 'viewMonitor':
        if (!isUuid(msg.pipelineId) || !isUuid(msg.workspaceId)) return fail('bad pipelineId/workspaceId');
        break;

      case 'viewHistory':
        if (!isUuid(msg.pipelineId) || !isUuid(msg.workspaceId)) return fail('bad pipelineId/workspaceId');
        if (typeof msg.pipelineName !== 'string' || msg.pipelineName.length > 256) return fail('bad pipelineName');
        if (typeof msg.workspaceName !== 'string' || msg.workspaceName.length > 256) return fail('bad workspaceName');
        break;

      case 'copyRunId':
        if (typeof msg.runId !== 'string' || msg.runId.length > 128) return fail('bad runId');
        break;

      case 'exportHistory':
        if (!isUuid(msg.pipelineId)) return fail('bad pipelineId');
        break;

      case 'setFavoritesOnly':
        if (typeof msg.enabled !== 'boolean') return fail('bad enabled');
        break;
    }

    return true;
  }

  private async _handleMessage(msg: WebviewToExtMsg): Promise<void> {

    if (!this._validateMsg(msg)) return;

    switch (msg.type) {

      case 'ready':
        await this.refresh();
        break;

      case 'refresh':
        this._runsFetchedAt.clear();
        this._schedulesById.clear();
        await this.refresh(true);
        break;

      case 'selectTenant':
        this._currentTenantId = msg.tenantId;
        this._workspaces = [];
        this._pipelines = [];
        this._selectedWorkspaceId = '';
        this._runsFetchedAt.clear();
        this._schedulesById.clear();
        await this.refresh();
        break;

      case 'selectWorkspace':
        this._selectedWorkspaceId = msg.workspaceId;
        this._runsFetchedAt.clear(); // force live fetch on first load of a workspace
        this._schedulesById.clear();
        await this.refresh();
        break;

      case 'toggleWorkspaceFavorite': {
        const isFavWs = this._storage.isWorkspaceFavorite(msg.workspaceId);
        if (isFavWs) {
          this._storage.removeWorkspaceFavorite(msg.workspaceId);
        } else {
          this._storage.addWorkspaceFavorite(msg.workspaceId);
        }
        const ws = this._workspaces.find(w => w.id === msg.workspaceId);
        if (ws) ws.isFavorite = !isFavWs;
        this._postState();
        break;
      }

      case 'blacklistWorkspace': {
        const cfg2 = vscode.workspace.getConfiguration('fabricPulse');
        const current = cfg2.get<string[]>('blacklistedWorkspaces', []);
        if (!current.includes(msg.workspaceId)) {
          await cfg2.update('blacklistedWorkspaces', [...current, msg.workspaceId], vscode.ConfigurationTarget.Global);
        }
        this._workspaces = this._workspaces.filter(w => w.id !== msg.workspaceId);
        if (this._selectedWorkspaceId === msg.workspaceId) {
          this._selectedWorkspaceId = '';
        }
        this._pipelines = this._pipelines.filter(p => p.workspaceId !== msg.workspaceId);
        this._postState();
        this._post({ type: 'toast', message: `"${msg.workspaceName}" ajouté à la blacklist`, level: 'info' });
        break;
      }

      case 'toggleFavorite': {
        const isFav = this._storage.isFavorite(msg.pipelineId);
        if (isFav) {
          this._storage.removeFavorite(msg.pipelineId);
        } else {
          this._storage.addFavorite({
            tenantId: this._currentTenantId,
            workspaceId: msg.workspaceId,
            pipelineId: msg.pipelineId,
            alertEnabled: false,
            itemType: msg.itemType ?? 'pipeline',
          });
        }
        // Optimistic update in local state
        const pl = this._pipelines.find(p => p.id === msg.pipelineId);
        if (pl) {
          pl.isFavorite = !isFav;
          if (isFav) pl.alertEnabled = false;
        }
        this._postState();
        break;
      }

      case 'refreshPipeline': {
        const target = this._pipelines.find(p => p.id === msg.pipelineId);
        if (!target) break;
        try {
          const itemType = (msg.itemType ?? target.itemType) as ItemType | undefined;
          const run = await this._fetchLastRun(msg.workspaceId, msg.pipelineId, itemType);
          if (run) {
            this._storage.upsertRunsBatch([{
              tenantId: this._currentTenantId,
              workspaceId: msg.workspaceId,
              pipelineId: msg.pipelineId,
              pipelineName: target.displayName,
              workspaceName: target.workspaceName,
              runId: run.runId,
              status: run.status,
              startTime: run.startTime,
              endTime: run.endTime,
              durationMs: run.durationMs,
              errorMessage: run.errorMessage,
              itemType: target.itemType ?? 'pipeline',
            }]);
          }
          this._runsFetchedAt.set(msg.pipelineId, Date.now());
          await this._fetchSchedule({ id: msg.pipelineId, itemType }, msg.workspaceId);
          const { rate } = this._storage.getSuccessRate(msg.pipelineId, 7);
          const durStats = this._storage.getDurationStats(msg.pipelineId);
          const idx = this._pipelines.findIndex(p => p.id === msg.pipelineId);
          if (idx !== -1) {
            this._pipelines[idx] = {
              ...this._pipelines[idx],
              lastRun: run,
              successRate7d: rate,
              avgDurationMs: durStats.avg,
              maxDurationMs: durStats.max,
              minDurationMs: durStats.min,
              ...this._scheduleFields(msg.pipelineId),
            };
          }
          this._postState();
        } catch (err: unknown) {
          this._post({ type: 'toast', message: err instanceof Error ? err.message : String(err), level: 'error' });
        }
        break;
      }

      case 'fetchPipelineHistory': {
        const target = this._pipelines.find(p => p.id === msg.pipelineId);
        if (!target) break;
        this._post({ type: 'toast', message: `Fetching history for "${target.displayName}"…`, level: 'info' });
        try {
          const itemType = (msg.itemType ?? target.itemType) as ItemType | undefined;
          const runs = await this._fetchAllRuns(msg.workspaceId, msg.pipelineId, itemType);
          if (runs.length > 0) {
            this._storage.upsertRunsBatch(runs.map(r => ({
              tenantId: this._currentTenantId,
              workspaceId: msg.workspaceId,
              pipelineId: msg.pipelineId,
              pipelineName: target.displayName,
              workspaceName: target.workspaceName,
              runId: r.runId,
              status: r.status,
              startTime: r.startTime,
              endTime: r.endTime,
              durationMs: r.durationMs,
              errorMessage: r.errorMessage,
              itemType: target.itemType ?? 'pipeline',
            })));
          }
          this._runsFetchedAt.set(msg.pipelineId, Date.now());
          const { rate } = this._storage.getSuccessRate(msg.pipelineId, 7);
          const durStats = this._storage.getDurationStats(msg.pipelineId);
          const idx = this._pipelines.findIndex(p => p.id === msg.pipelineId);
          if (idx !== -1) {
            this._pipelines[idx] = {
              ...this._pipelines[idx],
              lastRun: runs[0],
              successRate7d: rate,
              avgDurationMs: durStats.avg,
              maxDurationMs: durStats.max,
              minDurationMs: durStats.min,
            };
          }
          this._post({ type: 'toast', message: `${runs.length} runs fetched for "${target.displayName}"`, level: 'success' });
          this._postState();
        } catch (err: unknown) {
          this._post({ type: 'toast', message: err instanceof Error ? err.message : String(err), level: 'error' });
        }
        break;
      }

      case 'rerunPipeline': {
        const pipeline = this._pipelines.find(p => p.id === msg.pipelineId);
        try {
          const itemType = (msg.itemType ?? pipeline?.itemType) as ItemType | undefined;
          await this._triggerItem(msg.workspaceId, msg.pipelineId, itemType);
          const verb = itemType === 'semanticModel' ? 'refresh triggered' : 'triggered';
          this._post({ type: 'toast', message: `"${pipeline?.displayName ?? msg.pipelineId}" ${verb}`, level: 'success' });
          // Refresh after short delay so the new run appears
          setTimeout(() => this.refresh(), 3000);
        } catch (err: unknown) {
          this._post({ type: 'toast', message: err instanceof Error ? err.message : String(err), level: 'error' });
        }
        break;
      }

      case 'copyRunId':
        await vscode.env.clipboard.writeText(msg.runId);
        this._post({ type: 'toast', message: 'Run ID copied to clipboard', level: 'success' });
        break;

      case 'openInFabric': {
        // UUIDs already validated by _validateMsg
        let url: string;
        switch (msg.itemType ?? 'pipeline') {
          case 'semanticModel':
            url = `https://app.fabric.microsoft.com/groups/${msg.workspaceId}/semanticmodels/${msg.pipelineId}`;
            break;
          case 'notebook':
            url = `https://app.fabric.microsoft.com/groups/${msg.workspaceId}/synapsenotebooks/${msg.pipelineId}`;
            break;
          default:
            url = `https://app.fabric.microsoft.com/groups/${msg.workspaceId}/pipelines/${msg.pipelineId}?experience=data-pipeline`;
            break;
        }
        await vscode.env.openExternal(vscode.Uri.parse(url));
        break;
      }

      case 'viewMonitor': {
        // UUIDs already validated by _validateMsg.
        // Deep-link to the last run's monitoring view when we have a run id;
        // fall back to the pipeline editor for never-run pipelines.
        const runId = msg.runId && isUuid(msg.runId) ? msg.runId : undefined;
        const url = runId
          ? `https://app.fabric.microsoft.com/workloads/data-pipeline/monitoring/workspaces/${msg.workspaceId}/pipelines/${msg.pipelineId}/${runId}?experience=power-bi`
          : `https://app.fabric.microsoft.com/groups/${msg.workspaceId}/pipelines/${msg.pipelineId}?experience=data-pipeline`;
        await vscode.env.openExternal(vscode.Uri.parse(url));
        break;
      }

      case 'viewHistory': {
        const { HistoryPanel } = await import('./HistoryPanel');
        const target = this._pipelines.find(p => p.id === msg.pipelineId);
        if (!target) break;
        this._post({ type: 'toast', message: `Loading history for "${msg.pipelineName}"…`, level: 'info' });
        try {
          const itemType = (msg.itemType ?? target.itemType) as ItemType | undefined;
          const runs = await this._fetchAllRuns(msg.workspaceId, msg.pipelineId, itemType);
          if (runs.length > 0) {
            this._storage.upsertRunsBatch(runs.map(r => ({
              tenantId: this._currentTenantId,
              workspaceId: msg.workspaceId,
              pipelineId: msg.pipelineId,
              pipelineName: msg.pipelineName,
              workspaceName: msg.workspaceName,
              runId: r.runId,
              status: r.status,
              startTime: r.startTime,
              endTime: r.endTime,
              durationMs: r.durationMs,
              errorMessage: r.errorMessage,
              itemType: target.itemType ?? 'pipeline',
            })));
          }
          this._runsFetchedAt.set(msg.pipelineId, Date.now());
          const { rate } = this._storage.getSuccessRate(msg.pipelineId, 7);
          const durStats = this._storage.getDurationStats(msg.pipelineId);
          const idx = this._pipelines.findIndex(p => p.id === msg.pipelineId);
          if (idx !== -1) {
            this._pipelines[idx] = {
              ...this._pipelines[idx],
              lastRun: runs[0] ?? this._pipelines[idx].lastRun,
              successRate7d: rate,
              avgDurationMs: durStats.avg,
              maxDurationMs: durStats.max,
              minDurationMs: durStats.min,
            };
          }
          this._postState();
        } catch (err: unknown) {
          this._post({ type: 'toast', message: err instanceof Error ? err.message : String(err), level: 'error' });
        }
        HistoryPanel.createOrShow(this._extensionUri, target, this._storage);
        break;
      }

      case 'addTenant':
        await vscode.commands.executeCommand('fabricPulse.addTenant');
        break;

      case 'setFavoritesOnly':
        this._favoritesOnlyMode = msg.enabled;
        break;

      case 'exportHistory': {
        const target = this._pipelines.find(p => p.id === msg.pipelineId);
        if (!target) break;
        const csv = this._storage.exportRunsCsv(msg.pipelineId);
        const uri = await vscode.window.showSaveDialog({
          defaultUri: vscode.Uri.file(`${target.displayName}_history.csv`),
          filters: { 'CSV Files': ['csv'] },
        });
        if (uri) {
          fs.writeFileSync(uri.fsPath, csv, 'utf-8');
          this._post({ type: 'toast', message: 'History exported', level: 'success' });
        }
        break;
      }
    }
  }

  // ─── Item-type dispatch ─────────────────────────────────────────────────────

  /** Fetches the most recent run for an item, dispatching on its type. */
  private _fetchLastRun(workspaceId: string, itemId: string, itemType?: ItemType): Promise<PipelineRun | undefined> {
    switch (itemType ?? 'pipeline') {
      case 'semanticModel': return this._fabricApi.getLastSemanticModelRun(this._currentTenantId, workspaceId, itemId);
      case 'notebook':      return this._fabricApi.getLastNotebookRun(this._currentTenantId, workspaceId, itemId);
      default:              return this._fabricApi.getLastPipelineRun(this._currentTenantId, workspaceId, itemId);
    }
  }

  /** Fetches the full run history for an item, dispatching on its type. */
  private _fetchAllRuns(workspaceId: string, itemId: string, itemType?: ItemType): Promise<PipelineRun[]> {
    switch (itemType ?? 'pipeline') {
      case 'semanticModel': return this._fabricApi.getSemanticModelRuns(this._currentTenantId, workspaceId, itemId);
      case 'notebook':      return this._fabricApi.getNotebookRuns(this._currentTenantId, workspaceId, itemId);
      default:              return this._fabricApi.getPipelineRuns(this._currentTenantId, workspaceId, itemId);
    }
  }

  /** Triggers an on-demand run for an item, dispatching on its type. */
  private _triggerItem(workspaceId: string, itemId: string, itemType?: ItemType): Promise<string> {
    switch (itemType ?? 'pipeline') {
      case 'semanticModel': return this._fabricApi.triggerSemanticModelRefresh(this._currentTenantId, workspaceId, itemId);
      case 'notebook':      return this._fabricApi.triggerNotebook(this._currentTenantId, workspaceId, itemId);
      default:              return this._fabricApi.triggerPipeline(this._currentTenantId, workspaceId, itemId);
    }
  }

  // ─── Schedules ────────────────────────────────────────────────────────────

  /** Fetches the schedule for an item and caches it. Non-fatal: on error it
   *  keeps any previously cached value rather than clearing the column. */
  private async _fetchSchedule(
    item: { id: string; itemType?: ItemType },
    workspaceId: string,
  ): Promise<void> {
    try {
      let info;
      switch (item.itemType ?? 'pipeline') {
        case 'semanticModel': info = await this._fabricApi.getSemanticModelSchedule(this._currentTenantId, workspaceId, item.id); break;
        case 'notebook':      info = await this._fabricApi.getNotebookSchedule(this._currentTenantId, workspaceId, item.id); break;
        default:              info = await this._fabricApi.getPipelineSchedule(this._currentTenantId, workspaceId, item.id); break;
      }
      if (info !== undefined) this._schedulesById.set(item.id, info);
    } catch (err) {
      console.warn(`[FabricPulse] schedule fetch failed for ${item.id}:`, err);
    }
  }

  /** Schedule-derived fields for a pipeline row, read from the in-memory cache. */
  private _scheduleFields(itemId: string): Pick<PipelineWithStatus, 'nextRunAt' | 'scheduleSummary' | 'scheduleEnabled'> {
    const s = this._schedulesById.get(itemId);
    return { nextRunAt: s?.nextRunAt, scheduleSummary: s?.summary, scheduleEnabled: s?.enabled };
  }

  // ─── State ──────────────────────────────────────────────────────────────────

  private _postState(): void {
    const state: DashboardState = {
      tenants: this._tenants,
      currentTenantId: this._currentTenantId,
      workspaces: this._workspaces,
      pipelines: this._pipelines,
      selectedWorkspaceId: this._selectedWorkspaceId,
      lastRefreshed: this._lastRefreshed,
      nextRefreshAt: this._nextRefreshAt,
      isFromCache: this._isFromCache,
      isLoading: this._isLoading,
      batchProgress: this._batchProgress,
    };
    this._post({ type: 'updateState', state });
  }

  private _post(msg: ExtToDashMsg): void {
    if (this._disposed) { return; }
    this._panel.webview.postMessage(msg);
  }

  // ─── HTML ────────────────────────────────────────────────────────────────────

  private _buildHtml(): string {
    const webviewDir = vscode.Uri.joinPath(this._extensionUri, 'src', 'webview');
    const htmlPath = path.join(webviewDir.fsPath, 'dashboard.html');
    let html = fs.readFileSync(htmlPath, 'utf-8');

    const cssUri = this._panel.webview.asWebviewUri(
      vscode.Uri.joinPath(webviewDir, 'dashboard.css'),
    );
    const jsUri = this._panel.webview.asWebviewUri(
      vscode.Uri.joinPath(webviewDir, 'dashboard.js'),
    );
    const nonce = getNonce();

    const v = Date.now();
    html = html
      .replace(/\{\{CSS_URI\}\}/g, cssUri.toString() + '?v=' + v)
      .replace(/\{\{JS_URI\}\}/g, jsUri.toString() + '?v=' + v)
      .replace(/\{\{NONCE\}\}/g, nonce)
      .replace(/\{\{WEBVIEW_CSP_SOURCE\}\}/g, this._panel.webview.cspSource);

    return html;
  }

  // ─── Dispose ─────────────────────────────────────────────────────────────────

  public dispose(): void {
    this._disposed = true;
    DashboardPanel.currentPanel = undefined;
    this._panel.dispose();
    this._disposables.forEach(d => d.dispose());
    this._disposables.length = 0;
  }
}
