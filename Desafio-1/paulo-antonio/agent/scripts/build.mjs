import { build } from 'esbuild';
import { fileURLToPath } from 'node:url';
for (const [entry, output] of [['runtime', 'runtime/index.js'], ['chat-lambda', 'chat/index.js']]) {
  await build({ entryPoints: [fileURLToPath(new URL(`../src/${entry}.ts`, import.meta.url))],
    outfile: fileURLToPath(new URL(`../build/${output}`, import.meta.url)), bundle: true,
    platform: 'node', target: 'node22', format: 'cjs', sourcemap: false });
}
