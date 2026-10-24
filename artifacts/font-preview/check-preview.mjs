import {chromium,expect} from '@playwright/test';
import {readFile,writeFile} from 'node:fs/promises';
import {pathToFileURL} from 'node:url';
import path from 'node:path';
const browser=await chromium.launch({channel:'chromium'});
const errors=[];
try{
  const page=await browser.newPage({viewport:{width:780,height:900},deviceScaleFactor:2});
  page.on('pageerror',e=>errors.push(e.message));
  await page.goto(pathToFileURL(path.resolve('artifacts/font-preview/rendered.html')).href);
  const frame=page.frameLocator('iframe');
  const root=frame.locator('#ckretguard-lexend-preview');
  await expect(root).toBeVisible();
  await root.evaluate(()=>document.fonts.ready);
  const fonts=await root.evaluate(()=>[...document.fonts].map(font=>({family:font.family,status:font.status})));
  expect(fonts.some(font=>font.family==='Lexend Deca'&&font.status==='loaded')).toBe(true);
  const family=await frame.locator('.cg-lexend').evaluate(el=>getComputedStyle(el).fontFamily);
  expect(family).toContain('Lexend Deca');
  await expect(frame.locator('[data-variant="Lexend Deca"]')).toBeVisible();
  await expect(frame.locator('[data-variant="Current font"]')).toBeHidden();
  const snapshots=[];
  for(const width of [780,410,320]){
    await page.setViewportSize({width,height:900});
    const overflow=await root.evaluate(()=>document.documentElement.scrollWidth>innerWidth);
    expect(overflow).toBe(false);
    const clipped=await root.locator('.cg-lexend').evaluate(window=>{
      const r=window.getBoundingClientRect();return [...window.querySelectorAll('.cg-brand,.cg-subtitle,.cg-tagline,dt,dd,.cg-caption')].some(el=>{const b=el.getBoundingClientRect();return b.left<r.left||b.right>r.right||el.scrollWidth>el.clientWidth+1;});
    });
    expect(clipped).toBe(false);
    await root.screenshot({path:`artifacts/font-preview/lexend-${width}.png`});
    snapshots.push({width,overflow,clipped});
  }
  await page.setViewportSize({width:780,height:900});
  const controls=await frame.locator('button').allTextContents();
  const next=frame.getByRole('button',{name:/next/i});
  if(await next.count()){
    await next.first().click();
    await expect(frame.locator('[data-variant="Current font"]')).toBeVisible();
    await expect(frame.locator('[data-variant="Lexend Deca"]')).toBeHidden();
  }else throw new Error(`Carousel control unavailable: ${controls.join(', ')}`);
  expect(errors).toEqual([]);
  await writeFile('artifacts/font-preview/checks.json',JSON.stringify({fonts,family,snapshots,errors},null,2));
  console.log(JSON.stringify({fonts,family,snapshots,carousel:true,errors}));
}finally{await browser.close();}
