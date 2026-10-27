import { test, expect, chromium } from '@playwright/test';
import { access, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

const extension = path.resolve('dist');
const launch = profile => chromium.launchPersistentContext(profile, { channel: 'chromium', headless: true, reducedMotion: 'reduce',
  args: ['--disable-extensions-except=' + extension, '--load-extension=' + extension] });
let context, worker, dashboard;

async function openDashboard(browser) {
  const worker = browser.serviceWorkers()[0] ?? await browser.waitForEvent('serviceworker');
  const page = await browser.newPage();
  await page.goto('chrome-extension://' + new URL(worker.url()).hostname + '/composer.html');
  await expect(page.locator('#sensitive-names')).toBeEnabled();
  return { worker, page };
}

test.beforeAll(async () => {
  context = await launch('');
  ({ worker, page: dashboard } = await openDashboard(context));
  await context.route('https://chatgpt.com/**', route => route.fulfill({ contentType: 'text/html', body:
    '<!doctype html><html lang="en"><head><title>Synthetic production chat</title></head><body><textarea id="prompt-textarea"></textarea><button data-testid="send-button" aria-label="Send">Send</button><script>' +
    'document.querySelector("button").addEventListener("click",()=>fetch("/test-submit",{method:"POST",body:document.querySelector("textarea").value}));' +
    '</script></body></html>' }));
});
test.afterEach(async () => {
  for (const page of context.pages()) if (page !== dashboard) await page.close();
  await dashboard.evaluate(async () => { await SecretShieldHistory.request('clear'); await chrome.storage.local.clear(); });
});
test.afterAll(async () => { await context?.close(); });

test('production excludes the log viewer, recording scripts and legacy debug route', async () => {
  for (const file of ['debug.js', 'debug-view.js']) await expect(access(path.join(extension, file))).rejects.toThrow();
  const manifest = await worker.evaluate(() => chrome.runtime.getManifest());
  expect(manifest.content_scripts[0].js).not.toContain('debug.js');
  expect(await worker.evaluate(() => typeof globalThis.SecretShieldDebug)).toBe('undefined');
  expect(await dashboard.evaluate(() => typeof globalThis.SecretShieldDebug)).toBe('undefined');
  await dashboard.goto(dashboard.url().split('#')[0] + '#debug');
  await expect(dashboard.locator('#home-view')).toBeVisible();
  await expect(dashboard.locator('#debug-view,#debug-export,#debug-clear')).toHaveCount(0);
  await expect(dashboard.getByRole('navigation').getByRole('link')).toHaveText(['Home', 'History', 'Privacy Policy', 'Contact Us']);
  await expect(dashboard).toHaveTitle('CkretGuard · Protection');
});

test('production reviews, masks and sends without creating logs or accepting the old logging API', async () => {
  const page = await context.newPage(), submitted = [];
  page.on('request', request => { if (request.method() === 'POST') submitted.push(request.postData()); });
  await page.goto('https://chatgpt.com/c/synthetic-production');
  const id = await worker.evaluate(async url => (await chrome.tabs.query({ url }))[0].id, page.url());
  await expect.poll(() => worker.evaluate(async id => (await chrome.tabs.sendMessage(id, { type: 'coverage' })).ready, id)).toBe(true);
  const editor = page.locator('textarea'), review = page.getByRole('dialog');
  for (const [action, prompt] of [['Edit', 'api_key=synthetic-edit-123'], ['Mask', 'api_key=synthetic-mask-123'], ['Send', 'api_key=synthetic-send-123']]) {
    await editor.fill(prompt); await editor.press('Enter');
    await expect(review.getByRole('heading')).toHaveText('1 secret detected');
    await review.getByRole('button', { name: action, exact: true }).click();
    await expect(review).toBeHidden();
    if (action === 'Edit') { expect(submitted).toEqual([]); await expect(editor).toHaveValue(prompt); }
    else await expect.poll(() => submitted).toEqual(action === 'Mask' ? ['api_key=xxxxxxxxxx'] : ['api_key=xxxxxxxxxx', prompt]);
  }
  await editor.fill('Explain this example.');
  await page.getByRole('button', { name: 'Send', exact: true }).click();
  await expect.poll(() => submitted).toHaveLength(3);
  const response = await dashboard.evaluate(() => chrome.runtime.sendMessage({ type: 'ckretguard-debug', action: 'record',
    event: 'prompt.scanned', prompt: 'synthetic-must-not-be-saved' }).catch(() => null));
  expect(response?.ok).not.toBe(true);
  const state = await dashboard.evaluate(async () => ({
    databases: (await indexedDB.databases()).map(item => item.name),
    storage: await chrome.storage.local.get(null), history: await SecretShieldHistory.request('list'),
  }));
  expect(state.databases).not.toContain('ckretguard-debug');
  expect(state.storage).not.toHaveProperty('debugLogs');
  expect(state.history).toHaveLength(1);
  expect(JSON.stringify(state.storage)).not.toContain('synthetic-');
});

test('production startup deletes old development logs while preserving History, settings and counters', async () => {
  const profile = await mkdtemp(path.join(tmpdir(), 'ckretguard-production-'));
  let browser;
  try {
    browser = await launch(profile);
    let state = await openDashboard(browser);
    await state.page.evaluate(async () => {
      await chrome.storage.local.set({ debugLogs: { enabled: true, entries: ['synthetic-old-log'] },
        policy: { sensitiveNames: ['dataset_key'] }, activity: { detected: 7, maskedPrompts: 2, unmaskedPrompts: 1 } });
      await new Promise((resolve, reject) => {
        const request = indexedDB.open('ckretguard-debug', 2);
        request.onupgradeneeded = () => { request.result.createObjectStore('events'); request.result.createObjectStore('prompts'); };
        request.onerror = () => reject(request.error);
        request.onsuccess = () => {
          const db = request.result, transaction = db.transaction(['events', 'prompts'], 'readwrite');
          transaction.objectStore('events').put({ event: 'prompt.scanned' }, 'synthetic-event');
          transaction.objectStore('prompts').put({ prompt: 'api_key=synthetic-old-secret' }, 'synthetic-prompt');
          transaction.oncomplete = () => { db.close(); resolve(); };
          transaction.onerror = () => { db.close(); reject(transaction.error); };
        };
      });
      await SecretShieldHistory.request('clear');
    });
    await state.worker.evaluate(async () => {
      const entry = SecretShieldHistory.entry('api_key=synthetic-history-123', 1, 'https://chatgpt.com/c/retained-history');
      await SecretShieldHistory.perform('record', entry);
    });
    await browser.close(); browser = await launch(profile);
    state = await openDashboard(browser);
    await expect.poll(() => state.page.evaluate(async () => (await indexedDB.databases()).map(item => item.name))).not.toContain('ckretguard-debug');
    const retained = await state.page.evaluate(async () => {
      const history = await SecretShieldHistory.request('list');
      return { storage: await chrome.storage.local.get(null), history,
        prompt: await SecretShieldHistory.readPrompt(history[0].id) };
    });
    expect(retained.storage).not.toHaveProperty('debugLogs');
    expect(retained.storage.policy).toEqual({ sensitiveNames: ['dataset_key'] });
    expect(retained.storage.activity).toEqual({ detected: 7, maskedPrompts: 2, unmaskedPrompts: 1 });
    expect(retained.history).toHaveLength(1);
    expect(retained.prompt).toBe('api_key=synthetic-history-123');
  } finally { await browser?.close(); await rm(profile, { recursive: true, force: true }); }
});
