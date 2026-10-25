import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';

const statsSource = await readFile(new URL('../src/stats.js', import.meta.url), 'utf8');
const historySource = await readFile(new URL('../src/history.js', import.meta.url), 'utf8');
const coreSource = await readFile(new URL('../src/core.js', import.meta.url), 'utf8');
const policySource = await readFile(new URL('../src/policy.js', import.meta.url), 'utf8');
const workerSource = await readFile(new URL('../extension/background.js', import.meta.url), 'utf8');
function store(initial, failFirstWrite = false) {
  let listener, failures = Number(failFirstWrite);
  const saved = initial ? { activity: initial } : {}, writes = [];
  const context = vm.createContext({
    chrome: {
      runtime: { id: 'test-extension', onInstalled: { addListener: () => {} }, onMessage: { addListener: value => { listener = value; } } },
      storage: { local: {
        get: async key => { await new Promise(setImmediate); return { [key]: structuredClone(saved[key]) }; },
        set: async value => {
          if (failures) { failures--; throw new Error('unavailable'); }
          const clean = JSON.parse(JSON.stringify(value));
          writes.push(clean); Object.assign(saved, clean);
        },
      } },
    },
    importScripts: (...names) => names.forEach(name => vm.runInContext({ 'core.js':coreSource, 'policy.js':policySource, 'history.js':historySource, 'stats.js':statsSource }[name], context)),
  });
  vm.runInContext(workerSource, context);
  const send = (kind, count = 1, id = 'test-extension') => new Promise(resolve => {
    listener({ type: 'ckretguard-activity', kind, count }, { id }, result => resolve(JSON.parse(JSON.stringify(result))));
  });
  return { saved, writes, send, context };
}

test('concurrent activity updates preserve totals and store only three numeric counters', async () => {
  const state = store();
  const replies = await Promise.all([
    ...Array.from({ length: 40 }, () => state.send('detected', 2)),
    ...Array.from({ length: 30 }, () => state.send('maskedPrompts')),
    ...Array.from({ length: 30 }, () => state.send('unmaskedPrompts')),
  ]);
  assert.ok(replies.every(reply => reply.ok));
  assert.deepEqual(state.saved, { activity: { detected: 80, maskedPrompts: 30, unmaskedPrompts: 30 } });
  for (const write of state.writes) {
    assert.deepEqual(Object.keys(write), ['activity']);
    assert.deepEqual(Object.keys(write.activity), ['detected', 'maskedPrompts', 'unmaskedPrompts']);
    assert.ok(Object.values(write.activity).every(Number.isSafeInteger));
  }
});
test('invalid increments and other senders cannot change activity', async () => {
  const state = store();
  for (const count of [0, -1, 1.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1, '2', null]) {
    assert.equal((await state.send('detected', count)).ok, false);
  }
  assert.equal((await state.send('unrecognized')).ok, false);
  assert.equal((await state.send('edited')).ok, false);
  assert.equal((await state.send('maskedPrompts', 2)).ok, false);
  assert.equal((await state.send('unmaskedPrompts', 3)).ok, false);
  assert.equal((await state.send('detected', 1, 'another-extension')).ok, false);
  assert.deepEqual(state.saved, {});
  assert.equal(state.writes.length, 0);
});
test('activity repairs invalid stored values and saturates safe integer totals', async () => {
  const state = store({ detected: Number.MAX_SAFE_INTEGER, maskedPrompts: -1, unmaskedPrompts: '8', extra: 'discarded' });
  assert.equal((await state.send('detected', 3)).ok, true);
  assert.deepEqual(state.saved.activity, { detected: Number.MAX_SAFE_INTEGER, maskedPrompts: 0, unmaskedPrompts: 0 });
});
test('a failed activity write does not poison subsequent updates', async () => {
  const state = store(undefined, true);
  assert.equal((await state.send('detected', 2)).ok, false);
  assert.equal((await state.send('maskedPrompts', 1)).ok, true);
  assert.deepEqual(state.saved.activity, { detected: 0, maskedPrompts: 1, unmaskedPrompts: 0 });
});
test('activity client sends only a counter kind and count and contains messaging failures', async () => {
  const state = store();
  const messages = [];
  state.context.chrome.runtime.sendMessage = async message => { messages.push(JSON.parse(JSON.stringify(message))); return { ok: true }; };
  assert.equal(await state.context.SecretShieldStats.record('detected', 2), true);
  assert.deepEqual(messages, [{ type: 'ckretguard-activity', kind: 'detected', count: 2 }]);
  assert.equal(await state.context.SecretShieldStats.record('detected', 0), false);
  assert.equal(messages.length, 1);
  state.context.chrome.runtime.sendMessage = async () => { throw new Error('unavailable'); };
  assert.equal(await state.context.SecretShieldStats.record('maskedPrompts'), false);
});

test('legacy secret totals are not misreported as prompt totals', async () => {
  const state = store({ detected: 15, masked: 8, sent: 5, edited: 6 });
  const counters = await state.context.SecretShieldStats.read();
  assert.deepEqual(JSON.parse(JSON.stringify(counters)), { detected: 15, maskedPrompts: 0, unmaskedPrompts: 0 });
  await state.send('maskedPrompts');
  assert.deepEqual(state.saved.activity, { detected: 15, maskedPrompts: 1, unmaskedPrompts: 0 });
});
