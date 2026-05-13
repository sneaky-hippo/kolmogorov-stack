// Full-page screenshot of kolm.ai homepage for visual review of below-the-fold sections.
import { chromium } from 'playwright';
import { mkdir } from 'node:fs/promises';
const URL = process.env.URL || 'https://kolm.ai/';
const OUT = process.env.OUT || 'tmp/sshots-v7.13/full-page-dark.png';
await mkdir('tmp/sshots-v7.13', { recursive: true });
const browser = await chromium.launch();
const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1, colorScheme: 'dark' });
const page = await ctx.newPage();
await page.goto(URL, { waitUntil: 'networkidle' });
await page.waitForTimeout(800);
await page.screenshot({ path: OUT, fullPage: true });
await browser.close();
console.log('saved', OUT);
