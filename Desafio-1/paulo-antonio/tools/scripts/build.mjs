import { build } from 'esbuild';
import { fileURLToPath } from 'node:url';
await build({
  entryPoints: [fileURLToPath(new URL('../src/lambda.ts', import.meta.url))],
  outfile: fileURLToPath(new URL('../build/index.js', import.meta.url)),
  bundle: true, platform: 'node', target: 'node22', format: 'cjs', sourcemap: false,
});
