import { chromium } from 'playwright';
const b = await chromium.launch();
const views = [
  { name: 'desktop', w: 1440, h: 900 },
  { name: 'tablet', w: 860, h: 1180 },
  { name: 'mobile', w: 414, h: 896 },
];
for (const v of views) {
  const ctx = await b.newContext({ viewport: { width: v.w, height: v.h } });
  const page = await ctx.newPage();
  await page.goto('http://localhost:8787/', { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(400);
  const data = await page.evaluate(() => {
    const grid = document.querySelector('.uc-strip .uc-grid');
    const cards = Array.from(grid?.querySelectorAll('.uc-card') || []);
    const covers = document.querySelector('.uc-covers');
    const cs = grid ? getComputedStyle(grid) : null;
    return {
      cardCount: cards.length,
      gridCols: cs?.gridTemplateColumns,
      cardHeights: cards.map(c => c.getBoundingClientRect().height),
      coversText: covers?.textContent?.trim(),
      coversLinks: covers ? covers.querySelectorAll('a').length : 0,
      brokenNestedAnchors: document.querySelectorAll('.uc-card a').length,
    };
  });
  const bbox = await page.locator('.uc-strip').boundingBox();
  await page.locator('.uc-strip').screenshot({ path: `scripts/qa-uc-${v.name}.png` });
  console.log(`${v.name} ${v.w}x${v.h}:`, JSON.stringify({ ...data, sectionBox: bbox }, null, 2));
  await ctx.close();
}
await b.close();
