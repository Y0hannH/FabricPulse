// Turns recorded runs and schedule definitions into the blocks of the calendar view.
//
// Pure functions, no VS Code or network access, so the logic can be checked on
// its own. The past comes from run history (real start and end); the future is
// expanded from the schedule definitions and given the item's average duration
// as its length — it can only be an estimate.

import type { CalendarEvent, StoredRun } from '../models/types';
import type { ScheduleDef } from './scheduleService';
import { expandOccurrences } from './scheduleService';

export interface CalendarSource {
  itemId: string;
  runs: StoredRun[];
  /** Enabled schedule definitions; absent when the item has none (or they're unknown yet). */
  defs?: ScheduleDef[];
  avgDurationMs?: number;
}

/** A cron firing at least this often is drawn as one band per day instead of one
 *  block per run: a 5-minute pipeline would otherwise stack 288 blocks into an
 *  unreadable column. Applies to its past runs as well as its planned ones. */
export const FREQUENT_CRON_MAX_MINUTES = 30;

const ACTIVE_STATUSES = new Set(['InProgress', 'Queued', 'NotStarted']);

function isFrequentCron(def: ScheduleDef): boolean {
  return def.type === 'Cron' && !!def.interval && def.interval <= FREQUENT_CRON_MAX_MINUTES;
}

/** Which of several run statuses a day's band should show: a failure must not hide
 *  behind 95 successes. */
const STATUS_RANK: Record<string, number> = { Failed: 3, InProgress: 2, Cancelled: 1 };

/** Folds an item's recorded runs into one band per local day. */
function collapseRuns(
  runs: CalendarEvent[],
  itemId: string,
  intervalMinutes: number,
): CalendarEvent[] {
  const days = new Map<
    string,
    { start: number; end: number; count: number; failed: number; status: string }
  >();

  for (const r of runs) {
    const start = Date.parse(r.start);
    const end = Date.parse(r.end);
    const status = r.status ?? 'Succeeded';
    const key = localDayKey(start);
    const day = days.get(key);
    if (!day) {
      days.set(key, { start, end, count: 1, failed: status === 'Failed' ? 1 : 0, status });
      continue;
    }
    day.start = Math.min(day.start, start);
    day.end = Math.max(day.end, end);
    day.count++;
    if (status === 'Failed') day.failed++;
    if ((STATUS_RANK[status] ?? 0) > (STATUS_RANK[day.status] ?? 0)) day.status = status;
  }

  return [...days.values()].map((d) => ({
    itemId,
    kind: 'band' as const,
    start: new Date(d.start).toISOString(),
    end: new Date(d.end).toISOString(),
    status: d.status,
    label: `every ${intervalMinutes} min · ${d.count} run${d.count > 1 ? 's' : ''}${
      d.failed ? ` · ${d.failed} failed` : ''
    }`,
  }));
}

function runToEvent(run: StoredRun, itemId: string, nowMs: number): CalendarEvent | undefined {
  const startMs = run.startTime ? Date.parse(run.startTime) : NaN;
  if (!Number.isFinite(startMs)) return undefined;

  let endMs = run.endTime ? Date.parse(run.endTime) : NaN;
  if (!Number.isFinite(endMs)) {
    if (run.durationMs != null) endMs = startMs + run.durationMs;
    // A run with no end that is still active has been going on until now.
    else if (ACTIVE_STATUSES.has(run.status)) endMs = Math.max(nowMs, startMs);
    else endMs = startMs;
  }
  if (endMs < startMs) endMs = startMs;

  return {
    itemId,
    kind: 'run',
    start: new Date(startMs).toISOString(),
    end: new Date(endMs).toISOString(),
    status: run.status,
    runId: run.runId,
  };
}

/** Local calendar day of an instant — bands are cut at the viewer's midnight, which
 *  is the one the calendar columns use (the extension host and the webview share a clock). */
function localDayKey(ms: number): string {
  const d = new Date(ms);
  return `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`;
}

function plannedEvents(
  source: CalendarSource,
  fromMs: number,
  toMs: number,
  nowMs: number,
): CalendarEvent[] {
  if (!source.defs?.length) return [];

  // Nothing "planned" can lie in the past: whatever ran is in the history.
  const lower = Math.max(fromMs, nowMs);
  if (toMs < lower) return [];

  const durationMs = source.avgDurationMs ?? 0;
  const estimated = source.avgDurationMs != null;
  const events: CalendarEvent[] = [];
  const seen = new Set<number>();

  for (const def of source.defs) {
    const instants = expandOccurrences(def, lower, toMs);

    if (isFrequentCron(def)) {
      const days = new Map<string, { first: number; last: number; count: number }>();
      for (const t of instants) {
        const key = localDayKey(t);
        const day = days.get(key);
        if (day) {
          day.last = t;
          day.count++;
        } else {
          days.set(key, { first: t, last: t, count: 1 });
        }
      }
      for (const day of days.values()) {
        events.push({
          itemId: source.itemId,
          kind: 'band',
          start: new Date(day.first).toISOString(),
          end: new Date(day.last + durationMs).toISOString(),
          estimated,
          label: `every ${def.interval} min · ${day.count} run${day.count > 1 ? 's' : ''}`,
        });
      }
      continue;
    }

    for (const t of instants) {
      // Two definitions can fire at the same minute; draw it once.
      if (seen.has(t)) continue;
      seen.add(t);
      events.push({
        itemId: source.itemId,
        kind: 'planned',
        start: new Date(t).toISOString(),
        end: new Date(t + durationMs).toISOString(),
        estimated,
      });
    }
  }
  return events;
}

/** All blocks to draw for [fromMs, toMs): recorded runs overlapping the window, plus
 *  every scheduled run from `nowMs` onwards. */
export function buildCalendarEvents(
  sources: CalendarSource[],
  fromMs: number,
  toMs: number,
  nowMs: number = Date.now(),
): CalendarEvent[] {
  const events: CalendarEvent[] = [];

  for (const source of sources) {
    const runs: CalendarEvent[] = [];
    for (const run of source.runs) {
      const ev = runToEvent(run, source.itemId, nowMs);
      if (!ev) continue;
      if (Date.parse(ev.start) < toMs && Date.parse(ev.end) >= fromMs) runs.push(ev);
    }

    const frequent = source.defs?.find(isFrequentCron);
    events.push(...(frequent ? collapseRuns(runs, source.itemId, frequent.interval!) : runs));
    events.push(...plannedEvents(source, fromMs, toMs, nowMs));
  }

  return events.sort((a, b) => Date.parse(a.start) - Date.parse(b.start));
}
