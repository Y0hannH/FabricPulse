import * as vscode from 'vscode';

export type NotificationLevel = 'info' | 'success' | 'warning' | 'error';

export interface NotificationEntry {
  id: number;
  at: string; // ISO-8601
  level: NotificationLevel;
  source: string; // 'Dashboard' | 'Lakehouses' | 'History' | 'Alerts' | 'Auth' | 'Storage'
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
  /** Newest first. Named `entryList` rather than `entries`, which the public getter owns. */
  private entryList: NotificationEntry[];
  private nextId: number;
  private unread = 0;
  private persistTimer: ReturnType<typeof setTimeout> | undefined;

  private readonly changeEmitter = new vscode.EventEmitter<void>();
  readonly onDidChange = this.changeEmitter.event;

  constructor(private readonly state: vscode.Memento) {
    const saved = state.get<NotificationEntry[]>(STATE_KEY, []);
    this.entryList = Array.isArray(saved) ? saved.slice(0, MAX_ENTRIES) : [];
    this.nextId = this.entryList.reduce((max, e) => Math.max(max, e.id), 0) + 1;
  }

  get entries(): readonly NotificationEntry[] {
    return this.entryList;
  }

  get unreadCount(): number {
    return this.unread;
  }

  add(level: NotificationLevel, source: string, message: string): void {
    const text = message.trim();
    if (!text) return;
    this.entryList.unshift({
      id: this.nextId++,
      at: new Date().toISOString(),
      level,
      source,
      message: text,
    });
    if (this.entryList.length > MAX_ENTRIES) this.entryList.length = MAX_ENTRIES;
    this.unread++;
    this.schedulePersist();
    this.changeEmitter.fire();
  }

  markAllRead(): void {
    if (this.unread === 0) return;
    this.unread = 0;
    this.changeEmitter.fire();
  }

  clear(): void {
    this.entryList = [];
    this.unread = 0;
    this.schedulePersist();
    this.changeEmitter.fire();
  }

  private schedulePersist(): void {
    if (this.persistTimer) clearTimeout(this.persistTimer);
    this.persistTimer = setTimeout(() => this.persistNow(), PERSIST_DEBOUNCE_MS);
  }

  private persistNow(): void {
    this.persistTimer = undefined;
    void this.state.update(STATE_KEY, this.entryList);
  }

  dispose(): void {
    // Flush a pending write so the last burst before shutdown isn't lost.
    if (this.persistTimer) {
      clearTimeout(this.persistTimer);
      this.persistNow();
    }
    this.changeEmitter.dispose();
  }
}
