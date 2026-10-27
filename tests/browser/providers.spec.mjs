import { test, expect, chromium } from '@playwright/test';
import path from 'node:path';
import { credentialCases } from '../fixtures/credentials.mjs';

const providers = [
  { host: 'gemini.google.com', site: 'Gemini', conversation: '/app/synthetic-provider-test' },
  { host: 'chat.deepseek.com', site: 'DeepSeek', conversation: '/a/chat/s/synthetic-provider-test' },
  { host: 'grok.com', site: 'Grok', conversation: '/c/synthetic-provider-test' },
  { host: 'www.meta.ai', site: 'Meta AI', conversation: '/prompt/synthetic-provider-test' },
];
let context, worker, dashboard;
const review = page => page.getByRole('dialog');
const read = editor => editor.evaluate(el => el.value ?? el.innerText);
const records = () => dashboard.evaluate(() => SecretShieldHistory.request('list'));

function fixtureApp() {
  window.options = {}; window.current = ''; window.submitted = []; window.stops = 0; window.searches = 0;
  const editor = document.querySelector('#main-editor,#chat-input');
  const button = () => document.querySelector('#provider-send');
  const disabled = value => {
    const control = button();
    if (control instanceof HTMLButtonElement) control.disabled = value;
    else control?.classList.toggle('ds-button--disabled', value);
  };
  disabled(true);
  editor.addEventListener('input', () => {
    const value = editor.value ?? editor.innerText;
    disabled(true); clearTimeout(window.commitTimer);
    const commit = () => { window.current = value; disabled(Boolean(window.options.locked)); };
    if (window.options.delay) window.commitTimer = setTimeout(commit, window.options.delay);
    else commit();
  });
  button().addEventListener('click', event => {
    event.preventDefault();
    if (button().disabled || button().classList.contains('ds-button--disabled')) return;
    window.submitted.push(window.current);
    fetch('/test-submit', { method: 'POST', body: window.current });
  });
  editor.addEventListener('keydown', event => {
    if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) {
      event.preventDefault(); button()?.click();
    }
  });
  document.querySelector('#stop-response').addEventListener('click', () => window.stops++);
  document.querySelector('#search').addEventListener('keydown', event => {
    if (event.key === 'Enter') window.searches++;
  });
}
function fixture(provider, variant) {
  const gemini = provider.site === 'Gemini', deepseek = provider.site === 'DeepSeek', grok = provider.site === 'Grok';
  const editor = gemini ?
    '<rich-textarea style="display:block"><div id="main-editor" class="ql-editor" role="textbox" contenteditable="true" style="min-height:100px;white-space:pre-wrap"></div><div class="ql-clipboard" contenteditable="true" style="position:absolute;left:-10000px;width:1px;height:1px"></div></rich-textarea>' :
    deepseek ? '<textarea id="' + (variant === 'legacy' ? 'chat-input' : 'main-editor') + '" placeholder="' + (variant === 'legacy' ? 'Type here' : 'Message DeepSeek') + '"></textarea>' :
    grok ? '<div id="main-editor" class="tiptap ProseMirror query-bar-editor" role="combobox" aria-label="Ask Grok anything" contenteditable="true" style="min-height:100px;white-space:pre-wrap"></div>' :
    variant === 'multiline' ? '<textarea id="main-editor" aria-label="Ask Meta AI"></textarea>' :
    variant === 'richtext' ? '<div id="main-editor" role="textbox" aria-label="Ask Meta AI" contenteditable="true" style="min-height:100px;white-space:pre-wrap"></div>' :
    variant === 'guest' ? '<input id="main-editor" type="text" aria-label="Ask Meta AI" placeholder="Ask Meta AI anything...">' :
    variant === 'mobile' ? '<textarea id="main-editor" data-testid="composer-input" placeholder="Ask Meta AI..."></textarea>' :
    '<textarea data-testid="composer-input" placeholder="Ask Meta AI..." aria-hidden="true" style="display:none"></textarea><div id="main-editor" data-testid="composer-input" data-lexical-editor="true" role="textbox" contenteditable="true" style="min-height:100px;white-space:pre-wrap"></div>';
  const send = gemini ?
    '<button id="provider-send" aria-label="' + (variant === 'localized' ? 'Enviar mensaje' : 'Send message') + '"><mat-icon fonticon="arrow_upward" aria-hidden="true">↑</mat-icon></button>' :
    deepseek ? '<div id="provider-send" role="button" tabindex="0" class="ds-button ds-button--primary ds-button--circle"><div class="ds-button__icon"><svg viewBox="' + (variant === 'legacy' ? '0 0 14 16' : '0 0 16 16') + '" width="16" height="16"><path d="' + (variant === 'legacy' ? 'M7 1L1 7h5v8h2V7h5Z' : 'M8.3125 0.980206C8.66767 1.05312 8.97902 1.2042 9.2627 1.43235L14 7H9V15H7V7H2Z') + '"/></svg></div></div>' :
    '<button id="provider-send"' + (grok ? ' data-testid="chat-submit" aria-label="' + (variant === 'localized' ? 'Enviar' : 'Submit') + '"' : ' data-testid="composer-send-button" aria-label="' + (variant === 'localized' ? 'Enviar' : 'Send') + '"') + '><svg viewBox="0 0 24 24" width="20" height="20"><path d="M12 3L4 11H11V21H13V11H20Z"/></svg></button>';
  const stop = !deepseek ? '<button id="stop-response" type="button" aria-label="Stop response"><mat-icon fonticon="stop">■</mat-icon></button>' :
    '<div id="stop-response" role="button" tabindex="0" class="ds-button ds-button--primary ds-button--circle"><svg viewBox="0 0 16 16" width="16" height="16"><path d="M3 3h10v10H3Z"/></svg></div>';
  return '<!doctype html><html lang="en"><head><title>Synthetic ' + provider.site + '</title></head><body><textarea id="search" aria-label="Search conversations"></textarea><input-container>' +
    (grok ? '<form>' : '') + editor + send + stop + (grok ? '</form>' : '') + '</input-container><script>(' + fixtureApp.toString() + ')();</script></body></html>';
}

test.beforeAll(async () => {
  const extension = path.resolve('dist');
  context = await chromium.launchPersistentContext('', { channel: 'chromium', headless: true, reducedMotion: 'reduce',
    args: ['--disable-extensions-except=' + extension, '--load-extension=' + extension] });
  worker = context.serviceWorkers()[0] ?? await context.waitForEvent('serviceworker');
  await context.route(/^https:\/\/(?:gemini\.google\.com|chat\.deepseek\.com|grok\.com|(?:www\.)?meta\.ai)\//, route => {
    if (route.request().method() === 'POST') return route.fulfill({ body: 'ok' });
    const url = new URL(route.request().url());
    return route.fulfill({ contentType: 'text/html', body: fixture(providers.find(provider => provider.host === (url.hostname === 'meta.ai' ? 'www.meta.ai' : url.hostname)), url.searchParams.get('variant')) });
  });
  dashboard = await context.newPage();
  await dashboard.goto('chrome-extension://' + new URL(worker.url()).hostname + '/composer.html');
  await expect(dashboard.locator('#sensitive-names')).toBeEnabled();
});
test.afterEach(async () => {
  for (const page of context.pages()) if (page !== dashboard) await page.close();
  await dashboard.evaluate(async () => {
    await SecretShieldHistory.request('clear'); await SecretShieldDebug.request('clear');
    await chrome.storage.local.remove(['policy', 'activity']);
  });
});
test.afterAll(async () => { await context?.close(); });

async function chat(provider, variant = '') {
  const page = await context.newPage(), requests = [], errors = [];
  page.on('request', request => { if (request.method() === 'POST') requests.push(request.postData()); });
  page.on('pageerror', error => errors.push(error.message));
  await page.goto('https://' + provider.host + provider.conversation + '?variant=' + variant + '#not-saved');
  const tabId = await worker.evaluate(async host => (await chrome.tabs.query({ url: 'https://' + host + '/*' }))[0].id, provider.host);
  await expect.poll(() => worker.evaluate(async id => {
    try { return await chrome.tabs.sendMessage(id, { type: 'coverage' }); } catch { return null; }
  }, tabId)).toMatchObject({ ready: true, editors: 1, site: provider.site });
  return { page, requests, errors, editor: page.locator('#main-editor,#chat-input') };
}
async function attempt(state, gesture = 'Enter') {
  if (gesture === 'Enter') await state.editor.press('Enter');
  else {
    const target = state.page.locator(gesture === 'icon' ? '#provider-send svg,#provider-send mat-icon' : '#provider-send');
    const box = await target.boundingBox();
    await state.page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
  }
}
async function outgoing(state, expected, count = 1) {
  await expect.poll(() => state.requests.length).toBe(count);
  expect(state.requests[count - 1]).toBe(expected);
  await expect.poll(() => state.page.evaluate(() => window.submitted.length)).toBe(count);
  expect(state.errors).toEqual([]);
}

test('the manifest grants only the eight explicit chat origins and makes local assets available there', async () => {
  const manifest = await worker.evaluate(() => chrome.runtime.getManifest());
  const hosts = ['chatgpt.com', 'chat.openai.com', 'claude.ai', ...providers.map(provider => provider.host), 'meta.ai'].map(host => 'https://' + host + '/*');
  expect(manifest.host_permissions).toEqual(hosts);
  expect(manifest.content_scripts[0].matches).toEqual(hosts);
  expect(manifest.web_accessible_resources[0].matches).toEqual(hosts);
});

for (const provider of providers) {
  for (const action of ['Edit', 'Send', 'Mask']) for (const gesture of ['Enter', 'button', 'icon']) test(provider.site + ': ' + gesture + ' reviews exact values before ' + action, async () => {
    const state = await chat(provider);
    await state.editor.fill('api_key = synthetic-provider-123; client_secret = synthetic-provider-456');
    const original = await read(state.editor), masked = original.replace('synthetic-provider-123', 'xxxxxxxxxx').replace('synthetic-provider-456', 'xxxxxxxxxx');
    await attempt(state, gesture);
    await expect(review(state.page).locator('.review-values code')).toHaveText(['synthetic-provider-123', 'synthetic-provider-456']);
    expect(state.requests).toEqual([]);
    await review(state.page).getByRole('button', { name: action, exact: true }).click();
    await expect(review(state.page)).toBeHidden();
    if (action === 'Edit') {
      expect(state.requests).toEqual([]); expect(await read(state.editor)).toBe(original); await expect(state.editor).toBeFocused();
    } else await outgoing(state, action === 'Send' ? original : masked);
    await expect.poll(async () => (await records()).length).toBe(action === 'Send' ? 1 : 0);
    if (action === 'Send') {
      const [entry] = await records();
      expect(entry.site).toBe(provider.site); expect(entry.url).toBe('https://' + provider.host + provider.conversation);
      expect(await dashboard.evaluate(id => SecretShieldHistory.readPrompt(id), entry.id)).toBe(original);
    }
    const logs = await dashboard.evaluate(() => SecretShieldDebug.request('export'));
    expect(logs.entries.some(entry => entry.site === provider.site && entry.event === 'review.choice' && entry.details.action === action)).toBe(true);
    expect(JSON.stringify(logs)).not.toContain('synthetic-provider-');
  });

  for (const action of ['Edit', 'Send', 'Mask']) test(provider.site + ': all credential formats preserve the selected ' + action + ' behavior', async () => {
    const state = await chat(provider);
    let submissions = 0;
    for (const item of credentialCases) await test.step(item.name, async () => {
      const original = item.input.replace(/\r\n/g, '\n'), masked = item.masked.replace(/\r\n/g, '\n');
      await state.editor.evaluate((el, value) => {
        if (el instanceof HTMLTextAreaElement || el instanceof HTMLInputElement) Object.getOwnPropertyDescriptor(el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype, 'value').set.call(el, value);
        else el.textContent = value;
        el.dispatchEvent(new InputEvent('input', { bubbles: true }));
      }, original);
      await attempt(state);
      await expect(review(state.page).getByRole('heading')).toHaveText(item.count + ' secret' + (item.count === 1 ? '' : 's') + ' detected');
      await review(state.page).getByRole('button', { name: action, exact: true }).click();
      await expect(review(state.page)).toBeHidden();
      if (action === 'Edit') { expect(state.requests).toHaveLength(submissions); expect(await read(state.editor)).toBe(original); }
      else await outgoing(state, action === 'Send' ? original : masked, ++submissions);
    });
  });

  test(provider.site + ': custom keywords, client-ID opt-out and mandatory masking share the same guard', async () => {
    await dashboard.evaluate(async () => {
      await SecretShieldPolicy.update({ kind: 'addField', name: 'project_code' });
      await SecretShieldPolicy.update({ kind: 'set', key: 'protectClientIds', value: false });
      await SecretShieldPolicy.update({ kind: 'set', key: 'mode', value: 'block' });
    });
    const state = await chat(provider);
    const value = 'Q7mV8z2R9tA4nP6xL3cD';
    await state.editor.fill('project_code is mentioned below.\nclient_id: readable-public-id\n' + value);
    await attempt(state);
    await expect(review(state.page).locator('.review-values code')).toHaveText([value]);
    await expect(review(state.page).getByRole('button', { name: 'Send', exact: true })).toHaveCount(0);
    const original = await read(state.editor);
    await review(state.page).getByRole('button', { name: 'Mask', exact: true }).click();
    await outgoing(state, original.replace(value, 'xxxxxxxxxx'));
  });

  for (const action of ['Send', 'Mask']) test(provider.site + ': delayed framework updates and repeated ' + action + ' clicks send once', async () => {
    const state = await chat(provider);
    await state.page.evaluate(() => { window.options.delay = 100; });
    for (let i = 0; i < 12; i++) {
      const value = 'synthetic-repeated-' + i + '-123';
      await state.editor.fill('password=' + value); await attempt(state);
      await review(state.page).getByRole('button', { name: action, exact: true }).evaluate(button => { button.click(); button.click(); });
      await outgoing(state, 'password=' + (action === 'Send' ? value : 'xxxxxxxxxx'), i + 1);
    }
  });

  test(provider.site + ': unrelated inputs and Stop controls do not open the secret review', async () => {
    const state = await chat(provider);
    await state.page.locator('#search').fill('password=synthetic-search-123');
    await state.page.locator('#search').press('Enter');
    await state.editor.fill('password=synthetic-unsent-456');
    await state.page.locator('#stop-response').click();
    await expect(review(state.page)).toHaveCount(0);
    expect(state.requests).toEqual([]);
    expect(await state.page.evaluate(() => [window.searches, window.stops])).toEqual([1, 1]);
  });

  test(provider.site + ': alternate supported controls remain recognized', async () => {
    const state = await chat(provider, provider.site === 'DeepSeek' ? 'legacy' : provider.site === 'Meta AI' ? 'richtext' : 'localized');
    await state.editor.fill('api_key=synthetic-compatible-123'); await attempt(state, 'icon');
    await expect(review(state.page)).toBeVisible();
    await review(state.page).getByRole('button', { name: 'Mask', exact: true }).click();
    await outgoing(state, 'api_key=xxxxxxxxxx');
  });

  test(provider.site + ': changing the draft invalidates retained review buttons', async () => {
    const state = await chat(provider);
    await state.editor.fill('password=synthetic-before-123'); await attempt(state);
    const old = await review(state.page).getByRole('button', { name: 'Send', exact: true }).elementHandle();
    await state.editor.evaluate(el => {
      if (el instanceof HTMLTextAreaElement || el instanceof HTMLInputElement) el.value = 'password=synthetic-after-456';
      else el.textContent = 'password=synthetic-after-456';
      el.dispatchEvent(new InputEvent('input', { bubbles: true }));
    });
    await old.evaluate(button => button.click()); await old.dispose();
    expect(state.requests).toEqual([]);
    await attempt(state); await expect(review(state.page).locator('.review-values code')).toHaveText(['synthetic-after-456']);
  });
}

for (const provider of providers.filter(provider => provider.site !== 'Gemini')) for (const action of ['Send', 'Mask']) test(provider.site + ': a disabled control never reports ' + action + ' as sent', async () => {
  const state = await chat(provider);
  await state.page.evaluate(() => { window.options.locked = true; });
  await state.editor.fill('password=synthetic-disabled-123'); await attempt(state);
  await review(state.page).getByRole('button', { name: action, exact: true }).click();
  await expect(state.page.locator('#secret-shield-notice')).toBeVisible();
  expect(state.requests).toEqual([]);
  expect(await records()).toEqual([]);
  const counts = await dashboard.evaluate(() => SecretShieldStats.read());
  expect(counts.maskedPrompts).toBe(0); expect(counts.unmaskedPrompts).toBe(0);
  expect(await read(state.editor)).toBe('password=' + (action === 'Mask' ? 'xxxxxxxxxx' : 'synthetic-disabled-123'));
});

for (const action of ['Edit', 'Send', 'Mask']) test('Meta AI: the bare-domain alias preserves ' + action + ' behavior', async () => {
  const state = await chat({ host: 'meta.ai', site: 'Meta AI', conversation: '/prompt/synthetic-alias-test' });
  await state.editor.fill('api_key=synthetic-alias-123'); await attempt(state);
  await review(state.page).getByRole('button', { name: action, exact: true }).click();
  await expect(review(state.page)).toBeHidden();
  if (action === 'Edit') { expect(state.requests).toEqual([]); expect(await read(state.editor)).toBe('api_key=synthetic-alias-123'); }
  else await outgoing(state, 'api_key=' + (action === 'Send' ? 'synthetic-alias-123' : 'xxxxxxxxxx'));
});

for (const variant of ['guest', 'mobile', 'localized']) for (const action of ['Edit', 'Send', 'Mask']) test('Meta AI: ' + variant + ' composer preserves ' + action + ' behavior', async () => {
  const state = await chat(providers.find(provider => provider.site === 'Meta AI'), variant);
  await state.editor.fill('api_key=synthetic-meta-variant-123'); await attempt(state, 'icon');
  await expect(review(state.page).locator('.review-values code')).toHaveText(['synthetic-meta-variant-123']);
  await review(state.page).getByRole('button', { name: action, exact: true }).click();
  await expect(review(state.page)).toBeHidden();
  if (action === 'Edit') { expect(state.requests).toEqual([]); expect(await read(state.editor)).toBe('api_key=synthetic-meta-variant-123'); }
  else await outgoing(state, 'api_key=' + (action === 'Send' ? 'synthetic-meta-variant-123' : 'xxxxxxxxxx'));
});
