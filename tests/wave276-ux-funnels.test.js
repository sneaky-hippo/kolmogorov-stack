// W276 — Persona-based UX guided funnels.
//
// Behavior tests for the four persona onboarding pages, the persona-detector
// index page, the URL-param routing, the signup.html callout, and the
// vercel.json rewrites for the five new routes.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..');
const PUBLIC = path.join(ROOT, 'public');
const ONBOARD = path.join(PUBLIC, 'onboard');

function read(p) { return fs.readFileSync(p, 'utf8'); }

const PERSONAS = ['cto', 'developer', 'compliance', 'researcher'];

test('W276 onboard directory exists with index + 4 persona pages', () => {
  assert.ok(fs.existsSync(ONBOARD) && fs.statSync(ONBOARD).isDirectory(), 'public/onboard/ must exist');
  assert.ok(fs.existsSync(path.join(ONBOARD, 'index.html')), 'onboard/index.html must exist');
  for (const p of PERSONAS) {
    const file = path.join(ONBOARD, `${p}.html`);
    assert.ok(fs.existsSync(file), `onboard/${p}.html must exist`);
    const stat = fs.statSync(file);
    assert.ok(stat.size > 3000, `onboard/${p}.html must be substantive (>3KB), got ${stat.size}`);
  }
});

test('W276 onboard/index.html renders 4 persona radio cards', () => {
  const html = read(path.join(ONBOARD, 'index.html'));
  // Each persona has a labelled radio input.
  for (const p of PERSONAS) {
    assert.match(
      html,
      new RegExp(`<input[^>]*type="radio"[^>]*value="${p}"`),
      `index.html must render a radio input for persona=${p}`,
    );
    assert.match(
      html,
      new RegExp(`data-persona="${p}"`),
      `index.html must tag the card for persona=${p}`,
    );
  }
  // Four cards total (no more, no less).
  const radioCount = (html.match(/<input[^>]*type="radio"[^>]*name="persona"/g) || []).length;
  assert.equal(radioCount, 4, `expected exactly 4 persona radios, got ${radioCount}`);
});

test('W276 onboard/index.html JS contains URL-param routing logic', () => {
  const html = read(path.join(ONBOARD, 'index.html'));
  // The JS must read the ?persona= query param.
  assert.match(html, /\?persona=/, 'index.html must document the ?persona= param');
  assert.match(html, /getParam\s*\(\s*['"]persona['"]\s*\)|persona=([^&]+)/, 'must parse ?persona= param');
  // Routes table maps each persona to its onboarding subpage.
  // Keys may be quoted or unquoted; just require the persona key paired with the right path string.
  for (const p of PERSONAS) {
    const re = new RegExp(`(['"]?)${p}\\1\\s*:\\s*['"]/onboard/${p}['"]`);
    assert.match(html, re, `routes.${p} must point to /onboard/${p}`);
  }
  // Direct-entry must redirect on match.
  assert.match(html, /location\.replace\s*\(/, 'direct-entry must use location.replace to avoid stacking history');
});

test('W276 onboard/index.html has a canonical URL + title with kolm.ai', () => {
  const html = read(path.join(ONBOARD, 'index.html'));
  assert.match(html, /<link rel="canonical" href="https:\/\/kolm\.ai\/onboard"/);
  assert.match(html, /<title>[^<]*kolm\.ai[^<]*<\/title>/);
});

test('W276 each persona page renders a 4-step progress strip', () => {
  for (const p of PERSONAS) {
    const html = read(path.join(ONBOARD, `${p}.html`));
    // Step pills: data-step="1" .. data-step="4".
    for (const n of [1, 2, 3, 4]) {
      assert.match(
        html,
        new RegExp(`data-step="${n}"`),
        `onboard/${p}.html must render step pill data-step="${n}"`,
      );
    }
    // 4 sections, one per step.
    const sectionCount = (html.match(/class="ob-step[^"]*"\s+data-step=/g) || []).length;
    assert.equal(sectionCount, 4, `onboard/${p}.html must have exactly 4 ob-step sections, got ${sectionCount}`);
  }
});

test('W276 each persona page has a canonical pointing at /onboard/<persona>', () => {
  for (const p of PERSONAS) {
    const html = read(path.join(ONBOARD, `${p}.html`));
    assert.match(
      html,
      new RegExp(`<link rel="canonical" href="https://kolm\\.ai/onboard/${p}"`),
      `onboard/${p}.html must have canonical /onboard/${p}`,
    );
  }
});

test('W276 each persona page links to its required destinations', () => {
  // CTO step 4 schedules procurement; developer step 4 links to /install/cursor;
  // compliance step 3 links to /drift; researcher step 1 links to /models.
  const cto = read(path.join(ONBOARD, 'cto.html'));
  assert.match(cto, /\/enterprise\/inquiry/, 'cto.html must link to /enterprise/inquiry for procurement');
  assert.match(cto, /\/self-host/, 'cto.html must link to /self-host');

  const dev = read(path.join(ONBOARD, 'developer.html'));
  assert.match(dev, /\/install\/cursor/, 'developer.html must link to /install/cursor');
  assert.match(dev, /kolm capture/, 'developer.html must mention `kolm capture`');
  assert.match(dev, /kolm distill/, 'developer.html must mention `kolm distill`');

  const comp = read(path.join(ONBOARD, 'compliance.html'));
  assert.match(comp, /\/drift/, 'compliance.html must link to /drift');
  assert.match(comp, /\/baa/, 'compliance.html must link to /baa');
  assert.match(comp, /receipt chain/i, 'compliance.html must mention the receipt chain');

  const res = read(path.join(ONBOARD, 'researcher.html'));
  assert.match(res, /\/models/, 'researcher.html must link to /models');
  assert.match(res, /\/kscore-leaderboard/, 'researcher.html must link to /kscore-leaderboard');
  assert.match(res, /\/research/, 'researcher.html must link to /research');
});

test('W276 each onboard page has zero em-dashes and zero en-dashes in body copy', () => {
  for (const p of ['index', ...PERSONAS]) {
    const html = read(path.join(ONBOARD, `${p}.html`));
    const stripped = html
      .replace(/<script[\s\S]*?<\/script>/g, '')
      .replace(/<style[\s\S]*?<\/style>/g, '')
      .replace(/<pre[\s\S]*?<\/pre>/g, '')
      .replace(/<code[\s\S]*?<\/code>/g, '');
    assert.ok(!stripped.includes('—'), `onboard/${p}.html: no em-dash (U+2014) in body copy`);
    assert.ok(!stripped.includes('–'), `onboard/${p}.html: no en-dash (U+2013) in body copy`);
  }
});

test('W276 signup.html surfaces the /onboard callout', () => {
  const html = read(path.join(PUBLIC, 'signup.html'));
  // Must link to /onboard at least once.
  assert.match(html, /href="\/onboard"/, 'signup.html must include a href="/onboard" link');
  // The callout language names the four personas implicitly (guided path).
  assert.match(html, /guided path/i, 'signup.html callout must mention "guided path"');
});

test('W276 vercel.json has all 5 onboard rewrites', () => {
  const v = JSON.parse(read(path.join(ROOT, 'vercel.json')));
  const rewrites = v.rewrites || [];
  const expected = [
    { source: '/onboard', destination: '/onboard/index.html' },
    { source: '/onboard/cto', destination: '/onboard/cto.html' },
    { source: '/onboard/developer', destination: '/onboard/developer.html' },
    { source: '/onboard/compliance', destination: '/onboard/compliance.html' },
    { source: '/onboard/researcher', destination: '/onboard/researcher.html' },
  ];
  for (const e of expected) {
    const hit = rewrites.find((r) => r.source === e.source && r.destination === e.destination);
    assert.ok(hit, `vercel.json missing rewrite ${e.source} -> ${e.destination}`);
  }
});

test('W276 sw.js cache slug is at or past wave276 (>=276)', () => {
  const sw = read(path.join(PUBLIC, 'sw.js'));
  const m = sw.match(/const CACHE\s*=\s*'kolm-v\d+-\d{4}-\d{2}-\d{2}-wave(\d+)-/);
  assert.ok(m, 'sw.js CACHE must follow wave naming');
  const n = parseInt(m[1], 10);
  assert.ok(n >= 276, `expected sw.js wave >= 276, got ${n}`);
});

test('W276 onboard/index.html persona-card click handler exists', () => {
  const html = read(path.join(ONBOARD, 'index.html'));
  // Visual-selection JS so the card highlights when clicked.
  assert.match(html, /\.selected/, 'index.html must define a .selected card style');
  assert.match(html, /classList\.add\s*\(\s*['"]selected['"]\s*\)/, 'click handler must add .selected');
  // Form submit handler must look up the chosen persona and navigate.
  assert.match(html, /input\[name=persona\]:checked|name="persona"/, 'submit handler must read the chosen persona');
});

test('W276 each persona page has step-navigation JS', () => {
  for (const p of PERSONAS) {
    const html = read(path.join(ONBOARD, `${p}.html`));
    // Buttons with data-next move forward; pills are clickable.
    assert.match(html, /data-next/, `${p}.html must include data-next step buttons`);
    assert.match(html, /classList\.toggle\s*\(\s*['"]active['"]/, `${p}.html must toggle .active on step change`);
    // Each page sets the persona in localStorage so the index can restore.
    assert.match(
      html,
      new RegExp(`localStorage\\.setItem\\s*\\(\\s*['"]kolm-persona['"]\\s*,\\s*['"]${p}['"]\\s*\\)`),
      `${p}.html must persist persona=${p} to localStorage`,
    );
  }
});

test('W276 each persona page links back to /onboard (switch path)', () => {
  for (const p of PERSONAS) {
    const html = read(path.join(ONBOARD, `${p}.html`));
    assert.match(html, /href="\/onboard"/, `${p}.html must offer a way to switch personas via /onboard`);
  }
});

test('W276 onboard pages are noindex (private funnel)', () => {
  for (const p of ['index', ...PERSONAS]) {
    const html = read(path.join(ONBOARD, `${p}.html`));
    assert.match(html, /<meta name="robots" content="noindex/, `onboard/${p}.html should be noindex (private funnel)`);
  }
});
