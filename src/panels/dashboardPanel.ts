import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';

import type {
  DashboardState,
  ExtToDashMsg,
  Favorite,
  ItemType,
  PipelineRun,
  PipelineWithStatus,
  Tenant,
  WebviewToExtMsg,
  Workspace,
} from '../models/types';
import type { AlertService } from '../services/alertService';
import type { AuthState } from '../services/authService';
import type { FabricApiService } from '../services/fabricApi';
import type { NotificationLog } from '../services/notificationLog';
import type { ScheduleInfo } from '../services/scheduleService';
import type { StorageService } from '../services/storageService';

// Utility ─────────────────────────────────────────────────────────────────────

/** Cryptographically secure nonce for CSP. Never use Math.random() for nonces. */
function getNonce(): string {
  return crypto.randomBytes(16).toString('hex'); // 128-bit entropy
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
function isUuid(s: string): boolean {
  return UUID_RE.test(s);
}

/** A refresh still running after this long is stuck, not slow — every network
 *  call is capped well below it (30 s per request, 120 s per token acquisition).
 *  Past this point the loading flag is released so the Refresh button works
 *  again instead of being debounced away forever. */
const STUCK_REFRESH_MS = 3 * 60_000;

/** How often the token is renewed in the background. Well under the token's own
 *  lifetime, so the renewal — and any sign-in it turns out to need — happens
 *  between polls rather than in the middle of one. */
const TOKEN_PREWARM_MS = 5 * 60_000;

/** A schedule changes when someone edits it in Fabric, not every minute. Polling
 *  re-reads runs every cycle but a schedule only this often, which keeps a cycle at
 *  one run call per item. The Refresh button and a single-item refresh bypass it. */
const SCHEDULE_TTL_MS = 10 * 60_000;

// ─────────────────────────────────────────────────────────────────────────────

export class DashboardPanel {
  public static currentPanel: DashboardPanel | undefined;
  private static readonly VIEW_TYPE = 'fabricPulseDashboard';

  private readonly panel: vscode.WebviewPanel;
  private readonly disposables: vscode.Disposable[] = [];

  // Panel state
  private tenants: Tenant[] = [];
  private currentTenantId = '';
  private workspaces: Workspace[] = [];
  private pipelines: PipelineWithStatus[] = [];
  private selectedWorkspaceId = '';
  private lastRefreshed = '';
  private nextRefreshAt = '';
  private isFromCache = false;
  private isLoading = false;
  private batchProgress: { done: number; total: number } | undefined = undefined;
  private disposed = false;
  private favoritesOnlyMode = false;
  /** Whether the one-time "default to favorites-only when favorites exist" rule
   *  has been applied. Mirrors the webview's auto-enable so the very first
   *  refresh only fetches favorites instead of enumerating every workspace. */
  private favoritesDefaultApplied = false;

  /** itemId → epoch ms of last live API fetch for runs.
   *  Cleared when the workspace or tenant changes so the first load is always live. */
  private runsFetchedAt = new Map<string, number>();

  /** itemId → last fetched schedule info. Kept across the cache/fetch phases of a
   *  refresh so the "Next Run" column doesn't flicker; cleared on tenant/workspace change. */
  private schedulesById = new Map<string, ScheduleInfo>();
  /** itemId → epoch ms of the last schedule fetch, for SCHEDULE_TTL_MS. */
  private scheduleFetchedAt = new Map<string, number>();

  /** Epoch ms at which the in-progress refresh started — the watchdog reads it
   *  to tell a slow refresh from a stuck one. */
  private loadingStartedAt = 0;
  /** Incremented per refresh so a refresh released by the watchdog can no longer
   *  clobber the state of the one that replaced it. */
  private refreshSeq = 0;
  /** Latest auth phase, mirrored into the webview state as the re-auth banner. */
  private authState: { phase: 'pending' | 'failed'; message?: string } | undefined;
  private prewarmTimer: ReturnType<typeof setInterval> | undefined;

  // ─── Factory ────────────────────────────────────────────────────────────────

  public static createOrShow(
    extensionUri: vscode.Uri,
    fabricApi: FabricApiService,
    storage: StorageService,
    alertService: AlertService,
    context: vscode.ExtensionContext,
    notifications: NotificationLog,
  ): DashboardPanel {
    const column = vscode.window.activeTextEditor?.viewColumn ?? vscode.ViewColumn.One;

    if (DashboardPanel.currentPanel) {
      DashboardPanel.currentPanel.panel.reveal(column);
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
      panel,
      extensionUri,
      fabricApi,
      storage,
      alertService,
      context,
      notifications,
    );
    return DashboardPanel.currentPanel;
  }

  // ─── Constructor ─────────────────────────────────────────────────────────────

  private constructor(
    panel: vscode.WebviewPanel,
    private readonly extensionUri: vscode.Uri,
    private readonly fabricApi: FabricApiService,
    private readonly storage: StorageService,
    private readonly alertService: AlertService,
    private readonly context: vscode.ExtensionContext,
    private readonly notifications: NotificationLog,
  ) {
    this.panel = panel;

    // Load persisted tenants
    this.tenants = this.context.globalState.get<Tenant[]>('fabricPulse.tenants', []);
    if (this.tenants.length > 0) {
      this.currentTenantId = this.tenants[0].id;
    }

    this.panel.webview.html = this.buildHtml();

    this.panel.webview.onDidReceiveMessage(
      (msg: WebviewToExtMsg) => this.handleMessage(msg),
      null,
      this.disposables,
    );

    this.disposables.push(
      this.fabricApi.auth.onDidChangeAuthState((state) => this.onAuthStateChange(state)),
    );

    // Renew the token in the background, between polls. Because AuthService
    // renews well before expiry, a sign-in that turns out to be needed is
    // surfaced (banner + notification) while the current token still works —
    // instead of blocking the refresh that first hits the expired one.
    this.prewarmTimer = setInterval(() => {
      if (this.disposed || !this.currentTenantId) return;
      void this.fabricApi.auth.prewarm(this.currentTenantId);
    }, TOKEN_PREWARM_MS);

    this.panel.onDidDispose(() => this.dispose(), null, this.disposables);
  }

  /** Mirrors the auth phase into the webview and, on failure, raises a VS Code
   *  notification — the panel may well be in a background tab. */
  private onAuthStateChange(state: AuthState): void {
    if (this.disposed || state.tenantId !== this.currentTenantId) return;
    // Healthy renewals are the common case — nothing to redraw when the banner
    // is already down.
    if (state.phase === 'idle' && !this.authState) return;

    const previous = this.authState?.phase;

    this.authState =
      state.phase === 'idle' ? undefined : { phase: state.phase, message: state.message };

    // Only on the transition into 'failed', so a tenant that keeps failing
    // doesn't produce a notification per refresh.
    if (state.phase === 'failed' && previous !== 'failed') {
      this.notifications.add(
        'warning',
        'Auth',
        `Sign-in required — ${state.message ?? 'the session has expired.'}`,
      );
      void vscode.window
        .showWarningMessage(
          `FabricPulse: sign-in required — ${state.message ?? 'the session has expired.'}`,
          'Sign in',
        )
        .then((choice) => {
          if (choice === 'Sign in') void this.reauthenticate();
        });
    }

    this.postState();
  }

  /** Discards the credential and acquires a fresh one, then reloads. Behind the
   *  banner's "Sign in" button and the notification action. */
  private async reauthenticate(): Promise<void> {
    if (!this.currentTenantId) return;

    this.authState = { phase: 'pending', message: 'Signing in…' };
    this.postState();

    try {
      await this.fabricApi.auth.signIn(this.currentTenantId);
      this.authState = undefined;
      this.post({ type: 'toast', message: 'Signed in to Microsoft Fabric.', level: 'success' });
      await this.refresh(true);
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      this.authState = { phase: 'failed', message };
      this.post({ type: 'toast', message: `Sign-in failed: ${message}`, level: 'error' });
      this.postState();
    }
  }

  // ─── Public ──────────────────────────────────────────────────────────────────

  public setNextRefreshAt(iso: string): void {
    this.nextRefreshAt = iso;
    this.postState();
  }

  /** `due` marks a polling tick: every item in scope is re-read whatever its age.
   *  Comparing ages instead skipped every other cycle — items fetched a few seconds
   *  into the last cycle are still a few seconds short of one interval at the next
   *  tick, so they were never stale when the tick fired. */
  public async refresh(force = false, initialLoad = false, due = false): Promise<void> {
    if (this.isLoading) {
      // Debounce concurrent refreshes — unless the flag is stale. A refresh that
      // hung (typically on an expired token) used to leave it set for good,
      // which silently swallowed every later refresh, the Refresh button
      // included. Past STUCK_REFRESH_MS the flag is released and this refresh
      // proceeds; refreshSeq keeps the abandoned one from writing state.
      if (Date.now() - this.loadingStartedAt < STUCK_REFRESH_MS) return;
      console.warn('[FabricPulse] Previous refresh never completed — releasing the loading flag');
      this.isLoading = false;
    }

    if (!this.currentTenantId) {
      this.postState();
      return;
    }

    // First refresh: default to favorites-only when the tenant has favorites, so
    // the initial (forced) load only refreshes those instead of every workspace.
    // Mirrors the webview's auto-enable, but is known *before* the fetch starts.
    if (!this.favoritesDefaultApplied) {
      this.favoritesDefaultApplied = true;
      const favs = this.storage.getFavorites().filter((f) => f.tenantId === this.currentTenantId);
      if (favs.length > 0) this.favoritesOnlyMode = true;
    }

    this.isLoading = true;
    this.loadingStartedAt = Date.now();
    const seq = ++this.refreshSeq;
    /** False once a later refresh has taken over — this one must stop writing state. */
    const isCurrent = () => seq === this.refreshSeq;
    this.postState();

    const cfg = vscode.workspace.getConfiguration('fabricPulse');
    const blacklist = cfg.get<string[]>('blacklistedWorkspaces', []).map((s) => s.toLowerCase());
    const isBlacklisted = (ws: { id: string; displayName: string }) =>
      blacklist.includes(ws.id.toLowerCase()) || blacklist.includes(ws.displayName.toLowerCase());

    try {
      // ── No workspace selected: serve from SQLite cache when possible ──────
      // A forced refresh normally bypasses the cache to re-fetch everything.
      // On the initial open in favorites-only mode we keep the light path: it
      // refreshes just the favorites (live) instead of enumerating every
      // workspace. The manual Refresh button (initialLoad=false) still does a
      // full refresh so the user can always force-update every item.
      if (!this.selectedWorkspaceId && (!force || (initialLoad && this.favoritesOnlyMode))) {
        const cachedWorkspaces = this.storage.getKnownWorkspaces(this.currentTenantId);

        if (cachedWorkspaces.length > 0) {
          // Cache is populated — rebuild the view entirely from SQLite, zero API calls
          this.workspaces = cachedWorkspaces
            .filter((ws) => !isBlacklisted(ws))
            .map((ws) => ({
              ...ws,
              isFavorite: this.storage.isWorkspaceFavorite(ws.id),
            }));

          const tenantFavorites = this.storage
            .getFavorites()
            .filter((f) => f.tenantId === this.currentTenantId);

          // getKnownWorkspaces derives from pipeline_runs, so the workspace of a
          // favorite that has never run is missing from the picker. Add it from
          // the name stored when the item was starred.
          for (const fav of tenantFavorites) {
            if (this.workspaces.some((w) => w.id === fav.workspaceId)) continue;
            const ws = {
              id: fav.workspaceId,
              displayName: fav.workspaceName ?? fav.workspaceId,
              tenantId: this.currentTenantId,
            };
            if (isBlacklisted(ws)) continue;
            this.workspaces.push({ ...ws, isFavorite: this.storage.isWorkspaceFavorite(ws.id) });
          }

          const cachedItems = this.storage.getKnownPipelines(this.currentTenantId);
          this.pipelines = cachedItems.map((p) => {
            const fav = this.storage.getFavorite(p.id);
            const localRun = this.storage.getLastRun(p.id);
            const lastRun: PipelineRun | undefined = localRun
              ? {
                  id: String(localRun.id),
                  pipelineId: p.id,
                  runId: localRun.runId,
                  status: localRun.status as PipelineRun['status'],
                  startTime: localRun.startTime,
                  endTime: localRun.endTime,
                  durationMs: localRun.durationMs,
                  errorMessage: localRun.errorMessage,
                }
              : undefined;
            const { rate } = this.storage.getSuccessRate(p.id, 7);
            const durStats = this.storage.getDurationStats(p.id);
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
              cachedRunCount: this.storage.getRunCount(p.id),
              ...this.scheduleFields(p.id),
            };
          });

          // Same blind spot for the items themselves: a favorite with no run
          // recorded yet is absent from the query above and used to stay
          // invisible until its first run landed. Show it as a row with empty
          // statistics — it is starred, so the user expects to see it.
          const seenIds = new Set(cachedItems.map((p) => p.id));
          const knownWsIds = new Set(this.workspaces.map((w) => w.id));
          for (const fav of tenantFavorites) {
            if (seenIds.has(fav.pipelineId)) continue;
            if (!knownWsIds.has(fav.workspaceId)) continue; // workspace blacklisted
            this.pipelines.push(this.favoriteRow(fav));
          }

          this.lastRefreshed = new Date().toISOString();
          this.isFromCache = true;

          if (!this.favoritesOnlyMode) {
            // Pure cache mode — no API calls
            await this.alertService.checkAlerts(this.pipelines);
            return; // done — no API calls made
          }

          // Favorites-only mode: show cache immediately, then refresh only stale favorites
          this.postState();

          const pollingMs = cfg.get<number>('pollingInterval', 60) * 1000;
          const favorites = tenantFavorites;
          const wsMap = new Map(this.workspaces.map((w) => [w.id, w]));
          // A forced refresh or a polling tick re-fetches every favorite; otherwise only stale ones.
          const staleFavorites =
            force || due
              ? favorites
              : favorites.filter((f) => {
                  const lastFetched = this.runsFetchedAt.get(f.pipelineId) ?? 0;
                  return Date.now() - lastFetched >= pollingMs;
                });

          const favBatchSize = cfg.get<number>('batchSize', 5);
          for (let i = 0; i < staleFavorites.length; i += favBatchSize) {
            const batch = staleFavorites.slice(i, i + favBatchSize);
            await Promise.all(
              batch.map(async (fav) => {
                const item = this.pipelines.find((p) => p.id === fav.pipelineId);
                let run: PipelineRun | undefined;

                await Promise.all([
                  this.fetchSchedule(
                    { id: fav.pipelineId, itemType: fav.itemType as ItemType | undefined },
                    fav.workspaceId,
                    SCHEDULE_TTL_MS,
                  ),
                  (async () => {
                    try {
                      run = await this.fetchLastRun(
                        fav.workspaceId,
                        fav.pipelineId,
                        fav.itemType as ItemType | undefined,
                      );
                      if (run) {
                        this.storage.upsertRunsBatch([
                          {
                            tenantId: this.currentTenantId,
                            workspaceId: fav.workspaceId,
                            pipelineId: fav.pipelineId,
                            pipelineName: item?.displayName ?? fav.displayName ?? fav.pipelineId,
                            workspaceName:
                              wsMap.get(fav.workspaceId)?.displayName ??
                              fav.workspaceName ??
                              fav.workspaceId,
                            runId: run.runId,
                            status: run.status,
                            startTime: run.startTime,
                            endTime: run.endTime,
                            durationMs: run.durationMs,
                            errorMessage: run.errorMessage,
                            itemType: fav.itemType ?? 'pipeline',
                          },
                        ]);
                      }
                      this.runsFetchedAt.set(fav.pipelineId, Date.now());
                    } catch (err) {
                      console.warn(
                        `[FabricPulse] Could not fetch run for favorite ${fav.pipelineId}:`,
                        err,
                      );
                    }
                  })(),
                ]);

                const idx = this.pipelines.findIndex((p) => p.id === fav.pipelineId);
                if (idx !== -1) {
                  // Stats are re-read rather than carried over: a favorite that had
                  // no run until a moment ago would otherwise show "0 runs" next to
                  // the run it just fetched.
                  const { rate } = this.storage.getSuccessRate(fav.pipelineId, 7);
                  const durStats = this.storage.getDurationStats(fav.pipelineId);
                  this.pipelines[idx] = {
                    ...this.pipelines[idx],
                    ...(run ? { lastRun: run } : {}),
                    successRate7d: rate,
                    avgDurationMs: durStats.avg,
                    maxDurationMs: durStats.max,
                    minDurationMs: durStats.min,
                    cachedRunCount: this.storage.getRunCount(fav.pipelineId),
                    ...this.scheduleFields(fav.pipelineId),
                  };
                }
              }),
            );
          }

          this.isFromCache = false;
          this.lastRefreshed = new Date().toISOString();
          await this.alertService.checkAlerts(this.pipelines);
          return;
        }
        // Cache empty (first launch) → fall through to seed it via API
      }

      // ── Workspace selected (or cache empty on first launch) ───────────────
      const rawWorkspaces = await this.fabricApi.getWorkspaces(this.currentTenantId);
      const allWorkspaces = rawWorkspaces.filter((ws) => !isBlacklisted(ws));
      if (allWorkspaces.length < rawWorkspaces.length) {
        console.log(
          `[FabricPulse] Skipping ${rawWorkspaces.length - allWorkspaces.length} blacklisted workspace(s).`,
        );
      }
      this.workspaces = allWorkspaces.map((ws) => ({
        ...ws,
        isFavorite: this.storage.isWorkspaceFavorite(ws.id),
      }));
      // Post workspaces immediately so the picker populates before items load
      this.postState();

      const pollingMs = cfg.get<number>('pollingInterval', 60) * 1000;
      const batchSize = cfg.get<number>('batchSize', 5);
      const batchDelayMs = cfg.get<number>('batchDelayMs', 2500);
      const batchThreshold = cfg.get<number>('batchThreshold', 10);

      const filteredWorkspaces = (
        this.selectedWorkspaceId
          ? this.workspaces.filter((w) => w.id === this.selectedWorkspaceId)
          : this.workspaces
      ).sort((a, b) => (b.isFavorite ? 1 : 0) - (a.isFavorite ? 1 : 0));

      // ── Phase 1: collect all items (pipelines + semantic models) with cached run data ──
      type ItemMeta = { pipeline: PipelineWithStatus; ws: Workspace };
      const allMeta: ItemMeta[] = [];

      for (let wsIdx = 0; wsIdx < filteredWorkspaces.length; wsIdx++) {
        if (wsIdx > 0) await new Promise((r) => setTimeout(r, 500));
        const ws = filteredWorkspaces[wsIdx];

        // Sequential list calls: pipelines first warms up the auth token,
        // then the remaining types reuse the cached token — avoids parallel auth popups.
        let pipelines: import('../models/types').Pipeline[] = [];
        let models: import('../models/types').Pipeline[] = [];
        let notebooks: import('../models/types').Pipeline[] = [];
        let copyJobs: import('../models/types').Pipeline[] = [];
        let dbtJobs: import('../models/types').Pipeline[] = [];

        try {
          pipelines = await this.fabricApi.getPipelines(this.currentTenantId, ws.id);
        } catch (err) {
          console.warn(
            `[FabricPulse] Error fetching pipelines for workspace ${ws.displayName}:`,
            err,
          );
        }
        try {
          models = await this.fabricApi.getSemanticModels(this.currentTenantId, ws.id);
        } catch (err) {
          console.warn(
            `[FabricPulse] Error fetching semantic models for workspace ${ws.displayName}:`,
            err,
          );
        }
        try {
          notebooks = await this.fabricApi.getNotebooks(this.currentTenantId, ws.id);
        } catch (err) {
          console.warn(
            `[FabricPulse] Error fetching notebooks for workspace ${ws.displayName}:`,
            err,
          );
        }
        try {
          copyJobs = await this.fabricApi.getCopyJobs(this.currentTenantId, ws.id);
        } catch (err) {
          console.warn(
            `[FabricPulse] Error fetching copy jobs for workspace ${ws.displayName}:`,
            err,
          );
        }
        try {
          dbtJobs = await this.fabricApi.getDbtJobs(this.currentTenantId, ws.id);
        } catch (err) {
          console.warn(
            `[FabricPulse] Error fetching dbt jobs for workspace ${ws.displayName}:`,
            err,
          );
        }

        const allItems = [...pipelines, ...models, ...notebooks, ...copyJobs, ...dbtJobs];

        for (const p of allItems) {
          p.workspaceName = ws.displayName;
          const fav = this.storage.getFavorite(p.id);
          const localRun = this.storage.getLastRun(p.id);
          const lastRun: PipelineRun | undefined = localRun
            ? {
                id: String(localRun.id),
                pipelineId: p.id,
                runId: localRun.runId,
                status: localRun.status as PipelineRun['status'],
                startTime: localRun.startTime,
                endTime: localRun.endTime,
                durationMs: localRun.durationMs,
                errorMessage: localRun.errorMessage,
              }
            : undefined;
          const { rate } = this.storage.getSuccessRate(p.id, 7);
          const durStats = this.storage.getDurationStats(p.id);
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
              cachedRunCount: this.storage.getRunCount(p.id),
              ...this.scheduleFields(p.id),
            },
          });
        }
      }

      // Show all items from cache immediately so the UI is populated
      this.pipelines = allMeta.map((m) => m.pipeline);
      this.isFromCache = true;
      this.lastRefreshed = new Date().toISOString();
      this.postState();

      // ── Phase 2: fetch fresh runs for stale items, in batches ─────────────
      const staleMeta = allMeta
        .filter((m) => {
          if (this.favoritesOnlyMode && !m.pipeline.isFavorite) return false;
          if (due) return true;
          const lastFetched = this.runsFetchedAt.get(m.pipeline.id) ?? 0;
          return Date.now() - lastFetched >= pollingMs;
        })
        .sort((a, b) => (b.pipeline.isFavorite ? 1 : 0) - (a.pipeline.isFavorite ? 1 : 0));

      const useBatching = staleMeta.length > batchThreshold;
      const totalBatches = Math.ceil(staleMeta.length / batchSize);

      for (let i = 0; i < staleMeta.length; i += batchSize) {
        if (useBatching && i > 0) {
          await new Promise((r) => setTimeout(r, batchDelayMs));
        }

        const batchNum = Math.floor(i / batchSize) + 1;
        if (useBatching) {
          this.batchProgress = { done: batchNum - 1, total: totalBatches };
          this.postState();
        }

        const batch = staleMeta.slice(i, i + batchSize);
        await Promise.all(
          batch.map(async ({ pipeline, ws }) => {
            let run: PipelineRun | undefined;

            // Runs and schedule are independent calls — fetch them concurrently.
            await Promise.all([
              this.fetchSchedule(pipeline, ws.id, SCHEDULE_TTL_MS),
              (async () => {
                try {
                  run = await this.fetchLastRun(ws.id, pipeline.id, pipeline.itemType);
                  if (run) {
                    this.storage.upsertRunsBatch([
                      {
                        tenantId: this.currentTenantId,
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
                      },
                    ]);
                  }
                  this.runsFetchedAt.set(pipeline.id, Date.now());
                } catch (err) {
                  console.warn(
                    `[FabricPulse] Could not fetch runs for ${pipeline.itemType ?? 'pipeline'} ${pipeline.displayName}:`,
                    err,
                  );
                }
              })(),
            ]);

            const idx = this.pipelines.findIndex((x) => x.id === pipeline.id);
            if (idx !== -1) {
              this.pipelines[idx] = {
                ...this.pipelines[idx],
                ...(run ? { lastRun: run } : {}),
                ...this.scheduleFields(pipeline.id),
              };
            }
          }),
        );

        if (useBatching) {
          this.batchProgress = { done: batchNum, total: totalBatches };
        }
        this.postState();
      }

      this.batchProgress = undefined;
      this.isFromCache = false;
      this.lastRefreshed = new Date().toISOString();
      await this.alertService.checkAlerts(this.pipelines);
    } catch (err: unknown) {
      if (isCurrent()) {
        const msg = err instanceof Error ? err.message : String(err);
        this.post({ type: 'toast', message: msg, level: 'error' });
      }
    } finally {
      // A refresh the watchdog gave up on must not clear the flag of the one
      // now running, nor overwrite its state.
      if (isCurrent()) {
        this.isLoading = false;
        this.batchProgress = undefined;
        this.postState();
      }
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

  /** Runtime validation of webview messages. TypeScript types are erased at
   *  runtime; the webview is a less-trusted context so we validate IDs and
   *  constrain freetext before processing. Returns false if the message is invalid. */
  private validateMsg(msg: WebviewToExtMsg): boolean {
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
        if (typeof msg.workspaceName !== 'string' || msg.workspaceName.length > 256)
          return fail('bad workspaceName');
        break;

      case 'toggleFavorite':
      case 'refreshPipeline':
      case 'fetchPipelineHistory':
      case 'rerunPipeline':
        if (!isUuid(msg.pipelineId) || !isUuid(msg.workspaceId))
          return fail('bad pipelineId/workspaceId');
        break;

      case 'openInFabric':
        if (!isUuid(msg.pipelineId) || !isUuid(msg.workspaceId) || !isUuid(msg.tenantId))
          return fail('bad UUID');
        break;

      case 'viewMonitor':
        if (!isUuid(msg.pipelineId) || !isUuid(msg.workspaceId))
          return fail('bad pipelineId/workspaceId');
        break;

      case 'viewHistory':
        if (!isUuid(msg.pipelineId) || !isUuid(msg.workspaceId))
          return fail('bad pipelineId/workspaceId');
        if (typeof msg.pipelineName !== 'string' || msg.pipelineName.length > 256)
          return fail('bad pipelineName');
        if (typeof msg.workspaceName !== 'string' || msg.workspaceName.length > 256)
          return fail('bad workspaceName');
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

  private async handleMessage(msg: WebviewToExtMsg): Promise<void> {
    if (!this.validateMsg(msg)) return;

    switch (msg.type) {
      case 'ready':
        // Force a live refresh on first open: this acquires the auth token and
        // fetches fresh runs immediately. Phase 1 still paints cached rows first,
        // so the UI stays fast while live data streams in — no manual click needed.
        // initialLoad=true keeps it light in favorites-only mode (favorites only).
        await this.refresh(true, true);
        break;

      case 'refresh':
        this.runsFetchedAt.clear();
        this.schedulesById.clear();
        this.scheduleFetchedAt.clear();
        await this.refresh(true);
        break;

      case 'reauthenticate':
        await this.reauthenticate();
        break;

      case 'selectTenant':
        this.currentTenantId = msg.tenantId;
        this.authState = undefined; // auth state is per-tenant
        this.workspaces = [];
        this.pipelines = [];
        this.selectedWorkspaceId = '';
        this.runsFetchedAt.clear();
        this.schedulesById.clear();
        this.scheduleFetchedAt.clear();
        await this.refresh();
        break;

      case 'selectWorkspace':
        this.selectedWorkspaceId = msg.workspaceId;
        this.runsFetchedAt.clear(); // force live fetch on first load of a workspace
        this.schedulesById.clear();
        this.scheduleFetchedAt.clear();
        await this.refresh();
        break;

      case 'toggleWorkspaceFavorite': {
        const isFavWs = this.storage.isWorkspaceFavorite(msg.workspaceId);
        if (isFavWs) {
          this.storage.removeWorkspaceFavorite(msg.workspaceId);
        } else {
          this.storage.addWorkspaceFavorite(msg.workspaceId);
        }
        const ws = this.workspaces.find((w) => w.id === msg.workspaceId);
        if (ws) ws.isFavorite = !isFavWs;
        this.postState();
        break;
      }

      case 'blacklistWorkspace': {
        const cfg2 = vscode.workspace.getConfiguration('fabricPulse');
        const current = cfg2.get<string[]>('blacklistedWorkspaces', []);
        if (!current.includes(msg.workspaceId)) {
          await cfg2.update(
            'blacklistedWorkspaces',
            [...current, msg.workspaceId],
            vscode.ConfigurationTarget.Global,
          );
        }
        this.workspaces = this.workspaces.filter((w) => w.id !== msg.workspaceId);
        if (this.selectedWorkspaceId === msg.workspaceId) {
          this.selectedWorkspaceId = '';
        }
        this.pipelines = this.pipelines.filter((p) => p.workspaceId !== msg.workspaceId);
        this.postState();
        this.post({
          type: 'toast',
          message: `"${msg.workspaceName}" ajouté à la blacklist`,
          level: 'info',
        });
        break;
      }

      case 'toggleFavorite': {
        const isFav = this.storage.isFavorite(msg.pipelineId);
        const pl = this.pipelines.find((p) => p.id === msg.pipelineId);
        if (isFav) {
          this.storage.removeFavorite(msg.pipelineId);
        } else {
          this.storage.addFavorite({
            tenantId: this.currentTenantId,
            workspaceId: msg.workspaceId,
            pipelineId: msg.pipelineId,
            alertEnabled: false,
            itemType: msg.itemType ?? 'pipeline',
            // Stored now, while the names are on screen: the favorites-only
            // refresh rebuilds its view from recorded runs, so a favorite with
            // no run yet would otherwise have no name to persist.
            displayName: pl?.displayName,
            workspaceName: pl?.workspaceName,
          });
        }
        // Optimistic update in local state
        if (pl) {
          pl.isFavorite = !isFav;
          if (isFav) pl.alertEnabled = false;
        }
        this.postState();
        break;
      }

      case 'refreshPipeline': {
        const target = this.pipelines.find((p) => p.id === msg.pipelineId);
        if (!target) break;
        try {
          const itemType = (msg.itemType ?? target.itemType) as ItemType | undefined;
          await this.refreshItemLastRun(msg.workspaceId, msg.pipelineId, itemType);
        } catch (err: unknown) {
          this.post({
            type: 'toast',
            message: err instanceof Error ? err.message : String(err),
            level: 'error',
          });
        }
        break;
      }

      case 'fetchPipelineHistory': {
        const target = this.pipelines.find((p) => p.id === msg.pipelineId);
        if (!target) break;
        this.post({
          type: 'toast',
          message: `Fetching history for "${target.displayName}"…`,
          level: 'info',
        });
        try {
          const itemType = (msg.itemType ?? target.itemType) as ItemType | undefined;
          const runs = await this.fetchAllRuns(msg.workspaceId, msg.pipelineId, itemType);
          if (runs.length > 0) {
            this.storage.upsertRunsBatch(
              runs.map((r) => ({
                tenantId: this.currentTenantId,
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
              })),
            );
          }
          this.runsFetchedAt.set(msg.pipelineId, Date.now());
          const { rate } = this.storage.getSuccessRate(msg.pipelineId, 7);
          const durStats = this.storage.getDurationStats(msg.pipelineId);
          const idx = this.pipelines.findIndex((p) => p.id === msg.pipelineId);
          if (idx !== -1) {
            this.pipelines[idx] = {
              ...this.pipelines[idx],
              lastRun: runs[0],
              successRate7d: rate,
              avgDurationMs: durStats.avg,
              maxDurationMs: durStats.max,
              minDurationMs: durStats.min,
            };
          }
          this.post({
            type: 'toast',
            message: `${runs.length} runs fetched for "${target.displayName}"`,
            level: 'success',
          });
          this.postState();
        } catch (err: unknown) {
          this.post({
            type: 'toast',
            message: err instanceof Error ? err.message : String(err),
            level: 'error',
          });
        }
        break;
      }

      case 'rerunPipeline': {
        const pipeline = this.pipelines.find((p) => p.id === msg.pipelineId);
        try {
          const itemType = (msg.itemType ?? pipeline?.itemType) as ItemType | undefined;
          await this.triggerItem(msg.workspaceId, msg.pipelineId, itemType);
          const verb = itemType === 'semanticModel' ? 'refresh triggered' : 'triggered';
          this.post({
            type: 'toast',
            message: `"${pipeline?.displayName ?? msg.pipelineId}" ${verb}`,
            level: 'success',
          });
          // Targeted, staged refresh of just this item so the new run's status
          // appears within ~30s instead of waiting for the next polling cycle.
          this.schedulePostTriggerRefresh(msg.workspaceId, msg.pipelineId, itemType);
        } catch (err: unknown) {
          this.post({
            type: 'toast',
            message: err instanceof Error ? err.message : String(err),
            level: 'error',
          });
        }
        break;
      }

      case 'copyRunId':
        await vscode.env.clipboard.writeText(msg.runId);
        this.post({
          type: 'toast',
          message: 'Run ID copied to clipboard',
          level: 'success',
          log: false,
        });
        break;

      case 'openInFabric': {
        // UUIDs already validated by validateMsg
        let url: string;
        switch (msg.itemType ?? 'pipeline') {
          case 'semanticModel':
            url = `https://app.fabric.microsoft.com/groups/${msg.workspaceId}/semanticmodels/${msg.pipelineId}`;
            break;
          case 'notebook':
            url = `https://app.fabric.microsoft.com/groups/${msg.workspaceId}/synapsenotebooks/${msg.pipelineId}`;
            break;
          case 'copyJob':
            // Best-guess deep link by analogy with the other item types — not
            // documented by Microsoft. Verify against a real tenant and adjust.
            url = `https://app.fabric.microsoft.com/groups/${msg.workspaceId}/copyjobs/${msg.pipelineId}`;
            break;
          case 'dbtJob':
            url = `https://app.fabric.microsoft.com/groups/${msg.workspaceId}/dbtitems/${msg.pipelineId}?experience=power-bi`;
            break;
          default:
            url = `https://app.fabric.microsoft.com/groups/${msg.workspaceId}/pipelines/${msg.pipelineId}?experience=data-pipeline`;
            break;
        }
        await vscode.env.openExternal(vscode.Uri.parse(url));
        break;
      }

      case 'viewMonitor': {
        // UUIDs already validated by validateMsg.
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
        const { HistoryPanel } = await import('./historyPanel');
        const target = this.pipelines.find((p) => p.id === msg.pipelineId);
        if (!target) break;
        this.post({
          type: 'toast',
          message: `Loading history for "${msg.pipelineName}"…`,
          level: 'info',
        });
        try {
          const itemType = (msg.itemType ?? target.itemType) as ItemType | undefined;
          const runs = await this.fetchAllRuns(msg.workspaceId, msg.pipelineId, itemType);
          if (runs.length > 0) {
            this.storage.upsertRunsBatch(
              runs.map((r) => ({
                tenantId: this.currentTenantId,
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
              })),
            );
          }
          this.runsFetchedAt.set(msg.pipelineId, Date.now());
          const { rate } = this.storage.getSuccessRate(msg.pipelineId, 7);
          const durStats = this.storage.getDurationStats(msg.pipelineId);
          const idx = this.pipelines.findIndex((p) => p.id === msg.pipelineId);
          if (idx !== -1) {
            this.pipelines[idx] = {
              ...this.pipelines[idx],
              lastRun: runs[0] ?? this.pipelines[idx].lastRun,
              successRate7d: rate,
              avgDurationMs: durStats.avg,
              maxDurationMs: durStats.max,
              minDurationMs: durStats.min,
            };
          }
          this.postState();
        } catch (err: unknown) {
          this.post({
            type: 'toast',
            message: err instanceof Error ? err.message : String(err),
            level: 'error',
          });
        }
        HistoryPanel.createOrShow(this.extensionUri, target, this.storage, this.notifications);
        break;
      }

      case 'addTenant':
        await vscode.commands.executeCommand('fabricPulse.addTenant');
        break;

      case 'setFavoritesOnly':
        this.favoritesOnlyMode = msg.enabled;
        break;

      case 'exportHistory': {
        const target = this.pipelines.find((p) => p.id === msg.pipelineId);
        if (!target) break;
        const csv = this.storage.exportRunsCsv(msg.pipelineId);
        const uri = await vscode.window.showSaveDialog({
          defaultUri: vscode.Uri.file(`${target.displayName}_history.csv`),
          filters: { 'CSV Files': ['csv'] },
        });
        if (uri) {
          fs.writeFileSync(uri.fsPath, csv, 'utf-8');
          this.post({ type: 'toast', message: 'History exported', level: 'success', log: false });
        }
        break;
      }
    }
  }

  // ─── Item-type dispatch ─────────────────────────────────────────────────────

  /** Fetches the most recent run for an item, dispatching on its type. */
  private fetchLastRun(
    workspaceId: string,
    itemId: string,
    itemType?: ItemType,
  ): Promise<PipelineRun | undefined> {
    switch (itemType ?? 'pipeline') {
      case 'semanticModel':
        return this.fabricApi.getLastSemanticModelRun(this.currentTenantId, workspaceId, itemId);
      case 'notebook':
        return this.fabricApi.getLastNotebookRun(this.currentTenantId, workspaceId, itemId);
      case 'copyJob':
        return this.fabricApi.getLastCopyJobRun(this.currentTenantId, workspaceId, itemId);
      case 'dbtJob':
        return this.fabricApi.getLastDbtJobRun(this.currentTenantId, workspaceId, itemId);
      default:
        return this.fabricApi.getLastPipelineRun(this.currentTenantId, workspaceId, itemId);
    }
  }

  /** Fetches the full run history for an item, dispatching on its type. */
  private fetchAllRuns(
    workspaceId: string,
    itemId: string,
    itemType?: ItemType,
  ): Promise<PipelineRun[]> {
    switch (itemType ?? 'pipeline') {
      case 'semanticModel':
        return this.fabricApi.getSemanticModelRuns(this.currentTenantId, workspaceId, itemId);
      case 'notebook':
        return this.fabricApi.getNotebookRuns(this.currentTenantId, workspaceId, itemId);
      case 'copyJob':
        return this.fabricApi.getCopyJobRuns(this.currentTenantId, workspaceId, itemId);
      case 'dbtJob':
        return this.fabricApi.getDbtJobRuns(this.currentTenantId, workspaceId, itemId);
      default:
        return this.fabricApi.getPipelineRuns(this.currentTenantId, workspaceId, itemId);
    }
  }

  /** Triggers an on-demand run for an item, dispatching on its type.
   *  dbt jobs (preview) have no REST API to trigger a run — the UI hides the
   *  rerun button for this type, but this throws a clear error as a safety net
   *  in case it's ever reached anyway. */
  private triggerItem(workspaceId: string, itemId: string, itemType?: ItemType): Promise<string> {
    switch (itemType ?? 'pipeline') {
      case 'semanticModel':
        return this.fabricApi.triggerSemanticModelRefresh(
          this.currentTenantId,
          workspaceId,
          itemId,
        );
      case 'notebook':
        return this.fabricApi.triggerNotebook(this.currentTenantId, workspaceId, itemId);
      case 'copyJob':
        return this.fabricApi.triggerCopyJob(this.currentTenantId, workspaceId, itemId);
      case 'dbtJob':
        return Promise.reject(
          new Error(
            'dbt jobs cannot be triggered via the Fabric API (preview limitation) — use the schedule in the Fabric portal.',
          ),
        );
      default:
        return this.fabricApi.triggerPipeline(this.currentTenantId, workspaceId, itemId);
    }
  }

  /** Re-fetches the most recent run for a single item, persists it, and updates
   *  that row in place (last run, success rate, duration stats, schedule).
   *  Used by the manual "refresh last run" action and by the staged
   *  post-trigger refresh. Throws on API error so callers can decide whether
   *  to surface it. */
  private async refreshItemLastRun(
    workspaceId: string,
    itemId: string,
    itemType?: ItemType,
  ): Promise<void> {
    const target = this.pipelines.find((p) => p.id === itemId);
    if (!target) return; // item no longer in view (tenant/workspace changed)

    const type = itemType ?? target.itemType;
    const run = await this.fetchLastRun(workspaceId, itemId, type);
    if (run) {
      this.storage.upsertRunsBatch([
        {
          tenantId: this.currentTenantId,
          workspaceId,
          pipelineId: itemId,
          pipelineName: target.displayName,
          workspaceName: target.workspaceName,
          runId: run.runId,
          status: run.status,
          startTime: run.startTime,
          endTime: run.endTime,
          durationMs: run.durationMs,
          errorMessage: run.errorMessage,
          itemType: type ?? 'pipeline',
        },
      ]);
    }
    this.runsFetchedAt.set(itemId, Date.now());
    await this.fetchSchedule({ id: itemId, itemType: type }, workspaceId);

    const { rate } = this.storage.getSuccessRate(itemId, 7);
    const durStats = this.storage.getDurationStats(itemId);
    const idx = this.pipelines.findIndex((p) => p.id === itemId);
    if (idx !== -1) {
      this.pipelines[idx] = {
        ...this.pipelines[idx],
        ...(run ? { lastRun: run } : {}),
        successRate7d: rate,
        avgDurationMs: durStats.avg,
        maxDurationMs: durStats.max,
        minDurationMs: durStats.min,
        cachedRunCount: this.storage.getRunCount(itemId),
        ...this.scheduleFields(itemId),
      };
    }
    this.postState();
  }

  /** Schedules a few targeted re-fetches of an item's last run after it was
   *  triggered, so the new run's status shows up without waiting for the next
   *  polling cycle. Each tick is non-fatal and skipped if the panel is gone. */
  private schedulePostTriggerRefresh(
    workspaceId: string,
    itemId: string,
    itemType?: ItemType,
  ): void {
    // First tick catches the run starting (Queued/InProgress); later ticks
    // catch the final status. A pipeline/notebook run rarely appears instantly.
    const delaysMs = [8_000, 30_000];
    for (const delay of delaysMs) {
      setTimeout(() => {
        if (this.disposed) return;
        this.refreshItemLastRun(workspaceId, itemId, itemType).catch((err) =>
          console.warn(`[FabricPulse] post-trigger refresh failed for ${itemId}:`, err),
        );
      }, delay);
    }
  }

  // ─── Schedules ────────────────────────────────────────────────────────────

  /** Fetches the schedule for an item and caches it. Non-fatal: on error it
   *  keeps any previously cached value rather than clearing the column.
   *  `maxAgeMs`: skip the call when the schedule was fetched more recently than this. */
  private async fetchSchedule(
    item: { id: string; itemType?: ItemType },
    workspaceId: string,
    maxAgeMs = 0,
  ): Promise<void> {
    if (Date.now() - (this.scheduleFetchedAt.get(item.id) ?? 0) < maxAgeMs) return;
    try {
      let info;
      switch (item.itemType ?? 'pipeline') {
        case 'semanticModel':
          info = await this.fabricApi.getSemanticModelSchedule(
            this.currentTenantId,
            workspaceId,
            item.id,
          );
          break;
        case 'notebook':
          info = await this.fabricApi.getNotebookSchedule(
            this.currentTenantId,
            workspaceId,
            item.id,
          );
          break;
        case 'copyJob':
          info = await this.fabricApi.getCopyJobSchedule(
            this.currentTenantId,
            workspaceId,
            item.id,
          );
          break;
        case 'dbtJob':
          info = await this.fabricApi.getDbtJobSchedule(this.currentTenantId, workspaceId, item.id);
          break;
        default:
          info = await this.fabricApi.getPipelineSchedule(
            this.currentTenantId,
            workspaceId,
            item.id,
          );
          break;
      }
      // Recorded even when the item has no schedule, so those aren't asked every cycle.
      this.scheduleFetchedAt.set(item.id, Date.now());
      if (info !== undefined) this.schedulesById.set(item.id, info);
    } catch (err) {
      console.warn(`[FabricPulse] schedule fetch failed for ${item.id}:`, err);
    }
  }

  /** Builds a dashboard row for a starred item with no run in local history.
   *  The cache view is rebuilt from pipeline_runs, so such an item is absent
   *  from it; the names come from what was captured when it was starred.
   *  Statistics are left undefined rather than zeroed so the table renders "—"
   *  (nothing known) instead of "0%" (ran, never succeeded). */
  private favoriteRow(fav: Favorite): PipelineWithStatus {
    const ws = this.workspaces.find((w) => w.id === fav.workspaceId);
    return {
      id: fav.pipelineId,
      displayName: fav.displayName ?? fav.pipelineId,
      workspaceId: fav.workspaceId,
      workspaceName: fav.workspaceName ?? ws?.displayName ?? fav.workspaceId,
      tenantId: fav.tenantId,
      itemType: (fav.itemType ?? 'pipeline') as ItemType,
      isFavorite: true,
      alertEnabled: fav.alertEnabled,
      durationThresholdMs: fav.durationThresholdMs,
      cachedRunCount: 0,
      ...this.scheduleFields(fav.pipelineId),
    };
  }

  /** Schedule-derived fields for a pipeline row, read from the in-memory cache. */
  private scheduleFields(
    itemId: string,
  ): Pick<PipelineWithStatus, 'nextRunAt' | 'scheduleSummary' | 'scheduleEnabled'> {
    const s = this.schedulesById.get(itemId);
    return { nextRunAt: s?.nextRunAt, scheduleSummary: s?.summary, scheduleEnabled: s?.enabled };
  }

  // ─── State ──────────────────────────────────────────────────────────────────

  private postState(): void {
    const state: DashboardState = {
      tenants: this.tenants,
      currentTenantId: this.currentTenantId,
      workspaces: this.workspaces,
      pipelines: this.pipelines,
      selectedWorkspaceId: this.selectedWorkspaceId,
      lastRefreshed: this.lastRefreshed,
      nextRefreshAt: this.nextRefreshAt,
      isFromCache: this.isFromCache,
      isLoading: this.isLoading,
      batchProgress: this.batchProgress,
      auth: this.authState,
    };
    this.post({ type: 'updateState', state });
  }

  private post(msg: ExtToDashMsg): void {
    // Toasts fade out after a few seconds, so each one is also recorded — before
    // the disposed check, since one the user never got to see matters most.
    // Info toasts are progress chatter ("Loading history…") and aren't kept.
    if (msg.type === 'toast' && msg.level !== 'info' && msg.log !== false) {
      this.notifications.add(msg.level, 'Dashboard', msg.message);
    }
    if (this.disposed) {
      return;
    }
    this.panel.webview.postMessage(msg);
  }

  // ─── HTML ────────────────────────────────────────────────────────────────────

  private buildHtml(): string {
    const webviewDir = vscode.Uri.joinPath(this.extensionUri, 'src', 'webview');
    const htmlPath = path.join(webviewDir.fsPath, 'dashboard.html');
    let html = fs.readFileSync(htmlPath, 'utf-8');

    const cssUri = this.panel.webview.asWebviewUri(
      vscode.Uri.joinPath(webviewDir, 'dashboard.css'),
    );
    const jsUri = this.panel.webview.asWebviewUri(vscode.Uri.joinPath(webviewDir, 'dashboard.js'));
    const nonce = getNonce();

    const v = Date.now();
    html = html
      .replace(/\{\{CSS_URI\}\}/g, cssUri.toString() + '?v=' + v)
      .replace(/\{\{JS_URI\}\}/g, jsUri.toString() + '?v=' + v)
      .replace(/\{\{NONCE\}\}/g, nonce)
      .replace(/\{\{WEBVIEW_CSP_SOURCE\}\}/g, this.panel.webview.cspSource);

    return html;
  }

  // ─── Dispose ─────────────────────────────────────────────────────────────────

  public dispose(): void {
    this.disposed = true;
    if (this.prewarmTimer !== undefined) {
      clearInterval(this.prewarmTimer);
      this.prewarmTimer = undefined;
    }
    DashboardPanel.currentPanel = undefined;
    this.panel.dispose();
    this.disposables.forEach((d) => d.dispose());
    this.disposables.length = 0;
  }
}
