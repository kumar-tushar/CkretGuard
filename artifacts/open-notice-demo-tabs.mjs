import { chromium,expect } from '@playwright/test';
import { readFile,writeFile,mkdir } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import path from 'node:path';

const root=path.resolve('.');
const source=await readFile('src/content.js','utf8');
const inventory=JSON.parse(await readFile('artifacts/ui-inventory-data.json','utf8'));
const template=await readFile('artifacts/notice-demo-template.html','utf8');
const output=path.join(root,'artifacts','notice-demo-tabs');
await mkdir(output,{recursive:true});
const font=source.match(/const fontFamily = '([^']+)'/)[1];
const show=source.slice(source.indexOf('  function show(message) {'),source.indexOf('  function stop(event)'));
const escape=text=>text.replace(/[&<>"']/g,ch=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[ch]));
expect(inventory.notices).toHaveLength(10);
const paths=[];
for(const [index,item] of inventory.notices.entries()) {
  const script=`(() => { const fontFamily=${JSON.stringify(font)};let notice=null,pendingNotice='';${show}\nshow(${JSON.stringify(item.text)});})();`;
  const html=template.replace('__TITLE__',escape(`${index+1}/10 · ${item.title} · Local demo`)).replace('__INDEX__',String(index+1)).replace('__HEADING__',escape(item.title)).replace('__TRIGGER__',escape(item.when)).replace('__NOTICE_SCRIPT__',script.replaceAll('</script','<\\/script'));
  const file=path.join(output,`notice-${String(index+1).padStart(2,'0')}.html`);
  await writeFile(file,html);paths.push(file);
}

const browser=await chromium.launch({channel:'chromium',headless:false,args:['--window-size=1360,900']});
const context=await browser.newContext({viewport:null,offline:true});
await context.addInitScript(()=>{
  const original=Element.prototype.attachShadow;
  Element.prototype.attachShadow=function(options){const shadow=original.call(this,options);if(this.id==='secret-shield-notice')window.demoNoticeShadow=shadow;return shadow;};
});
const seen=[];
for(const [index,file] of paths.entries()) {
  const page=await context.newPage();
  await page.goto(pathToFileURL(file).href);
  const expected=`Ckretguard · ${inventory.notices[index].text}`;
  const notice=await page.evaluate(()=>{const div=window.demoNoticeShadow.querySelector('div'),style=getComputedStyle(div),rect=div.getBoundingClientRect();return {text:div.textContent,background:style.backgroundColor,blur:style.backdropFilter,bottom:innerHeight-rect.bottom,right:innerWidth-rect.right};});
  expect(notice).toEqual({text:expected,background:'rgba(24, 24, 24, 0.55)',blur:'blur(6px)',bottom:40,right:20});
  await expect(page.locator('#secret-shield-notice')).toBeVisible();
  expect(await page.title()).toBe(`${index+1}/10 · ${inventory.notices[index].title} · Local demo`);
  seen.push({tab:index+1,title:await page.title(),url:page.url(),notice:expected});
}
expect(context.pages()).toHaveLength(10);
await context.pages()[0].bringToFront();
await context.pages()[0].screenshot({path:path.join(root,'artifacts','notice-demo-tabs-open.png')});
await writeFile(path.join(output,'open-tabs.json'),JSON.stringify(seen,null,2));
console.log(JSON.stringify({opened:seen.length,browser:'Chromium test window',offline:true,tabs:seen},null,2));
console.log('The demo window will remain open until you close it.');
await new Promise(resolve=>browser.once('disconnected',resolve));
