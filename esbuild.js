const esbuild = require('esbuild');
const fs = require('fs');
const path = require('path');

const production = process.argv.includes('--production');

async function main() {
  // Ensure output directory exists
  if (!fs.existsSync('out')) fs.mkdirSync('out');

  await esbuild.build({
    entryPoints: ['src/extension.ts'],
    bundle: true,
    outfile: 'out/extension.js',
    external: ['vscode'],
    format: 'cjs',
    platform: 'node',
    target: 'node18',
    sourcemap: !production,
    minify: production,
  });

  // Copy sql.js WASM binary to out/ so it can be found at runtime via __dirname
  const wasmSource = path.join(__dirname, 'node_modules', 'sql.js', 'dist', 'sql-wasm.wasm');
  const wasmDest = path.join(__dirname, 'out', 'sql-wasm.wasm');
  fs.copyFileSync(wasmSource, wasmDest);

  console.log(`Build complete (${production ? 'production' : 'development'})`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
