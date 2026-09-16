import * as vscode from 'vscode';
import { NotificationEntry, NotificationLevel, NotificationLog } from '../services/notificationLog';

const ICONS: Record<NotificationLevel, vscode.ThemeIcon> = {
  error:   new vscode.ThemeIcon('error',   new vscode.ThemeColor('charts.red')),
  warning: new vscode.ThemeIcon('warning', new vscode.ThemeColor('charts.yellow')),
  success: new vscode.ThemeIcon('pass',    new vscode.ThemeColor('charts.green')),
  info:    new vscode.ThemeIcon('info',    new vscode.ThemeColor('charts.blue')),
};

const pad = (n: number) => String(n).padStart(2, '0');

/** Absolute rather than relative time: a relative label ("2 min ago") would go
 *  stale in a tree that is only redrawn when a notification arrives. */
function formatAt(iso: string): string {
  const d = new Date(iso);
  const time = `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
  return d.toDateString() === new Date().toDateString()
    ? time
    : `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${time}`;
}

/** Sidebar list of everything recorded in the NotificationLog, newest first,
 *  with an unread badge on the view (and so on the FabricPulse activity icon). */
export class NotificationsView implements vscode.TreeDataProvider<NotificationEntry>, vscode.Disposable {
  static readonly VIEW_ID = 'fabricpulse.notificationsView';

  private readonly _onDidChangeTreeData = new vscode.EventEmitter<void>();
  readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

  private readonly _view: vscode.TreeView<NotificationEntry>;
  private readonly _disposables: vscode.Disposable[] = [];

  constructor(private readonly _log: NotificationLog) {
    this._view = vscode.window.createTreeView(NotificationsView.VIEW_ID, { treeDataProvider: this });
    this._disposables.push(
      this._view,
      this._onDidChangeTreeData,
      _log.onDidChange(() => {
        this._onDidChangeTreeData.fire();
        this._syncBadge();
      }),
      // Opening the view is what "reading" them means.
      this._view.onDidChangeVisibility(e => { if (e.visible) _log.markAllRead(); }),
    );
    this._syncBadge();
  }

  static formatForClipboard(e: NotificationEntry): string {
    return `[${formatAt(e.at)}] ${e.level.toUpperCase()} ${e.source}: ${e.message}`;
  }

  private _syncBadge(): void {
    // A notification that lands while the list is on screen is read already.
    // markAllRead fires onDidChange, which calls back in here with unread = 0.
    if (this._view.visible && this._log.unreadCount > 0) {
      this._log.markAllRead();
      return;
    }
    const n = this._log.unreadCount;
    this._view.badge = n > 0
      ? { value: n, tooltip: `${n} unread FabricPulse notification${n > 1 ? 's' : ''}` }
      : undefined;
  }

  getChildren(element?: NotificationEntry): NotificationEntry[] {
    return element ? [] : [...this._log.entries];
  }

  getTreeItem(e: NotificationEntry): vscode.TreeItem {
    const firstLine = e.message.split('\n')[0];
    const item = new vscode.TreeItem(firstLine, vscode.TreeItemCollapsibleState.None);
    item.id = String(e.id);
    item.description = `${formatAt(e.at)} · ${e.source}`;
    item.iconPath = ICONS[e.level] ?? ICONS.info;
    item.contextValue = 'fabricPulseNotification';
    const tooltip = new vscode.MarkdownString();
    tooltip.appendMarkdown(`**${e.level.toUpperCase()}** · ${e.source} · ${new Date(e.at).toLocaleString()}\n\n`);
    tooltip.appendText(e.message); // appendText escapes: table names and API errors aren't markdown
    item.tooltip = tooltip;
    return item;
  }

  dispose(): void {
    this._disposables.forEach(d => d.dispose());
    this._disposables.length = 0;
  }
}
