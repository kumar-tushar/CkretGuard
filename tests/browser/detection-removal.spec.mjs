import { test, expect, chromium } from '@playwright/test';
import path from 'node:path';

const providers = [
  ['chatgpt.com', '<textarea id="prompt-textarea"></textarea>'],
  ['claude.ai', '<div contenteditable="true" data-testid="chat-input"></div>'],
  ['gemini.google.com', '<rich-textarea><div class="ql-editor" contenteditable="true" role="textbox"></div></rich-textarea>'],
  ['chat.deepseek.com', '<textarea id="chat-input"></textarea>'],
  ['grok.com', '<div class="query-bar-editor" contenteditable="true"></div>'],
  ['www.meta.ai', '<textarea data-testid="composer-input"></textarea>'],
  ['copilot.microsoft.com', '<textarea id="userInput"></textarea>'],
  ['www.perplexity.ai', '<textarea id="ask-input"></textarea>'],
  ['chat.mistral.ai', '<div data-chat-input-bar><div class="ProseMirror" contenteditable="true"></div></div>'],
];
let context, worker, dashboard, extensionId;
test.beforeAll(async () => {
  const extension = path.resolve('dist');
  context = await chromium.launchPersistentContext('', { channel: 'chromium', headless: true, reducedMotion: 'reduce',
    args: [`--disable-extensions-except=${extension}`, `--load-extension=${extension}`] });
  worker = context.serviceWorkers()[0] ?? await context.waitForEvent('serviceworker');
  extensionId = new URL(worker.url()).hostname;
  await context.route(url => providers.some(([host]) => url.hostname === host), route => {
    const host = new URL(route.request().url()).hostname;
    const [, editor] = providers.find(([name]) => name === host);
    const label = host === 'www.perplexity.ai' ? 'Submit' : host === 'chat.mistral.ai' ? 'Send question' : 'Send message';
    const testId = host === 'grok.com' ? 'chat-submit' : 'send-button';
    return route.fulfill({ contentType: 'text/html', body: `<!doctype html><html lang="en"><head><title>Detector removal fixture</title>
      <style>[contenteditable]{display:block;min-height:100px;white-space:pre-wrap}</style></head><body><form>${editor}
      <button type="submit" data-testid="${testId}" aria-label="${label}">Send</button></form><script>
      window.sent=[];const editor=document.querySelector('textarea,[contenteditable]');
      const send=()=>window.sent.push(editor.value??editor.innerText);
      document.querySelector('form').addEventListener('submit',event=>{event.preventDefault();send()});
      editor.addEventListener('keydown',event=>{if(event.key==='Enter'&&!event.shiftKey){event.preventDefault();send()}});
      </script></body></html>` });
  });
  dashboard = await context.newPage();
  await dashboard.goto(`chrome-extension://${extensionId}/composer.html`);
  await expect(dashboard.locator('#sensitive-names')).toBeEnabled();
});
test.afterEach(async () => {
  for (const page of context.pages()) if (page !== dashboard) await page.close();
  await dashboard.evaluate(async () => { await SecretShieldHistory.request('clear'); await chrome.storage.local.clear(); });
});
test.afterAll(async () => { await context?.close(); });

async function chat(host) {
  const page = await context.newPage();
  await page.goto(`https://${host}/`);
  const id = await worker.evaluate(async url => (await chrome.tabs.query({ url }))[0].id, page.url());
  await expect.poll(() => worker.evaluate(async id => (await chrome.tabs.sendMessage(id, { type: 'coverage' })).ready, id)).toBe(true);
  return { page, id, editor: page.locator('textarea,[contenteditable]') };
}

for (const [host] of providers) test(`${host}: retired rules leave prompts unchanged and do not open review`, async () => {
  await dashboard.evaluate(async () => {
    await SecretShieldPolicy.update({ kind: 'addField', name: 'dataset_key' });
    await SecretShieldPolicy.update({ kind: 'set', key: 'mode', value: 'block' });
  });
  const { page, editor } = await chat(host);
  const prompt = 'api key\n\nhju867fggfgxxjgswrxl\npassword=short\ndataset_key=synthetic-custom-123\nsk-proj-' + 'OnlyDummy9_'.repeat(4);
  await editor.fill(prompt);
  const original = await editor.evaluate(el => el.value ?? el.innerText);
  await editor.press('Enter');
  await expect.poll(() => page.evaluate(() => window.sent)).toEqual([original]);
  await page.getByRole('button', { name: /^(?:Send message|Send question|Submit)$/ }).click();
  await expect.poll(() => page.evaluate(() => window.sent)).toEqual([original, original]);
  await expect(page.getByRole('dialog')).toHaveCount(0);
  expect(await dashboard.evaluate(() => SecretShieldHistory.request('list'))).toEqual([]);
  expect(await dashboard.evaluate(() => SecretShieldStats.read())).toEqual({ detected: 0, maskedPrompts: 0, unmaskedPrompts: 0 });
});

for (const action of ['Send', 'Edit', 'Mask']) test(`review still handles ${action} when supplied with fixture findings`, async () => {
  const { page, id, editor } = await chat('chatgpt.com');
  // Supply a fixed test finding in the isolated world; no detector is added to the build.
  await worker.evaluate(id => chrome.scripting.executeScript({ target: { tabId: id }, func: () => {
    const core = globalThis.SecretShieldCore;
    const scan = text => {
      const start = text.indexOf('fixture-only-value');
      return start < 0 ? [] : [{ start, end: start + 'fixture-only-value'.length, type: 'fixture' }];
    };
    globalThis.SecretShieldCore = Object.freeze({ ...core, scan, redact: text => {
      const findings = scan(text);
      return { text: text.replace('fixture-only-value', core.MASK), count: findings.length, findings };
    } });
  } }), id);
  await editor.fill('Review fixture-only-value');
  await editor.press('Enter');
  const dialog = page.getByRole('dialog', { name: '1 secret detected', exact: true });
  await expect(dialog).toBeVisible();
  await expect(dialog.locator('.review-values code')).toHaveText(['fixture-only-value']);
  await expect(dialog.getByRole('button')).toHaveText(['Send', 'Edit', 'Mask']);
  await dialog.getByRole('button', { name: action, exact: true }).click();
  await expect(dialog).toBeHidden();
  await expect.poll(() => page.evaluate(() => window.sent)).toEqual(action === 'Edit' ? [] :
    [action === 'Mask' ? 'Review xxxxxxxxxx' : 'Review fixture-only-value']);
  if (action === 'Edit') { await expect(editor).toHaveValue('Review fixture-only-value'); await expect(editor).toBeFocused(); }
});

const first = 'N7q2V9m4R8s6T3x5K1p0L2z7H4c9D6b8', second = 'B9wK4s8H2yF7vN5rT6aZ';
for (const [host] of providers) for (const action of ['Send', 'Edit', 'Mask']) test(`${host}: Gitleaks findings preserve ${action} for repeated Enter and click attempts`, async () => {
  const { page, editor } = await chat(host), submitted = [];
  const draft = `Keep this text.\napi_key="${first}"\nclient_secret=${second}`;
  for (const trigger of ['Enter', 'click']) {
    await editor.fill(draft);
    const original = await editor.evaluate(el => el.value ?? el.innerText);
    if (trigger === 'Enter') await editor.press('Enter');
    else {
      // The guard opens on pointerdown. Use the same native mouse gesture as
      // the existing submission tests, without retrying a now-covered button.
      const button = await page.getByRole('button', { name: /^(?:Send message|Send question|Submit)$/ }).boundingBox();
      await page.mouse.click(button.x + button.width / 2, button.y + button.height / 2);
    }
    const dialog = page.getByRole('dialog', { name: '2 secrets detected', exact: true });
    await expect(dialog).toBeVisible();
    await expect(dialog.locator('.review-values code')).toHaveText([first, second]);
    expect(await page.evaluate(() => window.sent)).toEqual(submitted);
    await dialog.getByRole('button', { name: action, exact: true }).click();
    await expect(dialog).toBeHidden();
    if (action === 'Edit') {
      expect(await editor.evaluate(el => el.value ?? el.innerText)).toBe(original);
      await expect(editor).toBeFocused();
    } else submitted.push(action === 'Send' ? original : original.replace(first, 'xxxxxxxxxx').replace(second, 'xxxxxxxxxx'));
    await expect.poll(() => page.evaluate(() => window.sent)).toEqual(submitted);
  }
  await expect.poll(() => dashboard.evaluate(() => SecretShieldStats.read())).toEqual({
    detected: 4, maskedPrompts: action === 'Mask' ? 2 : 0, unmaskedPrompts: action === 'Send' ? 2 : 0,
  });
  const history = await dashboard.evaluate(() => SecretShieldHistory.request('list'));
  expect(history).toHaveLength(action === 'Send' ? 2 : 0);
  for (const entry of history) {
    expect(await dashboard.evaluate(id => SecretShieldHistory.readPrompt(id), entry.id)).toBe(draft);
    expect(entry.count).toBe(2);
  }
});

test('Gitleaks detection preserves strict mode, custom fields and the current modal design', async () => {
  await dashboard.evaluate(async () => {
    await SecretShieldPolicy.update({ kind: 'addField', name: 'dataset_name' });
    await SecretShieldPolicy.update({ kind: 'set', key: 'mode', value: 'block' });
  });
  const { page, editor } = await chat('claude.ai');
  await editor.fill(`api_key=${first}`); await editor.press('Enter');
  const dialog = page.getByRole('dialog');
  await expect(dialog.getByRole('button', { name: 'Send', exact: true })).toHaveCount(0);
  await expect(dialog.getByRole('button', { name: 'Mask', exact: true })).toHaveCSS('background-color', 'rgb(69, 214, 200)');
  await expect(dialog.getByRole('button', { name: 'Mask', exact: true })).toHaveCSS('height', '34px');
  await dialog.getByRole('button', { name: 'Mask', exact: true }).click();
  await expect.poll(() => page.evaluate(() => window.sent)).toEqual(['api_key=xxxxxxxxxx']);
  expect(await dashboard.evaluate(async () => (await SecretShieldPolicy.loadPolicy()).policy.sensitiveNames)).toEqual(['dataset_name']);
  await editor.fill('key={event.id}\nExplain how API keys work.'); await editor.press('Enter');
  await expect(dialog).toBeHidden();
  await expect.poll(() => page.evaluate(() => window.sent)).toHaveLength(2);
});
