#!/usr/bin/env node
// Targeted screenshots — capture specific selectors on a page at desktop + mobile.
// Usage: node scripts/screenshot-section.mjs --url=https://kolm.ai --selectors=.hero,.frontier-strip,.compile-anatomy
import { chromium } from 'playwright';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';

const argv = Object.fromEntries(process.argv.slice(2).map((a) => {
  const m = a.match(/^--([^=]+)=(.*)$/); return m ? [m[1], m[2]] : [a.replace(/^--/, ''), true];
}));

const URL_ = argv.url || process.env.URL || 'https://kolm.ai/';
const OUT = argv.out || 'tmp-screenshots';
const SELECTORS = (argv.selectors || '.hero,.provider-strip,.frontier-strip,.scenes,.compile-anatomy').split(',');
const STAMP = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
const OUT_DIR = join(OUT, `${STAMP}-sections`);

const VIEWPORTS = [
  { name: 'desktop', w: 1440, h: 900 },
  { name: 'mobile',  w: 390,  h: 844 },
];

async function main() {
  await mkdir(OUT_DIR, { recursive: true });
  const browser = await chromium.launch({ headless: true });
  for (const vp of VIEWPORTS) {
    const ctx = await browser.newContext({ viewport: { width: vp.w, height: vp.h }, colorScheme: 'dark' });
    const page = await ctx.newPage();
    await page.goto(URL_, { waitUntil: 'networkidle' });
    for (const sel of SELECTORS) {
      const slug = sel.replace(/[^a-z0-9]/gi, '_').replace(/^_+|_+$/g, '');
      const file = join(OUT_DIR, `${vp.name}-${slug}.png`);
      try {
        const el = await page.$(sel);
        if (!el) { console.log(`  SKIP  ${vp.name}  ${sel}  (not found)`); continue; }
        await el.screenshot({ path: file });
        console.log(`  SHOT  ${vp.name}  ${sel}  → ${file}`);
      } catch (e) {
        console.log(`  FAIL  ${vp.name}  ${sel}  ${e.message.slice(0, 80)}`);
      }
    }
    await ctx.close();
  }
  await browser.close();
  console.log(`\n  Output: ${OUT_DIR}`);
}

main().catch((e) => { console.error(e); process.exit(2); });
