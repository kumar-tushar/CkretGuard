import { chromium,expect } from '@playwright/test';
import { createHash } from 'node:crypto';
import { readFile,writeFile } from 'node:fs/promises';
import path from 'node:path';

const root=path.resolve('.'),extension=path.join(root,'dist');
const extensionId=[...createHash('sha256').update(extension).digest().subarray(0,16)].map(b=>String.fromCharCode(97+(b>>4),97+(b&15))).join('');
const context=await chromium.launchPersistentContext('',{channel:'chromium',headless:true,reducedMotion:'reduce',viewport:{width:410,height:780},deviceScaleFactor:2,args:[`--disable-extensions-except=${extension}`,`--load-extension=${extension}`]});
const errors=[];context.on('page',p=>p.on('pageerror',e=>errors.push(e.message)));
await context.route(/^https:\/\//,route=>route.abort());
try {
  const page=await context.newPage();
  await page.goto(`chrome-extension://${extensionId}/composer.html`);
  await expect(page.locator('#mask')).toBeEnabled();
  await expect(page.locator('h1')).toHaveText('CkretGuardLOCAL PROMPT GUARD');
  await expect(page.locator('h1')).toHaveCSS('color','rgb(69, 214, 200)');
  await expect(page.locator('header .brand-icon')).toHaveCSS('background-color','rgb(69, 214, 200)');
  for(const selector of ['.coverage','.workspace']) {
    await expect(page.locator(selector)).toHaveCSS('background-color','rgba(24, 24, 24, 0.55)');
    await expect(page.locator(selector)).toHaveCSS('backdrop-filter','blur(6px)');
  }
  for(const width of [410,780]) {
    await page.setViewportSize({width,height:800});
    expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
    await page.screenshot({path:`artifacts/branding-composer-${width}.png`,fullPage:true});
  }
  await page.setViewportSize({width:410,height:780});
  await page.screenshot({path:'artifacts/branding-composer-preview.png'});
  const source=await readFile('src/content.js','utf8');
  const font=source.match(/const fontFamily = '([^']+)'/)[1];
  const show=source.slice(source.indexOf('  function show(message) {'),source.indexOf('  function stop(event)'));
  const notices=JSON.parse(await readFile('artifacts/ui-inventory-data.json','utf8')).notices;
  const icon=`data:image/png;base64,${(await readFile('extension/icons/orbit-pointer.png')).toString('base64')}`;
  const noticePage=await context.newPage();
  const template=(await readFile('artifacts/notice-demo-template.html','utf8')).replace(/<script>__NOTICE_SCRIPT__<\/script>/,'').replaceAll('CKRETGUARD','CkretGuard').replaceAll('Ckretguard','CkretGuard');
  await noticePage.setContent(template.replace('__HEADING__','Updated brand preview').replace('__TRIGGER__','Local rendering check with synthetic content.').replace('__INDEX__','1'));
  await noticePage.evaluate(({font,show,icon})=>{
    window.chrome={runtime:{getURL:()=>icon}};
    const attach=Element.prototype.attachShadow;
    Element.prototype.attachShadow=function(options){const shadow=attach.call(this,options);if(this.id==='secret-shield-notice')window.qaNoticeShadow=shadow;return shadow;};
    eval(`(()=>{const fontFamily=${JSON.stringify(font)};let notice=null,pendingNotice='';${show};window.qaShowNotice=show;})()`);
  },{font,show,icon});
  for(const {text} of notices) {
    await noticePage.evaluate(message=>window.qaShowNotice(message),text);
    const notice=await noticePage.evaluate(()=>{
      const shadow=window.qaNoticeShadow,element=shadow.querySelector('[role=status]'),rect=element.getBoundingClientRect();
      return {text:element.textContent,brand:getComputedStyle(shadow.querySelector('strong')).color,icon:getComputedStyle(shadow.querySelector('.brand-icon')).backgroundColor,bottom:innerHeight-rect.bottom,right:innerWidth-rect.right};
    });
    expect(notice).toEqual({text:`CkretGuard · ${text}`,brand:'rgb(69, 214, 200)',icon:'rgb(69, 214, 200)',bottom:40,right:20});
  }
  await noticePage.setViewportSize({width:1100,height:800});
  await noticePage.evaluate(text=>window.qaShowNotice(text),notices[0].text);
  await noticePage.screenshot({path:'artifacts/branding-notice-preview.png'});
  const icons=[];
  for(const size of [16,48,128]) {
    const source=(await readFile(`dist/icons/ckretguard-${size}.png`)).toString('base64');
    const dimensions=await page.evaluate(async source=>{
      const img=new Image();img.src=`data:image/png;base64,${source}`;await img.decode();
      const canvas=document.createElement('canvas');canvas.width=img.width;canvas.height=img.height;const ctx=canvas.getContext('2d');ctx.drawImage(img,0,0);
      const pixels=ctx.getImageData(0,0,img.width,img.height).data;let opaque=0;
      for(let i=0;i<pixels.length;i+=4)if(pixels[i+3]===255){if(pixels[i]!==69||pixels[i+1]!==214||pixels[i+2]!==200)throw new Error('Non-brand opaque pixel');opaque++;}
      return {width:img.width,height:img.height,opaque};
    },source);
    expect(dimensions.width).toBe(size);expect(dimensions.height).toBe(size);expect(dimensions.opaque).toBeGreaterThan(0);icons.push({size,...dimensions});
  }
  expect(errors).toEqual([]);
  const report={composerWidths:[410,780],notices:notices.length,brand:'#45D6C8',icons,errors};
  await writeFile('artifacts/branding-checks.json',JSON.stringify(report,null,2));console.log(JSON.stringify(report));
} finally {await context.close();}
