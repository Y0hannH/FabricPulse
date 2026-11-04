import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';

import type {
  CalendarItem,
  CalendarState,
  CalendarToExtMsg,
  ExtToCalendarMsg,
  ItemType,
  Pipeline,
  PipelineRun,
  Tenant,
  Workspace,
} from '../models/types';
import type { AuthState } from '../services/authService';
import type { CalendarSource } from '../services/calendarService';
import { buildCalendarEvents } from '../services/calendarService';
import type { FabricApiService } from '../services/fabricApi';
import {
  fabricItemUrl,
  fetchItemLastRun,
  fetchItemRuns,
  fetchItemSchedule,
  listWorkspaceItems,
} from '../services/itemDispatch';
import type { NotificationLog } from '../services/notificationLog';
import type { ScheduleInfo } from '../services/scheduleService';
import type { StorageService } from '../services/storageService';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
function isUuid(s: unknown): s is string {
  return typeof s === 'string' && UUID_RE.test(s);
}

/** Cryptographically secure nonce for CSP. Never use Math.random() for nonces. */
function getNonce(): string {
  return crypto.randomBytes(16).toString('hex');
}

/** A refresh still running after this long is stuck, not slow — see DashboardPanel. */
const STUCK_REFRESH_MS = 3 * 60_000;

/** Up to this many items in scope, the first refresh pulls each one's full run
 *  history (one paginated call per item) so the past of the calendar is complete.
 *  Beyond it only the latest run is fetched — hundreds of full histories would
 *  hit the rate limit — and "Load history" fills in what is on screen on demand. */
const FULL_HISTORY_AUTO_MAX = 40;

/** Most items one "Load history" click may fetch in full. */
const LOAD_HISTORY_MAX_ITEMS = 200;

/** The calendar never shows more than a week or so; refusing wider ranges keeps a
 *  bad message from expanding a schedule over years. */
const MAX_RANGE_MS = 63 * 86_400_000;

/** The clock redraw: planned runs turn into past ones as time goes by. */
const CLOCK_TICK_MS = 60_000;

/** Floor for the background refresh. The dashboard polls as fast as the setting
 *  allows (10 s); this panel re-fetches schedules too, so it stays gentler. */
const MIN_POLL_SECONDS = 60;

export class CalendarPanel {
  public static currentPanel: CalendarPanel | undefined;
  private static readonly VIEW_TYPE = 'fabricPulseCalendar';

  private readonly panel: vscode.WebviewPanel;
  private readonly disposables: vscode.Disposable[] = [];

  private tenants: Tenant[] = [];
  private currentTenantId = '';
  private workspaces: Workspace[] = [];
  /** True once `workspaces` came from the API rather than being derived from the cache. */
  private workspacesLive = false;
  private selectedWorkspaceId = '';
  private favoritesOnly = false;
  private favoritesDefaultApplied = false;

  /** Every item known for the tenant: cached from run history, then refreshed from the API. */
  private catalog = new Map<string, Pipeline>();
  /** `${tenant}|${workspace}` of the last live listing — a different scope lists again. */
  private listedKey = '';
  private schedulesById = new Map<string, ScheduleInfo>();
  private fetchedAt = new Map<string, number>();
  private historyLoaded = new Set<string>();

  private rangeStartMs: number;
  private rangeEndMs: number;

  private lastRefreshed = '';
  private isLoading = false;
  private progress: { done: number; total: number } | undefined;
  private loadingStartedAt = 0;
  private refreshSeq = 0;
  private authState: { phase: 'pending' | 'failed'; message?: string } | undefined;
  private disposed = false;
  private pollTimer: ReturnType<typeof setTimeout> | undefined;
  private clockTimer: ReturnType<typeof setInterval> | undefined;

  // ─── Factory ────────────────────────────────────────────────────────────────

  public static createOrShow(
    extensionUri: vscode.Uri,
    fabricApi: FabricApiService,
    storage: StorageService,
    context: vscode.ExtensionContext,
    notifications: NotificationLog,
  ): CalendarPanel {
    const column = vscode.window.activeTextEditor?.viewColumn ?? vscode.ViewColumn.One;

    if (CalendarPanel.currentPanel) {
      CalendarPanel.currentPanel.panel.reveal(column);
      return CalendarPanel.currentPanel;
    }

    const webviewUri = vscode.Uri.joinPath(extensionUri, 'src', 'webview');
    const panel = vscode.window.createWebviewPanel(
      CalendarPanel.VIEW_TYPE,
      '📅 FabricPulse Calendar',
      column,
      {
        enableScripts: true,
        retainContextWhenHidden: true,
        localResourceRoots: [webviewUri],
      },
    );

    CalendarPanel.currentPanel = new CalendarPanel(
      panel,
      extensionUri,
      fabricApi,
      storage,
      context,
      notifications,
    );
    return CalendarPanel.currentPanel;
  }

  // ─── Constructor ────────────────────────────────────────────────────────────

  private constructor(
    panel: vscode.WebviewPanel,
    private readonly extensionUri: vscode.Uri,
    private readonly fabricApi: FabricApiService,
    private readonly storage: StorageService,
    private readonly context: vscode.ExtensionContext,
    private readonly notifications: NotificationLog,
  ) {
    this.panel = panel;

    // Until the webview reports the range it is showing: the current week, Monday first.
    const monday = new Date();
    monday.setHours(0, 0, 0, 0);
    monday.setDate(monday.getDate() - ((monday.getDay() + 6) % 7));
    this.rangeStartMs = monday.getTime();
    this.rangeEndMs = this.rangeStartMs + 7 * 86_400_000;

    this.tenants = this.context.globalState.get<Tenant[]>('fabricPulse.tenants', []);
    if (this.tenants.length > 0) this.currentTenantId = this.tenants[0].id;

    this.panel.webview.html = this.buildHtml();

    this.panel.webview.onDidReceiveMessage(
      (msg: CalendarToExtMsg) => this.handleMessage(msg),
      null,
      this.disposables,
    );

    this.disposables.push(
      this.fabricApi.auth.onDidChangeAuthState((state) => this.onAuthStateChange(state)),
    );

    // Planned runs become past ones as the clock advances, and runs recorded by
    // an open dashboard land in the same database — a cheap redraw picks both up.
    this.clockTimer = setInterval(() => {
      if (this.panel.visible) this.postState();
    }, CLOCK_TICK_MS);

    this.schedulePoll();

    this.panel.onDidDispose(() => this.dispose(), null, this.disposables);
  }

  // ─── Public ─────────────────────────────────────────────────────────────────

  public reloadTenants(): void {
    this.tenants = this.context.globalState.get<Tenant[]>('fabricPulse.tenants', []);
    if (this.tenants.length > 0 && !this.currentTenantId) {
      this.currentTenantId = this.tenants[0].id;
    }
    this.postState();
  }

  /** Redraws from the local database — after the history was cleared, say. */
  public redraw(): void {
    this.postState();
  }

  public async refresh(force = false): Promise<void> {
    if (this.isLoading) {
      // See DashboardPanel.refresh: a hung refresh must not swallow every later one.
      if (Date.now() - this.loadingStartedAt < STUCK_REFRESH_MS) {
        this.postState(); // a changed filter still redraws; its fetch waits for the next cycle
        return;
      }
      console.warn('[FabricPulse] Calendar refresh never completed — releasing the loading flag');
      this.isLoading = false;
    }

    if (!this.currentTenantId) {
      this.postState();
      return;
    }

    // Same first-load rule as the dashboard: start on favorites when there are any,
    // so the first refresh doesn't enumerate every workspace.
    if (!this.favoritesDefaultApplied) {
      this.favoritesDefaultApplied = true;
      const favs = this.storage.getFavorites().filter((f) => f.tenantId === this.currentTenantId);
      if (favs.length > 0) this.favoritesOnly = true;
    }

    this.isLoading = true;
    this.loadingStartedAt = Date.now();
    const seq = ++this.refreshSeq;
    const isCurrent = () => seq === this.refreshSeq;

    if (force) this.schedulesById.clear();

    try {
      // The recorded past is already local: show it before any network call.
      this.loadCatalogFromCache();
      this.postState();

      await this.listLiveItems(force, isCurrent);
      if (!isCurrent()) return;
      await this.fetchLive(this.scopeItems(), { force }, isCurrent);

      if (isCurrent()) this.lastRefreshed = new Date().toISOString();
    } catch (err: unknown) {
      if (isCurrent()) {
        this.post({
          type: 'toast',
          message: err instanceof Error ? err.message : String(err),
          level: 'error',
        });
      }
    } finally {
      // A refresh the watchdog gave up on must not clear the flag of the one now running.
      if (isCurrent()) {
        this.isLoading = false;
        this.progress = undefined;
        this.postState();
      }
    }
  }

  /** Stops the refresh in flight from writing any further: the scope it was
   *  working on (tenant, workspace, favorites) is no longer the one on screen. */
  private abandonRefresh(): void {
    this.refreshSeq++;
    this.isLoading = false;
    this.progress = undefined;
  }

  // ─── Catalog ────────────────────────────────────────────────────────────────

  private isBlacklisted(ws: { id: string; displayName: string }): boolean {
    const blacklist = vscode.workspace
      .getConfiguration('fabricPulse')
      .get<string[]>('blacklistedWorkspaces', [])
      .map((s) => s.toLowerCase());
    return (
      blacklist.includes(ws.id.toLowerCase()) || blacklist.includes(ws.displayName.toLowerCase())
    );
  }

  /** Items seen in run history plus starred ones that never ran — the same blind spot
   *  the dashboard patches. Live entries already in the catalog are left alone. */
  private loadCatalogFromCache(): void {
    const tenantId = this.currentTenantId;

    for (const k of this.storage.getKnownPipelines(tenantId)) {
      if (this.catalog.has(k.id)) continue;
      this.catalog.set(k.id, {
        id: k.id,
        displayName: k.displayName,
        workspaceId: k.workspaceId,
        workspaceName: k.workspaceName,
        tenantId,
        itemType: k.itemType as ItemType,
      });
    }
    for (const fav of this.storage.getFavorites()) {
      if (fav.tenantId !== tenantId || this.catalog.has(fav.pipelineId)) continue;
      this.catalog.set(fav.pipelineId, {
        id: fav.pipelineId,
        displayName: fav.displayName ?? fav.pipelineId,
        workspaceId: fav.workspaceId,
        workspaceName: fav.workspaceName ?? fav.workspaceId,
        tenantId,
        itemType: (fav.itemType ?? 'pipeline') as ItemType,
      });
    }

    if (!this.workspacesLive) {
      const byId = new Map<string, Workspace>();
      for (const p of this.catalog.values()) {
        if (byId.has(p.workspaceId)) continue;
        byId.set(p.workspaceId, {
          id: p.workspaceId,
          displayName: p.workspaceName,
          tenantId,
          isFavorite: this.storage.isWorkspaceFavorite(p.workspaceId),
        });
      }
      this.workspaces = [...byId.values()].filter((ws) => !this.isBlacklisted(ws));
    }
  }

  /** Lists the items of the workspaces in scope from the API. Skipped in favorites
   *  mode (the favorites are the scope) and when this scope was already listed. */
  private async listLiveItems(force: boolean, isCurrent: () => boolean): Promise<void> {
    if (this.favoritesOnly) return;
    const key = `${this.currentTenantId}|${this.selectedWorkspaceId}`;
    if (!force && this.listedKey === key) return;

    const raw = await this.fabricApi.getWorkspaces(this.currentTenantId);
    if (!isCurrent()) return;
    const all = raw.filter((ws) => !this.isBlacklisted(ws));
    this.workspaces = all.map((ws) => ({
      ...ws,
      isFavorite: this.storage.isWorkspaceFavorite(ws.id),
    }));
    this.workspacesLive = true;

    const targets = this.selectedWorkspaceId
      ? all.filter((ws) => ws.id === this.selectedWorkspaceId)
      : all;
    this.progress = { done: 0, total: targets.length };
    this.postState();

    for (let i = 0; i < targets.length; i++) {
      if (i > 0) await new Promise((r) => setTimeout(r, 500));
      if (!isCurrent()) return;
      const ws = targets[i];
      const items = await listWorkspaceItems(
        this.fabricApi,
        this.currentTenantId,
        ws.id,
        ws.displayName,
      );
      // An empty listing is far more often a swallowed error than an emptied
      // workspace — don't wipe what the cache knows about it.
      if (items.length > 0) {
        for (const [id, p] of this.catalog) if (p.workspaceId === ws.id) this.catalog.delete(id);
        for (const p of items) this.catalog.set(p.id, { ...p, tenantId: this.currentTenantId });
      }
      this.progress = { done: i + 1, total: targets.length };
      this.postState();
    }
    this.listedKey = key;
  }

  /** Catalog entries the current filters (workspace, favorites) put on the calendar. */
  private scopeItems(): Pipeline[] {
    return [...this.catalog.values()].filter(
      (p) =>
        (!this.selectedWorkspaceId || p.workspaceId === this.selectedWorkspaceId) &&
        (!this.favoritesOnly || this.storage.isFavorite(p.id)) &&
        !this.isBlacklisted({ id: p.workspaceId, displayName: p.workspaceName }),
    );
  }

  // ─── Live data ──────────────────────────────────────────────────────────────

  /** Fetches schedule + runs for the items whose data is older than the polling
   *  interval, in batches that follow the same throttling settings as the dashboard. */
  private async fetchLive(
    items: Pipeline[],
    opts: { force: boolean; fullHistory?: boolean },
    isCurrent: () => boolean,
  ): Promise<void> {
    const cfg = vscode.workspace.getConfiguration('fabricPulse');
    const pollingMs = cfg.get<number>('pollingInterval', 60) * 1000;
    const batchSize = cfg.get<number>('batchSize', 5);
    const batchDelayMs = cfg.get<number>('batchDelayMs', 2500);
    const batchThreshold = cfg.get<number>('batchThreshold', 10);

    const stale = items.filter(
      (p) => opts.force || Date.now() - (this.fetchedAt.get(p.id) ?? 0) >= pollingMs,
    );
    if (stale.length === 0) return;

    const autoFull = items.length <= FULL_HISTORY_AUTO_MAX;
    const useBatching = stale.length > batchThreshold;
    const totalBatches = Math.ceil(stale.length / batchSize);

    for (let i = 0; i < stale.length; i += batchSize) {
      if (!isCurrent()) return;
      if (useBatching && i > 0) await new Promise((r) => setTimeout(r, batchDelayMs));

      const batchNum = Math.floor(i / batchSize);
      if (useBatching) {
        this.progress = { done: batchNum, total: totalBatches };
        this.postState();
      }

      await Promise.all(
        stale
          .slice(i, i + batchSize)
          .map((p) =>
            this.fetchItem(p, !!opts.fullHistory || (autoFull && !this.historyLoaded.has(p.id))),
          ),
      );
      this.postState();
    }
  }

  /** Schedule and runs of one item, fetched concurrently. Non-fatal: whatever fails
   *  keeps its previous value, and the calendar draws what it has. */
  private async fetchItem(p: Pipeline, fullHistory: boolean): Promise<void> {
    const ref = {
      tenantId: this.currentTenantId,
      workspaceId: p.workspaceId,
      itemId: p.id,
      itemType: p.itemType,
    };

    await Promise.all([
      (async () => {
        try {
          const info = await fetchItemSchedule(this.fabricApi, ref);
          if (info !== undefined) this.schedulesById.set(p.id, info);
        } catch (err) {
          console.warn(`[FabricPulse] Calendar: schedule fetch failed for ${p.id}:`, err);
        }
      })(),
      (async () => {
        try {
          let runs: PipelineRun[];
          if (fullHistory) {
            runs = await fetchItemRuns(this.fabricApi, ref);
            this.historyLoaded.add(p.id);
          } else {
            const last = await fetchItemLastRun(this.fabricApi, ref);
            runs = last ? [last] : [];
          }
          if (runs.length > 0) {
            this.storage.upsertRunsBatch(
              runs.map((r) => ({
                tenantId: ref.tenantId, // not this.currentTenantId: the user may have switched meanwhile
                workspaceId: p.workspaceId,
                pipelineId: p.id,
                pipelineName: p.displayName,
                workspaceName: p.workspaceName,
                runId: r.runId,
                status: r.status,
                startTime: r.startTime,
                endTime: r.endTime,
                durationMs: r.durationMs,
                errorMessage: r.errorMessage,
                itemType: p.itemType ?? 'pipeline',
              })),
            );
          }
        } catch (err) {
          console.warn(`[FabricPulse] Calendar: run fetch failed for ${p.id}:`, err);
        }
      })(),
    ]);

    this.fetchedAt.set(p.id, Date.now());
  }

  /** Background refresh. The next tick is scheduled *before* the refresh runs, so a
   *  refresh that throws or hangs costs one cycle, never the loop (see CLAUDE.md). */
  private schedulePoll(): void {
    if (this.disposed) return;
    const seconds = Math.max(
      MIN_POLL_SECONDS,
      vscode.workspace.getConfiguration('fabricPulse').get<number>('pollingInterval', 60),
    );
    this.pollTimer = setTimeout(() => {
      this.schedulePoll();
      this.refresh().catch((err) =>
        console.warn('[FabricPulse] Calendar polling refresh failed — the loop continues:', err),
      );
    }, seconds * 1000);
  }

  // ─── Auth ───────────────────────────────────────────────────────────────────

  /** Mirrors the auth phase into the banner. The VS Code notification is the
   *  dashboard's job — two open panels would raise it twice. */
  private onAuthStateChange(state: AuthState): void {
    if (this.disposed || state.tenantId !== this.currentTenantId) return;
    if (state.phase === 'idle' && !this.authState) return;
    this.authState =
      state.phase === 'idle' ? undefined : { phase: state.phase, message: state.message };
    this.postState();
  }

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

  // ─── Messages ───────────────────────────────────────────────────────────────

  /** The webview is a less-trusted context: validate before acting (see DashboardPanel). */
  private validateMsg(msg: CalendarToExtMsg): boolean {
    const fail = (reason: string) => {
      console.warn(`[FabricPulse] Invalid calendar message (${msg.type}): ${reason}`);
      return false;
    };
    const validRange = (from: unknown, to: unknown): boolean => {
      if (typeof from !== 'string' || typeof to !== 'string') return false;
      const a = Date.parse(from);
      const b = Date.parse(to);
      return Number.isFinite(a) && Number.isFinite(b) && b > a && b - a <= MAX_RANGE_MS;
    };

    switch (msg.type) {
      case 'ready':
      case 'setRange':
        if (!validRange(msg.rangeStart, msg.rangeEnd)) return fail('bad range');
        break;
      case 'selectTenant':
        if (!isUuid(msg.tenantId)) return fail('bad tenantId');
        break;
      case 'selectWorkspace':
        if (msg.workspaceId && !isUuid(msg.workspaceId)) return fail('bad workspaceId');
        break;
      case 'setFavoritesOnly':
        if (typeof msg.enabled !== 'boolean') return fail('bad enabled');
        break;
      case 'loadHistory':
        if (
          !Array.isArray(msg.itemIds) ||
          msg.itemIds.length > LOAD_HISTORY_MAX_ITEMS ||
          !msg.itemIds.every(isUuid)
        )
          return fail('bad itemIds');
        break;
      case 'openInFabric':
      case 'viewHistory':
        if (!isUuid(msg.itemId)) return fail('bad itemId');
        break;
    }
    return true;
  }

  private async handleMessage(msg: CalendarToExtMsg): Promise<void> {
    if (!this.validateMsg(msg)) return;

    switch (msg.type) {
      case 'ready':
        this.rangeStartMs = Date.parse(msg.rangeStart);
        this.rangeEndMs = Date.parse(msg.rangeEnd);
        await this.refresh();
        break;

      case 'setRange':
        // Everything needed is already local — schedules are expanded, not fetched.
        this.rangeStartMs = Date.parse(msg.rangeStart);
        this.rangeEndMs = Date.parse(msg.rangeEnd);
        this.postState();
        break;

      case 'refresh':
        await this.refresh(true);
        break;

      case 'reauthenticate':
        await this.reauthenticate();
        break;

      case 'selectTenant':
        this.abandonRefresh();
        this.currentTenantId = msg.tenantId;
        this.authState = undefined; // auth state is per-tenant
        this.workspaces = [];
        this.workspacesLive = false;
        this.selectedWorkspaceId = '';
        this.catalog.clear();
        this.schedulesById.clear();
        this.fetchedAt.clear();
        this.historyLoaded.clear();
        this.listedKey = '';
        this.favoritesDefaultApplied = false;
        await this.refresh();
        break;

      case 'selectWorkspace':
        this.abandonRefresh();
        this.selectedWorkspaceId = msg.workspaceId;
        await this.refresh();
        break;

      case 'setFavoritesOnly':
        this.abandonRefresh();
        this.favoritesOnly = msg.enabled;
        // Leaving favorites mode widens the scope to workspaces not listed yet.
        await this.refresh();
        break;

      case 'loadHistory':
        await this.loadHistory(msg.itemIds);
        break;

      case 'addTenant':
        await vscode.commands.executeCommand('fabricPulse.addTenant');
        break;

      case 'openInFabric': {
        const item = this.catalog.get(msg.itemId);
        if (!item) break;
        await vscode.env.openExternal(
          vscode.Uri.parse(fabricItemUrl(item.workspaceId, item.id, item.itemType)),
        );
        break;
      }

      case 'viewHistory': {
        const item = this.catalog.get(msg.itemId);
        if (!item) break;
        const { HistoryPanel } = await import('./historyPanel');
        HistoryPanel.createOrShow(this.extensionUri, item, this.storage, this.notifications);
        break;
      }
    }
  }

  /** "Load history": pulls the full run history of the items on screen, which a
   *  large scope doesn't get automatically. */
  private async loadHistory(itemIds: string[]): Promise<void> {
    const items = itemIds
      .map((id) => this.catalog.get(id))
      .filter((p): p is Pipeline => p !== undefined);
    if (items.length === 0) return;
    if (this.isLoading) {
      this.post({
        type: 'toast',
        message: 'A refresh is running — try again in a moment.',
        level: 'info',
      });
      return;
    }

    this.isLoading = true;
    this.loadingStartedAt = Date.now();
    const seq = ++this.refreshSeq;
    const isCurrent = () => seq === this.refreshSeq;
    this.post({
      type: 'toast',
      message: `Loading run history for ${items.length} item${items.length > 1 ? 's' : ''}…`,
      level: 'info',
    });
    try {
      await this.fetchLive(items, { force: true, fullHistory: true }, isCurrent);
      if (isCurrent()) {
        this.post({ type: 'toast', message: 'Run history loaded.', level: 'success', log: false });
      }
    } catch (err: unknown) {
      this.post({
        type: 'toast',
        message: err instanceof Error ? err.message : String(err),
        level: 'error',
      });
    } finally {
      if (isCurrent()) {
        this.isLoading = false;
        this.progress = undefined;
        this.postState();
      }
    }
  }

  // ─── State ──────────────────────────────────────────────────────────────────

  private buildState(): CalendarState {
    const scope = this.scopeItems();
    // A run that started before the window can still reach into it.
    const since = new Date(this.rangeStartMs - 2 * 86_400_000).toISOString();

    const items: CalendarItem[] = [];
    const sources: CalendarSource[] = [];
    for (const p of scope) {
      const schedule = this.schedulesById.get(p.id);
      items.push({
        id: p.id,
        displayName: p.displayName,
        workspaceId: p.workspaceId,
        workspaceName: p.workspaceName,
        itemType: p.itemType ?? 'pipeline',
        isFavorite: this.storage.isFavorite(p.id),
        lastStatus: this.storage.getLastRun(p.id)?.status,
        scheduleSummary: schedule?.summary,
        scheduleEnabled: schedule?.enabled,
      });
      sources.push({
        itemId: p.id,
        runs: this.storage.getRuns(p.id, since),
        defs: schedule?.defs,
        avgDurationMs: this.storage.getDurationStats(p.id).avg,
      });
    }

    return {
      tenants: this.tenants,
      currentTenantId: this.currentTenantId,
      workspaces: this.workspaces,
      selectedWorkspaceId: this.selectedWorkspaceId,
      favoritesOnly: this.favoritesOnly,
      items,
      events: buildCalendarEvents(sources, this.rangeStartMs, this.rangeEndMs),
      rangeStart: new Date(this.rangeStartMs).toISOString(),
      rangeEnd: new Date(this.rangeEndMs).toISOString(),
      lastRefreshed: this.lastRefreshed,
      isLoading: this.isLoading,
      progress: this.progress,
      auth: this.authState,
    };
  }

  private postState(): void {
    this.post({ type: 'updateState', state: this.buildState() });
  }

  private post(msg: ExtToCalendarMsg): void {
    // Same rule as the dashboard: toasts fade, so non-trivial ones are also kept.
    if (msg.type === 'toast' && msg.level !== 'info' && msg.log !== false) {
      this.notifications.add(msg.level, 'Calendar', msg.message);
    }
    if (this.disposed) return;
    this.panel.webview.postMessage(msg);
  }

  // ─── HTML ───────────────────────────────────────────────────────────────────

  private buildHtml(): string {
    const webviewDir = vscode.Uri.joinPath(this.extensionUri, 'src', 'webview');
    let html = fs.readFileSync(path.join(webviewDir.fsPath, 'calendar.html'), 'utf-8');

    const asUri = (file: string) =>
      this.panel.webview.asWebviewUri(vscode.Uri.joinPath(webviewDir, file)).toString();
    const nonce = getNonce();
    const v = Date.now();

    html = html
      .replace(/\{\{DASHBOARD_CSS_URI\}\}/g, asUri('dashboard.css') + '?v=' + v)
      .replace(/\{\{CSS_URI\}\}/g, asUri('calendar.css') + '?v=' + v)
      .replace(/\{\{JS_URI\}\}/g, asUri('calendar.js') + '?v=' + v)
      .replace(/\{\{NONCE\}\}/g, nonce)
      .replace(/\{\{WEBVIEW_CSP_SOURCE\}\}/g, this.panel.webview.cspSource);

    return html;
  }

  // ─── Dispose ────────────────────────────────────────────────────────────────

  public dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    if (this.pollTimer !== undefined) clearTimeout(this.pollTimer);
    if (this.clockTimer !== undefined) clearInterval(this.clockTimer);
    CalendarPanel.currentPanel = undefined;
    this.panel.dispose();
    this.disposables.forEach((d) => d.dispose());
    this.disposables.length = 0;
  }
}
