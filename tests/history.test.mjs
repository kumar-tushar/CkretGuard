import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { webcrypto } from 'node:crypto';
import vm from 'node:vm';

const source = await readFile(new URL('../src/history.js', import.meta.url), 'utf8');
const worker = await readFile(new URL('../extension/background.js', import.meta.url), 'utf8');
function harness() {
  let listener;
  const messages = [];
  const context = vm.createContext({ URL, crypto: webcrypto,
    chrome: { runtime: { id: 'test-extension', onMessage: { addListener: value => { listener = value; } },
      sendMessage: async message => { messages.push(message); return { ok: true, entries: [] }; } } },
    importScripts: () => {},
  });
  vm.runInContext(source, context);
  vm.runInContext(worker, context);
  return { history: context.SecretShieldHistory, messages, context,
    send: (message, sender) => new Promise(resolve => listener({ type: 'ckretguard-history', ...message }, sender, resolve)) };
}
test('history preserves complete prompts and keeps only supported conversation links', () => {
  const { history } = harness();
  const prompt = 'api_key=synthetic-123\n' + 'full prompt '.repeat(12000);
  for (const [url, site, saved] of [
    ['https://chatgpt.com/c/abc-123?token=private#secret', 'ChatGPT', 'https://chatgpt.com/c/abc-123'],
    ['https://chat.openai.com/c/old-123', 'ChatGPT', 'https://chat.openai.com/c/old-123'],
    ['https://claude.ai/chat/abc-123', 'Claude', 'https://claude.ai/chat/abc-123'],
    ['https://chatgpt.com/unknown/private-value', 'ChatGPT', 'https://chatgpt.com/'],
  ]) {
    const entry = history.entry(prompt, 2, url);
    assert.equal(entry.prompt, prompt);
    assert.equal(entry.site, site);
    assert.equal(entry.url, saved);
    assert.equal(entry.count, 2);
    assert.ok(Number.isSafeInteger(entry.createdAt));
    assert.match(entry.id, /^[a-f0-9-]{36}$/);
  }
});
test('history rejects unsupported sources and invalid prompt metadata', () => {
  const { history } = harness();
  for (const url of ['http://chatgpt.com/', 'https://chatgpt.com.attacker.invalid/', 'https://user:pass@chatgpt.com/',
    'https://claude.ai:444/', 'javascript:alert(1)', undefined]) assert.throws(() => history.entry('key=synthetic-123', 1, url));
  for (const prompt of ['', '  ', null, 123, {}]) assert.throws(() => history.entry(prompt, 1, 'https://chatgpt.com/'));
  for (const count of [0, -1, 1.5, '2', null, Infinity]) assert.throws(() => history.entry('key=synthetic-123', count, 'https://chatgpt.com/'));
});
test('history read and deletion messages are rejected outside the extension dashboard', async () => {
  const { send } = harness();
  for (const url of ['https://chatgpt.com/composer.html', 'file:///composer.html', 'chrome-extension://other/composer.html',
    'chrome-extension://test-extension/other.html', undefined]) {
    for (const action of ['list', 'remove', 'clear']) {
      assert.equal((await send({ action, id: 'a'.repeat(36) }, { id: 'test-extension', url })).ok, false);
    }
  }
  assert.equal((await send({ action: 'list' }, { id: 'other', url: 'chrome-extension://test-extension/composer.html' })).ok, false);
});
test('history recording requires a supported top-level content script', async () => {
  const { send } = harness();
  for (const sender of [
    { id: 'test-extension', url: 'chrome-extension://test-extension/composer.html' },
    { id: 'test-extension', url: 'https://chatgpt.com/', tab: { id: 1 }, frameId: 2 },
    { id: 'test-extension', url: 'https://example.invalid/', tab: { id: 1 }, frameId: 0 },
  ]) assert.equal((await send({ action: 'record', prompt: 'key=synthetic-123', count: 1 }, sender)).ok, false);
});
test('history client reports failed replies and unavailable messaging', async () => {
  const { history, messages, context } = harness();
  assert.deepEqual(Array.from(await history.request('list')), []);
  assert.equal(messages.length, 1);
  assert.equal(messages[0].action, 'list');
  context.chrome.runtime.sendMessage = async () => ({ ok: false });
  await assert.rejects(history.request('clear'), /History unavailable/);
  context.chrome.runtime.sendMessage = async () => { throw new Error('unavailable'); };
  await assert.rejects(history.request('list'));
});
