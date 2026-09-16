# Changelog

All notable changes to the **FabricPulse** extension will be documented in this file.

## [1.11.0] - 2026-09-16

### Added
- **Notification history**: a new **Notifications** view in the FabricPulse sidebar keeps every error, warning and result — from the dashboard, lakehouses, history panels, alerts and sign-in — newest first, so nothing is lost when a notification fades out or is dismissed unread. A badge on the view (and the FabricPulse activity icon) counts what arrived since you last looked; hover an entry for the full message, copy it with the inline action, or clear the list from the view toolbar. The last 500 entries are kept across restarts. Pure UI confirmations ("copied", "loading…") are not recorded. New commands: `FabricPulse: Show Notifications`, `FabricPulse: Clear Notifications`
- **Lakehouse Overview — filter by maintenance status**: the table list can be filtered on *Failed*, *In progress*, *Optimized* or *Never* with a selector in its header, or by clicking a *Maintenance health* counter. A filtered list includes tables whose size was never measured, so failed tables can be found without scrolling and re-run in one go with **Maintain N shown**. Hovering a failed status (ⓘ) shows the failure reason
- **Lakehouse Overview — Show all**: next to *Show 15 more*, **Show all** displays the whole list
- **Bulk maintenance — concurrency limit and progress**: bulk maintenance now runs at most `fabricPulse.maintenanceConcurrency` jobs at a time (new setting, default 15, 1–50); the next table starts as soon as one finishes. A progress bar above the table list shows completed, failed, running and queued tables, and **■ Stop** prevents new tables from starting while running jobs finish. Closing and reopening the Overview picks the progress back up

### Fixed
- **Bulk maintenance overloaded the capacity**: every table was triggered back to back without waiting for any job to end, so maintaining 200 tables meant 200 concurrent Spark jobs — the likely cause of the failures seen on large selections. See the concurrency limit above
- **Bulk maintenance notification flood**: each finished job raised its own notification. A bulk run now ends with a single summary; per-table failures, with their reason, go to the Notifications view. Tables that could not even be started were silently ignored — they are now recorded as *Failed*, so they show under the Failed filter
- **"Last maint." did not update until the Overview was reopened**: job status changes are now pushed live to the Overview (they only reached the expanded Tables panel before)
- **Maintenance status stuck on "InProgress" / "Timeout"**: a job was followed for 5 minutes only — less than an Optimize or Vacuum on a large table. Jobs are now followed for up to 2 hours
- **Maintenance health counts didn't add up**: *Cancelled*, *Deduped*, *NotStarted* and *Timeout* statuses were counted in no category. Every table now falls in exactly one (Cancelled → Failed, Deduped → Optimized, NotStarted / Timeout → In progress), and the counts follow the selected schema
- **Lakehouse Overview — table filter lost focus after each character**: the modal was redrawn on every keystroke (and on every progress update), dropping focus from *Filter tables…* and scrolling the list back to the top. Focus, caret position and scroll position are now kept
- **Lakehouse Overview — filter box misaligned**: *Filter tables…* sat 5 px above the controls next to it (a dialog-form margin applied to it)

## [1.10.0] - 2026-09-16

### Added
- **Lakehouse Overview — Refresh all**: a new **↻ Refresh all** button in *Storage analysis* re-measures every table in the current scope (all tables, or the selected schema). Previously **Analyze** only covered tables never measured and disappeared once they all were, so after an Optimize / Vacuum the only way to update the ranking was one ↻ per row. Tables are refreshed largest first so the visible ranking is corrected first; current sizes stay on screen (with ⏳) until replaced, the ranking updates live, and the run can be cancelled. The whole scope is re-measured — not just the 15 visible rows — because a table below the top 15 can move into it after maintenance

### Fixed
- **Duplicate items and GUID names in the dashboard**: in favorites-only mode, refreshing a favorite that had no run recorded yet saved the item's GUID as its display name (and the workspace GUID as its workspace name). Because the cached view was built with `SELECT DISTINCT` over run history, an item recorded under both its GUID and its real name then appeared **twice** in the dashboard, and a workspace could appear twice in the picker. Favorites now store their item and workspace names when starred, and the cached view keeps one row per item using the most recent name — which also cleans up rows affected by the bug. Existing favorites get their names back-filled from history on first launch (local database schema v5)
- **Starred items with no run history were missing from the dashboard**: the cached view was built from run history only, so an item starred before its first run stayed invisible until it ran — and so did its workspace in the picker. They are now listed (statistics show "—" until a run is recorded), and the favorites refresh updates the row as soon as a run is fetched
- **Lakehouse Overview — refresh race**: clicking a row's ↻ while a batch was running marked the whole batch as finished; cancelling a batch left ⏳ spinners stuck on the tables it skipped. Row refresh is now unavailable during a batch, and cancelling clears the spinners
- **Documentation page**: the *Item Types* section still described three item types; it now covers Copy Jobs and dbt Jobs, including why the run button is hidden for dbt Jobs (not triggerable via the API while in preview). The type-pill lists and the quick-action description were updated to match

### Changed
- **Developer tooling — linting restored**: ESLint 10 no longer reads `.eslintrc.json`, so `npm run lint` had been failing outright. The config was migrated to `eslint.config.js` (flat config) with the same rules. Two rule renames surfaced in the process: `no-var-requires` became `no-require-imports`, and the new `preserve-caught-error` rule caught an SQL.js initialization error that discarded its original cause (now attached). TypeScript `lib` moved from ES2020 to ES2022 to allow `Error` causes — the extension already runs on Node 18

## [1.9.1] - 2026-08-20

### Fixed
- **Auto-refresh no longer stops when the token expires**: when a token expired and the renewal needed an interactive sign-in, the acquisition never returned. The polling loop scheduled its next tick only *after* awaiting the refresh, so it stopped for good — and because the loading flag stayed set, the Refresh button was silently debounced away too. The only way out was closing and reopening the panel. Four changes fix it:
  - The polling loop now schedules its next tick *before* running the refresh, so a refresh that throws or hangs costs at most one skipped cycle instead of ending auto-refresh
  - A 401 now drops only the expired access token and replays the request once; the credential — and its refresh token — is discarded only if the replay also returns 401. Previously any 401 wiped the credential and forced a full browser sign-in for what was usually just an expired token
  - Token acquisition is capped at 120 s, and a refresh stuck for more than 3 minutes releases the loading flag so the Refresh button keeps working. Concurrent sign-ins are deduplicated, so a timed-out call never opens a second browser window, and a sign-in completed late still populates the cache
  - Tokens are now renewed in the background 5 minutes before expiry, off the refresh path. When a sign-in is genuinely required, a banner appears at the top of the dashboard with a **Sign in** button (plus a VS Code notification) instead of a browser tab opening unannounced

### Changed
- **Expired Azure CLI sessions fall back to the browser**: when `az login` credentials were picked up at startup and the CLI session later expired, every refresh failed until the user ran `az login` again. FabricPulse now falls back to interactive sign-in automatically

## [1.9.0] - 2026-07-16

### Added
- **Copy Jobs**: Fabric Copy Job runs are now monitored in the main dashboard with the same feature set as pipelines — last run status, run history, success rate, durations, "Next Run" (schedule-based), on-demand trigger, favorites, and alerts. New type filter (`Copy Job`)
- **dbt Jobs** *(preview)*: Fabric dbt Job runs (`DataBuildToolJob`) are monitored read-only — last run, history, and "Next Run". The Fabric REST API does not support triggering dbt jobs in preview, so the trigger button is hidden for this type. New type filter (`dbt Job`)

All Copy Job and dbt Job features above (listing, run history, "Next Run", trigger for Copy Jobs, and the "Open in Fabric" deep links) have been confirmed working against a live tenant.

### Known limitations
- dbt Jobs remain read-only (no trigger button) — the Fabric REST API does not support starting a dbt job run programmatically while the feature is in preview

## [1.8.2] - 2026-06-01

### Fixed
- **First-launch refresh respects favorites-only**: Since the live-refresh-on-open change, the initial forced refresh enumerated every workspace and item even when the favorites-only filter was (or would be) active. The dashboard now decides up front — before the first fetch — to start in favorites-only mode when the active tenant has favorites, and the initial open then takes the light path: it refreshes only the favorites (live) from cache instead of listing every workspace. The manual Refresh button still performs a full refresh of every item

## [1.8.1] - 2026-06-01

### Fixed
- **Next Run — monthly schedules**: Monthly Fabric schedules (e.g. "the 1st of each month at 08:00") were computed and labelled as **Daily** because the `Monthly` schedule type was not handled. The next-run estimate now supports monthly schedules — both day-of-month occurrences (e.g. day 1, with months lacking that day skipped) and ordinal-weekday occurrences (e.g. "Second Tuesday"), plus the `recurrence` interval (every N months). The tooltip now reads e.g. `Monthly — day 1 at 08:00` instead of `Daily`

## [1.8.0] - 2026-05-29

### Added
- **In-editor documentation**: New "Open Documentation" command and sidebar button open a dedicated page documenting every feature (dashboard, item types, quick actions, history, lakehouses, alerts, workspaces) and all configuration settings — replacing the old in-dashboard help modal

### Changed
- **Dashboard — actions column**: Row action buttons moved out of the name cell into a dedicated, fixed-width column placed before the name. This keeps pipeline, semantic model and notebook names aligned regardless of the pipeline-only "Open run monitoring" button
- **Live refresh on open**: The dashboard now performs a live refresh as soon as it opens (acquiring a token if needed) instead of waiting for a manual Refresh click
- **Refresh after trigger**: Triggering a run (pipeline re-run, notebook run, model refresh) now automatically refreshes that item's last run a few seconds later, so the new status appears immediately instead of waiting for the next poll

### Removed
- **In-dashboard help modal**: The toolbar `?` help button and its modal were removed in favor of the new Documentation page

## [1.7.0] - 2026-05-28

### Added
- **Notebooks**: Fabric Notebooks are now monitored in the main dashboard alongside pipelines and semantic models — runs, durations, statuses, schedule-based "Next Run", favorites, and history. Trigger on-demand runs (`RunNotebook` job) and use the same quick actions as pipelines
- **Unified type filter**: The dashboard type pills (All / Pipeline / Model / Notebook) filter by item type across all three kinds of items

## [1.6.1] - 2026-05-28

### Added
- **Dashboard — "Open run monitoring" action**: New 📈 row action for data pipelines that opens the pipeline's run monitoring directly in Fabric, deep-linking to the most recent run — so you can jump straight to the logs of a failed run instead of navigating through Fabric's menus. Falls back to the pipeline editor for never-run pipelines

## [1.6.0] - 2026-05-28

### Added
- **Dashboard — "Next Run" column**: A new sortable column estimates when each pipeline or semantic model is next scheduled to run (e.g. `in 3h`, `in 2d`). It reads the Fabric job schedule (cron/daily/weekly) and the Power BI refresh schedule, then computes the next occurrence in the schedule's own time zone. Shows `paused` when a schedule is disabled and `—` when none is set; hover for the full schedule description

## [1.5.0] - 2026-05-22

### Added
- **Overview — table filter**: A "Filter tables…" input in the "Largest tables" section header lets you search the ranked list by table name (or `schema.table`) in real time; resets automatically when switching schema
- **Overview — refresh size**: Each measured row now shows a ↻ button that re-triggers the size computation for that individual table on demand — useful after a Vacuum or data update. A ⏳ spinner replaces the button while the recomputation is in progress

### Fixed
- **Overview modal styling**: The modal layout (stat cards, schema pills, type badges, maintenance buttons) was broken due to smart/curly quotes (`"` `"`) in the generated HTML attributes — `querySelector` could not match any class, so no inline styles were applied. All occurrences have been replaced with straight ASCII quotes

## [1.4.2] - 2026-05-21

### Changed
- **Sign-in page**: The browser tab shown after an interactive Microsoft sign-in now displays a styled FabricPulse page (distinct success and error states) instead of plain text

## [1.4.1] - 2026-05-21

### Fixed
- **Table size recompute**: The size cell is now a button — clicking a computed size recomputes it (e.g. after a Vacuum), instead of being a static value
- **Expand race condition**: Rapidly expanding different lakehouses could display one lakehouse's tables under another; the stale result is now discarded
- **Maintenance polling**: A background maintenance job now polls with the tenant captured at trigger time, so switching the active tenant mid-job no longer breaks status tracking
- **Table name validation**: Maintenance no longer rejects valid table names that start with a digit or contain hyphens (the previous check was overly strict)

### Changed
- Removed verbose debug logging from the table-maintenance request path
- Computed table sizes are cached for the session and survive a refresh or collapse/expand
- Removed duplicate toast notifications on maintenance trigger and connection-string copy

## [1.4.0] - 2026-05-21

### Added
- **Schema-enabled lakehouse tables**: Tables in schema-enabled lakehouses are now listed by walking the OneLake directory structure (the Fabric "List Tables" API does not support them); they can be expanded like any other lakehouse
- **Table size**: New "Size" column with an on-demand button that computes a table's on-disk footprint by recursively summing its OneLake file sizes

### Changed
- **Tables column**: The expand control is now a labelled pill button (`▸ N tables`) instead of a small arrow, making it easier to discover

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
