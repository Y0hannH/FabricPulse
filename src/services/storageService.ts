import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import type { Database as SqlDatabase } from 'sql.js';
import { StoredRun, Annotation, Favorite, PatternWarning } from '../models/types';

// ─────────────────────────────────────────────────────────────────────────────

export class StorageService {
  private db!: SqlDatabase;
  private dbPath = '';

  /** Factory cached so we can reopen the DB without re-initializing WASM. */
  private _SQL!: { Database: new (data?: ArrayLike<number> | Buffer | null) => SqlDatabase };

  /** Debounced flush: coalesces rapid writes into a single disk write. */
  private _flushTimer: ReturnType<typeof setTimeout> | undefined;
  private _dirty = false;

  /** Counts DB operations since last reopen. Used to trigger periodic WASM heap reset. */
  private _opsSinceReopen = 0;
  private static readonly REOPEN_THRESHOLD = 5_000;

  /** When true, _trackOp will not trigger a reopen (e.g. inside a transaction). */
  private _inTransaction = false;

  constructor(private readonly context: vscode.ExtensionContext) {}

  // ─── Init ─────────────────────────────────────────────────────────────────

  async initialize(): Promise<void> {
    const storagePath = this.context.globalStorageUri.fsPath;
    if (!fs.existsSync(storagePath)) {
      fs.mkdirSync(storagePath, { recursive: true });
    }
    this.dbPath = path.join(storagePath, 'fabricpulse.db');

    // sql.js uses WebAssembly — no native compilation needed.
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const initSqlJs = require('sql.js') as (cfg?: { locateFile(f: string): string }) => Promise<{ Database: new (data?: ArrayLike<number> | Buffer | null) => SqlDatabase }>;

    try {
      // The WASM binary is copied to the same directory as the bundled extension
      // by the esbuild build script. __dirname points to out/ at runtime.
      this._SQL = await initSqlJs({
        locateFile: (file: string) => path.join(__dirname, file),
      });
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      throw new Error(`FabricPulse: Failed to initialize SQL.js.\n${msg}`);
    }

    this._openDb();

    this.createSchema();
    this.runMigrations();
    this.cleanupOldData();
    this._flush();
  }

  /** Open (or reopen) the SQLite database from disk, resetting the WASM heap. */
  private _openDb(): void {
    if (fs.existsSync(this.dbPath)) {
      try {
        const buf = fs.readFileSync(this.dbPath);
        this.db = new this._SQL.Database(buf);
      } catch {
        // Database file is corrupted — back it up and start fresh.
        const backupPath = this.dbPath + '.corrupted';
        try { fs.renameSync(this.dbPath, backupPath); } catch { /* best-effort */ }
        this.db = new this._SQL.Database();
        vscode.window.showWarningMessage(
          'FabricPulse: Local database was corrupted and has been reset. History data was lost.',
        );
      }
    } else {
      this.db = new this._SQL.Database();
    }
    this._opsSinceReopen = 0;
  }

  /**
   * Flush to disk, close the old WASM instance, and reopen from the fresh file.
   * This reclaims WASM heap memory that accumulates over long-running sessions.
   */
  private _reopenDb(): void {
    try {
      this._flushSync();
      this.db.close();
    } catch { /* best-effort */ }
    this._openDb();
    console.log('[FabricPulse] DB reopened — WASM heap reset.');
  }

  /** Track a DB operation and trigger a WASM heap reset when threshold is reached.
   *  Skips reopen if inside a transaction to avoid invalidating the DB mid-operation. */
  private _trackOp(): void {
    this._opsSinceReopen++;
    if (!this._inTransaction && this._opsSinceReopen >= StorageService.REOPEN_THRESHOLD) {
      this._reopenDb();
    }
  }

  /** Synchronous flush — writes the in-memory DB to disk immediately. */
  private _flushSync(): void {
    try {
      const data = this.db.export();
      fs.writeFileSync(this.dbPath, Buffer.from(data));
      this._dirty = false;
    } catch (err) {
      console.error('[FabricPulse] DB flush failed:', err);
    }
  }

  /**
   * Debounced flush — coalesces rapid writes into a single disk write.
   * Waits 2 seconds after the last mutation before writing to disk.
   * This dramatically reduces the number of db.export() calls (the main
   * source of WASM heap growth) during batch operations and polling ticks.
   */
  private _flush(): void {
    this._dirty = true;
    if (this._flushTimer) clearTimeout(this._flushTimer);
    this._flushTimer = setTimeout(() => {
      this._flushTimer = undefined;
      this._flushSync();
    }, 2_000);
  }

  // ─── Schema ───────────────────────────────────────────────────────────────

  private createSchema(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS pipeline_runs (
        id               INTEGER PRIMARY KEY AUTOINCREMENT,
        tenant_id        TEXT    NOT NULL,
        workspace_id     TEXT    NOT NULL,
        pipeline_id      TEXT    NOT NULL,
        pipeline_name    TEXT    NOT NULL,
        workspace_name   TEXT    NOT NULL,
        run_id           TEXT    NOT NULL,
        status           TEXT    NOT NULL,
        start_time       TEXT,
        end_time         TEXT,
        duration_ms      INTEGER,
        error_message    TEXT,
        created_at       TEXT    DEFAULT (datetime('now')),
        UNIQUE(run_id)
      );

      CREATE INDEX IF NOT EXISTS idx_runs_pipeline_time
        ON pipeline_runs(pipeline_id, start_time);

      CREATE INDEX IF NOT EXISTS idx_runs_tenant_time
        ON pipeline_runs(tenant_id, start_time);

      CREATE TABLE IF NOT EXISTS annotations (
        id          INTEGER PRIMARY KEY AUTOINCREMENT,
        pipeline_id TEXT NOT NULL,
        date        TEXT NOT NULL,
        note        TEXT NOT NULL,
        created_at  TEXT DEFAULT (datetime('now'))
      );

      CREATE INDEX IF NOT EXISTS idx_annotations_pipeline
        ON annotations(pipeline_id, date);

      CREATE TABLE IF NOT EXISTS favorites (
        id                    INTEGER PRIMARY KEY AUTOINCREMENT,
        tenant_id             TEXT    NOT NULL,
        workspace_id          TEXT    NOT NULL,
        pipeline_id           TEXT    NOT NULL,
        alert_enabled         INTEGER NOT NULL DEFAULT 0,
        duration_threshold_ms INTEGER,
        UNIQUE(pipeline_id)
      );

      CREATE TABLE IF NOT EXISTS workspace_favorites (
        id           INTEGER PRIMARY KEY AUTOINCREMENT,
        workspace_id TEXT    NOT NULL,
        UNIQUE(workspace_id)
      );

      CREATE TABLE IF NOT EXISTS schema_version (
        version INTEGER NOT NULL
      );
    `);
  }

  private runMigrations(): void {
    const rows = this.db.exec('SELECT MAX(version) AS v FROM schema_version');
    const current = (rows[0]?.values[0]?.[0] as number) ?? 0;
    if (current < 1) {
      this.db.run('INSERT INTO schema_version (version) VALUES (?)', [1]);
      this._flush();
    }
    if (current < 2) {
      // workspace_favorites table already created in createSchema via CREATE TABLE IF NOT EXISTS
      this.db.run('UPDATE schema_version SET version = 2');
      this._flush();
    }
    if (current < 3) {
      // Add item_type column to pipeline_runs and favorites for semantic model support
      const addColumn = (table: string, col: string, def: string) => {
        try {
          this.db.run(`ALTER TABLE ${table} ADD COLUMN ${col} ${def}`);
        } catch (err: unknown) {
          // "duplicate column name" is expected if column already exists — anything else is a real error
          const msg = err instanceof Error ? err.message : '';
          if (!msg.includes('duplicate column')) throw err;
        }
      };
      addColumn('pipeline_runs', 'item_type', "TEXT DEFAULT 'pipeline'");
      addColumn('favorites', 'item_type', "TEXT DEFAULT 'pipeline'");
      this.db.run('UPDATE schema_version SET version = 3');
      this._flush();
    }
  }

  // ─── pipeline_runs ────────────────────────────────────────────────────────

  upsertRun(run: StoredRun): void {
    this.db.run(
      `INSERT OR REPLACE INTO pipeline_runs
         (tenant_id, workspace_id, pipeline_id, pipeline_name, workspace_name,
          run_id, status, start_time, end_time, duration_ms, error_message, item_type)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
      [run.tenantId, run.workspaceId, run.pipelineId, run.pipelineName, run.workspaceName,
       run.runId, run.status, run.startTime ?? null, run.endTime ?? null,
       run.durationMs ?? null, run.errorMessage ?? null, run.itemType ?? 'pipeline'],
    );
    this._flush();
  }

  upsertRunsBatch(runs: StoredRun[]): void {
    if (runs.length === 0) return;
    this._inTransaction = true;
    this.db.run('BEGIN');
    try {
      for (const run of runs) {
        this.db.run(
          `INSERT OR REPLACE INTO pipeline_runs
             (tenant_id, workspace_id, pipeline_id, pipeline_name, workspace_name,
              run_id, status, start_time, end_time, duration_ms, error_message, item_type)
           VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
          [run.tenantId, run.workspaceId, run.pipelineId, run.pipelineName, run.workspaceName,
           run.runId, run.status, run.startTime ?? null, run.endTime ?? null,
           run.durationMs ?? null, run.errorMessage ?? null, run.itemType ?? 'pipeline'],
        );
      }
      this.db.run('COMMIT');
    } catch (err) {
      try { this.db.run('ROLLBACK'); } catch { /* already rolled back */ }
      throw err;
    } finally {
      this._inTransaction = false;
    }
    this._trackOp();
    this._flush();
  }

  getRuns(pipelineId: string, since?: string): StoredRun[] {
    this._trackOp();
    const sql = since
      ? 'SELECT * FROM pipeline_runs WHERE pipeline_id = ? AND start_time >= ? ORDER BY start_time DESC'
      : 'SELECT * FROM pipeline_runs WHERE pipeline_id = ? ORDER BY start_time DESC';
    const result = this.db.exec(sql, since ? [pipelineId, since] : [pipelineId]);
    return this._rows(result).map(r => this._mapRun(r));
  }

  getLastRun(pipelineId: string): StoredRun | undefined {
    this._trackOp();
    const result = this.db.exec(
      'SELECT * FROM pipeline_runs WHERE pipeline_id = ? ORDER BY start_time DESC LIMIT 1',
      [pipelineId],
    );
    const rows = this._rows(result);
    return rows.length ? this._mapRun(rows[0]) : undefined;
  }

  getDurationStats(pipelineId: string): { avg: number | undefined; max: number | undefined; min: number | undefined } {
    this._trackOp();
    const result = this.db.exec(
      `SELECT
         AVG(duration_ms),
         MAX(CASE WHEN status = 'Succeeded' THEN duration_ms END),
         MIN(CASE WHEN status = 'Succeeded' THEN duration_ms END)
       FROM pipeline_runs WHERE pipeline_id = ? AND duration_ms IS NOT NULL`,
      [pipelineId],
    );
    const row = result[0]?.values[0];
    if (!row || row[0] == null) return { avg: undefined, max: undefined, min: undefined };
    return {
      avg: Math.round(row[0] as number),
      max: row[1] != null ? (row[1] as number) : undefined,
      min: row[2] != null ? (row[2] as number) : undefined,
    };
  }

  getRunCount(pipelineId: string): number {
    this._trackOp();
    const result = this.db.exec(
      'SELECT COUNT(*) FROM pipeline_runs WHERE pipeline_id = ?',
      [pipelineId],
    );
    return (result[0]?.values[0]?.[0] as number) ?? 0;
  }

  getSuccessRate(pipelineId: string, days: number): { rate: number; total: number } {
    this._trackOp();
    const since = new Date(Date.now() - days * 86_400_000).toISOString();
    const result = this.db.exec(
      `SELECT COUNT(*) AS total,
              SUM(CASE WHEN status = 'Succeeded' THEN 1 ELSE 0 END) AS succeeded
       FROM pipeline_runs WHERE pipeline_id = ? AND start_time >= ?`,
      [pipelineId, since],
    );
    const row = result[0]?.values[0];
    const total = (row?.[0] as number) ?? 0;
    const succeeded = (row?.[1] as number) ?? 0;
    return { rate: total > 0 ? Math.round((succeeded / total) * 100) : 0, total };
  }

  getTodayStats(tenantId: string): { total: number; failed: number } {
    this._trackOp();
    const start = new Date();
    start.setHours(0, 0, 0, 0);
    const result = this.db.exec(
      `SELECT COUNT(*) AS total,
              SUM(CASE WHEN status = 'Failed' THEN 1 ELSE 0 END) AS failed
       FROM pipeline_runs WHERE tenant_id = ? AND start_time >= ?`,
      [tenantId, start.toISOString()],
    );
    const row = result[0]?.values[0];
    return { total: (row?.[0] as number) ?? 0, failed: (row?.[1] as number) ?? 0 };
  }

  /** Returns the distinct set of workspaces seen in pipeline_runs for a given tenant.
   *  Used to populate the workspace picker from cache when no live fetch is needed. */
  getKnownWorkspaces(tenantId: string): { id: string; displayName: string; tenantId: string }[] {
    const result = this.db.exec(
      `SELECT DISTINCT workspace_id, workspace_name FROM pipeline_runs WHERE tenant_id = ?`,
      [tenantId],
    );
    return this._rows(result).map(r => ({
      id:          r['workspace_id'] as string,
      displayName: r['workspace_name'] as string,
      tenantId,
    }));
  }

  /** Returns the distinct set of items (pipelines + semantic models) seen in pipeline_runs for a given tenant.
   *  Used to rebuild the dashboard view from cache without calling the Fabric API. */
  getKnownPipelines(tenantId: string): { id: string; displayName: string; workspaceId: string; workspaceName: string; tenantId: string; itemType: string }[] {
    const result = this.db.exec(
      `SELECT DISTINCT pipeline_id, pipeline_name, workspace_id, workspace_name,
              COALESCE(item_type, 'pipeline') AS item_type
       FROM pipeline_runs WHERE tenant_id = ?`,
      [tenantId],
    );
    return this._rows(result).map(r => ({
      id:            r['pipeline_id'] as string,
      displayName:   r['pipeline_name'] as string,
      workspaceId:   r['workspace_id'] as string,
      workspaceName: r['workspace_name'] as string,
      tenantId,
      itemType:      (r['item_type'] as string) ?? 'pipeline',
    }));
  }

  // ─── favorites ────────────────────────────────────────────────────────────

  getFavorites(): Favorite[] {
    const result = this.db.exec('SELECT * FROM favorites');
    return this._rows(result).map(r => this._mapFav(r));
  }

  getFavorite(pipelineId: string): Favorite | undefined {
    const result = this.db.exec('SELECT * FROM favorites WHERE pipeline_id = ?', [pipelineId]);
    const rows = this._rows(result);
    return rows.length ? this._mapFav(rows[0]) : undefined;
  }

  isFavorite(pipelineId: string): boolean {
    const result = this.db.exec('SELECT id FROM favorites WHERE pipeline_id = ?', [pipelineId]);
    return (result[0]?.values?.length ?? 0) > 0;
  }

  addFavorite(fav: Omit<Favorite, 'id'>): void {
    this.db.run(
      'INSERT OR IGNORE INTO favorites (tenant_id, workspace_id, pipeline_id, alert_enabled, duration_threshold_ms, item_type) VALUES (?,?,?,?,?,?)',
      [fav.tenantId, fav.workspaceId, fav.pipelineId, fav.alertEnabled ? 1 : 0, fav.durationThresholdMs ?? null, fav.itemType ?? 'pipeline'],
    );
    this._flush();
  }

  removeFavorite(pipelineId: string): void {
    this.db.run('DELETE FROM favorites WHERE pipeline_id = ?', [pipelineId]);
    this._flush();
  }

  updateFavoriteAlert(pipelineId: string, alertEnabled: boolean, durationThresholdMs?: number): void {
    this.db.run(
      'UPDATE favorites SET alert_enabled = ?, duration_threshold_ms = ? WHERE pipeline_id = ?',
      [alertEnabled ? 1 : 0, durationThresholdMs ?? null, pipelineId],
    );
    this._flush();
  }

  // ─── workspace_favorites ──────────────────────────────────────────────────

  isWorkspaceFavorite(workspaceId: string): boolean {
    const result = this.db.exec('SELECT id FROM workspace_favorites WHERE workspace_id = ?', [workspaceId]);
    return (result[0]?.values?.length ?? 0) > 0;
  }

  addWorkspaceFavorite(workspaceId: string): void {
    this.db.run('INSERT OR IGNORE INTO workspace_favorites (workspace_id) VALUES (?)', [workspaceId]);
    this._flush();
  }

  removeWorkspaceFavorite(workspaceId: string): void {
    this.db.run('DELETE FROM workspace_favorites WHERE workspace_id = ?', [workspaceId]);
    this._flush();
  }

  // ─── annotations ─────────────────────────────────────────────────────────

  getAnnotations(pipelineId: string): Annotation[] {
    const result = this.db.exec(
      'SELECT * FROM annotations WHERE pipeline_id = ? ORDER BY date DESC', [pipelineId],
    );
    return this._rows(result).map(r => this._mapAnnotation(r));
  }

  addAnnotation(ann: Omit<Annotation, 'id' | 'createdAt'>): void {
    this.db.run(
      'INSERT INTO annotations (pipeline_id, date, note) VALUES (?,?,?)',
      [ann.pipelineId, ann.date, ann.note],
    );
    this._flush();
  }

  // ─── Pattern detection ────────────────────────────────────────────────────

  detectPatterns(pipelineId: string, days = 30): PatternWarning[] {
    const since = new Date(Date.now() - days * 86_400_000).toISOString();
    const result = this.db.exec(
      `SELECT start_time, status FROM pipeline_runs
       WHERE pipeline_id = ? AND start_time >= ? ORDER BY start_time DESC`,
      [pipelineId, since],
    );

    const allRuns = (result[0]?.values ?? []) as [string, string][];
    const failed = allRuns.filter(r => r[1] === 'Failed');
    const warnings: PatternWarning[] = [];

    if (failed.length < 3 || failed.length / allRuns.length < 0.3) return warnings;

    const weekdayCounts = new Array<number>(7).fill(0);
    for (const r of failed) weekdayCounts[new Date(r[0]).getDay()]++;

    const dayNames = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
    weekdayCounts.forEach((count, day) => {
      if (count > 0 && count / failed.length >= 0.3) {
        warnings.push({ type: 'weekday', description: `Often fails on ${dayNames[day]}`, failureCount: count, totalFailures: failed.length });
      }
    });

    const hourCounts = new Array<number>(24).fill(0);
    for (const r of failed) hourCounts[new Date(r[0]).getHours()]++;

    for (let h = 0; h < 24; h += 2) {
      const count = (hourCounts[h] ?? 0) + (hourCounts[h + 1] ?? 0);
      if (count > 0 && count / failed.length >= 0.3) {
        warnings.push({ type: 'timerange', description: `Often fails between ${String(h).padStart(2, '0')}:00–${String(h + 2).padStart(2, '0')}:00`, failureCount: count, totalFailures: failed.length });
      }
    }
    return warnings;
  }

  // ─── Cleanup & export ─────────────────────────────────────────────────────

  private cleanupOldData(): void {
    const days = vscode.workspace.getConfiguration('fabricPulse').get<number>('retentionDays', 90);
    const cutoff = new Date(Date.now() - days * 86_400_000).toISOString();
    this.db.run('DELETE FROM pipeline_runs WHERE created_at < ?', [cutoff]);
  }

  exportRunsCsv(pipelineId: string, since?: string): string {
    const runs = this.getRuns(pipelineId, since);
    const headers = ['run_id', 'status', 'start_time', 'end_time', 'duration_ms', 'error_message'];
    const rows = runs.map(r =>
      [r.runId, r.status, r.startTime, r.endTime ?? '', String(r.durationMs ?? ''), r.errorMessage ?? '']
        .map(v => csvCell(v)).join(','),
    );
    return [headers.join(','), ...rows].join('\n');
  }

  exportRunsJson(pipelineId: string, since?: string): string {
    return JSON.stringify(this.getRuns(pipelineId, since), null, 2);
  }

  clearAllHistory(): void {
    this.db.run('DELETE FROM pipeline_runs');
    this._flush();
  }

  close(): void {
    if (this._flushTimer) {
      clearTimeout(this._flushTimer);
      this._flushTimer = undefined;
    }
    try { this._flushSync(); this.db.close(); } catch { /* ignore */ }
  }

  // ─── Row helpers ──────────────────────────────────────────────────────────

  /** Convert exec() result into an array of plain objects keyed by column name. */
  private _rows(result: ReturnType<SqlDatabase['exec']>): Record<string, unknown>[] {
    if (!result[0]) return [];
    const { columns, values } = result[0];
    return values.map(row => Object.fromEntries(columns.map((c, i) => [c, row[i]])));
  }

  private _mapRun(r: Record<string, unknown>): StoredRun {
    return {
      id:            r['id'] as number | undefined,
      tenantId:      r['tenant_id'] as string,
      workspaceId:   r['workspace_id'] as string,
      pipelineId:    r['pipeline_id'] as string,
      pipelineName:  r['pipeline_name'] as string,
      workspaceName: r['workspace_name'] as string,
      runId:         r['run_id'] as string,
      status:        r['status'] as string,
      startTime:     r['start_time'] as string,
      endTime:       (r['end_time'] as string | null) ?? undefined,
      durationMs:    (r['duration_ms'] as number | null) ?? undefined,
      errorMessage:  (r['error_message'] as string | null) ?? undefined,
      createdAt:     (r['created_at'] as string | null) ?? undefined,
      itemType:      (r['item_type'] as string | null) ?? 'pipeline',
    };
  }

  private _mapFav(r: Record<string, unknown>): Favorite {
    return {
      id:                  r['id'] as number | undefined,
      tenantId:            r['tenant_id'] as string,
      workspaceId:         r['workspace_id'] as string,
      pipelineId:          r['pipeline_id'] as string,
      alertEnabled:        (r['alert_enabled'] as number) === 1,
      durationThresholdMs: (r['duration_threshold_ms'] as number | null) ?? undefined,
      itemType:            (r['item_type'] as string | null) ?? 'pipeline',
    };
  }

  private _mapAnnotation(r: Record<string, unknown>): Annotation {
    return {
      id:         r['id'] as number | undefined,
      pipelineId: r['pipeline_id'] as string,
      date:       r['date'] as string,
      note:       r['note'] as string,
      createdAt:  (r['created_at'] as string | null) ?? undefined,
    };
  }
}

// ─── CSV injection protection (CWE-1236) ─────────────────────────────────────

function csvCell(value: string): string {
  const escaped = value.replace(/"/g, '""');
  const safe = /^[=+\-@\t\r]/.test(escaped) ? `'${escaped}` : escaped;
  return `"${safe}"`;
}
