// v7.15 mobile verify: probe section gaps, footer height, access-anywhere render.
import { chromium } from 'playwright';
import { mkdir } from 'node:fs/promises';
const BASE = process.env.URL || 'https://kolm.ai';
const OUT = 'tmp/sshots-v7.15-verify';
await mkdir(OUT, { recursive: true });
const browser = await chromium.launch();

async function probe(viewport, theme, name) {
  const ctx = await browser.newContext({ viewport, deviceScaleFactor: 2, colorScheme: theme });
  const page = await ctx.newPage();
  await page.goto(BASE + '/', { waitUntil: 'networkidle', timeout: 30000 });
  await page.waitForTimeout(700);
  const data = await page.evaluate(() => {
    const get = (sel) => {
      const el = document.querySelector(sel);
      if (!el) return null;
      const r = el.getBoundingClientRect();
      const cs = getComputedStyle(el);
      return { y: Math.round(r.top + window.scrollY), h: Math.round(r.height), mt: cs.marginTop, pt: cs.paddingTop, pb: cs.paddingBottom };
    };
    return {
      hero: get('.home-hero-centered'),
      demo: get('.demo-anchor'),
      anatomy: get('.compile-anatomy'),
      ac: get('.after-compile'),
      aa: get('.access-anywhere'),
      uc: get('.uc-strip'),
      faq: get('.home-faq'),
      cta: get('.bottom-cta'),
      footer: get('.site-footer'),
      total: document.documentElement.scrollHeight
    };
  });
  console.log(`\n[${name}]`);
  for (const [k, v] of Object.entries(data)) {
    if (v && typeof v === 'object') {
      console.log(`  ${k.padEnd(8)}  y=${String(v.y).padStart(5)}  h=${String(v.h).padStart(4)}  mt=${v.mt} pt=${v.pt}`);
    } else if (k === 'total') {
      console.log(`  total page height: ${v}px`);
    }
  }
  const file = `${OUT}/${name}.png`;
  await page.screenshot({ path: file, fullPage: true });
  console.log(`  saved ${file}`);
  await ctx.close();
}

await probe({ width: 390, height: 844 }, 'dark', 'mobile-dark-390');
await probe({ width: 390, height: 844 }, 'light', 'mobile-light-390');
await probe({ width: 1440, height: 900 }, 'dark', 'desktop-dark-1440');
await probe({ width: 1440, height: 900 }, 'light', 'desktop-light-1440');

await browser.close();
console.log('\ndone');
