import { test, expect, chromium } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import path from 'node:path';

const root = path.resolve('.');
const refreshMessage = 'Extension connection lost. Refresh this chat tab before sending.';
function fixture(host) {
  const editor = host === 'claude.ai' ? '<div contenteditable="true" data-testid="chat-input" style="min-height:80px;white-space:pre-wrap"></div>' :
    host === 'gemini.google.com' ? '<rich-textarea><div class="ql-editor" role="textbox" contenteditable="true" style="min-height:80px;white-space:pre-wrap"></div></rich-textarea>' :
    host === 'chat.deepseek.com' ? '<textarea placeholder="Message DeepSeek"></textarea>' :
    host === 'grok.com' ? '<div class="query-bar-editor" role="combobox" contenteditable="true" style="min-height:80px;white-space:pre-wrap"></div>' :
    host === 'www.meta.ai' ? '<div data-testid="composer-input" data-lexical-editor="true" role="textbox" contenteditable="true" style="min-height:80px;white-space:pre-wrap"></div>' :
    host === 'meta.ai' ? '<input type="text" aria-label="Ask Meta AI">' : '<textarea id="prompt-textarea"></textarea>';
  const control = host === 'chat.deepseek.com' ? '<div role="button" tabindex="0" class="ds-button ds-button--primary ds-button--circle"><svg viewBox="0 0 16 16" width="16" height="16"><path d="M8.3125 0.980206L14 7H9V15H7V7H2Z"/></svg></div>' :
    host === 'grok.com' ? '<button data-testid="chat-submit" aria-label="Submit">Send</button>' :
    host.endsWith('meta.ai') ? '<button data-testid="composer-send-button" aria-label="Send">Send</button>' : '<button data-testid="send-button" aria-label="Send message">Send</button>';
  return `<!doctype html><html lang="en"><head><title>Synthetic chat</title></head><body><form>${editor}${control}</form>
    <script>window.submitted=[];window.current='';const editor=document.querySelector('textarea,[contenteditable],input');editor.addEventListener('input',()=>{window.current=editor.value??editor.innerText;});
    const send=()=>{window.submitted.push(window.current);};editor.addEventListener('keydown',event=>{if(event.key==='Enter'&&!event.shiftKey){event.preventDefault();send();}});
    document.querySelector('[role="button"]')?.addEventListener('click',send);
    document.querySelector('form').addEventListener('submit',event=>{event.preventDefault();send();});</script></body></html>`;
}

for (const host of ['chatgpt.com', 'chat.openai.com', 'claude.ai', 'gemini.google.com', 'chat.deepseek.com', 'grok.com', 'www.meta.ai', 'meta.ai']) test(`${host}: extension updates reconnect open drafts without reloading or duplicate submissions`, async () => {
  const extension = path.join(root, 'dist');
  const context = await chromium.launchPersistentContext('', { channel: 'chromium', headless: true, reducedMotion: 'reduce',
    ignoreDefaultArgs: ['--disable-extensions'],
    args: [`--disable-extensions-except=${extension}`, `--load-extension=${extension}`] });
  try {
    let worker = context.serviceWorkers()[0] ?? await context.waitForEvent('serviceworker');
    const extensions = await context.newPage();
    await extensions.goto('chrome://extensions');
    const developerMode = extensions.locator('extensions-toolbar #devMode');
    await expect(developerMode).toBeVisible();
    await developerMode.evaluate(toggle => { if (!toggle.checked) toggle.click(); });
    await extensions.close();
    await worker.evaluate(() => chrome.storage.local.set({ policy: { mode: 'redact', protectClientIds: false, sensitiveNames: ['dataset_key'] } }));
    await context.route(`https://${host}/**`, route => route.fulfill({ contentType: 'text/html', body: fixture(host) }));
    const page = await context.newPage(), errors = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.goto(`https://${host}/${host === 'claude.ai' ? 'chat' : 'c'}/synthetic-reload`);
    const tabId = await worker.evaluate(async host => (await chrome.tabs.query({ url: `https://${host}/*` }))[0].id, host);
    const ready = () => expect.poll(() => worker.evaluate(async id => {
      try { return (await chrome.tabs.sendMessage(id, { type: 'coverage' })).ready; }
      catch { return false; }
    }, tabId)).toBe(true);
    await ready();
    const navigation = await page.evaluate(() => performance.timeOrigin);
    const editor = page.locator('textarea,[contenteditable],input');
    const dialog = page.getByRole('dialog');
    const submitted = [];
    for (const cycle of [0, 1]) {
      const separator = host.endsWith('meta.ai') ? '; ' : '\n';
      const draft = `openai_api_key = xxxxxxxxxx${separator}dataset_key = synthetic-reload-${cycle}-123`;
      await editor.fill(draft);
      // A page-created handoff event cannot retire a connected guard.
      await page.evaluate(() => window.dispatchEvent(new Event('ckretguard-reconnect')));
      await editor.press('Enter');
      await expect(dialog).toBeVisible();
      await page.evaluate(() => { window.oldActions = [...document.querySelector('#ckretguard-review').shadowRoot.querySelectorAll('button')]; });
      await expect.poll(() => worker.evaluate(async () => (await chrome.storage.local.get('activity')).activity?.detected)).toBe(cycle * 2 + 1);
      const replacement = context.waitForEvent('serviceworker');
      await worker.evaluate(() => chrome.runtime.reload());
      worker = await replacement;
      await ready();
      await expect(page.locator('#ckretguard-review')).toHaveCount(0);
      expect(await editor.evaluate(element => element.value ?? element.innerText)).toBe(draft);
      expect(await page.evaluate(() => performance.timeOrigin)).toBe(navigation);
      await page.evaluate(() => window.oldActions.forEach(button => button.click()));
      expect(await page.evaluate(() => window.submitted.length)).toBe(cycle);
      if (cycle === 1) {
        // Repeated injection in a live world also replaces listeners rather than stacking them.
        await worker.evaluate(async id => {
          const script = chrome.runtime.getManifest().content_scripts[0];
          for (let i = 0; i < 2; i++) await chrome.scripting.executeScript({ target: { tabId: id }, files: script.js });
        }, tabId);
        await ready();
      }
      await editor.press('Enter');
      await expect(dialog).toBeVisible();
      await dialog.getByRole('button', { name: cycle === 0 ? 'Mask' : 'Send', exact: true }).click();
      submitted.push(cycle === 0 ? `openai_api_key = xxxxxxxxxx${separator}dataset_key = xxxxxxxxxx` : draft);
      await expect.poll(() => page.evaluate(() => window.submitted)).toEqual(submitted);
      await expect.poll(() => worker.evaluate(async () => (await chrome.storage.local.get('activity')).activity)).toEqual({ detected: cycle * 2 + 2, maskedPrompts: 1, unmaskedPrompts: cycle });
      const policy = await worker.evaluate(async () => (await chrome.storage.local.get('policy')).policy);
      expect(policy).toEqual({ mode: 'redact', protectClientIds: false, sensitiveNames: ['dataset_key'] });
    }
    expect(errors).toEqual([]);
  } finally { await context.close(); }
});

for (const host of ['chatgpt.com', 'claude.ai', 'gemini.google.com', 'chat.deepseek.com', 'grok.com', 'www.meta.ai', 'meta.ai']) for (const missing of ['id', 'runtime']) test(`${host}: disconnected ${missing} blocks sending with a visible refresh notice`, async () => {
  const browser = await chromium.launch({ channel: 'chromium' });
  try {
    const page = await browser.newPage({ reducedMotion: 'reduce' }), errors = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.route(`https://${host}/**`, route => route.fulfill({ contentType: 'text/html', body: fixture(host) }));
    await page.goto(`https://${host}/`);
    await page.evaluate(() => {
      const attach = Element.prototype.attachShadow;
      Element.prototype.attachShadow = function(options) {
        const shadow = attach.call(this, options);
        if (this.id === 'secret-shield-notice') window.noticeShadow = shadow;
        return shadow;
      };
      window.chrome = { storage: { local: { get: async () => ({}) }, managed: { get: async () => ({}) }, onChanged: { addListener() {} } },
        runtime: { id: 'synthetic-extension', getURL: file => `chrome-extension://synthetic/${file}`, onMessage: { addListener: listener => { window.coverageListener = listener; } } } };
    });
    for (const name of ['core', 'policy', 'adapters', 'content']) await page.addScriptTag({ content: await readFile(path.join(root, 'src', name + '.js'), 'utf8') });
    await expect.poll(() => page.evaluate(() => new Promise(resolve => window.coverageListener({ type: 'coverage' }, null, resolve)))).toMatchObject({ ready: true });
    await page.evaluate(missing => {
      if (missing === 'runtime') delete chrome.runtime;
      else { delete chrome.runtime.id; chrome.runtime.getURL = () => { throw new Error('Extension context invalidated.'); }; }
    }, missing);
    const editor = page.locator('textarea,[contenteditable],input');
    for (const draft of ['api_key=synthetic-disconnected-123', 'A plain prompt.']) {
      await editor.fill(draft);
      await editor.press('Enter');
      await page.locator('form button, form [role="button"]').click();
      await page.locator('form').evaluate(form => form.requestSubmit());
      await expect(page.locator('#secret-shield-notice')).toBeVisible();
      expect(await page.evaluate(() => window.noticeShadow.textContent)).toContain(refreshMessage);
      expect(await editor.evaluate(element => element.value ?? element.innerText)).toBe(draft);
      expect(await page.evaluate(() => window.submitted)).toEqual([]);
    }
    expect(errors).toEqual([]);
  } finally { await browser.close(); }
});
