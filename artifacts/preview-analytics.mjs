import { chromium,expect } from '@playwright/test';
import { createHash } from 'node:crypto';
import { writeFile } from 'node:fs/promises';
import path from 'node:path';
const extension=path.resolve('dist');
const id=[...createHash('sha256').update(extension).digest().subarray(0,16)].map(b=>String.fromCharCode(97+(b>>4),97+(b&15))).join('');
const context=await chromium.launchPersistentContext('',{channel:'chromium',headless:true,reducedMotion:'reduce',viewport:{width:410,height:720},deviceScaleFactor:2,args:[`--disable-extensions-except=${extension}`,`--load-extension=${extension}`]});
const errors=[];
try{
  const page=await context.newPage();page.on('pageerror',e=>errors.push(e.message));
  await page.goto(`chrome-extension://${id}/composer.html`);
  await expect(page.locator('#mask')).toBeEnabled();
  await expect(page.locator('#stat-detected')).toHaveText('0');
  await expect(page.locator('.intro h2')).toHaveText('Share the question, keep the secret');
  await expect(page.locator('.intro h2')).toHaveCSS('color','rgb(255, 255, 255)');
  await expect(page.locator('.stats > div')).toHaveCount(4);
  await expect(page.getByText('A little less',{exact:false})).toHaveCount(0);
  await expect(page.getByText('OFFLINE',{exact:true})).toHaveCount(0);
  await expect(page.locator('#coverage')).toBeHidden();
  for(const width of [410,780]){
    await page.setViewportSize({width,height:720});
    expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
    const heading=await page.locator('.intro h2').evaluate(el=>({height:el.getBoundingClientRect().height,line:parseFloat(getComputedStyle(el).lineHeight)}));
    expect(heading.height).toBe(heading.line);
    await page.screenshot({path:`artifacts/analytics-composer-${width}.png`,fullPage:true});
  }
  await page.setViewportSize({width:410,height:600});
  await page.screenshot({path:'artifacts/analytics-dashboard-preview.png'});
  // Exercise the client and service worker through real local masking, then reopen the page.
  await page.locator('#draft').fill('api_key=synthetic-preview-123\npassword=synthetic-preview-456');
  await page.locator('#mask').click();
  await expect(page.locator('#stat-detected')).toHaveText('2');
  await expect(page.locator('#stat-masked')).toHaveText('2');
  await expect(page.locator('#copy')).toBeEnabled();
  await expect(page.locator('#result')).toHaveValue('api_key=xxxxx\npassword=xxxxx');
  const stored=await page.evaluate(async()=>chrome.storage.local.get(null));
  expect(stored).toEqual({activity:{detected:2,masked:2,sent:0,edited:0}});
  await page.reload();await expect(page.locator('#stat-detected')).toHaveText('2');
  // Corrupted or huge totals must not force a horizontal scrollbar.
  await page.evaluate(()=>chrome.storage.local.set({activity:{detected:Number.MAX_SAFE_INTEGER,masked:0,sent:0,edited:0}}));
  await expect(page.locator('#stat-detected')).not.toHaveText('2');
  expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
  expect(errors).toEqual([]);
  const report={widths:[410,780],cards:4,tagline:'Share the question, keep the secret',stored,errors};
  await writeFile('artifacts/analytics-visual-checks.json',JSON.stringify(report,null,2));console.log(JSON.stringify(report));
}finally{await context.close();}
