const puppeteer = require('puppeteer');
const path = require('path');
const fs = require('fs');
const OUT = path.join(__dirname,'..','tmp-mobile-audit');

const SHOTS = [
  { name: 'spec-roadmap-table', url: 'http://localhost:8765/spec.html', scrollTo: 'h2:nth-of-type(1)', vp:{w:390,h:844}, after:600 },
  { name: 'pricing-matrix', url: 'http://localhost:8765/pricing.html', scrollTo: '.matrix', vp:{w:390,h:844}, after:600 },
  { name: 'pricing-vs-tbl', url: 'http://localhost:8765/pricing.html', scrollTo: '.vs-tbl', vp:{w:390,h:844}, after:600 },
  { name: 'index-footer', url: 'http://localhost:8765/index.html', scrollTo: 'footer', vp:{w:390,h:844}, after:600 },
  { name: 'docs-footer', url: 'http://localhost:8765/docs.html', scrollTo: 'footer', vp:{w:390,h:844}, after:600 },
  { name: 'index-roi-calc', url: 'http://localhost:8765/index.html', scrollTo: '.vr-calc', vp:{w:390,h:844}, after:600 },
  { name: 'docs-rail', url: 'http://localhost:8765/docs.html', scrollTo: 'body', vp:{w:390,h:844}, after:600 },
];

(async()=>{
  const browser = await puppeteer.launch({headless:'new',args:['--no-sandbox']});
  for (const s of SHOTS) {
    const page = await browser.newPage();
    await page.setViewport({width:s.vp.w,height:s.vp.h,deviceScaleFactor:2});
    await page.goto(s.url,{waitUntil:'networkidle2',timeout:30000});
    await new Promise(r => setTimeout(r, s.after));
    await page.evaluate((sel)=>{
      const el = document.querySelector(sel);
      if (el) el.scrollIntoView({block:'start'});
    }, s.scrollTo);
    await new Promise(r => setTimeout(r, 400));
    const out = path.join(OUT, `verify-${s.name}.png`);
    await page.screenshot({path: out, fullPage:false});
    console.log(out);
    await page.close();
  }
  await browser.close();
})();
