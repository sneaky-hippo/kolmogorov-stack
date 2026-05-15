#!/usr/bin/env node
const puppeteer = require('puppeteer');
const path = require('path');
const fs = require('fs');

const URL = process.env.URL || 'https://kolm.ai/';
const OUTDIR = process.env.OUTDIR || path.join(__dirname, '..', 'tmp-screenshots');

const VIEWPORTS = [
  { name: 'desktop', width: 1440, height: 900, dpr: 1 },
  { name: 'mobile',  width: 390,  height: 844, dpr: 2 },
];

const SCENES = [0, 1, 2, 3, 4];

async function run() {
  if (!fs.existsSync(OUTDIR)) fs.mkdirSync(OUTDIR, { recursive: true });
  const browser = await puppeteer.launch({
    headless: 'new',
    args: ['--no-sandbox','--disable-setuid-sandbox','--disable-dev-shm-usage'],
  });
  for (const vp of VIEWPORTS) {
    const page = await browser.newPage();
    await page.setViewport({ width: vp.width, height: vp.height, deviceScaleFactor: vp.dpr });
    console.log(`[${vp.name}] navigating ${URL}`);
    await page.goto(URL, { waitUntil: 'networkidle2', timeout: 60000 });
    // Kill all rAF/timers tied to the demo loop so injected text content
    // is not immediately overwritten by tickScene re-renders.
    await page.evaluate(() => {
      window.requestAnimationFrame = function(){ return 0; };
      window.cancelAnimationFrame = function(){};
      // Clear all pending timeouts/intervals (best-effort).
      var hi = setTimeout(function(){}, 0);
      for (var i = 0; i <= hi; i++) { try { clearTimeout(i); clearInterval(i); } catch (e) {} }
    });
    await new Promise(r => setTimeout(r, 400));
    for (const s of SCENES) {
      // Force scene to its near-end state by directly applying the trigger
      // classes and final text content. Avoids RAF-throttling issues in
      // headless puppeteer where the demo's playing-state may not advance.
      await page.evaluate((sceneIndex) => {
        const scenes = document.querySelectorAll('.hcn-scene');
        scenes.forEach((el, i) => {
          el.classList.toggle('active', i === sceneIndex);
        });
        const sEl = scenes[sceneIndex];
        if (!sEl) return;
        if (sceneIndex === 0) {
          // HOOK: prompt typed, file materialized, seal stamped.
          const typed = document.getElementById('hcn-typed');
          if (typed) typed.textContent = 'extract PHI from clinical notes';
          sEl.classList.add('go');
        } else if (sceneIndex === 1) {
          // PROOF: accuracy at final 94%, shipped state, badge BEATS TARGET.
          sEl.classList.add('go');
          sEl.classList.add('shipped');
          const k = document.getElementById('hcn-proof-k');
          if (k) k.textContent = '94%';
          const ep = document.getElementById('hcn-proof-epoch');
          if (ep) ep.textContent = '25/25';
          const seen = document.getElementById('hcn-proof-seen');
          if (seen) seen.textContent = '3,200';
          const gb = document.getElementById('hcn-proof-gate-badge');
          if (gb) gb.textContent = 'beats target';
        } else if (sceneIndex === 2) {
          // PORT: all 6 devices lit.
          sEl.classList.add('go');
          sEl.querySelectorAll('.hcn-port-dev').forEach((d) => {
            d.classList.add('lit');
            const t = d.querySelector('.hcn-port-dev-tick');
            if (t) t.textContent = 'done';
          });
        } else if (sceneIndex === 3) {
          // RACE: both streams done.
          const sl = document.getElementById('hcn-stream-l');
          const sr = document.getElementById('hcn-stream-r');
          const RUN = 'User locked out after password-reset email failed to arrive. Asking for manual reset and a new MFA enrollment link. Urgency: medium.';
          if (sl) sl.textContent = RUN;
          if (sr) sr.textContent = RUN;
          const msl = document.getElementById('hcn-ms-l');
          const msr = document.getElementById('hcn-ms-r');
          if (msl) msl.textContent = '1387 ms';
          if (msr) msr.textContent = '187 ms';
          const pl = document.getElementById('hcn-pill-l');
          const pr = document.getElementById('hcn-pill-r');
          if (pl) { pl.className = 'hcn-race-pill ok'; pl.textContent = 'done'; }
          if (pr) { pr.className = 'hcn-race-pill ok'; pr.textContent = 'done'; }
        } else if (sceneIndex === 4) {
          // OUTCOME: receipt fully shown, SHIPPED stamp landed.
          sEl.classList.add('go');
          sEl.classList.add('stamped');
          sEl.querySelectorAll('.hcn-rec-row').forEach((r) => r.classList.add('show'));
          const ht = document.getElementById('hcn-hero-text');
          if (ht) ht.classList.add('show');
        }
      }, s);
      await new Promise(r => setTimeout(r, 2400));
      const stage = await page.$('.hcn-stage-wrap');
      const out = path.join(OUTDIR, `${vp.name}-scene-${s+1}.png`);
      if (stage) {
        await stage.screenshot({ path: out });
      } else {
        await page.screenshot({ path: out, fullPage: false });
      }
      console.log(`  -> ${out}`);
    }
    await page.close();
  }
  await browser.close();
  console.log('done.');
}

run().catch(e => { console.error(e); process.exit(1); });
