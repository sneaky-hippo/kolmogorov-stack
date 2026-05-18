// Wave 221: nav consolidation 6 → 5 (Product / Models / Docs / Pricing / Enterprise).
// Use cases collapsed under Product; Research + Training collapse under Docs.
// Tests assert BEHAVIOR (canonical block written by the idempotent injector
// script + path-active wiring in nav.js + /product page exists + vercel rewrite
// + sw.js wave-floor), not page-text markers. Single source of truth =
// scripts/inject-nav.cjs.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..');
const NAV_JS = fs.readFileSync(path.join(ROOT, 'public/nav.js'), 'utf8');
const SW = fs.readFileSync(path.join(ROOT, 'public/sw.js'), 'utf8');
const VERCEL = JSON.parse(fs.readFileSync(path.join(ROOT, 'vercel.json'), 'utf8'));
const INJECTOR = fs.readFileSync(path.join(ROOT, 'scripts/inject-nav.cjs'), 'utf8');
const PRODUCT_HTML = fs.readFileSync(path.join(ROOT, 'public/product.html'), 'utf8');

const NAV_ITEMS = ['Product', 'Models', 'Docs', 'Pricing', 'Enterprise'];
const BEGIN_MARK = '<!-- KOLM_NAV_BEGIN (W221) -->';
const END_MARK = '<!-- KOLM_NAV_END (W221) -->';

test('W221 #1 - inject-nav.cjs declares the canonical 5-item nav in order', () => {
  // The single source of truth must enumerate the 5 items in the plan-mandated
  // order. The order matters for visual scan + screen-reader announcement.
  const navItemsBlock = INJECTOR.match(/const NAV_ITEMS = \[([\s\S]*?)\];/);
  assert.ok(navItemsBlock, 'NAV_ITEMS array present in injector');
  const body = navItemsBlock[1];
  const seen = NAV_ITEMS.map(label => {
    const m = body.match(new RegExp(`label:\\s*['"]${label}['"]`));
    return m ? body.indexOf(m[0]) : -1;
  });
  assert.ok(seen.every(i => i >= 0), 'all 5 labels present');
  const sorted = [...seen].sort((a, b) => a - b);
  assert.deepEqual(seen, sorted, 'labels must appear in plan-mandated order');
});

test('W221 #2 - injector is idempotent on re-run (0 new touches second pass)', () => {
  // Re-running scripts/inject-nav.cjs must NOT mutate any file that already
  // carries the marker. This is the load-bearing property: future waves that
  // re-run the script during a sweep must not gratuitously dirty the tree.
  const out = execFileSync(process.execPath, ['scripts/inject-nav.cjs'], {
    cwd: ROOT, encoding: 'utf8',
  });
  const m = out.match(/(\d+)\s+touched,\s+(\d+)\s+idempotent-noop/);
  assert.ok(m, 'injector output parseable');
  assert.equal(parseInt(m[1], 10), 0,
    'second run must touch 0 files (first run during W221 already converted everything)');
});

test('W221 #3 - canonical nav block is written into every page with a marker', () => {
  // Every page that carries the BEGIN/END markers must contain the canonical
  // 5 anchors in the right order. Hard guarantee against drift.
  const pubDir = path.join(ROOT, 'public');
  const stack = [pubDir];
  let checked = 0;
  while (stack.length) {
    const d = stack.pop();
    for (const entry of fs.readdirSync(d, { withFileTypes: true })) {
      if (entry.name === '_archive' || entry.name === '_generations') continue;
      const full = path.join(d, entry.name);
      if (entry.isDirectory()) { stack.push(full); continue; }
      if (!entry.name.endsWith('.html')) continue;
      const s = fs.readFileSync(full, 'utf8');
      const beginIdx = s.indexOf(BEGIN_MARK);
      if (beginIdx < 0) continue;
      const endIdx = s.indexOf(END_MARK, beginIdx);
      assert.ok(endIdx > beginIdx, `${entry.name}: END marker after BEGIN`);
      const block = s.slice(beginIdx, endIdx);
      for (const label of NAV_ITEMS) {
        assert.match(block, new RegExp(`>${label}</a>`), `${entry.name}: ${label} link missing`);
      }
      // Order: indices must be monotonically increasing.
      const positions = NAV_ITEMS.map(l => block.indexOf(`>${l}</a>`));
      const sorted = [...positions].sort((a, b) => a - b);
      assert.deepEqual(positions, sorted, `${entry.name}: nav items must be in canonical order`);
      checked++;
    }
  }
  assert.ok(checked >= 50, `expected ≥50 marked pages, saw ${checked}`);
});

test('W221 #4 - removed nav items (Use cases / Research / Training) no longer appear as anchors in marked blocks', () => {
  // Use cases, Research, Training must NOT appear as top-level anchors inside
  // the marked block (they may appear in page body content; only the marked
  // block is constrained).
  const pubDir = path.join(ROOT, 'public');
  const stack = [pubDir];
  let checked = 0;
  while (stack.length) {
    const d = stack.pop();
    for (const entry of fs.readdirSync(d, { withFileTypes: true })) {
      if (entry.name === '_archive' || entry.name === '_generations') continue;
      const full = path.join(d, entry.name);
      if (entry.isDirectory()) { stack.push(full); continue; }
      if (!entry.name.endsWith('.html')) continue;
      const s = fs.readFileSync(full, 'utf8');
      const b = s.indexOf(BEGIN_MARK);
      if (b < 0) continue;
      const e = s.indexOf(END_MARK, b);
      const block = s.slice(b, e);
      assert.ok(!/>Use cases</.test(block), `${entry.name}: "Use cases" must be removed from marked nav`);
      assert.ok(!/>Research</.test(block), `${entry.name}: "Research" must be removed from marked nav`);
      assert.ok(!/>Training</.test(block), `${entry.name}: "Training" must be removed from marked nav`);
      checked++;
    }
  }
  assert.ok(checked >= 50);
});

test('W221 #5 - nav.js path-active wiring covers all 5 new nav items', () => {
  // The 5 nav anchors must be wired to the 5 path-active regexes. Active
  // state matters for both visual feedback and screen-reader aria-current.
  assert.match(NAV_JS, /href === '\/product'/, '/product wired');
  assert.match(NAV_JS, /href === '\/models'/, '/models wired');
  assert.match(NAV_JS, /href === '\/docs'/, '/docs wired');
  assert.match(NAV_JS, /href === '\/pricing'/, '/pricing wired');
  assert.match(NAV_JS, /href === '\/enterprise'/, '/enterprise wired');
});

test('W221 #6 - /use-cases routes still match the Product tab (use-cases collapsed under Product)', () => {
  // The path-active regex for Product must include `use-cases` so the existing
  // /use-cases/* URLs (which are still served and linked) highlight Product.
  const prdReMatch = NAV_JS.match(/var\s+prdRe\s*=\s*\/(\^[^\/]*?\/[^\/]+)\//);
  assert.ok(prdReMatch, 'prdRe regex extractable');
  const body = prdReMatch[1];
  assert.ok(/\buse-cases\b/.test(body), 'prdRe must include use-cases');
  assert.ok(/\bhealthcare\b/.test(body), 'prdRe must include healthcare');
  assert.ok(/\bfinance\b/.test(body), 'prdRe must include finance');
  assert.ok(/\bcaptures\b/.test(body), 'prdRe must include captures (the W213 dashboard)');
  assert.ok(/\bquickstart\b/.test(body), 'prdRe must include quickstart');
});

test('W221 #7 - /research and /training routes still highlight the Docs tab (collapsed under Docs)', () => {
  // research + training were W210-era top-level items; per plan they collapse
  // under Docs. Path-active regex for Docs must match those.
  const devReMatch = NAV_JS.match(/var\s+devRe\s*=\s*\/(\^[^\/]*?\/[^\/]+)\//);
  assert.ok(devReMatch, 'devRe regex extractable');
  const body = devReMatch[1];
  assert.ok(/\bresearch\b/.test(body), 'devRe must include research');
  assert.ok(/\btraining\b/.test(body), 'devRe must include training');
  assert.ok(/\bdocs\b/.test(body), 'devRe must include docs');
});

test('W221 #8 - /models and /runtimes both highlight the Models tab', () => {
  // /runtimes (W219) lives alongside /models (W217) in the frontier catalog
  // story; both should activate the Models nav item.
  const modReMatch = NAV_JS.match(/var\s+modRe\s*=\s*\/(\^[^\/]*?\/[^\/]+)\//);
  assert.ok(modReMatch, 'modRe regex extractable');
  const body = modReMatch[1];
  assert.ok(/\bmodels\b/.test(body), 'modRe must include models');
  assert.ok(/\bruntimes\b/.test(body), 'modRe must include runtimes');
});

test('W221 #9 - /product page exists with H1, lede, the four verbs grid, and use-cases list', () => {
  // The new Product top-level destination must carry the value-prop sentence
  // stack and link out to the four verbs (Capture / Compile / Ship / Audit)
  // plus the use-cases the visitor likely came from.
  assert.match(PRODUCT_HTML, /<h1[^>]*>[\s\S]*?The AI compiler[\s\S]*?<\/h1>/i);
  assert.match(PRODUCT_HTML, /Capture\s+your\s+real\s+prompts/);
  assert.match(PRODUCT_HTML, /Compile\s+them\s+into\s+your\s+own\s+model/);
  assert.match(PRODUCT_HTML, /Ship\s+it\s+on\s+your\s+hardware/);
  assert.match(PRODUCT_HTML, /Audit\s+every\s+call/);
  assert.match(PRODUCT_HTML, /href=["']\/captures["']/);
  assert.match(PRODUCT_HTML, /href=["']\/quickstart["']/);
  assert.match(PRODUCT_HTML, /href=["']\/runtimes["']/);
  assert.match(PRODUCT_HTML, /href=["']\/drift["']/);
  assert.match(PRODUCT_HTML, /href=["']\/use-cases["']/);
});

test('W221 #10 - /product rewrite is wired in vercel.json', () => {
  const rewrite = VERCEL.rewrites.find(r => r.source === '/product');
  assert.ok(rewrite, '/product rewrite present');
  assert.equal(rewrite.destination, '/product.html');
});

test('W221 #11 - sw.js CACHE wave-floor >= 221', () => {
  // Wave-floor regex (NOT equality) so future cache bumps do not regress
  // this test — the W169 lock-in test trap Pablo flagged.
  const m = SW.match(/const\s+CACHE\s*=\s*'kolm-v7-2026-05-\d+-wave(\d+)/);
  assert.ok(m, 'CACHE slug present');
  assert.ok(parseInt(m[1], 10) >= 221, 'CACHE wave >= 221 (got ' + m[1] + ')');
});

test('W221 #12 - injector script writes the marker so the block is re-locatable on the next sweep', () => {
  // The script must produce a block delimited by the marker so the next wave's
  // injector can find + replace it deterministically. This is what makes the
  // single-source-of-truth pattern work.
  assert.match(INJECTOR, /KOLM_NAV_BEGIN \(W221\)/, 'BEGIN marker literal in injector');
  assert.match(INJECTOR, /KOLM_NAV_END \(W221\)/, 'END marker literal in injector');
  assert.match(INJECTOR, /MARKED_RE/, 'MARKED_RE branch (idempotent re-run path)');
  assert.match(INJECTOR, /LEGACY_RE/, 'LEGACY_RE branch (one-shot upgrade path)');
});

test('W221 #13 - /product page declares JSON-LD SoftwareApplication + BreadcrumbList', () => {
  // The new top-level landing page must carry rich-result schema so SEO can
  // index it (W225 will wire site-wide JSON-LD, but the canonical destination
  // of the Product nav tab should be discoverable from W221 onward).
  assert.match(PRODUCT_HTML, /application\/ld\+json/);
  assert.match(PRODUCT_HTML, /"SoftwareApplication"/);
  assert.match(PRODUCT_HTML, /"BreadcrumbList"/);
});
