// Computes the next scheduled run from a Fabric/Power BI schedule definition.
//
// The scheduling APIs return the *definition* of a schedule (cron interval,
// daily/weekly times) expressed as wall-clock times in a Windows time-zone id —
// they do NOT return a "next run" timestamp. We compute it here.
//
// The hard part is the time zone: schedule times are wall-clock in a Windows
// zone id (e.g. "Romance Standard Time"), while JS Intl only understands IANA
// names (e.g. "Europe/Paris"). We map the common Windows ids to IANA and fall
// back to UTC for anything unknown.

/** Normalized schedule definition (Fabric "configuration" or PBI refreshSchedule). */
export interface ScheduleDef {
  enabled: boolean;
  type: 'Cron' | 'Daily' | 'Weekly' | 'Monthly';
  interval?: number;        // Cron: minutes between runs
  times?: string[];         // Daily/Weekly/Monthly: "HH:mm" wall-clock times
  weekdays?: string[];      // Weekly: English day names ("Monday" …)
  startDateTime?: string;   // wall-clock anchor in localTimeZoneId (no tz suffix)
  endDateTime?: string;     // wall-clock end in localTimeZoneId
  localTimeZoneId?: string; // Windows time-zone id
  // Monthly only —
  recurrence?: number;      // every N months (1–12); anchored on startDateTime's month
  dayOfMonth?: number;      // DayOfMonth occurrence: 1–31
  weekIndex?: string;       // OrdinalWeekday occurrence: First|Second|Third|Fourth|Fifth
  ordinalWeekday?: string;  // OrdinalWeekday occurrence: English day name ("Monday" …)
}

/** Result consumed by the dashboard. */
export interface ScheduleInfo {
  enabled: boolean;
  nextRunAt?: string;  // ISO-8601 UTC instant of the next run, if computable
  summary: string;     // human-readable description (tooltip)
}

const WEEKDAY_INDEX: Record<string, number> = {
  sunday: 0, monday: 1, tuesday: 2, wednesday: 3, thursday: 4, friday: 5, saturday: 6,
};

const WEEKDAY_SHORT = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

const WEEK_INDEX: Record<string, number> = {
  first: 1, second: 2, third: 3, fourth: 4, fifth: 5,
};

/** Number of days in a given (1-based) month. */
function daysInMonth(year: number, month1: number): number {
  return new Date(Date.UTC(year, month1, 0)).getUTCDate();
}

/** Resolves the day-of-month (1–31) a Monthly schedule targets for the given
 *  calendar month, or undefined when that month has no matching day (e.g. the
 *  31st in February, or a missing "Fifth Monday") — such months are skipped. */
function resolveMonthlyDay(def: ScheduleDef, year: number, month1: number): number | undefined {
  const dim = daysInMonth(year, month1);

  // OrdinalWeekday occurrence (e.g. "Second Tuesday")
  if (def.weekIndex && def.ordinalWeekday) {
    const targetDow = WEEKDAY_INDEX[def.ordinalWeekday.toLowerCase()];
    const n = WEEK_INDEX[def.weekIndex.toLowerCase()];
    if (targetDow == null || n == null) return undefined;
    const firstDow = new Date(Date.UTC(year, month1 - 1, 1)).getUTCDay();
    const day = 1 + ((targetDow - firstDow + 7) % 7) + (n - 1) * 7;
    return day <= dim ? day : undefined;
  }

  // DayOfMonth occurrence (e.g. "the 1st")
  if (def.dayOfMonth != null) {
    return def.dayOfMonth <= dim ? def.dayOfMonth : undefined;
  }

  return undefined;
}

/** Windows time-zone id → IANA name. Covers the common zones; unknown ids
 *  fall back to UTC (with a console warning) so the next-run estimate stays
 *  reasonable rather than failing outright. */
const WINDOWS_TO_IANA: Record<string, string> = {
  'UTC': 'UTC',
  'GMT Standard Time': 'Europe/London',
  'Greenwich Standard Time': 'Atlantic/Reykjavik',
  'W. Europe Standard Time': 'Europe/Berlin',
  'Central Europe Standard Time': 'Europe/Budapest',
  'Romance Standard Time': 'Europe/Paris',
  'Central European Standard Time': 'Europe/Warsaw',
  'W. Central Africa Standard Time': 'Africa/Lagos',
  'GTB Standard Time': 'Europe/Bucharest',
  'E. Europe Standard Time': 'Europe/Chisinau',
  'FLE Standard Time': 'Europe/Helsinki',
  'Turkey Standard Time': 'Europe/Istanbul',
  'Israel Standard Time': 'Asia/Jerusalem',
  'Egypt Standard Time': 'Africa/Cairo',
  'South Africa Standard Time': 'Africa/Johannesburg',
  'Russian Standard Time': 'Europe/Moscow',
  'Arabic Standard Time': 'Asia/Baghdad',
  'Arab Standard Time': 'Asia/Riyadh',
  'Arabian Standard Time': 'Asia/Dubai',
  'Iran Standard Time': 'Asia/Tehran',
  'Pakistan Standard Time': 'Asia/Karachi',
  'India Standard Time': 'Asia/Kolkata',
  'Bangladesh Standard Time': 'Asia/Dhaka',
  'SE Asia Standard Time': 'Asia/Bangkok',
  'China Standard Time': 'Asia/Shanghai',
  'Singapore Standard Time': 'Asia/Singapore',
  'W. Australia Standard Time': 'Australia/Perth',
  'Taipei Standard Time': 'Asia/Taipei',
  'Tokyo Standard Time': 'Asia/Tokyo',
  'Korea Standard Time': 'Asia/Seoul',
  'Cen. Australia Standard Time': 'Australia/Adelaide',
  'AUS Eastern Standard Time': 'Australia/Sydney',
  'E. Australia Standard Time': 'Australia/Brisbane',
  'New Zealand Standard Time': 'Pacific/Auckland',
  'Azores Standard Time': 'Atlantic/Azores',
  'Mid-Atlantic Standard Time': 'Atlantic/South_Georgia',
  'E. South America Standard Time': 'America/Sao_Paulo',
  'SA Eastern Standard Time': 'America/Cayenne',
  'Argentina Standard Time': 'America/Argentina/Buenos_Aires',
  'Newfoundland Standard Time': 'America/St_Johns',
  'Atlantic Standard Time': 'America/Halifax',
  'SA Western Standard Time': 'America/La_Paz',
  'Pacific SA Standard Time': 'America/Santiago',
  'Eastern Standard Time': 'America/New_York',
  'US Eastern Standard Time': 'America/Indiana/Indianapolis',
  'SA Pacific Standard Time': 'America/Bogota',
  'Central Standard Time': 'America/Chicago',
  'Central Standard Time (Mexico)': 'America/Mexico_City',
  'Canada Central Standard Time': 'America/Regina',
  'Mountain Standard Time': 'America/Denver',
  'Mountain Standard Time (Mexico)': 'America/Chihuahua',
  'US Mountain Standard Time': 'America/Phoenix',
  'Pacific Standard Time': 'America/Los_Angeles',
  'Pacific Standard Time (Mexico)': 'America/Tijuana',
  'Alaskan Standard Time': 'America/Anchorage',
  'Hawaiian Standard Time': 'Pacific/Honolulu',
};

const _warnedZones = new Set<string>();

function resolveTz(windowsId?: string): string {
  if (!windowsId) return 'UTC';
  const iana = WINDOWS_TO_IANA[windowsId];
  if (iana) return iana;
  // Maybe the API already returned an IANA name (contains a slash)
  if (windowsId.includes('/')) return windowsId;
  if (!_warnedZones.has(windowsId)) {
    _warnedZones.add(windowsId);
    console.warn(`[FabricPulse] Unknown time-zone id "${windowsId}" — assuming UTC for next-run estimate.`);
  }
  return 'UTC';
}

interface WallClock { year: number; month: number; day: number; hour: number; minute: number; second: number; }

/** Reads the wall-clock components of a UTC instant as observed in `tz`. */
function tzParts(utcMs: number, tz: string): WallClock {
  const fmt = new Intl.DateTimeFormat('en-US', {
    timeZone: tz, hour12: false,
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
  });
  const map: Record<string, string> = {};
  for (const p of fmt.formatToParts(new Date(utcMs))) {
    if (p.type !== 'literal') map[p.type] = p.value;
  }
  return {
    year: Number(map.year),
    month: Number(map.month),
    day: Number(map.day),
    hour: Number(map.hour) % 24, // some ICU builds emit "24" for midnight
    minute: Number(map.minute),
    second: Number(map.second),
  };
}

/** Converts a wall-clock time in `tz` to the corresponding UTC epoch ms.
 *  Uses the standard offset-probe trick; good enough across DST boundaries. */
function zonedWallClockToUtc(y: number, mo: number, d: number, h: number, mi: number, tz: string): number {
  const guess = Date.UTC(y, mo - 1, d, h, mi);
  const p = tzParts(guess, tz);
  const asUtc = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second);
  const offset = asUtc - guess; // how far ahead of UTC the zone sits at this instant
  return guess - offset;
}

/** Parses a wall-clock datetime string ("2024-04-28T09:00:00", with or without
 *  a trailing Z/offset) into its calendar components, ignoring any tz suffix
 *  because the schedule's localTimeZoneId is authoritative. */
function parseWallClock(s: string): WallClock | undefined {
  const m = /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})(?::(\d{2}))?/.exec(s);
  if (!m) return undefined;
  return {
    year: +m[1], month: +m[2], day: +m[3],
    hour: +m[4], minute: +m[5], second: m[6] ? +m[6] : 0,
  };
}

/** Computes the next run instant (epoch ms) for a single enabled schedule. */
export function computeNextRun(def: ScheduleDef, nowMs: number = Date.now()): number | undefined {
  if (!def.enabled) return undefined;
  const tz = resolveTz(def.localTimeZoneId);

  const startWc = def.startDateTime ? parseWallClock(def.startDateTime) : undefined;
  const endWc = def.endDateTime ? parseWallClock(def.endDateTime) : undefined;
  const startMs = startWc ? zonedWallClockToUtc(startWc.year, startWc.month, startWc.day, startWc.hour, startWc.minute, tz) : undefined;
  const endMs = endWc ? zonedWallClockToUtc(endWc.year, endWc.month, endWc.day, endWc.hour, endWc.minute, tz) : undefined;

  if (endMs != null && nowMs > endMs) return undefined;
  const lower = Math.max(nowMs, startMs ?? nowMs);

  if (def.type === 'Cron') {
    if (!def.interval || def.interval <= 0 || startMs == null) return undefined;
    const intervalMs = def.interval * 60_000;
    if (lower <= startMs) return startMs;
    const k = Math.ceil((lower - startMs) / intervalMs);
    const next = startMs + k * intervalMs;
    return endMs != null && next > endMs ? undefined : next;
  }

  // All time-slot schedules (Daily / Weekly / Monthly) share this parsed list.
  const times = (def.times ?? [])
    .map(t => { const [h, mi] = t.split(':'); return { h: Number(h), mi: Number(mi) }; })
    .filter(t => Number.isFinite(t.h) && Number.isFinite(t.mi))
    .sort((a, b) => a.h - b.h || a.mi - b.mi);
  if (times.length === 0) return undefined;

  if (def.type === 'Monthly') {
    const recurrence = def.recurrence && def.recurrence > 0 ? def.recurrence : 1;
    // Anchor the "every N months" cadence on the schedule's start month (or now).
    const anchorWc = startMs != null ? tzParts(startMs, tz) : tzParts(nowMs, tz);
    const anchorIdx = anchorWc.year * 12 + (anchorWc.month - 1);
    const nowWcM = tzParts(nowMs, tz);
    const startIdx = nowWcM.year * 12 + (nowWcM.month - 1);

    // Scan up to 10 years ahead (recurrence ≤ 12 ⇒ at most ~120 valid months).
    for (let i = 0; i <= 120; i++) {
      const monthIdx = startIdx + i;
      if (monthIdx < anchorIdx) continue;
      if ((monthIdx - anchorIdx) % recurrence !== 0) continue;
      const cy = Math.floor(monthIdx / 12);
      const cm = (monthIdx % 12) + 1;
      const day = resolveMonthlyDay(def, cy, cm);
      if (day == null) continue;
      for (const t of times) {
        const cand = zonedWallClockToUtc(cy, cm, day, t.h, t.mi, tz);
        if (cand >= lower && (endMs == null || cand <= endMs)) return cand;
      }
    }
    return undefined;
  }

  const weekdaySet = def.type === 'Weekly'
    ? new Set((def.weekdays ?? []).map(d => WEEKDAY_INDEX[d.toLowerCase()]).filter(n => n != null))
    : null;
  if (weekdaySet && weekdaySet.size === 0) return undefined;

  const nowWc = tzParts(nowMs, tz);
  const anchor = Date.UTC(nowWc.year, nowWc.month - 1, nowWc.day); // pure calendar counter

  for (let off = 0; off <= 8; off++) {
    const cal = new Date(anchor + off * 86_400_000);
    const y = cal.getUTCFullYear(), mo = cal.getUTCMonth() + 1, d = cal.getUTCDate();
    if (weekdaySet && !weekdaySet.has(cal.getUTCDay())) continue;
    for (const t of times) {
      const cand = zonedWallClockToUtc(y, mo, d, t.h, t.mi, tz);
      if (cand >= lower && (endMs == null || cand <= endMs)) return cand;
    }
  }
  return undefined;
}

/** One-line human-readable description of a schedule (used as a tooltip). */
export function summarize(def: ScheduleDef): string {
  const tzSuffix = def.localTimeZoneId ? ` (${def.localTimeZoneId})` : '';
  if (def.type === 'Cron' && def.interval) {
    const label = def.interval % 60 === 0 ? `every ${def.interval / 60}h` : `every ${def.interval}m`;
    return `Cron — ${label}${tzSuffix}`;
  }
  const times = (def.times ?? []).join(', ');
  if (def.type === 'Weekly') {
    const days = (def.weekdays ?? [])
      .map(d => WEEKDAY_SHORT[WEEKDAY_INDEX[d.toLowerCase()] ?? -1] ?? d)
      .join(', ');
    return `Weekly — ${days || '?'} at ${times || '?'}${tzSuffix}`;
  }
  if (def.type === 'Monthly') {
    const rec = def.recurrence && def.recurrence > 1 ? `every ${def.recurrence} months` : 'Monthly';
    let when: string;
    if (def.weekIndex && def.ordinalWeekday) {
      const wd = WEEKDAY_SHORT[WEEKDAY_INDEX[def.ordinalWeekday.toLowerCase()] ?? -1] ?? def.ordinalWeekday;
      when = `${def.weekIndex} ${wd}`;
    } else if (def.dayOfMonth != null) {
      when = `day ${def.dayOfMonth}`;
    } else {
      when = '?';
    }
    return `${rec} — ${when} at ${times || '?'}${tzSuffix}`;
  }
  return `Daily — ${times || '?'}${tzSuffix}`;
}

/** Combines one or more schedule definitions into a single ScheduleInfo,
 *  picking the soonest next run across all enabled schedules. */
export function combineSchedules(defs: ScheduleDef[], nowMs: number = Date.now()): ScheduleInfo | undefined {
  if (defs.length === 0) return undefined;

  const enabled = defs.filter(d => d.enabled);
  if (enabled.length === 0) {
    return { enabled: false, summary: summarize(defs[0]) };
  }

  let bestMs: number | undefined;
  for (const d of enabled) {
    const ms = computeNextRun(d, nowMs);
    if (ms != null && (bestMs == null || ms < bestMs)) bestMs = ms;
  }

  return {
    enabled: true,
    nextRunAt: bestMs != null ? new Date(bestMs).toISOString() : undefined,
    summary: enabled.map(summarize).join(' · '),
  };
}
