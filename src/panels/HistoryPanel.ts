import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import * as crypto from 'crypto';
import { StorageService } from '../services/storageService';
import { Pipeline, HistoryData, HistoryToExtMsg, ExtToHistoryMsg } from '../models/types';

/** Cryptographically secure nonce for CSP. Never use Math.random() for nonces. */
function getNonce(): string {
  return crypto.randomBytes(16).toString('hex'); // 128-bit entropy
}

type Period = '7d' | '30d' | '90d' | 'all';

export class HistoryPanel {
  private static readonly _panels = new Map<string, HistoryPanel>();
  private static readonly VIEW_TYPE = 'fabricPulseHistory';

  private readonly _panel: vscode.WebviewPanel;
  private readonly _disposables: vscode.Disposable[] = [];
  private _period: Period = '30d';

  // ─── Factory ────────────────────────────────────────────────────────────────

  public static createOrShow(
    extensionUri: vscode.Uri,
    pipeline: Pipeline,
    storage: StorageService,
  ): void {
    const existing = HistoryPanel._panels.get(pipeline.id);
    if (existing) {
      existing._panel.reveal(vscode.ViewColumn.Beside);
      return;
    }

    const webviewUri = vscode.Uri.joinPath(extensionUri, 'src', 'webview');
    const panel = vscode.window.createWebviewPanel(
      HistoryPanel.VIEW_TYPE,
      `📊 ${pipeline.displayName}`,
      vscode.ViewColumn.Beside,
      {
        enableScripts: true,
        retainContextWhenHidden: true,
        localResourceRoots: [webviewUri],
      },
    );

    new HistoryPanel(panel, extensionUri, pipeline, storage);
  }

  // ─── Constructor ─────────────────────────────────────────────────────────────

  private constructor(
    panel: vscode.WebviewPanel,
    private readonly _extensionUri: vscode.Uri,
    private readonly _pipeline: Pipeline,
    private readonly _storage: StorageService,
  ) {
    this._panel = panel;
    HistoryPanel._panels.set(_pipeline.id, this);

    this._panel.webview.html = this._buildHtml();

    this._panel.webview.onDidReceiveMessage(
      (msg: HistoryToExtMsg) => this._handleMessage(msg),
      null,
      this._disposables,
    );

    this._panel.onDidDispose(() => this.dispose(), null, this._disposables);
  }

  // ─── Data ────────────────────────────────────────────────────────────────────

  private _sendData(): void {
    const since = this._getSince();
    const days = this._getDays();

    const runs = this._storage.getRuns(this._pipeline.id, since);
    const annotations = this._storage.getAnnotations(this._pipeline.id);
    const { rate, total } = this._storage.getSuccessRate(this._pipeline.id, days || 3650);
    const patterns = this._storage.detectPatterns(this._pipeline.id, days || 90);

    const lastCachedAt = runs.reduce<string | undefined>((max, r) => {
      if (!r.createdAt) return max;
      return max === undefined || r.createdAt > max ? r.createdAt : max;
    }, undefined);

    const data: HistoryData = {
      pipeline: this._pipeline,
      runs,
      annotations,
      period: this._period,
      successRate: rate,
      totalRuns: total,
      patterns,
      lastCachedAt,
    };

    this._post({ type: 'historyData', data });
  }

  private _getSince(): string | undefined {
    const days = this._getDays();
    if (days === 0) return undefined;
    return new Date(Date.now() - days * 86_400_000).toISOString();
  }

  private _getDays(): number {
    switch (this._period) {
      case '7d':  return 7;
      case '30d': return 30;
      case '90d': return 90;
      case 'all': return 0;
    }
  }

  // ─── Message handling ────────────────────────────────────────────────────────

  private static readonly VALID_PERIODS = new Set(['7d', '30d', '90d', 'all']);
  private static readonly DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
  private static readonly MAX_NOTE_LENGTH = 500;

  private async _handleMessage(msg: HistoryToExtMsg): Promise<void> {
    switch (msg.type) {

      case 'ready':
        this._sendData();
        break;

      case 'setPeriod':
        if (!HistoryPanel.VALID_PERIODS.has(msg.period)) {
          console.warn(`[FabricPulse] Invalid period: ${msg.period}`);
          break;
        }
        this._period = msg.period;
        this._sendData();
        break;

      case 'addAnnotation':
        if (!HistoryPanel.DATE_RE.test(msg.date)) {
          console.warn(`[FabricPulse] Invalid annotation date: ${msg.date}`);
          break;
        }
        if (typeof msg.note !== 'string' || msg.note.length === 0 || msg.note.length > HistoryPanel.MAX_NOTE_LENGTH) {
          console.warn('[FabricPulse] Invalid annotation note');
          break;
        }
        this._storage.addAnnotation({
          pipelineId: this._pipeline.id,
          date: msg.date,
          note: msg.note,
        });
        this._sendData();
        break;

      case 'exportCsv': {
        const since = this._getSince();
        const csv = this._storage.exportRunsCsv(this._pipeline.id, since);
        const uri = await vscode.window.showSaveDialog({
          defaultUri: vscode.Uri.file(`${this._pipeline.displayName}_history.csv`),
          filters: { 'CSV Files': ['csv'] },
        });
        if (uri) {
          fs.writeFileSync(uri.fsPath, csv, 'utf-8');
          this._post({ type: 'toast', message: 'CSV exported', level: 'success' });
        }
        break;
      }

      case 'exportJson': {
        const since = this._getSince();
        const json = this._storage.exportRunsJson(this._pipeline.id, since);
        const uri = await vscode.window.showSaveDialog({
          defaultUri: vscode.Uri.file(`${this._pipeline.displayName}_history.json`),
          filters: { 'JSON Files': ['json'] },
        });
        if (uri) {
          fs.writeFileSync(uri.fsPath, json, 'utf-8');
          this._post({ type: 'toast', message: 'JSON exported', level: 'success' });
        }
        break;
      }
    }
  }

  // ─── Helpers ─────────────────────────────────────────────────────────────────

  private _post(msg: ExtToHistoryMsg): void {
    this._panel.webview.postMessage(msg);
  }

  private _buildHtml(): string {
    const webviewDir = vscode.Uri.joinPath(this._extensionUri, 'src', 'webview');
    const htmlPath = path.join(webviewDir.fsPath, 'history.html');
    let html = fs.readFileSync(htmlPath, 'utf-8');

    const cssUri = this._panel.webview.asWebviewUri(
      vscode.Uri.joinPath(webviewDir, 'dashboard.css'),
    );
    const jsUri = this._panel.webview.asWebviewUri(
      vscode.Uri.joinPath(webviewDir, 'history.js'),
    );
    const nonce = getNonce();

    html = html
      .replace(/\{\{CSS_URI\}\}/g, cssUri.toString())
      .replace(/\{\{JS_URI\}\}/g, jsUri.toString())
      .replace(/\{\{NONCE\}\}/g, nonce)
      .replace(/\{\{WEBVIEW_CSP_SOURCE\}\}/g, this._panel.webview.cspSource);

    return html;
  }

  public dispose(): void {
    HistoryPanel._panels.delete(this._pipeline.id);
    this._panel.dispose();
    this._disposables.forEach(d => d.dispose());
    this._disposables.length = 0;
  }
}
