import { cp, mkdir, readFile, rm } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = fileURLToPath(new URL('../', import.meta.url));
const destination = path.join(root, 'dist');
await rm(destination, { recursive: true, force: true });
await mkdir(destination, { recursive: true });
await cp(path.join(root, 'extension'), destination, { recursive: true });
for (const name of ['core', 'policy', 'stats', 'adapters', 'content']) {
  await cp(path.join(root, 'src', `${name}.js`), path.join(destination, `${name}.js`));
}

const manifest = JSON.parse(await readFile(path.join(destination, 'manifest.json'), 'utf8'));
console.log(`Built CkretGuard ${manifest.version} → ${destination}`);
