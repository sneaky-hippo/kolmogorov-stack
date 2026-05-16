#!/usr/bin/env node
// Wave 110 QA harness: snapshot every primary route at desktop+mobile,
// light+dark. Drops PNGs into tmp-screenshots/<UTC-YYYY-MM-DDTHH-MM-SS>/.
//
// Usage:
//   node scripts/qa-screenshots.mjs                     # prod (kolm.ai)
//   node scripts/qa-screenshots.mjs --base http://localhost:8787
//   node scripts/qa-screenshots.mjs --routes /,/pricing,/license
//   node scripts/qa-screenshots.mjs --quick             # smaller route set
//
// Exits 0 even if individual routes fail (logged) — never blocks deploy.

import { chromium } from 'playwright';
import fs from 'node:fs';
import path from 'node:path';

function arg(name, def = null) {
  const idx = process.argv.indexOf(`--${name}`);
  if (idx < 0) return def;
  return process.argv[idx + 1] || def;
}

const BASE = arg('base', 'https://kolm.ai');
const QUICK = process.argv.includes('--quick');
const ROUTES_RAW = arg('routes', null);

const FULL_ROUTES = [
  '/', '/pricing', '/quickstart', '/k-score', '/research/k-score-whitepaper',
  '/license', '/registry', '/leaderboard', '/docs', '/dashboard',
  '/healthcare', '/finance', '/legal', '/edge', '/defense',
  '/hub', '/playground', '/compile', '/run', '/recall',
  '/anatomy', '/spec', '/benchmarks', '/security', '/manifesto',
  '/compare/kolm-vs-openai', '/compare/kolm-vs-ollama',
  '/use-cases/health-insurance', '/use-cases/sr-11-7-finance',
  '/research', '/frontier-stack',
];
const QUICK_ROUTES = ['/', '/pricing', '/license', '/k-score', '/registry', '/quickstart'];
const ROUTES = ROUTES_RAW
  ? ROUTES_RAW.split(',').map(s => s.trim()).filter(Boolean)
  : (QUICK ? QUICK_ROUTES : FULL_ROUTES);

const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
const outDir = path.join('tmp-screenshots', stamp);
fs.mkdirSync(outDir, { recursive: true });

const MODES = [
  { name: 'desktop-light', viewport: { width: 1440, height: 900 }, colorScheme: 'light' },
  { name: 'desktop-dark',  viewport: { width: 1440, height: 900 }, colorScheme: 'dark' },
  { name: 'mobile-light',  viewport: { width: 390,  height: 844 }, colorScheme: 'light' },
  { name: 'mobile-dark',   viewport: { width: 390,  height: 844 }, colorScheme: 'dark' },
];

function slugify(route) {
  return route === '/' ? 'home' : route.replace(/^\//, '').replace(/\//g, '-');
}

console.log(`qa-screenshots: ${ROUTES.length} routes x ${MODES.length} modes = ${ROUTES.length * MODES.length} shots`);
console.log(`base:  ${BASE}`);
console.log(`out:   ${outDir}/`);
console.log('');

const browser = await chromium.launch();
let ok = 0;
let fail = 0;
const t0 = Date.now();

for (const mode of MODES) {
  const ctx = await browser.newContext({
    viewport: mode.viewport,
    colorScheme: mode.colorScheme,
    userAgent: mode.name.startsWith('mobile')
      ? 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1'
      : undefined,
  });
  const page = await ctx.newPage();
  for (const route of ROUTES) {
    const url = `${BASE}${route}`;
    const file = path.join(outDir, `${slugify(route)}__${mode.name}.png`);
    try {
      const resp = await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 15000 });
      const status = resp ? resp.status() : 0;
      if (status >= 400) { console.error(`  [${mode.name}] ${route} -> ${status}`); fail++; continue; }
      await page.waitForTimeout(600);
      await page.screenshot({ path: file, fullPage: false });
      ok++;
    } catch (e) {
      console.error(`  [${mode.name}] ${route} -> error: ${e.message}`);
      fail++;
    }
  }
  await ctx.close();
}

await browser.close();
const dt = ((Date.now() - t0) / 1000).toFixed(1);
console.log('');
console.log(`done: ${ok} ok, ${fail} fail in ${dt}s`);
console.log(`screenshots: ${outDir}/`);
process.exit(0);
