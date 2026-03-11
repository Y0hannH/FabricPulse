import * as vscode from 'vscode';
import { StorageService } from './storageService';
import { PipelineWithStatus } from '../models/types';

/** Max number of alerted run IDs to keep in globalState. Old entries are
 *  evicted FIFO once this limit is reached.  Prevents unbounded growth. */
const MAX_ALERTED_RUNS = 500;
const ALERTED_STATE_KEY = 'fabricPulse.alertedRunIds';
const DAILY_REPORT_DATE_KEY = 'fabricPulse.lastDailyReportDate';

export class AlertService {
  private dailyReportTimer?: ReturnType<typeof setInterval>;
  private lastDailyReportDate: string;

  /** In-memory copy of alerted run IDs, synced to globalState. */
  private _alertedIds: Set<string>;

  constructor(
    private readonly storage: StorageService,
    private readonly context: vscode.ExtensionContext,
  ) {
    // Hydrate from persisted state
    const persisted = context.globalState.get<string[]>(ALERTED_STATE_KEY, []);
    this._alertedIds = new Set(persisted);
    this.lastDailyReportDate = context.globalState.get<string>(DAILY_REPORT_DATE_KEY, '');
  }

  /** Returns true if this run was already alerted. */
  private _wasAlerted(runId: string): boolean {
    return this._alertedIds.has(runId);
  }

  /** Marks a run as alerted and persists the bounded set. */
  private async _markAlerted(runId: string): Promise<void> {
    this._alertedIds.add(runId);

    // Evict oldest entries when the set exceeds the cap
    if (this._alertedIds.size > MAX_ALERTED_RUNS) {
      const ids = Array.from(this._alertedIds);
      this._alertedIds = new Set(ids.slice(ids.length - MAX_ALERTED_RUNS));
    }

    await this.context.globalState.update(ALERTED_STATE_KEY, Array.from(this._alertedIds));
  }

  // ─── Failure & duration alerts ───────────────────────────────────────────────

  async checkAlerts(pipelines: PipelineWithStatus[]): Promise<void> {
    for (const pipeline of pipelines) {
      if (!pipeline.isFavorite || !pipeline.alertEnabled) continue;

      const lastRun = pipeline.lastRun;
      if (!lastRun) continue;

      await this.checkFailureAlert(pipeline, lastRun.runId, lastRun.status);
      await this.checkDurationAlert(pipeline, lastRun.runId, lastRun.durationMs);
    }
  }

  private async checkFailureAlert(
    pipeline: PipelineWithStatus,
    runId: string,
    status: string,
  ): Promise<void> {
    if (status !== 'Failed') return;
    if (this._wasAlerted(runId)) return;

    const action = await vscode.window.showErrorMessage(
      `⚡ FabricPulse: "${pipeline.displayName}" failed in workspace "${pipeline.workspaceName}"`,
      'Open Dashboard',
      'View History',
      'Dismiss',
    );

    await this._markAlerted(runId);

    if (action === 'Open Dashboard') {
      vscode.commands.executeCommand('fabricPulse.openDashboard');
    } else if (action === 'View History') {
      vscode.commands.executeCommand('fabricPulse.openHistory', pipeline.id);
    }
  }

  private async checkDurationAlert(
    pipeline: PipelineWithStatus,
    runId: string,
    durationMs?: number,
  ): Promise<void> {
    if (!pipeline.durationThresholdMs || !durationMs) return;
    if (durationMs <= pipeline.durationThresholdMs) return;
    if (this._wasAlerted(runId)) return;

    const actual = formatDuration(durationMs);
    const threshold = formatDuration(pipeline.durationThresholdMs);

    await vscode.window.showWarningMessage(
      `⚡ FabricPulse: "${pipeline.displayName}" took ${actual} (threshold: ${threshold})`,
      'Open Dashboard',
      'Dismiss',
    );

    await this._markAlerted(runId);
  }

  // ─── Daily report ────────────────────────────────────────────────────────────

  scheduleDailyReport(tenantId: string): void {
    this.stopDailyReport();

    // Check every minute whether it's report time.
    // Uses >= comparison to avoid missing the target minute due to timer drift.
    this.dailyReportTimer = setInterval(() => {
      const now = new Date();
      const cfg = vscode.workspace.getConfiguration('fabricPulse').get<string>('dailyReportTime', '18:00');
      const [targetHour, targetMin] = cfg.split(':').map(Number);

      if (isNaN(targetHour) || isNaN(targetMin)) return; // guard against malformed config

      const today = now.toDateString();
      const nowMinutes = now.getHours() * 60 + now.getMinutes();
      const targetMinutes = targetHour * 60 + targetMin;

      if (
        nowMinutes >= targetMinutes &&
        this.lastDailyReportDate !== today
      ) {
        this.lastDailyReportDate = today;
        this.context.globalState.update(DAILY_REPORT_DATE_KEY, today);
        this.sendDailyReport(tenantId);
      }
    }, 60_000);
  }

  private sendDailyReport(tenantId: string): void {
    const stats = this.storage.getTodayStats(tenantId);

    if (stats.total === 0) {
      vscode.window.showInformationMessage('📊 FabricPulse: No pipeline runs recorded today.');
      return;
    }

    const msg = `📊 FabricPulse: ${stats.total} run${stats.total > 1 ? 's' : ''} today — ${stats.failed} failed`;

    vscode.window.showInformationMessage(msg, 'Open Dashboard').then(action => {
      if (action === 'Open Dashboard') {
        vscode.commands.executeCommand('fabricPulse.openDashboard');
      }
    });
  }

  stopDailyReport(): void {
    if (this.dailyReportTimer) {
      clearInterval(this.dailyReportTimer);
      this.dailyReportTimer = undefined;
    }
  }

  dispose(): void {
    this.stopDailyReport();
  }
}

function formatDuration(ms: number): string {
  const totalSecs = Math.round(ms / 1000);
  const mins = Math.floor(totalSecs / 60);
  const secs = totalSecs % 60;
  if (mins >= 60) {
    return `${Math.floor(mins / 60)}h ${mins % 60}m`;
  }
  return mins > 0 ? `${mins}m ${secs}s` : `${secs}s`;
}
