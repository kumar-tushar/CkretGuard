import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';

const worker = await readFile(new URL('../extension/background.js', import.meta.url), 'utf8');
const manifest = JSON.parse(await readFile(new URL('../extension/manifest.json', import.meta.url), 'utf8'));
function harness(queryFailure = false) {
  let installed;
  const queries = [], scripts = [], styles = [];
  const context = vm.createContext({
    importScripts() {},
    chrome: {
      runtime: { onInstalled: { addListener: listener => { installed = listener; } }, onMessage: { addListener() {} }, getManifest: () => manifest },
      tabs: { query: async options => { queries.push(options); if (queryFailure) throw new Error('Access restricted'); return [{ id: 1 }, { id: 2 }, {}]; } },
      scripting: {
        executeScript: async value => { scripts.push(value); if (value.target.tabId === 1) throw new Error('Tab closed'); },
        insertCSS: async value => { styles.push(value); if (value.target.tabId === 2) throw new Error('Tab changed'); },
      },
    },
  });
  vm.runInContext(worker, context);
  return { queries, scripts, styles, installed };
}
test('install and update recovery targets only supported tabs and tolerates independent injection failures', async () => {
  const state = harness();
  await state.installed({ reason: 'update' });
  assert.deepEqual(JSON.parse(JSON.stringify(state.queries)), [{ url: manifest.content_scripts[0].matches }]);
  assert.deepEqual(state.scripts.map(item => item.target.tabId), [1, 2]);
  assert.deepEqual(state.styles.map(item => item.target.tabId), [1, 2]);
  for (const item of state.scripts) {
    assert.equal(item.injectImmediately, true);
    assert.equal(item.files, manifest.content_scripts[0].js);
    assert.equal(Object.hasOwn(item.target, 'allFrames'), false);
  }
  await state.installed({ reason: 'install' });
  assert.equal(state.scripts.length, 4);
});
test('recovery contains unavailable tab access without an unhandled rejection', async () => {
  const state = harness(true);
  await state.installed({ reason: 'update' });
  assert.equal(state.scripts.length, 0);
});
