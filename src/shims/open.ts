import * as vscode from 'vscode';

/**
 * Shim for the `open` npm package.
 * `@azure/identity` uses `open` to launch the browser during interactive auth.
 * The real `open` package is ESM-only and breaks esbuild CJS bundling,
 * so we replace it with VS Code's native API which does the same thing.
 */
async function open(target: string): Promise<void> {
  await vscode.env.openExternal(vscode.Uri.parse(target));
}

export = open;
