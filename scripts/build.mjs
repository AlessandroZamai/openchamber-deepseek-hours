import { copyFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

const packageDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const outDir = path.join(packageDir, 'build');

await mkdir(outDir, { recursive: true });

await build({
  entryPoints: [path.join(packageDir, 'src/main.js')],
  bundle: true,
  format: 'iife',
  platform: 'browser',
  target: 'chrome110',
  minify: true,
  outfile: path.join(outDir, 'main.js'),
  logLevel: 'info',
});

for (const surface of ['panel', 'status']) {
  const directory = path.join(packageDir, surface);
  await mkdir(directory, { recursive: true });
  await copyFile(path.join(outDir, 'main.js'), path.join(directory, 'main.js'));
  await copyFile(path.join(packageDir, 'src/styles.css'), path.join(directory, 'styles.css'));
}

console.log('Built panel/ and status/ bundles.');
