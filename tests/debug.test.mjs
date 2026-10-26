import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { webcrypto } from 'node:crypto';
import vm from 'node:vm';
const source = await readFile(new URL('../extension/debug.js', import.meta.url), 'utf8');
const worker = await readFile(new URL('../extension/background.js', import.meta.url), 'utf8');
const plain = value => JSON.parse(JSON.stringify(value));
function harness(client = false) {
  let handler;
  const messages = [], now = Date.now();
  const context = vm.createContext({ URL, crypto: webcrypto, ...(client ? { document: {} } : {}), Date: { now: () => now },
    chrome: { runtime: { id: 'test-extension', getURL: file => `chrome-extension://test-extension/${file}`,
      onInstalled: { addListener() {} }, onMessage: { addListener: listener => { handler = listener; } },
      sendMessage: async message => { messages.push(plain(message)); return { ok: true }; } },
    storage: { local: { get: async () => ({}), set: async () => {} } } }, importScripts() {},
  });
  vm.runInContext(source, context);
  return { debug: context.SecretShieldDebug, context, messages, now,
    worker: () => vm.runInContext(worker, context),
    send: (message, sender) => new Promise(resolve => handler({ type: context.SecretShieldDebug.type, ...message }, sender, resolve)) };
}
const dashboard = { id: 'test-extension', url: 'chrome-extension://test-extension/composer.html' };
const content = { id: 'test-extension', url: 'https://claude.ai/chat/not-saved?token=never-stored', frameId: 0, tab: { id: 7 } };

test('debug clients capture automatically without reading an enable preference or needing a start action', async () => {
  const { debug, context, messages } = harness(true);
  context.chrome.storage.local.get = async () => { throw new Error('Capture must not depend on a preference'); };
  assert.equal(await debug.record('prompt.scanned', { count: 2 }), true);
  assert.equal(await debug.record('review.choice', { action: 'Mask' }), true);
  assert.deepEqual(messages.map(message => message.event), ['prompt.scanned', 'review.choice']);
  assert.throws(() => debug.authorize({ action: 'toggle', enabled: false }, dashboard));
});

test('seven-day retention keeps the exact cutoff and more than 1,000 recent events', () => {
  const { debug, now } = harness();
  const entry = { id: webcrypto.randomUUID(), time: now, event: 'worker.started', source: 'worker', details: {} };
  const entries = Array.from({ length: 1500 }, () => ({ ...entry, id: webcrypto.randomUUID() }));
  entries.push({ ...entry, time: now - debug.RETENTION_MS }, { ...entry, time: now - debug.RETENTION_MS - 1 }, { ...entry, time: now + 1 });
  const state = debug.normalize({ enabled: false, entries });
  assert.equal(debug.RETENTION_DAYS, 7); assert.equal(debug.RETENTION_MS, 7 * 86400000);
  assert.equal(state.entries.length, 1501); assert.equal(state.retentionDays, 7);
  assert.equal(Object.hasOwn(state, 'enabled'), false);
});

test('debug schema discards prompts, field names, URLs, arbitrary messages and unrecognized details', () => {
  const { debug } = harness();
  const clean = debug.details({ prompt: 'api_key=secret-value', field: 'private-dataset', stack: 'secret', url: 'https://secret.invalid', message: 'private',
    count: 2, chars: 27, durationMs: 100, errorName: 'TypeError', reason: 'api_key=secret', file: '/private/secret.txt',
    attempt: 'not-a-session', action: 'private', method: 'error', line: -1 });
  assert.deepEqual(plain(clean), { count: 2, chars: 27, durationMs: 100, method: 'error', errorName: 'TypeError' });
  assert.deepEqual(plain(debug.details(null)), {});
  assert.deepEqual(plain(debug.authorize({ action: 'record', event: 'send.failed' }, content)), { source: 'content', site: 'Claude', tabId: 7 });
  assert.throws(() => debug.authorize({ action: 'record', event: 'constructor' }, content));
});

test('only the extension dashboard can read or clear debug logs; recording controls are rejected', () => {
  const { debug } = harness();
  for (const sender of [content, { ...content, id: 'other' }, { ...content, frameId: 1 },
    { ...content, url: 'https://claude.ai.attacker.invalid' }, { ...content, url: 'http://claude.ai/' },
    { ...dashboard, url: 'chrome-extension://test-extension/other.html' }, { ...dashboard, id: 'other' }]) {
    for (const action of ['list', 'clear']) assert.throws(() => debug.authorize({ action }, sender));
  }
  for (const action of ['list', 'clear']) assert.deepEqual(plain(debug.authorize({ action }, dashboard)), { source: 'dashboard' });
  for (const enabled of [true, false]) assert.throws(() => debug.authorize({ action: 'toggle', enabled }, dashboard));
  assert.throws(() => debug.authorize({ action: 'list', before: { time: -1, id: 'invalid' } }, dashboard));
});

test('diagnostic ID and messaging failures are contained and errors retain only safe locations', async () => {
  const { debug, context } = harness(true);
  context.crypto = { randomUUID: () => { throw new Error('Synthetic ID failure'); } };
  assert.equal(debug.attempt(), undefined);
  context.chrome.runtime.sendMessage = async () => { throw new Error('Synthetic messaging failure'); };
  assert.equal(await debug.record('prompt.scanned'), false);
  assert.equal(await debug.record('unknown-event'), false);
  const error = new TypeError('api_key=do-not-save');
  error.stack = 'TypeError: api_key=do-not-save\n    at send (chrome-extension://test-extension/content.js:123:45)';
  assert.deepEqual(plain(debug.errorDetails(error)), { errorName: 'TypeError', file: 'content.js', line: 123, column: 45 });
});

test('worker debug messages validate senders and never return stored logs to content scripts', async () => {
  const state = harness();
  const calls = [];
  state.context.SecretShieldDebug = { ...state.debug, perform: async (...args) => { calls.push(args); return { entries: [], count: 0, next: null }; } };
  state.worker();
  const response = await state.send({ action: 'record', event: 'prompt.scanned', details: { count: 1 } }, content);
  assert.deepEqual(plain(response), { ok: true });
  for (const action of ['list', 'clear', 'toggle']) assert.equal((await state.send({ action, enabled: false }, content)).ok, false);
  assert.equal((await state.send({ action: 'toggle', enabled: false }, dashboard)).ok, false);
  const listed = await state.send({ action: 'list' }, dashboard);
  assert.equal(listed.ok, true); assert.deepEqual(plain(listed.state.entries), []);
  assert.equal(calls.some(([action]) => action === 'record'), true);
});

test('export retrieves every page rather than truncating to the on-screen batch', async () => {
  const { debug, context, now } = harness(true), entry = { time: now, event: 'worker.started', source: 'worker', details: {} };
  let page = 0;
  context.chrome.runtime.sendMessage = async message => {
    assert.equal(message.action, 'list');
    if (page++) assert.deepEqual(plain(message.before), { time: now, id: 'a'.repeat(36) });
    return { ok: true, state: { entries: [{ ...entry, id: webcrypto.randomUUID() }], count: 2,
      next: page === 1 ? { time: now, id: 'a'.repeat(36) } : null } };
  };
  assert.equal((await debug.request('export')).entries.length, 2);
});
