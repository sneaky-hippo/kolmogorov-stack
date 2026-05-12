import { chromium } from 'playwright';
const b = await chromium.launch();

const pages = [
  { name: 'home', path: '/' },
  { name: 'pricing', path: '/pricing' },
  { name: 'use-cases', path: '/use-cases' },
  { name: 'docs', path: '/docs' },
  { name: 'signup', path: '/signup' },
  { name: 'signin', path: '/signin' },
  { name: 'enterprise', path: '/enterprise' },
  { name: 'healthcare', path: '/healthcare' },
  { name: 'manifesto', path: '/manifesto' },
  { name: 'spec', path: '/spec' },
];

const viewports = [
  { name: 'desktop', w: 1440, h: 900 },
  { name: 'mobile', w: 414, h: 896 },
];

const results = [];
for (const v of viewports) {
  for (const p of pages) {
    const ctx = await b.newContext({ viewport: { width: v.w, height: v.h } });
    const page = await ctx.newPage();
    const errors = [];
    page.on('pageerror', e => errors.push('js:' + e.message.slice(0, 80)));
    page.on('requestfailed', r => {
      const u = r.url();
      if (u.startsWith('http://localhost:8787') && !u.includes('favicon')) {
        errors.push('net:' + r.method() + ' ' + u.replace('http://localhost:8787', '') + ' ' + r.failure()?.errorText);
      }
    });
    page.on('response', r => {
      const u = r.url();
      if (u.startsWith('http://localhost:8787') && r.status() >= 400 && !u.includes('favicon')) {
        errors.push('http:' + r.status() + ' ' + u.replace('http://localhost:8787', ''));
      }
    });
    try {
      await page.goto('http://localhost:8787' + p.path, { waitUntil: 'domcontentloaded', timeout: 15000 });
      await page.waitForTimeout(600);
      const data = await page.evaluate(() => {
        const header = document.querySelector('header.site-header, header.site');
        const headerRect = header?.getBoundingClientRect();
        const main = document.querySelector('main');
        const mainRect = main?.getBoundingClientRect();
        const h1s = document.querySelectorAll('h1');
        const overflowing = [];
        document.querySelectorAll('section, main, article').forEach(el => {
          if (el.scrollWidth > el.clientWidth + 2) {
            overflowing.push(el.tagName + '.' + (el.className || '').split(' ').slice(0, 2).join('.'));
          }
        });
        const nestedAnchors = [];
        document.querySelectorAll('a a').forEach(a => {
          nestedAnchors.push(a.outerHTML.slice(0, 80));
        });
        const bodyW = document.documentElement.scrollWidth;
        const viewW = document.documentElement.clientWidth;
        return {
          headerH: headerRect ? Math.round(headerRect.height) : null,
          mainY: mainRect ? Math.round(mainRect.top) : null,
          h1Count: h1s.length,
          h1Text: h1s[0]?.textContent?.slice(0, 60).trim() || null,
          bodyOverflow: bodyW > viewW + 2 ? `${bodyW}>${viewW}` : 'ok',
          overflowingSections: overflowing.slice(0, 3),
          nestedAnchors: nestedAnchors.slice(0, 3),
        };
      });
      results.push({ viewport: v.name, page: p.name, ...data, errors: errors.slice(0, 3) });
    } catch (e) {
      results.push({ viewport: v.name, page: p.name, error: e.message.slice(0, 80) });
    }
    await ctx.close();
  }
}
await b.close();
console.log(JSON.stringify(results, null, 2));
