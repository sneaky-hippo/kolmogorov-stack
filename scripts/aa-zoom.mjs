// Zoom in on access-anywhere section across viewports.
import { chromium } from 'playwright';
import { mkdir } from 'node:fs/promises';
const BASE = process.env.URL || 'https://kolm.ai';
const OUT = 'tmp/sshots-aa';
await mkdir(OUT, { recursive: true });
const browser = await chromium.launch();

async function zoom(viewport, theme, name) {
  const ctx = await browser.newContext({ viewport, deviceScaleFactor: 2, colorScheme: theme });
  const page = await ctx.newPage();
  await page.goto(BASE + '/', { waitUntil: 'networkidle', timeout: 30000 });
  await page.waitForTimeout(700);
  const aa = await page.$('.access-anywhere');
  if (aa) {
    await aa.scrollIntoViewIfNeeded();
    await page.waitForTimeout(300);
    const box = await aa.boundingBox();
    if (box) {
      const pageScrollY = await page.evaluate(() => window.scrollY);
      await page.screenshot({
        path: `${OUT}/aa-${name}.png`,
        clip: { x: 0, y: box.y, width: viewport.width, height: Math.min(box.height + 40, 2200) }
      });
      console.log(`aa ${name}: y=${Math.round(box.y)} h=${Math.round(box.height)}`);
    }
  }
  await ctx.close();
}

await zoom({ width: 390, height: 844 }, 'dark', 'mobile-390-dark');
await zoom({ width: 390, height: 844 }, 'light', 'mobile-390-light');
await zoom({ width: 1440, height: 900 }, 'dark', 'desktop-1440-dark');
await zoom({ width: 820, height: 1180 }, 'dark', 'tablet-820-dark');

await browser.close();
console.log('done');
