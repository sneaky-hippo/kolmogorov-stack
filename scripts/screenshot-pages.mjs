#!/usr/bin/env node
// Screenshot key pages for visual audit.
import { chromium } from '@playwright/test';
import path from 'node:path';
import fs from 'node:fs';

const BASE = process.env.URL || 'https://kolm.ai';
const OUT = process.env.OUT || path.resolve('_audit/screens');
fs.mkdirSync(OUT, { recursive: true });

const PAGES = [
  { slug: 'home',        url: '/' },
  { slug: 'pricing',     url: '/pricing' },
  { slug: 'docs',        url: '/docs' },
  { slug: 'quickstart',  url: '/quickstart' },
  { slug: 'api',         url: '/api' },
  { slug: 'spec',        url: '/spec' },
  { slug: 'healthcare',  url: '/healthcare' },
  { slug: 'finance',     url: '/finance' },
  { slug: 'enterprise',  url: '/enterprise' },
  { slug: 'manifesto',   url: '/manifesto' },
  { slug: 'compile',     url: '/compile' },
  { slug: 'run',         url: '/run' },
  { slug: 'evolve',      url: '/evolve' },
  { slug: 'leaderboard', url: '/leaderboard' },
  { slug: 'changelog',   url: '/changelog' },
  { slug: 'faq',         url: '/faq' },
  { slug: 'signup',      url: '/signup' },
  { slug: 'cookbook',    url: '/cookbook' },
];

const browser = await chromium.launch();
const ctx     = await browser.newContext({ viewport: { width: 1440, height: 900 } });

for (const p of PAGES) {
  const page = await ctx.newPage();
  const url  = BASE + p.url;
  try {
    await page.goto(url, { waitUntil: 'networkidle', timeout: 30000 });
    await page.screenshot({ path: path.join(OUT, `${p.slug}-dark.png`),  fullPage: false });
    await page.evaluate(() => {
      document.documentElement.setAttribute('data-theme', 'light');
      try { localStorage.setItem('kolm-theme', 'light'); } catch (e) {}
    });
    await page.waitForTimeout(600);
    await page.screenshot({ path: path.join(OUT, `${p.slug}-light.png`), fullPage: false });
    console.log(`ok    ${p.slug}`);
  } catch (e) {
    console.log(`fail  ${p.slug}  ${e.message}`);
  } finally {
    await page.close();
  }
}

await browser.close();
console.log('done. screens in', OUT);
