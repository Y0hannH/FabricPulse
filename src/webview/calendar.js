// @ts-check
/// <reference lib="dom" />
'use strict';

// ── VS Code API ───────────────────────────────────────────────────────────────
const vscode = acquireVsCodeApi();

// ── State ─────────────────────────────────────────────────────────────────────
/** @type {import('../models/types').CalendarState} */
let state = {
  tenants: [],
  currentTenantId: '',
  workspaces: [],
  selectedWorkspaceId: '',
  favoritesOnly: false,
  items: [],
  events: [],
  rangeStart: '',
  rangeEnd: '',
  lastRefreshed: '',
  nextRefreshAt: '',
  isLoading: false,
};

/** Filters applied here. Workspace and favorites change what the extension fetches,
 *  so those two round-trip; the rest only hide what is already loaded. */
const localFilter = {
  text: '',
  itemType: 'all',
  scheduledOnly: false,
  statusFilters: /** @type {Set<string>} */ (new Set()),
};

/** What is on screen: a day or a week (Monday first) containing `anchor`. */
const view = { mode: /** @type {'day'|'week'} */ ('week'), anchor: startOfDay(new Date()) };

/** Pixels per hour — keep in sync with --cal-hour-h in calendar.css. */
const HOUR_H = 48;
/** Shortest block drawn, in minutes: a 20 s run would otherwise be invisible. */
const MIN_EVENT_MINUTES = 22;
/** Blocks side by side before the rest collapse into a "+N" pill. */
const MAX_COLUMNS = 5;
/** Frequent-cron bands: width of one lane (strip + gap) and how many a day column holds. */
const BAND_LANE_PX = 9;
const MAX_BAND_LANES = 6;

/** Scroll to the working hours the first time the grid is shown. */
let needsInitialScroll = true;

// ── DOM refs ──────────────────────────────────────────────────────────────────
const $ = (/** @type {string} */ id) => /** @type {HTMLElement} */ (document.getElementById(id));

const dom = {
  tenantSelect: /** @type {HTMLSelectElement} */ ($('tenant-select')),
  wsPicker: $('ws-picker'),
  wsPickerToggle: /** @type {HTMLButtonElement} */ ($('ws-picker-toggle')),
  wsPickerLabel: $('ws-picker-label'),
  wsPickerDropdown: $('ws-picker-dropdown'),
  wsPickerSearch: /** @type {HTMLInputElement} */ ($('ws-picker-search')),
  wsPickerList: $('ws-picker-list'),
  filterInput: /** @type {HTMLInputElement} */ ($('filter-input')),
  clearFilter: $('btn-clear-filter'),
  favoritesOnly: /** @type {HTMLInputElement} */ ($('favorites-only')),
  scheduledOnly: /** @type {HTMLInputElement} */ ($('scheduled-only')),
  lastRefreshed: $('last-refreshed'),
  btnHistory: /** @type {HTMLButtonElement} */ ($('btn-history')),
  btnRefresh: $('btn-refresh'),
  btnAddTenant: $('btn-add-tenant'),
  loadingBar: $('loading-bar'),
  authBanner: $('auth-banner'),
  authBannerIcon: $('auth-banner-icon'),
  authBannerText: $('auth-banner-text'),
  btnReauth: $('btn-reauth'),
  toast: $('toast'),
  calNav: $('cal-nav'),
  calTitle: $('cal-title'),
  calMeta: $('cal-meta'),
  emptyTenants: $('empty-tenants'),
  calWrap: $('cal-wrap'),
  calHead: $('cal-head'),
  calScroll: $('cal-scroll'),
  calGrid: $('cal-grid'),
  calEmpty: $('cal-empty'),
  popover: $('popover'),
};

// ── Date helpers (local time) ─────────────────────────────────────────────────
function startOfDay(/** @type {Date} */ d) {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate());
}

/** Calendar arithmetic rather than +24h, so a daylight-saving day stays one column. */
function addDays(/** @type {Date} */ d, /** @type {number} */ n) {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate() + n);
}

function weekStart(/** @type {Date} */ d) {
  const s = startOfDay(d);
  return addDays(s, -((s.getDay() + 6) % 7));
}

function currentRange() {
  const start = view.mode === 'day' ? startOfDay(view.anchor) : weekStart(view.anchor);
  const days = view.mode === 'day' ? 1 : 7;
  return { start, end: addDays(start, days), days };
}

function pad2(/** @type {number} */ n) {
  return String(n).padStart(2, '0');
}

function fmtTime(/** @type {Date|number} */ d) {
  const date = typeof d === 'number' ? new Date(d) : d;
  return `${pad2(date.getHours())}:${pad2(date.getMinutes())}`;
}

function fmtDateTime(/** @type {Date} */ d) {
  return `${d.toLocaleDateString(undefined, { weekday: 'short', day: 'numeric', month: 'short' })} ${fmtTime(d)}`;
}

// ── Message bus ───────────────────────────────────────────────────────────────
window.addEventListener('message', (/** @type {MessageEvent} */ ev) => {
  const msg = ev.data;
  switch (msg.type) {
    case 'updateState':
      state = msg.state;
      render();
      break;
    case 'toast':
      showToast(msg.message, msg.level ?? 'info');
      break;
  }
});

function post(/** @type {any} */ msg) {
  vscode.postMessage(msg);
}

function postRange(/** @type {'setRange'|'ready'} */ type) {
  const { start, end } = currentRange();
  post({ type, rangeStart: start.toISOString(), rangeEnd: end.toISOString() });
}

// The "Updated … · Next in …" label keeps counting between refreshes…
setInterval(renderLastRefreshed, 15_000);

// …and the now-line moves, planned runs turning into past ones.
setInterval(() => {
  // Redrawing closes the popover; don't pull it out from under someone reading it.
  if (dom.popover.classList.contains('hidden')) renderCalendar();
}, 60_000);

// ── Render ────────────────────────────────────────────────────────────────────
function render() {
  dom.loadingBar.classList.toggle('hidden', !state.isLoading);
  renderAuthBanner();
  renderToolbar();
  renderCalendar();
  renderLastRefreshed();
}

function renderAuthBanner() {
  const auth = state.auth;
  dom.authBanner.classList.toggle('hidden', !auth);
  dom.authBanner.classList.toggle('auth-banner-pending', auth?.phase === 'pending');
  dom.authBanner.classList.toggle('auth-banner-failed', auth?.phase === 'failed');
  if (!auth) return;

  const pending = auth.phase === 'pending';
  dom.authBannerIcon.textContent = pending ? '⏳' : '🔑';
  dom.authBannerText.textContent = pending
    ? auth.message || 'Waiting for the Microsoft sign-in to complete…'
    : `Session expired — sign in again to resume refreshing.${auth.message ? ` (${auth.message})` : ''}`;
  /** @type {HTMLButtonElement} */ (dom.btnReauth).disabled = pending;
}

function renderLastRefreshed() {
  if (state.isLoading && state.progress && state.progress.total > 0) {
    dom.lastRefreshed.textContent = `Fetching… ${state.progress.done}/${state.progress.total}`;
  } else if (state.lastRefreshed) {
    const next = state.nextRefreshAt ? ` · Next ${formatIn(state.nextRefreshAt)}` : '';
    dom.lastRefreshed.textContent = `Updated ${formatRelative(state.lastRefreshed)}${next}`;
  } else {
    dom.lastRefreshed.textContent = '';
  }
}

function renderToolbar() {
  dom.tenantSelect.innerHTML = '';
  if (state.tenants.length === 0) {
    dom.tenantSelect.innerHTML = '<option value="">— No tenants —</option>';
  } else {
    state.tenants.forEach((t) => {
      const opt = document.createElement('option');
      opt.value = t.id;
      opt.textContent = t.name;
      opt.selected = t.id === state.currentTenantId;
      dom.tenantSelect.appendChild(opt);
    });
  }

  const selWs = state.workspaces.find((w) => w.id === state.selectedWorkspaceId);
  dom.wsPickerLabel.textContent = selWs ? selWs.displayName : 'All workspaces';

  dom.filterInput.value = localFilter.text;
  dom.favoritesOnly.checked = state.favoritesOnly;
  dom.clearFilter.style.display = localFilter.text ? 'block' : 'none';
}

// ── Filtering ─────────────────────────────────────────────────────────────────
/** Same rules as the dashboard: name/workspace text, item type, last-run status. */
function getVisibleItems() {
  let list = state.items.slice();

  if (localFilter.text) {
    const needle = localFilter.text.toLowerCase();
    list = list.filter(
      (p) =>
        p.displayName.toLowerCase().includes(needle) ||
        p.workspaceName.toLowerCase().includes(needle),
    );
  }
  if (localFilter.itemType !== 'all') {
    list = list.filter((p) => (p.itemType ?? 'pipeline') === localFilter.itemType);
  }
  if (localFilter.scheduledOnly) {
    // scheduleEnabled is set whenever a schedule was found, true or false (paused).
    list = list.filter((p) => p.scheduleEnabled !== undefined);
  }
  if (localFilter.statusFilters.size > 0) {
    list = list.filter((p) => {
      if (localFilter.statusFilters.has('neverRun') && !p.lastStatus) return true;
      return !!p.lastStatus && localFilter.statusFilters.has(p.lastStatus);
    });
  }
  return list;
}

// ── Calendar ──────────────────────────────────────────────────────────────────
/** Events currently drawn, indexed by the `data-ev` attribute of their block. */
/** @type {Array<{ ev: any, item: any }>} */
let drawn = [];
/** Hidden-block groups behind each "+N" pill, indexed by `data-more`. */
/** @type {Array<Array<{ ev: any, item: any }>>} */
let moreGroups = [];

function renderCalendar() {
  closePopover();

  if (state.tenants.length === 0) {
    dom.emptyTenants.classList.remove('hidden');
    dom.calWrap.classList.add('hidden');
    dom.calNav.classList.add('hidden');
    return;
  }
  dom.emptyTenants.classList.add('hidden');
  dom.calWrap.classList.remove('hidden');
  dom.calNav.classList.remove('hidden');

  const { start, days } = currentRange();
  renderNav(start, days);

  const visibleItems = getVisibleItems();
  const itemById = new Map(visibleItems.map((i) => [i.id, i]));
  const events = state.events.filter((e) => itemById.has(e.itemId));
  dom.calMeta.textContent = `${visibleItems.length} item${visibleItems.length === 1 ? '' : 's'}`;

  drawn = [];
  moreGroups = [];
  const nowMs = Date.now();
  const scrollTop = dom.calScroll.scrollTop;

  dom.calHead.style.setProperty('--cal-cols', String(days));
  dom.calGrid.style.setProperty('--cal-cols', String(days));

  let headHtml = '<div></div>';
  let gridHtml = `<div class="cal-gutter">${hourLabels()}</div>`;

  for (let i = 0; i < days; i++) {
    const dayStart = addDays(start, i);
    const dayStartMs = dayStart.getTime();
    const dayEndMs = addDays(start, i + 1).getTime();
    const isToday = nowMs >= dayStartMs && nowMs < dayEndMs;

    headHtml += `<div class="day-head${isToday ? ' today' : ''}">
      <span class="dow">${esc(dayStart.toLocaleDateString(undefined, { weekday: 'short' }))}</span>
      <span class="dom">${dayStart.getDate()}</span></div>`;

    const segments = [];
    const bandSegs = [];
    for (const ev of events) {
      const s = Date.parse(ev.start);
      const e = Date.parse(ev.end);
      // An event ending exactly at midnight belongs to the day before.
      if (!(s < dayEndMs && (e > dayStartMs || s >= dayStartMs))) continue;
      const m0 = (Math.max(s, dayStartMs) - dayStartMs) / 60_000;
      const m1 = (Math.min(Math.max(e, s), dayEndMs) - dayStartMs) / 60_000;
      const seg = { ev, item: itemById.get(ev.itemId), m0, m1, vm1: Math.max(m1, m0 + MIN_EVENT_MINUTES) };
      // Bands span hours: laid out beside the other blocks they would crush them.
      (ev.kind === 'band' ? bandSegs : segments).push(seg);
    }
    layoutSegments(segments);

    // One lane per item, along the right edge; the regular blocks give up that width.
    const lanes = new Map();
    for (const seg of bandSegs) if (!lanes.has(seg.ev.itemId)) lanes.set(seg.ev.itemId, lanes.size);
    const laneCount = Math.min(lanes.size, MAX_BAND_LANES);

    let blocks = '';
    for (const seg of segments) {
      if (seg.hidden) continue;
      blocks += blockHtml(seg);
    }
    blocks += pillsHtml(segments);

    let strips = '';
    for (const seg of bandSegs) {
      strips += bandHtml(seg, Math.min(lanes.get(seg.ev.itemId), MAX_BAND_LANES - 1));
    }

    const nowLine = isToday
      ? `<div class="now-line" style="top:${((nowMs - dayStartMs) / 3_600_000) * HOUR_H}px"></div>`
      : '';
    gridHtml += `<div class="day-col${isToday ? ' today' : ''}">
      <div class="day-events" style="right:${laneCount * BAND_LANE_PX}px">${blocks}</div>${strips}${nowLine}</div>`;
  }

  dom.calHead.innerHTML = headHtml;
  dom.calGrid.innerHTML = gridHtml;

  // The header must line up with the columns, so it gives up the scrollbar's width too.
  dom.calHead.style.paddingRight = `${dom.calScroll.offsetWidth - dom.calScroll.clientWidth}px`;

  const anyEvent = events.some((e) => Date.parse(e.start) < addDays(start, days).getTime());
  dom.calEmpty.classList.toggle('hidden', anyEvent || state.isLoading);
  dom.calEmpty.textContent = state.items.length === 0
    ? 'No items yet — refresh, or switch off “Favorites” to look at every workspace.'
    : 'Nothing scheduled or recorded here with the current filters.';

  if (needsInitialScroll) {
    needsInitialScroll = false;
    const hour = start.getTime() <= nowMs && nowMs < addDays(start, days).getTime()
      ? Math.max(0, new Date(nowMs).getHours() - 1)
      : 7;
    dom.calScroll.scrollTop = hour * HOUR_H;
  } else {
    dom.calScroll.scrollTop = scrollTop;
  }
}

function renderNav(/** @type {Date} */ start, /** @type {number} */ days) {
  const long = { day: 'numeric', month: 'short' };
  dom.calTitle.textContent =
    days === 1
      ? start.toLocaleDateString(undefined, { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' })
      : `${start.toLocaleDateString(undefined, long)} – ${addDays(start, days - 1).toLocaleDateString(undefined, { ...long, year: 'numeric' })}`;
  document.querySelectorAll('.view-btn').forEach((b) => {
    b.classList.toggle('active', /** @type {HTMLElement} */ (b).dataset.view === view.mode);
  });
}

function hourLabels() {
  let html = '';
  for (let h = 1; h < 24; h++) {
    html += `<span class="hour-label" style="top:${h * HOUR_H}px">${pad2(h)}:00</span>`;
  }
  return html;
}

/** Puts overlapping blocks side by side, Outlook-style. Blocks that would need more
 *  than MAX_COLUMNS columns are flagged `hidden` and summarised by a "+N" pill. */
function layoutSegments(/** @type {any[]} */ segs) {
  segs.sort((a, b) => a.m0 - b.m0 || b.vm1 - b.m0 - (a.vm1 - a.m0));

  /** @type {any[]} */
  let cluster = [];
  let clusterEnd = -1;

  const flush = () => {
    if (cluster.length === 0) return;
    /** @type {number[]} */
    const colEnds = [];
    for (const s of cluster) {
      let c = colEnds.findIndex((end) => end <= s.m0);
      if (c === -1) {
        c = colEnds.length;
        colEnds.push(0);
      }
      colEnds[c] = s.vm1;
      s.col = c;
    }
    // One column is given up to the pill when the cluster is too wide.
    const overflow = colEnds.length > MAX_COLUMNS;
    const shown = overflow ? MAX_COLUMNS - 1 : colEnds.length;
    const total = overflow ? MAX_COLUMNS : colEnds.length;
    const hiddenSegs = [];
    for (const s of cluster) {
      s.cols = total;
      if (s.col >= shown) {
        s.hidden = true;
        hiddenSegs.push(s);
      }
    }
    if (hiddenSegs.length > 0) {
      hiddenSegs[0].pill = { col: shown, cols: total, group: hiddenSegs };
    }
    cluster = [];
    clusterEnd = -1;
  };

  for (const s of segs) {
    if (cluster.length > 0 && s.m0 >= clusterEnd) flush();
    cluster.push(s);
    clusterEnd = Math.max(clusterEnd, s.vm1);
  }
  flush();
}

function blockHtml(/** @type {any} */ seg) {
  const { ev, item } = seg;
  const maxPx = 24 * HOUR_H;
  const top = (seg.m0 / 60) * HOUR_H;
  const height = Math.max(10, Math.min(((seg.vm1 - seg.m0) / 60) * HOUR_H, maxPx - top));

  const index = drawn.push({ ev, item }) - 1;
  const cls = ev.kind === 'run' ? `ev ev-${statusCls(ev.status)}` : 'ev ev-planned';

  return `<div class="${cls}${height < 34 ? ' ev-compact' : ''}" data-ev="${index}"
      style="top:${top}px;height:${height}px;left:calc(${(seg.col / seg.cols) * 100}% + 1px);width:calc(${100 / seg.cols}% - 3px)"
      title="${esc(describe(ev, item))}">
    <span class="ev-title">${esc(item.displayName)}</span>
    <span class="ev-sub">${esc(`${timeRange(ev)} · ${item.workspaceName}`)}</span>
  </div>`;
}

/** A frequent cron, folded into a thin strip from its first to its last run of the day. */
function bandHtml(/** @type {any} */ seg, /** @type {number} */ lane) {
  const { ev, item } = seg;
  const index = drawn.push({ ev, item }) - 1;
  const top = (seg.m0 / 60) * HOUR_H;
  const height = Math.max(6, ((seg.m1 - seg.m0) / 60) * HOUR_H);
  // Recorded runs are coloured by their worst status; upcoming ones are hatched.
  const cls = ev.status ? `bs-${statusCls(ev.status)}` : 'bs-planned';
  return `<div class="band-strip ${cls}" data-ev="${index}"
      style="top:${top}px;height:${height}px;right:${lane * BAND_LANE_PX + 1}px"
      title="${esc(describe(ev, item))}"></div>`;
}

function pillsHtml(/** @type {any[]} */ segs) {
  let html = '';
  for (const seg of segs) {
    if (!seg.pill) continue;
    const { col, cols, group } = seg.pill;
    const index =
      moreGroups.push(group.map((/** @type {any} */ s) => ({ ev: s.ev, item: s.item }))) - 1;
    html += `<div class="ev-more" data-more="${index}"
        style="top:${(seg.m0 / 60) * HOUR_H}px;left:calc(${(col / cols) * 100}% + 1px);width:calc(${100 / cols}% - 3px)"
        title="${group.length} more at this time">+${group.length}</div>`;
  }
  return html;
}

// ── Event text ────────────────────────────────────────────────────────────────
function timeRange(/** @type {any} */ ev) {
  const s = Date.parse(ev.start);
  const e = Date.parse(ev.end);
  if (e <= s) return fmtTime(s);
  return `${fmtTime(s)}–${ev.kind === 'run' ? '' : '~'}${fmtTime(e)}`;
}

function typeLabel(/** @type {string|undefined} */ t) {
  switch (t) {
    case 'semanticModel': return 'Semantic model';
    case 'notebook': return 'Notebook';
    case 'copyJob': return 'Copy job';
    case 'dbtJob': return 'dbt job';
    default: return 'Pipeline';
  }
}

function describe(/** @type {any} */ ev, /** @type {any} */ item) {
  const s = new Date(ev.start);
  const lines = [item.displayName, `${item.workspaceName} · ${typeLabel(item.itemType)}`];
  if (ev.kind === 'run') {
    lines.push(`${ev.status ?? 'Unknown'} · ${timeRange(ev)}`);
    const ms = Date.parse(ev.end) - s.getTime();
    if (ms > 0) lines.push(`Duration ${formatDuration(ms)}`);
  } else if (ev.kind === 'band') {
    lines.push(`${ev.status ?? 'Planned'} · ${ev.label ?? ''}`, timeRange(ev));
  } else {
    lines.push(`Planned · ${timeRange(ev)}`);
    if (ev.estimated) lines.push(`Estimated length: ${formatDuration(Date.parse(ev.end) - s.getTime())} (average of past runs)`);
  }
  return lines.join('\n');
}

// ── Popover ───────────────────────────────────────────────────────────────────
function closePopover() {
  dom.popover.classList.add('hidden');
  dom.popover.innerHTML = '';
}

function placePopover(/** @type {number} */ x, /** @type {number} */ y) {
  dom.popover.classList.remove('hidden');
  const w = dom.popover.offsetWidth;
  const h = dom.popover.offsetHeight;
  dom.popover.style.left = `${Math.max(8, Math.min(x, window.innerWidth - w - 8))}px`;
  dom.popover.style.top = `${Math.max(8, Math.min(y, window.innerHeight - h - 8))}px`;
}

function openEventPopover(/** @type {{ev:any,item:any}} */ entry, /** @type {number} */ x, /** @type {number} */ y) {
  const { ev, item } = entry;
  const s = new Date(ev.start);
  const e = new Date(ev.end);
  const row = (/** @type {string} */ label, /** @type {string} */ value) =>
    `<div class="pop-row"><span class="pop-label">${esc(label)}</span><span class="pop-value">${value}</span></div>`;

  let html = `<div class="pop-title">${esc(item.displayName)}</div>
    <div class="pop-ws muted">${esc(item.workspaceName)} · ${esc(typeLabel(item.itemType))}</div>`;

  if (ev.kind === 'run') {
    html += row('Status', `<span class="status-badge status-${statusCls(ev.status)}">${esc(ev.status ?? 'Unknown')}</span>`);
    html += row('Started', esc(fmtDateTime(s)));
    if (e.getTime() > s.getTime()) {
      html += row('Ended', esc(fmtDateTime(e)));
      html += row('Duration', esc(formatDuration(e.getTime() - s.getTime())));
    }
  } else if (ev.kind === 'band' && ev.status) {
    // Recorded runs of a frequent cron, folded into one strip for the day.
    html += row('Status', `<span class="status-badge status-${statusCls(ev.status)}">${esc(ev.status)}</span>`);
    html += row('Runs', esc(ev.label ?? ''));
    html += row('From', esc(fmtDateTime(s)));
    html += row('To', esc(fmtDateTime(e)));
  } else {
    html += row('Status', '<span class="muted">Planned</span>');
    html += row('Starts', esc(fmtDateTime(s)));
    if (ev.kind === 'band') {
      html += row('Cadence', esc(ev.label ?? ''));
      html += row('Until', esc(`~${fmtTime(e)}`));
    } else if (e.getTime() > s.getTime()) {
      html += row('Ends', esc(`~${fmtTime(e)} (estimated)`));
      html += row('Length', esc(`${formatDuration(e.getTime() - s.getTime())} — average of past runs`));
    } else {
      html += row('Length', '<span class="muted">unknown — no completed run to average yet</span>');
    }
  }
  if (item.scheduleSummary) html += row('Schedule', esc(item.scheduleSummary));
  if (item.scheduleEnabled === false) html += row('Schedule', '<span class="next-paused">paused</span>');

  html += `<div class="pop-actions">
    <button class="btn btn-primary btn-sm" data-pop="portal" data-id="${esc(item.id)}">Open in Fabric</button>
    <button class="btn btn-secondary btn-sm" data-pop="history" data-id="${esc(item.id)}">History</button>
  </div>`;

  dom.popover.innerHTML = html;
  placePopover(x, y);
}

function openMorePopover(/** @type {Array<{ev:any,item:any}>} */ group, /** @type {number} */ x, /** @type {number} */ y) {
  const sorted = group.slice().sort((a, b) => Date.parse(a.ev.start) - Date.parse(b.ev.start));
  let html = `<div class="pop-title">${group.length} more at this time</div>`;
  sorted.forEach((entry) => {
    drawn.push(entry);
    html += `<button class="pop-list-item" data-listed="${drawn.length - 1}">
      <span class="ev-title">${esc(entry.item.displayName)}</span>
      <span class="ev-sub">${esc(`${timeRange(entry.ev)} · ${entry.item.workspaceName}`)}</span>
    </button>`;
  });
  dom.popover.innerHTML = html;
  placePopover(x, y);
}

dom.calGrid.addEventListener('click', (e) => {
  const target = /** @type {HTMLElement} */ (e.target);
  const block = target.closest('[data-ev]');
  const pill = target.closest('[data-more]');
  if (!block && !pill) {
    closePopover();
    return;
  }
  e.stopPropagation();
  if (block) {
    const entry = drawn[Number(/** @type {HTMLElement} */ (block).dataset.ev)];
    if (entry) openEventPopover(entry, e.clientX + 8, e.clientY + 8);
  } else if (pill) {
    const group = moreGroups[Number(/** @type {HTMLElement} */ (pill).dataset.more)];
    if (group) openMorePopover(group, e.clientX + 8, e.clientY + 8);
  }
});

dom.popover.addEventListener('click', (e) => {
  const target = /** @type {HTMLElement} */ (e.target);
  e.stopPropagation();

  const listed = target.closest('[data-listed]');
  if (listed) {
    const entry = drawn[Number(/** @type {HTMLElement} */ (listed).dataset.listed)];
    const rect = dom.popover.getBoundingClientRect();
    if (entry) openEventPopover(entry, rect.left, rect.top);
    return;
  }

  const action = /** @type {HTMLElement|null} */ (target.closest('[data-pop]'));
  if (!action) return;
  const id = action.dataset.id ?? '';
  if (action.dataset.pop === 'portal') post({ type: 'openInFabric', itemId: id });
  if (action.dataset.pop === 'history') post({ type: 'viewHistory', itemId: id });
  closePopover();
});

document.addEventListener('click', (e) => {
  if (!dom.popover.classList.contains('hidden') && !dom.popover.contains(/** @type {Node} */ (e.target))) {
    closePopover();
  }
  if (wsPickerOpen && !dom.wsPicker.contains(/** @type {Node} */ (e.target))) closeWsPicker();
});

document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') {
    closePopover();
    closeWsPicker();
  }
});

dom.calScroll.addEventListener('scroll', closePopover);
window.addEventListener('resize', () => {
  dom.calHead.style.paddingRight = `${dom.calScroll.offsetWidth - dom.calScroll.clientWidth}px`;
});

// ── Navigation ────────────────────────────────────────────────────────────────
function rangeChanged() {
  postRange('setRange');
  renderCalendar();
}

$('btn-today').addEventListener('click', () => {
  view.anchor = startOfDay(new Date());
  needsInitialScroll = true;
  rangeChanged();
});
$('btn-prev').addEventListener('click', () => {
  view.anchor = addDays(view.anchor, view.mode === 'day' ? -1 : -7);
  rangeChanged();
});
$('btn-next').addEventListener('click', () => {
  view.anchor = addDays(view.anchor, view.mode === 'day' ? 1 : 7);
  rangeChanged();
});
document.querySelectorAll('.view-btn').forEach((btn) => {
  btn.addEventListener('click', () => {
    view.mode = /** @type {'day'|'week'} */ (/** @type {HTMLElement} */ (btn).dataset.view ?? 'week');
    rangeChanged();
  });
});

// ── Toolbar ───────────────────────────────────────────────────────────────────
dom.tenantSelect.addEventListener('change', () => {
  post({ type: 'selectTenant', tenantId: dom.tenantSelect.value });
});

let wsPickerOpen = false;

function openWsPicker() {
  wsPickerOpen = true;
  dom.wsPickerDropdown.classList.remove('hidden');
  dom.wsPickerSearch.value = '';
  dom.wsPickerSearch.focus();
  renderWsPickerList('');
}

function closeWsPicker() {
  wsPickerOpen = false;
  dom.wsPickerDropdown.classList.add('hidden');
}

function renderWsPickerList(/** @type {string} */ filter) {
  const lc = filter.toLowerCase();
  const sorted = state.workspaces.slice().sort((a, b) => {
    if (a.isFavorite && !b.isFavorite) return -1;
    if (!a.isFavorite && b.isFavorite) return 1;
    return a.displayName.localeCompare(b.displayName);
  });
  const filtered = lc ? sorted.filter((ws) => ws.displayName.toLowerCase().includes(lc)) : sorted;

  dom.wsPickerList.innerHTML = '';

  const add = (/** @type {string} */ id, /** @type {string} */ name, /** @type {boolean} */ star) => {
    const li = document.createElement('li');
    const active = id === state.selectedWorkspaceId;
    li.className = 'ws-picker-item' + (active ? ' active' : '');
    li.innerHTML = `<span class="ws-picker-dot">${active ? '●' : ''}</span>
      <span class="ws-picker-name">${esc(name)}</span>${star ? '<span class="ws-star-btn starred">★</span>' : ''}`;
    li.addEventListener('click', () => {
      closeWsPicker();
      post({ type: 'selectWorkspace', workspaceId: id });
    });
    dom.wsPickerList.appendChild(li);
  };

  add('', 'All workspaces', false);
  filtered.forEach((ws) => add(ws.id, ws.displayName, !!ws.isFavorite));
}

dom.wsPickerToggle.addEventListener('click', (e) => {
  e.stopPropagation();
  if (wsPickerOpen) closeWsPicker();
  else openWsPicker();
});

dom.wsPickerSearch.addEventListener('input', () => {
  renderWsPickerList(dom.wsPickerSearch.value.trim());
});

let filterDebounce = 0;
dom.filterInput.addEventListener('input', () => {
  localFilter.text = dom.filterInput.value;
  dom.clearFilter.style.display = localFilter.text ? 'block' : 'none';
  clearTimeout(filterDebounce);
  filterDebounce = setTimeout(renderCalendar, 120);
});

dom.clearFilter.addEventListener('click', () => {
  localFilter.text = '';
  dom.filterInput.value = '';
  dom.clearFilter.style.display = 'none';
  renderCalendar();
});

dom.favoritesOnly.addEventListener('change', () => {
  post({ type: 'setFavoritesOnly', enabled: dom.favoritesOnly.checked });
});

dom.scheduledOnly.addEventListener('change', () => {
  localFilter.scheduledOnly = dom.scheduledOnly.checked;
  renderCalendar();
});

document.querySelectorAll('.type-filter-btn').forEach((btn) => {
  btn.addEventListener('click', () => {
    localFilter.itemType = /** @type {HTMLElement} */ (btn).dataset.itype ?? 'all';
    document.querySelectorAll('.type-filter-btn').forEach((b) => b.classList.remove('active'));
    btn.classList.add('active');
    renderCalendar();
  });
});

document.querySelectorAll('.status-filter-btn').forEach((btn) => {
  btn.addEventListener('click', () => {
    const status = /** @type {HTMLElement} */ (btn).dataset.status ?? '';
    if (localFilter.statusFilters.has(status)) {
      localFilter.statusFilters.delete(status);
      btn.classList.remove('active');
    } else {
      localFilter.statusFilters.add(status);
      btn.classList.add('active');
    }
    renderCalendar();
  });
});

dom.btnRefresh.addEventListener('click', () => post({ type: 'refresh' }));
dom.btnReauth.addEventListener('click', () => post({ type: 'reauthenticate' }));
dom.btnAddTenant.addEventListener('click', () => post({ type: 'addTenant' }));
$('btn-empty-add-tenant').addEventListener('click', () => post({ type: 'addTenant' }));

dom.btnHistory.addEventListener('click', () => {
  const ids = getVisibleItems().map((i) => i.id);
  if (ids.length === 0) {
    showToast('No items to load history for.', 'info');
    return;
  }
  // The extension caps one request; say so rather than silently loading a part.
  const capped = ids.slice(0, 200);
  if (capped.length < ids.length) {
    showToast(`Loading history for the first ${capped.length} of ${ids.length} items — narrow the filters for the rest.`, 'warning');
  }
  post({ type: 'loadHistory', itemIds: capped });
});

// ── Toast ─────────────────────────────────────────────────────────────────────
let toastTimer = 0;
function showToast(/** @type {string} */ msg, /** @type {string} */ level = 'info') {
  dom.toast.textContent = msg;
  dom.toast.className = `toast toast-${level}`;
  dom.toast.classList.remove('hidden');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => dom.toast.classList.add('hidden'), 4000);
}

// ── Helpers ───────────────────────────────────────────────────────────────────
function statusCls(/** @type {string|undefined} */ status) {
  switch (status) {
    case 'Succeeded': return 'succeeded';
    case 'Failed': return 'failed';
    case 'InProgress': return 'inprogress';
    case 'Cancelled': return 'cancelled';
    case 'Queued': return 'queued';
    default: return 'unknown';
  }
}

function formatRelative(/** @type {string} */ iso) {
  const mins = Math.floor((Date.now() - new Date(iso).getTime()) / 60_000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  const h = Math.floor(mins / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.floor(h / 24)}d ago`;
}

function formatIn(/** @type {string} */ iso) {
  const diff = new Date(iso).getTime() - Date.now();
  if (diff <= 0) return 'now';
  const mins = Math.ceil(diff / 60_000);
  if (mins < 60) return `in ${mins}m`;
  return `in ${Math.floor(mins / 60)}h`;
}

function formatDuration(/** @type {number} */ ms) {
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  const r = s % 60;
  if (m < 60) return `${m}m ${r}s`;
  return `${Math.floor(m / 60)}h ${m % 60}m`;
}

function esc(/** @type {string} */ s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

// ── Bootstrap ─────────────────────────────────────────────────────────────────
postRange('ready');
