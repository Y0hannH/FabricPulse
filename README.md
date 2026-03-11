# ⚡ FabricPulse

> Real-time pulse of your Microsoft Fabric pipelines — right inside VS Code.

![VS Code](https://img.shields.io/badge/VS%20Code-%5E1.85-007ACC?style=flat-square&logo=visualstudiocode)
![Version](https://img.shields.io/badge/Version-1.2.1-blue?style=flat-square)
![License](https://img.shields.io/badge/License-MIT-00B4D8?style=flat-square)
![Status](https://img.shields.io/badge/Status-In%20Development-orange?style=flat-square)

---

## What is FabricPulse?

FabricPulse is a VS Code extension for data engineers working with Microsoft Fabric. It brings pipeline monitoring directly into your development environment — no context switching, no slow portal, no waiting for Power BI to load.

You choose which pipelines matter. FabricPulse watches them, stores their history locally, and alerts you when something goes wrong.

---

## Features

| | Feature | Description |
|---|---|---|
| 📋 | **Dashboard** | Overview of all your pipelines with color-coded status, live filtering by workspace and name |
| ⭐ | **Favorites** | Pin key pipelines. "Favorites only" view — loaded first on startup |
| 📊 | **History** | Duration chart, success rate, run table — stored locally in SQLite |
| 🔔 | **Alerts** | Native VS Code notifications on failure or threshold breach. Configurable daily report |
| ⚡ | **Quick Actions** | Re-run, Copy Run ID, Open in Fabric, View History — directly from the table |
| 🧠 | **Pattern Detection** | Detects if a pipeline frequently fails on the same day or time range |
| 🏢 | **Multi-tenant** | Manage multiple Azure tenants / clients from a single panel |
| 📤 | **Export** | CSV or JSON export of run history for client reports |
| 📝 | **Annotations** | Manual notes on specific dates to correlate performance with deployments |
| 🧮 | **Semantic Models** | Monitor Power BI / Fabric Semantic Model refreshes and statuses |
| 🔢 | **Total Executions** | Total run count displayed per pipeline to gauge execution frequency |
| 🚀 | **Smart Loading** | Priority loading for favorites, configurable batching, instant cache on startup |
| 🚫 | **Workspace Blacklist** | Exclude workspaces from polling (by ID or name) to reduce noise |

---

## Getting Started

### Prerequisites

- VS Code 1.85+
- Azure CLI installed and configured (`az login`)
- Access to a Microsoft Fabric workspace

### Installation

```bash
# From the marketplace (when available)
ext install evolve.fabricpulse

# From source
git clone https://github.com/evolve/fabricpulse
cd fabricpulse
npm install
npm run compile
```

### First Run

1. Open the Command Palette (`Ctrl+Shift+P`)
2. Run `FabricPulse: Open Dashboard`
3. Add your tenant via `FabricPulse: Add Tenant`
4. Mark your critical pipelines as favorites ⭐

---

## Architecture

| Layer | Stack |
|---|---|
| Extension Host | TypeScript + VS Code Extension API |
| UI / Webview | Vanilla HTML/CSS/JS — native VS Code theming |
| Auth | Azure CLI (`az login`) + interactive browser fallback |
| API | Microsoft Fabric REST API v1 |
| Storage | SQLite (`sql.js`) via `globalStorageUri` |
| Alerting | VS Code Notification API + polling every 60s |

---

## Commands

| Command | Description |
|---|---|
| `fabricPulse.openDashboard` | Open the main dashboard |
| `fabricPulse.addTenant` | Add an Azure tenant |
| `fabricPulse.exportHistory` | Export CSV history for the selected pipeline |
| `fabricPulse.clearHistory` | Clear local history |

---

## Configuration

| Setting | Default | Description |
|---|---|---|
| `fabricPulse.pollingInterval` | `60` | Auto-refresh interval in seconds |
| `fabricPulse.retentionDays` | `90` | Number of days to retain run history |
| `fabricPulse.dailyReportTime` | `"18:00"` | Time for the daily summary report (HH:MM) |
| `fabricPulse.batchSize` | `5` | Number of pipelines fetched per batch |
| `fabricPulse.batchDelayMs` | `2500` | Delay between batches (ms) to avoid API rate limiting |
| `fabricPulse.batchThreshold` | `10` | Minimum number of stale pipelines to trigger batched loading |
| `fabricPulse.blacklistedWorkspaces` | `[]` | Workspaces excluded from polling (by ID or name) |

---

## Local Data & Privacy

FabricPulse does not collect any data. Everything is stored locally:

- **Run history**: SQLite in VS Code's `globalStorage` directory
- **Favorites and config**: VS Code `globalState`
- No telemetry, no backend, no external calls beyond the Fabric API

Default retention: **90 days**. Configurable in settings.

---

## Roadmap

### ✅ Foundation
Dashboard, favorites, history, alerts, multi-tenant, CSV/JSON export, pattern detection, annotations.

### ✅ Semantic Models & Performance
- Semantic Model support (Power BI / Fabric refreshes)
- Priority loading for favorites on startup
- Configurable batching with instant cache
- Workspace blacklist
- Total run count per pipeline
- Timezone fix on run timestamps

### ✅ Security & Bug Hardening
- SSRF prevention, UUID validation, webview message validation, XSS hardening
- Bounded globalState, transaction safety, fetch timeouts, retry caps
- 15+ bug fixes across all services

### 🔲 Notebooks & Spark Jobs
- Fabric Notebooks support (runs, durations, statuses)
- Spark Jobs support
- Unified filters across pipelines, notebooks, and semantic models

### 🔲 Run Analysis
- Compare two runs of the same pipeline (parameters, durations, logs)
- Configuration diff between executions

### 🔲 Sharing & Cross-tenant
- Static HTML report export (for client sharing)
- "Pinned Items" cross-tenant panel: monitor favorites from multiple tenants in a single view

---

## Contributing

The project is under active development. Contributions will be welcome once the repo is published.

- Fork → branch → PR
- Open an issue to discuss a feature before coding
- Follow the existing naming conventions

---

## License

MIT © 2025 [Evolve](https://evolve-data.fr) — Yohann

---

*Built with ♥ by Evolve*
