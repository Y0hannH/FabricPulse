// @ts-check
/// <reference lib="dom" />
'use strict';

// ── VS Code API ───────────────────────────────────────────────────────────────
const vscode = acquireVsCodeApi();

// ── State ─────────────────────────────────────────────────────────────────────
/** @type {import('../models/types').LakehouseState} */
let state = {
  tenants: [],
  currentTenantId: '',
  workspaces: [],
  lakehouses: [],
  selectedWorkspaceId: '',
  expandedLakehouseId: '',
  tables: [],
  isLoading: false,
};

const localFilter = {
  text: '',
  favoritesOnly: false,
};

const sort = { col: 'name', dir: 1 };

/** Table keys (schema.name) whose on-disk size is currently being computed. */
const computingSizes = new Set();

/** Local filter for the tables panel. */
const tableFilter = { text: '' };

/** Overview state — set when overviewReady arrives. */
let overviewLhId = '';
let overviewTables = /** @type {any[]} */ ([]);
let overviewVisibleCount = 15;
let overviewComputing = false;
let overviewBatchDone = 0;
let overviewBatchTotal = 0;
let overviewSchemaFilter = '';
let overviewTableFilter  = '';
/** @type {Set<string>} Keys (schema.name or name) currently being size-refreshed. */
const overviewRefreshingKeys = new Set();
let overviewBulkMaintRunning = false;
let overviewBulkMaintDone = 0;
let overviewBulkMaintTotal = 0;
let overviewRenderScheduled = false;

/** User-resized height of the tables panel, kept across expand/collapse. */
let tablesPanelHeight = '40vh';

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
  btnRefresh:        $('btn-refresh'),
  loadingBar:        $('loading-bar'),
  toast:             $('toast'),
  emptyTenants:      $('empty-tenants'),
  tableWrap:         $('table-wrap'),
  tbody:             $('lakehouse-tbody'),
  noResults:         $('no-results'),
  tablesPanel:       $('tables-panel'),
  tablesTitle:       $('tables-title'),
  tablesTbody:       $('tables-tbody'),
  noTables:          $('no-tables'),
  btnCloseTables:    $('btn-close-tables'),
  tablesSplitter:    $('tables-splitter'),
  tablesFilter:      /** @type {HTMLInputElement}  */ ($('tables-filter')),
  clearTablesFilter: $('btn-clear-tables-filter'),
};

// ── Message bus ───────────────────────────────────────────────────────────────
window.addEventListener('message', (/** @type {MessageEvent} */ ev) => {
  const msg = ev.data;
  switch (msg.type) {
    case 'updateState': {
      // Clear table filter when a different lakehouse is expanded
      if (msg.state.expandedLakehouseId !== state.expandedLakehouseId) {
        tableFilter.text = '';
        dom.tablesFilter.value = '';
        dom.clearTablesFilter.style.display = 'none';
      }
      state = msg.state;
      render();
      break;
    }
    case 'toast':
      showToast(msg.message, msg.level ?? 'info');
      break;
    case 'sizeComputed':
      computingSizes.delete(msg.schemaName ? `${msg.schemaName}.${msg.tableName}` : msg.tableName);
      renderTablesPanel();
      break;
    case 'overviewReady':
      overviewLhId = msg.lakehouseId;
      overviewTables = msg.allTables;
      overviewVisibleCount = 15;
      overviewComputing = false;
      overviewBatchDone = 0;
      overviewBatchTotal = 0;
      overviewSchemaFilter = '';
      overviewTableFilter  = '';
      overviewRefreshingKeys.clear();
      overviewBulkMaintRunning = false;
      overviewBulkMaintDone = 0;
      overviewBulkMaintTotal = 0;
      renderOverviewModal();
      break;
    case 'overviewBatchProgress': {
      if (msg.tableKey) {
        const t = overviewTables.find(tb => tableKey(tb) === msg.tableKey);
        if (t && msg.sizeBytes >= 0) t.sizeBytes = msg.sizeBytes;
        overviewRefreshingKeys.delete(msg.tableKey);
      }
      overviewBatchDone = msg.done;
      overviewBatchTotal = msg.total;
      if (msg.cancelled || msg.done >= msg.total) overviewComputing = false;
      scheduleOverviewRender();
      break;
    }
    case 'bulkMaintenanceProgress': {
      overviewBulkMaintDone = msg.done;
      overviewBulkMaintTotal = msg.total;
      if (msg.done >= msg.total) overviewBulkMaintRunning = false;
      if (msg.tableKey && !msg.error) {
        const t = overviewTables.find(tb => tableKey(tb) === msg.tableKey);
        if (t) { t.maintenanceStatus = 'Optimize — InProgress'; t.lastMaintenanceAt = new Date().toISOString(); }
      }
      scheduleOverviewRender();
      break;
    }
  }
});

function post(/** @type {any} */ msg) {
  vscode.postMessage(msg);
}

// ── Render ────────────────────────────────────────────────────────────────────
function render() {
  dom.loadingBar.classList.toggle('hidden', !state.isLoading);
  renderToolbar();
  renderLakehouseTable();
  renderTablesPanel();
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

  // Workspace label
  const selWs = state.workspaces.find(w => w.id === state.selectedWorkspaceId);
  dom.wsPickerLabel.textContent = selWs ? selWs.displayName : 'All workspaces';

  dom.filterInput.value = localFilter.text;
  dom.favoritesOnly.checked = localFilter.favoritesOnly;
  dom.clearFilter.style.display = localFilter.text ? 'block' : 'none';
}

// ── Table filter ──────────────────────────────────────────────────────────────
function getVisibleTables() {
  if (!tableFilter.text) return state.tables;
  const needle = tableFilter.text.toLowerCase();
  return state.tables.filter(t => {
    const full = t.schema ? `${t.schema}.${t.name}` : t.name;
    return full.toLowerCase().includes(needle);
  });
}

// ── Filtering & sorting ───────────────────────────────────────────────────────
function getVisible() {
  let list = state.lakehouses.slice();

  if (localFilter.text) {
    const needle = localFilter.text.toLowerCase();
    list = list.filter(lh =>
      lh.displayName.toLowerCase().includes(needle) ||
      lh.workspaceName.toLowerCase().includes(needle)
    );
  }
  if (localFilter.favoritesOnly) {
    list = list.filter(lh => lh.isFavorite);
  }

  list.sort((a, b) => {
    switch (sort.col) {
      case 'name':      return a.displayName.localeCompare(b.displayName) * sort.dir;
      case 'workspace': return a.workspaceName.localeCompare(b.workspaceName) * sort.dir;
      default: return 0;
    }
  });

  return list;
}

// ── Lakehouse table rendering ─────────────────────────────────────────────────
function renderLakehouseTable() {
  updateSortArrows();

  if (state.tenants.length === 0) {
    dom.emptyTenants.classList.remove('hidden');
    dom.tableWrap.classList.add('hidden');
    return;
  }
  dom.emptyTenants.classList.add('hidden');
  dom.tableWrap.classList.remove('hidden');

  const visible = getVisible();

  if (visible.length === 0 && !state.isLoading) {
    dom.tbody.innerHTML = '';
    dom.noResults.classList.remove('hidden');
    return;
  }
  dom.noResults.classList.add('hidden');

  const newHtml = visible.map(buildLakehouseRow).join('');
  if (dom.tbody.innerHTML !== newHtml) {
    dom.tbody.innerHTML = newHtml;
    attachLakehouseListeners();
  }
}

function buildLakehouseRow(/** @type {any} */ lh) {
  const isExpanded = lh.id === state.expandedLakehouseId;
  const sqlStatusClass = lh.sqlEndpointStatus === 'Success' ? 'status-succeeded'
    : lh.sqlEndpointStatus === 'Failed' ? 'status-failed'
    : lh.sqlEndpointStatus === 'InProgress' ? 'status-inprogress'
    : 'muted';
  const sqlStatusLabel = lh.sqlEndpointStatus ?? '—';
  const connStr = lh.connectionString ?? '';
  const schemaBadge = lh.isSchemaEnabled
    ? `<span class="item-type-badge item-type-model" title="Schema-enabled (${esc(lh.defaultSchema || 'dbo')})">Schema</span>`
    : '';

  // Show cached table count even when collapsed
  const tableCount = isExpanded
    ? state.tables.length
    : (lh.tableCount != null ? lh.tableCount : null);

  const expandTitle = isExpanded ? 'Hide tables' : 'Show tables';
  const tablesLabel = tableCount != null
    ? `${tableCount} table${tableCount === 1 ? '' : 's'}`
    : 'Show tables';

  return `
<tr data-lhid="${esc(lh.id)}" data-wsid="${esc(lh.workspaceId)}" class="${isExpanded ? 'row-expanded' : ''}">
  <td class="col-star">
    <button class="star-btn ${lh.isFavorite ? 'starred' : ''}"
            data-action="star"
            title="${lh.isFavorite ? 'Remove from favorites' : 'Add to favorites'}">
      ${lh.isFavorite ? '★' : '☆'}
    </button>
  </td>
  <td class="col-name">
    <span class="pipeline-name" title="${esc(lh.displayName)}">${esc(lh.displayName)}</span>
    ${schemaBadge}
    ${lh.description ? `<span class="muted text-xs" title="${esc(lh.description)}"> — ${esc(truncate(lh.description, 50))}</span>` : ''}
  </td>
  <td class="col-workspace muted" title="${esc(lh.workspaceName)}">${esc(lh.workspaceName)}</td>
  <td class="col-sql-status">
    <span class="status-badge ${sqlStatusClass}">${esc(sqlStatusLabel)}</span>
  </td>
  <td class="col-tables-count">
    <button class="tables-toggle" data-action="expand" title="${expandTitle}">
      <span class="tables-toggle-chevron">${isExpanded ? '▾' : '▸'}</span>
      <span>${esc(tablesLabel)}</span>
    </button>
  </td>
  <td class="col-actions-lh">
    <div class="actions" style="opacity:1;position:static">
      <button class="action-btn" data-action="overview" title="Lakehouse overview — top tables, sizes, health">📊</button>
      ${lh.isSchemaEnabled ? `<button class="action-btn" data-action="manual-maint" data-schema="${esc(lh.defaultSchema || 'dbo')}" title="Run maintenance (manual table name)">🔧</button>` : ''}
      ${connStr ? `<button class="action-btn" data-action="copy-conn" data-conn="${esc(connStr)}" title="Copy SQL connection string">📋</button>` : ''}
      <button class="action-btn" data-action="portal" title="Open in Fabric portal">🔗</button>
    </div>
  </td>
</tr>`;
}

function attachLakehouseListeners() {
  dom.tbody.querySelectorAll('tr').forEach(row => {
    row.addEventListener('click', handleLakehouseClick);
  });
}

function handleLakehouseClick(/** @type {MouseEvent} */ e) {
  const target = /** @type {HTMLElement} */ (e.target);
  const btn = /** @type {HTMLElement|null} */ (target.closest('[data-action]'));
  if (!btn) return;
  const action = btn.dataset.action;

  const tr = /** @type {HTMLElement} */ (btn.closest('tr'));
  const lhid = tr.dataset.lhid ?? '';
  const wsid = tr.dataset.wsid ?? '';

  switch (action) {
    case 'star':
      post({ type: 'toggleFavorite', lakehouseId: lhid, workspaceId: wsid });
      btn.classList.toggle('starred');
      btn.textContent = btn.classList.contains('starred') ? '★' : '☆';
      break;

    case 'expand':
      post({ type: 'expandLakehouse', lakehouseId: lhid, workspaceId: wsid });
      break;

    case 'overview':
      openOverviewModal(lhid, wsid);
      break;

    case 'copy-conn':
      post({ type: 'copyConnectionString', connectionString: btn.dataset.conn ?? '' });
      break;

    case 'manual-maint':
      openManualMaintenanceModal(lhid, wsid, btn.dataset.schema ?? 'dbo');
      break;

    case 'portal':
      post({ type: 'openInFabric', lakehouseId: lhid, workspaceId: wsid, tenantId: state.currentTenantId });
      break;
  }
}

// ── Tables panel rendering ────────────────────────────────────────────────────
function renderTablesPanel() {
  if (!state.expandedLakehouseId) {
    dom.tablesPanel.classList.add('hidden');
    dom.tablesSplitter.classList.add('hidden');
    return;
  }

  dom.tablesPanel.classList.remove('hidden');
  dom.tablesSplitter.classList.remove('hidden');
  dom.tablesPanel.style.height = tablesPanelHeight;
  const lh = state.lakehouses.find(l => l.id === state.expandedLakehouseId);
  const total = state.tables.length;
  const visible = getVisibleTables();
  dom.tablesTitle.textContent = lh
    ? `Tables — ${lh.displayName}${tableFilter.text ? ` (${visible.length}/${total})` : ` (${total})`}`
    : 'Tables';

  if (state.tables.length === 0 && !state.isLoading) {
    dom.tablesTbody.innerHTML = '';
    dom.noTables.classList.remove('hidden');
    dom.noTables.textContent = 'No tables found in this lakehouse.';
    return;
  }
  if (visible.length === 0 && !state.isLoading) {
    dom.tablesTbody.innerHTML = '';
    dom.noTables.classList.remove('hidden');
    dom.noTables.textContent = 'No tables match the search.';
    return;
  }
  dom.noTables.classList.add('hidden');

  const html = visible.map(t => buildTableRow(t, state.expandedLakehouseId, lh?.workspaceId ?? '')).join('');
  if (dom.tablesTbody.innerHTML !== html) {
    dom.tablesTbody.innerHTML = html;
    attachTableListeners();
  }
}

function buildTableRow(/** @type {any} */ t, /** @type {string} */ lhid, /** @type {string} */ wsid) {
  const typeBadge = t.type === 'External'
    ? '<span class="item-type-badge item-type-model">External</span>'
    : '<span class="item-type-badge item-type-pipeline">Managed</span>';

  const maintDate = t.lastMaintenanceAt ? formatRelative(t.lastMaintenanceAt) : '—';
  const maintStatus = t.maintenanceStatus ?? '';
  // Color based on job status
  const maintClass = maintStatus.includes('Failed') ? 'status-failed'
    : maintStatus.includes('Completed') ? 'status-succeeded'
    : maintStatus.includes('InProgress') ? 'status-inprogress'
    : maintStatus.includes('Cancelled') ? 'muted'
    : maintStatus ? 'rate-mid' : '';

  const key = tableKey(t);
  const sizeCell = computingSizes.has(key)
    ? '<span class="muted">…</span>'
    : t.sizeBytes != null
      ? `<button class="size-btn" data-action="calc-size" title="${esc(String(t.sizeBytes))} bytes — click to recompute">${esc(formatBytes(t.sizeBytes))}</button>`
      : '<button class="action-btn" data-action="calc-size" title="Compute on-disk size">📐</button>';

  return `
<tr data-lhid="${esc(lhid)}" data-wsid="${esc(wsid)}" data-tname="${esc(t.name)}" data-schema="${esc(t.schema ?? '')}">
  <td class="col-tbl-name">
    ${t.schema ? `<span class="muted text-xs">${esc(t.schema)}.</span>` : ''}<span class="pipeline-name" title="${esc((t.schema ? t.schema + '.' : '') + t.name)}">${esc(t.name)}</span>
  </td>
  <td class="col-tbl-type">${typeBadge}</td>
  <td class="col-tbl-format muted">${esc(t.format)}</td>
  <td class="col-tbl-size">${sizeCell}</td>
  <td class="col-tbl-maint ${maintClass}" title="${esc(t.lastMaintenanceAt ?? '')}">
    ${maintDate !== '—' ? `${esc(maintDate)} <span class="muted text-xs">(${esc(maintStatus)})</span>` : '—'}
  </td>
  <td class="col-tbl-actions">
    <button class="action-btn" data-action="maintenance" title="Configure & run table maintenance">🔧</button>
  </td>
</tr>`;
}

function attachTableListeners() {
  dom.tablesTbody.querySelectorAll('tr').forEach(row => {
    row.addEventListener('click', (/** @type {MouseEvent} */ e) => {
      const target = /** @type {HTMLElement} */ (e.target);
      const btn = /** @type {HTMLElement|null} */ (target.closest('[data-action]'));
      if (!btn) return;
      const tr = /** @type {HTMLElement} */ (btn.closest('tr'));
      const lhid = tr.dataset.lhid ?? '';
      const wsid = tr.dataset.wsid ?? '';
      const tname = tr.dataset.tname ?? '';
      const schema = tr.dataset.schema ?? '';

      if (btn.dataset.action === 'maintenance') {
        openMaintenanceModal(lhid, wsid, tname, schema);
      } else if (btn.dataset.action === 'calc-size') {
        computingSizes.add(schema ? `${schema}.${tname}` : tname);
        post({
          type: 'computeTableSize',
          lakehouseId: lhid, workspaceId: wsid, tableName: tname,
          schemaName: schema || undefined,
        });
        renderTablesPanel();
      }
    });
  });
}

// ── Manual maintenance modal (schema-enabled lakehouses) ──────────────────────
function openManualMaintenanceModal(/** @type {string} */ lhid, /** @type {string} */ wsid, /** @type {string} */ defaultSchema) {
  const existing = document.getElementById('maint-overlay');
  if (existing) existing.remove();

  const lh = state.lakehouses.find(l => l.id === lhid);
  const lhName = lh ? lh.displayName : 'Lakehouse';

  const overlay = document.createElement('div');
  overlay.id = 'maint-overlay';
  overlay.className = 'modal-overlay';
  overlay.innerHTML = `
    <div class="modal" style="width:380px">
      <h3>🔧 Maintenance — ${esc(lhName)} <span class="item-type-badge item-type-model">Schema</span></h3>

      <label>Schema name</label>
      <input type="text" id="maint-schema" value="${esc(defaultSchema)}" placeholder="dbo" />

      <label>Table name</label>
      <input type="text" id="maint-tablename" value="" placeholder="my_table" autofocus />

      <div class="maint-option">
        <label class="maint-check-label">
          <input type="checkbox" id="maint-vorder" checked />
          <strong>V-Order</strong>
        </label>
        <span class="muted text-xs">Optimize read performance (bin compaction)</span>
      </div>

      <div class="maint-option">
        <label class="maint-check-label">
          <input type="checkbox" id="maint-vacuum" />
          <strong>Vacuum</strong>
        </label>
        <span class="muted text-xs">Remove unreferenced old files</span>
      </div>

      <div id="maint-vacuum-opts" class="hidden" style="margin-left:22px;margin-bottom:8px">
        <label>Retention <span class="muted text-xs">(days)</span></label>
        <input type="number" id="maint-retention-days" value="7" min="1" max="365" style="width:80px" />
      </div>

      <div class="modal-actions">
        <button class="btn btn-secondary" id="maint-cancel">Cancel</button>
        <button class="btn btn-primary" id="maint-run">Run Maintenance</button>
      </div>
    </div>
  `;

  document.body.appendChild(overlay);

  const vacuumCb = /** @type {HTMLInputElement} */ (document.getElementById('maint-vacuum'));
  const vacuumOpts = document.getElementById('maint-vacuum-opts');
  vacuumCb.addEventListener('change', () => {
    vacuumOpts.classList.toggle('hidden', !vacuumCb.checked);
  });

  overlay.addEventListener('click', (e) => { if (e.target === overlay) overlay.remove(); });
  document.getElementById('maint-cancel').addEventListener('click', () => overlay.remove());

  document.getElementById('maint-run').addEventListener('click', () => {
    const tableNameEl = /** @type {HTMLInputElement} */ (document.getElementById('maint-tablename'));
    const tableName = tableNameEl.value.trim();
    if (!tableName) {
      tableNameEl.style.borderColor = 'var(--vscode-inputValidation-errorBorder, #f44)';
      tableNameEl.focus();
      return;
    }

    const vOrder = /** @type {HTMLInputElement} */ (document.getElementById('maint-vorder')).checked;
    const vacuum = vacuumCb.checked;
    const daysEl = /** @type {HTMLInputElement|null} */ (document.getElementById('maint-retention-days'));
    const days = daysEl ? Math.max(1, Math.min(365, parseInt(daysEl.value, 10) || 7)) : 7;
    const vacuumRetention = vacuum ? `${days}:00:00:00` : undefined;
    const schemaName = /** @type {HTMLInputElement} */ (document.getElementById('maint-schema')).value.trim() || undefined;

    post({
      type: 'runMaintenance',
      lakehouseId: lhid,
      workspaceId: wsid,
      tableName,
      schemaName,
      vOrder,
      vacuum,
      vacuumRetention,
    });
    overlay.remove();
  });
}

// ── Maintenance config modal ──────────────────────────────────────────────────
function openMaintenanceModal(/** @type {string} */ lhid, /** @type {string} */ wsid, /** @type {string} */ tableName, /** @type {string} */ tableSchema = '') {
  // Check if lakehouse is schema-enabled
  const lh = state.lakehouses.find(l => l.id === lhid);
  const isSchema = !!tableSchema || (lh?.isSchemaEnabled ?? false);
  const defaultSchema = tableSchema || lh?.defaultSchema || 'dbo';

  // Remove any existing modal
  const existing = document.getElementById('maint-overlay');
  if (existing) existing.remove();

  const overlay = document.createElement('div');
  overlay.id = 'maint-overlay';
  overlay.className = 'modal-overlay';
  overlay.innerHTML = `
    <div class="modal" style="width:380px">
      <h3>🔧 Table Maintenance — ${esc(tableName)}</h3>

      ${isSchema ? `
      <label>Schema name</label>
      <input type="text" id="maint-schema" value="${esc(defaultSchema)}" placeholder="dbo" />
      ` : ''}

      <div class="maint-option">
        <label class="maint-check-label">
          <input type="checkbox" id="maint-vorder" checked />
          <strong>V-Order</strong>
        </label>
        <span class="muted text-xs">Optimize read performance (bin compaction)</span>
      </div>

      <div class="maint-option">
        <label class="maint-check-label">
          <input type="checkbox" id="maint-vacuum" />
          <strong>Vacuum</strong>
        </label>
        <span class="muted text-xs">Remove unreferenced old files</span>
      </div>

      <div id="maint-vacuum-opts" class="hidden" style="margin-left:22px;margin-bottom:8px">
        <label>Retention <span class="muted text-xs">(days)</span></label>
        <input type="number" id="maint-retention-days" value="7" min="1" max="365" style="width:80px" />
      </div>

      <div class="modal-actions">
        <button class="btn btn-secondary" id="maint-cancel">Cancel</button>
        <button class="btn btn-primary" id="maint-run">Run Maintenance</button>
      </div>
    </div>
  `;

  document.body.appendChild(overlay);

  // Toggle vacuum options
  const vacuumCb = /** @type {HTMLInputElement} */ (document.getElementById('maint-vacuum'));
  const vacuumOpts = document.getElementById('maint-vacuum-opts');
  vacuumCb.addEventListener('change', () => {
    vacuumOpts.classList.toggle('hidden', !vacuumCb.checked);
  });

  // Close on overlay click
  overlay.addEventListener('click', (e) => {
    if (e.target === overlay) overlay.remove();
  });

  document.getElementById('maint-cancel').addEventListener('click', () => overlay.remove());

  document.getElementById('maint-run').addEventListener('click', () => {
    const vOrder = /** @type {HTMLInputElement} */ (document.getElementById('maint-vorder')).checked;
    const vacuum = vacuumCb.checked;
    const daysEl = /** @type {HTMLInputElement|null} */ (document.getElementById('maint-retention-days'));
    const days = daysEl ? Math.max(1, Math.min(365, parseInt(daysEl.value, 10) || 7)) : 7;
    const vacuumRetention = vacuum ? `${days}:00:00:00` : undefined;
    const schemaEl = /** @type {HTMLInputElement|null} */ (document.getElementById('maint-schema'));
    const schemaName = schemaEl ? schemaEl.value.trim() : undefined;

    post({
      type: 'runMaintenance',
      lakehouseId: lhid,
      workspaceId: wsid,
      tableName,
      schemaName: schemaName || undefined,
      vOrder,
      vacuum,
      vacuumRetention: vacuumRetention || undefined,
    });
    overlay.remove();
  });
}

// ── Sort ──────────────────────────────────────────────────────────────────────
function updateSortArrows() {
  document.querySelectorAll('th.sortable').forEach(th => {
    const arrow = /** @type {HTMLElement|null} */ (th.querySelector('.sort-arrow'));
    if (!arrow) return;
    const col = /** @type {HTMLElement} */ (th).dataset.col;
    arrow.textContent = col === sort.col ? (sort.dir === 1 ? '▾' : '▴') : '';
  });
}

document.querySelectorAll('#lakehouse-table .sortable').forEach(th => {
  th.addEventListener('click', () => {
    const col = /** @type {HTMLElement} */ (th).dataset.col ?? '';
    if (sort.col === col) { sort.dir *= -1; } else { sort.col = col; sort.dir = 1; }
    renderLakehouseTable();
  });
});

// ── Workspace picker ──────────────────────────────────────────────────────────
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
  const filtered = lc ? sorted.filter(ws => ws.displayName.toLowerCase().includes(lc)) : sorted;

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
      <span class="ws-picker-name">${esc(ws.displayName)}</span>`;
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

document.addEventListener('click', (e) => {
  if (wsPickerOpen && !dom.wsPicker.contains(/** @type {Node} */ (e.target))) closeWsPicker();
});

// ── Toolbar events ────────────────────────────────────────────────────────────
dom.tenantSelect.addEventListener('change', () => {
  post({ type: 'selectTenant', tenantId: dom.tenantSelect.value });
});

let filterDebounce = 0;
dom.filterInput.addEventListener('input', () => {
  localFilter.text = dom.filterInput.value;
  dom.clearFilter.style.display = localFilter.text ? 'block' : 'none';
  clearTimeout(filterDebounce);
  filterDebounce = setTimeout(renderLakehouseTable, 120);
});

dom.clearFilter.addEventListener('click', () => {
  localFilter.text = '';
  dom.filterInput.value = '';
  dom.clearFilter.style.display = 'none';
  renderLakehouseTable();
});

dom.favoritesOnly.addEventListener('change', () => {
  localFilter.favoritesOnly = dom.favoritesOnly.checked;
  renderLakehouseTable();
});

dom.btnRefresh.addEventListener('click', () => post({ type: 'refresh' }));

dom.btnCloseTables.addEventListener('click', () => post({ type: 'collapseLakehouse' }));

// ── Tables filter events ──────────────────────────────────────────────────────
let tablesFilterDebounce = 0;
dom.tablesFilter.addEventListener('input', () => {
  tableFilter.text = dom.tablesFilter.value;
  dom.clearTablesFilter.style.display = tableFilter.text ? 'block' : 'none';
  clearTimeout(tablesFilterDebounce);
  tablesFilterDebounce = setTimeout(renderTablesPanel, 100);
});

dom.clearTablesFilter.addEventListener('click', () => {
  tableFilter.text = '';
  dom.tablesFilter.value = '';
  dom.clearTablesFilter.style.display = 'none';
  renderTablesPanel();
});

// ── Overview modal ────────────────────────────────────────────────────────────
function scheduleOverviewRender() {
  if (overviewRenderScheduled) return;
  overviewRenderScheduled = true;
  setTimeout(() => { overviewRenderScheduled = false; renderOverviewModal(); }, 120);
}

function injectOverviewStyles() {
  if (document.getElementById('overview-styles')) return;
  const style = document.createElement('style');
  style.id = 'overview-styles';
  style.textContent = `
.overview-modal {
  width: 720px; max-width: 94vw; max-height: 88vh;
  padding: 0; display: flex; flex-direction: column;
}
.overview-modal-header {
  display: flex; align-items: center; justify-content: space-between;
  padding: 14px 18px 10px; border-bottom: 1px solid var(--fp-border); flex-shrink: 0;
}
.overview-modal-header h3 { margin: 0; font-size: 14px; }
.overview-body { overflow-y: auto; flex: 1; padding: 0 0 8px; }
.overview-loading { padding: 24px; text-align: center; color: var(--vscode-descriptionForeground); font-size: 12px; }
.overview-stats {
  display: flex; gap: 12px; padding: 14px 18px 12px;
  flex-wrap: wrap; border-bottom: 1px solid var(--fp-border);
}
.stat-card {
  background: var(--fp-bg-alt, rgba(255,255,255,0.04));
  border: 1px solid var(--fp-border); border-radius: 6px;
  padding: 10px 16px; min-width: 110px; flex: 1;
}
.stat-value { font-size: 20px; font-weight: 600; color: var(--vscode-foreground); line-height: 1.2; }
.stat-label { font-size: 11px; color: var(--vscode-descriptionForeground); margin-top: 2px; }
.overview-section { padding: 12px 18px; border-bottom: 1px solid var(--fp-border); }
.overview-section:last-child { border-bottom: none; }
.overview-section-header {
  display: flex; align-items: center; justify-content: space-between;
  font-size: 12px; font-weight: 600; color: var(--vscode-foreground); margin-bottom: 8px;
}
.overview-table-wrap { max-height: 280px; overflow-y: auto; }
.overview-progress-bar { height: 4px; background: var(--fp-border); border-radius: 2px; overflow: hidden; margin-bottom: 4px; }
.overview-progress-fill { height: 100%; background: var(--fp-blue, #4d9ce6); transition: width 0.3s ease; }
.overview-health { display: flex; gap: 20px; flex-wrap: wrap; font-size: 12px; color: var(--vscode-foreground); }
.overview-schemas { display: flex; flex-wrap: wrap; gap: 6px; }
.schema-pill {
  background: var(--fp-bg-alt, rgba(255,255,255,0.05));
  border: 1px solid var(--fp-border); border-radius: 12px;
  padding: 2px 10px; font-size: 11px; color: var(--vscode-foreground);
  cursor: pointer; transition: border-color 0.15s, background 0.15s;
}
.schema-pill:hover { border-color: var(--fp-blue); }
.schema-pill-active { background: rgba(77,156,230,0.15); border-color: var(--fp-blue); color: var(--fp-blue); }
.overview-row-maint {
  opacity: 1 !important; font-size: 14px !important;
  color: var(--vscode-foreground) !important; cursor: pointer;
}
`;
  document.head.appendChild(style);
}

function openOverviewModal(/** @type {string} */ lhid, /** @type {string} */ wsid) {
  injectOverviewStyles();
  const existing = document.getElementById('overview-overlay');
  if (existing) existing.remove();

  const lh = state.lakehouses.find(l => l.id === lhid);
  const lhName = lh ? lh.displayName : lhid;

  const overlay = document.createElement('div');
  overlay.id = 'overview-overlay';
  overlay.className = 'modal-overlay';
  overlay.dataset.lhid = lhid;
  overlay.dataset.wsid = wsid;
  overlay.innerHTML =
    '<div class="modal overview-modal">' +
      '<div class="overview-modal-header">' +
        '<h3>📊 Overview — ' + esc(lhName) + '</h3>' +
        '<button class="btn-icon" id="overview-close">✕</button>' +
      '</div>' +
      '<div id="overview-body" class="overview-body">' +
        '<div class="overview-loading">Loading tables…</div>' +
      '</div>' +
    '</div>';

  document.body.appendChild(overlay);

  // Style the modal container inline (bypass VS Code webview CSS restrictions)
  const modalEl = /** @type {HTMLElement} */ (overlay.querySelector('.overview-modal'));
  if (modalEl) {
    modalEl.style.cssText = 'width:720px;max-width:94vw;max-height:88vh;padding:0;display:flex;flex-direction:column;overflow:hidden';
  }
  const headerEl = /** @type {HTMLElement} */ (overlay.querySelector('.overview-modal-header'));
  if (headerEl) {
    headerEl.style.cssText = 'display:flex;align-items:center;justify-content:space-between;padding:14px 18px 10px;border-bottom:1px solid #3c3c3c;flex-shrink:0';
  }
  const bodyEl = /** @type {HTMLElement} */ (overlay.querySelector('.overview-body'));
  if (bodyEl) {
    bodyEl.style.cssText = 'overflow-y:auto;flex:1;padding:0 0 8px';
  }

  overlay.addEventListener('click', e => { if (e.target === overlay) overlay.remove(); });
  document.getElementById('overview-close').addEventListener('click', () => overlay.remove());

  post({ type: 'openOverview', lakehouseId: lhid, workspaceId: wsid });
}

/**
 * Applies all overview-specific styles directly to DOM elements.
 * This bypasses stylesheet loading/caching issues in VS Code webviews.
 * @param {HTMLElement} body - The #overview-body element
 */
function _styleOverviewDOM(body) {
  if (!body) return;
  const S = {
    stats:       'display:flex;gap:12px;padding:14px 18px 12px;flex-wrap:wrap;border-bottom:1px solid #3c3c3c',
    card:        'background:rgba(255,255,255,0.05);border:1px solid #3c3c3c;border-radius:6px;padding:10px 16px;min-width:110px;flex:1',
    statValue:   'font-size:20px;font-weight:600;line-height:1.2',
    statLabel:   'font-size:11px;opacity:0.65;margin-top:2px',
    section:     'padding:12px 18px;border-bottom:1px solid #3c3c3c',
    secHeader:   'display:flex;align-items:center;justify-content:space-between;font-size:12px;font-weight:600;margin-bottom:8px',
    tblWrap:     'max-height:280px;overflow-y:auto',
    health:      'display:flex;gap:20px;flex-wrap:wrap;font-size:12px',
    schemas:     'display:flex;flex-wrap:wrap;gap:6px;margin-top:4px',
    pill:        'background:rgba(255,255,255,0.06);border:1px solid #3c3c3c;border-radius:12px;padding:2px 10px;font-size:11px;cursor:pointer;display:inline-block',
    pillActive:  'background:rgba(77,156,230,0.15);border:1px solid #4d9ce6;border-radius:12px;padding:2px 10px;font-size:11px;cursor:pointer;color:#4d9ce6;display:inline-block',
    maintBtn:    'background:none;border:none;font-size:15px;cursor:pointer;padding:2px 5px;opacity:1;line-height:1',
    badgeManaged:'display:inline-block;padding:1px 6px;border-radius:3px;font-size:10px;font-weight:600;background:rgba(77,156,230,0.15);color:#4d9ce6',
    badgeExt:    'display:inline-block;padding:1px 6px;border-radius:3px;font-size:10px;font-weight:600;background:rgba(177,128,215,0.15);color:#b180d7',
    progressBar: 'height:4px;background:#3c3c3c;border-radius:2px;overflow:hidden;margin-bottom:4px',
    progressFill:'height:100%;background:#4d9ce6;transition:width 0.3s ease',
  };

  const q  = (sel) => body.querySelector(sel);
  const qa = (sel) => body.querySelectorAll(sel);

  const stats = q('.overview-stats');
  if (stats) stats.style.cssText = S.stats;

  qa('.stat-card').forEach(el => { el.style.cssText = S.card; });
  qa('.stat-value').forEach(el => { el.style.cssText = S.statValue; });
  qa('.stat-label').forEach(el => { el.style.cssText = S.statLabel; });

  qa('.overview-section').forEach(el => { el.style.cssText = S.section; });
  qa('.overview-section-header').forEach(el => { el.style.cssText = S.secHeader; });

  const tblWrap = q('.overview-table-wrap');
  if (tblWrap) tblWrap.style.cssText = S.tblWrap;

  const health = q('.overview-health');
  if (health) health.style.cssText = S.health;

  const schemas = q('.overview-schemas');
  if (schemas) schemas.style.cssText = S.schemas;

  qa('.schema-pill').forEach(el => {
    el.style.cssText = el.classList.contains('schema-pill-active') ? S.pillActive : S.pill;
  });

  qa('.overview-row-maint').forEach(el => { el.style.cssText = S.maintBtn; });

  qa('.item-type-badge').forEach(el => {
    el.style.cssText = el.classList.contains('item-type-model') ? S.badgeExt : S.badgeManaged;
  });

  const bar = q('.overview-progress-bar');
  if (bar) {
    bar.style.cssText = S.progressBar;
    const fill = bar.querySelector('.overview-progress-fill');
    if (fill) fill.style.cssText = S.progressFill + ';width:' + (fill.style.width || '0%');
  }
}

function renderOverviewModal() {
  const overlay = /** @type {HTMLElement|null} */ (document.getElementById('overview-overlay'));
  if (!overlay) return;
  const body = document.getElementById('overview-body');
  if (!body) return;

  const lhid = overlay.dataset.lhid ?? '';
  const wsid  = overlay.dataset.wsid  ?? '';
  const lh = state.lakehouses.find(l => l.id === lhid);

  // ── Schema list ─────────────────────────────────────────────────────────────
  const allSchemas = /** @type {string[]} */ (
    [...new Set(overviewTables.map(t => t.schema).filter(s => s != null && s !== ''))].sort()
  );
  const hasSchemas = allSchemas.length > 1;

  // Tables scoped to selected schema
  const schemaFiltered = overviewSchemaFilter
    ? overviewTables.filter(t => t.schema === overviewSchemaFilter)
    : overviewTables;

  const allMeasured     = overviewTables.filter(t => t.sizeBytes != null && t.sizeBytes >= 0);
  const measuredPct     = overviewTables.length > 0 ? Math.round(allMeasured.length / overviewTables.length * 100) : 0;
  const totalKnownBytes = allMeasured.reduce((s, t) => s + (t.sizeBytes ?? 0), 0);
  const managedCount    = overviewTables.filter(t => (t.type ?? 'Managed') === 'Managed').length;
  const externalCount   = overviewTables.filter(t => t.type === 'External').length;

  const unmeasuredInScope  = schemaFiltered.filter(t => t.sizeBytes == null);
  const measuredInScope    = schemaFiltered.filter(t => t.sizeBytes != null && t.sizeBytes >= 0);
  const sortedBySize       = measuredInScope.slice().sort((a, b) => (b.sizeBytes ?? 0) - (a.sizeBytes ?? 0));

  // Apply name filter to the measured rows only (stats and Analyze button are unaffected)
  const nameFilterLower    = overviewTableFilter.toLowerCase();
  const nameFiltered       = overviewTableFilter
    ? sortedBySize.filter(t => ((t.schema ? t.schema + '.' : '') + t.name).toLowerCase().includes(nameFilterLower))
    : sortedBySize;
  const visibleRows        = nameFiltered.slice(0, overviewVisibleCount);
  const hasMoreMeasured    = nameFiltered.length > overviewVisibleCount;

  // Maintenance health (all tables)
  const maintCompleted  = overviewTables.filter(t => t.maintenanceStatus?.includes('Completed')).length;
  const maintFailed     = overviewTables.filter(t => t.maintenanceStatus?.includes('Failed')).length;
  const maintInProgress = overviewTables.filter(t => t.maintenanceStatus?.includes('InProgress')).length;
  const maintNever      = overviewTables.filter(t => !t.maintenanceStatus).length;

  // Schema breakdown
  /** @type {Map<string, number>} */
  const schemaMap = new Map();
  if (lh?.isSchemaEnabled) {
    for (const t of overviewTables) {
      const s = t.schema ?? 'unknown';
      schemaMap.set(s, (schemaMap.get(s) ?? 0) + 1);
    }
  }
  const schemaEntries = [...schemaMap.entries()].sort((a, b) => b[1] - a[1]);

  // ── Controls ─────────────────────────────────────────────────────────────────
  const schemaDropdown = hasSchemas
    ? '<select id="overview-schema-select" class="select" style="height:26px;font-size:12px">' +
        '<option value="">All schemas</option>' +
        allSchemas.map(s =>
          '<option value="' + esc(s) + '"' + (overviewSchemaFilter === s ? ' selected' : '') + '>' + esc(s) + '</option>'
        ).join('') +
      '</select>'
    : '';

  const scopeLabel = overviewSchemaFilter
    ? esc(overviewSchemaFilter) + ' (' + unmeasuredInScope.length + ' unmeasured)'
    : 'all (' + unmeasuredInScope.length + ' unmeasured)';

  const analyzeBtn = !overviewComputing && unmeasuredInScope.length > 0
    ? '<button class="btn btn-primary" id="overview-analyze" style="font-size:11px">📐 Analyze ' + scopeLabel + '</button>'
    : '';
  const cancelBtn = overviewComputing
    ? '<button class="btn btn-secondary" id="overview-cancel" style="font-size:11px">■ Cancel</button>'
    : '';

  const progressBar = overviewComputing
    ? '<div class="overview-progress-bar" style="margin-top:8px"><div class="overview-progress-fill" style="width:' +
        (overviewBatchTotal > 0 ? Math.round(overviewBatchDone / overviewBatchTotal * 100) : 0) +
        '%"></div></div>' +
      '<div class="muted text-xs" style="margin:4px 0 2px">Computing… ' + overviewBatchDone + ' / ' + overviewBatchTotal +
        (overviewBatchDone > 0 ? ' — ranking updates live' : '') + '</div>'
    : (unmeasuredInScope.length > 0 && allMeasured.length === 0
        ? '<div class="muted text-xs" style="margin-top:6px">Click "Analyze" to compute all sizes and get the true ranking.</div>'
        : '');

  // ── Top-N rows ────────────────────────────────────────────────────────────────
  const maintAllBtn = visibleRows.length > 0 && !overviewBulkMaintRunning
    ? '<button class="btn btn-secondary" id="overview-maint-all" style="font-size:11px">🔧 Maintain all ' + visibleRows.length + '</button>'
    : overviewBulkMaintRunning
      ? '<span class="muted text-xs">Triggering… ' + overviewBulkMaintDone + '/' + overviewBulkMaintTotal + '</span>'
      : '';

  const tableRowsHtml = visibleRows.length === 0
    ? '<tr><td colspan="6" class="muted" style="padding:14px;text-align:center">' +
        (overviewTableFilter && sortedBySize.length > 0
          ? 'No measured tables match "' + esc(overviewTableFilter) + '".'
          : overviewComputing ? 'Computing — first results will appear shortly…' : 'No sizes computed yet — click Analyze to start.') +
      '</td></tr>'
    : visibleRows.map((t, i) => {
        const typeVal   = t.type ?? 'Managed';
        const typeBadge = typeVal === 'External'
          ? '<span class="item-type-badge item-type-model">External</span>'
          : '<span class="item-type-badge item-type-pipeline">Managed</span>';
        const nameHtml  = t.schema
          ? '<span class="muted text-xs">' + esc(t.schema) + '.</span>' + esc(t.name)
          : esc(t.name);
        const maintClass = t.maintenanceStatus
          ? (t.maintenanceStatus.includes('Failed')     ? 'status-failed'
           : t.maintenanceStatus.includes('Completed')  ? 'status-succeeded'
           : t.maintenanceStatus.includes('InProgress') ? 'status-inprogress' : '')
          : '';
        const maintLabel = t.lastMaintenanceAt ? formatRelative(t.lastMaintenanceAt) : '—';
        const shortStatus = t.maintenanceStatus
          ? ' <span class="muted text-xs">(' + esc(t.maintenanceStatus.split(' — ')[0]) + ')</span>'
          : '';
        const tkey = t.schema ? t.schema + '.' + t.name : t.name;
        const isRefreshing = overviewRefreshingKeys.has(tkey);
        const refreshBtn = isRefreshing
          ? '<span class="muted text-xs" style="margin-left:4px">⏳</span>'
          : '<button class="action-btn overview-row-refresh" data-tname="' + esc(t.name) + '" data-tschema="' + esc(t.schema ?? '') + '"' +
              ' title="Refresh size" style="opacity:1;font-size:12px;padding:0 2px;margin-left:3px">↻</button>';
        return '<tr data-tname="' + esc(t.name) + '" data-tschema="' + esc(t.schema ?? '') + '">' +
          '<td class="muted text-xs" style="width:28px;text-align:right">' + (i + 1) + '</td>' +
          '<td style="max-width:200px"><span class="pipeline-name" title="' + esc((t.schema ? t.schema + '.' : '') + t.name) + '">' + nameHtml + '</span></td>' +
          '<td style="width:90px">' + typeBadge + '</td>' +
          '<td style="width:96px;white-space:nowrap"><span style="font-weight:600">' + esc(formatBytes(t.sizeBytes ?? 0)) + '</span>' + refreshBtn + '</td>' +
          '<td class="' + maintClass + '" style="width:120px;font-size:11px">' + esc(maintLabel) + shortStatus + '</td>' +
          '<td style="width:36px"><button class="action-btn overview-row-maint" title="Run maintenance on this table">🔧</button></td>' +
        '</tr>';
      }).join('');

  const showMoreBtn = hasMoreMeasured
    ? '<button class="btn btn-secondary" id="overview-show-more" style="margin:6px 0;font-size:11px">Show ' + Math.min(15, sortedBySize.length - overviewVisibleCount) + ' more ↓</button>'
    : unmeasuredInScope.length > 0 && !overviewComputing
      ? '<div class="muted text-xs" style="padding:6px 0">' + unmeasuredInScope.length + ' tables not yet measured — "Analyze" for the complete ranking.</div>'
      : '';

  // ── Schema breakdown pills ────────────────────────────────────────────────────
  const schemaSection = schemaEntries.length > 0
    ? '<div class="overview-section">' +
        '<div class="overview-section-header">Schema breakdown</div>' +
        '<div class="overview-schemas">' +
          schemaEntries.map(([s, n]) =>
            '<span class="schema-pill' + (overviewSchemaFilter === s ? ' schema-pill-active' : '') +
            '" data-schema="' + esc(s) + '" title="Click to filter"><strong>' + esc(s) + '</strong> ' + n + '</span>'
          ).join('') +
        '</div>' +
      '</div>'
    : '';

  // ── Assemble ─────────────────────────────────────────────────────────────────
  body.innerHTML =
    '<div class="overview-stats">' +
      '<div class="stat-card"><div class="stat-value">' + overviewTables.length + '</div><div class="stat-label">Tables</div></div>' +
      '<div class="stat-card"><div class="stat-value">' + allMeasured.length +
        ' <span class="muted text-xs">(' + measuredPct + '%)</span></div><div class="stat-label">Measured</div></div>' +
      '<div class="stat-card"><div class="stat-value">' + esc(formatBytes(totalKnownBytes)) + '</div><div class="stat-label">Known size</div></div>' +
      (managedCount || externalCount
        ? '<div class="stat-card"><div class="stat-value">' + managedCount + ' / ' + externalCount + '</div><div class="stat-label">Managed / Ext.</div></div>'
        : '') +
    '</div>' +

    '<div class="overview-section">' +
      '<div class="overview-section-header"><span>Storage analysis</span>' +
        '<div style="display:flex;align-items:center;gap:6px">' + schemaDropdown + analyzeBtn + cancelBtn + '</div>' +
      '</div>' +
      progressBar +
    '</div>' +

    '<div class="overview-section">' +
      '<div class="overview-section-header">' +
        '<span>Largest tables' + (overviewSchemaFilter ? ' — ' + esc(overviewSchemaFilter) : '') + '</span>' +
        '<div style="display:flex;align-items:center;gap:8px">' +
          '<input type="text" id="overview-table-filter" class="input" placeholder="Filter tables…"' +
            ' value="' + esc(overviewTableFilter) + '" autocomplete="off"' +
            ' style="height:24px;font-size:11px;width:140px;flex-shrink:0" />' +
          maintAllBtn +
        '</div>' +
      '</div>' +
      '<div class="overview-table-wrap">' +
        '<table class="pipeline-table">' +
          '<thead><tr>' +
            '<th style="width:28px">#</th>' +
            '<th>Table</th>' +
            '<th style="width:90px">Type</th>' +
            '<th style="width:80px">Size</th>' +
            '<th style="width:120px">Last maint.</th>' +
            '<th style="width:36px"></th>' +
          '</tr></thead>' +
          '<tbody>' + tableRowsHtml + '</tbody>' +
        '</table>' +
      '</div>' +
      showMoreBtn +
    '</div>' +

    '<div class="overview-section">' +
      '<div class="overview-section-header">Maintenance health</div>' +
      '<div class="overview-health">' +
        '<span>✅ Optimized <strong>' + maintCompleted + '</strong></span>' +
        '<span>🔄 In progress <strong>' + maintInProgress + '</strong></span>' +
        '<span>❌ Failed <strong>' + maintFailed + '</strong></span>' +
        '<span>⚪ Never <strong>' + maintNever + '</strong></span>' +
      '</div>' +
    '</div>' +

    schemaSection;

  // ── Apply inline styles (bypass CSS loading issues in VS Code webview) ────────
  _styleOverviewDOM(body);

  // ── Event listeners ──────────────────────────────────────────────────────────

  document.getElementById('overview-table-filter')?.addEventListener('input', function () {
    overviewTableFilter  = /** @type {HTMLInputElement} */ (this).value;
    overviewVisibleCount = 15;
    renderOverviewModal();
  });

  document.getElementById('overview-schema-select')?.addEventListener('change', function () {
    overviewSchemaFilter = /** @type {HTMLSelectElement} */ (this).value;
    overviewTableFilter  = '';
    overviewVisibleCount = 15;
    renderOverviewModal();
  });

  body.querySelectorAll('.schema-pill[data-schema]').forEach(pill => {
    pill.addEventListener('click', () => {
      const s = /** @type {HTMLElement} */ (pill).dataset.schema ?? '';
      overviewSchemaFilter = overviewSchemaFilter === s ? '' : s;
      overviewTableFilter  = '';
      overviewVisibleCount = 15;
      renderOverviewModal();
    });
  });

  document.getElementById('overview-analyze')?.addEventListener('click', () => {
    overviewComputing    = true;
    overviewBatchDone    = 0;
    overviewBatchTotal   = unmeasuredInScope.length;
    renderOverviewModal();
    post({
      type: 'computeOverviewBatch',
      lakehouseId: lhid,
      workspaceId: wsid,
      tables: unmeasuredInScope.map(t => ({ name: t.name, schema: t.schema })),
    });
  });

  document.getElementById('overview-cancel')?.addEventListener('click', () => {
    post({ type: 'cancelOverviewBatch' });
    overviewComputing = false;
    renderOverviewModal();
  });

  document.getElementById('overview-show-more')?.addEventListener('click', () => {
    overviewVisibleCount += 15;
    renderOverviewModal();
  });

  body.querySelectorAll('.overview-row-maint').forEach(btn => {
    btn.addEventListener('click', () => {
      const tr     = /** @type {HTMLElement} */ (btn.closest('tr'));
      const tname  = tr?.dataset.tname   ?? '';
      const schema = tr?.dataset.tschema ?? '';
      openMaintenanceModal(lhid, wsid, tname, schema);
    });
  });

  body.querySelectorAll('.overview-row-refresh').forEach(btn => {
    btn.addEventListener('click', () => {
      const el     = /** @type {HTMLElement} */ (btn);
      const tname  = el.dataset.tname  ?? '';
      const tschema = el.dataset.tschema ?? '';
      const key    = tschema ? tschema + '.' + tname : tname;
      overviewRefreshingKeys.add(key);
      renderOverviewModal();
      post({
        type: 'computeOverviewBatch',
        lakehouseId: lhid,
        workspaceId: wsid,
        tables: [{ name: tname, schema: tschema || undefined }],
      });
    });
  });

  document.getElementById('overview-maint-all')?.addEventListener('click', () => {
    openBulkMaintenanceDialog(lhid, wsid, visibleRows);
  });
}

function openBulkMaintenanceDialog(
  /** @type {string} */ lhid,
  /** @type {string} */ wsid,
  /** @type {any[]}   */ tables,
) {
  const existing = document.getElementById('bulk-maint-overlay');
  if (existing) existing.remove();

  const overlay = document.createElement('div');
  overlay.id = 'bulk-maint-overlay';
  overlay.className = 'modal-overlay';
  overlay.style.zIndex = '1100';
  overlay.innerHTML =
    '<div class="modal" style="width:400px">' +
      '<h3>🔧 Bulk Maintenance — ' + tables.length + ' tables</h3>' +
      '<p class="muted text-xs" style="margin-bottom:12px">Maintenance will be triggered sequentially on the ' + tables.length + ' largest measured tables.</p>' +
      '<div class="maint-option">' +
        '<label class="maint-check-label"><input type="checkbox" id="bulk-vorder" checked /><strong>V-Order</strong></label>' +
        '<span class="muted text-xs">Optimize read performance (bin compaction)</span>' +
      '</div>' +
      '<div class="maint-option">' +
        '<label class="maint-check-label"><input type="checkbox" id="bulk-vacuum" /><strong>Vacuum</strong></label>' +
        '<span class="muted text-xs">Remove unreferenced old files</span>' +
      '</div>' +
      '<div id="bulk-vacuum-opts" class="hidden" style="margin-left:22px;margin-bottom:8px">' +
        '<label>Retention <span class="muted text-xs">(days)</span></label>' +
        '<input type="number" id="bulk-retention-days" value="7" min="1" max="365" style="width:80px" />' +
      '</div>' +
      '<div class="modal-actions">' +
        '<button class="btn btn-secondary" id="bulk-cancel">Cancel</button>' +
        '<button class="btn btn-primary" id="bulk-run">Run on ' + tables.length + ' tables</button>' +
      '</div>' +
    '</div>';

  document.body.appendChild(overlay);

  const vacuumCb   = /** @type {HTMLInputElement} */ (document.getElementById('bulk-vacuum'));
  const vacuumOpts = document.getElementById('bulk-vacuum-opts');
  vacuumCb.addEventListener('change', () => vacuumOpts.classList.toggle('hidden', !vacuumCb.checked));

  overlay.addEventListener('click', e => { if (e.target === overlay) overlay.remove(); });
  document.getElementById('bulk-cancel').addEventListener('click', () => overlay.remove());

  document.getElementById('bulk-run').addEventListener('click', () => {
    const vOrder = /** @type {HTMLInputElement} */ (document.getElementById('bulk-vorder')).checked;
    const vacuum = vacuumCb.checked;
    const daysEl = /** @type {HTMLInputElement|null} */ (document.getElementById('bulk-retention-days'));
    const days   = daysEl ? Math.max(1, Math.min(365, parseInt(daysEl.value, 10) || 7)) : 7;
    const vacuumRetention = vacuum ? days + ':00:00:00' : undefined;

    overviewBulkMaintRunning = true;
    overviewBulkMaintDone    = 0;
    overviewBulkMaintTotal   = tables.length;
    renderOverviewModal();
    overlay.remove();

    post({
      type: 'runBulkMaintenance',
      lakehouseId: lhid,
      workspaceId: wsid,
      tables: tables.map(t => ({ name: t.name, schema: t.schema })),
      vOrder,
      vacuum,
      vacuumRetention,
    });
  });
}

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
function formatRelative(/** @type {string} */ iso) {
  const diff = Date.now() - new Date(iso).getTime();
  const mins = Math.floor(diff / 60_000);
  if (mins < 1)  return 'just now';
  if (mins < 60) return `${mins}m ago`;
  const h = Math.floor(mins / 60);
  if (h < 24)    return `${h}h ago`;
  const d = Math.floor(h / 24);
  if (d < 30)    return `${d}d ago`;
  return `${Math.floor(d / 30)}mo ago`;
}

function truncate(/** @type {string} */ s, /** @type {number} */ max) {
  return s.length > max ? s.slice(0, max) + '…' : s;
}

function tableKey(/** @type {any} */ t) {
  return t.schema ? `${t.schema}.${t.name}` : t.name;
}

function formatBytes(/** @type {number} */ n) {
  if (!Number.isFinite(n) || n < 0) return '—';
  if (n < 1024) return `${n} B`;
  const units = ['KB', 'MB', 'GB', 'TB'];
  let v = n / 1024;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) { v /= 1024; i++; }
  return `${v < 10 ? v.toFixed(1) : Math.round(v)} ${units[i]}`;
}

function esc(/** @type {string} */ s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

// ── Splitter drag-to-resize ────────────────────────────────────────────────────
{
  let dragging = false;
  let startY = 0;
  let startH = 0;

  dom.tablesSplitter.addEventListener('mousedown', (/** @type {MouseEvent} */ e) => {
    e.preventDefault();
    dragging = true;
    startY = e.clientY;
    startH = dom.tablesPanel.offsetHeight;
    dom.tablesSplitter.classList.add('active');
    document.body.style.cursor = 'row-resize';
    document.body.style.userSelect = 'none';
  });

  document.addEventListener('mousemove', (/** @type {MouseEvent} */ e) => {
    if (!dragging) return;
    const delta = startY - e.clientY; // dragging up = bigger panel
    const newH = Math.max(80, Math.min(window.innerHeight * 0.8, startH + delta));
    dom.tablesPanel.style.height = newH + 'px';
  });

  document.addEventListener('mouseup', () => {
    if (!dragging) return;
    dragging = false;
    tablesPanelHeight = dom.tablesPanel.style.height || tablesPanelHeight;
    dom.tablesSplitter.classList.remove('active');
    document.body.style.cursor = '';
    document.body.style.userSelect = '';
  });
}

// ── Bootstrap ─────────────────────────────────────────────────────────────────
post({ type: 'ready' });
