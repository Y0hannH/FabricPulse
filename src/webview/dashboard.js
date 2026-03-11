// @ts-check
/// <reference lib="dom" />
'use strict';

// ── VS Code API ───────────────────────────────────────────────────────────────
// acquireVsCodeApi() can only be called once per webview lifetime
const vscode = acquireVsCodeApi();

// ── State ─────────────────────────────────────────────────────────────────────
/** @type {import('../models/types').DashboardState} */
let state = {
  tenants: [],
  currentTenantId: '',
  workspaces: [],
  pipelines: [],
  selectedWorkspaceId: '',
  lastRefreshed: '',
  nextRefreshAt: '',
  isFromCache: false,
  isLoading: false,
};

/** Local filter — round-tripped only for tenant/workspace changes that trigger an API call */
const localFilter = {
  text: '',
  favoritesOnly: false,
  statusFilters: /** @type {Set<string>} */ (new Set()),
  itemType: 'all', // 'all' | 'pipeline' | 'semanticModel'
};

/** Whether we have already applied the default favorites-filter on first real data load */
let _favoritesDefaultApplied = false;

/** Sort state */
const sort = { col: 'name', dir: 1 }; // dir: 1 = asc, -1 = desc

// ── DOM refs ──────────────────────────────────────────────────────────────────
const $ = (/** @type {string} */ id) => /** @type {HTMLElement} */ (document.getElementById(id));

const dom = {
  tenantSelect:      /** @type {HTMLSelectElement} */ ($('tenant-select')),
  wsPicker:          $('ws-picker'),
  wsPickerToggle:    /** @type {HTMLButtonElement} */ ($('ws-picker-toggle')),
  wsPickerLabel:     $('ws-picker-label'),
  wsPickerDropdown:  $('ws-picker-dropdown'),
  wsPickerSearch:    /** @type {HTMLInputElement}  */ ($('ws-picker-search')),
  wsPickerList:      $('ws-picker-list'),
  filterInput:       /** @type {HTMLInputElement}  */ ($('filter-input')),
  clearFilter:       $('btn-clear-filter'),
  favoritesOnly:     /** @type {HTMLInputElement}  */ ($('favorites-only')),
  lastRefreshed:     $('last-refreshed'),
  btnRefresh:        $('btn-refresh'),
  btnAddTenant:      $('btn-add-tenant'),
  loadingBar:        $('loading-bar'),
  toast:             $('toast'),
  emptyTenants:      $('empty-tenants'),
  tableWrap:         $('table-wrap'),
  tbody:             $('pipeline-tbody'),
  noResults:         $('no-results'),
};

// ── Message bus ───────────────────────────────────────────────────────────────
window.addEventListener('message', (/** @type {MessageEvent} */ ev) => {
  const msg = ev.data;
  switch (msg.type) {
    case 'updateState':
      state = msg.state;
      // Auto-enable favorites filter once on first real data load (if favorites exist)
      if (!_favoritesDefaultApplied && state.pipelines.length > 0) {
        _favoritesDefaultApplied = true;
        if (state.pipelines.some(p => p.isFavorite)) {
          localFilter.favoritesOnly = true;
          dom.favoritesOnly.checked = true;
          post({ type: 'setFavoritesOnly', enabled: true });
        }
      }
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

// ── Render ────────────────────────────────────────────────────────────────────
function render() {
  renderLoadingBar();
  renderToolbar();
  renderTable();
  renderLastRefreshed();
}

function renderLoadingBar() {
  dom.loadingBar.classList.toggle('hidden', !state.isLoading);
}

function renderLastRefreshed() {
  if (state.isLoading && state.batchProgress) {
    const { done, total } = state.batchProgress;
    dom.lastRefreshed.textContent = `Fetching… batch ${done}/${total}`;
    return;
  }
  if (state.lastRefreshed) {
    const time = formatRelative(state.lastRefreshed);
    const label = state.isFromCache ? `Cached · ${time}` : `Updated ${time}`;
    const nextPart = state.nextRefreshAt
      ? ` · Next ${formatIn(state.nextRefreshAt)}`
      : '';
    dom.lastRefreshed.textContent = label + nextPart;
  } else {
    dom.lastRefreshed.textContent = '';
  }
}

function renderToolbar() {
  // Tenant select
  dom.tenantSelect.innerHTML = '';
  if (state.tenants.length === 0) {
    dom.tenantSelect.innerHTML = '<option value="">— No tenants —</option>';
  } else {
    state.tenants.forEach(t => {
      const opt = document.createElement('option');
      opt.value = t.id;
      opt.textContent = t.name;
      opt.selected = t.id === state.currentTenantId;
      dom.tenantSelect.appendChild(opt);
    });
  }

  // Workspace slicer label
  const selWs = state.workspaces.find(w => w.id === state.selectedWorkspaceId);
  dom.wsPickerLabel.textContent = selWs ? selWs.displayName : 'All workspaces';

  // Keep local filter controls in sync with first render
  dom.filterInput.value = localFilter.text;
  dom.favoritesOnly.checked = localFilter.favoritesOnly;
  dom.clearFilter.style.display = localFilter.text ? 'block' : 'none';
}

// ── Filtering & sorting ───────────────────────────────────────────────────────
function getVisible() {
  let list = state.pipelines.slice();

  if (state.selectedWorkspaceId) {
    list = list.filter(p => p.workspaceId === state.selectedWorkspaceId);
  }
  if (localFilter.text) {
    const needle = localFilter.text.toLowerCase();
    list = list.filter(p =>
      p.displayName.toLowerCase().includes(needle) ||
      p.workspaceName.toLowerCase().includes(needle)
    );
  }
  if (localFilter.favoritesOnly) {
    list = list.filter(p => p.isFavorite);
  }
  if (localFilter.itemType !== 'all') {
    const target = localFilter.itemType;
    list = list.filter(p => (p.itemType ?? 'pipeline') === target);
  }
  if (localFilter.statusFilters.size > 0) {
    list = list.filter(p => {
      const status = p.lastRun?.status;
      if (localFilter.statusFilters.has('neverRun') && !status) return true;
      return status && localFilter.statusFilters.has(status);
    });
  }

  const STATUS_ORDER = /** @type {Record<string, number>} */ ({ 'Failed': 0, 'InProgress': 1, 'Succeeded': 2 });

  list.sort((a, b) => {
    switch (sort.col) {
      case 'name':      return a.displayName.localeCompare(b.displayName) * sort.dir;
      case 'workspace': return a.workspaceName.localeCompare(b.workspaceName) * sort.dir;
      case 'status': {
        const as = STATUS_ORDER[a.lastRun?.status ?? ''] ?? 3;
        const bs = STATUS_ORDER[b.lastRun?.status ?? ''] ?? 3;
        return (as - bs) * sort.dir;
      }
      case 'duration': {
        const ad = a.lastRun?.durationMs;
        const bd = b.lastRun?.durationMs;
        if (ad == null && bd == null) return 0;
        if (ad == null) return 1;
        if (bd == null) return -1;
        return (ad - bd) * sort.dir;
      }
      case 'rate': {
        const ar = a.successRate7d;
        const br = b.successRate7d;
        if (ar == null && br == null) return 0;
        if (ar == null) return 1;
        if (br == null) return -1;
        return (ar - br) * sort.dir;
      }
      default: return 0;
    }
  });

  return list;
}

// ── Table rendering ───────────────────────────────────────────────────────────
function renderTable() {
  updateSortArrows();

  if (state.tenants.length === 0) {
    dom.emptyTenants.classList.remove('hidden');
    dom.tableWrap.classList.add('hidden');
    return;
  }
  dom.emptyTenants.classList.add('hidden');
  dom.tableWrap.classList.remove('hidden');

  const visible = getVisible();

  if (visible.length === 0) {
    dom.tbody.innerHTML = '';
    dom.noResults.classList.remove('hidden');
    return;
  }
  dom.noResults.classList.add('hidden');

  // Diff-based update: only re-render if data changed
  const newHtml = visible.map(buildRowHtml).join('');

  // Simple check: if innerHTML is unchanged don't re-set (avoids flickering)
  if (dom.tbody.innerHTML !== newHtml) {
    dom.tbody.innerHTML = newHtml;
    attachRowListeners();
  }
}

function buildRowHtml(/** @type {any} */ p) {
  const run = p.lastRun;
  const statusClass = statusCls(run?.status);
  const statusLabel = run?.status ?? '';
  const timeAgo = run?.startTime ? formatRelative(run.startTime) : '';
  const duration = run?.durationMs != null ? formatDuration(run.durationMs) : '—';
  const runId = run?.runId ?? '';
  const isModel = (p.itemType ?? 'pipeline') === 'semanticModel';

  const rate = p.successRate7d;
  const rateCls = rate == null ? '' : rate >= 90 ? 'rate-high' : rate >= 70 ? 'rate-mid' : 'rate-low';
  const rateText = rate != null ? `${rate}%` : '—';

  const avgDur = p.avgDurationMs != null ? formatDuration(p.avgDurationMs) : '—';
  const minDur = p.minDurationMs != null ? formatDuration(p.minDurationMs) : '—';
  const maxDur = p.maxDurationMs != null ? formatDuration(p.maxDurationMs) : '—';

  const typeBadge = isModel
    ? `<span class="item-type-badge item-type-model" title="Semantic Model">Model</span>`
    : `<span class="item-type-badge item-type-pipeline" title="Data Pipeline">Pipeline</span>`;

  const rerunTitle = isModel ? 'Trigger refresh' : 'Re-run pipeline';
  const rerunIcon = isModel ? '⟳' : '▶';

  return `
<tr data-pid="${esc(p.id)}" data-wsid="${esc(p.workspaceId)}"
    data-pname="${esc(p.displayName)}" data-wsname="${esc(p.workspaceName)}"
    data-runid="${esc(runId)}" data-itype="${esc(p.itemType ?? 'pipeline')}">
  <td class="col-star">
    <button class="star-btn ${p.isFavorite ? 'starred' : ''}"
            data-action="star"
            title="${p.isFavorite ? 'Remove from favorites' : 'Add to favorites'}">
      ${p.isFavorite ? '★' : '☆'}
    </button>
  </td>
  <td class="col-type">${typeBadge}</td>
  <td class="col-name">
    <div class="name-cell">
      <div class="actions">
        <button class="action-btn" data-action="refresh-pipeline"  title="Refresh last run">↺</button>
        <button class="action-btn" data-action="fetch-history"    title="Fetch full history">⬇</button>
        <button class="action-btn" data-action="rerun"            title="${rerunTitle}">${rerunIcon}</button>
        <button class="action-btn ${!runId ? 'disabled' : ''}"   data-action="copy"    title="Copy Run ID">📋</button>
        <button class="action-btn" data-action="portal"           title="Open in Fabric portal">🔗</button>
        <button class="action-btn" data-action="history"          title="View full history">📊</button>
      </div>
      <span class="pipeline-name" title="${esc(p.displayName)}">${esc(p.displayName)}</span>
    </div>
  </td>
  <td class="col-workspace muted" title="${esc(p.workspaceName)}">${esc(p.workspaceName)}</td>
  <td class="col-status">
    ${run
      ? `<span class="status-badge status-${statusClass}">${esc(statusLabel)}</span><span class="time-ago muted">${esc(timeAgo)}</span>`
      : '<span class="muted">—</span>'}
  </td>
  <td class="col-duration" style="text-align:right">${esc(duration)}</td>
  <td class="col-dur-avg muted" style="text-align:right" title="Avg duration (all runs)">${esc(avgDur)}</td>
  <td class="col-dur-min muted" style="text-align:right" title="Min duration (succeeded only)">${esc(minDur)}</td>
  <td class="col-dur-max muted" style="text-align:right" title="Max duration (succeeded only)">${esc(maxDur)}</td>
  <td class="col-rate ${rateCls}" style="text-align:right">${esc(rateText)}</td>
  <td class="col-runs" style="text-align:right">${p.cachedRunCount != null ? esc(String(p.cachedRunCount)) : '—'}</td>
</tr>`;
}

function attachRowListeners() {
  dom.tbody.querySelectorAll('tr').forEach(row => {
    row.addEventListener('click', handleRowClick);
  });
}

function handleRowClick(/** @type {MouseEvent} */ e) {
  const btn = /** @type {HTMLElement} */ (e.target);
  if (!btn.dataset.action) return;

  const tr = /** @type {HTMLElement} */ (btn.closest('tr'));
  const pid    = tr.dataset.pid   ?? '';
  const wsid   = tr.dataset.wsid  ?? '';
  const pname  = tr.dataset.pname ?? '';
  const wname  = tr.dataset.wsname ?? '';
  const runId  = tr.dataset.runid ?? '';
  const itype  = /** @type {'pipeline'|'semanticModel'} */ (tr.dataset.itype ?? 'pipeline');

  switch (btn.dataset.action) {
    case 'star':
      post({ type: 'toggleFavorite', pipelineId: pid, workspaceId: wsid, itemType: itype });
      // Optimistic UI: toggle starred class immediately
      btn.classList.toggle('starred');
      btn.textContent = btn.classList.contains('starred') ? '★' : '☆';
      break;

    case 'refresh-pipeline':
      post({ type: 'refreshPipeline', pipelineId: pid, workspaceId: wsid, itemType: itype });
      showToast(`Refreshing "${pname}"…`, 'info');
      break;

    case 'fetch-history':
      post({ type: 'fetchPipelineHistory', pipelineId: pid, workspaceId: wsid, itemType: itype });
      break;

    case 'rerun':
      post({ type: 'rerunPipeline', pipelineId: pid, workspaceId: wsid, itemType: itype });
      showToast(itype === 'semanticModel' ? `Triggering refresh for "${pname}"…` : `Triggering "${pname}"…`, 'info');
      break;

    case 'copy':
      if (runId) post({ type: 'copyRunId', runId });
      break;

    case 'portal':
      post({ type: 'openInFabric', pipelineId: pid, workspaceId: wsid, tenantId: state.currentTenantId, itemType: itype });
      break;

    case 'history':
      post({ type: 'viewHistory', pipelineId: pid, workspaceId: wsid, pipelineName: pname, workspaceName: wname, itemType: itype });
      break;
  }
}

// ── Sort column headers ───────────────────────────────────────────────────────
function updateSortArrows() {
  document.querySelectorAll('th.sortable').forEach(th => {
    const arrow = /** @type {HTMLElement|null} */ (th.querySelector('.sort-arrow'));
    if (!arrow) return;
    const col = /** @type {HTMLElement} */ (th).dataset.col;
    arrow.textContent = col === sort.col ? (sort.dir === 1 ? '▾' : '▴') : '';
  });
}

document.querySelectorAll('.sortable').forEach(th => {
  th.addEventListener('click', () => {
    const col = /** @type {HTMLElement} */ (th).dataset.col ?? '';
    if (sort.col === col) {
      sort.dir *= -1;
    } else {
      sort.col = col;
      sort.dir = 1;
    }
    renderTable();
  });
});

// ── Toolbar event listeners ───────────────────────────────────────────────────
dom.tenantSelect.addEventListener('change', () => {
  post({ type: 'selectTenant', tenantId: dom.tenantSelect.value });
});

// ── Workspace slicer ──────────────────────────────────────────────────────────
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

  // Sort: favorites first, then alphabetical
  const sorted = state.workspaces.slice().sort((a, b) => {
    if (a.isFavorite && !b.isFavorite) return -1;
    if (!a.isFavorite && b.isFavorite) return 1;
    return a.displayName.localeCompare(b.displayName);
  });

  const filtered = lc
    ? sorted.filter(ws => ws.displayName.toLowerCase().includes(lc))
    : sorted;

  dom.wsPickerList.innerHTML = '';

  // "All workspaces" row
  const allLi = document.createElement('li');
  const allActive = !state.selectedWorkspaceId;
  allLi.className = 'ws-picker-item' + (allActive ? ' active' : '');
  allLi.innerHTML = `<span class="ws-picker-dot">${allActive ? '●' : ''}</span><span class="ws-picker-name">All workspaces</span>`;
  allLi.addEventListener('click', () => { closeWsPicker(); post({ type: 'selectWorkspace', workspaceId: '' }); });
  dom.wsPickerList.appendChild(allLi);

  filtered.forEach(ws => {
    const li = document.createElement('li');
    const active = ws.id === state.selectedWorkspaceId;
    li.className = 'ws-picker-item' + (active ? ' active' : '');
    li.innerHTML = `
      <span class="ws-picker-dot">${active ? '●' : ''}</span>
      <span class="ws-picker-name">${esc(ws.displayName)}</span>
      <button class="ws-star-btn ${ws.isFavorite ? 'starred' : ''}"
              data-wsid="${esc(ws.id)}"
              title="${ws.isFavorite ? 'Remove from favorites' : 'Pin workspace'}">${ws.isFavorite ? '★' : '☆'}</button>
      <button class="ws-blacklist-btn"
              data-wsid="${esc(ws.id)}" data-wsname="${esc(ws.displayName)}"
              title="Blacklist this workspace">⊘</button>`;

    li.querySelector('.ws-star-btn').addEventListener('click', (e) => {
      e.stopPropagation();
      const btn = /** @type {HTMLElement} */ (e.currentTarget);
      const wsId = btn.dataset.wsid ?? '';
      // Optimistic update
      const wsObj = state.workspaces.find(w => w.id === wsId);
      if (wsObj) wsObj.isFavorite = !wsObj.isFavorite;
      post({ type: 'toggleWorkspaceFavorite', workspaceId: wsId });
      renderWsPickerList(dom.wsPickerSearch.value.trim());
    });

    li.querySelector('.ws-blacklist-btn').addEventListener('click', (e) => {
      e.stopPropagation();
      const btn = /** @type {HTMLElement} */ (e.currentTarget);
      post({ type: 'blacklistWorkspace', workspaceId: btn.dataset.wsid ?? '', workspaceName: btn.dataset.wsname ?? '' });
    });

    li.addEventListener('click', () => { closeWsPicker(); post({ type: 'selectWorkspace', workspaceId: ws.id }); });
    dom.wsPickerList.appendChild(li);
  });
}

dom.wsPickerToggle.addEventListener('click', (e) => {
  e.stopPropagation();
  wsPickerOpen ? closeWsPicker() : openWsPicker();
});

dom.wsPickerSearch.addEventListener('input', () => {
  renderWsPickerList(dom.wsPickerSearch.value.trim());
});

// Close when clicking outside
document.addEventListener('click', (e) => {
  if (wsPickerOpen && !dom.wsPicker.contains(/** @type {Node} */ (e.target))) {
    closeWsPicker();
  }
});

let filterDebounce = 0;
dom.filterInput.addEventListener('input', () => {
  localFilter.text = dom.filterInput.value;
  dom.clearFilter.style.display = localFilter.text ? 'block' : 'none';
  clearTimeout(filterDebounce);
  filterDebounce = setTimeout(renderTable, 120);
});

dom.clearFilter.addEventListener('click', () => {
  localFilter.text = '';
  dom.filterInput.value = '';
  dom.clearFilter.style.display = 'none';
  renderTable();
});

dom.favoritesOnly.addEventListener('change', () => {
  localFilter.favoritesOnly = dom.favoritesOnly.checked;
  post({ type: 'setFavoritesOnly', enabled: dom.favoritesOnly.checked });
  renderTable();
});

dom.btnRefresh.addEventListener('click', () => {
  post({ type: 'refresh' });
});

dom.btnAddTenant.addEventListener('click', () => {
  post({ type: 'addTenant' });
});

$('btn-empty-add-tenant')?.addEventListener('click', () => {
  post({ type: 'addTenant' });
});

// ── Type filter buttons ───────────────────────────────────────────────────────
document.querySelectorAll('.type-filter-btn').forEach(btn => {
  btn.addEventListener('click', () => {
    const itype = /** @type {HTMLElement} */ (btn).dataset.itype ?? 'all';
    localFilter.itemType = itype;
    // Single-select: update active state
    document.querySelectorAll('.type-filter-btn').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    renderTable();
  });
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
    case 'Succeeded':  return 'succeeded';
    case 'Failed':     return 'failed';
    case 'InProgress': return 'inprogress';
    case 'Cancelled':  return 'cancelled';
    case 'Queued':     return 'queued';
    default:           return 'unknown';
  }
}

function formatRelative(/** @type {string} */ iso) {
  const diff = Date.now() - new Date(iso).getTime();
  const mins = Math.floor(diff / 60_000);
  if (mins < 1)  return 'just now';
  if (mins < 60) return `${mins}m ago`;
  const h = Math.floor(mins / 60);
  if (h < 24)    return `${h}h ago`;
  return `${Math.floor(h / 24)}d ago`;
}

function formatIn(/** @type {string} */ iso) {
  const diff = new Date(iso).getTime() - Date.now();
  if (diff <= 0) return 'now';
  const mins = Math.ceil(diff / 60_000);
  if (mins < 60) return `in ${mins}m`;
  const h = Math.floor(mins / 60);
  return `in ${h}h`;
}

function formatDuration(/** @type {number} */ ms) {
  const s = Math.round(ms / 1000);
  if (s < 60)    return `${s}s`;
  const m = Math.floor(s / 60);
  const r = s % 60;
  if (m < 60)    return `${m}m ${r}s`;
  return `${Math.floor(m / 60)}h ${m % 60}m`;
}

function esc(/** @type {string} */ s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;'); // prevent single-quote breakout in HTML attributes
}

// ── Status filter buttons ─────────────────────────────────────────────────────
document.querySelectorAll('.status-filter-btn').forEach(btn => {
  btn.addEventListener('click', () => {
    const status = /** @type {HTMLElement} */ (btn).dataset.status ?? '';
    if (localFilter.statusFilters.has(status)) {
      localFilter.statusFilters.delete(status);
      btn.classList.remove('active');
    } else {
      localFilter.statusFilters.add(status);
      btn.classList.add('active');
    }
    renderTable();
  });
});

// ── Bootstrap ─────────────────────────────────────────────────────────────────
post({ type: 'ready' });
