import { chromium, expect } from '@playwright/test';
import { createHash } from 'node:crypto';
import { writeFile } from 'node:fs/promises';
import path from 'node:path';

const extension = path.resolve('dist');
const extensionId = [...createHash('sha256').update(extension).digest().subarray(0, 16)]
  .map(byte => String.fromCharCode(97 + (byte >> 4), 97 + (byte & 15))).join('');
const context = await chromium.launchPersistentContext('', {
  channel: 'chromium', headless: true, reducedMotion: 'reduce',
  args: [`--disable-extensions-except=${extension}`, `--load-extension=${extension}`],
});
const results = [];
const fontFailures = [];
context.on('request', request => { if (request.resourceType() === 'font') console.log('Font request:', request.url()); });
context.on('requestfailed', request => {
  if (request.url().includes('dm-sans')) fontFailures.push({ url: request.url(), error: request.failure() });
});

async function renderedFont(page, attribute, value) {
  const client = await context.newCDPSession(page);
  try {
    await client.send('DOM.enable');
    await client.send('CSS.enable');
    const { root } = await client.send('DOM.getDocument', { depth: -1, pierce: true });
    function find(node) {
      const attrs = node.attributes ?? [];
      for (let index = 0; index < attrs.length; index += 2) {
        if (attrs[index] === attribute && attrs[index + 1] === value) return node;
      }
      for (const child of [...(node.children ?? []), ...(node.shadowRoots ?? [])]) {
        const found = find(child);
        if (found) return found;
      }
    }
    const node = find(root);
    expect(node, `Rendered node ${attribute}=${value}`).toBeTruthy();
    const { fonts } = await client.send('CSS.getPlatformFontsForNode', { nodeId: node.nodeId });
    expect(fonts.some(font => font.familyName.startsWith('DM Sans') && font.isCustomFont && font.glyphCount > 0), JSON.stringify({ attribute, value, fonts })).toBe(true);
    return fonts;
  } finally {
    await client.detach();
  }
}

try {
  await context.route(/^https:\/\/(?:chatgpt\.com|claude\.ai)\//, route => route.fulfill({
    contentType: 'text/html',
    headers: { 'Content-Security-Policy': "default-src 'self'; style-src 'self'; font-src 'self'; script-src 'unsafe-inline'" },
    body: '<!doctype html><html><body><form><textarea id="prompt-textarea" data-testid="chat-input" class="tiptap" contenteditable="true"></textarea><button type="submit" data-testid="send-button" aria-label="Send message">Send</button></form><script>document.querySelector("form").addEventListener("submit",event=>event.preventDefault());</script></body></html>',
  }));
  const composer = await context.newPage();
  await composer.goto(`chrome-extension://${extensionId}/composer.html`);
  await expect(composer.locator('#mask')).toBeEnabled();
  await composer.evaluate(() => document.fonts.ready);
  await composer.locator('#draft').fill('Synthetic credentials only: api_key=fictional-example-123');
  await composer.locator('details').evaluate(details => { details.open = true; });
  for (const selector of ['h1', '.intro h2', '.stats dt', '.stats dd', '#draft', '#mask', '#result', 'summary', '#mode', 'footer']) {
    const family = await composer.locator(selector).first().evaluate(element => getComputedStyle(element).fontFamily);
    expect(family, selector).toContain('CkretGuard DM Sans');
  }
  const composerFonts = await renderedFont(composer, 'id', 'mask');
  for (const width of [410, 661, 780]) {
    await composer.setViewportSize({ width, height: 1100 });
    const overflow = await composer.evaluate(() => document.documentElement.scrollWidth > innerWidth);
    expect(overflow).toBe(false);
    const clipped = await composer.locator('main').evaluate(main => [...main.querySelectorAll('h1,h2,.stats dt,.stats dd,button,.section-label')]
      .some(element => element.scrollWidth > element.clientWidth + 1));
    expect(clipped).toBe(false);
    await composer.screenshot({ path: `artifacts/modern-fonts/composer-dm-sans-${width}.png`, fullPage: true });
    results.push({ surface: 'composer', width, overflow, clipped, fonts: composerFonts });
  }
  for (const host of ['chatgpt.com', 'claude.ai']) {
    const page = await context.newPage();
    page.on('console', message => { if (message.type() === 'error') console.log(message.text()); });
    await page.goto(`https://${host}/ckretguard-font-check`);
    await expect.poll(async () => composer.evaluate(async () => {
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
      return (await chrome.tabs.sendMessage(tab.id, { type: 'coverage' })).ready;
    })).toBe(true);
    await page.locator('textarea').fill('api_key=synthetic-font-check-123');
    await page.locator('textarea').press('Enter');
    const review = page.getByRole('dialog', { name: '1 secret detected' });
    await expect(review).toBeVisible();
    await page.evaluate(() => document.fonts.ready);
    console.log(await review.evaluate(element => ({ family: getComputedStyle(element).fontFamily, fonts: [...document.fonts].map(font => ({ family: font.family, status: font.status })) })), fontFailures);
    const headingFonts = await renderedFont(page, 'id', 'ckretguard-review-title');
    const buttonFonts = await renderedFont(page, 'class', 'send');
    for (const width of [410, 780]) {
      await page.setViewportSize({ width, height: 900 });
      await expect(review.locator('.actions')).toHaveCSS('margin-top', '28px');
      for (const name of ['Send', 'Edit', 'Mask']) {
        const button = review.getByRole('button', { name, exact: true });
        await expect(button).toHaveCSS('height', '34px');
        const family = await button.evaluate(element => getComputedStyle(element).fontFamily);
        expect(family).toContain('CkretGuard DM Sans');
      }
      const overflow = await review.evaluate(dialog => dialog.scrollWidth > dialog.clientWidth + 1);
      expect(overflow).toBe(false);
      await page.screenshot({ path: `artifacts/modern-fonts/${host}-dm-sans-${width}.png` });
      results.push({ surface: host, width, overflow, headingFonts, buttonFonts });
    }
    await page.locator('[data-testid="send-button"]').evaluate(button => { button.disabled = true; });
    await review.getByRole('button', { name: 'Send', exact: true }).click();
    await expect(page.locator('#secret-shield-notice')).toBeVisible();
    await page.evaluate(() => document.fonts.ready);
    const noticeFonts = await renderedFont(page, 'role', 'status');
    await page.screenshot({ path: `artifacts/modern-fonts/${host}-notice-dm-sans.png` });
    results.push({ surface: `${host} notice`, fonts: noticeFonts });
    await page.close();
  }
  expect(fontFailures).toEqual([]);
  await writeFile('artifacts/modern-fonts/extension-checks.json', JSON.stringify({ results, fontFailures }, null, 2));
  console.log(JSON.stringify({ checked: results.length, actualFont: 'DM Sans', strictPageCSP: true, fontFailures }));
} finally {
  await context.close();
}
