import { test, expect, chromium } from '@playwright/test';
import { readFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
const root = process.cwd();
let context, dashboard, worker, extensionId;
const logs = () => dashboard.evaluate(() => SecretShieldDebug.request('export'));
const events = async () => (await logs()).entries.map(entry => entry.event);
async function openLogs() {
  await dashboard.goto(`chrome-extension://${extensionId}/composer.html#debug`);
  await expect(dashboard.locator('#debug-status')).toContainText('Logging automatically');
}
async function chat(host) {
  const page = await context.newPage();
  await page.goto(`https://${host}/${host === 'claude.ai' ? 'chat' : 'c'}/synthetic-debug?private=never-log-this`);
  const tabId = await worker.evaluate(async host => (await chrome.tabs.query({ url: `https://${host}/*` }))[0].id, host);
  await expect.poll(() => worker.evaluate(async id => (await chrome.tabs.sendMessage(id, { type: 'coverage' })).ready, tabId)).toBe(true);
  return { page, tabId };
}
async function choose(page, action) {
  const before = await page.evaluate(() => window.sent.length);
  const editor = page.locator('textarea,[contenteditable]');
  await editor.fill('api_key=synthetic-debug-value-123\nclient_secret=synthetic-debug-value-456');
  await editor.press('Enter');
  await expect(page.getByRole('dialog')).toBeVisible();
  await page.getByRole('dialog').getByRole('button', { name: action, exact: true }).click();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  if (action !== 'Edit') await expect.poll(() => page.evaluate(() => window.sent.length)).toBe(before + 1);
}
test.beforeAll(async () => {
  const extension = path.join(root, 'dist');
  context = await chromium.launchPersistentContext('', { channel: 'chromium', headless: true, reducedMotion: 'reduce',
    args: [`--disable-extensions-except=${extension}`, `--load-extension=${extension}`] });
  worker = context.serviceWorkers()[0] ?? await context.waitForEvent('serviceworker');
  extensionId = new URL(worker.url()).hostname;
  await context.route(/^https:\/\/(chatgpt\.com|claude\.ai)\//, route => route.fulfill({ contentType: 'text/html', body: `<!doctype html><html lang="en"><head><title>Synthetic debug test</title></head><body><form>
    ${new URL(route.request().url()).hostname === 'claude.ai' ? '<div contenteditable="true" data-testid="chat-input" style="white-space:pre-wrap;min-height:80px"></div>' : '<textarea id="prompt-textarea"></textarea>'}
    <button data-testid="send-button" aria-label="Send message">Send</button></form>
    <script>window.sent=[];const editor=document.querySelector('textarea,[contenteditable]');const send=()=>window.sent.push(editor.value??editor.innerText);
    editor.addEventListener('keydown',event=>{if(event.key==='Enter'&&!event.shiftKey){event.preventDefault();send();}});
    document.querySelector('form').addEventListener('submit',event=>{event.preventDefault();send();});</script></body></html>` }));
  dashboard = await context.newPage();
  await dashboard.goto(`chrome-extension://${extensionId}/composer.html#debug`);
});
test.afterEach(async () => {
  for (const page of context.pages()) if (page !== dashboard) await page.close();
  await worker.evaluate(() => { if (globalThis.restoreDebugStorage) { restoreDebugStorage(); delete globalThis.restoreDebugStorage; } });
  await dashboard.evaluate(async () => {
    await SecretShieldDebug.request('clear');
    await SecretShieldHistory.request('clear');
  });
});
test.afterAll(async () => { await context?.close(); });

test('Debug Logs captures immediately without recording controls and matches the existing typography without nested scrolling', async () => {
  await expect(dashboard.locator('#debug-view')).toBeVisible();
  await expect(dashboard.locator('#debug-status')).toContainText('Logging automatically');
  await expect(dashboard.locator('#debug-toggle')).toHaveCount(0);
  await expect(dashboard.getByRole('button', { name: /Start recording|Stop recording/ })).toHaveCount(0);
  await expect(dashboard.locator('#debug-list')).toHaveCSS('overflow-y', 'visible');
  for (const width of [410, 661, 1280]) {
    await dashboard.setViewportSize({ width, height: 850 });
    expect(await dashboard.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await expect(dashboard.locator('#debug-view')).toHaveCSS('font-size', '12px');
    await expect(dashboard.locator('#debug-view')).toHaveCSS('line-height', '16px');
  }
  const { page } = await chat('chatgpt.com');
  await choose(page, 'Mask');
  await expect.poll(events).toContain('mask.applied');
});

for (const host of ['chatgpt.com', 'claude.ai']) for (const action of ['Send', 'Edit', 'Mask']) test(`${host}: debug timeline records ${action} without prompts or secrets`, async () => {
  await openLogs();
  const { page } = await chat(host);
  await choose(page, action);
  await expect.poll(events).toContain('review.choice');
  if (action !== 'Edit') await expect.poll(events).toContain('send.activated');
  const state = await logs(), choice = state.entries.find(entry => entry.event === 'review.choice');
  expect(choice.details.attempt).toMatch(/^[a-f0-9-]{36}$/);
  expect(choice.details.action).toBe(action); expect(choice.site).toBe(host === 'claude.ai' ? 'Claude' : 'ChatGPT');
  const attempt = state.entries.filter(entry => entry.details.attempt === choice.details.attempt);
  expect(attempt.map(entry => entry.event)).toEqual(expect.arrayContaining(['prompt.scanned', 'review.opened', 'review.choice', 'review.closed']));
  expect(attempt.find(entry => entry.event === 'prompt.scanned').details).toMatchObject({ count: 2 });
  expect(JSON.stringify(state)).not.toMatch(/synthetic-debug-value|client_secret|api_key=|never-log-this|private=/);
  expect(await page.evaluate(() => window.sent)).toEqual(action === 'Edit' ? [] :
    [action === 'Mask' ? 'api_key=xxxxxxxxxx\nclient_secret=xxxxxxxxxx' : 'api_key=synthetic-debug-value-123\nclient_secret=synthetic-debug-value-456']);
  if (action === 'Mask') expect(attempt.map(entry => entry.event)).toContain('mask.applied');
  if (action === 'Edit') expect(attempt.map(entry => entry.event)).not.toContain('send.activated');
});

test('automatic debug logging exports safe JSON, survives page reload, and clearing does not stop capture or change History', async () => {
  await openLogs();
  const { page } = await chat('chatgpt.com'); await choose(page, 'Send');
  await expect.poll(events).toContain('history.recorded');
  const saved = await dashboard.evaluate(async () => ({ activity: await SecretShieldStats.read(), history: await SecretShieldHistory.request('list') }));
  await dashboard.reload();
  await expect(dashboard.locator('#debug-status')).toContainText('Logging automatically');
  const download = dashboard.waitForEvent('download');
  await dashboard.locator('#debug-export').click();
  const file = await download, exported = JSON.parse(await readFile(await file.path(), 'utf8'));
  expect(file.suggestedFilename()).toMatch(/^ckretguard-debug-.*\.json$/);
  expect(exported).toMatchObject({ version: '1.0.0', deliveryConfirmed: false, includesPromptText: false });
  expect(exported.entries.some(entry => entry.event === 'send.activated')).toBe(true);
  expect(JSON.stringify(exported)).not.toMatch(/synthetic-debug-value|never-log-this|private=/);
  await dashboard.locator('#debug-clear').click();
  await expect(dashboard.locator('#debug-list li')).toHaveCount(0);
  expect(await dashboard.evaluate(() => SecretShieldHistory.request('list'))).toEqual(saved.history);
  expect(await dashboard.evaluate(() => SecretShieldStats.read())).toEqual(saved.activity);
  await choose(page, 'Mask');
  await expect.poll(events).toContain('mask.applied');
  await dashboard.reload();
  await expect.poll(events).toContain('mask.applied');
});

test('extension errors and console activity are sanitized, and logging storage failures never prevent Mask or Send', async () => {
  await openLogs();
  const { page, tabId } = await chat('claude.ai');
  await worker.evaluate(async id => chrome.scripting.executeScript({ target: { tabId: id }, func: () => {
    const error = new TypeError('api_key=never-store-error-content');
    error.stack = `TypeError: secret\n at guard (${chrome.runtime.getURL('content.js')}:12:34)`;
    window.dispatchEvent(new ErrorEvent('error', { error, filename: chrome.runtime.getURL('content.js'), lineno: 12, colno: 34 }));
    console.warn('client_secret=never-store-console-content');
    crypto.randomUUID = () => { throw new Error('Synthetic diagnostic ID failure'); };
  } }), tabId);
  await expect.poll(events).toContain('runtime.error');
  await expect.poll(events).toContain('console.message');
  const state = await logs();
  expect(state.entries.find(entry => entry.event === 'runtime.error').details).toMatchObject({ errorName: 'TypeError', file: 'content.js', line: 12, column: 34 });
  expect(state.entries.find(entry => entry.event === 'console.message').details).toMatchObject({ method: 'warn', arguments: 1 });
  expect(JSON.stringify(state)).not.toMatch(/never-store-error-content|never-store-console-content/);
  await dashboard.bringToFront();
  await expect(dashboard.locator('.debug-entry').filter({ hasText: 'Extension console output' }).locator('strong')).toHaveClass('debug-level-warn');
  const download = dashboard.waitForEvent('download');
  await dashboard.locator('#debug-export').click();
  const exported = JSON.parse(await readFile(await (await download).path(), 'utf8'));
  expect(exported.entries.find(entry => entry.event === 'console.message').level).toBe('warn');
  await worker.evaluate(() => {
    const original = indexedDB.open.bind(indexedDB);
    globalThis.restoreDebugStorage = () => { indexedDB.open = original; };
    indexedDB.open = (...args) => { if (args[0] === 'ckretguard-debug') throw new Error('Synthetic diagnostic database failure'); return original(...args); };
  });
  await choose(page, 'Mask'); await choose(page, 'Send');
  await expect.poll(() => page.evaluate(() => window.sent.length)).toBe(2);
});

test('debug timeline shows scan failures and disabled send controls without claiming delivery', async () => {
  await openLogs();
  const { page } = await chat('chatgpt.com');
  await page.locator('textarea').fill('Authorization: Bearer');
  await page.locator('textarea').press('Enter');
  await expect.poll(events).toContain('prompt.scan_failed');
  await page.locator('textarea').fill('api_key=synthetic-debug-unavailable-123');
  await page.locator('textarea').press('Enter');
  await page.getByRole('button', { name: 'Send message', exact: true }).evaluate(button => { button.disabled = true; });
  await page.getByRole('dialog').getByRole('button', { name: 'Mask', exact: true }).click();
  await expect.poll(events).toContain('send.failed');
  expect(await page.evaluate(() => window.sent)).toEqual([]);
  expect(await events()).not.toContain('send.activated');
  await dashboard.setViewportSize({ width: 1000, height: 850 });
  await dashboard.bringToFront();
  await mkdir(path.join(root, 'artifacts'), { recursive: true });
  await dashboard.screenshot({ path: 'artifacts/debug-logs-preview.png', fullPage: true });
});

for (const host of ['chatgpt.com', 'claude.ai']) test(`${host}: recording and the current draft survive an extension reload`, async () => {
  const extensions = await context.newPage();
  await extensions.goto('chrome://extensions');
  const toggle = extensions.locator('extensions-toolbar #devMode');
  await expect(toggle).toBeVisible();
  await toggle.evaluate(element => { if (!element.checked) element.click(); });
  await extensions.close();
  await openLogs();
  const { page, tabId } = await chat(host);
  const draft = 'api_key=synthetic-debug-reload-123';
  await page.locator('textarea,[contenteditable]').fill(draft);
  const ids = (await logs()).entries.map(entry => entry.id);
  const replacement = context.waitForEvent('serviceworker');
  await worker.evaluate(() => chrome.runtime.reload()); worker = await replacement;
  await expect.poll(async () => {
    try { return (await worker.evaluate(async id => chrome.tabs.sendMessage(id, { type: 'coverage' }), tabId)).ready; }
    catch { return false; }
  }).toBe(true);
  // Chrome closes extension pages when the unpacked extension reloads; reopen the same logs view.
  if (dashboard.isClosed()) dashboard = await context.newPage();
  await dashboard.goto(`chrome-extension://${extensionId}/composer.html#debug`);
  await expect(dashboard.locator('#debug-toggle')).toHaveCount(0);
  expect((await logs()).entries.map(entry => entry.id)).toEqual(expect.arrayContaining(ids));
  await expect.poll(events).toContain('extension.updated');
  expect(await page.locator('textarea,[contenteditable]').evaluate(editor => editor.value ?? editor.innerText)).toBe(draft);
  await choose(page, 'Mask'); await expect.poll(events).toContain('send.activated');
});

test('automatic logs retain more than 1,000 events for seven days, paginate and export every retained entry', async () => {
  await openLogs();
  await dashboard.evaluate(() => SecretShieldDebug.request('clear'));
  const now = Date.now();
  await worker.evaluate(now => { globalThis.debugOriginalNow = Date.now; Date.now = () => now; }, now);
  await dashboard.evaluate(now => { globalThis.debugOriginalNow = Date.now; Date.now = () => now; }, now);
  try {
    const seeded = await dashboard.evaluate(async now => {
      const db = await new Promise((resolve, reject) => { const open = indexedDB.open('ckretguard-debug', 1); open.onsuccess = () => resolve(open.result); open.onerror = () => reject(open.error); });
      const base = { event: 'prompt.scanned', source: 'content', site: 'ChatGPT', tabId: 42, details: { count: 1 } };
      const entries = Array.from({ length: 1505 }, () => ({ ...base, id: crypto.randomUUID(), time: now - 6 * 86400000 }));
      const boundary = { ...base, id: crypto.randomUUID(), time: now - 7 * 86400000 };
      const expired = { ...base, id: crypto.randomUUID(), time: now - 7 * 86400000 - 1 };
      await new Promise((resolve, reject) => {
        const transaction = db.transaction('events', 'readwrite');
        for (const entry of [...entries, boundary, expired]) transaction.objectStore('events').add(entry);
        transaction.oncomplete = resolve; transaction.onerror = transaction.onabort = () => reject(transaction.error);
      });
      db.close(); return { boundary: boundary.id, expired: expired.id };
    }, now);
    const state = await logs();
    expect(state.count).toBe(1506); expect(state.entries.length).toBe(1506); expect(state.retentionDays).toBe(7);
    expect(state.entries.map(entry => entry.id)).toContain(seeded.boundary);
    expect(state.entries.map(entry => entry.id)).not.toContain(seeded.expired);
    await dashboard.evaluate(() => window.dispatchEvent(new Event('ckretguard-debug-open')));
    await expect(dashboard.locator('#debug-list li')).toHaveCount(200);
    await dashboard.locator('#debug-more').click();
    await expect(dashboard.locator('#debug-list li')).toHaveCount(400);
    await worker.evaluate(() => SecretShieldDebug.write('guard.started'));
    await expect(dashboard.locator('#debug-list li')).toHaveCount(401);
    expect((await logs()).entries.length).toBe(1507);
    const download = dashboard.waitForEvent('download'); await dashboard.locator('#debug-export').click();
    const exported = JSON.parse(await readFile(await (await download).path(), 'utf8'));
    expect(exported.entries.length).toBe(1507);
    const databaseCount = await dashboard.evaluate(async () => {
      const db = await new Promise(resolve => { const open = indexedDB.open('ckretguard-debug', 1); open.onsuccess = () => resolve(open.result); });
      const result = await new Promise(resolve => { const request = db.transaction('events').objectStore('events').count(); request.onsuccess = () => resolve(request.result); });
      db.close(); return result;
    });
    expect(databaseCount).toBe(1507);
  } finally {
    await worker.evaluate(() => { Date.now = debugOriginalNow; delete globalThis.debugOriginalNow; });
    await dashboard.evaluate(() => { Date.now = debugOriginalNow; delete globalThis.debugOriginalNow; });
  }
});

test('the former disabled recording preference cannot stop capture and old logs migrate only once', async () => {
  const now = Date.now(), id = crypto.randomUUID();
  await worker.evaluate(async ({ now, id }) => {
    await new Promise((resolve, reject) => {
      const request = indexedDB.deleteDatabase('ckretguard-debug'); request.onsuccess = resolve; request.onerror = () => reject(request.error);
    });
    await chrome.storage.local.set({ debugLogs: { enabled: false, entries: [{ id, time: now - 6 * 86400000, event: 'prompt.scanned', source: 'worker', details: { count: 2 } }] } });
  }, { now, id });
  const replacement = context.waitForEvent('serviceworker');
  await worker.evaluate(() => chrome.runtime.reload()); worker = await replacement;
  if (dashboard.isClosed()) dashboard = await context.newPage();
  await openLogs();
  await expect.poll(async () => (await logs()).entries.map(entry => entry.id)).toContain(id);
  await expect.poll(events).toContain('worker.started');
  await dashboard.evaluate(() => SecretShieldDebug.request('clear'));
  await worker.evaluate(() => chrome.storage.local.set({ debugLogs: { enabled: false } }));
  await worker.evaluate(() => SecretShieldDebug.write('guard.started'));
  expect((await logs()).entries.map(entry => entry.id)).not.toContain(id);
  await expect.poll(events).toContain('guard.started');
  expect(await dashboard.evaluate(() => SecretShieldDebug.request('toggle', { enabled: false }).then(() => true, () => false))).toBe(false);
});
