# Changelog

All notable changes to the **FabricPulse** extension will be documented in this file.

## [1.1.4] - 2026-03-09

### Fixed
- Fixed WASM memory leak during long-running sessions — debounced disk flushes and periodic database reopen prevent heap exhaustion
- Fixed "memory access out of bounds" crash on startup caused by corrupted local database — the extension now auto-recovers by resetting the database and notifying the user
- Fixed "open2.default is not a function" error caused by ESM/CJS interop issue with the `open` package during Azure authentication

## [1.1.0] - 2025-06-01

### Added
- Semantic Model monitoring (Power BI / Fabric refresh statuses)
- Priority loading for favorite pipelines on startup
- Configurable batch loading with instant cache
- Workspace blacklist — exclude workspaces from polling by ID or name
- Total run count displayed per pipeline

### Fixed
- Timezone handling on run timestamps

## [1.0.0] - 2025-04-01

### Added
- Main dashboard with color-coded pipeline statuses
- Live filtering by workspace and pipeline name
- Favorite pipelines with dedicated view
- Run history stored locally in SQLite (via sql.js)
- Duration chart and success rate per pipeline
- Native VS Code notifications on failure or threshold breach
- Configurable daily summary report
- Pattern detection (recurring failures by day or time range)
- Multi-tenant support (multiple Azure tenants)
- Manual annotations on specific dates
- CSV and JSON export of run history
- Quick actions: Re-run, Copy Run ID, Open in Fabric, View History
