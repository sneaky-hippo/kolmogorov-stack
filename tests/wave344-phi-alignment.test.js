// Wave 344 — PHI artifact runtime alignment.
//
// Bug: the installed PHI artifact missed NAME, ADDRESS, and MRN even though
// src/phi-redactor.js can detect all 20 PHI classes. The original artifact's
// runtime was a stale, stripped-down regex copy.
//
// Fix: examples/claims-redactor/recipe.js mirrors src/phi-redactor.js's
// DETECTORS matrix 1:1 (single-source pattern, W295/W258-ML-4). Same regex
// shapes, same [PHI_<CLASS>_<INDEX>] token format, same de-dup logic.
//
// What this test locks in:
//   1. The recipe in the committed .kolm masks all THREE identifiers in the
//      smoke-test note: NAME (Sandra Pham), ADDRESS/GEO (415 Oak St), MRN.
//   2. Round-trip via /v1/marketplace/claims-redactor/download produces the
//      same redaction when run.
//   3. Token format matches src/phi-redactor.js's contract (tokenPattern()).
//   4. The recipe + phi-redactor.js agree on the detector class names so
//      reinject() (which only reads tokens) works across both surfaces.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const CLI = path.join(ROOT, 'cli', 'kolm.js');
const ARTIFACT = path.join(ROOT, 'examples', 'claims-redactor', 'claims-redactor.kolm');

const SMOKE = 'Sandra Pham, 415 Oak St, MRN 9988123';

function runRecipe(input) {
  // Direct sandbox execution against the committed recipe.js — no spawn cost,
  // hot path that the .kolm runtime walks.
  const src = fs.readFileSync(path.join(ROOT, 'examples', 'claims-redactor', 'recipe.js'), 'utf8');
  // Use the same compiler the runtime uses.
  const vm = require('node:vm');
  const wrapped = `(function(input, lib){ "use strict"; ${src}\n; return generate(input, lib); })`;
  const script = new vm.Script(wrapped, { filename: 'recipe.js' });
  const ctx = vm.createContext({});
  const fn = script.runInContext(ctx);
  return fn({ text: input }, { patterns: {}, pack: null, index: null, params: null });
}

// Use ESM-compatible require for the helper above.
const require = (await import('node:module')).createRequire(import.meta.url);

async function makeApp() {
  const { buildRouter } = await import('../src/router.js');
  const express = (await import('express')).default;
  const app = express();
  app.use(express.json({ limit: '4mb' }));
  app.use(buildRouter());
  return app;
}

function withServer(app, fn) {
  return new Promise((resolve, reject) => {
    const server = app.listen(0, async () => {
      try {
        const out = await fn(`http://127.0.0.1:${server.address().port}`);
        server.close(() => resolve(out));
      } catch (e) {
        server.close(() => reject(e));
      }
    });
  });
}

test('W344 #1 — recipe.js on the smoke-test note masks NAME, GEO, and MRN', () => {
  const out = runRecipe(SMOKE);
  // The recipe returns { redacted, map, classes }. Assert all three classes
  // appear and the original substrings DO NOT appear anywhere in `redacted`.
  assert.ok(out.classes.includes('NAME'),
    `NAME must be detected; got classes: ${JSON.stringify(out.classes)}`);
  assert.ok(out.classes.includes('GEO'),
    `GEO must be detected; got classes: ${JSON.stringify(out.classes)}`);
  assert.ok(out.classes.includes('MRN'),
    `MRN must be detected; got classes: ${JSON.stringify(out.classes)}`);
  assert.ok(!out.redacted.includes('Sandra Pham'),
    `'Sandra Pham' must be redacted from output; got: ${out.redacted}`);
  assert.ok(!out.redacted.includes('415 Oak St'),
    `'415 Oak St' must be redacted from output; got: ${out.redacted}`);
  assert.ok(!out.redacted.includes('9988123'),
    `'9988123' must be redacted from output; got: ${out.redacted}`);
  // And the map must round-trip those values back.
  const vals = Object.values(out.map);
  assert.ok(vals.includes('Sandra Pham'), 'map must carry Sandra Pham original');
  assert.ok(vals.includes('415 Oak St'), 'map must carry 415 Oak St original');
  assert.ok(vals.includes('9988123'), 'map must carry 9988123 original');
});

test('W344 #2 — tokens follow [PHI_<CLASS>_<INDEX>] contract from src/phi-redactor.js', async () => {
  const out = runRecipe(SMOKE);
  const { tokenPattern } = await import('../src/phi-redactor.js');
  const re = tokenPattern();
  const found = [...out.redacted.matchAll(re)].map((m) => ({ tok: m[0], cls: m[1], idx: m[2] }));
  // We expect at least 3 token hits (NAME, GEO, MRN) using the SAME regex
  // that drives findTokens() / reinject() on the phi-redactor.js side.
  assert.ok(found.length >= 3, `expected >=3 tokens; got ${found.length}`);
  const classes = new Set(found.map((f) => f.cls));
  assert.ok(classes.has('NAME'), 'token NAME class missing');
  assert.ok(classes.has('GEO'), 'token GEO class missing');
  assert.ok(classes.has('MRN'), 'token MRN class missing');
});

test('W344 #3 — recipe + src/phi-redactor.js agree on class names (drift guard)', async () => {
  const { CLASSES } = await import('../src/phi-redactor.js');
  const recipeSrc = fs.readFileSync(path.join(ROOT, 'examples', 'claims-redactor', 'recipe.js'), 'utf8');
  // Every class our recipe declares in `cls: 'X'` entries must also be a
  // CLASSES member from src/phi-redactor.js. If the recipe ever invents a
  // new class string, reinject() on the phi-redactor side would still
  // pass through unknown tokens (graceful), but the marketplace SLO is that
  // the two stay in lockstep.
  const re = /cls:\s*'([A-Z]+)'/g;
  const recipeClasses = new Set();
  let m;
  while ((m = re.exec(recipeSrc)) !== null) recipeClasses.add(m[1]);
  assert.ok(recipeClasses.size >= 10, `recipe should declare >= 10 classes; got ${recipeClasses.size}`);
  for (const c of recipeClasses) {
    assert.ok(CLASSES.includes(c),
      `recipe declares class '${c}' that is NOT in src/phi-redactor.js CLASSES (drift!). CLASSES=${JSON.stringify(CLASSES)}`);
  }
});

test('W344 #4 — committed .kolm runs the recipe and masks all three smoke-test identifiers', async () => {
  if (!fs.existsSync(ARTIFACT)) {
    console.warn('skipping W344 #4: claims-redactor.kolm not committed yet');
    return;
  }
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'kolm-w344-'));
  // NOTE: do NOT override HOME/USERPROFILE here. The committed .kolm was
  // signed by the dev machine's ~/.kolm/config.json HMAC secret; spawning the
  // CLI with a fresh HOME would mint a new secret and trip the
  // KOLM_E_SIGNATURE_INVALID guard. We do isolate KOLM_DATA_DIR so this run
  // can't pollute the real data dir.
  const env = { ...process.env, KOLM_DATA_DIR: tmp };
  const r = spawnSync(process.execPath, [
    CLI, 'run', ARTIFACT,
  ], {
    input: JSON.stringify({ text: SMOKE }),
    encoding: 'utf8',
    env, cwd: ROOT, timeout: 30000,
  });
  assert.equal(r.status, 0, `run exit ${r.status}; stderr=\n${r.stderr}\nstdout=\n${r.stdout}`);
  // Smoke-test redaction must appear in stdout. The run command pretty-prints
  // the JSON; assert each masked substring is present and each original is
  // NOT.
  assert.match(r.stdout, /\[PHI_NAME_\d+\]/, 'output must contain a PHI_NAME_n token');
  assert.match(r.stdout, /\[PHI_GEO_\d+\]/, 'output must contain a PHI_GEO_n token');
  assert.match(r.stdout, /\[PHI_MRN_\d+\]/, 'output must contain a PHI_MRN_n token');
  // The originals must NOT leak into the output (NB: they DO appear inside
  // the map block of the JSON; we want NAME/GEO not appearing in the
  // `redacted` value. Easiest cross-check: the verbatim raw text must not
  // appear as a whole substring outside a quoted map value.)
  const redactedMatch = /"redacted":\s*"([^"]+)"/.exec(r.stdout);
  assert.ok(redactedMatch, 'output must include a "redacted" value in JSON');
  const redactedVal = redactedMatch[1];
  assert.ok(!redactedVal.includes('Sandra Pham'),
    `Sandra Pham must not appear in redacted field; got: ${redactedVal}`);
  assert.ok(!redactedVal.includes('415 Oak St'),
    `415 Oak St must not appear in redacted field; got: ${redactedVal}`);
  assert.ok(!redactedVal.includes('9988123'),
    `9988123 must not appear in redacted field; got: ${redactedVal}`);
}, { timeout: 60000 });

test('W344 #5 — round-trip via /v1/marketplace/claims-redactor/download serves the same .kolm', async () => {
  if (!fs.existsSync(ARTIFACT)) {
    console.warn('skipping W344 #5: claims-redactor.kolm not committed yet');
    return;
  }
  const app = await makeApp();
  await withServer(app, async (base) => {
    // The marketplace gate requires productionReady() to pass. Our .kolm
    // was built with --seeds so it should pass without ?force=true.
    const r = await fetch(base + '/v1/marketplace/claims-redactor/download');
    if (r.status !== 200) {
      const txt = await r.text().catch(() => '<unreadable>');
      assert.equal(r.status, 200, `expected 200; got ${r.status} (body=${txt})`);
    }
    assert.equal(r.headers.get('x-kolm-production-ready'), 'true',
      'X-Kolm-Production-Ready header must be true');
    const buf = Buffer.from(await r.arrayBuffer());
    // Saved-to-disk bytes must match the committed artifact byte-for-byte.
    const onDisk = fs.readFileSync(ARTIFACT);
    assert.equal(buf.length, onDisk.length, 'downloaded byte count must match on-disk');
    assert.ok(buf.equals(onDisk), 'downloaded bytes must equal on-disk bytes');
  });
}, { timeout: 60000 });

test('W344 #6 — recipe NAME detector continues to NOT match bare single tokens (wave144 lock-in)', () => {
  // Per tests/wave144-phi-redactor.test.js line 145-148, bare "Maria" alone
  // (no honorific/label, no surname) must NOT trigger NAME detection. Our
  // recipe adds bare-name detection, but only as "First Last" pairs where
  // BOTH parts are titlecased; single tokens are still ignored.
  const out = runRecipe('Maria called Maria.');
  assert.ok(!out.classes.includes('NAME'),
    `bare 'Maria' (single token) must NOT trigger NAME; got classes: ${JSON.stringify(out.classes)}`);
});

test('W344 #7 — recipe correctly handles a no-PHI input (idempotent passthrough)', () => {
  const out = runRecipe('Lab values normal. Vitals stable. Discharge home.');
  assert.equal(out.redacted, 'Lab values normal. Vitals stable. Discharge home.');
  // Cross-realm: compare via canonical JSON instead of deepStrictEqual.
  assert.equal(JSON.stringify(out.map), '{}');
  assert.equal(JSON.stringify(out.classes), '[]');
});

test('W344 #8 — recipe is deterministic (same input -> same redacted + same map)', () => {
  const a = runRecipe(SMOKE);
  const b = runRecipe(SMOKE);
  assert.equal(a.redacted, b.redacted);
  // runRecipe executes in a vm context, so a.map / b.map carry a cross-realm
  // Object prototype; deepStrictEqual fails the reference-equal prototype
  // check. Compare canonical JSON instead.
  assert.equal(JSON.stringify(a.map), JSON.stringify(b.map));
  assert.equal(JSON.stringify(a.classes), JSON.stringify(b.classes));
});

test('W344 #9 — recipe re-redaction of a redacted string is a no-op on tokens (idempotency)', () => {
  const first = runRecipe(SMOKE);
  const second = runRecipe(first.redacted);
  // The already-tokenized output must not pick up new PHI matches because
  // existing tokens are protected by the sentinel pass.
  assert.equal(second.redacted, first.redacted,
    `re-redacting a redacted string must be a no-op; first=${first.redacted}, second=${second.redacted}`);
});

test('W344 #10 — same identifier appears twice -> same token (de-dupe contract)', () => {
  const out = runRecipe('MRN 1234567 noted; later MRN 1234567 confirmed.');
  // Two MRN matches with the same identifier collapse to a single token.
  const tokens = (out.redacted.match(/\[PHI_MRN_\d+\]/g) || []);
  assert.equal(tokens.length, 2, 'both MRN mentions get tokenized');
  assert.equal(tokens[0], tokens[1], `same identifier -> same token; got ${JSON.stringify(tokens)}`);
});
