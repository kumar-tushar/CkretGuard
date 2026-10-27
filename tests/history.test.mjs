import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { webcrypto } from 'node:crypto';
import vm from 'node:vm';

const source = await readFile(new URL('../src/history.js', import.meta.url), 'utf8');
const worker = await readFile(new URL('../extension/background.js', import.meta.url), 'utf8');
const core = await readFile(new URL('../src/core.js', import.meta.url), 'utf8');
const policy = await readFile(new URL('../src/policy.js', import.meta.url), 'utf8');
function harness(cleanup = false) {
  let listener, alarmListener;
  const messages = [];
  const cleanups = [], alarms = [];
  const context = vm.createContext({ URL, crypto: webcrypto,
    chrome: { runtime: { id: 'test-extension', onInstalled: { addListener: () => {} }, onMessage: { addListener: value => { listener = value; } },
      sendMessage: async message => { messages.push(message); return { ok: true, entries: [] }; } } },
    importScripts: () => {},
  });
  if (cleanup) context.chrome.alarms = { create: async (...args) => { alarms.push(args); },
    onAlarm: { addListener: value => { alarmListener = value; } } };
  vm.runInContext(source, context);
  vm.runInContext(core, context);
  vm.runInContext(policy, context);
  if (cleanup) context.SecretShieldHistory = { ...context.SecretShieldHistory,
    perform: async action => { cleanups.push(action); return { removed: 1 }; } };
  vm.runInContext(worker, context);
  return { history: context.SecretShieldHistory, messages, context, cleanups, alarms,
    alarm: name => alarmListener({ name }), settled: () => vm.runInContext('pending', context),
    send: (message, sender) => new Promise(resolve => listener({ type: 'ckretguard-history', ...message }, sender, resolve)) };
}
test('history preserves complete prompts and keeps only supported conversation links', () => {
  const { history } = harness();
  const prompt = 'api_key=synthetic-123\n' + 'full prompt '.repeat(12000);
  for (const [url, site, saved] of [
    ['https://chatgpt.com/c/abc-123?token=private#secret', 'ChatGPT', 'https://chatgpt.com/c/abc-123'],
    ['https://chat.openai.com/c/old-123', 'ChatGPT', 'https://chat.openai.com/c/old-123'],
    ['https://claude.ai/chat/abc-123', 'Claude', 'https://claude.ai/chat/abc-123'],
    ['https://gemini.google.com/app/abc123?token=private#secret', 'Gemini', 'https://gemini.google.com/app/abc123'],
    ['https://gemini.google.com/u/1/app/abc123', 'Gemini', 'https://gemini.google.com/u/1/app/abc123'],
    ['https://chat.deepseek.com/a/chat/s/abc-123?token=private', 'DeepSeek', 'https://chat.deepseek.com/a/chat/s/abc-123'],
    ['https://grok.com/c/abc-123?token=private#secret', 'Grok', 'https://grok.com/c/abc-123'],
    ['https://www.meta.ai/c/abc-123?token=private#secret', 'Meta AI', 'https://www.meta.ai/c/abc-123'],
    ['https://www.meta.ai/prompt/abc-123?token=private#secret', 'Meta AI', 'https://www.meta.ai/prompt/abc-123'],
    ['https://meta.ai/prompt/abc-123?token=private', 'Meta AI', 'https://meta.ai/prompt/abc-123'],
    ['https://meta.ai/c/abc-123?token=private', 'Meta AI', 'https://meta.ai/c/abc-123'],
    ['https://copilot.microsoft.com/chat/conversation/abc-123?token=private#secret', 'Microsoft Copilot', 'https://copilot.microsoft.com/chat/conversation/abc-123'],
    ['https://copilot.microsoft.com/chats/abc-123?token=private#secret', 'Microsoft Copilot', 'https://copilot.microsoft.com/chats/abc-123'],
    ['https://copilot.com/chat/conversation/abc-123?token=private#secret', 'Microsoft Copilot', 'https://copilot.com/chat/conversation/abc-123'],
    ['https://copilot.com/chats/abc-123?token=private#secret', 'Microsoft Copilot', 'https://copilot.com/chats/abc-123'],
    ['https://copilot.cloud.microsoft/chat/conversation/abc-123?token=private#secret', 'Microsoft Copilot', 'https://copilot.cloud.microsoft/chat/conversation/abc-123'],
    ['https://copilot.cloud.microsoft/chats/abc-123?token=private#secret', 'Microsoft Copilot', 'https://copilot.cloud.microsoft/chats/abc-123'],
    ['https://m365.cloud.microsoft/chat/conversation/abc-123?token=private#secret', 'Microsoft Copilot', 'https://m365.cloud.microsoft/chat/conversation/abc-123'],
    ['https://m365.cloud.microsoft/chats/abc-123?token=private#secret', 'Microsoft Copilot', 'https://m365.cloud.microsoft/chats/abc-123'],
    ['https://www.perplexity.ai/search/dummy-query_abc-123?token=private#secret', 'Perplexity', 'https://www.perplexity.ai/search/dummy-query_abc-123'],
    ['https://perplexity.ai/search/dummy-query_abc-123?token=private#secret', 'Perplexity', 'https://perplexity.ai/search/dummy-query_abc-123'],
    ['https://chat.mistral.ai/chat/abc-123?token=private#secret', 'Mistral', 'https://chat.mistral.ai/chat/abc-123'],
    ['https://chat.mistral.ai/work/abc-123?token=private#secret', 'Mistral', 'https://chat.mistral.ai/work/abc-123'],
    ['https://www.perplexity.ai/search/private.email@example.invalid', 'Perplexity', 'https://www.perplexity.ai/'],
    ['https://copilot.cloud.microsoft/unknown/private-value', 'Microsoft Copilot', 'https://copilot.cloud.microsoft/'],
    ['https://chat.mistral.ai/unknown/private-value', 'Mistral', 'https://chat.mistral.ai/'],
    ['https://www.meta.ai/unknown/private-value', 'Meta AI', 'https://www.meta.ai/'],
    ['https://gemini.google.com/unknown/private-value', 'Gemini', 'https://gemini.google.com/'],
    ['https://chat.deepseek.com/unknown/private-value', 'DeepSeek', 'https://chat.deepseek.com/'],
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
    'https://claude.ai:444/', 'https://gemini.google.com.attacker.invalid/app/abc', 'https://chat.deepseek.com.attacker.invalid/',
    'https://gemini.google.com:444/', 'https://user:pass@chat.deepseek.com/', 'https://grok.com.attacker.invalid/',
    'https://www.meta.ai.attacker.invalid/', 'https://meta.ai.attacker.invalid/', 'http://grok.com/',
    'https://meta.ai:444/', 'https://user:pass@www.meta.ai/', 'https://copilot.com.attacker.invalid/', 'https://copilot.cloud.microsoft.attacker.invalid/', 'https://www.perplexity.ai:444/', 'https://chat.mistral.ai.attacker.invalid/', 'javascript:alert(1)', undefined]) assert.throws(() => history.entry('key=synthetic-123', 1, url));
  for (const prompt of ['', '  ', null, 123, {}]) assert.throws(() => history.entry(prompt, 1, 'https://chatgpt.com/'));
  for (const count of [0, -1, 1.5, '2', null, Infinity]) assert.throws(() => history.entry('key=synthetic-123', count, 'https://chatgpt.com/'));
});
test('history read and deletion messages are rejected outside the extension dashboard', async () => {
  const { send } = harness();
  for (const url of ['https://chatgpt.com/composer.html', 'file:///composer.html', 'chrome-extension://other/composer.html',
    'chrome-extension://test-extension/other.html', undefined]) {
    for (const action of ['list', 'read', 'remove', 'clear']) {
      assert.equal((await send({ action, id: 'a'.repeat(36) }, { id: 'test-extension', url })).ok, false);
    }
  }
  assert.equal((await send({ action: 'list' }, { id: 'other', url: 'chrome-extension://test-extension/composer.html' })).ok, false);
});
test('History cleanup runs on worker start and its hourly alarm', async () => {
  const state = harness(true);
  await state.settled();
  assert.equal(state.history.RETENTION_DAYS, 90);
  assert.equal(state.alarms[0][0], 'history-retention');
  assert.equal(state.alarms[0][1].periodInMinutes, 60);
  assert.deepEqual(state.cleanups, ['prune']);
  state.alarm('unrelated');
  state.alarm('history-retention');
  await state.settled();
  assert.deepEqual(state.cleanups, ['prune', 'prune']);
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
