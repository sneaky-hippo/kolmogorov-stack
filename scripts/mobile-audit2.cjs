#!/usr/bin/env node
// Mobile UX audit harness — captures screenshots + DOM diagnostics for 5 key pages
// at 3 viewports. Loads from http://localhost:8765 so absolute /styles.css paths resolve.
const puppeteer = require('puppeteer');
const path = require('path');
const fs = require('fs');

const BASE = process.env.BASE || 'http://localhost:8765';
const OUTDIR = path.join(__dirname, '..', 'tmp-mobile-audit');

const PAGES = [
  { name: 'index', file: 'index.html' },
  { name: 'pricing', file: 'pricing.html' },
  { name: 'quickstart', file: 'quickstart.html' },
  { name: 'docs', file: 'docs.html' },
  { name: 'spec', file: 'spec.html' },
];

const VIEWPORTS = [
  { name: 'iphone14pro', width: 390, height: 844, dpr: 2 },
  { name: 'galaxys22',    width: 360, height: 780, dpr: 2 },
  { name: 'ipad',         width: 768, height: 1024, dpr: 2 },
];

async function run() {
  if (!fs.existsSync(OUTDIR)) fs.mkdirSync(OUTDIR, { recursive: true });
  const browser = await puppeteer.launch({
    headless: 'new',
    args: ['--no-sandbox','--disable-setuid-sandbox','--disable-dev-shm-usage'],
  });

  const report = {};

  for (const pg of PAGES) {
    report[pg.name] = {};
    const fileUrl = `${BASE}/${pg.file}`;
    for (const vp of VIEWPORTS) {
      const page = await browser.newPage();
      await page.setViewport({ width: vp.width, height: vp.height, deviceScaleFactor: vp.dpr });
      try {
        await page.goto(fileUrl, { waitUntil: 'networkidle2', timeout: 30000 });
      } catch (e) {
        report[pg.name][vp.name] = { error: e.message };
        await page.close();
        continue;
      }
      await new Promise(r => setTimeout(r, 600));

      const diag = await page.evaluate((vpWidth) => {
        const out = {
          docWidth: document.documentElement.scrollWidth,
          docHeight: document.documentElement.scrollHeight,
          innerWidth: window.innerWidth,
          bodyOverflowX: getComputedStyle(document.body).overflowX,
          horizOverflow: document.documentElement.scrollWidth > window.innerWidth + 1,
          smallTapTargets: [],
          smallFonts: [],
          formInputsSmall: [],
          overflowingElements: [],
        };

        // Tap target check: interactive elements visible in header/footer or buttons
        const tappable = document.querySelectorAll('a, button, [role="button"], input[type="button"], input[type="submit"], .btn, .chip, .pill, .nav-link, .footer-link, .ts-cell, .ac-link');
        tappable.forEach(el => {
          const r = el.getBoundingClientRect();
          if (r.width === 0 || r.height === 0) return;
          const cs = window.getComputedStyle(el);
          if (cs.display === 'none' || cs.visibility === 'hidden') return;
          // Only flag tap targets that are likely primary navigation/actions on mobile
          // (skip tiny inline links inside body copy)
          if (r.height < 36) {
            const t = (el.textContent || '').trim().slice(0, 40);
            out.smallTapTargets.push({ tag: el.tagName, cls: (el.className || '').toString().slice(0,80), text: t, h: Math.round(r.height), w: Math.round(r.width) });
          }
        });

        const textEls = document.querySelectorAll('p, li, td, th, span, dd, dt, small, .muted, .meta, .caption');
        const fontHits = new Map();
        textEls.forEach(el => {
          const cs = window.getComputedStyle(el);
          const fs = parseFloat(cs.fontSize);
          if (fs && fs < 12) {
            const txt = (el.textContent || '').trim().slice(0, 30);
            if (!txt) return;
            const key = el.tagName + '|' + ((el.className || '').toString().slice(0,40)) + '|' + fs;
            if (!fontHits.has(key)) {
              fontHits.set(key, { tag: el.tagName, cls: (el.className||'').toString().slice(0,60), fs: fs.toFixed(1), sample: txt });
            }
          }
        });
        out.smallFonts = Array.from(fontHits.values()).slice(0, 30);

        const inputs = document.querySelectorAll('input, textarea, select');
        inputs.forEach(el => {
          const cs = window.getComputedStyle(el);
          const fs = parseFloat(cs.fontSize);
          if (fs && fs < 16) {
            out.formInputsSmall.push({ type: el.type || el.tagName, id: el.id || '', fs: fs.toFixed(1), name: el.name || '' });
          }
        });

        const all = document.querySelectorAll('body *');
        const seen = new Set();
        all.forEach(el => {
          const r = el.getBoundingClientRect();
          if (r.right > vpWidth + 2 && r.left >= -2) {
            const cs = window.getComputedStyle(el);
            if (cs.position === 'fixed' || cs.position === 'absolute') return;
            if (el.tagName === 'HTML' || el.tagName === 'BODY') return;
            const sig = el.tagName + '|' + (el.className || '').toString().slice(0,40) + '|' + Math.round(r.right);
            if (seen.has(sig)) return;
            seen.add(sig);
            out.overflowingElements.push({
              tag: el.tagName,
              cls: (el.className||'').toString().slice(0,80),
              id: el.id || '',
              w: Math.round(r.width),
              right: Math.round(r.right),
            });
          }
        });
        out.overflowingElements = out.overflowingElements.slice(0, 25);

        return out;
      }, vp.width);

      report[pg.name][vp.name] = diag;

      const outFile = path.join(OUTDIR, `${pg.name}-${vp.name}.png`);
      try {
        await page.screenshot({ path: outFile, fullPage: false });
      } catch (e) {}
      await page.close();
    }
  }

  await browser.close();
  fs.writeFileSync(path.join(OUTDIR, 'report.json'), JSON.stringify(report, null, 2));
  for (const pg of PAGES) {
    for (const vp of VIEWPORTS) {
      const r = report[pg.name][vp.name];
      if (!r) continue;
      if (r.error) { console.log(`${pg.name} ${vp.name}: ERROR ${r.error}`); continue; }
      console.log(`${pg.name} ${vp.name}: docW=${r.docWidth} innerW=${r.innerWidth} bodyOvX=${r.bodyOverflowX} overflow=${r.horizOverflow} smallTaps=${r.smallTapTargets.length} smallFonts=${r.smallFonts.length} smallInputs=${r.formInputsSmall.length} overflowEls=${r.overflowingElements.length}`);
    }
  }
}

run().catch(e => { console.error(e); process.exit(1); });
