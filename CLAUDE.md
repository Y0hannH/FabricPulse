# FabricPulse — working notes

A VS Code extension that monitors Microsoft Fabric pipelines (plus semantic models, notebooks,
copy jobs, dbt jobs and lakehouses) without leaving the editor. Run history is stored locally in
SQLite (`sql.js`); the Fabric REST API is the only external service it talks to.

Part of the Pulse Suite. Build layout, tsconfig and ESLint config are shared across all four
extensions — see `HARMONISATION.md` in the parent folder before changing any of them.

## Commands

```bash
npm run compile     # esbuild → dist/extension.js (+ sql-wasm.wasm copied next to it)
npm run watch       # esbuild in watch mode
npm run typecheck   # tsc --noEmit (tsc never emits here; esbuild does)
npm run lint
npm run vsix        # installable .vsix
```

`F5` in VS Code launches an Extension Development Host with the extension loaded.

## Two runtime layouts to keep in mind

- **`dist/`** holds the bundle *and* `sql-wasm.wasm`. `storageService.ts` resolves the binary via
  `__dirname`, so the copy step in `esbuild.js` is not optional — dropping it breaks storage at
  startup, not at build time.
- **`src/webview/`** is read from disk at runtime by the panels and is therefore shipped in the
  VSIX (see the negation in `.vscodeignore`). Those `.js`/`.css` files are hand-written browser
  code, not bundled and not linted.

## Conventions

- The polling loop must never be able to stop for good: schedule the next tick *before* awaiting a
  refresh, cap token acquisition, and release the loading flag on a stuck refresh. Regressions here
  are invisible until the panel silently stops updating (see the 1.9.1 changelog entry).
- A first 401 drops the access token only, and the request is replayed once. The credential — and
  its refresh token — is discarded only if the replay also fails. Don't "simplify" that back into a
  full sign-in on any 401.
- Failures surface through the dashboard's re-auth banner (`onDidChangeAuthState`), not by opening
  a browser tab unannounced.
- Comments explain *why* a boundary is where it is, not what the code does. Match that density.
- These notes are in English, like the rest of the repo (README, code comments, commit messages).
