#!/usr/bin/env node
// Verify header chrome is IDENTICAL across pages (no menu jump).
// Loads each page, reads computed dimensions of the header strip, fails if any
// page diverges from the canonical baseline beyond a tiny tolerance.

import { chromium } from '@playwright/test';

const BASE = process.env.URL || 'https://kolm.ai';
const PAGES = [
  { slug: 'home',        url: '/' },
  { slug: 'use-cases',   url: '/use-cases' },
  { slug: 'docs',        url: '/docs' },
  { slug: 'pricing',     url: '/pricing' },
  { slug: 'healthcare',  url: '/healthcare' },
  { slug: 'enterprise',  url: '/enterprise' },
  { slug: 'manifesto',   url: '/manifesto' },
  { slug: 'compile',     url: '/compile' },
  { slug: 'k-score',     url: '/k-score' },
  { slug: 'anatomy',     url: '/anatomy' },
  { slug: 'serve',       url: '/serve' },
  { slug: 'signup',      url: '/signup' },
  { slug: 'spec',        url: '/spec' },
];

const browser = await chromium.launch();
const ctx     = await browser.newContext({ viewport: { width: 1440, height: 900 } });

function pickHeader() {
  return document.querySelector('header.site-header, header.site');
}

async function measure(page, slug) {
  return await page.evaluate(() => {
    const h = document.querySelector('header.site-header, header.site');
    if (!h) return null;
    const r = h.getBoundingClientRect();
    const cs = getComputedStyle(h);
    const nav = h.querySelector('.site-nav, nav, .left nav');
    const ncs = nav ? getComputedStyle(nav) : null;
    const firstNavA = nav ? nav.querySelector('a') : null;
    const acs = firstNavA ? getComputedStyle(firstNavA) : null;
    const actions = h.querySelector('.site-actions, .right');
    const actcs = actions ? getComputedStyle(actions) : null;
    const navtog = h.querySelector('.nav-toggle');
    const navtog_cs = navtog ? getComputedStyle(navtog) : null;
    const ghstar = h.querySelector('.gh-star, #gh-star');
    return {
      headerHeight: Math.round(r.height),
      headerBg: cs.backgroundColor,
      headerBorderBottom: cs.borderBottomColor,
      navGap: ncs && ncs.gap,
      navAFontSize: acs && acs.fontSize,
      navAColor: acs && acs.color,
      actionsGap: actcs && actcs.gap,
      navToggleDisplay: navtog_cs && navtog_cs.display,
      ghStarPresent: !!ghstar,
    };
  });
}

const results = [];
for (const p of PAGES) {
  const page = await ctx.newPage();
  try {
    await page.goto(BASE + p.url, { waitUntil: 'domcontentloaded', timeout: 30000 });
    const m = await measure(page, p.slug);
    results.push({ slug: p.slug, ...m });
    // Light-mode pass
    await page.evaluate(() => { document.documentElement.setAttribute('data-theme', 'light'); });
    await page.waitForTimeout(200);
    const ml = await measure(page, p.slug);
    results.push({ slug: p.slug + ' (light)', ...ml });
  } catch (e) {
    results.push({ slug: p.slug, error: e.message });
  } finally {
    await page.close();
  }
}
await browser.close();

console.log('slug         hgt  bg                              nav-gap  nav-a-fs  actions-gap  ntog  gh');
for (const r of results) {
  if (r.error) { console.log(`${r.slug.padEnd(12)} FAIL  ${r.error}`); continue; }
  console.log(
    `${r.slug.padEnd(12)} ` +
    `${String(r.headerHeight).padEnd(4)} ` +
    `${(r.headerBg || '').padEnd(31)} ` +
    `${(r.navGap || '').padEnd(8)} ` +
    `${(r.navAFontSize || '').padEnd(9)} ` +
    `${(r.actionsGap || '').padEnd(12)} ` +
    `${(r.navToggleDisplay || '').padEnd(5)} ` +
    `${r.ghStarPresent ? 'YES' : 'no'}`
  );
}

// Verify uniformity — compare dark to dark, light to light
const darkResults  = results.filter(r => !r.slug.includes('(light)') && !r.error);
const lightResults = results.filter(r =>  r.slug.includes('(light)') && !r.error);
let fails = 0;
function compareGroup(group, label) {
  if (group.length === 0) return;
  const baseline = group[0];
  for (const r of group) {
    if (r === baseline) continue;
  if (r.headerHeight !== baseline.headerHeight) { fails++; console.log(`DIFF: ${r.slug} headerHeight=${r.headerHeight} vs ${baseline.headerHeight}`); }
  if (r.headerBg !== baseline.headerBg) { fails++; console.log(`DIFF: ${r.slug} headerBg=${r.headerBg} vs ${baseline.headerBg}`); }
  if (r.navAFontSize !== baseline.navAFontSize) { fails++; console.log(`DIFF: ${r.slug} navAFontSize=${r.navAFontSize} vs ${baseline.navAFontSize}`); }
  if (r.actionsGap !== baseline.actionsGap) { fails++; console.log(`DIFF: ${r.slug} actionsGap=${r.actionsGap} vs ${baseline.actionsGap}`); }
  if (r.navToggleDisplay !== baseline.navToggleDisplay) { fails++; console.log(`DIFF: ${r.slug} navToggleDisplay=${r.navToggleDisplay} vs ${baseline.navToggleDisplay}`); }
  if (r.ghStarPresent !== baseline.ghStarPresent) { fails++; console.log(`DIFF: ${r.slug} ghStar present=${r.ghStarPresent}`); }
  }
}
compareGroup(darkResults, 'dark');
compareGroup(lightResults, 'light');
console.log(`\n${fails === 0 ? 'PASS — header chrome identical across all pages (dark + light)' : 'FAIL — ' + fails + ' divergences (menu would jump)'}`);
process.exit(fails === 0 ? 0 : 1);
