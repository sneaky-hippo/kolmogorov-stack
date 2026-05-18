// Wave 347 — POST /v1/build/preview (richer dry-run preview).
//
// The builder UI used to call POST /v1/builder/preview, which returns only
// {recipe_source, k_score_estimate, warnings, synth}. The "preview pane"
// could not show the visitor a useful gate verdict because the path never
// ran prepareSeedSplit or productionReady. W347 adds POST /v1/build/preview
// (also public, also rate-limited by builderLimiter) that:
//   - takes {spec, seeds_jsonl_text}
//   - parses canonical {input,output} OR legacy {prompt,completion}
//   - runs synthesize + computeKScore + prepareSeedSplit + productionReadySync
//   - returns {ok, k_score, train_rows, holdout_rows, train_count,
//              holdout_count, production_ready, gate_reasons, accepted,
//              recipe_source, warnings, synth}
//
// Behavior assertions (no copy):
//   1. /v1/build/preview is registered ABOVE r.use(authMiddleware).
//   2. POST with a real spec + 8 canonical seed rows returns 200 with
//      k_score (composite + ships fields), train_rows[<=3], holdout_rows[<=3],
//      train_count + holdout_count summing to the input count, and a
//      production_ready object with an `ok` boolean and `reasons` array.
//   3. POST with seeds_jsonl_text missing → 400 invalid_seeds.
//   4. POST with spec missing → 400 invalid_spec.
//   5. POST with seeds_jsonl_text=='' (whitespace only) → 400 empty_seeds.
//   6. Legacy {prompt,completion} rows are accepted just like canonical rows.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..');
const ROUTER_SRC = fs.readFileSync(path.join(ROOT, 'src/router.js'), 'utf8');

async function bootApp() {
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
        const port = server.address().port;
        const out = await fn(`http://127.0.0.1:${port}`);
        server.close(() => resolve(out));
      } catch (e) {
        server.close(() => reject(e));
      }
    });
  });
}

function sampleSpec() {
  return {
    name: 'phi-redactor-preview',
    task: 'Redact patient names from clinical notes.',
    output_spec: { type: 'string' },
  };
}

function sampleSeeds(n = 8) {
  // Deterministic, identical input pattern so the simple synth can find a
  // recipe. Each row swaps a name for [REDACTED].
  const rows = [];
  for (let i = 0; i < n; i++) {
    rows.push(JSON.stringify({
      input: `Patient John Doe ${i} arrived at 9am.`,
      output: `Patient [REDACTED] arrived at 9am.`,
    }));
  }
  return rows.join('\n');
}

test('W347 #1 - /v1/build/preview is registered ABOVE the auth gate', () => {
  const previewIdx = ROUTER_SRC.indexOf("r.post('/v1/build/preview'");
  const gateIdx = ROUTER_SRC.indexOf('r.use(authMiddleware);');
  assert.ok(previewIdx > 0, 'POST /v1/build/preview not found');
  assert.ok(gateIdx > 0, 'authMiddleware mount point missing');
  assert.ok(previewIdx < gateIdx, 'build/preview must be unauthed');
});

test('W347 #2 - 200 with k_score + rows + production_ready on a real payload', async () => {
  const app = await bootApp();
  await withServer(app, async (base) => {
    const r = await fetch(base + '/v1/build/preview', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ spec: sampleSpec(), seeds_jsonl_text: sampleSeeds(8) }),
    });
    assert.equal(r.status, 200, 'expected 200 on a real preview');
    const j = await r.json();
    assert.equal(j.ok, true);
    // k_score shape from src/kscore.js.
    assert.ok(j.k_score && typeof j.k_score === 'object', 'k_score missing');
    assert.equal(typeof j.k_score.composite, 'number', 'k_score.composite missing');
    assert.equal(typeof j.k_score.ships, 'boolean', 'k_score.ships missing');
    // Row preview is capped at 3.
    assert.ok(Array.isArray(j.train_rows), 'train_rows missing');
    assert.ok(Array.isArray(j.holdout_rows), 'holdout_rows missing');
    assert.ok(j.train_rows.length <= 3, `train_rows must be <=3, got ${j.train_rows.length}`);
    assert.ok(j.holdout_rows.length <= 3, `holdout_rows must be <=3, got ${j.holdout_rows.length}`);
    // Train + holdout counts should sum to <= the input count
    // (de-dup may drop some rows; that's expected and reported in warnings).
    assert.equal(typeof j.train_count, 'number');
    assert.equal(typeof j.holdout_count, 'number');
    assert.ok(j.train_count + j.holdout_count <= 8);
    assert.ok(j.train_count + j.holdout_count > 0);
    // production_ready verdict shape.
    assert.ok(j.production_ready && typeof j.production_ready === 'object');
    assert.equal(typeof j.production_ready.ok, 'boolean');
    assert.ok(Array.isArray(j.production_ready.reasons));
    assert.ok(Array.isArray(j.gate_reasons));
    // recipe_source is a string (possibly empty when synth could not converge).
    assert.equal(typeof j.recipe_source, 'string');
    // warnings present even if empty.
    assert.ok(Array.isArray(j.warnings));
  });
});

test('W347 #3 - missing seeds_jsonl_text returns 400 invalid_seeds', async () => {
  const app = await bootApp();
  await withServer(app, async (base) => {
    const r = await fetch(base + '/v1/build/preview', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ spec: sampleSpec() }),
    });
    assert.equal(r.status, 400);
    const j = await r.json();
    assert.equal(j.error, 'invalid_seeds');
  });
});

test('W347 #4 - missing spec returns 400 invalid_spec', async () => {
  const app = await bootApp();
  await withServer(app, async (base) => {
    const r = await fetch(base + '/v1/build/preview', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ seeds_jsonl_text: sampleSeeds(4) }),
    });
    assert.equal(r.status, 400);
    const j = await r.json();
    assert.equal(j.error, 'invalid_spec');
  });
});

test('W347 #5 - empty (whitespace) seeds returns 400 empty_seeds', async () => {
  const app = await bootApp();
  await withServer(app, async (base) => {
    const r = await fetch(base + '/v1/build/preview', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ spec: sampleSpec(), seeds_jsonl_text: '\n   \n\n' }),
    });
    assert.equal(r.status, 400);
    const j = await r.json();
    assert.equal(j.error, 'empty_seeds');
  });
});

test('W347 #6 - legacy {prompt,completion} rows are accepted', async () => {
  const app = await bootApp();
  await withServer(app, async (base) => {
    const lines = [];
    for (let i = 0; i < 6; i++) {
      lines.push(JSON.stringify({
        prompt: `Patient Alice Smith ${i} called at 3pm.`,
        completion: `Patient [REDACTED] called at 3pm.`,
      }));
    }
    const r = await fetch(base + '/v1/build/preview', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ spec: sampleSpec(), seeds_jsonl_text: lines.join('\n') }),
    });
    assert.equal(r.status, 200);
    const j = await r.json();
    assert.equal(j.ok, true);
    assert.ok(j.train_count + j.holdout_count > 0,
      'legacy rows should be parsed into train/holdout');
  });
});
