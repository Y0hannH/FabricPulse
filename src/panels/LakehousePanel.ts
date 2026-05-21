import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import * as crypto from 'crypto';
import { FabricApiService } from '../services/fabricApi';
import { StorageService } from '../services/storageService';
import {
  Tenant,
  Workspace,
  Lakehouse,
  LakehouseTable,
  LakehouseState,
  LakehouseToExtMsg,
  ExtToLakehouseMsg,
} from '../models/types';

// Utility ─────────────────────────────────────────────────────────────────────

function getNonce(): string {
  return crypto.randomBytes(16).toString('hex');
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
function isUuid(s: string): boolean {
  return UUID_RE.test(s);
}

// ─────────────────────────────────────────────────────────────────────────────

export class LakehousePanel {
  public static currentPanel: LakehousePanel | undefined;
  private static readonly VIEW_TYPE = 'fabricPulseLakehouse';

  private readonly _panel: vscode.WebviewPanel;
  private readonly _disposables: vscode.Disposable[] = [];

  // Panel state
  private _tenants: Tenant[] = [];
  private _currentTenantId = '';
  private _workspaces: Workspace[] = [];
  private _lakehouses: Lakehouse[] = [];
  private _selectedWorkspaceId = '';
  private _expandedLakehouseId = '';
  private _tables: LakehouseTable[] = [];
  private _isLoading = false;
  private _disposed = false;
  /** Cache table counts per lakehouse after first expand */
  private _tableCounts = new Map<string, number>();

  // ─── Factory ────────────────────────────────────────────────────────────────

  public static createOrShow(
    extensionUri: vscode.Uri,
    fabricApi: FabricApiService,
    storage: StorageService,
    context: vscode.ExtensionContext,
  ): LakehousePanel {
    const column = vscode.window.activeTextEditor?.viewColumn ?? vscode.ViewColumn.One;

    if (LakehousePanel.currentPanel) {
      LakehousePanel.currentPanel._panel.reveal(column);
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
      panel, extensionUri, fabricApi, storage, context,
    );
    return LakehousePanel.currentPanel;
  }

  // ─── Constructor ─────────────────────────────────────────────────────────────

  private constructor(
    panel: vscode.WebviewPanel,
    private readonly _extensionUri: vscode.Uri,
    private readonly _fabricApi: FabricApiService,
    private readonly _storage: StorageService,
    private readonly _context: vscode.ExtensionContext,
  ) {
    this._panel = panel;

    this._tenants = this._context.globalState.get<Tenant[]>('fabricPulse.tenants', []);
    if (this._tenants.length > 0) {
      this._currentTenantId = this._tenants[0].id;
    }

    this._panel.webview.html = this._buildHtml();

    this._panel.webview.onDidReceiveMessage(
      (msg: LakehouseToExtMsg) => this._handleMessage(msg),
      null,
      this._disposables,
    );

    this._panel.onDidDispose(() => this.dispose(), null, this._disposables);
  }

  // ─── Public ──────────────────────────────────────────────────────────────────

  public async refresh(): Promise<void> {
    if (this._isLoading || !this._currentTenantId) {
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
      // Fetch workspaces
      const rawWorkspaces = await this._fabricApi.getWorkspaces(this._currentTenantId);
      this._workspaces = rawWorkspaces
        .filter(ws => !isBlacklisted(ws))
        .map(ws => ({
          ...ws,
          isFavorite: this._storage.isWorkspaceFavorite(ws.id),
        }));
      this._postState();

      // Fetch lakehouses
      const filteredWorkspaces = this._selectedWorkspaceId
        ? this._workspaces.filter(w => w.id === this._selectedWorkspaceId)
        : this._workspaces;

      const allLakehouses: Lakehouse[] = [];

      for (let i = 0; i < filteredWorkspaces.length; i++) {
        if (i > 0) await new Promise(r => setTimeout(r, 500));
        const ws = filteredWorkspaces[i];
        try {
          const lhs = await this._fabricApi.getLakehouses(this._currentTenantId, ws.id);
          for (const lh of lhs) {
            lh.workspaceName = ws.displayName;
            lh.isFavorite = this._storage.isLakehouseFavorite(lh.id);
            allLakehouses.push(lh);
          }
        } catch (err) {
          console.warn(`[FabricPulse] Error fetching lakehouses for workspace ${ws.displayName}:`, err);
        }
      }

      this._lakehouses = allLakehouses;

      // Apply cached table counts
      for (const lh of this._lakehouses) {
        const cached = this._tableCounts.get(lh.id);
        if (cached !== undefined) lh.tableCount = cached;
      }

      // If a lakehouse was expanded, re-fetch its tables
      if (this._expandedLakehouseId) {
        const lh = this._lakehouses.find(l => l.id === this._expandedLakehouseId);
        if (lh) {
          try {
            this._tables = await this._fetchTables(lh);
            this._enrichTablesWithMaintenance(lh.id);
          } catch (err) {
            console.warn('[FabricPulse] Error fetching tables:', err);
            this._tables = [];
          }
        } else {
          this._expandedLakehouseId = '';
          this._tables = [];
        }
      }
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      this._post({ type: 'toast', message: msg, level: 'error' });
    } finally {
      this._isLoading = false;
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

  private _validateMsg(msg: LakehouseToExtMsg): boolean {
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
        if (!isUuid(msg.lakehouseId) || !isUuid(msg.workspaceId) || !isUuid(msg.tenantId)) return fail('bad UUID');
        break;
      case 'runMaintenance':
      case 'computeTableSize':
        if (!isUuid(msg.lakehouseId) || !isUuid(msg.workspaceId)) return fail('bad id');
        if (typeof msg.tableName !== 'string' || msg.tableName.length > 256) return fail('bad tableName');
        break;
      case 'copyConnectionString':
        if (typeof msg.connectionString !== 'string' || msg.connectionString.length > 1024) return fail('bad connectionString');
        break;
    }
    return true;
  }

  private async _handleMessage(msg: LakehouseToExtMsg): Promise<void> {
    if (!this._validateMsg(msg)) return;

    switch (msg.type) {

      case 'ready':
        await this.refresh();
        break;

      case 'refresh':
        await this.refresh();
        break;

      case 'selectTenant':
        this._currentTenantId = msg.tenantId;
        this._workspaces = [];
        this._lakehouses = [];
        this._selectedWorkspaceId = '';
        this._expandedLakehouseId = '';
        this._tables = [];
        await this.refresh();
        break;

      case 'selectWorkspace':
        this._selectedWorkspaceId = msg.workspaceId;
        this._expandedLakehouseId = '';
        this._tables = [];
        await this.refresh();
        break;

      case 'toggleFavorite': {
        const isFav = this._storage.isLakehouseFavorite(msg.lakehouseId);
        if (isFav) {
          this._storage.removeLakehouseFavorite(msg.lakehouseId);
        } else {
          this._storage.addLakehouseFavorite(this._currentTenantId, msg.workspaceId, msg.lakehouseId);
        }
        const lh = this._lakehouses.find(l => l.id === msg.lakehouseId);
        if (lh) lh.isFavorite = !isFav;
        this._postState();
        break;
      }

      case 'expandLakehouse': {
        if (this._expandedLakehouseId === msg.lakehouseId) {
          // Toggle collapse
          this._expandedLakehouseId = '';
          this._tables = [];
          this._postState();
          break;
        }
        const targetLh = this._lakehouses.find(l => l.id === msg.lakehouseId);
        if (!targetLh) break;
        this._expandedLakehouseId = msg.lakehouseId;
        this._isLoading = true;
        this._postState();
        try {
          this._tables = await this._fetchTables(targetLh);
          this._enrichTablesWithMaintenance(msg.lakehouseId);
          // Cache table count
          this._tableCounts.set(msg.lakehouseId, this._tables.length);
          targetLh.tableCount = this._tables.length;
        } catch (err: unknown) {
          this._tables = [];
          this._post({ type: 'toast', message: err instanceof Error ? err.message : String(err), level: 'error' });
        } finally {
          this._isLoading = false;
          this._postState();
        }
        break;
      }

      case 'collapseLakehouse':
        this._expandedLakehouseId = '';
        this._tables = [];
        this._postState();
        break;

      case 'copyConnectionString':
        await vscode.env.clipboard.writeText(msg.connectionString);
        this._post({ type: 'toast', message: 'Connection string copied to clipboard', level: 'success' });
        break;

      case 'runMaintenance': {
        // Build a description of what's being run
        const parts: string[] = ['Optimize'];
        if (msg.vOrder) parts.push('V-Order');
        if (msg.vacuum) parts.push('Vacuum');
        const desc = parts.join(' + ');
        // Schema-qualified key so two tables with the same name in different
        // schemas don't collide in the maintenance store.
        const maintKey = msg.schemaName ? `${msg.schemaName}.${msg.tableName}` : msg.tableName;

        try {
          const result = await this._fabricApi.triggerTableMaintenance(
            this._currentTenantId, msg.workspaceId, msg.lakehouseId, msg.tableName,
            {
              schemaName: msg.schemaName,
              vOrder: msg.vOrder,
              vacuum: msg.vacuum,
              vacuumRetention: msg.vacuumRetention,
            },
          );
          this._storage.upsertMaintenance(msg.lakehouseId, maintKey, `${desc} — InProgress`);
          this._enrichTablesWithMaintenance(msg.lakehouseId);
          this._postState();
          this._post({ type: 'toast', message: `${desc} triggered for "${msg.tableName}"`, level: 'success' });

          // Poll job status in background
          if (result.jobInstanceId) {
            this._pollMaintenanceJob(
              msg.workspaceId, msg.lakehouseId, result.jobInstanceId, maintKey, desc,
            );
          }
        } catch (err: unknown) {
          this._post({ type: 'toast', message: err instanceof Error ? err.message : String(err), level: 'error' });
        }
        break;
      }

      case 'computeTableSize': {
        try {
          const size = await this._fabricApi.getTableSize(
            this._currentTenantId, msg.workspaceId, msg.lakehouseId, msg.tableName, msg.schemaName,
          );
          const key = msg.schemaName ? `${msg.schemaName}.${msg.tableName}` : msg.tableName;
          const t = this._tables.find(
            tbl => (tbl.schema ? `${tbl.schema}.${tbl.name}` : tbl.name) === key,
          );
          if (t) t.sizeBytes = size;
          this._postState();
        } catch (err: unknown) {
          this._post({ type: 'toast', message: err instanceof Error ? err.message : String(err), level: 'error' });
        } finally {
          this._post({ type: 'sizeComputed', tableName: msg.tableName, schemaName: msg.schemaName });
        }
        break;
      }

      case 'openInFabric': {
        const url = `https://app.fabric.microsoft.com/groups/${msg.workspaceId}/lakehouses/${msg.lakehouseId}`;
        await vscode.env.openExternal(vscode.Uri.parse(url));
        break;
      }
    }
  }

  // ─── Job polling ─────────────────────────────────────────────────────────

  private async _pollMaintenanceJob(
    workspaceId: string,
    lakehouseId: string,
    jobInstanceId: string,
    maintKey: string,
    desc: string,
  ): Promise<void> {
    const POLL_INTERVAL_MS = 5_000;
    const MAX_POLLS = 60; // 5 min max
    const TERMINAL = new Set(['Completed', 'Failed', 'Cancelled', 'Deduped']);

    for (let i = 0; i < MAX_POLLS; i++) {
      await new Promise(r => setTimeout(r, POLL_INTERVAL_MS));
      if (this._disposed) return;

      try {
        const job = await this._fabricApi.getJobInstance(
          this._currentTenantId, workspaceId, lakehouseId, jobInstanceId,
        );

        const statusLabel = `${desc} — ${job.status}`;
        this._storage.upsertMaintenance(lakehouseId, maintKey, statusLabel);

        // Update UI if this lakehouse is currently expanded
        if (this._expandedLakehouseId === lakehouseId) {
          this._enrichTablesWithMaintenance(lakehouseId);
          this._postState();
        }

        if (TERMINAL.has(job.status)) {
          const level = job.status === 'Completed' ? 'success' : 'error';
          const failMsg = job.failureReason ? ` — ${job.failureReason}` : '';
          this._post({
            type: 'toast',
            message: `${desc} on "${maintKey}": ${job.status}${failMsg}`,
            level,
          });
          return;
        }
      } catch (err) {
        console.warn(`[FabricPulse] Error polling maintenance job ${jobInstanceId}:`, err);
        // Continue polling — transient errors shouldn't stop tracking
      }
    }

    // Timeout — update status
    this._storage.upsertMaintenance(lakehouseId, maintKey, `${desc} — Timeout (still running?)`);
    if (this._expandedLakehouseId === lakehouseId) {
      this._enrichTablesWithMaintenance(lakehouseId);
      this._postState();
    }
  }

  // ─── Helpers ───────────────────────────────────────────────────────────────

  private _enrichTablesWithMaintenance(lakehouseId: string): void {
    const maintenances = this._storage.getAllMaintenances(lakehouseId);
    for (const t of this._tables) {
      const key = t.schema ? `${t.schema}.${t.name}` : t.name;
      const m = maintenances.get(key);
      if (m) {
        t.lastMaintenanceAt = m.triggeredAt;
        t.maintenanceStatus = m.status;
      }
    }
  }

  /** Schema-enabled lakehouses are listed via OneLake (the Fabric List Tables
   *  API does not support them); regular lakehouses use the Fabric API. */
  private _fetchTables(lh: Lakehouse): Promise<LakehouseTable[]> {
    return lh.isSchemaEnabled
      ? this._fabricApi.getSchemaLakehouseTables(this._currentTenantId, lh.workspaceId, lh.id)
      : this._fabricApi.getLakehouseTables(this._currentTenantId, lh.workspaceId, lh.id);
  }

  // ─── State ──────────────────────────────────────────────────────────────────

  private _postState(): void {
    const state: LakehouseState = {
      tenants: this._tenants,
      currentTenantId: this._currentTenantId,
      workspaces: this._workspaces,
      lakehouses: this._lakehouses,
      selectedWorkspaceId: this._selectedWorkspaceId,
      expandedLakehouseId: this._expandedLakehouseId,
      tables: this._tables,
      isLoading: this._isLoading,
    };
    this._post({ type: 'updateState', state });
  }

  private _post(msg: ExtToLakehouseMsg): void {
    if (this._disposed) return;
    this._panel.webview.postMessage(msg);
  }

  // ─── HTML ────────────────────────────────────────────────────────────────────

  private _buildHtml(): string {
    const webviewDir = vscode.Uri.joinPath(this._extensionUri, 'src', 'webview');
    const htmlPath = path.join(webviewDir.fsPath, 'lakehouse.html');
    let html = fs.readFileSync(htmlPath, 'utf-8');

    const cssUri = this._panel.webview.asWebviewUri(
      vscode.Uri.joinPath(webviewDir, 'dashboard.css'),
    );
    const jsUri = this._panel.webview.asWebviewUri(
      vscode.Uri.joinPath(webviewDir, 'lakehouse.js'),
    );
    const nonce = getNonce();

    html = html
      .replace(/\{\{CSS_URI\}\}/g, cssUri.toString())
      .replace(/\{\{JS_URI\}\}/g, jsUri.toString())
      .replace(/\{\{NONCE\}\}/g, nonce)
      .replace(/\{\{WEBVIEW_CSP_SOURCE\}\}/g, this._panel.webview.cspSource);

    return html;
  }

  // ─── Dispose ─────────────────────────────────────────────────────────────────

  public dispose(): void {
    this._disposed = true;
    LakehousePanel.currentPanel = undefined;
    this._panel.dispose();
    this._disposables.forEach(d => d.dispose());
    this._disposables.length = 0;
  }
}
