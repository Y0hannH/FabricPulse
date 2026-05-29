import * as vscode from 'vscode';
import * as crypto from 'crypto';

function getNonce(): string {
  return crypto.randomBytes(16).toString('hex');
}

/**
 * A self-contained, read-only webview that documents every feature of the
 * FabricPulse extension and its configuration settings. The HTML is fully
 * inline (no external JS/CSS, no message passing) so the panel is cheap to
 * build and has no runtime dependencies.
 */
export class DocumentationPanel {
  public static currentPanel: DocumentationPanel | undefined;
  private static readonly VIEW_TYPE = 'fabricPulseDocumentation';

  private readonly _panel: vscode.WebviewPanel;
  private readonly _disposables: vscode.Disposable[] = [];

  public static createOrShow(extensionUri: vscode.Uri): DocumentationPanel {
    const column = vscode.window.activeTextEditor?.viewColumn ?? vscode.ViewColumn.One;

    if (DocumentationPanel.currentPanel) {
      DocumentationPanel.currentPanel._panel.reveal(column);
      return DocumentationPanel.currentPanel;
    }

    const panel = vscode.window.createWebviewPanel(
      DocumentationPanel.VIEW_TYPE,
      '📖 FabricPulse Documentation',
      column,
      {
        enableScripts: false,
        retainContextWhenHidden: true,
        localResourceRoots: [extensionUri],
      },
    );

    DocumentationPanel.currentPanel = new DocumentationPanel(panel);
    return DocumentationPanel.currentPanel;
  }

  private constructor(panel: vscode.WebviewPanel) {
    this._panel = panel;
    this._panel.webview.html = this._buildHtml();
    this._panel.onDidDispose(() => this.dispose(), null, this._disposables);
  }

  // ─── HTML ──────────────────────────────────────────────────────────────────

  private _buildHtml(): string {
    const nonce = getNonce();
    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta http-equiv="Content-Security-Policy"
        content="default-src 'none'; style-src 'nonce-${nonce}'; img-src data:;" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>FabricPulse Documentation</title>
  <style nonce="${nonce}">
    :root {
      --fp-accent: var(--vscode-textLink-foreground, #4da0ff);
      --fp-border: var(--vscode-widget-border, rgba(255,255,255,0.12));
      --fp-bg-alt: var(--vscode-editorWidget-background, rgba(255,255,255,0.04));
      --fp-muted: var(--vscode-descriptionForeground, #999);
    }
    * { box-sizing: border-box; }
    body {
      font-family: var(--vscode-font-family);
      font-size: var(--vscode-font-size, 13px);
      color: var(--vscode-foreground);
      background: var(--vscode-editor-background);
      line-height: 1.6;
      margin: 0;
      padding: 0;
    }
    .wrap {
      max-width: 920px;
      margin: 0 auto;
      padding: 28px 32px 80px;
    }
    .hero {
      border-bottom: 1px solid var(--fp-border);
      padding-bottom: 18px;
      margin-bottom: 24px;
    }
    .hero h1 { font-size: 26px; margin: 0 0 6px; }
    .hero p { color: var(--fp-muted); margin: 0; }
    .badge {
      display: inline-block;
      font-size: 11px;
      padding: 2px 8px;
      border-radius: 10px;
      background: var(--fp-bg-alt);
      border: 1px solid var(--fp-border);
      color: var(--fp-muted);
      margin-left: 8px;
      vertical-align: middle;
    }
    nav.toc {
      background: var(--fp-bg-alt);
      border: 1px solid var(--fp-border);
      border-radius: 8px;
      padding: 14px 18px;
      margin-bottom: 28px;
    }
    nav.toc h2 { font-size: 12px; text-transform: uppercase; letter-spacing: 0.06em; color: var(--fp-muted); margin: 0 0 8px; }
    nav.toc ul { list-style: none; margin: 0; padding: 0; columns: 2; column-gap: 28px; }
    nav.toc li { margin: 3px 0; break-inside: avoid; }
    nav.toc a { color: var(--fp-accent); text-decoration: none; }
    nav.toc a:hover { text-decoration: underline; }
    section { margin-bottom: 34px; scroll-margin-top: 16px; }
    section > h2 {
      font-size: 19px;
      margin: 0 0 12px;
      padding-bottom: 6px;
      border-bottom: 1px solid var(--fp-border);
    }
    h3 { font-size: 15px; margin: 18px 0 6px; }
    p { margin: 8px 0; }
    ul.feat { margin: 8px 0; padding-left: 22px; }
    ul.feat li { margin: 5px 0; }
    code {
      font-family: var(--vscode-editor-font-family, monospace);
      background: var(--fp-bg-alt);
      border: 1px solid var(--fp-border);
      border-radius: 4px;
      padding: 1px 5px;
      font-size: 0.92em;
    }
    kbd {
      font-family: var(--vscode-editor-font-family, monospace);
      background: var(--fp-bg-alt);
      border: 1px solid var(--fp-border);
      border-bottom-width: 2px;
      border-radius: 4px;
      padding: 1px 6px;
      font-size: 0.9em;
      white-space: nowrap;
    }
    .muted { color: var(--fp-muted); }
    table.settings {
      width: 100%;
      border-collapse: collapse;
      margin: 12px 0;
      font-size: 13px;
    }
    table.settings th, table.settings td {
      text-align: left;
      padding: 8px 10px;
      border-bottom: 1px solid var(--fp-border);
      vertical-align: top;
    }
    table.settings th { color: var(--fp-muted); font-weight: 600; }
    table.settings td code { white-space: nowrap; }
    .callout {
      background: var(--fp-bg-alt);
      border-left: 3px solid var(--fp-accent);
      border-radius: 0 6px 6px 0;
      padding: 10px 14px;
      margin: 14px 0;
    }
    .actions-grid {
      display: grid;
      grid-template-columns: 60px 1fr;
      gap: 6px 12px;
      align-items: center;
      margin: 10px 0;
    }
    .actions-grid .icon { font-size: 16px; text-align: center; }
  </style>
</head>
<body>
<div class="wrap">

  <div class="hero">
    <h1>⚡ FabricPulse <span class="badge">Documentation</span></h1>
    <p>Real-time monitoring &amp; management for Microsoft Fabric — pipelines, semantic models, notebooks and lakehouses, right inside VS Code.</p>
  </div>

  <nav class="toc">
    <h2>Contents</h2>
    <ul>
      <li><a href="#getting-started">Getting Started</a></li>
      <li><a href="#dashboard">Dashboard</a></li>
      <li><a href="#item-types">Item Types</a></li>
      <li><a href="#filters">Filtering &amp; Sorting</a></li>
      <li><a href="#actions">Quick Actions</a></li>
      <li><a href="#history">History &amp; Annotations</a></li>
      <li><a href="#lakehouses">Lakehouses</a></li>
      <li><a href="#alerts">Alerts &amp; Patterns</a></li>
      <li><a href="#workspaces">Workspaces &amp; Favorites</a></li>
      <li><a href="#settings">Settings</a></li>
      <li><a href="#commands">Commands</a></li>
    </ul>
  </nav>

  <section id="getting-started">
    <h2>1 · Getting Started</h2>
    <ul class="feat">
      <li><strong>Add a tenant</strong> — click <kbd>+ Add Tenant</kbd> in the dashboard (or the FabricPulse sidebar) and enter a display name plus your Azure Tenant ID (a GUID).</li>
      <li><strong>Sign in</strong> — on first refresh FabricPulse acquires an Azure token via your default browser. The dashboard refreshes live as soon as the page opens.</li>
      <li><strong>Pick a workspace</strong> — use the workspace picker to focus on one workspace, or leave it on <em>All workspaces</em> to monitor everything.</li>
    </ul>
    <div class="callout">
      FabricPulse keeps a local history cache (SQLite). The dashboard paints cached data instantly, then refreshes live data in the background.
    </div>
  </section>

  <section id="dashboard">
    <h2>2 · Dashboard</h2>
    <p>The dashboard is the main view — a sortable table of every monitored item with its latest run, schedule and duration statistics.</p>
    <ul class="feat">
      <li><strong>Last Run</strong> — status badge (Succeeded / Failed / In Progress) and relative time.</li>
      <li><strong>Next Run</strong> — next scheduled execution, derived from the item's Fabric schedule.</li>
      <li><strong>Duration</strong> — duration of the most recent run.</li>
      <li><strong>Avg / Min ✓ / Max ✓</strong> — average across all cached runs, plus min and max of <em>succeeded</em> runs only.</li>
      <li><strong>7d Rate</strong> — success rate over the last 7 days, color-coded.</li>
      <li><strong>Runs</strong> — total number of runs in the local cache.</li>
    </ul>
  </section>

  <section id="item-types">
    <h2>3 · Item Types</h2>
    <p>FabricPulse monitors three kinds of Fabric items, each with the same set of actions and statistics:</p>
    <ul class="feat">
      <li><strong>Pipeline</strong> — Data Factory pipelines. Supports re-run and a deep link to run monitoring.</li>
      <li><strong>Semantic Model</strong> — Power BI / Fabric datasets. The run button triggers a dataset refresh.</li>
      <li><strong>Notebook</strong> — Fabric notebooks. The run button starts a <code>RunNotebook</code> job.</li>
    </ul>
    <p class="muted">Use the type pills in the toolbar (All · Pipeline · Model · Notebook) to show one type at a time.</p>
  </section>

  <section id="filters">
    <h2>4 · Filtering &amp; Sorting</h2>
    <ul class="feat">
      <li><strong>Search</strong> — type in the filter box to match item or workspace names.</li>
      <li><strong>★ Favorites</strong> — toggle to show only starred items.</li>
      <li><strong>Type pills</strong> — All / Pipeline / Model / Notebook.</li>
      <li><strong>Status pills</strong> — Failed, Succeeded, Never run, In Progress (multi-select).</li>
      <li><strong>Sort</strong> — click any column header to sort; click again to reverse.</li>
    </ul>
  </section>

  <section id="actions">
    <h2>5 · Quick Actions</h2>
    <p>Hover over a row to reveal the action buttons (in the dedicated actions column before the name):</p>
    <div class="actions-grid">
      <span class="icon">↺</span><span>Refresh the item's last run immediately.</span>
      <span class="icon">⬇</span><span>Fetch the item's full run history into the local cache.</span>
      <span class="icon">▶ / ⟳</span><span>Re-run a pipeline, run a notebook, or trigger a model refresh. The last run auto-refreshes a few seconds later so the new status appears quickly.</span>
      <span class="icon">📋</span><span>Copy the latest Run ID to the clipboard.</span>
      <span class="icon">🔗</span><span>Open the item in the Fabric portal.</span>
      <span class="icon">📈</span><span>Open run monitoring in Fabric <span class="muted">(pipelines only)</span>.</span>
      <span class="icon">📊</span><span>Open the History panel for the item.</span>
    </div>
  </section>

  <section id="history">
    <h2>6 · History &amp; Annotations</h2>
    <ul class="feat">
      <li><strong>Chart</strong> — duration over time, with points color-coded by status.</li>
      <li><strong>Period</strong> — switch between 7 days, 30 days, 90 days, or all.</li>
      <li><strong>Annotations</strong> — click the 📝 icon to attach a note to a specific date (e.g. "schema change", "infra incident").</li>
      <li><strong>Export</strong> — export the history as CSV or JSON from inside the History panel.</li>
    </ul>
  </section>

  <section id="lakehouses">
    <h2>7 · Lakehouses</h2>
    <p>Open the Lakehouses view from the sidebar or command palette to inspect and maintain Fabric lakehouses.</p>
    <ul class="feat">
      <li><strong>Browse tables</strong> — expand a lakehouse to list its tables (supports both classic and schema-enabled lakehouses).</li>
      <li><strong>Table size</strong> — compute the on-disk size of any table, or batch-compute all of them in the overview.</li>
      <li><strong>Maintenance</strong> — run Optimize, V-Order and Vacuum on individual tables or in bulk; job status is polled and reported.</li>
      <li><strong>SQL endpoint</strong> — copy the lakehouse connection string.</li>
      <li><strong>Open in Fabric</strong> — deep link to the lakehouse in the portal.</li>
    </ul>
  </section>

  <section id="alerts">
    <h2>8 · Alerts &amp; Patterns</h2>
    <ul class="feat">
      <li><strong>Failure alerts</strong> — failed runs surface automatically as VS Code notifications.</li>
      <li><strong>Daily report</strong> — a summary notification at a configurable time (default 18:00).</li>
      <li><strong>Pattern detection</strong> — FabricPulse warns when an item fails repeatedly on the same day or within the same time window.</li>
    </ul>
  </section>

  <section id="workspaces">
    <h2>9 · Workspaces &amp; Favorites</h2>
    <ul class="feat">
      <li><strong>Favorites</strong> — star an item to pin it; favorites load first on startup.</li>
      <li><strong>Workspace picker</strong> — filter to a single workspace, star workspaces, or blacklist ones you don't want polled.</li>
      <li><strong>Blacklist</strong> — excluded workspaces are skipped entirely during refresh (see <code>blacklistedWorkspaces</code> below).</li>
    </ul>
  </section>

  <section id="settings">
    <h2>10 · Settings</h2>
    <p>Open VS Code Settings and search <kbd>fabricPulse</kbd>, or edit <code>settings.json</code> directly.</p>
    <table class="settings">
      <thead>
        <tr><th>Setting</th><th>Default</th><th>Description</th></tr>
      </thead>
      <tbody>
        <tr>
          <td><code>fabricPulse.pollingInterval</code></td>
          <td>60</td>
          <td>Auto-refresh interval in seconds (10–3600).</td>
        </tr>
        <tr>
          <td><code>fabricPulse.retentionDays</code></td>
          <td>90</td>
          <td>Days of run history to keep locally (7–365).</td>
        </tr>
        <tr>
          <td><code>fabricPulse.dailyReportTime</code></td>
          <td>18:00</td>
          <td>Time of day (HH:MM) for the daily summary notification.</td>
        </tr>
        <tr>
          <td><code>fabricPulse.batchSize</code></td>
          <td>5</td>
          <td>Items fetched per batch when loading all workspaces (1–50).</td>
        </tr>
        <tr>
          <td><code>fabricPulse.batchDelayMs</code></td>
          <td>2500</td>
          <td>Delay in milliseconds between batches to avoid API rate limiting (500–30000).</td>
        </tr>
        <tr>
          <td><code>fabricPulse.batchThreshold</code></td>
          <td>10</td>
          <td>Minimum number of stale items required to trigger batched loading (1–200).</td>
        </tr>
        <tr>
          <td><code>fabricPulse.blacklistedWorkspaces</code></td>
          <td>[]</td>
          <td>Workspaces to exclude from refresh. Accepts workspace IDs (GUIDs) or display names (case-insensitive).</td>
        </tr>
      </tbody>
    </table>
  </section>

  <section id="commands">
    <h2>11 · Commands</h2>
    <p>Available from the Command Palette (<kbd>Ctrl/Cmd</kbd> + <kbd>Shift</kbd> + <kbd>P</kbd>):</p>
    <ul class="feat">
      <li><code>FabricPulse: Open Dashboard</code></li>
      <li><code>FabricPulse: Open Lakehouses</code></li>
      <li><code>FabricPulse: Open Documentation</code></li>
      <li><code>FabricPulse: Add Tenant</code></li>
      <li><code>FabricPulse: Export History (CSV)</code></li>
      <li><code>FabricPulse: Clear Local History</code></li>
    </ul>
  </section>

</div>
</body>
</html>`;
  }

  public dispose(): void {
    DocumentationPanel.currentPanel = undefined;
    this._panel.dispose();
    this._disposables.forEach(d => d.dispose());
    this._disposables.length = 0;
  }
}
