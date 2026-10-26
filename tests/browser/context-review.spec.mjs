import { test, expect, chromium } from '@playwright/test';
import { mkdir } from 'node:fs/promises';
import path from 'node:path';
let context, worker, dashboard, extensionId;
const first = 'Q7mV8z2R9tA4nP6xL3cD', second = 'B9wK4s8H2yF7vN5rT6aZ';
const original = `My API key and client secret are at the bottom.\nPlease help with this connection.\n\n${first}\n\n${second}`;
async function chat(host) {
  const page = await context.newPage(), sent = [];
  page.on('request', request => { if (request.method() === 'POST') sent.push(request.postData()); });
  await page.goto(`https://${host}/${host === 'claude.ai' ? 'chat' : 'c'}/synthetic-context-review`);
  const id = await worker.evaluate(async url => (await chrome.tabs.query({ url }))[0].id, page.url());
  await expect.poll(() => worker.evaluate(async id => (await chrome.tabs.sendMessage(id, { type: 'coverage' })).ready, id)).toBe(true);
  return { page, sent };
}
test.beforeAll(async () => {
  const extension = path.resolve('dist');
  context = await chromium.launchPersistentContext('', { channel: 'chromium', headless: true, reducedMotion: 'reduce',
    args: [`--disable-extensions-except=${extension}`, `--load-extension=${extension}`] });
  worker = context.serviceWorkers()[0] ?? await context.waitForEvent('serviceworker');
  extensionId = new URL(worker.url()).hostname;
  await context.route(/^https:\/\/(?:chatgpt\.com|claude\.ai)\//, route => {
    if (route.request().method() === 'POST') return route.fulfill({ body: 'ok' });
    return route.fulfill({ contentType: 'text/html', body: `<!doctype html><html lang="en"><head><title>Synthetic context review</title><style>body{background:#181818;color:#ddd;font:14px sans-serif}form{margin:100px auto;width:70%}textarea,[contenteditable]{background:#242424;color:#ddd;border:1px solid #3d3d3d;border-radius:12px;padding:12px;box-sizing:border-box}</style></head><body><form>
      ${new URL(route.request().url()).hostname === 'claude.ai' ? '<div data-testid="chat-input" contenteditable="true" style="min-height:120px;white-space:pre-wrap"></div>' : '<textarea id="prompt-textarea" style="width:100%;height:120px"></textarea>'}
      <button data-testid="send-button" aria-label="Send message">Send</button></form><script>
      window.sent=[];const editor=document.querySelector('textarea,[contenteditable]');
      const send=()=>{const value=editor.value??editor.innerText;window.sent.push(value);fetch('/test-submit',{method:'POST',body:value});};
      editor.addEventListener('keydown',event=>{if(event.key==='Enter'&&!event.shiftKey){event.preventDefault();send();}});
      document.querySelector('form').addEventListener('submit',event=>{event.preventDefault();send();});</script></body></html>` });
  });
  dashboard = await context.newPage(); await dashboard.goto(`chrome-extension://${extensionId}/composer.html`);
});
test.afterEach(async () => {
  for (const page of context.pages()) if (page !== dashboard) await page.close();
  await dashboard.evaluate(async () => { await SecretShieldHistory.request('clear'); await chrome.storage.local.remove('policy'); });
});
test.afterAll(async () => { await context?.close(); });

for (const host of ['chatgpt.com', 'claude.ai']) for (const action of ['Send', 'Edit', 'Mask']) test(`${host}: distant candidates are displayed completely before ${action}`, async () => {
  const { page, sent } = await chat(host), editor = page.locator('textarea,[contenteditable]');
  await editor.fill(original);
  const current = await editor.evaluate(el => el.value ?? el.innerText);
  await editor.press('Enter');
  const dialog = page.getByRole('dialog', { name: '2 secrets detected', exact: true });
  await expect(dialog).toBeVisible();
  await expect(dialog.locator('.review-values code')).toHaveText([first, second]);
  await expect(dialog.locator('.finding-reason')).toHaveText(['1. Possible secret', '2. Possible secret']);
  expect(sent).toEqual([]);
  if (host === 'chatgpt.com' && action === 'Edit') {
    await mkdir('artifacts', { recursive: true });
    await dialog.screenshot({ path: 'artifacts/context-secret-review.png' });
  }
  await dialog.getByRole('button', { name: action, exact: true }).click();
  await expect(dialog).toBeHidden();
  if (action === 'Edit') { expect(sent).toEqual([]); await expect(editor).toBeFocused(); expect(await editor.evaluate(el => el.value ?? el.innerText)).toBe(current); }
  else await expect.poll(() => sent).toEqual([action === 'Send' ? current : current.replace(first, 'xxxxxxxxxx').replace(second, 'xxxxxxxxxx')]);
  const logs = await dashboard.evaluate(() => SecretShieldDebug.request('export'));
  expect(JSON.stringify(logs)).not.toContain(first); expect(JSON.stringify(logs)).not.toContain(second);
  expect(logs.entries.some(entry => entry.event === 'prompt.scanned' && entry.details.contextCount === 2)).toBe(true);
});

for (const host of ['chatgpt.com', 'claude.ai']) test(`${host}: known formats, explicit values and possible secrets share one review without duplicate detections`, async () => {
  const { page, sent } = await chat(host), provider = 'sk-proj-' + 'OnlyDummy9_'.repeat(4);
  const draft = `api_key = short-value\nA distant value follows.\n${first}\n${provider}`;
  await page.locator('textarea,[contenteditable]').fill(draft); await page.locator('textarea,[contenteditable]').press('Enter');
  const dialog = page.getByRole('dialog');
  await expect(dialog.getByRole('heading')).toHaveText('3 secrets detected');
  await expect(dialog.locator('.review-values code')).toHaveText(['short-value', first, provider]);
  await expect(dialog.locator('.finding-reason')).toHaveText(['1. Labeled value', '2. Possible secret', '3. Known key format']);
  await dialog.getByRole('button', { name: 'Mask', exact: true }).click();
  await expect.poll(() => sent).toEqual([draft.replace('short-value', 'xxxxxxxxxx').replace(first, 'xxxxxxxxxx').replace(provider, 'xxxxxxxxxx')]);
});

test('unknown values require keyword evidence and explicit client-ID opt-out stays respected', async () => {
  await dashboard.evaluate(() => SecretShieldPolicy.update({ kind: 'set', key: 'protectClientIds', value: false }));
  const { page, sent } = await chat('chatgpt.com'), editor = page.locator('textarea');
  for (const draft of [first, `client id\n${first}`, `Explain API keys.\nrequest_id: ${first}`, `Explain API keys.\ngetCustomerAccessToken`]) {
    await editor.fill(draft); await editor.press('Enter');
    await expect(page.getByRole('dialog')).toHaveCount(0);
    await expect.poll(() => sent.at(-1)).toBe(draft);
  }
  const draft = `API key at the bottom.\nclient_id: ${first}\n${second}`;
  await editor.fill(draft); await editor.press('Enter');
  const dialog = page.getByRole('dialog'); await expect(dialog.locator('.review-values code')).toHaveText([second]);
  await dialog.getByRole('button', { name: 'Mask', exact: true }).click();
  await expect.poll(() => sent.at(-1)).toBe(draft.replace(second, 'xxxxxxxxxx'));
  const session = `API key at the bottom.\nsession_id: ${first}`;
  await editor.fill(session); await editor.press('Enter');
  await expect(dialog.locator('.review-values code')).toHaveText([first]);
  await dialog.getByRole('button', { name: 'Mask', exact: true }).click();
  await expect.poll(() => sent.at(-1)).toBe(session.replace(first, 'xxxxxxxxxx'));
});

test('review treats detected HTML as text and every long or repeated value is available without leaking it to diagnostics', async () => {
  const { page, sent } = await chat('claude.ai'), editor = page.locator('[contenteditable]');
  const value = 'demo-<img src=x onerror="window.injected=true">', draft = `password='${value}'`;
  await editor.fill(draft); await editor.press('Enter');
  const dialog = page.getByRole('dialog');
  await expect(dialog.locator('.review-values code')).toHaveText([value]);
  await expect(dialog.locator('.review-values img')).toHaveCount(0);
  expect(await page.evaluate(() => window.injected)).toBeUndefined();
  await dialog.getByRole('button', { name: 'Edit', exact: true }).click();
  const long = first.repeat(200);
  await editor.fill(`private_key = "${long}"`); await editor.press('Enter');
  await expect(dialog.locator('.review-values code')).toHaveText([long]);
  await dialog.getByRole('button', { name: 'Edit', exact: true }).click();
  const repeated = 'api_key=short\n' + Array(65).fill(first).join('\n');
  await editor.fill(repeated); await editor.press('Enter');
  await expect(dialog.getByRole('heading')).toHaveText('66 secrets detected');
  await expect(dialog.locator('.review-values li')).toHaveCount(50);
  await expect(dialog.getByRole('heading')).toBeFocused();
  expect(await dialog.evaluate(el => el.scrollTop)).toBe(0);
  await dialog.getByRole('button', { name: 'Show more (16 remaining)', exact: true }).click();
  await expect(dialog.locator('.review-values li')).toHaveCount(66);
  await expect(dialog.locator('.review-values code').last()).toHaveText(first);
  await dialog.getByRole('button', { name: 'Mask', exact: true }).click();
  await expect.poll(() => sent).toEqual([repeated.replace('short', 'xxxxxxxxxx').replaceAll(first, 'xxxxxxxxxx')]);
});

test('custom keyword triggers and block mode use the same review and continue to hide Send', async () => {
  await dashboard.evaluate(async () => {
    await SecretShieldPolicy.update({ kind: 'addField', name: 'project_code' });
    await SecretShieldPolicy.update({ kind: 'set', key: 'mode', value: 'block' });
  });
  const { page, sent } = await chat('claude.ai'), editor = page.locator('[contenteditable]');
  await editor.fill(`project_code is mentioned in this prompt.\n${first}`); await editor.press('Enter');
  const dialog = page.getByRole('dialog');
  await expect(dialog.locator('.review-values code')).toHaveText([first]);
  await expect(dialog.getByRole('button', { name: 'Send', exact: true })).toHaveCount(0);
  await dialog.getByRole('button', { name: 'Mask', exact: true }).click();
  await expect.poll(() => sent).toEqual([`project_code is mentioned in this prompt.\nxxxxxxxxxx`]);
});
