import { test, expect, chromium } from '@playwright/test';
import { readFile, mkdir } from 'node:fs/promises';
import path from 'node:path';

const root = path.resolve('.');
const extension = path.join(root, 'dist');
const key = 'sk-proj-' + 'SyntheticOnly9_'.repeat(5);
let context, composer, extensionId;
function fixture(kind = 'textarea', unknown = false, delayed = false) {
  const editor = kind === 'textarea' ? `<textarea ${unknown ? 'id="unknown"' : 'id="prompt-textarea"'}></textarea>` : kind === 'markdown' ?
    '<div contenteditable="true" aria-multiline="true" role="textbox" data-composer-markdown="" aria-label="Ask ChatGPT" data-virtualkeyboard="true" class="ProseMirror" style="white-space:pre-wrap;min-height:100px;border:1px solid"></div>' :
    `<div class="tiptap" data-testid="chat-input" contenteditable="true" role="textbox" style="white-space:pre-wrap;min-height:100px;border:1px solid"></div>`;
  return `<!doctype html><html><body><form>${editor}<button type="submit" data-testid="send-button" aria-label="Send message">Send</button></form><script>
    window.submitted=[]; window.current='';
    const editor=document.querySelector('textarea,[contenteditable]');
    const read=()=>editor.value??editor.innerText;
    editor.addEventListener('input',()=>{
      if (window.frameworkSync) return;
      const value=read();
      if (${Boolean(delayed)}) {
        const button=document.querySelector('[data-testid="send-button"]');
        button.disabled=true;
        if (${delayed === 'removed'}) button.remove();
        clearTimeout(window.syncTimer);
        window.syncTimer=setTimeout(()=>{
          window.current=value;
          if (${delayed === 'same-text'}) {
            window.frameworkSync=true;
            editor.dispatchEvent(new InputEvent('input',{bubbles:true}));
            window.frameworkSync=false;
          }
          const replacement=button.cloneNode(true);replacement.disabled=false;
          if (button.isConnected) button.replaceWith(replacement);
          else document.querySelector('form').append(replacement);
        },100);
      } else window.current=value;
    });
    const send=()=>{window.submitted.push(window.current);fetch('/test-submit',{method:'POST',body:window.current})};
    editor.addEventListener('keydown',e=>{if(e.key==='Enter'&&!e.shiftKey){e.preventDefault();send()}});
    document.querySelector('form').addEventListener('submit',e=>{e.preventDefault();send()});
  </script></body></html>`;
}

test.beforeAll(async () => {
  context = await chromium.launchPersistentContext('', {channel:'chromium',headless:true,reducedMotion:'reduce',
    args:[`--disable-extensions-except=${extension}`,`--load-extension=${extension}`]});
  const worker = context.serviceWorkers()[0] ?? await context.waitForEvent('serviceworker', {timeout:10000});
  extensionId = new URL(worker.url()).hostname;
  // Nothing reaches the actual AI services: these are local DOM/API contract fixtures.
  await context.route(/^https:\/\/(?:chatgpt\.com|claude\.ai)\//, async route => {
    if (route.request().method() === 'POST') await route.fulfill({status:200,body:'ok'});
    else {
      const url=new URL(route.request().url());
      const delayed=url.pathname === '/delayed-missing-send' ? 'removed' : url.pathname === '/delayed-sync-event' ? 'same-text' : url.pathname === '/delayed';
      await route.fulfill({contentType:'text/html',body:fixture(url.hostname === 'claude.ai' ? 'editable' : url.pathname === '/markdown' ? 'markdown':'textarea', url.pathname.includes('unknown'), delayed)});
    }
  });
  composer = await context.newPage();
  await composer.goto(`chrome-extension://${extensionId}/composer.html`);
  await expect(composer.locator('#sensitive-names')).toBeEnabled();
  await composer.locator('#fields-title').click();
});
test.afterAll(async () => { await context?.close(); });
test.afterEach(async () => {
  const worker=context.serviceWorkers()[0];
  if (worker) await worker.evaluate(()=>pending);
  if (composer) {
    await composer.evaluate(()=>SecretShieldHistory.request('clear'));
    await composer.evaluate(()=>{location.hash='home';});
    await expect(composer.locator('#home-view')).toBeVisible();
    await composer.evaluate(()=>chrome.storage.local.clear());
    await expect(composer.locator('#sensitive-names')).toBeEnabled();
    await expect(composer.locator('#saved-fields li')).toHaveCount(0);
    await composer.locator('#custom-fields').evaluate(el=>{el.open=true;});
    await composer.locator('#sensitive-names').fill('');
  }
});

async function chat(host='chatgpt.com', suffix='') {
  const page = await context.newPage();
  await page.goto(`https://${host}/${suffix}`);
  await page.bringToFront();
  await expect.poll(async () => composer.evaluate(async () => {
    const [tab] = await chrome.tabs.query({active:true,currentWindow:true});
    return (await chrome.tabs.sendMessage(tab.id,{type:'coverage'})).ready;
  })).toBe(true);
  return page;
}

const review = page => page.getByRole('dialog', { name: /^\d+ secrets? detected$/ });
const editorText = editor => editor.evaluate(el=>el.value??el.innerText);
async function activity() {
  return composer.evaluate(()=>SecretShieldStats.read());
}
async function addFields(names) {
  for (const name of names) {
    await composer.locator('#sensitive-names').fill(name);
    await composer.locator('#save-fields').click();
    await expect(composer.locator('#saved-fields span').getByText(name.trim(),{exact:true})).toHaveCount(1);
    await expect(composer.locator('#sensitive-names')).toHaveValue('');
  }
}

for (const host of ['chatgpt.com','claude.ai']) test(`${host}: activity counts review choices without invalidating the draft`, async () => {
  const page=await chat(host); const editor=page.locator('textarea,[contenteditable]');
  await editor.fill('api_key=synthetic-one-123\npassword=synthetic-two-456\nclient_id=synthetic-three-789');
  await clickSend(page);
  await expect(review(page)).toBeVisible();
  await expect.poll(activity).toEqual({detected:3,maskedPrompts:0,unmaskedPrompts:0});
  await expect(review(page)).toBeVisible();
  await review(page).getByRole('button',{name:'Edit',exact:true}).click();
  await expect.poll(activity).toEqual({detected:3,maskedPrompts:0,unmaskedPrompts:0});
  await editor.fill('api_key=synthetic-mask-123\npassword=synthetic-mask-456');
  await editor.press('Enter');
  await expect(review(page)).toBeVisible();
  await expect.poll(activity).toEqual({detected:5,maskedPrompts:0,unmaskedPrompts:0});
  await review(page).getByRole('button',{name:'Mask',exact:true}).click();
  await expect.poll(activity).toEqual({detected:5,maskedPrompts:1,unmaskedPrompts:0});
  await expect.poll(()=>page.evaluate(()=>window.submitted)).toEqual(['api_key=xxxxxxxxxx\npassword=xxxxxxxxxx']);
  await editor.fill('client_secret=synthetic-send-123\nclient_id=synthetic-send-456');
  await editor.press('Enter');
  await expect(review(page)).toBeVisible();
  await expect.poll(activity).toEqual({detected:7,maskedPrompts:1,unmaskedPrompts:0});
  await review(page).getByRole('button',{name:'Send',exact:true}).click();
  await expect.poll(activity).toEqual({detected:7,maskedPrompts:1,unmaskedPrompts:1});
  const stored=await composer.evaluate(async()=>JSON.stringify(await chrome.storage.local.get(null)));
  expect(stored).not.toContain('synthetic');
  await expect(composer.locator('#stat-detected')).toHaveText('7');
  await expect(composer.locator('#stat-maskedPrompts')).toHaveText('1');
  await expect(composer.locator('#stat-unmaskedPrompts')).toHaveText('1');
  await expect(composer.locator('#stat-edited')).toHaveCount(0);
  await page.close();
});

test('custom fields persist locally without incrementing activity', async () => {
  await addFields([' dataset1 ','project_code']);
  await composer.locator('#sensitive-names').fill('DATASET1');
  await composer.locator('#save-fields').click();
  await expect(composer.locator('#field-status')).toContainText('already saved');
  await expect(composer.locator('#saved-fields span')).toHaveText(['project_code','dataset1']);
  await expect.poll(activity).toEqual({detected:0,maskedPrompts:0,unmaskedPrompts:0});
  await composer.locator('#sensitive-names').fill('unsaved_field');
  await composer.evaluate(()=>chrome.storage.local.set({activity:{detected:12,maskedPrompts:0,unmaskedPrompts:0}}));
  await expect(composer.locator('#stat-detected')).toHaveText('12');
  await expect(composer.locator('#sensitive-names')).toHaveValue('unsaved_field');
  await composer.reload();
  await expect(composer.locator('#sensitive-names')).toBeEnabled();
  await expect(composer.locator('#sensitive-names')).toHaveValue('');
  await expect(composer.locator('#saved-fields span')).toHaveText(['project_code','dataset1']);
  await expect(composer.locator('#stat-detected')).toHaveText('12');
  await expect(composer.locator('#stat-maskedPrompts')).toHaveText('0');
  await expect(composer.locator('#draft,#result,#copy,#mask')).toHaveCount(0);
  const manifest=await composer.evaluate(()=>chrome.runtime.getManifest());
  expect(manifest.action.default_popup).toBe('composer.html');
});

test('single-field entry supports Enter and removing one saved field preserves the others', async () => {
  await composer.locator('#sensitive-names').press('Enter');
  await expect(composer.locator('#save-fields')).toBeDisabled();
  await expect(composer.locator('#field-status')).toHaveText('');
  await expect(composer.locator('#saved-fields li')).toHaveCount(0);
  await composer.locator('#sensitive-names').fill('dataset1');
  await composer.locator('#sensitive-names').press('Enter');
  await expect(composer.locator('#saved-fields span')).toHaveText(['dataset1']);
  await expect(composer.locator('#sensitive-names')).toHaveValue('');
  await addFields(['project_code']);
  await composer.getByRole('button',{name:'Remove dataset1',exact:true}).click();
  await expect(composer.locator('#saved-fields span')).toHaveText(['project_code']);
  await composer.reload();
  await expect(composer.locator('#saved-fields span')).toHaveText(['project_code']);
  expect(await composer.evaluate(async()=>(await chrome.storage.local.get('policy')).policy.sensitiveNames)).toEqual(['project_code']);
});

test('field Save requires three characters and routine field changes remain quiet', async () => {
  const input=composer.locator('#sensitive-names');
  const save=composer.locator('#save-fields');
  await expect(composer.locator('#field-status')).toHaveText('');
  await expect(composer.getByText('No custom fields saved yet.',{exact:true})).toHaveCount(0);
  for (const draft of ['', 'a', 'ab', '  ab  ']) {
    await input.fill(draft);
    await expect(save).toBeDisabled();
    await expect(save).toHaveCSS('background-color','rgb(48, 48, 48)');
  }
  await input.focus();
  await expect(input).toHaveCSS('outline-style','none');
  await expect(input).toHaveCSS('box-shadow','none');
  await input.press('Enter');
  expect(await composer.evaluate(async()=>(await chrome.storage.local.get('policy')).policy)).toBeUndefined();
  await input.fill('abc');
  await expect(save).toBeEnabled();
  await expect(save).toHaveCSS('background-color','rgb(69, 214, 200)');
  await save.click();
  await expect(input).toHaveValue('');
  await expect(save).toBeDisabled();
  await expect(composer.locator('#field-status')).toHaveText('');
  await addFields(['new_dataset']);
  await expect(composer.locator('#saved-fields span')).toHaveText(['new_dataset','abc']);
  await expect(composer.locator('#field-status')).toHaveText('');
  await composer.getByRole('button',{name:'Remove abc',exact:true}).click();
  await expect(composer.locator('#saved-fields span')).toHaveText(['new_dataset']);
  await expect(composer.locator('#field-status')).toHaveText('');
});

test('failed field and settings writes preserve saved values and allow retry', async () => {
  await addFields(['dataset1']);
  await composer.locator('#protection-settings').evaluate(el=>{el.open=true;});
  const worker=context.serviceWorkers()[0];
  await worker.evaluate(()=>{
    const original=chrome.storage.local.set;
    globalThis.restoreSettingsStorage=()=>{chrome.storage.local.set=original;};
    chrome.storage.local.set=async()=>{throw new Error('synthetic storage failure');};
  });
  try {
    await composer.locator('#sensitive-names').fill('dataset2');
    await composer.locator('#save-fields').click();
    await expect(composer.locator('#field-status')).toHaveText('Could not save fields. Try again.');
    await expect(composer.locator('#field-status')).toHaveCSS('color','rgb(255, 107, 107)');
    await expect(composer.locator('#sensitive-names')).toHaveValue('dataset2');
    await composer.getByRole('radio',{name:'Edit or Mask',exact:true}).click();
    await expect(composer.locator('#settings-status')).toContainText('Could not save settings');
    await expect(composer.locator('#settings-status')).toHaveCSS('color','rgb(255, 107, 107)');
    await expect(composer.getByRole('radio',{name:'Send, Edit, or Mask',exact:true})).toBeChecked();
    await composer.locator('#client-ids').click();
    await expect(composer.locator('#client-ids')).toBeChecked();
    const policy=await composer.evaluate(async()=>(await chrome.storage.local.get('policy')).policy);
    expect(policy.mode).toBe('redact');
    expect(policy.protectClientIds).toBe(true);
    expect(policy.sensitiveNames).toEqual(['dataset1']);
  } finally {
    await worker.evaluate(()=>{restoreSettingsStorage();delete globalThis.restoreSettingsStorage;});
  }
  await composer.locator('#save-fields').click();
  await expect(composer.locator('#saved-fields span')).toHaveText(['dataset2','dataset1']);
  await expect(composer.locator('#field-status')).toHaveText('');
  await expect(composer.locator('#field-status')).not.toHaveClass(/error/);
  await composer.getByRole('radio',{name:'Edit or Mask',exact:true}).check();
  await expect(composer.getByRole('radio',{name:'Edit or Mask',exact:true})).toBeEnabled();
  await expect.poll(()=>composer.evaluate(async()=>(await chrome.storage.local.get('policy')).policy.mode)).toBe('block');
  await expect(composer.locator('#settings-status')).toHaveText('');
  await expect(composer.locator('#settings-status')).not.toHaveClass(/error/);
});

for (const host of ['chatgpt.com','claude.ai']) test(`${host}: client-ID selection saves automatically without disabling client-secret detection`, async () => {
  const page=await chat(host); const editor=page.locator('textarea,[contenteditable]');
  const original=['client_id','client-id','Client ID','clientId','clienT  ID'].map((name,i)=>`${name}=synthetic-public-app-${i}`).join('\n');
  await editor.fill(original); await editor.press('Enter');
  await expect(review(page)).toBeVisible();
  await composer.locator('#protection-settings').evaluate(el=>{el.open=true;});
  await composer.locator('#client-ids').uncheck();
  await expect(composer.locator('#client-ids')).toBeEnabled();
  await expect.poll(()=>composer.evaluate(async()=>(await chrome.storage.local.get('policy')).policy.protectClientIds)).toBe(false);
  await expect(review(page)).toBeHidden();
  await editor.press('Enter');
  await expect.poll(()=>page.evaluate(()=>window.submitted)).toEqual([original]);
  await editor.fill('client_secret=synthetic-private-456\npassword=synthetic-private-789');
  await editor.press('Enter');
  await expect(review(page).getByRole('heading')).toHaveText('2 secrets detected');
  await review(page).getByRole('button',{name:'Edit',exact:true}).click();
  await composer.locator('#client-ids').check();
  await expect(composer.locator('#client-ids')).toBeEnabled();
  await editor.fill(original); await editor.press('Enter');
  await expect(review(page)).toBeVisible();
  await page.close();
});

for (const host of ['chatgpt.com','claude.ai']) test(`${host}: credential field spelling variants trigger review and mask every value`, async () => {
  const page=await chat(host); const editor=page.locator('textarea,[contenteditable]');
  const names=['key','apiKey','api key','api-key','api_key','apiToken','api-token','api token','api_token',
    'client_secret','client secret','clientsecret','client-secret','access_token','access token','accesstoken','access-token',
    'authToken','auth-token','auth token','auth_token','refreshToken','refresh-token','refresh token','refresh_token',
    'privateKey','private-key','private key','private_key','secretKey','secret-key','secret key','secret_key',
    'awsSecretAccessKey','aws-secret-access-key','aws secret access key','aws_secret_access_key',
    'awsAccessKeyId','aws-access-key-id','aws access key id','aws_access_key_id','CLIENT-ID','clienT  Id'];
  const separators=[': ', ' = ', ' is ', ':    ', '= ', ' ='];
  const original=names.map((name,i)=>name+separators[i%separators.length]+`synthetic-format-${i}`).join('\n');
  const masked=names.map((name,i)=>name+separators[i%separators.length]+'xxxxxxxxxx').join('\n');
  await editor.fill(original); await editor.press('Enter');
  await expect(review(page).getByRole('heading')).toHaveText(`${names.length} secrets detected`);
  expect(await page.evaluate(()=>window.submitted)).toEqual([]);
  await review(page).getByRole('button',{name:'Edit',exact:true}).click();
  expect(await editorText(editor)).toBe(original);
  await editor.press('Enter');
  await review(page).getByRole('button',{name:'Mask',exact:true}).click();
  await expect.poll(()=>page.evaluate(()=>window.submitted)).toEqual([masked]);
  expect(await editorText(editor)).toBe(masked);
  await expect.poll(activity).toEqual({detected:names.length*2,maskedPrompts:1,unmaskedPrompts:0});
  await page.close();
});

for (const host of ['chatgpt.com','claude.ai']) test(`${host}: rushed and pasted prompts preserve Edit and Send and fully mask outgoing requests`, async () => {
  const page=await chat(host); const editor=page.locator('textarea,[contenteditable]');
  const requests=[];
  page.on('request',request=>{if(request.method()==='POST') requests.push(request.postData());});
  const cases=[
    ['⚡clienT  secret:    fake-quick-123\nAPI\tTOKEN=fake-tab-456\nCLIENT-ID:fake-id-789',
      '⚡clienT  secret:    xxxxxxxxxx\nAPI\tTOKEN=xxxxxxxxxx\nCLIENT-ID:xxxxxxxxxx',3],
    ['password=“fake password with spaces”\nclient_secret=‘fake secret phrase’',
      'password=“xxxxxxxxxx”\nclient_secret=‘xxxxxxxxxx’',2],
    ['client\u00a0id:\u00a0fake-copied-id-123\naccess-token：\nfake-nextline-456',
      'client\u00a0id:\u00a0xxxxxxxxxx\naccess-token：\nxxxxxxxxxx',2],
    ['apiKey="fake unfinished key','apiKey="xxxxxxxxxx',1],
    ['Authorization: Bearer fake-bearer-123\napi_key=${SERVICE_KEY}',
      'Authorization: Bearer xxxxxxxxxx\napi_key=${SERVICE_KEY}',1],
    ['Authorization: Bearer "fake-auth-123"\nAuthorization: Basic ‘fake-basic-456’',
      'Authorization: Bearer "xxxxxxxxxx"\nAuthorization: Basic ‘xxxxxxxxxx’',2],
    ['clientSecret＝fake-fullwidth-123\npassword=\n"fake following line"',
      'clientSecret＝xxxxxxxxxx\npassword=\n"xxxxxxxxxx"',2],
    ['password:\nclient_secret: fake-after-empty-123\napi_key=\n"client_id": "fake-following-id-456"',
      'password:\nclient_secret: xxxxxxxxxx\napi_key=\n"client_id": "xxxxxxxxxx"',2],
  ];
  const sent=[];
  for(const [original,masked,count] of cases) {
    await editor.fill(original); await editor.press('Enter');
    await expect(review(page).getByRole('heading')).toHaveText(`${count} secret${count===1?'':'s'} detected`);
    expect(requests).toEqual(sent);
    await review(page).getByRole('button',{name:'Edit',exact:true}).click();
    expect(await editorText(editor)).toBe(original);
    expect(requests).toEqual(sent);
    await editor.press('Enter');
    await review(page).getByRole('button',{name:'Send',exact:true}).click();
    sent.push(original);
    await expect.poll(()=>requests).toEqual(sent);
    await editor.fill(original); await editor.press('Enter');
    await review(page).getByRole('button',{name:'Mask',exact:true}).click();
    sent.push(masked);
    await expect.poll(()=>requests).toEqual(sent);
    expect(await editorText(editor)).toBe(masked);
    expect(await page.evaluate(()=>window.submitted)).toEqual(sent);
  }
  await page.close();
});

for (const host of ['chatgpt.com','claude.ai']) for (const action of ['Send','Mask']) test(`${host}: rapid Enter, send clicks and repeated ${action} clicks submit once`, async () => {
  const page=await chat(host); const editor=page.locator('textarea,[contenteditable]');
  const original='clienT-secret = fake-rushed-123\npassword=“fake rushed password”';
  await editor.fill(original); await editor.focus();
  await page.keyboard.down('Enter');
  await expect(review(page)).toBeVisible();
  for(let i=0;i<3;i++) await page.keyboard.down('Enter');
  await page.evaluate(()=>{
    for(let i=0;i<3;i++) {
      document.querySelector('[data-testid="send-button"]').click();
      document.querySelector('form').requestSubmit();
    }
  });
  expect(await page.evaluate(()=>window.submitted)).toEqual([]);
  await expect(review(page)).toHaveCount(1);
  await expect.poll(activity).toEqual({detected:2,maskedPrompts:0,unmaskedPrompts:0});
  const request=page.waitForRequest(request=>request.method()==='POST');
  await review(page).getByRole('button',{name:action,exact:true}).evaluate(button=>{button.click();button.click();button.click();});
  const expected=action==='Send'?original:'clienT-secret = xxxxxxxxxx\npassword=“xxxxxxxxxx”';
  expect((await request).postData()).toBe(expected);
  await page.keyboard.down('Enter');
  await page.keyboard.up('Enter');
  expect(await page.evaluate(()=>window.submitted)).toEqual([expected]);
  await expect.poll(activity).toEqual({detected:2,maskedPrompts:action==='Mask'?1:0,unmaskedPrompts:action==='Send'?1:0});
  await expect.poll(()=>composer.evaluate(async()=>(await SecretShieldHistory.request('list')).length)).toBe(action==='Send'?1:0);
  await page.close();
});

for (const host of ['chatgpt.com','claude.ai']) test(`${host}: custom field values trigger Edit, Send, and Mask without storing values in preferences`, async () => {
  await addFields(['dataset1','project_code']);
  const page=await chat(host); const editor=page.locator('textarea,[contenteditable]');
  const plain='dataset10 = fictional-public-123';
  await editor.fill(plain); await editor.press('Enter');
  await expect.poll(()=>page.evaluate(()=>window.submitted)).toEqual([plain]);
  const original='{"dataset1": "synthetic-data-123", "project_code": "synthetic-project-456"}';
  await editor.fill(original); await clickSend(page);
  await expect(review(page)).toBeVisible();
  await expect(review(page).getByRole('heading')).toHaveText('2 secrets detected');
  await review(page).getByRole('button',{name:'Edit',exact:true}).click();
  expect(await editorText(editor)).toBe(original);
  expect(await page.evaluate(()=>window.submitted)).toEqual([plain]);
  await editor.press('Enter');
  await review(page).getByRole('button',{name:'Send',exact:true}).click();
  await expect.poll(()=>page.evaluate(()=>window.submitted)).toEqual([plain,original]);
  await editor.fill(original); await editor.press('Enter');
  await review(page).getByRole('button',{name:'Mask',exact:true}).click();
  const masked='{"dataset1": "xxxxxxxxxx", "project_code": "xxxxxxxxxx"}';
  await expect.poll(()=>page.evaluate(()=>window.submitted)).toEqual([plain,original,masked]);
  await expect.poll(activity).toEqual({detected:6,maskedPrompts:1,unmaskedPrompts:1});
  const stored=await composer.evaluate(async()=>JSON.stringify(await chrome.storage.local.get(null)));
  expect(stored).not.toContain('synthetic-data');
  expect(stored).not.toContain('synthetic-project');
  await page.close();
});

test('clearing custom fields cancels an open review and keeps built-in detection', async () => {
  await addFields(['dataset1']);
  const page=await chat(); const editor=page.locator('textarea');
  await editor.fill('dataset1=synthetic-custom-123'); await editor.press('Enter');
  await expect(review(page)).toBeVisible();
  await composer.getByRole('button',{name:'Remove dataset1',exact:true}).click();
  await expect(composer.locator('#field-status')).toHaveText('');
  await expect(composer.locator('#saved-fields li')).toHaveCount(0);
  await expect(review(page)).toBeHidden();
  await editor.press('Enter');
  await expect.poll(()=>page.evaluate(()=>window.submitted)).toEqual(['dataset1=synthetic-custom-123']);
  await editor.fill('password=synthetic-built-in-123'); await editor.press('Enter');
  await expect(review(page)).toBeVisible();
  await page.close();
});

test('unsuccessful Send and Mask choices do not record successful outcomes', async () => {
  const page=await chat(); const editor=page.locator('textarea');
  await editor.fill('api_key=synthetic-failed-123');
  await editor.press('Enter');
  await expect(review(page)).toBeVisible();
  await page.locator('[data-testid="send-button"]').evaluate(button=>{button.disabled=true;});
  await review(page).getByRole('button',{name:'Send',exact:true}).click();
  await expect(review(page)).toBeHidden();
  await expect.poll(activity).toEqual({detected:1,maskedPrompts:0,unmaskedPrompts:0});
  await page.locator('[data-testid="send-button"]').evaluate(button=>{button.disabled=false;});
  await editor.press('Enter');
  await expect(review(page)).toBeVisible();
  await page.evaluate(()=>{
    const editor=document.querySelector('textarea'),original=editor.value;
    editor.addEventListener('input',()=>{editor.value=original;});
  });
  await review(page).getByRole('button',{name:'Mask',exact:true}).click();
  await expect(review(page)).toBeHidden();
  await expect.poll(activity).toEqual({detected:2,maskedPrompts:0,unmaskedPrompts:0});
  expect(await page.evaluate(()=>window.submitted)).toEqual([]);
  await page.close();
});

test('a masked draft without an available Send control does not count as a sent prompt', async () => {
  const page=await chat(); const editor=page.locator('textarea');
  await editor.fill('api_key=synthetic-unsent-123\npassword=synthetic-unsent-456');
  await editor.press('Enter');
  await expect(review(page)).toBeVisible();
  await page.locator('[data-testid="send-button"]').evaluate(button=>{button.disabled=true;});
  await review(page).getByRole('button',{name:'Mask',exact:true}).click();
  await expect(editor).toHaveValue('api_key=xxxxxxxxxx\npassword=xxxxxxxxxx');
  await expect(page.locator('#secret-shield-notice')).toBeVisible();
  await expect.poll(activity).toEqual({detected:2,maskedPrompts:0,unmaskedPrompts:0});
  expect(await page.evaluate(()=>window.submitted)).toEqual([]);
  await page.close();
});
async function clickSend(page) {
  const button=page.getByRole('button',{name:'Send message',exact:true});
  await expect(button).toBeVisible();
  await button.scrollIntoViewIfNeeded();
  const box=await button.boundingBox();
  // The review opens on pointerdown; locator.click would retry when its modal covers mouseup.
  await page.mouse.click(box.x+box.width/2,box.y+box.height/2);
}

for (const host of ['chatgpt.com','claude.ai']) {
  test(`${host}: Mask automatically sends only the masked prompt once`, async () => {
    const page=await chat(host); const editor=page.locator('textarea,[contenteditable]');
    const original=`Explain api_key="${key}" please`;
    await editor.fill(original);
    expect(await editorText(editor)).toBe(original);
    await expect(review(page)).toBeHidden();
    await editor.press('Enter');
    expect(await page.evaluate(()=>window.submitted)).toEqual([]);
    expect(await editorText(editor)).toBe(original);
    await expect(review(page)).toBeVisible();
    await expect(review(page).getByRole('heading')).toHaveText('1 secret detected');
    await expect(review(page).locator('.count')).toHaveCSS('color','rgb(255, 107, 107)');
    await expect(review(page).locator('p')).toHaveCount(0);
    await expect(review(page).getByRole('button',{name:'Edit',exact:true})).toHaveCSS('text-decoration-line','none');
    await expect(review(page).getByRole('button',{name:'Send',exact:true})).toHaveCSS('font-weight','500');
    await expect(review(page).locator('small')).toHaveCount(0);
    for (const name of ['Send','Edit','Mask']) await expect(review(page).getByRole('button',{name,exact:true})).toBeVisible();
    if (host === 'chatgpt.com') {
      await mkdir(path.join(root,'artifacts'),{recursive:true});
      await page.screenshot({path:path.join(root,'artifacts','review-popup.png'),fullPage:true});
    }
    const sent=page.waitForRequest(req=>req.method()==='POST');
    await review(page).getByRole('button',{name:'Mask',exact:true}).click();
    await expect(review(page)).toBeHidden();
    await expect.poll(()=>editorText(editor)).toBe('Explain api_key="xxxxxxxxxx" please');
    expect((await sent).postData()).toBe('Explain api_key="xxxxxxxxxx" please');
    expect(await page.evaluate(()=>window.submitted)).toEqual(['Explain api_key="xxxxxxxxxx" please']);
    await page.close();
  });
  test(`${host}: Edit retains the original draft and the next attempt asks again`, async () => {
    const page=await chat(host); const editor=page.locator('textarea,[contenteditable]');
    const original='password = synthetic-password-4583';
    await editor.fill(original);
    await clickSend(page);
    await expect(review(page)).toBeVisible();
    await review(page).getByRole('button',{name:'Edit',exact:true}).click();
    await expect(review(page)).toBeHidden();
    expect(await editorText(editor)).toBe(original);
    expect(await page.evaluate(()=>window.submitted)).toEqual([]);
    await editor.press('Enter');
    await expect(review(page)).toBeVisible();
    expect(await page.evaluate(()=>window.submitted)).toEqual([]);
    await page.close();
  });
  test(`${host}: Send delivers the reviewed original once and a new secret needs review`, async () => {
    const page=await chat(host); const editor=page.locator('textarea,[contenteditable]');
    const original=`Explain api_key="${key}" please`;
    await editor.fill(original);
    await editor.press('Enter');
    await expect(review(page)).toBeVisible();
    const sent=page.waitForRequest(req=>req.method()==='POST');
    await review(page).getByRole('button',{name:'Send',exact:true}).click();
    expect((await sent).postData()).toBe(original);
    await expect(review(page)).toBeHidden();
    expect(await page.evaluate(()=>window.submitted)).toEqual([original]);
    await editor.press('Enter');
    await expect(review(page)).toBeVisible();
    expect(await page.evaluate(()=>window.submitted)).toEqual([original]);
    await review(page).getByRole('button',{name:'Edit',exact:true}).click();
    await editor.fill('client_secret = next-synthetic-secret-7364');
    await editor.press('Enter');
    await expect(review(page)).toBeVisible();
    expect(await page.evaluate(()=>window.submitted)).toEqual([original]);
    await page.close();
  });
}
for (const gesture of ['Enter','send button']) {
  test(`ChatGPT markdown editor: ${gesture} cancels the first secret-bearing send`, async () => {
    const page=await chat('chatgpt.com','markdown');
    const editor=page.getByRole('textbox',{name:'Ask ChatGPT',exact:true});
    const send=()=>gesture === 'Enter' ? editor.press('Enter') : clickSend(page);
    await editor.fill(`Explain api_key="${key}" please`);
    await send();
    expect(await page.evaluate(()=>window.submitted)).toEqual([]);
    await expect(editor).toHaveText(`Explain api_key="${key}" please`);
    const sent=page.waitForRequest(req=>req.method()==='POST');
    await review(page).getByRole('button',{name:'Mask',exact:true}).click();
    await expect(editor).toHaveText('Explain api_key="xxxxxxxxxx" please');
    expect((await sent).postData()).toBe('Explain api_key="xxxxxxxxxx" please');
    expect(await page.evaluate(()=>window.submitted)).toEqual(['Explain api_key="xxxxxxxxxx" please']);
    await page.close();
  });
}
test('pointer and click open one review and its Send approval submits once', async () => {
  const page=await chat(); const editor=page.locator('textarea');
  await editor.fill(`Fix ${key}`); await clickSend(page);
  expect(await page.evaluate(()=>window.submitted)).toEqual([]);
  await expect(editor).toHaveValue(`Fix ${key}`);
  await expect(review(page)).toHaveCount(1);
  await review(page).getByRole('button',{name:'Send',exact:true}).click();
  expect(await page.evaluate(()=>window.submitted)).toEqual([`Fix ${key}`]);
  await page.close();
});
test('review counts detected occurrences once when scanner matches overlap', async () => {
  const page=await chat(); const editor=page.locator('textarea');
  await editor.fill(`api_key="${key}"\nRepeat ${key}\npassword=synthetic-password-4583`);
  await editor.press('Enter');
  await expect(review(page).getByRole('heading')).toHaveText('3 secrets detected');
  expect(await page.evaluate(()=>window.submitted)).toEqual([]);
  await page.close();
});
for (const action of ['Send','Edit','Mask']) test(`${action}: review enters from the bottom and exits in the selected direction`, async () => {
  const page=await chat();const editor=page.locator('textarea');
  await page.emulateMedia({reducedMotion:'no-preference'});
  await page.evaluate(()=>{
    const observer=new MutationObserver(()=>{
      const dialog=document.querySelector('#ckretguard-review')?.shadowRoot?.querySelector('dialog');
      const animation=dialog?.getAnimations()[0];
      if (animation) { animation.pause();animation.currentTime=0;observer.disconnect(); }
    });
    observer.observe(document.body,{childList:true});
  });
  const original=`api_key="${key}"`;
  await editor.fill(original);await editor.press('Enter');
  const entry=await review(page).evaluate(dialog=>{
    const animation=dialog.getAnimations()[0];
    const from={top:dialog.getBoundingClientRect().top,viewport:innerHeight};
    animation.finish();return from;
  });
  expect(entry.top).toBeGreaterThanOrEqual(entry.viewport);
  const exit=await review(page).evaluate((dialog,action)=>{
    [...dialog.querySelectorAll('button')].find(button=>button.textContent===action).click();
    const animation=dialog.getAnimations()[0];animation.pause();
    animation.currentTime=animation.effect.getTiming().duration;
    const end=dialog.getBoundingClientRect();animation.currentTime=0;
    return {direction:dialog.dataset.motion,top:end.top,bottom:end.bottom,viewport:innerHeight,
      disabled:[...dialog.querySelectorAll('button')].every(button=>button.disabled)};
  },action);
  expect(exit.direction).toBe(action==='Edit'?'down':'up');
  if (action==='Edit') expect(exit.top).toBeGreaterThanOrEqual(exit.viewport);
  else expect(exit.bottom).toBeLessThanOrEqual(0);
  expect(exit.disabled).toBe(true);
  expect(await page.evaluate(()=>window.submitted)).toEqual([]);
  const sent=action==='Edit'?null:page.waitForRequest(req=>req.method()==='POST');
  await review(page).evaluate(dialog=>dialog.getAnimations().forEach(animation=>animation.finish()));
  await expect(review(page)).toBeHidden();
  if (sent) {
    const expected=action==='Send'?original:'api_key="xxxxxxxxxx"';
    expect((await sent).postData()).toBe(expected);
    expect(await page.evaluate(()=>window.submitted)).toEqual([expected]);
  } else {
    await expect(editor).toHaveValue(original);
    expect(await page.evaluate(()=>window.submitted)).toEqual([]);
  }
  await page.close();
});
for (const action of ['Send','Mask']) test(`changing a draft during the ${action} exit animation prevents sending`, async () => {
  const page=await chat();const editor=page.locator('textarea');
  await page.emulateMedia({reducedMotion:'no-preference'});
  await editor.fill(`api_key="${key}"`);await editor.press('Enter');
  await review(page).evaluate((dialog,action)=>{
    dialog.getAnimations().forEach(animation=>animation.finish());
    [...dialog.querySelectorAll('button')].find(button=>button.textContent===action).click();
    dialog.getAnimations().forEach(animation=>animation.pause());
    const editor=document.querySelector('textarea');
    editor.value='password="changed-synthetic-secret-2456"';window.current=editor.value;
    dialog.getAnimations().forEach(animation=>animation.finish());
  },action);
  await expect(review(page)).toBeHidden();
  expect(await page.evaluate(()=>window.submitted)).toEqual([]);
  await expect(editor).toHaveValue('password="changed-synthetic-secret-2456"');
  await page.close();
});
for (const action of ['Send','Mask']) test(`a policy refresh during the ${action} exit animation prevents sending`, async () => {
  const page=await chat();const editor=page.locator('textarea');
  await page.emulateMedia({reducedMotion:'no-preference'});
  const original=`api_key="${key}"`;await editor.fill(original);await editor.press('Enter');
  await review(page).evaluate((dialog,action)=>{
    dialog.getAnimations().forEach(animation=>animation.finish());
    [...dialog.querySelectorAll('button')].find(button=>button.textContent===action).click();
    dialog.getAnimations().forEach(animation=>animation.pause());
  },action);
  await composer.evaluate(()=>chrome.storage.local.set({policy:{mode:'block'}}));
  await expect(composer.locator('input[name=mode]:checked')).toHaveValue('block');
  await expect(review(page)).toBeHidden();
  expect(await page.evaluate(()=>window.submitted)).toEqual([]);
  await expect(editor).toHaveValue(original);await page.close();
});
test('reduced motion skips review animations', async () => {
  const page=await chat();await page.locator('textarea').fill(`api_key=${key}`);
  await page.locator('textarea').press('Enter');
  expect(await review(page).evaluate(dialog=>dialog.getAnimations().length)).toBe(0);
  await review(page).getByRole('button',{name:'Edit',exact:true}).click();
  await expect(review(page)).toBeHidden();expect(await page.evaluate(()=>window.submitted)).toEqual([]);
  await page.close();
});
for (const host of ['chatgpt.com','claude.ai']) test(`${host}: Edit or Mask mode removes Send and switching back restores it`, async () => {
  const page=await chat(host); const editor=page.locator('textarea,[contenteditable]');
  const original=`api_key=${key}`;
  await editor.fill(original); await editor.press('Enter');
  await expect(review(page)).toBeVisible();
  const previousSend=await review(page).getByRole('button',{name:'Send',exact:true}).elementHandle();
  await composer.locator('#protection-settings').evaluate(el=>{el.open=true;});
  await composer.getByRole('radio',{name:'Edit or Mask',exact:true}).check();
  await expect(composer.getByRole('radio',{name:'Edit or Mask',exact:true})).toBeEnabled();
  await expect.poll(()=>composer.evaluate(async()=>(await chrome.storage.local.get('policy')).policy.mode)).toBe('block');
  await expect(review(page)).toBeHidden();
  await previousSend.evaluate(button=>button.click());
  await previousSend.dispose();
  expect(await page.evaluate(()=>window.submitted)).toEqual([]);
  await editor.press('Enter');
  await expect(review(page)).toBeVisible();
  await expect(review(page).getByRole('button',{name:'Send',exact:true})).toHaveCount(0);
  await expect(review(page).getByRole('button')).toHaveText(['Edit','Mask']);
  await expect(review(page).locator('p')).toHaveCount(0);
  await review(page).getByRole('button',{name:'Edit',exact:true}).click();
  expect(await editorText(editor)).toBe(original);
  expect(await page.evaluate(()=>window.submitted)).toEqual([]);
  await editor.press('Enter');
  await expect(review(page)).toBeVisible();
  await expect(review(page).getByRole('button',{name:'Send',exact:true})).toHaveCount(0);
  const sent=page.waitForRequest(req=>req.method()==='POST');
  await review(page).getByRole('button',{name:'Mask',exact:true}).click();
  await expect.poll(()=>editorText(editor)).toBe('api_key=xxxxxxxxxx');
  expect((await sent).postData()).toBe('api_key=xxxxxxxxxx');
  expect(await page.evaluate(()=>window.submitted)).toEqual(['api_key=xxxxxxxxxx']);
  await composer.getByRole('radio',{name:'Send, Edit, or Mask',exact:true}).check();
  await expect(composer.getByRole('radio',{name:'Send, Edit, or Mask',exact:true})).toBeEnabled();
  await expect.poll(()=>composer.evaluate(async()=>(await chrome.storage.local.get('policy')).policy.mode)).toBe('redact');
  await editor.fill(original); await editor.press('Enter');
  await expect(review(page).getByRole('button')).toHaveText(['Send','Edit','Mask']);
  await review(page).getByRole('button',{name:'Send',exact:true}).click();
  await expect.poll(()=>page.evaluate(()=>window.submitted)).toEqual(['api_key=xxxxxxxxxx',original]);
  await page.close();
});
for (const variant of ['delayed','delayed-missing-send','delayed-sync-event']) test(`Mask waits for framework synchronization and current Send: ${variant}`, async () => {
  const page=await chat('chatgpt.com',variant); const editor=page.locator('textarea');
  const original=`api_key=${key}`;
  await editor.fill(original);
  await expect.poll(()=>page.evaluate(()=>window.current)).toBe(original);
  await editor.press('Enter');
  const sent=page.waitForRequest(req=>req.method()==='POST');
  await review(page).getByRole('button',{name:'Mask',exact:true}).click();
  expect((await sent).postData()).toBe('api_key=xxxxxxxxxx');
  await expect(editor).toHaveValue('api_key=xxxxxxxxxx');
  expect(await page.evaluate(()=>window.submitted)).toEqual(['api_key=xxxxxxxxxx']);
  await page.close();
});
test('Mask does not submit when the framework rejects the masked editor update', async () => {
  const page=await chat(); const editor=page.locator('textarea');
  const original=`api_key=${key}`;
  await editor.fill(original);
  await editor.press('Enter');
  await page.evaluate(original=>{
    document.querySelector('textarea').addEventListener('input',event=>{
      if (event.target.value === 'api_key=xxxxxxxxxx') {
        event.target.value=original;
        window.current=original;
      }
    });
  },original);
  await review(page).getByRole('button',{name:'Mask',exact:true}).click();
  await expect(editor).toHaveValue(original);
  expect(await page.evaluate(()=>window.submitted)).toEqual([]);
  await page.close();
});
test('changing the draft while Mask waits for synchronization cancels automatic Send', async () => {
  const page=await chat('chatgpt.com','delayed'); const editor=page.locator('textarea');
  const original=`api_key=${key}`;
  await editor.fill(original);
  await expect.poll(()=>page.evaluate(()=>window.current)).toBe(original);
  await editor.press('Enter');
  await page.evaluate(()=>{
    document.querySelector('textarea').addEventListener('input',event=>{
      if (event.target.value === 'api_key=xxxxxxxxxx') setTimeout(()=>{
        event.target.value='password=changed-synthetic-secret-2456';
        event.target.dispatchEvent(new InputEvent('input',{bubbles:true}));
      },20);
    });
  });
  await review(page).getByRole('button',{name:'Mask',exact:true}).click();
  await expect.poll(()=>page.evaluate(()=>window.current)).toBe('password=changed-synthetic-secret-2456');
  await expect(editor).toHaveValue('password=changed-synthetic-secret-2456');
  expect(await page.evaluate(()=>window.submitted)).toEqual([]);
  await page.close();
});
test('a policy refresh while Mask waits for synchronization cancels automatic Send', async () => {
  const page=await chat('chatgpt.com','delayed'); const editor=page.locator('textarea');
  const original=`api_key=${key}`;
  await editor.fill(original);
  await expect.poll(()=>page.evaluate(()=>window.current)).toBe(original);
  await editor.press('Enter');
  await review(page).getByRole('button',{name:'Mask',exact:true}).click();
  await composer.evaluate(()=>chrome.storage.local.set({policy:{mode:'block'}}));
  await expect(composer.locator('input[name=mode]:checked')).toHaveValue('block');
  await expect.poll(()=>page.evaluate(()=>window.current)).toBe('api_key=xxxxxxxxxx');
  expect(await page.evaluate(()=>window.submitted)).toEqual([]);
  await page.close();
});
test('pasted credentials remain unchanged until a send attempt opens review', async () => {
  const page=await chat();
  await page.evaluate(text=>{
    window.pasteSeen=[];
    const editor=document.querySelector('textarea');
    editor.addEventListener('paste',e=>{
      const value=e.clipboardData.getData('text/plain');
      window.pasteSeen.push(value);
      // Synthetic clipboard events have no native insertion; emulate the page's paste handler.
      editor.value=value;
      editor.dispatchEvent(new InputEvent('input',{bubbles:true,inputType:'insertFromPaste'}));
    });
    const data=new DataTransfer();data.setData('text/plain',`api_key=${text}`);
    editor.dispatchEvent(new ClipboardEvent('paste',{clipboardData:data,bubbles:true,cancelable:true}));
  },key);
  await expect(page.locator('textarea')).toHaveValue(`api_key=${key}`);
  expect(await page.evaluate(()=>window.pasteSeen)).toEqual([`api_key=${key}`]);
  await expect(review(page)).toBeHidden();
  await page.locator('textarea').press('Enter');
  await expect(review(page)).toBeVisible();
  expect(await page.evaluate(()=>window.submitted)).toEqual([]);
  await page.close();
});
test('credential field types require review while ordinary personal text sends normally', async () => {
  const page=await chat(); const editor=page.locator('textarea');
  for (const prompt of [
    'client_id = synthetic-client-4583',
    'client_secret = synthetic-client-secret-4583',
    'password = synthetic-password-4583',
    'secret key = synthetic-secret-key-4583',
    'access_token = synthetic-access-token-4583',
  ]) {
    await editor.fill(prompt);
    await editor.press('Enter');
    await expect(review(page)).toBeVisible();
    expect(await page.evaluate(()=>window.submitted)).toEqual([]);
    await review(page).getByRole('button',{name:'Edit',exact:true}).click();
    await expect(editor).toHaveValue(prompt);
  }
  const ordinary='My name is Example Person and my email is example@example.invalid.';
  await editor.fill(ordinary);
  await editor.press('Enter');
  await expect(review(page)).toBeHidden();
  expect(await page.evaluate(()=>window.submitted)).toEqual([ordinary]);
  await page.close();
});
for (const action of ['Send','Mask']) test(`changing the draft invalidates pending ${action}`, async () => {
  const page=await chat(); const editor=page.locator('textarea');
  await editor.fill(`api_key=${key}`);
  await editor.press('Enter');
  const approve=await review(page).getByRole('button',{name:action,exact:true}).elementHandle();
  await page.evaluate(()=>{
    // A page/framework can change its draft without emitting an input event.
    const editor=document.querySelector('textarea');
    editor.value='password = changed-synthetic-secret-2456';
    window.current=editor.value;
  });
  await approve.evaluate(button=>button.click());
  expect(await page.evaluate(()=>window.submitted)).toEqual([]);
  await expect(editor).toHaveValue('password = changed-synthetic-secret-2456');
  if (await review(page).isVisible()) await review(page).getByRole('button',{name:'Edit',exact:true}).click();
  await editor.press('Enter');
  await expect(review(page)).toBeVisible();
  expect(await page.evaluate(()=>window.submitted)).toEqual([]);
  await page.close();
});
for (const action of ['Send','Mask']) test(`replacing the visible editor invalidates pending ${action}`, async () => {
  const page=await chat(); const original=`api_key=${key}`;
  await page.locator('textarea').fill(original);
  await page.locator('textarea').press('Enter');
  const choice=await review(page).getByRole('button',{name:action,exact:true}).elementHandle();
  await page.evaluate(()=>{
    const old=document.querySelector('textarea');
    old.id='retired-editor';old.hidden=true;
    const replacement=document.createElement('textarea');
    replacement.id='prompt-textarea';
    replacement.value='password = replacement-synthetic-secret-3456';
    old.after(replacement);
  });
  await choice.evaluate(button=>button.click());
  expect(await page.evaluate(()=>window.submitted)).toEqual([]);
  await expect(page.locator('#retired-editor')).toHaveValue(original);
  await expect(page.locator('#prompt-textarea')).toHaveValue('password = replacement-synthetic-secret-3456');
  await page.close();
});
for (const action of ['Send','Mask']) test(`a policy refresh invalidates an open review and retained ${action} button`, async () => {
  const page=await chat(); const editor=page.locator('textarea');
  await editor.fill(`api_key=${key}`);
  await editor.press('Enter');
  const approve=await review(page).getByRole('button',{name:action,exact:true}).elementHandle();
  await composer.evaluate(()=>chrome.storage.local.set({policy:{mode:'block'}}));
  await expect(composer.locator('input[name=mode]:checked')).toHaveValue('block');
  await expect.poll(async()=>!await review(page).isVisible() || await review(page).getByRole('button',{name:'Send',exact:true}).isDisabled()).toBe(true);
  await approve.evaluate(button=>button.click());
  expect(await page.evaluate(()=>window.submitted)).toEqual([]);
  await expect(editor).toHaveValue(`api_key=${key}`);
  if (await review(page).isVisible()) await review(page).getByRole('button',{name:'Edit',exact:true}).click();
  await editor.press('Enter');
  await expect(review(page)).toBeVisible();
  await expect(review(page).getByRole('button',{name:'Send',exact:true})).toHaveCount(0);
  expect(await page.evaluate(()=>window.submitted)).toEqual([]);
  await page.close();
});
for (const host of ['chatgpt.com','claude.ai']) test(`${host}: the full prompt is scanned beyond 100,000 characters for Edit, Send, and Mask`, async () => {
  const page=await chat(host); const editor=page.locator('textarea,[contenteditable]');
  const plain='ordinary text '.repeat(8000);
  await editor.fill(plain); await editor.press('Enter');
  await expect.poll(()=>page.evaluate(()=>window.submitted.length)).toBe(1);
  expect((await page.evaluate(()=>window.submitted))[0]).toBe(plain);
  const prefix='ordinary text '.repeat(80000);
  const original='password=synthetic-long-start-123\n'+prefix+'\nclient_secret=synthetic-long-end-456';
  await editor.fill(original); await editor.press('Enter');
  await expect(review(page).getByRole('heading')).toHaveText('2 secrets detected');
  await review(page).getByRole('button',{name:'Edit',exact:true}).click();
  expect(await editorText(editor)).toBe(original);
  expect(await page.evaluate(()=>window.submitted.length)).toBe(1);
  await editor.press('Enter');
  await review(page).getByRole('button',{name:'Send',exact:true}).click();
  await expect.poll(()=>page.evaluate(()=>window.submitted.length)).toBe(2);
  expect((await page.evaluate(()=>window.submitted))[1]).toBe(original);
  await editor.fill(original); await editor.press('Enter');
  await expect(review(page).getByRole('heading')).toHaveText('2 secrets detected');
  await review(page).getByRole('button',{name:'Mask',exact:true}).click();
  await expect.poll(()=>page.evaluate(()=>window.submitted.length)).toBe(3);
  const masked=original.replace('synthetic-long-start-123','xxxxxxxxxx').replace('synthetic-long-end-456','xxxxxxxxxx');
  expect(await editorText(editor)).toBe(masked);
  expect((await page.evaluate(()=>window.submitted))[2]).toBe(masked);
  await page.close();
});
test('excessive scan work, missing inputs and ambiguous inputs block known send controls', async () => {
  const page=await chat();
  await page.locator('textarea').fill(Array.from({length:500},(_,i)=>`api_key="fictional-value-${i}"`).join('\n').repeat(4));
  await page.locator('textarea').press('Enter');
  expect(await page.evaluate(()=>window.submitted)).toEqual([]);
  await page.close();
  const missing=await chat('chatgpt.com','unknown');
  await missing.getByRole('button',{name:'Send message',exact:true}).click();
  expect(await missing.evaluate(()=>window.submitted)).toEqual([]);
  await missing.close();
  const ambiguous=await chat();
  await ambiguous.evaluate(()=>{
    const editor=document.createElement('textarea');editor.dataset.id='root';document.querySelector('form').append(editor);
  });
  await ambiguous.getByRole('button',{name:'Send message',exact:true}).click();
  expect(await ambiguous.evaluate(()=>window.submitted)).toEqual([]);
  await ambiguous.close();
});
test('plain messages, Shift+Enter and unrelated forms keep their normal behavior', async () => {
  const page=await chat();
  await page.locator('textarea').fill('Explain safe environment variables.');
  await page.locator('textarea').press('Shift+Enter');
  expect(await page.evaluate(()=>window.submitted)).toEqual([]);
  await page.locator('textarea').press('Enter');
  expect((await page.evaluate(()=>window.submitted))[0]).toContain('Explain safe environment variables.');
  await page.evaluate(()=>{
    const form=document.createElement('form');form.id='search';form.innerHTML='<input name="q"><button>Search</button>';
    form.addEventListener('submit',e=>{e.preventDefault();window.searchWorked=true});document.body.append(form);
  });
  await page.getByRole('button',{name:'Search',exact:true}).click();
  expect(await page.evaluate(()=>window.searchWorked)).toBe(true);
  await page.close();
});
test('invalid custom fields do not replace saved protection or persist secret assignments', async () => {
  await addFields(['dataset1']);
  for (const invalid of ['dataset1=synthetic-secret-value', '(a+)+$', 'x'.repeat(65)]) {
    await composer.locator('#sensitive-names').fill(invalid);
    await expect(composer.locator('#field-status')).toHaveText('');
    await expect(composer.locator('#field-status')).not.toHaveClass(/error/);
    await composer.locator('#save-fields').click();
    await expect(composer.locator('#field-status')).toHaveText('Use 3–64 characters, starting with a letter. Allowed: letters, numbers, spaces, _ and -.');
    await expect(composer.locator('#field-status')).toHaveCSS('font-size','12px');
    await expect(composer.locator('#field-status')).toHaveCSS('line-height','16px');
    await expect(composer.locator('#field-status')).toHaveCSS('font-weight','400');
    await expect(composer.locator('#field-status')).toHaveCSS('color','rgb(255, 107, 107)');
    const form=await composer.locator('#field-form').boundingBox();
    const message=await composer.locator('#field-status').boundingBox();
    expect(message.y-form.y-form.height).toBe(12);
    expect(await composer.evaluate(async()=>(await chrome.storage.local.get('policy')).policy.sensitiveNames)).toEqual(['dataset1']);
  }
  const saved=await composer.evaluate(async()=>JSON.stringify(await chrome.storage.local.get(null)));
  expect(saved).not.toContain('synthetic-secret-value');
  await composer.reload();
  await expect(composer.locator('#saved-fields span')).toHaveText(['dataset1']);
});

test('the 50th saved field hides entry and deleting one restores it', async () => {
  await composer.evaluate(()=>chrome.storage.local.set({policy:{sensitiveNames:Array.from({length:49},(_,i)=>'dataset'+i)}}));
  await expect(composer.locator('#field-count')).toHaveText('49 custom fields saved.');
  await expect(composer.locator('#field-form')).toBeVisible();
  await addFields(['dataset49']);
  await expect(composer.locator('#field-count')).toHaveText('50 custom fields saved.');
  await expect(composer.locator('#field-form')).toBeHidden();
  await expect(composer.locator('#sensitive-names')).toBeHidden();
  await expect(composer.locator('#save-fields')).toBeDisabled();
  await expect(composer.locator('#field-help')).toHaveText('You can add maximum 50 fields.');
  await composer.evaluate(()=>{
    document.getElementById('sensitive-names').value='overflow_field';
    document.getElementById('field-form').requestSubmit();
  });
  expect(await composer.evaluate(async()=>(await chrome.storage.local.get('policy')).policy.sensitiveNames.length)).toBe(50);
  await composer.reload();
  await composer.locator('#fields-title').click();
  await expect(composer.locator('#field-form')).toBeHidden();
  await expect(composer.locator('#saved-fields')).toBeVisible();
  await composer.getByRole('button',{name:'Remove dataset0',exact:true}).click();
  await expect(composer.locator('#field-count')).toHaveText('49 custom fields saved.');
  await expect(composer.locator('#field-form')).toBeVisible();
  await expect(composer.locator('#field-help')).toHaveText('Add field names whose values you want to protect.');
  await expect(composer.locator('#sensitive-names')).toBeEnabled();
  const page=await chat();
  await page.locator('textarea').fill('dataset49=synthetic-fiftieth-123');
  await page.locator('textarea').press('Enter');
  await expect(review(page)).toBeVisible();
  await review(page).getByRole('button',{name:'Mask',exact:true}).click();
  await expect.poll(()=>page.evaluate(()=>window.submitted)).toEqual(['dataset49=xxxxxxxxxx']);
  await page.close();
});

test('saved fields use full-width rows and controls use brand hover colors', async () => {
  await composer.evaluate(()=>chrome.storage.local.set({policy:{sensitiveNames:Array.from({length:7},(_,i)=>'dataset'+i)}}));
  await expect(composer.locator('#field-count')).toHaveText('7 custom fields saved.');
  await expect(composer.locator('#saved-fields-panel summary')).toHaveCount(0);
  await expect(composer.locator('#saved-fields')).toBeVisible();
  await expect(composer.locator('#saved-fields li')).toHaveCount(7);
  const remove=composer.getByRole('button',{name:'Remove dataset0',exact:true});
  await remove.hover();
  await expect(remove).toHaveCSS('color','rgb(69, 214, 200)');
  await composer.locator('#sensitive-names').fill('new_field');
  await composer.locator('#save-fields').hover();
  await expect(composer.locator('#save-fields')).toHaveCSS('background-color','rgb(69, 214, 200)');
  await expect(composer.locator('#save-fields')).toHaveCSS('color','rgb(24, 24, 24)');
  const list=await composer.locator('#saved-fields').boundingBox();
  let previous;
  for (const row of await composer.locator('#saved-fields li').all()) {
    const name=await row.locator('span').boundingBox();
    const button=await row.locator('button').boundingBox();
    const icon=await row.locator('svg').boundingBox();
    const box=await row.boundingBox();
    expect(name.x+name.width).toBeLessThan(button.x);
    expect(Math.abs(box.x+box.width-button.x-button.width-8)).toBeLessThan(1);
    expect(box.width).toBe(list.width);
    expect(icon.width).toBe(12);
    expect(icon.height).toBe(12);
    expect(Math.abs(icon.y+icon.height/2-name.y-name.height/2)).toBeLessThan(1);
    if (previous) expect(box.y-previous.y-previous.height).toBe(8);
    previous=box;
    expect(box.height).toBeLessThanOrEqual(34);
    await expect(row).toHaveCSS('border-top-width','0px');
    await expect(row).toHaveCSS('background-image','none');
  }
  await composer.locator('#fields-title').click();
  await expect(composer.locator('#saved-fields')).toBeHidden();
  await composer.locator('#fields-title').click();
  await expect(composer.locator('#saved-fields')).toBeVisible();
  const page=await chat();
  await page.locator('textarea').fill('api_key=synthetic-hover-123');
  await page.locator('textarea').press('Enter');
  const mask=review(page).getByRole('button',{name:'Mask',exact:true});
  await mask.hover();
  await expect(mask).toHaveCSS('background-color','rgb(69, 214, 200)');
  await expect(mask).toHaveCSS('color','rgb(24, 24, 24)');
  await page.close();
});

test('managed custom fields are read-only while unlocked settings remain editable', async () => {
  const worker=context.serviceWorkers()[0];
  await worker.evaluate(()=>{
    const managed=chrome.storage.managed.get;
    globalThis.restoreManagedStorage=()=>{chrome.storage.managed.get=managed;};
    chrome.storage.managed.get=async()=>({sensitiveNames:['org_dataset']});
  });
  await composer.evaluate(async()=>{
    const original=SecretShieldPolicy;
    window.restoreCkretguardPolicy=()=>{globalThis.SecretShieldPolicy=original;};
    globalThis.SecretShieldPolicy={...original,loadPolicy:async()=>{
      const {policy={}}=await chrome.storage.local.get('policy');
      return {policy:SecretShieldCore.normalizePolicy({...policy,sensitiveNames:['org_dataset']}),locked:['sensitiveNames']};
    }};
    await chrome.storage.local.set({policy:{mode:'redact'}});
  });
  try {
    await expect(composer.locator('#saved-fields span')).toHaveText(['org_dataset']);
    await expect(composer.locator('#sensitive-names')).toBeDisabled();
    await expect(composer.locator('#save-fields')).toBeDisabled();
    await expect(composer.locator('#saved-fields button')).toHaveCount(0);
    await expect(composer.locator('#field-status')).toContainText('managed by your organization');
    await composer.locator('#protection-settings').evaluate(el=>{el.open=true;});
    await composer.getByRole('radio',{name:'Edit or Mask',exact:true}).check();
    await expect(composer.getByRole('radio',{name:'Edit or Mask',exact:true})).toBeEnabled();
    const policy=await composer.evaluate(async()=>(await chrome.storage.local.get('policy')).policy);
    expect(policy.mode).toBe('block');
    expect(policy.sensitiveNames).toBeUndefined();
    await expect(composer.locator('#saved-fields span')).toHaveText(['org_dataset']);
  } finally {
    await composer.evaluate(()=>{window.restoreCkretguardPolicy();delete window.restoreCkretguardPolicy;});
    await worker.evaluate(()=>{restoreManagedStorage();delete globalThis.restoreManagedStorage;});
  }
});
test('form submission and held Enter cannot forward the first secret-bearing attempt', async () => {
  const page=await chat();
  await page.locator('textarea').fill(`api_key=${key}`);
  await page.evaluate(()=>document.querySelector('form').requestSubmit());
  expect(await page.evaluate(()=>window.submitted)).toEqual([]);
  await expect(review(page)).toBeVisible();
  await review(page).getByRole('button',{name:'Edit',exact:true}).click();
  await page.locator('textarea').fill(`api_key=${key}`);
  await page.evaluate(()=>{
    const editor=document.querySelector('textarea');
    editor.dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',bubbles:true,cancelable:true}));
    editor.dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',bubbles:true,cancelable:true,repeat:true}));
    editor.dispatchEvent(new KeyboardEvent('keyup',{key:'Enter',bubbles:true,cancelable:true}));
  });
  expect(await page.evaluate(()=>window.submitted)).toEqual([]);
  await expect(review(page)).toHaveCount(1);
  await expect(page.locator('textarea')).toHaveValue(`api_key=${key}`);
  await page.close();
});
test('Mask sends once while held Enter cannot duplicate the submission', async () => {
  const page=await chat(); const editor=page.locator('textarea');
  await editor.fill(`api_key=${key}`);
  await editor.focus();
  await page.keyboard.down('Enter');
  await expect(review(page)).toBeVisible();
  const sent=page.waitForRequest(req=>req.method()==='POST');
  await review(page).getByRole('button',{name:'Mask',exact:true}).click();
  await expect(editor).toHaveValue('api_key=xxxxxxxxxx');
  expect((await sent).postData()).toBe('api_key=xxxxxxxxxx');
  await page.keyboard.down('Enter');
  expect(await page.evaluate(()=>window.submitted)).toEqual(['api_key=xxxxxxxxxx']);
  await page.keyboard.up('Enter');
  expect(await page.evaluate(()=>window.submitted)).toEqual(['api_key=xxxxxxxxxx']);
  await page.close();
});
test('settings preserve custom fields and fit the toolbar dashboard', async () => {
  await addFields(['dataset1','internal_code']);
  await expect(composer.locator('#sensitive-names')).toHaveAttribute('placeholder','dataset_key');
  await expect(composer.locator('#mode label')).toHaveText(['Send, Edit, or Mask','Edit or Mask']);
  await expect(composer.locator('select,#save')).toHaveCount(0);
  await expect(composer.locator('#protection-settings')).toHaveCSS('border-left-width','1px');
  await expect(composer.locator('#protection-settings')).toHaveCSS('border-right-width','1px');
  await expect(composer.locator('#protection-settings')).toHaveCSS('border-radius','13px');
  await composer.locator('#protection-settings').evaluate(el=>{el.open=true;});
  await composer.getByRole('radio',{name:'Edit or Mask',exact:true}).check();
  await composer.locator('#client-ids').uncheck();
  await expect(composer.locator('#client-ids')).toBeEnabled();
  await expect.poll(()=>composer.evaluate(async()=>(await chrome.storage.local.get('policy')).policy.protectClientIds)).toBe(false);
  await composer.reload();
  await composer.locator('#fields-title').click();
  await expect(composer.locator('#saved-fields span')).toHaveText(['internal_code','dataset1']);
  await expect(composer.locator('input[name=mode]:checked')).toHaveValue('block');
  await expect(composer.locator('#client-ids')).not.toBeChecked();
  await expect(composer.locator('#saved-fields')).toBeVisible();
  for (const width of [410,661,780]) {
    await composer.setViewportSize({width,height:1000});
    expect(await composer.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
    const input=await composer.locator('#sensitive-names').boundingBox();
    const button=await composer.locator('#save-fields').boundingBox();
    const saved=await composer.locator('#saved-fields').boundingBox();
    expect(Math.abs(input.y-button.y)).toBeLessThan(1);
    expect(input.height).toBe(button.height);
    expect(saved.y).toBeGreaterThan(input.y+input.height);
  }
  await expect(composer.locator('h1 span')).toHaveCSS('letter-spacing','normal');
  await expect(composer.locator('h1 span')).toHaveCSS('color','rgb(255, 255, 255)');
  await expect(composer.locator('.stats [title]')).toHaveCount(0);
  await expect(composer.locator('#activity-status')).toBeHidden();
  await expect(composer.getByText('Counts stay on this device.',{exact:true})).toHaveCount(0);
  await expect(composer.locator('#field-example,textarea')).toHaveCount(0);
  await composer.setViewportSize({width:410,height:1000});
  await mkdir(path.join(root,'artifacts'),{recursive:true});
  await composer.locator('#protection-settings').evaluate(el=>{el.open=true;});
  await composer.screenshot({path:path.join(root,'artifacts','composer.png'),fullPage:true});
  await composer.locator('#protection-settings').screenshot({path:path.join(root,'artifacts','protection-settings.png')});
});

async function noticeHarness(host='chatgpt.com', deferred=false) {
  const browser=await chromium.launch({channel:'chromium'});
  const page=await browser.newPage({reducedMotion:deferred?'reduce':'no-preference'});
  await page.clock.install({time:new Date('2026-01-01T00:00:00Z')});
  await page.clock.pauseAt(new Date('2026-01-01T00:00:01Z'));
  await page.route(`https://${host}/**`,route=>route.fulfill({contentType:'text/html',body:fixture(host==='claude.ai'?'editable':'textarea')}));
  await page.goto(`https://${host}/`);
  await page.evaluate(deferred=>{
    window.policyUnavailable=true;
    const attach=Element.prototype.attachShadow;
    Element.prototype.attachShadow=function(options) {
      const shadow=attach.call(this,options);
      if (this.id==='secret-shield-notice') window.noticeShadow=shadow;
      return shadow;
    };
    window.chrome={storage:{local:{get:async()=>{
      if (window.policyUnavailable) throw new Error('synthetic storage failure');
      return {};
    }},managed:{get:async()=>({})},onChanged:{addListener:listener=>{window.policyChanged=listener;}}},
      runtime:{getURL:file=>`chrome-extension://test/${file}`,onMessage:{addListener:listener=>{window.coverageListener=listener;}}}};
    if (deferred) {window.noticeBody=document.body;document.body.remove();}
  },deferred);
  for (const name of ['core','policy','adapters','content']) await page.addScriptTag({content:await readFile(path.join(root,'src',name+'.js'),'utf8')});
  return {browser,page};
}

for (const host of ['chatgpt.com','claude.ai']) test(`${host}: notices count down for five seconds and replacements restart the timer`, async () => {
  const {browser,page}=await noticeHarness(host);
  try {
    const notice=page.locator('#secret-shield-notice');
    await expect(notice).toBeVisible();
    const progress=await page.evaluate(()=>{
      const bar=window.noticeShadow.querySelector('.notice-progress');
      const animation=bar.getAnimations()[0];
      animation.pause();animation.currentTime=2500;
      const rect=bar.getBoundingClientRect(),parent=bar.parentElement.getBoundingClientRect();
      return {duration:animation.effect.getTiming().duration,easing:animation.effect.getTiming().easing,
        width:rect.width,parentWidth:parent.width,height:rect.height,top:rect.top-parent.top,color:getComputedStyle(bar).backgroundColor};
    });
    expect(progress.duration).toBe(5000);expect(progress.easing).toBe('linear');
    expect(Math.abs(progress.width-(progress.parentWidth-2)/2)).toBeLessThan(1);
    expect(progress.height).toBe(3);expect(progress.top).toBe(1);
    expect(progress.color).toBe('rgb(69, 214, 200)');
    await page.clock.runFor(4000);
    await page.locator('textarea,[contenteditable]').press('Enter');
    await expect(notice).toHaveCount(1);
    expect(await page.evaluate(()=>window.noticeShadow.textContent)).toContain('Reload the extension and this tab.');
    expect(await page.evaluate(()=>window.noticeShadow.querySelector('.notice-progress').getAnimations().length)).toBe(1);
    await page.clock.runFor(1000);
    await expect(notice).toBeVisible();
    await page.clock.runFor(3999);
    await expect(notice).toBeVisible();
    await page.clock.runFor(1);
    await expect(notice).toHaveCount(0);
    expect(await page.evaluate(()=>window.submitted)).toEqual([]);
    await page.locator('textarea,[contenteditable]').press('Enter');
    await expect(notice).toBeVisible();
    await page.clock.runFor(5000);
    await expect(notice).toHaveCount(0);
    expect(await page.evaluate(()=>window.submitted)).toEqual([]);
    await page.evaluate(()=>{window.policyUnavailable=false;window.policyChanged({policy:{}},'local');});
    await expect.poll(()=>page.evaluate(()=>new Promise(resolve=>window.coverageListener({type:'coverage'},null,resolve)))).toMatchObject({ready:true});
    await page.locator('textarea,[contenteditable]').fill('api_key=synthetic-notice-timer-123');
    await page.locator('textarea,[contenteditable]').press('Enter');
    await expect(review(page)).toBeVisible();
    await page.clock.runFor(5000);
    await expect(review(page)).toBeVisible();
    expect(await page.evaluate(()=>window.submitted)).toEqual([]);
  } finally {await browser.close();}
});

test('a deferred notice starts its five-second timer on display, including reduced motion', async () => {
  const {browser,page}=await noticeHarness('chatgpt.com',true);
  try {
    await page.clock.runFor(6000);
    await expect(page.locator('#secret-shield-notice')).toHaveCount(0);
    await page.evaluate(()=>{document.documentElement.append(window.noticeBody);document.dispatchEvent(new Event('DOMContentLoaded'));});
    await expect(page.locator('#secret-shield-notice')).toBeVisible();
    expect(await page.evaluate(()=>window.noticeShadow.querySelector('.notice-progress').getAnimations()[0].effect.getTiming().easing)).toBe('steps(5)');
    await page.clock.runFor(4999);
    await expect(page.locator('#secret-shield-notice')).toBeVisible();
    await page.clock.runFor(1);
    await expect(page.locator('#secret-shield-notice')).toHaveCount(0);
  } finally {await browser.close();}
});

for (const state of ['pending','unavailable','invalid']) test(`${state} policy blocks submission in the content-script harness`, async () => {
  const browser=await chromium.launch({channel:'chromium'});
  const page=await browser.newPage();
  await page.route('https://chatgpt.com/**',route=>route.fulfill({contentType:'text/html',body:fixture()}));
  await page.goto('https://chatgpt.com/');
  await page.evaluate(state=>{
    const get=()=>state==='pending'?new Promise(()=>{}):state==='invalid'?Promise.resolve({policy:{mode:'allow-all'}}):Promise.reject(new Error('unreadable'));
    window.chrome={storage:{local:{get},managed:{get:async()=>({})},onChanged:{addListener:()=>{}}},runtime:{getURL:file=>`chrome-extension://test/${file}`,onMessage:{addListener:()=>{}}}};
  },state);
  for(const name of ['core','policy','adapters','content']) await page.addScriptTag({content:await readFile(path.join(root,'src',name+'.js'),'utf8')});
  await page.locator('textarea').fill('ordinary prompt');await page.locator('textarea').press('Enter');
  expect(await page.evaluate(()=>window.submitted)).toEqual([]);
  await browser.close();
});

for (const host of ['chatgpt.com','claude.ai']) test(`${host}: Markdown and multiline authorization cannot send unmasked credentials after Mask`,async()=>{
  const page=await chat(host), requests=[];
  page.on('request',request=>{if(request.method()==='POST') requests.push(request.postData());});
  const cases=[
    ['client_secret: `synthetic-markdown-123`','client_secret: `xxxxxxxxxx`'],
    ['`client_secret`: synthetic-label-123','`client_secret`: xxxxxxxxxx'],
    ['client_secret:\n```\nsynthetic-fenced-123\n```','client_secret:\n```xxxxxxxxxx```'],
    ['Authorization: Bearer\nsynthetic-bearer-123','Authorization: Bearer\nxxxxxxxxxx'],
    ['Authorization: Basic\n"synthetic basic token"','Authorization: Basic\n"xxxxxxxxxx"'],
  ];
  const sent=[];
  for(const [original,masked] of cases){
    await page.locator('textarea,[contenteditable]').fill(original);
    await page.locator('textarea,[contenteditable]').press('Enter');
    await expect(review(page)).toBeVisible();
    expect(requests).toEqual(sent);
    await review(page).getByRole('button',{name:'Mask',exact:true}).click();
    sent.push(masked);
    await expect.poll(()=>requests).toEqual(sent);
  }
  await page.close();
});
for(const host of ['chatgpt.com','claude.ai']) test(`${host}: CSS-hidden editor and send duplicates do not block the visible composer`,async()=>{
  const page=await chat(host);
  await page.evaluate(()=>{
    const active=document.querySelector('textarea,[contenteditable]');
    const hidden=active.cloneNode(true);hidden.removeAttribute('id');
    if(hidden.tagName==='TEXTAREA') hidden.dataset.id='root';
    hidden.style.visibility='hidden';document.body.append(hidden);
    const button=document.querySelector('[data-testid="send-button"]').cloneNode(true);
    button.style.visibility='hidden';document.body.append(button);
  });
  const editor=page.locator('textarea,[contenteditable]').first();
  await editor.fill('A plain prompt.');await clickSend(page);
  await expect.poll(()=>page.evaluate(()=>window.submitted)).toEqual(['A plain prompt.']);
  await editor.fill('client_secret=synthetic-visible-123');await editor.press('Enter');
  await expect(review(page)).toBeVisible();
  await review(page).getByRole('button',{name:'Mask',exact:true}).click();
  await expect.poll(()=>page.evaluate(()=>window.submitted)).toEqual(['A plain prompt.','client_secret=xxxxxxxxxx']);
  await page.close();
});
test('two extension views preserve simultaneous field additions and independent setting changes',async()=>{
  const other=await context.newPage();
  try {
    await other.goto(`chrome-extension://${extensionId}/composer.html`);
    await expect(other.locator('#sensitive-names')).toBeEnabled();
    await other.locator('#fields-title').click();
    await composer.locator('#sensitive-names').fill('first_field');
    await other.locator('#sensitive-names').fill('second_field');
    await Promise.all([composer,other].map(page=>page.locator('#field-form').evaluate(form=>form.requestSubmit())));
    await expect.poll(()=>composer.evaluate(async()=>((await chrome.storage.local.get('policy')).policy?.sensitiveNames ?? []).slice().sort())).toEqual(['first_field','second_field']);
    await expect(composer.locator('#sensitive-names')).toHaveValue('');
    await expect(other.locator('#sensitive-names')).toHaveValue('');
    await other.locator('#protection-settings').evaluate(element=>{element.open=true;});
    await Promise.all([composer.getByRole('button',{name:'Remove first_field',exact:true}).click(),
      other.getByRole('radio',{name:'Edit or Mask',exact:true}).check()]);
    await expect.poll(()=>composer.evaluate(async()=>(await chrome.storage.local.get('policy')).policy)).toEqual({mode:'block',protectClientIds:true,sensitiveNames:['second_field']});
    await expect(composer.locator('#field-status')).toHaveText('');
    await expect(other.locator('#settings-status')).toHaveText('');
  } finally { await other.close(); }
});
