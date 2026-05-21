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
};

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
    case 'sizeComputed':
      computingSizes.delete(msg.schemaName ? `${msg.schemaName}.${msg.tableName}` : msg.tableName);
      renderTablesPanel();
      break;
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

    case 'copy-conn':
      post({ type: 'copyConnectionString', connectionString: btn.dataset.conn ?? '' });
      showToast('Connection string copied!', 'success');
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
    dom.tablesPanel.style.height = '';
    return;
  }

  dom.tablesPanel.classList.remove('hidden');
  dom.tablesSplitter.classList.remove('hidden');
  // Set a sensible default height if not already resized by user
  if (!dom.tablesPanel.style.height) {
    dom.tablesPanel.style.height = '40vh';
  }
  const lh = state.lakehouses.find(l => l.id === state.expandedLakehouseId);
  dom.tablesTitle.textContent = lh ? `Tables — ${lh.displayName}` : 'Tables';

  if (state.tables.length === 0 && !state.isLoading) {
    dom.tablesTbody.innerHTML = '';
    dom.noTables.classList.remove('hidden');
    return;
  }
  dom.noTables.classList.add('hidden');

  const html = state.tables.map(t => buildTableRow(t, state.expandedLakehouseId, lh?.workspaceId ?? '')).join('');
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
  const sizeCell = t.sizeBytes != null
    ? `<span title="${esc(String(t.sizeBytes))} bytes">${esc(formatBytes(t.sizeBytes))}</span>`
    : computingSizes.has(key)
      ? '<span class="muted">…</span>'
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

    const parts = ['Optimize'];
    if (vOrder) parts.push('V-Order');
    if (vacuum) parts.push('Vacuum');
    showToast(`${parts.join(' + ')} triggered for "${schemaName ? schemaName + '.' : ''}${tableName}"…`, 'info');
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

    const parts = ['Optimize'];
    if (vOrder) parts.push('V-Order');
    if (vacuum) parts.push('Vacuum');
    showToast(`${parts.join(' + ')} triggered for "${tableName}"…`, 'info');
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
    dom.tablesSplitter.classList.remove('active');
    document.body.style.cursor = '';
    document.body.style.userSelect = '';
  });
}

// ── Bootstrap ─────────────────────────────────────────────────────────────────
post({ type: 'ready' });
