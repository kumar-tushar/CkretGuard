import { test, expect, chromium } from '@playwright/test';
import { createHash } from 'node:crypto';
import { readFile, mkdir } from 'node:fs/promises';
import path from 'node:path';

const root = path.resolve('.');
const extension = path.join(root, 'dist');
const extensionId = [...createHash('sha256').update(extension).digest().subarray(0,16)]
  .map(byte => String.fromCharCode(97+(byte>>4), 97+(byte&15))).join('');
const key = 'sk-proj-' + 'SyntheticOnly9_'.repeat(5);
let context, composer;
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
  context = await chromium.launchPersistentContext('', {channel:'chromium',headless:true,
    args:[`--disable-extensions-except=${extension}`,`--load-extension=${extension}`]});
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
  await expect(composer.locator('#mask')).toBeEnabled();
});
test.afterAll(async () => { await context?.close(); });
test.afterEach(async () => {
  if (composer) { await composer.evaluate(()=>chrome.storage.local.clear()); await expect(composer.locator('#mask')).toBeEnabled(); }
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

const review = page => page.getByRole('dialog', { name: 'Secrets detected', exact: true });
const editorText = editor => editor.evaluate(el=>el.value??el.innerText);
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
    await expect(review(page).locator('#ckretguard-review-description')).toHaveText('1 secret detected in this prompt.');
    await expect(review(page).locator('p')).toHaveCount(1);
    await expect(review(page).locator('small')).toHaveCount(0);
    for (const name of ['Send','Edit','Mask']) await expect(review(page).getByRole('button',{name,exact:true})).toBeVisible();
    if (host === 'chatgpt.com') {
      await mkdir(path.join(root,'artifacts'),{recursive:true});
      await page.screenshot({path:path.join(root,'artifacts','review-popup.png'),fullPage:true});
    }
    const sent=page.waitForRequest(req=>req.method()==='POST');
    await review(page).getByRole('button',{name:'Mask',exact:true}).click();
    await expect(review(page)).toBeHidden();
    await expect.poll(()=>editorText(editor)).toBe('Explain api_key="xxxxx" please');
    expect((await sent).postData()).toBe('Explain api_key="xxxxx" please');
    expect(await page.evaluate(()=>window.submitted)).toEqual(['Explain api_key="xxxxx" please']);
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
    await expect(editor).toHaveText('Explain api_key="xxxxx" please');
    expect((await sent).postData()).toBe('Explain api_key="xxxxx" please');
    expect(await page.evaluate(()=>window.submitted)).toEqual(['Explain api_key="xxxxx" please']);
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
  await expect(review(page).locator('#ckretguard-review-description')).toHaveText('3 secrets detected in this prompt.');
  expect(await page.evaluate(()=>window.submitted)).toEqual([]);
  await page.close();
});
test('block policy prevents original Send while Mask submits only clean text', async () => {
  const page=await chat();
  await composer.evaluate(()=>chrome.storage.local.set({policy:{mode:'block'}}));
  await page.locator('textarea').fill(`api_key=${key}`);
  await page.locator('textarea').press('Enter');
  await expect(page.locator('textarea')).toHaveValue(`api_key=${key}`);
  await expect(review(page)).toBeVisible();
  await expect(review(page).getByRole('button',{name:'Send',exact:true})).toBeDisabled();
  const sent=page.waitForRequest(req=>req.method()==='POST');
  await review(page).getByRole('button',{name:'Mask',exact:true}).click();
  await expect(page.locator('textarea')).toHaveValue('api_key=xxxxx');
  expect((await sent).postData()).toBe('api_key=xxxxx');
  expect(await page.evaluate(()=>window.submitted)).toEqual(['api_key=xxxxx']);
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
  expect((await sent).postData()).toBe('api_key=xxxxx');
  await expect(editor).toHaveValue('api_key=xxxxx');
  expect(await page.evaluate(()=>window.submitted)).toEqual(['api_key=xxxxx']);
  await page.close();
});
test('Mask does not submit when the framework rejects the masked editor update', async () => {
  const page=await chat(); const editor=page.locator('textarea');
  const original=`api_key=${key}`;
  await editor.fill(original);
  await editor.press('Enter');
  await page.evaluate(original=>{
    document.querySelector('textarea').addEventListener('input',event=>{
      if (event.target.value === 'api_key=xxxxx') {
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
      if (event.target.value === 'api_key=xxxxx') setTimeout(()=>{
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
  await expect(composer.locator('#mode')).toHaveValue('block');
  await expect.poll(()=>page.evaluate(()=>window.current)).toBe('api_key=xxxxx');
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
  await expect(composer.locator('#mode')).toHaveValue('block');
  await expect.poll(async()=>!await review(page).isVisible() || await review(page).getByRole('button',{name:'Send',exact:true}).isDisabled()).toBe(true);
  await approve.evaluate(button=>button.click());
  expect(await page.evaluate(()=>window.submitted)).toEqual([]);
  await expect(editor).toHaveValue(`api_key=${key}`);
  if (await review(page).isVisible()) await review(page).getByRole('button',{name:'Edit',exact:true}).click();
  await editor.press('Enter');
  await expect(review(page).getByRole('button',{name:'Send',exact:true})).toBeDisabled();
  expect(await page.evaluate(()=>window.submitted)).toEqual([]);
  await page.close();
});
test('large prompts, missing inputs and ambiguous inputs block known send controls', async () => {
  const page=await chat();
  await page.locator('textarea').fill('a'.repeat(100001));
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
test('local composer never persists text and invalidates stale copy results', async () => {
  await composer.locator('#draft').fill(`Please fix API_KEY="${key}"`);
  await composer.locator('#mask').click();
  await expect(composer.locator('#result')).toHaveValue('Please fix API_KEY="xxxxx"');
  await expect(composer.locator('#copy')).toBeEnabled();
  const saved=await composer.evaluate(async()=>JSON.stringify(await chrome.storage.local.get(null)));
  expect(saved).not.toContain(key);expect(saved).not.toContain('Please fix');
  await composer.locator('#draft').fill('changed');
  await expect(composer.locator('#copy')).toBeDisabled();
  await expect(composer.locator('#result')).toHaveValue('');
  await composer.locator('#clear').click();
  await expect(composer.locator('#draft')).toHaveValue('');
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
  await expect(editor).toHaveValue('api_key=xxxxx');
  expect((await sent).postData()).toBe('api_key=xxxxx');
  await page.keyboard.down('Enter');
  expect(await page.evaluate(()=>window.submitted)).toEqual(['api_key=xxxxx']);
  await page.keyboard.up('Enter');
  expect(await page.evaluate(()=>window.submitted)).toEqual(['api_key=xxxxx']);
  await page.close();
});
test('settings store only policy, and composer has no horizontal overflow', async () => {
  await composer.locator('summary').click();
  await composer.locator('#sensitive-names').fill('internal_code');
  await composer.locator('#save').click();
  await expect(composer.locator('#settings-status')).toContainText('Settings saved');
  await composer.locator('#draft').fill('internal_code = fictional-value-9843');
  await composer.locator('#mask').click();
  await expect(composer.locator('#result')).toHaveValue('internal_code = xxxxx');
  await composer.locator('#clear').click();
  await composer.locator('summary').click();
  await composer.setViewportSize({width:410,height:900});
  expect(await composer.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
  await mkdir(path.join(root,'artifacts'),{recursive:true});
  await composer.screenshot({path:path.join(root,'artifacts','composer.png'),fullPage:true});
});

for (const state of ['pending','unavailable','invalid']) test(`${state} policy blocks submission in the content-script harness`, async () => {
  const browser=await chromium.launch({channel:'chromium'});
  const page=await browser.newPage();
  await page.route('https://chatgpt.com/**',route=>route.fulfill({contentType:'text/html',body:fixture()}));
  await page.goto('https://chatgpt.com/');
  await page.evaluate(state=>{
    const get=()=>state==='pending'?new Promise(()=>{}):state==='invalid'?Promise.resolve({policy:{mode:'allow-all'}}):Promise.reject(new Error('unreadable'));
    window.chrome={storage:{local:{get},managed:{get:async()=>({})},onChanged:{addListener:()=>{}}},runtime:{onMessage:{addListener:()=>{}}}};
  },state);
  for(const name of ['core','policy','adapters','content']) await page.addScriptTag({content:await readFile(path.join(root,'src',name+'.js'),'utf8')});
  await page.locator('textarea').fill('ordinary prompt');await page.locator('textarea').press('Enter');
  expect(await page.evaluate(()=>window.submitted)).toEqual([]);
  await browser.close();
});
