const esbuild = require('esbuild');
const fs = require('fs');
const path = require('path');

const production = process.argv.includes('--production');
const watch = process.argv.includes('--watch');

/** @type {import('esbuild').BuildOptions} */
const options = {
  entryPoints: ['src/extension.ts'],
  bundle: true,
  outfile: 'dist/extension.js',
  external: ['vscode'],
  // @azure/identity pulls in "open" (ESM-only, resolves its xdg-open helper via
  // import.meta.url). esbuild's CJS output turns import.meta into `{}`, so the
  // shim replaces it with vscode.env.openExternal.
  alias: { open: './src/shims/open.ts' },
  format: 'cjs',
  platform: 'node',
  target: 'node18',
  sourcemap: !production,
  minify: production,
  logLevel: 'info',
};

/** sql.js loads its WASM binary from __dirname at runtime (see storageService.ts),
 *  so it has to sit next to the bundle. */
function copyWasm() {
  fs.copyFileSync(
    path.join(__dirname, 'node_modules', 'sql.js', 'dist', 'sql-wasm.wasm'),
    path.join(__dirname, 'dist', 'sql-wasm.wasm'),
  );
}

async function main() {
  // Repartir d'un dist/ propre : un bundle périmé laissé là finirait dans le VSIX.
  fs.rmSync('dist', { recursive: true, force: true });
  fs.mkdirSync('dist');

  if (watch) {
    const ctx = await esbuild.context(options);
    await ctx.watch();
    copyWasm();
    return;
  }

  await esbuild.build(options);
  copyWasm();
  console.log(`Build complete (${production ? 'production' : 'development'})`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
