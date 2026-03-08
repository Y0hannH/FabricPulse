import * as vscode from 'vscode';
import { StorageService } from './storageService';
import { PipelineWithStatus } from '../models/types';

export class AlertService {
  private dailyReportTimer?: ReturnType<typeof setInterval>;
  private lastDailyReportDate = '';

  constructor(
    private readonly storage: StorageService,
    private readonly context: vscode.ExtensionContext,
  ) {}

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

    const stateKey = `fabricPulse.alerted.fail.${runId}`;
    if (this.context.globalState.get<boolean>(stateKey)) return;

    const action = await vscode.window.showErrorMessage(
      `⚡ FabricPulse: "${pipeline.displayName}" failed in workspace "${pipeline.workspaceName}"`,
      'Open Dashboard',
      'View History',
      'Dismiss',
    );

    await this.context.globalState.update(stateKey, true);

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

    const stateKey = `fabricPulse.alerted.duration.${runId}`;
    if (this.context.globalState.get<boolean>(stateKey)) return;

    const actual = formatDuration(durationMs);
    const threshold = formatDuration(pipeline.durationThresholdMs);

    await vscode.window.showWarningMessage(
      `⚡ FabricPulse: "${pipeline.displayName}" took ${actual} (threshold: ${threshold})`,
      'Open Dashboard',
      'Dismiss',
    );

    await this.context.globalState.update(stateKey, true);
  }

  // ─── Daily report ────────────────────────────────────────────────────────────

  scheduleDailyReport(tenantId: string): void {
    this.stopDailyReport();

    // Check every minute whether it's report time
    this.dailyReportTimer = setInterval(() => {
      const now = new Date();
      const cfg = vscode.workspace.getConfiguration('fabricPulse').get<string>('dailyReportTime', '18:00');
      const [targetHour, targetMin] = cfg.split(':').map(Number);
      const today = now.toDateString();

      if (
        now.getHours() === targetHour &&
        now.getMinutes() === targetMin &&
        this.lastDailyReportDate !== today
      ) {
        this.lastDailyReportDate = today;
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
