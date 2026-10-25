import test from 'node:test';
import assert from 'node:assert/strict';
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { tmpdir } from 'node:os';
import path from 'node:path';
import vm from 'node:vm';

async function fixture() {
  const root = await mkdtemp(path.join(tmpdir(), 'ckretguard-build-test-'));
  await Promise.all(['scripts', 'src', 'extension'].map(name => mkdir(path.join(root, name))));
  await cp(new URL('../scripts/build.mjs', import.meta.url), path.join(root, 'scripts/build.mjs'));
  await writeFile(path.join(root, 'extension/manifest.json'), JSON.stringify({ version: '1.0.0' }));
  for (const name of ['core', 'policy', 'stats', 'history', 'adapters', 'content']) await writeFile(path.join(root, `src/${name}.js`), `globalThis.${name} = 'complete';\n`);
  return root;
}
function build(root, inspect = false) {
  const child = spawn(process.execPath, ['scripts/build.mjs'], { cwd: root, stdio: 'ignore' });
  let running = true;
  const completion = new Promise((resolve, reject) => {
    child.on('error', reject);
    child.on('close', code => { running = false; code === 0 ? resolve() : reject(new Error(`Build exited ${code}`)); });
  });
  return (async () => {
    let reads = 0;
    while (inspect && running) {
      for (const name of ['core', 'policy', 'stats', 'history', 'adapters', 'content']) {
        const source = await readFile(path.join(root, `dist/${name}.js`), 'utf8');
        assert.match(source, /complete/);
        new vm.Script(source);
        reads++;
      }
      JSON.parse(await readFile(path.join(root, 'dist/manifest.json'), 'utf8'));
    }
    await completion;
    return reads;
  })();
}

test('rebuilding never removes or exposes partial scripts in a loaded extension directory', async () => {
  const root = await fixture();
  try {
    await build(root);
    await writeFile(path.join(root, 'dist/obsolete.js'), 'obsolete');
    let reads = 0;
    for (let i = 0; i < 5; i++) reads += await build(root, true);
    assert.ok(reads > 0);
    await assert.rejects(readFile(path.join(root, 'dist/obsolete.js')), { code: 'ENOENT' });
    assert.equal(await readFile(path.join(root, 'dist/core.js'), 'utf8'), await readFile(path.join(root, 'src/core.js'), 'utf8'));
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('a failed preparation preserves the previously working extension build', async () => {
  const root = await fixture();
  try {
    await build(root);
    const original = await readFile(path.join(root, 'dist/core.js'), 'utf8');
    await rm(path.join(root, 'src/core.js'));
    await assert.rejects(build(root));
    assert.equal(await readFile(path.join(root, 'dist/core.js'), 'utf8'), original);
  } finally { await rm(root, { recursive: true, force: true }); }
});
