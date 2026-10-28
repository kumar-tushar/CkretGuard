import { cp, mkdir, mkdtemp, readFile, readdir, rename, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = fileURLToPath(new URL('../', import.meta.url));
const destination = path.join(root, 'dist');
const staging = await mkdtemp(path.join(tmpdir(), 'ckretguard-build-'));
async function files(directory, prefix = '') {
  const result = [];
  for (const item of await readdir(directory, { withFileTypes: true })) {
    const relative = path.join(prefix, item.name);
    if (item.isDirectory()) result.push(...await files(path.join(directory, item.name), relative));
    else result.push(relative);
  }
  return result;
}
try {
  await cp(path.join(root, 'extension'), staging, { recursive: true });
  for (const name of ['gitleaks-rules', 'core', 'policy', 'stats', 'history', 'adapters', 'content']) {
    await cp(path.join(root, 'src', `${name}.js`), path.join(staging, `${name}.js`));
  }
  const manifest = JSON.parse(await readFile(path.join(staging, 'manifest.json'), 'utf8'));
  const next = await files(staging);
  await mkdir(destination, { recursive: true });
  const previous = await files(destination);
  // Keep loaded scripts available; each file is replaced only after its copy is complete.
  for (const relative of [...next.filter(name => name !== 'manifest.json'), 'manifest.json']) {
    const target = path.join(destination, relative), temporary = `${target}.${process.pid}.tmp`;
    await mkdir(path.dirname(target), { recursive: true });
    try {
      await cp(path.join(staging, relative), temporary);
      await rename(temporary, target);
    } finally { await rm(temporary, { force: true }); }
  }
  for (const relative of previous) {
    if (!next.includes(relative)) await rm(path.join(destination, relative), { force: true });
  }
  console.log(`Built CkretGuard ${manifest.version} → ${destination}`);
} finally { await rm(staging, { recursive: true, force: true }); }
