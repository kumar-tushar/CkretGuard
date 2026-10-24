import {chromium,expect} from '@playwright/test';
import {createHash} from 'node:crypto';
import {readFile} from 'node:fs/promises';
import path from 'node:path';
const extension=path.resolve('dist');
const id=[...createHash('sha256').update(extension).digest().subarray(0,16)].map(b=>String.fromCharCode(97+(b>>4),97+(b&15))).join('');
const context=await chromium.launchPersistentContext('',{channel:'chromium',headless:true,viewport:{width:410,height:650},deviceScaleFactor:2,args:[`--disable-extensions-except=${extension}`,`--load-extension=${extension}`]});
try{
  const page=await context.newPage();await page.goto(`chrome-extension://${id}/composer.html`);
  await expect(page.locator('#stat-detected')).toHaveText('0');
  await expect(page.locator('.stats>div')).toHaveCount(3);
  await expect(page.locator('.intro h2')).toHaveText('Ask freely. Keep secrets private.');
  await expect(page.locator('.intro h2')).toHaveCSS('color','rgb(69, 214, 200)');
  await expect(page.locator('header')).toHaveCSS('border-bottom-width','0px');
  await expect(page.locator('#stat-edited')).toHaveCount(0);
  for(const width of [410,661,780]){
    await page.setViewportSize({width,height:650});
    expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
    await page.screenshot({path:`artifacts/font-preview/current-production-${width}.png`});
  }
  const css=await readFile('extension/composer.css','utf8');
  const before=await readFile('/tmp/ckretguard-three-metrics-before/extension/composer.css','utf8');
  expect(css.split('\n')[0]).toBe(before.split('\n')[0]);
  expect(css).not.toContain('Lexend');
  expect(await page.locator('h1').evaluate(el=>getComputedStyle(el).fontFamily)).not.toContain('Lexend');
  console.log(JSON.stringify({cards:3,widths:[410,661,780],divider:false,tagline:'Lagoon Teal',productionFontUnchanged:true}));
}finally{await context.close();}
