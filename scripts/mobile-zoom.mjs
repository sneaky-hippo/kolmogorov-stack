// Zoomed mobile screenshots of specific sections for v7.15 surgical fix.
import { chromium } from 'playwright';
import { mkdir } from 'node:fs/promises';
const OUT = 'tmp/sshots-v7.15';
await mkdir(OUT, { recursive: true });
const BASE = process.env.URL || 'https://kolm.ai';
const browser = await chromium.launch();
const ctx = await browser.newContext({
  viewport: { width: 390, height: 844 },
  deviceScaleFactor: 2,
  userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 16_0 like Mac OS X) AppleWebKit/605.1.15',
  colorScheme: 'dark'
});
const page = await ctx.newPage();
await page.goto(BASE + '/', { waitUntil: 'networkidle', timeout: 25000 });
await page.waitForTimeout(600);

// 1. Hero + demo + proof
await page.evaluate(() => window.scrollTo(0, 0));
await page.waitForTimeout(300);
await page.screenshot({ path: `${OUT}/zoom-1-hero.png` });

// 2. Scroll to demo + proof area
const demoEl = await page.$('.demo-anchor');
if (demoEl) {
  await demoEl.scrollIntoViewIfNeeded();
  await page.waitForTimeout(300);
  await page.screenshot({ path: `${OUT}/zoom-2-demo-proof.png` });
}

// 3. uc-strip tabs visibility
const ucEl = await page.$('.uc-strip');
if (ucEl) {
  await ucEl.scrollIntoViewIfNeeded();
  await page.waitForTimeout(300);
  await page.screenshot({ path: `${OUT}/zoom-3-uc-strip.png` });
}

// 4. between after-compile and uc-strip (the big gap)
await page.evaluate(() => {
  const ac = document.querySelector('.after-compile');
  if (ac) {
    const rect = ac.getBoundingClientRect();
    window.scrollTo(0, window.scrollY + rect.bottom - 400);
  }
});
await page.waitForTimeout(300);
await page.screenshot({ path: `${OUT}/zoom-4-after-compile-to-uc.png` });

// 5. Footer
const footEl = await page.$('footer.site-footer');
if (footEl) {
  await footEl.scrollIntoViewIfNeeded();
  await page.waitForTimeout(300);
  await page.screenshot({ path: `${OUT}/zoom-5-footer.png` });
}

// Probe specific elements
const measurements = await page.evaluate(() => {
  function probe(sel) {
    const el = document.querySelector(sel);
    if (!el) return null;
    const cs = getComputedStyle(el);
    const rect = el.getBoundingClientRect();
    return {
      selector: sel,
      width: rect.width,
      height: rect.height,
      top: rect.top + window.scrollY,
      marginTop: cs.marginTop,
      marginBottom: cs.marginBottom,
      paddingTop: cs.paddingTop,
      paddingBottom: cs.paddingBottom,
      display: cs.display,
      overflow: cs.overflow
    };
  }
  return {
    hero: probe('.home-hero-centered'),
    demoAnchor: probe('.demo-anchor'),
    heroProof: probe('.hero-proof'),
    anatomy: probe('.compile-anatomy'),
    vrCalc: probe('.vr-calc-only'),
    afterCompile: probe('.after-compile'),
    afterCompileLast: probe('.after-compile .ac-card:last-child'),
    ucStrip: probe('.uc-strip'),
    ucTabs: probe('.uc-tabs'),
    ucHeadH2: probe('.uc-strip h2'),
    homeFaq: probe('.home-faq'),
    bottomCta: probe('.bottom-cta'),
    footer: probe('footer.site-footer'),
    viewportWidth: window.innerWidth
  };
});
console.log(JSON.stringify(measurements, null, 2));

await browser.close();
