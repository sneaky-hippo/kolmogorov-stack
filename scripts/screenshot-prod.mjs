#!/usr/bin/env node
// Screenshot QA harness — kolm.ai surfaces across viewport + theme.
// Usage: node scripts/screenshot-prod.mjs [--url=https://kolm.ai] [--out=tmp-screenshots] [--routes=/,/use-cases,/docs]
import { chromium } from 'playwright';
import { mkdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';

const argv = Object.fromEntries(process.argv.slice(2).map((a) => {
  const m = a.match(/^--([^=]+)=(.*)$/); return m ? [m[1], m[2]] : [a.replace(/^--/, ''), true];
}));

const BASE = argv.url || process.env.URL || 'https://kolm.ai';
const OUT = argv.out || 'tmp-screenshots';
const STAMP = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
const OUT_DIR = join(OUT, `${STAMP}-${BASE.replace(/[^a-z0-9]/gi, '_')}`);

const ROUTES = (argv.routes || [
  '/index.html',
  '/use-cases',
  '/docs',
  '/research',
  '/enterprise',
  '/pricing',
  '/quickstart',
  '/train',
  '/distill',
  '/frontier-stack',
  '/k-score',
  '/spec',
  '/security',
  '/case-studies',
  '/agents',
  '/signup',
  '/healthcare',
  '/finance',
  '/legal',
  '/defense',
  '/r/00000000',
].join(',')).split(',').filter(Boolean);

const VIEWPORTS = [
  { name: 'desktop', w: 1440, h: 900 },
  { name: 'mobile', w: 390, h: 844 },
];
const THEMES = ['dark', 'light'];

async function main() {
  await mkdir(OUT_DIR, { recursive: true });
  const browser = await chromium.launch({ headless: true });
  let pass = 0; let fail = 0; const failures = [];

  for (const vp of VIEWPORTS) {
    for (const theme of THEMES) {
      const ctx = await browser.newContext({
        viewport: { width: vp.w, height: vp.h },
        colorScheme: theme,
        userAgent: 'Mozilla/5.0 kolm-screenshot-qa/1.0',
      });
      const page = await ctx.newPage();
      for (const route of ROUTES) {
        const isRoot = route === '/' || route === '/index.html';
        const url = isRoot ? `${BASE}/` : `${BASE}${route}`;
        const slug = isRoot ? 'home' : route.replace(/[^a-z0-9]/gi, '_').replace(/^_+|_+$/g, '');
        const file = join(OUT_DIR, `${vp.name}-${theme}-${slug}.png`);
        try {
          const res = await page.goto(url, { waitUntil: 'networkidle', timeout: 20000 });
          const status = res ? res.status() : 0;
          if (theme === 'light') {
            await page.evaluate(() => document.documentElement.setAttribute('data-theme', 'light'));
            await page.waitForTimeout(100);
          }
          await page.screenshot({ path: file, fullPage: true });
          if (status >= 200 && status < 400) {
            pass++;
            process.stdout.write(`  PASS  ${vp.name}-${theme}  ${route}  [${status}]\n`);
          } else {
            fail++;
            failures.push(`${vp.name}-${theme}  ${route}  [${status}]`);
            process.stdout.write(`  FAIL  ${vp.name}-${theme}  ${route}  [${status}]\n`);
          }
        } catch (e) {
          fail++;
          failures.push(`${vp.name}-${theme}  ${route}  ${e.message}`);
          process.stdout.write(`  FAIL  ${vp.name}-${theme}  ${route}  ${e.message.slice(0, 80)}\n`);
        }
      }
      await ctx.close();
    }
  }

  await browser.close();
  console.log(`\n  Output: ${OUT_DIR}`);
  console.log(`  ${pass} pass, ${fail} fail`);
  if (failures.length) {
    console.log(`\n  Failures:`);
    failures.forEach((f) => console.log(`    ${f}`));
    process.exit(1);
  }
}

main().catch((e) => { console.error(e); process.exit(2); });
