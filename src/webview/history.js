// @ts-check
'use strict';

const vscode = acquireVsCodeApi();

// ── State ─────────────────────────────────────────────────────────────────────
/** @type {import('../models/types').HistoryData|null} */
let data = null;

// ── DOM ───────────────────────────────────────────────────────────────────────
const $ = (/** @type {string} */ id) => /** @type {HTMLElement} */ (document.getElementById(id));

const dom = {
  title:        $('pipeline-title'),
  statRate:     $('stat-rate'),
  statTotal:    $('stat-total'),
  statPeriod:   $('stat-period'),
  periodBtns:   /** @type {NodeListOf<HTMLElement>} */ (document.querySelectorAll('.period-btn')),
  toast:        $('toast'),
  canvas:       /** @type {HTMLCanvasElement} */ ($('duration-chart')),
  patternsSection: $('patterns-section'),
  runsTbody:    $('runs-tbody'),
  noRuns:       $('no-runs'),
  annSection:   $('annotations-section'),
  annList:      $('annotations-list'),
  exportLabel:  $('export-label'),
  btnCsv:       $('btn-export-csv'),
  btnJson:      $('btn-export-json'),
  btnAddNote:   $('btn-add-note'),
  modalOverlay: $('modal-overlay'),
  modalDate:    /** @type {HTMLInputElement}  */ ($('modal-date')),
  modalNote:    /** @type {HTMLTextAreaElement} */ ($('modal-note')),
  modalCancel:  $('modal-cancel'),
  modalSave:    $('modal-save'),
};

// ── Messages ──────────────────────────────────────────────────────────────────
window.addEventListener('message', (/** @type {MessageEvent} */ ev) => {
  const msg = ev.data;
  if (msg.type === 'historyData') {
    data = msg.data;
    render();
  } else if (msg.type === 'toast') {
    showToast(msg.message, msg.level ?? 'info');
  }
});

function post(/** @type {any} */ msg) { vscode.postMessage(msg); }

// ── Render ────────────────────────────────────────────────────────────────────
function render() {
  if (!data) return;

  // Header
  dom.title.textContent = `📊 ${data.pipeline.displayName} — ${data.pipeline.workspaceName}`;
  dom.statRate.textContent = `${data.successRate}%`;
  dom.statTotal.textContent = String(data.totalRuns);

  const periodLabel = { '7d': '7 days', '30d': '30 days', '90d': '90 days', 'all': 'all time' };
  dom.statPeriod.textContent = periodLabel[data.period] ?? '';

  // Period buttons
  dom.periodBtns.forEach(btn => {
    btn.classList.toggle('active', btn.dataset.period === data.period);
  });

  // Chart
  drawChart(data.runs);

  // Patterns
  renderPatterns(data.patterns);

  // Table
  renderRunsTable(data.runs);

  // Annotations
  renderAnnotations(data.annotations);
}

// ── Chart (native canvas 2D) ──────────────────────────────────────────────────
function drawChart(/** @type {any[]} */ runs) {
  const canvas = dom.canvas;
  const dpr = window.devicePixelRatio || 1;

  // Size canvas to its CSS display size
  const rect = canvas.getBoundingClientRect();
  const W = rect.width  || canvas.parentElement?.clientWidth || 600;
  const H = 160;

  canvas.width  = W * dpr;
  canvas.height = H * dpr;
  canvas.style.width  = W + 'px';
  canvas.style.height = H + 'px';

  const ctx = canvas.getContext('2d');
  if (!ctx) return;
  ctx.scale(dpr, dpr);
  ctx.clearRect(0, 0, W, H);

  const PAD = { top: 16, right: 16, bottom: 32, left: 52 };
  const cW = W - PAD.left - PAD.right;
  const cH = H - PAD.top  - PAD.bottom;

  // Only runs with a measured duration
  const valid = runs
    .filter(r => r.durationMs != null)
    .sort((a, b) => new Date(a.startTime).getTime() - new Date(b.startTime).getTime());

  // CSS variables
  const fgColor   = getCssVar('--vscode-foreground',             '#cccccc');
  const mutedColor= getCssVar('--vscode-descriptionForeground',  '#888888');
  const gridColor = 'rgba(255,255,255,0.06)';

  if (valid.length === 0) {
    ctx.fillStyle = mutedColor;
    ctx.font = '11px sans-serif';
    ctx.textAlign = 'center';
    ctx.fillText('No duration data for the selected period', W / 2, H / 2);
    return;
  }

  const maxMs   = Math.max(...valid.map(r => r.durationMs));
  const minTime = new Date(valid[0].startTime).getTime();
  const maxTime = new Date(valid[valid.length - 1].startTime).getTime();
  const timeSpan = maxTime - minTime || 1;

  const mapX = (/** @type {string} */ iso) =>
    PAD.left + ((new Date(iso).getTime() - minTime) / timeSpan) * cW;
  const mapY = (/** @type {number} */ ms) =>
    PAD.top + cH - (ms / maxMs) * cH;

  // ── Grid lines (horizontal) ──────────────────────────────────────────────
  const gridCount = 4;
  ctx.strokeStyle = gridColor;
  ctx.lineWidth = 1;

  for (let i = 0; i <= gridCount; i++) {
    const y = PAD.top + (i / gridCount) * cH;
    ctx.beginPath();
    ctx.moveTo(PAD.left, y);
    ctx.lineTo(PAD.left + cW, y);
    ctx.stroke();

    // Y-axis label
    const val = maxMs * (1 - i / gridCount);
    ctx.fillStyle = mutedColor;
    ctx.font = '9px monospace';
    ctx.textAlign = 'right';
    ctx.fillText(fmtDur(val), PAD.left - 4, y + 3);
  }

  // ── Line ─────────────────────────────────────────────────────────────────
  ctx.beginPath();
  ctx.strokeStyle = '#4d9ce6';
  ctx.lineWidth = 1.5;
  ctx.lineJoin = 'round';
  valid.forEach((r, i) => {
    const x = mapX(r.startTime);
    const y = mapY(r.durationMs);
    i === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y);
  });
  ctx.stroke();

  // ── Dots (color-coded by status) ─────────────────────────────────────────
  valid.forEach(r => {
    const x = mapX(r.startTime);
    const y = mapY(r.durationMs);
    const color = r.status === 'Succeeded' ? '#4ec9b0'
                : r.status === 'Failed'    ? '#f14c4c'
                : r.status === 'InProgress'? '#e5a400'
                : '#6e7681';

    ctx.beginPath();
    ctx.arc(x, y, 3.5, 0, Math.PI * 2);
    ctx.fillStyle = color;
    ctx.fill();
  });

  // ── X-axis date labels ────────────────────────────────────────────────────
  ctx.fillStyle = mutedColor;
  ctx.font = '9px monospace';
  ctx.textAlign = 'center';

  const labelMax = Math.min(valid.length, 6);
  const step = Math.max(1, Math.floor(valid.length / labelMax));
  for (let i = 0; i < valid.length; i += step) {
    const r = valid[i];
    const x = mapX(r.startTime);
    const d = new Date(r.startTime);
    const label = `${d.getMonth() + 1}/${d.getDate()}`;
    ctx.fillText(label, x, PAD.top + cH + 18);
  }
}

// ── Patterns ──────────────────────────────────────────────────────────────────
function renderPatterns(/** @type {any[]} */ patterns) {
  if (!patterns || patterns.length === 0) {
    dom.patternsSection.style.display = 'none';
    return;
  }
  dom.patternsSection.style.display = 'block';
  dom.patternsSection.innerHTML = patterns.map(p => `
    <div class="pattern-warn">
      ⚠ ${esc(p.description)}
      <span class="muted" style="font-size:10px">(${p.failureCount}/${p.totalFailures} failures)</span>
    </div>
  `).join('');
}

// ── Runs table ────────────────────────────────────────────────────────────────
function renderRunsTable(/** @type {any[]} */ runs) {
  if (!runs || runs.length === 0) {
    dom.runsTbody.innerHTML = '';
    dom.noRuns.classList.remove('hidden');
    return;
  }
  dom.noRuns.classList.add('hidden');

  // Build annotation lookup (date → note)
  const annByDate = {};
  if (data?.annotations) {
    for (const ann of data.annotations) {
      const day = ann.date.slice(0, 10);
      annByDate[day] = ann.note;
    }
  }

  dom.runsTbody.innerHTML = runs.map(r => {
    const day = r.startTime?.slice(0, 10) ?? '';
    const hasAnn = !!annByDate[day];
    const durText = r.durationMs != null ? fmtDur(r.durationMs) : '—';
    const statusClass = statusCls(r.status);
    const dateStr = r.startTime ? new Date(r.startTime).toLocaleString() : '—';

    return `
<tr>
  <td class="h-col-date muted" title="${esc(dateStr)}">${esc(dateStr)}</td>
  <td class="h-col-status">
    <span class="status-badge status-${statusClass}">${esc(r.status)}</span>
  </td>
  <td class="h-col-dur" style="text-align:right">${durText}</td>
  <td class="h-col-err muted" title="${esc(r.errorMessage ?? '')}">
    ${r.errorMessage ? `<span style="color:var(--fp-red)">${esc(truncate(r.errorMessage, 80))}</span>` : ''}
  </td>
  <td class="h-col-note">
    <span class="annotation-note" data-date="${esc(day)}" title="${hasAnn ? esc(annByDate[day]) : 'Add note'}">
      ${hasAnn ? '📝' : ''}
    </span>
  </td>
</tr>`;
  }).join('');

  // Click annotation dots to open modal with that date pre-filled
  dom.runsTbody.querySelectorAll('.annotation-note').forEach(el => {
    el.addEventListener('click', () => {
      const date = /** @type {HTMLElement} */ (el).dataset.date ?? '';
      openModal(date);
    });
  });
}

// ── Annotations list ──────────────────────────────────────────────────────────
function renderAnnotations(/** @type {any[]} */ anns) {
  if (!anns || anns.length === 0) {
    dom.annSection.style.display = 'none';
    return;
  }
  dom.annSection.style.display = 'block';
  dom.annList.innerHTML = anns.map(a => `
    <div style="padding:4px 0; border-bottom:1px solid rgba(255,255,255,0.05); font-size:11px;">
      <span class="muted">${esc(a.date.slice(0, 10))}</span>
      <span style="margin-left:8px">${esc(a.note)}</span>
    </div>
  `).join('');
}

// ── Period buttons ────────────────────────────────────────────────────────────
dom.periodBtns.forEach(btn => {
  btn.addEventListener('click', () => {
    post({ type: 'setPeriod', period: btn.dataset.period });
  });
});

// ── Export ────────────────────────────────────────────────────────────────────
dom.btnCsv.addEventListener('click',  () => post({ type: 'exportCsv' }));
dom.btnJson.addEventListener('click', () => post({ type: 'exportJson' }));

// ── Annotation modal ──────────────────────────────────────────────────────────
dom.btnAddNote.addEventListener('click', () => {
  openModal(new Date().toISOString().slice(0, 10));
});

dom.modalCancel.addEventListener('click', closeModal);
dom.modalOverlay.addEventListener('click', e => {
  if (e.target === dom.modalOverlay) closeModal();
});

dom.modalSave.addEventListener('click', () => {
  const date = dom.modalDate.value.trim();
  const note = dom.modalNote.value.trim();

  // Validate date format (YYYY-MM-DD)
  if (!date || !/^\d{4}-\d{2}-\d{2}$/.test(date) || isNaN(Date.parse(date))) {
    showToast('Please enter a valid date (YYYY-MM-DD).', 'warning');
    return;
  }
  if (!note) {
    showToast('Note cannot be empty.', 'warning');
    return;
  }
  // Enforce reasonable length limit to prevent DB bloat
  if (note.length > 1000) {
    showToast('Note must be 1000 characters or less.', 'warning');
    return;
  }

  post({ type: 'addAnnotation', date, note });
  closeModal();
});

function openModal(/** @type {string} */ date) {
  dom.modalDate.value = date;
  dom.modalNote.value = '';
  dom.modalOverlay.classList.remove('hidden');
  dom.modalNote.focus();
}
function closeModal() {
  dom.modalOverlay.classList.add('hidden');
}

// Escape on modal
window.addEventListener('keydown', e => {
  if (e.key === 'Escape') closeModal();
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
function statusCls(/** @type {string|undefined} */ s) {
  switch (s) {
    case 'Succeeded':  return 'succeeded';
    case 'Failed':     return 'failed';
    case 'InProgress': return 'inprogress';
    case 'Cancelled':  return 'cancelled';
    case 'Queued':     return 'queued';
    default:           return 'unknown';
  }
}

function fmtDur(/** @type {number} */ ms) {
  const s = Math.round(ms / 1000);
  if (s < 60)  return `${s}s`;
  const m = Math.floor(s / 60);
  const r = s % 60;
  if (m < 60)  return `${m}m ${r}s`;
  return `${Math.floor(m / 60)}h ${m % 60}m`;
}

function truncate(/** @type {string} */ s, /** @type {number} */ n) {
  return s.length > n ? s.slice(0, n) + '…' : s;
}

function esc(/** @type {string} */ s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;'); // prevent single-quote breakout in HTML attributes
}

function getCssVar(/** @type {string} */ name, /** @type {string} */ fallback) {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim() || fallback;
}

// Re-draw chart on window resize
let resizeTimer = 0;
window.addEventListener('resize', () => {
  clearTimeout(resizeTimer);
  resizeTimer = setTimeout(() => { if (data) drawChart(data.runs); }, 150);
});

// ── Bootstrap ─────────────────────────────────────────────────────────────────
post({ type: 'ready' });
