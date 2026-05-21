# Changelog

All notable changes to the **FabricPulse** extension will be documented in this file.

## [1.3.0] - 2026-05-21

### Added
- **Lakehouse panel**: New "Open Lakehouses" command — browse Microsoft Fabric lakehouses across workspaces, with tenant and workspace filters, text search, and favorites
- **Table browser**: Expand a lakehouse to list its Delta tables (Managed/External, format, last maintenance) in a resizable detail panel
- **Table maintenance**: Trigger Optimize (bin-compaction + V-Order) and Vacuum jobs on tables directly from the panel; job status is polled in the background and surfaced per table
- **Schema-enabled lakehouses**: Manual maintenance dialog (schema + table name) for schema-enabled lakehouses, where the Fabric List Tables API is unavailable
- **SQL endpoint**: Connection string copy and provisioning status shown per lakehouse

### Fixed
- **Maintenance timestamp**: Maintenance run times are stored as ISO 8601 UTC, fixing a timezone offset that displayed a just-triggered job as hours old

### Changed
- **API errors**: Fabric API error messages now include the server-provided detail message when available

## [1.2.3] - 2026-03-25

### Fixed
- **Workspace filter**: Selecting "All workspaces" after filtering by a specific workspace now works correctly (empty workspaceId was rejected by UUID validation)

## [1.2.2] - 2026-03-17

### Added
- **Resizable columns**: Drag column borders in the dashboard table to resize them; double-click a border to reset to default width

### Fixed
- **Status bar timer**: "Updated just now · Next in Xm" text now updates in real-time without requiring a manual refresh click

## [1.2.1] - 2026-03-11

### Added
- **Quick Guide**: Help button (`?`) in the toolbar opens an in-webview modal with usage documentation — covers getting started, dashboard filters, quick actions, history panel, alerts, and settings

## [1.2.0] - 2026-03-11

### Security
- **SSRF prevention**: Pagination URLs are now validated against the expected API origin before following `continuationUri` links
- **UUID validation**: All public API methods (`fabricApi.ts`) now reject malformed IDs via `assertUuids()`, preventing path injection in REST URLs
- **Webview message validation**: `DashboardPanel` and `HistoryPanel` now validate every incoming webview message (UUID format, string lengths, boolean types, period whitelist) before processing
- **Bounded globalState**: Alerted run IDs are stored in a single bounded Set (max 500, FIFO eviction) instead of per-run keys, preventing unbounded storage growth
- **401 handling**: Paginated API calls (`listAll`, `listAllPbi`) now detect expired tokens mid-pagination and re-authenticate automatically
- **XSS hardening**: All interpolated values in `dashboard.js` and `history.js` are escaped via `esc()` before insertion into innerHTML

### Fixed
- **Retry-After capped**: Server-provided `Retry-After` headers are now capped to 60 seconds to prevent server-controlled hangs
- **Token refresh in pagination**: Token is re-acquired per pagination page to avoid expiry during long-running fetches
- **Favorites-only refresh batched**: Refreshing only favorites now uses the same batch-loading logic as full refreshes, preventing API rate-limit errors
- **Fetch timeout**: All HTTP requests now have a 30-second timeout to prevent indefinite hangs
- **Transaction safety**: `upsertRunsBatch` uses try/catch with explicit ROLLBACK on error; `_inTransaction` flag prevents database reopen mid-transaction
- **ALTER TABLE migration**: Only "duplicate column" errors are silently ignored during schema migration; other errors are re-thrown
- **Daily report timer**: Uses `>=` comparison with NaN guard for malformed config, preventing missed reports due to timer drift
- **Polling timer cleanup**: `clearTimeout` used instead of `clearInterval` to match the `setTimeout`-based polling loop
- **AVG duration**: Average duration now filters to `Succeeded` runs only, consistent with MIN/MAX calculations
- **History cleanup**: Uses `start_time` column (with NULL fallback to `created_at`) instead of non-existent `created_at` for retention cleanup
- **Daily report persistence**: `lastDailyReportDate` is persisted in globalState so the daily report survives VS Code restarts
- **openHistory command**: Now reconstructs the pipeline from storage and opens the HistoryPanel instead of silently failing
- **Optional startTime**: `PipelineRun.startTime` is now optional to reflect runs that haven't started yet — prevents fabricated timestamps, NaN in charts, and premature cleanup
- **API error messages**: `serviceExceptionJson` returns a safe fallback message when JSON parsing fails instead of throwing
- **Unreachable code path**: Dead `return fn()` after exhausted retries replaced with `throw Error` for fail-fast behavior

## [1.1.6] - 2026-03-10

### Fixed
- Fixed "Unexpected end of JSON input" error when triggering a pipeline run — the Fabric API returns 202 Accepted with an empty body, which is now handled gracefully

## [1.1.5] - 2026-03-09

### Fixed
- Fixed multiple authentication popups opening simultaneously when switching tenants with favorites — concurrent token requests are now deduplicated so only a single auth window appears

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
