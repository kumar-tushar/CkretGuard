import { test, expect, chromium } from '@playwright/test';
import path from 'node:path';
import { credentialCases, plainCases } from '../fixtures/credentials.mjs';

const extension = path.resolve('dist');
let context, worker, chatSequence = 0;
const review = page => page.getByRole('dialog');
const fixture = host => `<!doctype html><html lang="en"><head><title>Synthetic submission</title></head><body><form>
  <div contenteditable="true" ${host === 'claude.ai' ? 'class="tiptap" data-testid="chat-input"' : 'id="prompt-textarea" role="textbox" data-composer-markdown=""'} style="min-height:80px;white-space:pre-wrap"></div>
  <button data-testid="send-button" aria-label="Send message">Send</button></form><script>
  window.options={};window.current='';window.submitted=[];window.commitTimer=null;window.remounted=false;
  const editor=()=>document.querySelector('[contenteditable]'),button=()=>document.querySelector('[data-testid="send-button"]');
  const send=()=>{window.submitted.push(window.current);fetch('/test-submit',{method:'POST',body:window.current});if(window.options.clearOnSend){editor().textContent='';editor().dispatchEvent(new InputEvent('input',{bubbles:true}));}};
  function bind(element){
    element.addEventListener('input',()=>{
      const value=element.innerText,control=button();clearTimeout(window.commitTimer);if(control)control.disabled=true;
      const commit=()=>{window.current=value;if(control)control.disabled=false;};
      if(window.options.delay)window.commitTimer=setTimeout(commit,window.options.delay);else commit();
      if(window.options.remount&&!window.remounted){window.remounted=true;queueMicrotask(()=>{const replacement=element.cloneNode(true);element.replaceWith(replacement);bind(replacement);});}
    });
    element.addEventListener('keydown',event=>{if(event.key==='Enter'&&!event.shiftKey){event.preventDefault();if(!button().disabled)button().click();}});
  }
  bind(editor());
  button().addEventListener('click',event=>{
    if(window.options.submit==='click'){event.preventDefault();send();}
    if(window.options.submit==='deferred'){event.preventDefault();setTimeout(()=>{document.querySelector('form').requestSubmit();if(window.options.duplicate)document.querySelector('form').requestSubmit();window.deferredComplete=true;},window.options.submitDelay||20);}
  });
  document.querySelector('form').addEventListener('submit',event=>{event.preventDefault();if(window.options.submit!=='click')send();});
  </script></body></html>`;

test.beforeAll(async () => {
  context = await chromium.launchPersistentContext('', { channel: 'chromium', headless: true, reducedMotion: 'reduce',
    args: [`--disable-extensions-except=${extension}`, `--load-extension=${extension}`] });
  worker = context.serviceWorkers()[0] ?? await context.waitForEvent('serviceworker');
  await context.route(/^https:\/\/(?:chatgpt\.com|claude\.ai)\//, route => route.fulfill({
    contentType: route.request().method() === 'POST' ? 'text/plain' : 'text/html',
    body: route.request().method() === 'POST' ? 'ok' : fixture(new URL(route.request().url()).hostname),
  }));
});
test.afterEach(async () => {
  for (const page of context.pages()) await page.close();
  await worker.evaluate(async () => { await pending; await SecretShieldHistory.perform('clear'); await chrome.storage.local.clear(); });
});
test.afterAll(async () => { await context?.close(); });

async function chat(host) {
  await worker.evaluate(() => chrome.storage.local.set({ policy: { sensitiveNames: ['dataset_key'] } }));
  const page = await context.newPage(), requests = [], errors = [];
  page.on('request', request => { if (request.method() === 'POST') requests.push(request.postData()); });
  page.on('pageerror', error => errors.push(error.message));
  await page.goto(`https://${host}/${host === 'claude.ai' ? 'chat' : 'c'}/synthetic-stress-${++chatSequence}`);
  const id = await worker.evaluate(async url => (await chrome.tabs.query({ url }))[0].id, page.url());
  await expect.poll(() => worker.evaluate(async id => {
    try { return (await chrome.tabs.sendMessage(id, { type: 'coverage' })).ready; } catch { return false; }
  }, id)).toBe(true);
  return { page, id, requests, errors, editor: page.locator('[contenteditable]') };
}

test('eight concurrent ChatGPT and Claude tabs keep approvals, outgoing prompts, and History independent', async () => {
  const states = [];
  for (let i = 0; i < 8; i++) states.push(await chat(i % 2 ? 'claude.ai' : 'chatgpt.com'));
  for (const [i, state] of states.entries()) await prepare(state, `<p>api_key = synthetic-tab-${i}-123</p>`);
  await Promise.all(states.map(async (state, i) => {
    const action = i % 4 < 2 ? 'Send' : 'Mask';
    await review(state.page).getByRole('button', { name: action, exact: true }).evaluate(button => { button.click(); button.click(); });
    await checkSent(state, `api_key = ${action === 'Send' ? `synthetic-tab-${i}-123` : 'xxxxxxxxxx'}`);
  }));
  await expect.poll(() => worker.evaluate(async () => (await chrome.storage.local.get('activity')).activity)).toEqual({ detected: 8, maskedPrompts: 4, unmaskedPrompts: 4 });
  await worker.evaluate(() => pending);
  const history = await worker.evaluate(async () => (await SecretShieldHistory.perform('list')).entries);
  expect(history).toHaveLength(4);
  expect(history.map(item => item.site).sort()).toEqual(['ChatGPT', 'ChatGPT', 'Claude', 'Claude']);
  expect(new Set(history.map(item => item.url)).size).toBe(4);
});
async function prepare(state, html) {
  await state.page.evaluate(() => { window.options = {}; window.remounted = false; });
  await state.editor.evaluate((element, html) => { element.innerHTML = html; element.dispatchEvent(new InputEvent('input', { bubbles: true })); }, html);
  await expect(state.page.getByRole('button', { name: 'Send message', exact: true })).toBeEnabled();
  const original = await state.editor.innerText();
  await state.editor.press('Enter');
  await expect(review(state.page)).toBeVisible();
  return original;
}
async function checkSent(state, expected, count = 1) {
  await expect.poll(() => state.requests.length).toBe(count);
  expect(state.requests[count - 1]).toBe(expected);
  expect(await state.page.evaluate(() => window.submitted.length)).toBe(count);
  await expect(review(state.page)).toBeHidden();
  expect(await state.page.locator('#secret-shield-notice').count()).toBe(0);
  expect(state.errors).toEqual([]);
}

for (const host of ['chatgpt.com', 'claude.ai']) {
  for (let start = 0; start < credentialCases.length; start += 12) {
    for (const action of ['Edit', 'Send', 'Mask']) test(`${host}: credential catalog ${start + 1}-${Math.min(start + 12, credentialCases.length)} via ${action}`, async () => {
      const state = await chat(host);
      let submissions = 0;
      for (const [index, item] of credentialCases.slice(start, start + 12).entries()) {
        await test.step(item.name, async () => {
          await state.page.evaluate(() => { window.options = {}; });
          await state.editor.fill(item.input);
          await expect(state.page.getByRole('button', { name: 'Send message', exact: true })).toBeEnabled();
          if (index % 3 === 0) await state.editor.press('Enter');
          else if (index % 3 === 1) await state.editor.evaluate(editor => editor.closest('form').requestSubmit());
          else {
            const button = state.page.getByRole('button', { name: 'Send message', exact: true });
            const box = await button.boundingBox();
            await state.page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
          }
          await expect(review(state.page).getByRole('heading')).toHaveText(`${item.count} secret${item.count === 1 ? '' : 's'} detected`);
          expect(state.requests.length).toBe(submissions);
          await state.page.evaluate(index => { window.options = { submit: ['click', 'form', 'deferred'][index % 3] }; }, index);
          const choice = review(state.page).getByRole('button', { name: action, exact: true });
          if (index % 3 === 0) await choice.click();
          else await choice.press(index % 3 === 1 ? 'Enter' : ' ');
          if (action === 'Edit') {
            await expect(review(state.page)).toBeHidden();
            expect(await state.editor.innerText()).toBe(item.input);
            expect(state.requests).toEqual([]);
            await expect(state.editor).toBeFocused();
          } else {
            await checkSent(state, action === 'Send' ? item.input : item.masked, ++submissions);
          }
        });
      }
    });
  }

  test(`${host}: ordinary prompts and existing placeholders send without a review`, async () => {
    const state = await chat(host);
    for (const [index, input] of plainCases.entries()) {
      await state.editor.fill(input);
      await state.editor.press('Enter');
      await checkSent(state, input, index + 1);
    }
  });

  for (const action of ['Send', 'Mask']) test(`${host}: ${action} waits for a temporarily removed click-only Send control`, async () => {
    const state = await chat(host);
    const original = await prepare(state, '<p>client_secret = synthetic-removed-123</p>');
    await state.page.evaluate(action => {
      window.options.submit = 'click';
      const remove = () => {
        const button = document.querySelector('[data-testid="send-button"]');
        button.remove();
        setTimeout(() => document.querySelector('form').append(button), 200);
      };
      if (action === 'Send') remove();
      else document.querySelector('[contenteditable]').addEventListener('input', () => queueMicrotask(remove), { once: true });
    }, action);
    await review(state.page).getByRole('button', { name: action, exact: true }).click();
    await checkSent(state, action === 'Send' ? original : original.replace('synthetic-removed-123', 'xxxxxxxxxx'));
  });

  for (const action of ['Send', 'Mask']) test(`${host}: an explicit form-only ${action} attempt uses that same form`, async () => {
    const state = await chat(host);
    await state.editor.fill('password = synthetic-form-only-123');
    await state.page.evaluate(() => {
      document.querySelector('[data-testid="send-button"]').remove();
      document.querySelector('form').requestSubmit();
    });
    await expect(review(state.page)).toBeVisible();
    await review(state.page).getByRole('button', { name: action, exact: true }).click();
    await checkSent(state, action === 'Send' ? 'password = synthetic-form-only-123' : 'password = xxxxxxxxxx');
  });

  test(`${host}: block mode applies Edit and Mask to a mixed credential batch`, async () => {
    const state = await chat(host);
    await worker.evaluate(() => chrome.storage.local.set({ policy: { mode: 'block', sensitiveNames: ['dataset_key'] } }));
    const items = credentialCases.filter((_, i) => i % 5 === 0).slice(0, 10);
    const original = items.map(item => item.input).join('\n'), expected = items.map(item => item.masked).join('\n');
    await state.editor.fill(original);
    await state.editor.press('Enter');
    await expect(review(state.page).getByRole('button', { name: 'Send', exact: true })).toHaveCount(0);
    await review(state.page).getByRole('button', { name: 'Edit', exact: true }).click();
    expect(await state.editor.innerText()).toBe(original);
    expect(state.requests).toEqual([]);
    await state.editor.press('Enter');
    await review(state.page).getByRole('button', { name: 'Mask', exact: true }).click();
    await checkSent(state, expected);
  });

  test(`${host}: every one of 50 configured custom fields is detected and masked in one prompt`, async () => {
    const state = await chat(host);
    const names = Array.from({ length: 50 }, (_, i) => `custom_field_${i}`);
    await worker.evaluate(sensitiveNames => chrome.storage.local.set({ policy: { sensitiveNames } }), names);
    const original = names.map((name, i) => `${name} = synthetic-custom-${i}-123`).join('\n');
    await state.editor.fill(original);
    await state.editor.press('Enter');
    await expect(review(state.page).getByRole('heading')).toHaveText('50 secrets detected');
    await review(state.page).getByRole('button', { name: 'Mask', exact: true }).click();
    await checkSent(state, names.map(name => `${name} = xxxxxxxxxx`).join('\n'));
  });

  for (const action of ['Send', 'Mask']) test(`${host}: ${action} waits for a temporarily disabled Send control`, async () => {
    const state = await chat(host);
    const original = await prepare(state, '<p>api_key = synthetic-delayed-123</p>');
    await state.page.evaluate(action => {
      if (action === 'Mask') window.options.delay = 1200;
      else { const button = document.querySelector('[data-testid="send-button"]'); button.disabled = true; setTimeout(() => { button.disabled = false; }, 1200); }
    }, action);
    await review(state.page).getByRole('button', { name: action, exact: true }).click();
    await checkSent(state, action === 'Mask' ? original.replace('synthetic-delayed-123', 'xxxxxxxxxx') : original);
  });

  test(`${host}: Mask follows a framework remount only when the masked draft matches exactly`, async () => {
    const state = await chat(host);
    const original = await prepare(state, '<p>api_key = xxxxxxxxxx</p><p>dataset_key = synthetic-remount-123</p>');
    await state.page.evaluate(() => { window.options = { delay: 90, remount: true }; });
    await review(state.page).getByRole('button', { name: 'Mask', exact: true }).click();
    await checkSent(state, original.replace('synthetic-remount-123', 'xxxxxxxxxx'));
    expect(await state.page.evaluate(() => window.remounted)).toBe(true);
  });

  for (const action of ['Send', 'Mask']) test(`${host}: ${action} permits one deferred form submission after its approved click`, async () => {
    const state = await chat(host);
    const original = await prepare(state, '<p>client_secret = synthetic-deferred-123</p>');
    await state.page.evaluate(() => { window.options.submit = 'deferred'; });
    await review(state.page).getByRole('button', { name: action, exact: true }).click();
    await checkSent(state, action === 'Mask' ? original.replace('synthetic-deferred-123', 'xxxxxxxxxx') : original);
  });

  for (const action of ['Send', 'Mask']) for (const change of ['draft', 'policy']) test(`${host}: changing ${change} while ${action} waits cancels automatic sending`, async () => {
    const state = await chat(host);
    await prepare(state, '<p>api_key = synthetic-cancel-123</p>');
    await state.page.evaluate(action => {
      if (action === 'Mask') window.options.delay = 1200;
      else document.querySelector('[data-testid="send-button"]').disabled = true;
    }, action);
    await review(state.page).getByRole('button', { name: action, exact: true }).click();
    await expect(review(state.page)).toBeHidden();
    if (change === 'draft') await state.editor.fill('api_key = synthetic-changed-456');
    else await worker.evaluate(() => chrome.storage.local.set({ policy: { mode: 'block', sensitiveNames: ['dataset_key'] } }));
    await expect(state.page.locator('#secret-shield-notice')).toBeVisible();
    expect(state.requests).toEqual([]);
    expect(await worker.evaluate(async () => (await chrome.storage.local.get('activity')).activity)).toEqual({ detected: 1, maskedPrompts: 0, unmaskedPrompts: 0 });
    expect(state.errors).toEqual([]);
  });

  for (const action of ['Send', 'Mask']) test(`${host}: retiring a controller during pending ${action} cannot submit or recreate stale notices`, async () => {
    const state = await chat(host);
    await prepare(state, '<p>api_key = synthetic-teardown-123</p>');
    await state.page.evaluate(action => {
      if (action === 'Mask') window.options.delay = 1200;
      else {
        const button = document.querySelector('[data-testid="send-button"]');
        button.disabled = true;
        setTimeout(() => { button.disabled = false; }, 1200);
      }
    }, action);
    await review(state.page).getByRole('button', { name: action, exact: true }).click();
    await expect(review(state.page)).toBeHidden();
    await state.page.evaluate(() => {
      window.staleNotices = [];
      new MutationObserver(records => {
        for (const record of records) for (const node of record.addedNodes) {
          if (node.id === 'secret-shield-notice') window.staleNotices.push(node.id);
        }
      }).observe(document.body, { childList: true });
    });
    await worker.evaluate(id => chrome.scripting.executeScript({ target: { tabId: id }, func: () => globalThis.SecretShieldContent() }), state.id);
    await worker.evaluate(id => chrome.scripting.executeScript({ target: { tabId: id }, files: chrome.runtime.getManifest().content_scripts[0].js }), state.id);
    await expect.poll(() => worker.evaluate(async id => (await chrome.tabs.sendMessage(id, { type: 'coverage' })).ready, state.id)).toBe(true);
    await expect(state.page.getByRole('button', { name: 'Send message', exact: true })).toBeEnabled();
    expect(state.requests).toEqual([]);
    expect(await state.page.evaluate(() => window.staleNotices)).toEqual([]);
    expect(await state.page.locator('#secret-shield-notice').count()).toBe(0);
    expect(state.errors).toEqual([]);
    await state.editor.press('Enter');
    if (action === 'Send') await review(state.page).getByRole('button', { name: 'Send', exact: true }).click();
    await checkSent(state, action === 'Send' ? 'api_key = synthetic-teardown-123' : 'api_key = xxxxxxxxxx');
  });

  for (const change of ['draft', 'policy', 'expiry']) test(`${host}: deferred unmasked submission requires an unchanged, unexpired approval: ${change}`, async () => {
    const state = await chat(host);
    await prepare(state, '<p>client_secret = synthetic-approval-123</p>');
    await state.page.evaluate(change => { window.options = { submit: 'deferred', submitDelay: change === 'expiry' ? 3200 : 250 }; }, change);
    await review(state.page).getByRole('button', { name: 'Send', exact: true }).click();
    await expect.poll(() => worker.evaluate(async () => (await chrome.storage.local.get('activity')).activity?.unmaskedPrompts)).toBe(1);
    if (change === 'draft') await state.editor.fill('client_secret = synthetic-changed-456');
    if (change === 'policy') await worker.evaluate(() => chrome.storage.local.set({ policy: { mode: 'block', sensitiveNames: ['dataset_key'] } }));
    await expect.poll(() => state.page.evaluate(() => window.deferredComplete)).toBe(true);
    await expect(review(state.page)).toBeVisible();
    if (change === 'policy') await expect(review(state.page).getByRole('button', { name: 'Send', exact: true })).toHaveCount(0);
    expect(state.requests).toEqual([]);
    expect(state.errors).toEqual([]);
  });

  for (const action of ['Send', 'Mask']) for (const clearOnSend of [false, true]) test(`${host}: ${action} blocks duplicate framework form callbacks with clear=${clearOnSend}`, async () => {
    const state = await chat(host);
    const original = await prepare(state, '<p>api_key = synthetic-duplicate-123</p>');
    await state.page.evaluate(clearOnSend => { window.options = { submit: 'deferred', duplicate: true, clearOnSend }; }, clearOnSend);
    await review(state.page).getByRole('button', { name: action, exact: true }).click();
    await expect.poll(() => state.page.evaluate(() => window.deferredComplete)).toBe(true);
    await checkSent(state, action === 'Mask' ? original.replace('synthetic-duplicate-123', 'xxxxxxxxxx') : original);
    if (clearOnSend) {
      await state.page.evaluate(() => { window.options = {}; });
      await state.editor.fill('client_secret = synthetic-next-prompt-456');
      await state.editor.press('Enter');
      await expect(review(state.page)).toBeVisible();
      expect(state.requests).toHaveLength(1);
      await review(state.page).getByRole('button', { name: 'Mask', exact: true }).click();
      await checkSent(state, 'client_secret = xxxxxxxxxx', 2);
    }
  });

  for (const replacement of ['changed', 'ambiguous']) test(`${host}: Mask rejects a ${replacement} replacement editor`, async () => {
    const state = await chat(host);
    await prepare(state, '<p>api_key = synthetic-remount-123</p>');
    await state.page.evaluate(replacement => {
      window.options = { delay: 90, remount: true };
      document.querySelector('[contenteditable]').addEventListener('input', () => queueMicrotask(() => {
        const editor = document.querySelector('[contenteditable]');
        if (replacement === 'changed') editor.textContent = 'api_key = synthetic-unapproved-456';
        else editor.after(editor.cloneNode(true));
      }), { once: true });
    }, replacement);
    await review(state.page).getByRole('button', { name: 'Mask', exact: true }).click();
    await expect(state.page.locator('#secret-shield-notice')).toBeVisible();
    expect(state.requests).toEqual([]);
    expect(state.errors).toEqual([]);
  });

  for (const action of ['Send', 'Mask']) test(`${host}: repeated ${action} sends 25 varied drafts exactly once each`, async () => {
    const state = await chat(host);
    for (let iteration = 0; iteration < 25; iteration++) {
      const value = `synthetic-stress-${iteration}-123`;
      const html = [
        `<p>openai_api_key = xxxxxxxxxx</p><p>api_key = ${value}</p>`,
        `<p>Explain 🧪 this config.</p><p><br></p><p>dataset_key = ${value}</p><p>Keep this paragraph.</p>`,
        `<p><strong>Keep this style.</strong></p><p>client_secret = synthetic-<em>stress-${iteration}</em>-123</p>`,
      ][iteration % 3];
      const original = await prepare(state, html);
      await state.page.evaluate(({ action, iteration }) => {
        window.options = { submit: iteration % 3 === 0 ? 'click' : iteration % 3 === 1 ? 'form' : 'deferred',
          delay: action === 'Mask' ? [0, 40, 120][iteration % 3] : 0,
          remount: action === 'Mask' && iteration % 4 === 3 };
        if (action === 'Send' && iteration % 3) { const button = document.querySelector('[data-testid="send-button"]'); button.disabled = true; setTimeout(() => { button.disabled = false; }, 80); }
      }, { action, iteration });
      const choice = await review(state.page).getByRole('button', { name: action, exact: true }).elementHandle();
      await choice.evaluate(button => { button.click(); button.click(); });
      await checkSent(state, action === 'Mask' ? original.replaceAll(value, 'xxxxxxxxxx') : original, iteration + 1);
      await choice.dispose();
    }
    const activity = await worker.evaluate(async () => (await chrome.storage.local.get('activity')).activity);
    expect(activity).toEqual({ detected: 25, maskedPrompts: action === 'Mask' ? 25 : 0, unmaskedPrompts: action === 'Send' ? 25 : 0 });
  });
}
