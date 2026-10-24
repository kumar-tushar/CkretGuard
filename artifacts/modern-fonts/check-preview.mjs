import { chromium, expect } from '@playwright/test';
import { writeFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import path from 'node:path';

const browser = await chromium.launch({ channel: 'chromium' });
const errors = [];
const snapshots = [];
const names = ['Manrope', 'Geist', 'Plus Jakarta Sans', 'DM Sans', 'Outfit'];
try {
  const page = await browser.newPage({ viewport: { width: 780, height: 900 }, deviceScaleFactor: 2 });
  page.on('pageerror', error => errors.push(error.message));
  await page.goto(pathToFileURL(path.resolve('artifacts/modern-fonts/rendered.html')).href);
  const frame = page.frameLocator('iframe');
  const root = frame.locator('#ckretguard-modern-fonts');
  await expect(root).toBeVisible();
  await root.evaluate(async (_, families) => {
    await Promise.all(families.map(family => document.fonts.load(`500 20px "${family}"`)));
    await document.fonts.ready;
  }, names);
  const fonts = await root.evaluate(() => [...document.fonts].map(font => ({ family: font.family, status: font.status })));
  for (const name of names) expect(fonts.some(font => font.family === name && font.status === 'loaded')).toBe(true);
  const next = frame.getByRole('button', { name: /next/i }).first();
  for (const name of names) {
    const variant = frame.locator(`[data-variant="${name}"]`);
    await expect(variant).toBeVisible();
    const family = await variant.locator('.cg-window').evaluate(el => getComputedStyle(el).fontFamily);
    expect(family).toContain(name);
    for (const width of [780, 410, 320]) {
      await page.setViewportSize({ width, height: 900 });
      const overflow = await root.evaluate(() => document.documentElement.scrollWidth > innerWidth);
      expect(overflow).toBe(false);
      const clipped = await variant.locator('.cg-window').evaluate(window => {
        const r = window.getBoundingClientRect();
        return [...window.querySelectorAll('.cg-brand,.cg-subtitle,.cg-tagline,dt,dd,.cg-caption')].some(el => {
          const b = el.getBoundingClientRect();
          return b.left < r.left || b.right > r.right || el.scrollWidth > el.clientWidth + 1;
        });
      });
      expect(clipped).toBe(false);
      if (width === 780 || name === 'Manrope') {
        await root.screenshot({ path: `artifacts/modern-fonts/${name.toLowerCase().replaceAll(' ', '-')}-${width}.png` });
      }
      snapshots.push({ name, width, family, overflow, clipped });
    }
    await page.setViewportSize({ width: 780, height: 900 });
    if (name !== names.at(-1)) await next.click();
  }
  expect(errors).toEqual([]);
  await writeFile('artifacts/modern-fonts/checks.json', JSON.stringify({ fonts, snapshots, errors }, null, 2));
  console.log(JSON.stringify({ fonts, layoutsChecked: snapshots.length, carousel: true, errors }));
} finally {
  await browser.close();
}
