import { test, expect, chromium } from '@playwright/test';
import path from 'node:path';
import { mkdir } from 'node:fs/promises';

const root = path.resolve('.');
let context, dashboard, extensionId;
const review = page => page.getByRole('dialog');
async function entries() { return dashboard.evaluate(async () => {
  const entries = await SecretShieldHistory.request('list');
  return Promise.all(entries.map(async entry => ({ ...entry, prompt: await SecretShieldHistory.readPrompt(entry.id) })));
}); }
async function chat(host = 'chatgpt.com') {
  const page = await context.newPage();
  await page.goto(`https://${host}/${host === 'claude.ai' ? 'chat' : 'c'}/test-conversation?token=not-saved#not-saved`);
  await page.bringToFront();
  await expect.poll(() => dashboard.evaluate(async () => {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    return (await chrome.tabs.sendMessage(tab.id, { type: 'coverage' })).ready;
  })).toBe(true);
  return page;
}
async function clickSend(page) {
  const button = page.getByRole('button', { name: 'Send message', exact: true });
  await button.scrollIntoViewIfNeeded();
  const box = await button.boundingBox();
  // The review opens on pointerdown and covers mouseup; avoid locator.click retries.
  await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
}
async function choose(page, prompt, action) {
  await page.locator('textarea,[contenteditable]').fill(prompt);
  await clickSend(page);
  await expect(review(page)).toBeVisible();
  await review(page).getByRole('button', { name: action, exact: true }).click();
  await expect(review(page)).toBeHidden();
}
test.beforeAll(async () => {
  const extension = path.join(root, 'dist');
  context = await chromium.launchPersistentContext('', { channel: 'chromium', headless: true, reducedMotion: 'reduce',
    args: [`--disable-extensions-except=${extension}`, `--load-extension=${extension}`] });
  const worker = context.serviceWorkers()[0] ?? await context.waitForEvent('serviceworker');
  extensionId = new URL(worker.url()).hostname;
  await context.route(/^https:\/\/(?:chatgpt\.com|chat\.openai\.com|claude\.ai)\//, route => route.fulfill({ contentType: 'text/html', body: `<!doctype html><html lang="en"><head><title>Synthetic chat</title></head><body>
    <form>${new URL(route.request().url()).hostname === 'claude.ai' ? '<div contenteditable="true" data-testid="chat-input" style="min-height:80px;white-space:pre-wrap"></div>' : '<textarea id="prompt-textarea"></textarea>'}<button data-testid="send-button" aria-label="Send message">Send</button></form>
    <script>window.sent=[];document.querySelector('form').addEventListener('submit',event=>{event.preventDefault();const editor=document.querySelector('textarea,[contenteditable]');window.sent.push(editor.value??editor.innerText);});</script></body></html>` }));
  dashboard = await context.newPage();
  await dashboard.goto(`chrome-extension://${extensionId}/composer.html`);
  await expect(dashboard.locator('#sidebar')).toBeVisible();
});
test.afterEach(async () => {
  await dashboard.evaluate(() => SecretShieldHistory.request('clear'));
  await dashboard.evaluate(() => chrome.storage.local.clear());
  await dashboard.goto(`chrome-extension://${extensionId}/composer.html`);
  await expect(dashboard.locator('#sensitive-names')).toBeEnabled();
  for (const page of context.pages()) if (page !== dashboard) await page.close();
});
test.afterAll(async () => { await context?.close(); });

test('full page navigation supports all four views, reloads and browser back', async () => {
  await expect(dashboard.locator('#field-form')).toBeHidden();
  await expect(dashboard.locator('#protection-settings .settings')).toBeHidden();
  await expect(dashboard.getByRole('navigation').getByRole('link')).toHaveText(['Home', 'History', 'Privacy Policy', 'Contact Us']);
  await expect(dashboard.locator('#expand')).toBeHidden();
  for (const [name, view] of [['History', 'history'], ['Privacy Policy', 'privacy'], ['Contact Us', 'contact']]) {
    await dashboard.getByRole('navigation').getByRole('link', { name, exact: true }).click();
    await expect(dashboard.locator(`#${view}-view`)).toBeVisible();
    await expect(dashboard.getByRole('navigation').getByRole('link', { name, exact: true })).toHaveAttribute('aria-current', 'page');
    await expect(dashboard.locator('#home-view')).toBeHidden();
  }
  await dashboard.reload();
  await expect(dashboard.locator('#contact-view')).toBeVisible();
  await expect(dashboard.locator('.contact-link')).toHaveAttribute('href', 'mailto:connect.orenthic@gmail.com');
  await dashboard.goBack();
  await expect(dashboard.locator('#privacy-view')).toBeVisible();
  for (const width of [1280, 800, 661, 410]) {
    await dashboard.setViewportSize({ width, height: 900 });
    expect(await dashboard.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  }
});

test('toolbar mode keeps the existing Home layout without a sidebar', async () => {
  const popup = await context.newPage();
  await popup.addInitScript(() => { chrome.tabs.getCurrent = async () => undefined; });
  await popup.goto(`chrome-extension://${extensionId}/composer.html#history`);
  await expect(popup.locator('#sidebar')).toBeHidden();
  await expect(popup.locator('#home-view')).toBeVisible();
  await expect(popup.locator('#history-view')).toBeHidden();
  await expect(popup.locator('#expand')).toBeVisible();
  await expect(popup.locator('#field-form')).toBeHidden();
  await popup.locator('#fields-title').press('Enter');
  await expect(popup.locator('#field-form')).toBeVisible();
  await expect(popup.locator('#sensitive-names')).toBeEnabled();
  await popup.locator('#sensitive-names').fill('unsaved_field');
  await popup.locator('#fields-title').press('Space');
  await expect(popup.locator('#field-form')).toBeHidden();
  await popup.locator('#fields-title').click();
  await expect(popup.locator('#sensitive-names')).toHaveValue('unsaved_field');
  await popup.reload();
  await expect(popup.locator('#field-form')).toBeHidden();
});

for (const host of ['chatgpt.com', 'chat.openai.com', 'claude.ai']) test(`${host}: only Send saves the complete unmasked prompt and its source`, async () => {
  const page = await chat(host);
  const original = 'api_key=synthetic-visible-123\npassword="synthetic secret phrase"';
  await page.locator('textarea,[contenteditable]').fill('Ordinary prompt without credentials.');
  await clickSend(page);
  await choose(page, original, 'Edit');
  expect(await entries()).toEqual([]);
  await choose(page, original, 'Mask');
  await expect.poll(() => page.evaluate(() => window.sent)).toEqual(['Ordinary prompt without credentials.', 'api_key=xxxxxxxxxx\npassword="xxxxxxxxxx"']);
  expect(await entries()).toEqual([]);
  await choose(page, original, 'Send');
  await expect.poll(async () => (await entries()).length).toBe(1);
  const [saved] = await entries();
  expect(saved.prompt).toBe(original);
  expect(saved.count).toBe(2);
  expect(saved.site).toBe(host === 'claude.ai' ? 'Claude' : 'ChatGPT');
  expect(saved.url).toBe(`https://${host}/${host === 'claude.ai' ? 'chat' : 'c'}/test-conversation`);
  expect(Date.now() - saved.createdAt).toBeLessThan(10000);
  await dashboard.getByRole('navigation').getByRole('link', { name: 'History', exact: true }).click();
  await dashboard.locator('#history-list summary').click();
  await expect(dashboard.locator('#history-list pre')).toHaveText(original);
  await dashboard.reload();
  await expect(dashboard.locator('#history-list')).toContainText('2 secrets sent unmasked');
  await dashboard.locator('#history-list summary').click();
  await expect(dashboard.locator('#history-list pre')).toHaveText(original);
});

test('newest prompts appear first and updates reach every open dashboard', async () => {
  const page = await chat();
  await dashboard.getByRole('navigation').getByRole('link', { name: 'History', exact: true }).click();
  await choose(page, 'key=synthetic-older-123', 'Send');
  await expect(dashboard.locator('#history-list li')).toHaveCount(1);
  const second = await context.newPage();
  await second.goto(`chrome-extension://${extensionId}/composer.html#history`);
  await expect(second.locator('#history-list li')).toHaveCount(1);
  await choose(page, 'key=synthetic-newer-456', 'Send');
  await expect(second.locator('#history-list li')).toHaveCount(2);
  await dashboard.locator('#history-list details').evaluateAll(items => items.forEach(item => { item.open = true; }));
  await expect(dashboard.locator('#history-list pre')).toHaveText(['key=synthetic-newer-456', 'key=synthetic-older-123']);
  await second.locator('#history-list button').first().click();
  await expect(dashboard.locator('#history-list li')).toHaveCount(1);
  await expect(dashboard.locator('#history-list pre')).toHaveText('key=synthetic-older-123');
  const totals = await dashboard.evaluate(() => SecretShieldStats.read());
  const confirmation = dashboard.getByRole('dialog', { name: 'Clear history?', exact: true });
  await dashboard.locator('#clear-history').click();
  await expect(confirmation).toBeVisible();
  await expect(confirmation.getByRole('button', { name: 'Cancel', exact: true })).toBeFocused();
  expect((await entries()).length).toBe(1);
  await confirmation.getByRole('button', { name: 'Cancel', exact: true }).click();
  await expect(confirmation).toBeHidden();
  await expect(dashboard.locator('#clear-history')).toBeFocused();
  await expect(dashboard.locator('#history-list li')).toHaveCount(1);
  await dashboard.locator('#clear-history').click();
  await dashboard.keyboard.press('Escape');
  await expect(confirmation).toBeHidden();
  expect((await entries()).length).toBe(1);
  await dashboard.locator('#clear-history').click();
  await confirmation.getByRole('button', { name: 'Clear history', exact: true }).click();
  await expect(confirmation).toBeHidden();
  await expect(dashboard.locator('#history-list li')).toHaveCount(0);
  await expect(second.locator('#history-list li')).toHaveCount(0);
  await expect(dashboard.locator('#history-title')).toBeFocused();
  expect(await dashboard.evaluate(() => SecretShieldStats.read())).toEqual(totals);
});

test('clear history modal retains entries after a failure and permits retry', async () => {
  const page = await chat();
  await choose(page, 'key=synthetic-clear-failure-123', 'Send');
  await expect.poll(async () => (await entries()).length).toBe(1);
  await dashboard.getByRole('navigation').getByRole('link', { name: 'History', exact: true }).click();
  await dashboard.locator('#clear-history').click();
  const confirmation = dashboard.getByRole('dialog', { name: 'Clear history?', exact: true });
  const worker = context.serviceWorkers()[0];
  await worker.evaluate(() => { globalThis.originalHistoryDB = indexedDB.open; indexedDB.open = () => { throw new Error('synthetic failure'); }; });
  try {
    await confirmation.getByRole('button', { name: 'Clear history', exact: true }).click();
    await expect(confirmation).toBeVisible();
    await expect(confirmation.getByRole('status')).toHaveText('Could not clear history. Try again.');
    await expect(confirmation.getByRole('button', { name: 'Clear history', exact: true })).toBeEnabled();
    await expect(dashboard.locator('#history-list li')).toHaveCount(1);
  } finally { await worker.evaluate(() => { indexedDB.open = originalHistoryDB; delete globalThis.originalHistoryDB; }); }
  expect((await entries()).length).toBe(1);
  await confirmation.getByRole('button', { name: 'Clear history', exact: true }).click();
  await expect(confirmation).toBeHidden();
  expect(await entries()).toEqual([]);
});

test('failed or invalidated sends never enter History', async () => {
  const page = await chat();
  await page.locator('textarea,[contenteditable]').fill('key=synthetic-cancelled-123');
  await clickSend(page);
  await expect(review(page)).toBeVisible();
  await page.locator('[data-testid=send-button]').evaluate(button => { button.disabled = true; });
  await review(page).getByRole('button', { name: 'Send', exact: true }).click();
  await expect(review(page)).toBeHidden();
  await expect(page.locator('#secret-shield-notice')).toBeVisible();
  expect(await entries()).toEqual([]);
  await page.locator('[data-testid=send-button]').evaluate(button => { button.disabled = false; });
  await clickSend(page);
  await expect(review(page)).toBeVisible();
  await dashboard.evaluate(() => chrome.storage.local.set({ policy: { mode: 'block' } }));
  await expect(review(page)).toBeHidden();
  expect(await entries()).toEqual([]);
  expect(await page.evaluate(() => window.sent)).toEqual([]);
});

test('History renders prompt text safely, preserves long prompts and keeps preferences content-free', async () => {
  const page = await chat();
  const original = '<img src=x onerror="window.injected=true">\nkey=synthetic-safe-123\n' + 'long prompt '.repeat(10000);
  await choose(page, original, 'Send');
  await expect.poll(async () => (await entries()).length).toBe(1);
  expect((await entries())[0].prompt).toBe(original);
  await dashboard.getByRole('navigation').getByRole('link', { name: 'History', exact: true }).click();
  await dashboard.locator('#history-list summary').click();
  await expect.poll(() => dashboard.locator('#history-list pre').textContent()).toBe(original);
  await expect(dashboard.locator('#history-list img')).toHaveCount(0);
  expect(await dashboard.evaluate(() => window.injected)).toBeUndefined();
  const preferences = await dashboard.evaluate(async () => JSON.stringify(await chrome.storage.local.get(null)));
  expect(preferences).not.toContain('synthetic-safe');
  // Content scripts use the website's origin for IndexedDB, not the extension's database.
  expect(await page.evaluate(async () => (await indexedDB.databases()).some(db => db.name === 'ckretguard-history'))).toBe(false);
});

test('History reports storage errors without changing Send and recovers after a failure', async () => {
  const page = await chat();
  await choose(page, 'key=synthetic-persist-123', 'Send');
  await expect.poll(async () => (await entries()).length).toBe(1);
  const worker = context.serviceWorkers()[0];
  await worker.evaluate(() => { globalThis.originalHistoryDB = indexedDB.open; indexedDB.open = () => { throw new Error('synthetic failure'); }; });
  try {
    await choose(page, 'key=synthetic-storage-failure-456', 'Send');
    await expect.poll(() => page.evaluate(() => window.sent.length)).toBe(2);
    await expect(page.locator('#secret-shield-notice')).toBeVisible();
    await dashboard.getByRole('navigation').getByRole('link', { name: 'History', exact: true }).click();
    await expect(dashboard.locator('#history-status')).toContainText('Could not load history');
  } finally { await worker.evaluate(() => { indexedDB.open = originalHistoryDB; delete globalThis.originalHistoryDB; }); }
  await dashboard.reload();
  await dashboard.locator('#history-list summary').click();
  await expect(dashboard.locator('#history-list pre')).toHaveText('key=synthetic-persist-123');
});

test('Home and History retain the brand styling in full mode', async () => {
  const page = await chat();
  await choose(page, 'client_secret=synthetic-preview-123', 'Send');
  await expect.poll(async () => (await entries()).length).toBe(1);
  await dashboard.setViewportSize({ width: 1280, height: 850 });
  await mkdir(path.join(root, 'artifacts'), { recursive: true });
  await dashboard.screenshot({ path: path.join(root, 'artifacts', 'full-page-home.png'), fullPage: true });
  await dashboard.getByRole('navigation').getByRole('link', { name: 'History', exact: true }).click();
  await dashboard.locator('#history-list summary').click();
  await dashboard.screenshot({ path: path.join(root, 'artifacts', 'full-page-history.png'), fullPage: true });
  await dashboard.locator('#clear-history').click();
  await dashboard.screenshot({ path: path.join(root, 'artifacts', 'clear-history-modal.png'), fullPage: true });
  await dashboard.getByRole('dialog', { name: 'Clear history?', exact: true }).getByRole('button', { name: 'Cancel', exact: true }).click();
});

async function seedHistory(items) {
  return dashboard.evaluate(async items=>{
    await SecretShieldHistory.perform('prune');
    const records=items.map(item=>({...SecretShieldHistory.entry(item.large ? 'key=synthetic-volume-123\n'+'plain text '.repeat(100000) : 'key=synthetic-history-123',1,'https://chatgpt.com/c/history-test'),
      ...(item.createdAt===undefined?{}:{createdAt:item.createdAt})}));
    const db=await new Promise((resolve,reject)=>{const request=indexedDB.open('ckretguard-history',1);request.onsuccess=()=>resolve(request.result);request.onerror=()=>reject(request.error);});
    try { await new Promise((resolve,reject)=>{
      const transaction=db.transaction('prompts','readwrite');
      for(const record of records) transaction.objectStore('prompts').add(record);
      transaction.oncomplete=resolve;transaction.onerror=transaction.onabort=()=>reject(transaction.error);
    }); } finally { db.close(); }
    return records.map(({id,prompt,createdAt})=>({id,length:prompt.length,createdAt}));
  },items);
}
test('History physically deletes entries older than 90 days and retains the cutoff boundary',async()=>{
  const worker=context.serviceWorkers()[0], now=Date.now(), day=86400000;
  await worker.evaluate(now=>{globalThis.originalHistoryNow=Date.now;Date.now=()=>now;},now);
  try {
    const seeded=await seedHistory([{createdAt:now-90*day-1},{createdAt:now-90*day},{createdAt:now-89*day}]);
    const listed=await dashboard.evaluate(()=>SecretShieldHistory.request('list'));
    expect(listed.map(item=>item.id)).toEqual([seeded[2].id,seeded[1].id]);
    const remaining=await dashboard.evaluate(()=>new Promise((resolve,reject)=>{
      const request=indexedDB.open('ckretguard-history',1);
      request.onsuccess=()=>{const db=request.result,transaction=db.transaction('prompts');const count=transaction.objectStore('prompts').count();count.onsuccess=()=>resolve(count.result);transaction.oncomplete=()=>db.close();};
      request.onerror=reject;
    }));
    expect(remaining).toBe(2);
    expect(await dashboard.evaluate(async id=>{try{await SecretShieldHistory.readPrompt(id);return false;}catch{return true;}},seeded[0].id)).toBe(true);
    const alarm=await dashboard.evaluate(()=>chrome.alarms.get('history-retention'));
    expect(alarm.periodInMinutes).toBe(60);
  } finally { await worker.evaluate(()=>{Date.now=originalHistoryNow;delete globalThis.originalHistoryNow;}); }
});
test('History metadata pagination preserves records sharing a timestamp',async()=>{
  const seeded=await seedHistory(Array.from({length:405},()=>({createdAt:Date.now()})));
  const metadata=await dashboard.evaluate(()=>SecretShieldHistory.request('list'));
  expect(metadata).toHaveLength(405);
  expect(new Set(metadata.map(item=>item.id))).toEqual(new Set(seeded.map(item=>item.id)));
  expect(metadata.every(item=>!Object.hasOwn(item,'prompt'))).toBe(true);
});
test('large History lists stay below message limits and selected prompts load without truncation',async()=>{
  const seeded=await seedHistory(Array.from({length:70},()=>({large:true})));
  await dashboard.locator('#sidebar a[href="#history"]').click();
  await expect(dashboard.locator('#history-list li')).toHaveCount(70);
  expect(await dashboard.evaluate(async()=>JSON.stringify(await SecretShieldHistory.request('list')).length)).toBeLessThan(100000);
  await expect(dashboard.locator('#history-list pre').first()).toHaveText('');
  await dashboard.locator('#history-list summary').first().click();
  await expect.poll(()=>dashboard.locator('#history-list pre').first().evaluate(element=>element.textContent.length)).toBe(seeded[0].length);
  await expect(dashboard.locator('#clear-history')).toBeVisible();
  await dashboard.locator('#clear-history').click();
  await dashboard.getByRole('dialog').getByRole('button',{name:'Clear history',exact:true}).click();
  await expect(dashboard.locator('#history-list li')).toHaveCount(0);
});
test('Clear history remains available when listing fails',async()=>{
  await seedHistory([{}]);
  const worker=context.serviceWorkers()[0];
  await worker.evaluate(()=>{
    const original=SecretShieldHistory;
    globalThis.restoreHistoryList=()=>{globalThis.SecretShieldHistory=original;};
    globalThis.SecretShieldHistory={...original,perform:async(action,value)=>{if(action==='list')throw new Error('synthetic list failure');return original.perform(action,value);}};
  });
  try {
    await dashboard.locator('#sidebar a[href="#history"]').click();
    await expect(dashboard.locator('#history-status')).toContainText('Could not load history');
    await expect(dashboard.locator('#clear-history')).toBeVisible();
    await dashboard.locator('#clear-history').click();
    await dashboard.getByRole('dialog').getByRole('button',{name:'Clear history',exact:true}).click();
    await expect(dashboard.getByRole('dialog')).toBeHidden();
  } finally { await worker.evaluate(()=>{restoreHistoryList();delete globalThis.restoreHistoryList;}); }
  expect(await entries()).toEqual([]);
});
