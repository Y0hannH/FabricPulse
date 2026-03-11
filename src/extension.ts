import * as vscode from 'vscode';
import { DashboardPanel } from './panels/DashboardPanel';
import { HistoryPanel } from './panels/HistoryPanel';
import { FabricApiService } from './services/fabricApi';
import { AuthService } from './services/authService';
import { StorageService } from './services/storageService';
import { AlertService } from './services/alertService';
import { Tenant } from './models/types';

// Services (initialized in activate, used across commands)
let _storage: StorageService;
let _alertService: AlertService;
let _pollingTimer: ReturnType<typeof setTimeout> | undefined;

// ─── Extension activation ─────────────────────────────────────────────────────

export async function activate(context: vscode.ExtensionContext): Promise<void> {
  console.log('[FabricPulse] Activating...');

  // ── Initialize services ───────────────────────────────────────────────────

  const authService = new AuthService();
  _storage = new StorageService(context);
  _alertService = new AlertService(_storage, context);

  try {
    await _storage.initialize();
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    vscode.window.showErrorMessage(`FabricPulse: ${msg}`, 'OK');
    return; // Extension still loads but without persistent storage
  }

  const fabricApi = new FabricApiService(authService);

  // Schedule daily report for already-configured tenants
  const tenants = context.globalState.get<Tenant[]>('fabricPulse.tenants', []);
  if (tenants.length > 0) {
    _alertService.scheduleDailyReport(tenants[0].tenantId);
  }

  // ── Register commands ─────────────────────────────────────────────────────

  context.subscriptions.push(

    // fabricPulse.openDashboard ─────────────────────────────────────────────
    vscode.commands.registerCommand('fabricPulse.openDashboard', () => {
      const panel = DashboardPanel.createOrShow(
        context.extensionUri, fabricApi, _storage, _alertService, context,
      );
      startPolling(panel);
    }),

    // fabricPulse.addTenant ────────────────────────────────────────────────
    vscode.commands.registerCommand('fabricPulse.addTenant', async () => {
      const name = await vscode.window.showInputBox({
        title: 'FabricPulse — Add Tenant',
        prompt: 'Enter a display name for this tenant',
        placeHolder: 'e.g. Production, Client A, Dev...',
        validateInput: v => v.trim().length > 0 ? null : 'Name cannot be empty',
      });
      if (!name) return;

      const tenantId = await vscode.window.showInputBox({
        title: 'FabricPulse — Add Tenant',
        prompt: 'Enter the Azure Tenant ID (GUID)',
        placeHolder: 'xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx',
        validateInput: v =>
          /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(v.trim())
            ? null
            : 'Invalid Tenant ID — must be a UUID (e.g. 6ba7b810-9dad-11d1-80b4-00c04fd430c8)',
      });
      if (!tenantId) return;

      const existing = context.globalState.get<Tenant[]>('fabricPulse.tenants', []);

      // Avoid duplicates
      if (existing.some(t => t.tenantId.toLowerCase() === tenantId.trim().toLowerCase())) {
        vscode.window.showWarningMessage(`Tenant "${name}" is already configured.`);
        return;
      }

      const newTenant: Tenant = { id: tenantId.trim(), name: name.trim(), tenantId: tenantId.trim() };
      existing.push(newTenant);
      await context.globalState.update('fabricPulse.tenants', existing);

      // Start daily report for first tenant
      if (existing.length === 1) {
        _alertService.scheduleDailyReport(newTenant.tenantId);
      }

      vscode.window.showInformationMessage(`✅ Tenant "${name}" added to FabricPulse`);

      // Refresh dashboard if open
      if (DashboardPanel.currentPanel) {
        DashboardPanel.currentPanel.reloadTenants();
        await DashboardPanel.currentPanel.refresh();
      }
    }),

    // fabricPulse.exportHistory ────────────────────────────────────────────
    vscode.commands.registerCommand('fabricPulse.exportHistory', async () => {
      vscode.window.showInformationMessage(
        'Use the Export CSV / Export JSON buttons inside the History panel.',
      );
    }),

    // fabricPulse.clearHistory ─────────────────────────────────────────────
    vscode.commands.registerCommand('fabricPulse.clearHistory', async () => {
      const answer = await vscode.window.showWarningMessage(
        'This will permanently delete all locally stored pipeline run history. This cannot be undone.',
        { modal: true },
        'Delete All History',
      );
      if (answer !== 'Delete All History') return;

      _storage.clearAllHistory();
      vscode.window.showInformationMessage('FabricPulse: Local history cleared.');

      if (DashboardPanel.currentPanel) {
        await DashboardPanel.currentPanel.refresh();
      }
    }),

    // Internal: open history for a specific pipeline ────────────────────────
    vscode.commands.registerCommand('fabricPulse.openHistory', async (pipelineId: string) => {
      if (DashboardPanel.currentPanel) {
        await DashboardPanel.currentPanel.refresh();
      }
      // HistoryPanel.createOrShow is called from the dashboard message handler
    }),

  );

  // ── Cleanup on deactivation ────────────────────────────────────────────────

  context.subscriptions.push({
    dispose: () => {
      stopPolling();
      _alertService.dispose();
      _storage.close();
    },
  });

  console.log('[FabricPulse] Activated.');
}

// ─── Polling loop ─────────────────────────────────────────────────────────────

function startPolling(panel: DashboardPanel): void {
  stopPolling();

  // Use a recursive setTimeout so the interval re-reads the config on every
  // tick — changes in VS Code settings apply immediately without a restart.
  const tick = async () => {
    if (!DashboardPanel.currentPanel) {
      stopPolling();
      return;
    }
    await DashboardPanel.currentPanel.refresh();
    const intervalSecs = vscode.workspace
      .getConfiguration('fabricPulse')
      .get<number>('pollingInterval', 60);
    const nextAt = new Date(Date.now() + intervalSecs * 1000).toISOString();
    DashboardPanel.currentPanel?.setNextRefreshAt(nextAt);
    _pollingTimer = setTimeout(tick, intervalSecs * 1000);
  };

  const intervalSecs = vscode.workspace
    .getConfiguration('fabricPulse')
    .get<number>('pollingInterval', 60);
  const nextAt = new Date(Date.now() + intervalSecs * 1000).toISOString();
  panel.setNextRefreshAt(nextAt);
  _pollingTimer = setTimeout(tick, intervalSecs * 1000);
}

function stopPolling(): void {
  if (_pollingTimer !== undefined) {
    clearTimeout(_pollingTimer);
    _pollingTimer = undefined;
  }
}

// ─── Extension deactivation ───────────────────────────────────────────────────

export function deactivate(): void {
  stopPolling();
}
