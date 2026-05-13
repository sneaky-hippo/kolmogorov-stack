// Full-page mobile screenshots at 390x844 (iPhone 14 Pro) for v7.15 audit.
import { chromium } from 'playwright';
import { mkdir } from 'node:fs/promises';
const OUT = 'tmp/sshots-v7.15';
await mkdir(OUT, { recursive: true });
const BASE = process.env.URL || 'https://kolm.ai';
const PAGES = ['/', '/quickstart', '/pricing', '/docs', '/spec', '/security', '/api', '/cookbook', '/use-cases', '/anatomy', '/k-score', '/build-your-own'];
const browser = await chromium.launch();
for (const path of PAGES) {
  const ctx = await browser.newContext({
    viewport: { width: 390, height: 844 },
    deviceScaleFactor: 2,
    userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 16_0 like Mac OS X) AppleWebKit/605.1.15',
    colorScheme: 'dark'
  });
  const page = await ctx.newPage();
  try {
    await page.goto(BASE + path, { waitUntil: 'networkidle', timeout: 25000 });
    await page.waitForTimeout(600);
    const file = `${OUT}/mobile-dark${path.replace(/\//g, '-') || '-home'}.png`;
    await page.screenshot({ path: file, fullPage: true });
    console.log('mobile-dark', path);
  } catch (e) {
    console.log('err', path, e.message);
  }
  await ctx.close();
}
await browser.close();
console.log('done');
