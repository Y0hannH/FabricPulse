import * as vscode from 'vscode';

export type NotificationLevel = 'info' | 'success' | 'warning' | 'error';

export interface NotificationEntry {
  id: number;
  at: string;       // ISO-8601
  level: NotificationLevel;
  source: string;   // 'Dashboard' | 'Lakehouses' | 'History' | 'Alerts' | 'Auth' | 'Storage'
  message: string;
}

const STATE_KEY = 'fabricPulse.notificationLog';

/** Oldest entries are dropped beyond this. A bulk maintenance over hundreds of
 *  tables can log one failure per table, so the cap is deliberately generous. */
const MAX_ENTRIES = 500;

/** Bursts (one failure per table) are coalesced into a single globalState write. */
const PERSIST_DEBOUNCE_MS = 1_000;

/** Keeps every notification FabricPulse raises — webview toasts and VS Code
 *  notifications alike — so the ones that faded out or were dismissed unread
 *  can be reviewed from the sidebar. Persisted (capped) so a restart doesn't
 *  lose them; the unread count is per session. */
export class NotificationLog implements vscode.Disposable {
  /** Newest first. */
  private _entries: NotificationEntry[];
  private _nextId: number;
  private _unread = 0;
  private _persistTimer: ReturnType<typeof setTimeout> | undefined;

  private readonly _onDidChange = new vscode.EventEmitter<void>();
  readonly onDidChange = this._onDidChange.event;

  constructor(private readonly _state: vscode.Memento) {
    const saved = _state.get<NotificationEntry[]>(STATE_KEY, []);
    this._entries = Array.isArray(saved) ? saved.slice(0, MAX_ENTRIES) : [];
    this._nextId = this._entries.reduce((max, e) => Math.max(max, e.id), 0) + 1;
  }

  get entries(): readonly NotificationEntry[] {
    return this._entries;
  }

  get unreadCount(): number {
    return this._unread;
  }

  add(level: NotificationLevel, source: string, message: string): void {
    const text = message.trim();
    if (!text) return;
    this._entries.unshift({ id: this._nextId++, at: new Date().toISOString(), level, source, message: text });
    if (this._entries.length > MAX_ENTRIES) this._entries.length = MAX_ENTRIES;
    this._unread++;
    this._schedulePersist();
    this._onDidChange.fire();
  }

  markAllRead(): void {
    if (this._unread === 0) return;
    this._unread = 0;
    this._onDidChange.fire();
  }

  clear(): void {
    this._entries = [];
    this._unread = 0;
    this._schedulePersist();
    this._onDidChange.fire();
  }

  private _schedulePersist(): void {
    if (this._persistTimer) clearTimeout(this._persistTimer);
    this._persistTimer = setTimeout(() => this._persistNow(), PERSIST_DEBOUNCE_MS);
  }

  private _persistNow(): void {
    this._persistTimer = undefined;
    void this._state.update(STATE_KEY, this._entries);
  }

  dispose(): void {
    // Flush a pending write so the last burst before shutdown isn't lost.
    if (this._persistTimer) {
      clearTimeout(this._persistTimer);
      this._persistNow();
    }
    this._onDidChange.dispose();
  }
}
