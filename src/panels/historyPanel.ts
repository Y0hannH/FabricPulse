import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';

import type { ExtToHistoryMsg, HistoryData, HistoryToExtMsg, Pipeline } from '../models/types';
import type { NotificationLog } from '../services/notificationLog';
import type { StorageService } from '../services/storageService';

/** Cryptographically secure nonce for CSP. Never use Math.random() for nonces. */
function getNonce(): string {
  return crypto.randomBytes(16).toString('hex'); // 128-bit entropy
}

type Period = '7d' | '30d' | '90d' | 'all';

export class HistoryPanel {
  private static readonly panels = new Map<string, HistoryPanel>();
  private static readonly VIEW_TYPE = 'fabricPulseHistory';

  private readonly panel: vscode.WebviewPanel;
  private readonly disposables: vscode.Disposable[] = [];
  private period: Period = '30d';

  // ─── Factory ────────────────────────────────────────────────────────────────

  public static createOrShow(
    extensionUri: vscode.Uri,
    pipeline: Pipeline,
    storage: StorageService,
    notifications: NotificationLog,
  ): void {
    const existing = HistoryPanel.panels.get(pipeline.id);
    if (existing) {
      existing.panel.reveal(vscode.ViewColumn.Beside);
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

    new HistoryPanel(panel, extensionUri, pipeline, storage, notifications);
  }

  // ─── Constructor ─────────────────────────────────────────────────────────────

  private constructor(
    panel: vscode.WebviewPanel,
    private readonly extensionUri: vscode.Uri,
    private readonly pipeline: Pipeline,
    private readonly storage: StorageService,
    private readonly notifications: NotificationLog,
  ) {
    this.panel = panel;
    HistoryPanel.panels.set(pipeline.id, this);

    this.panel.webview.html = this.buildHtml();

    this.panel.webview.onDidReceiveMessage(
      (msg: HistoryToExtMsg) => this.handleMessage(msg),
      null,
      this.disposables,
    );

    this.panel.onDidDispose(() => this.dispose(), null, this.disposables);
  }

  // ─── Data ────────────────────────────────────────────────────────────────────

  private sendData(): void {
    const since = this.getSince();
    const days = this.getDays();

    const runs = this.storage.getRuns(this.pipeline.id, since);
    const annotations = this.storage.getAnnotations(this.pipeline.id);
    const { rate, total } = this.storage.getSuccessRate(this.pipeline.id, days || 3650);
    const patterns = this.storage.detectPatterns(this.pipeline.id, days || 90);

    const lastCachedAt = runs.reduce<string | undefined>((max, r) => {
      if (!r.createdAt) return max;
      return max === undefined || r.createdAt > max ? r.createdAt : max;
    }, undefined);

    const data: HistoryData = {
      pipeline: this.pipeline,
      runs,
      annotations,
      period: this.period,
      successRate: rate,
      totalRuns: total,
      patterns,
      lastCachedAt,
    };

    this.post({ type: 'historyData', data });
  }

  private getSince(): string | undefined {
    const days = this.getDays();
    if (days === 0) return undefined;
    return new Date(Date.now() - days * 86_400_000).toISOString();
  }

  private getDays(): number {
    switch (this.period) {
      case '7d':
        return 7;
      case '30d':
        return 30;
      case '90d':
        return 90;
      case 'all':
        return 0;
    }
  }

  // ─── Message handling ────────────────────────────────────────────────────────

  private static readonly VALID_PERIODS = new Set(['7d', '30d', '90d', 'all']);
  private static readonly DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
  private static readonly MAX_NOTE_LENGTH = 500;

  private async handleMessage(msg: HistoryToExtMsg): Promise<void> {
    switch (msg.type) {
      case 'ready':
        this.sendData();
        break;

      case 'setPeriod':
        if (!HistoryPanel.VALID_PERIODS.has(msg.period)) {
          console.warn(`[FabricPulse] Invalid period: ${msg.period}`);
          break;
        }
        this.period = msg.period;
        this.sendData();
        break;

      case 'addAnnotation':
        if (!HistoryPanel.DATE_RE.test(msg.date)) {
          console.warn(`[FabricPulse] Invalid annotation date: ${msg.date}`);
          break;
        }
        if (
          typeof msg.note !== 'string' ||
          msg.note.length === 0 ||
          msg.note.length > HistoryPanel.MAX_NOTE_LENGTH
        ) {
          console.warn('[FabricPulse] Invalid annotation note');
          break;
        }
        this.storage.addAnnotation({
          pipelineId: this.pipeline.id,
          date: msg.date,
          note: msg.note,
        });
        this.sendData();
        break;

      case 'exportCsv': {
        const since = this.getSince();
        const csv = this.storage.exportRunsCsv(this.pipeline.id, since);
        const uri = await vscode.window.showSaveDialog({
          defaultUri: vscode.Uri.file(`${this.pipeline.displayName}_history.csv`),
          filters: { 'CSV Files': ['csv'] },
        });
        if (uri) {
          fs.writeFileSync(uri.fsPath, csv, 'utf-8');
          this.post({ type: 'toast', message: 'CSV exported', level: 'success', log: false });
        }
        break;
      }

      case 'exportJson': {
        const since = this.getSince();
        const json = this.storage.exportRunsJson(this.pipeline.id, since);
        const uri = await vscode.window.showSaveDialog({
          defaultUri: vscode.Uri.file(`${this.pipeline.displayName}_history.json`),
          filters: { 'JSON Files': ['json'] },
        });
        if (uri) {
          fs.writeFileSync(uri.fsPath, json, 'utf-8');
          this.post({ type: 'toast', message: 'JSON exported', level: 'success', log: false });
        }
        break;
      }
    }
  }

  // ─── Helpers ─────────────────────────────────────────────────────────────────

  private post(msg: ExtToHistoryMsg): void {
    // Toasts fade out after a few seconds, so each one is also recorded.
    // Info toasts are progress chatter ("Loading history…") and aren't kept.
    if (msg.type === 'toast' && msg.level !== 'info' && msg.log !== false) {
      this.notifications.add(msg.level, 'History', msg.message);
    }
    this.panel.webview.postMessage(msg);
  }

  private buildHtml(): string {
    const webviewDir = vscode.Uri.joinPath(this.extensionUri, 'src', 'webview');
    const htmlPath = path.join(webviewDir.fsPath, 'history.html');
    let html = fs.readFileSync(htmlPath, 'utf-8');

    const cssUri = this.panel.webview.asWebviewUri(
      vscode.Uri.joinPath(webviewDir, 'dashboard.css'),
    );
    const jsUri = this.panel.webview.asWebviewUri(vscode.Uri.joinPath(webviewDir, 'history.js'));
    const nonce = getNonce();

    const v = Date.now();
    html = html
      .replace(/\{\{CSS_URI\}\}/g, cssUri.toString() + '?v=' + v)
      .replace(/\{\{JS_URI\}\}/g, jsUri.toString() + '?v=' + v)
      .replace(/\{\{NONCE\}\}/g, nonce)
      .replace(/\{\{WEBVIEW_CSP_SOURCE\}\}/g, this.panel.webview.cspSource);

    return html;
  }

  public dispose(): void {
    HistoryPanel.panels.delete(this.pipeline.id);
    this.panel.dispose();
    this.disposables.forEach((d) => d.dispose());
    this.disposables.length = 0;
  }
}
