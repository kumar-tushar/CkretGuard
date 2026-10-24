import { chromium, expect } from '@playwright/test';
import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

const root=path.resolve('.');
const source=await readFile('src/content.js','utf8');
const composerSource=await readFile('extension/composer.js','utf8');
const composerHtml=await readFile('extension/composer.html','utf8');
const font=source.match(/const fontFamily = '([^']+)'/)[1];
const noticeCss=source.match(/style\.textContent = `(:host\{all:initial;position:fixed;[\s\S]+?)`;/)[1].replace('${fontFamily}',font);
const noticeMessages=new Set();
for(const match of source.matchAll(/\bshow\((.+?)\);/g)) {
  if(match[1]==='pendingNotice')continue;
  for(const policyError of [false,true]) {
    const message=Function('policyError',`return (${match[1]});`)(policyError);
    if(typeof message==='string')noticeMessages.add(message);
  }
}
const noticeTitles={
  'Loading local policy. Send is paused; try again shortly.':['Policy loading','A send attempt happens before the local policy finishes loading.'],
  'Policy unavailable. Send is paused. Reload the extension and this tab.':['Policy unavailable during send','The user tries to send while policy loading has failed.'],
  'The draft or policy changed. Send again to review the current prompt.':['Draft or policy changed','Send or Mask is selected after the reviewed draft or policy changes.'],
  'Send is not ready. Your draft is still in the input box.':['Send control not ready','Send is selected but the website’s send control is disabled.'],
  'Could not activate Send. Your draft is still in the input box.':['Send could not activate','The reviewed original prompt cannot be submitted safely.'],
  'The masked draft is ready, but Send is unavailable. It has not been sent.':['Masked draft waiting','Mask succeeds, but the website’s send control does not become ready.'],
  'Could not send the masked prompt. Check the draft and send again.':['Masked send failed','The draft changes, updating fails, or masked submission cannot complete.'],
  'Chat input could not be identified uniquely. Use the extension’s local composer.':['Chat input unavailable','No unique supported chat input can be identified.'],
  'Could not scan or update this input. Send blocked. Use the local composer.':['Scan or input update failed','Scanning fails, including invalid or oversized input.'],
  'Policy unavailable. Send is paused.':['Policy loading failed','Initial policy loading or a policy refresh fails.'],
};
expect(noticeMessages.size).toBe(10);
expect(new Set(Object.keys(noticeTitles))).toEqual(noticeMessages);
const notices=[...noticeMessages].map(text=>({title:noticeTitles[text][0],when:noticeTitles[text][1],text}));

const composerMessages=new Map();
function expressionAt(start) {
  let quote='',escaped=false;
  for(let i=start;i<composerSource.length;i++) {
    const ch=composerSource[i];
    if(quote) {
      if(escaped)escaped=false;
      else if(ch==='\\')escaped=true;
      else if(ch===quote)quote='';
    } else if(ch==='\''||ch==='"'||ch==='`')quote=ch;
    else if(ch===';')return composerSource.slice(start,i);
  }
  throw new Error('Unterminated message expression');
}
for(const match of composerSource.matchAll(/\$\('(result-status|coverage|settings-status|managed-label)'\)\.textContent\s*=\s*/g)) {
  const expression=expressionAt(match.index+match[0].length);
  for(const count of [0,1,2])for(const site of ['ChatGPT','Claude'])for(const ready of [false,true])for(const locked of [[],['mode']]) {
    const result={count};const state={site,ready,editors:ready?1:0};
    const text=Function('result','state','locked',`return (${expression});`)(result,state,locked);
    if(text)composerMessages.set(text,{channel:match[1],text});
  }
}
for(const channel of ['coverage','result-status']) {
  const text=composerHtml.match(new RegExp(`<[^>]+id="${channel}"[^>]*>([^<]+)<`))[1];
  composerMessages.set(text,{channel,text});
}
expect(composerMessages.size).toBe(20);
const composerTitles=[
  ['Draft changed.','Draft changed','Editing the draft invalidates the previous masked result.'],
  ['1 possible secret masked.','One credential masked','The local scanner masks one detected occurrence.'],
  ['2 possible secrets masked.','Multiple credentials masked','The number reflects the detected occurrences.'],
  ['No supported secret pattern','No supported pattern found','The local scan finds no recognized credential pattern.'],
  ['Could not scan.','Local scan failed','The local scan or policy is unavailable or the input cannot be processed.'],
  ['Text cleared','Text cleared','Clear removes the draft and masked result from this window.'],
  ['Masked text copied.','Copy succeeded','Copy masked text writes the reviewed result to the clipboard.'],
  ['Could not copy.','Copy failed','Clipboard copying fails or the reviewed result is no longer safe to copy.'],
  ['Ready.','Composer ready','Local policy has loaded successfully.'],
  ['Policy unavailable.','Composer policy unavailable','Policy loading fails; masking and copying are paused.'],
  ['Settings saved.','Settings saved','The protection settings have been saved successfully.'],
  ['Could not save.','Settings could not save','Settings are invalid or writing settings fails.'],
  ['Managed by your organization','Managed settings','Organization policy locks one or more protection fields.'],
  ['ChatGPT input recognized','ChatGPT guard ready','The active ChatGPT tab reports one supported input and a loaded policy.'],
  ['Claude input recognized','Claude guard ready','The active Claude tab reports one supported input and a loaded policy.'],
  ['ChatGPT · guard unavailable','ChatGPT guard unavailable','The ChatGPT input is not uniquely recognized or its policy is not ready.'],
  ['Claude · guard unavailable','Claude guard unavailable','The Claude input is not uniquely recognized or its policy is not ready.'],
  ['Local composer ready ·','No supported active chat','No supported tab can be reached, including a tab needing refresh.'],
  ['Checking chat input','Checking the active tab','The extension window is checking input coverage.'],
  ['Loading local policy','Loading composer policy','The extension window has opened and local policy is loading.'],
];
const composerStates=[...composerMessages.values()].map(item=>{
  const description=composerTitles.find(([prefix])=>item.text.startsWith(prefix));
  if(!description)throw new Error(`Missing description: ${item.text}`);
  return {...item,title:description[1],when:description[2]};
});

const extension=path.join(root,'dist');
expect(await readFile(path.join(extension,'content.js'),'utf8')).toBe(source);
const extensionId=[...createHash('sha256').update(extension).digest().subarray(0,16)].map(b=>String.fromCharCode(97+(b>>4),97+(b&15))).join('');
const context=await chromium.launchPersistentContext('',{channel:'chromium',headless:true,reducedMotion:'reduce',deviceScaleFactor:2,viewport:{width:460,height:800},args:[`--disable-extensions-except=${extension}`,`--load-extension=${extension}`]});
const reviews=[];
try {
  await context.route('https://chatgpt.com/**',route=>route.fulfill({contentType:'text/html',body:'<form><textarea id="prompt-textarea"></textarea><button data-testid="send-button">Send</button></form>'}));
  const composer=await context.newPage();await composer.goto(`chrome-extension://${extensionId}/composer.html`);await expect(composer.locator('#mask')).toBeEnabled();
  const composerMarkup=await composer.locator('main').evaluate(main=>main.outerHTML);
  const composerCss=await readFile('extension/composer.css','utf8');
  const shield=`data:image/png;base64,${(await readFile('dist/icons/shield-48.png')).toString('base64')}`;
  const page=await context.newPage();await page.goto('https://chatgpt.com/');await page.bringToFront();
  await expect.poll(()=>composer.evaluate(async()=>{const [tab]=await chrome.tabs.query({active:true,currentWindow:true});return (await chrome.tabs.sendMessage(tab.id,{type:'coverage'})).ready;})).toBe(true);
  const editor=page.locator('textarea');
  let iconImages=[];
  for(const item of [
    {title:'One secret detected',when:'Send or Enter detects one supported credential.',draft:'api_key="synthetic-demo-key-123"'},
    {title:'Multiple secrets detected',when:'The headline shows the exact detected occurrence count.',draft:'api_key="synthetic-demo-key-123"\npassword="synthetic-demo-password-456"'},
    {title:'Organization Block mode',when:'Managed or local Block mode disables Send and adds this explanation.',draft:'api_key="synthetic-demo-key-123"',block:true},
    {title:'Closing / submitting',when:'Send, Edit, or Mask disables all three buttons while the exit animation completes.',draft:'api_key="synthetic-demo-key-123"',closing:true},
  ]) {
    await composer.evaluate(mode=>chrome.storage.local.set({policy:{mode}}),item.block?'block':'redact');
    await expect(composer.locator('#mode')).toHaveValue(item.block?'block':'redact');
    await expect.poll(()=>composer.evaluate(async()=>{const [tab]=await chrome.tabs.query({active:true,currentWindow:true});return (await chrome.tabs.sendMessage(tab.id,{type:'coverage'})).ready;})).toBe(true);
    await editor.fill(item.draft);await editor.press('Enter');
    const dialog=page.getByRole('dialog');await expect(dialog).toBeVisible();
    if(!iconImages.length) {
      const specs=await dialog.locator('.button-icon').evaluateAll(icons=>icons.map(icon=>({html:icon.outerHTML,color:getComputedStyle(icon).color})));
      const iconPage=await context.newPage();
      for(const icon of specs) {
        await iconPage.setContent(`<style>html,body{margin:0;background:transparent;color:${icon.color}}svg{display:block;width:14px;height:14px}</style>${icon.html}`);
        iconImages.push(`data:image/png;base64,${(await iconPage.locator('svg').screenshot({omitBackground:true})).toString('base64')}`);
      }
      await iconPage.close();await page.bringToFront();
    }
    if(item.closing) {
      await page.emulateMedia({reducedMotion:'no-preference'});
      await dialog.evaluate(d=>{d.querySelector('.edit').click();d.getAnimations().forEach(a=>{a.pause();a.currentTime=0;});});
    }
    const captured=await dialog.evaluate(d=>({html:d.outerHTML,css:d.getRootNode().querySelector('style').textContent}));
    let iconIndex=0;
    captured.html=captured.html.replace(/<svg\b[\s\S]*?<\/svg>/g,()=>`<img class="button-icon" src="${iconImages[iconIndex++]}" alt="" aria-hidden="true">`).replace(/ autofocus=""/g,'');
    const orbit=`data:image/png;base64,${(await readFile('extension/icons/orbit-pointer.png')).toString('base64')}`;
    captured.css=captured.css.replaceAll(`chrome-extension://${extensionId}/icons/orbit-pointer.png`,orbit);
    reviews.push({...captured,title:item.title,when:item.when});
    if(!item.closing)await dialog.getByRole('button',{name:'Edit',exact:true}).click();
  }
  const data={version:'1.0.0',reviews,noticeCss,notices,composerCss,composerMarkup:composerMarkup.replace(/src="[^"]*icons\/shield-48\.png"/,`src="${shield}"`),composerStates};
  await writeFile('artifacts/ui-inventory-data.json',JSON.stringify(data,null,2));
  console.log(JSON.stringify({reviewStates:reviews.length,notices:notices.length,extensionMessages:composerStates.length,noticeTexts:notices.map(n=>n.text),extensionTexts:composerStates.map(n=>n.text)}));
} finally {await context.close();}
