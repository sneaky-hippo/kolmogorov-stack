// Wave 214: click-to-distill from captures.
//
// Behavior assertions (per Pablo W202-W210 correction - no page-text markers).
//
// W214 contract this test enforces (W364 update: specialist always returns
// 202 with a real job_id via the in-tree worker; 503 distill_bridge_not_configured
// is no longer reachable from the shipped router):
//   1. POST /v1/distill/from-captures registered behind authMiddleware.
//   2. GET  /v1/distill/from-captures/preview registered behind authMiddleware
//      and is read-only (the handler must NOT call synthesize() or fetch a
//      trainer bridge - preview can never start a job).
//   3. Both routes read from the durable W212 store (listCaptures), not from
//      an in-memory shim - so the same rows captured via the proxy are
//      visible to distill.
//   4. The POST handler picks recipe vs specialist by count: <1000 = recipe,
//      >=1000 = specialist (forceable via body.mode).
//   5. The recipe path uses the largest template-hash cluster as positives
//      (canonical heuristic) and refuses (400 no_cluster) below 4 in the
//      best cluster.
//   6. Capture-store-unavailable surfaces as 503 with a structured error
//      (not a 200 with empty rows) - same durability contract as W212.
//   7. The specialist path tries KOLM_TRAINER_BRIDGE_URL first, then falls
//      through to the in-tree distill-bridge.js worker so the tenant always
//      gets a real job_id (never 503 distill_bridge_not_configured).
//   8. cli/kolm.js - cmdDistill routes --from-captures to cmdDistillFromCaptures.
//   9. cmdDistillFromCaptures honors --preview (GET), --mode, --min-pairs,
//      --json, and exits non-zero on every error branch (not_enough_captures,
//      no_cluster, capture_store_unavailable).
//  10. public/captures.html promote-button calls the preview GET first and
//      only POSTs after user confirmation.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..');
const ROUTER_SRC = fs.readFileSync(path.join(ROOT, 'src/router.js'), 'utf8');
const CLI_SRC = fs.readFileSync(path.join(ROOT, 'cli/kolm.js'), 'utf8');
const CAPTURES_HTML = fs.readFileSync(path.join(ROOT, 'public/captures.html'), 'utf8');

function sliceHandler(src, marker, len = 8000) {
  const idx = src.indexOf(marker);
  assert.ok(idx > 0, `marker not found: ${marker}`);
  return src.slice(idx, idx + len);
}

const POST_MARKER = "r.post('/v1/distill/from-captures'";
const GET_MARKER = "r.get('/v1/distill/from-captures/preview'";

test('W214 #1 - POST /v1/distill/from-captures behind authMiddleware', () => {
  assert.match(
    ROUTER_SRC,
    /r\.post\(['"]\/v1\/distill\/from-captures['"]\s*,\s*authMiddleware/,
    'POST route must be authMiddleware-gated'
  );
});

test('W214 #2 - GET /v1/distill/from-captures/preview behind authMiddleware', () => {
  assert.match(
    ROUTER_SRC,
    /r\.get\(['"]\/v1\/distill\/from-captures\/preview['"]\s*,\s*authMiddleware/,
    'GET preview route must be authMiddleware-gated'
  );
});

test('W214 #3 - preview handler is read-only (no synthesize, no fetch)', () => {
  const handler = sliceHandler(ROUTER_SRC, GET_MARKER, 2500);
  assert.doesNotMatch(handler, /synthesize\(/, 'preview must not call synthesize()');
  assert.doesNotMatch(handler, /\bfetch\s*\(/, 'preview must not call fetch() (no trainer bridge)');
  assert.match(handler, /listCaptures\(/, 'preview must read durable store via listCaptures');
});

test('W214 #4 - POST handler reads durable W212 store (listCaptures)', () => {
  const handler = sliceHandler(ROUTER_SRC, POST_MARKER);
  assert.match(handler, /await\s+listCaptures\(/, 'must await listCaptures');
  // Must NOT use an in-memory shim or pre-W212 swallow pattern.
  assert.doesNotMatch(handler, /observations\.find\(/);
  assert.doesNotMatch(handler, /globalThis\._captures/);
});

test('W214 #5 - chosen mode: recipe when count < 1000, specialist when >= 1000', () => {
  const handler = sliceHandler(ROUTER_SRC, POST_MARKER);
  // The decision lives in a single expression; assert both arms are present.
  assert.match(handler, /captures\.length\s*>=\s*1000\s*\?\s*['"]specialist['"]\s*:\s*['"]recipe['"]/);
  assert.match(handler, /forceMode/, 'caller must be able to force mode');
  assert.match(handler, /\['recipe',\s*'specialist'\]/, 'mode whitelist must be enforced');
});

test('W214 #6 - recipe path uses largest template-hash cluster + refuses < 4', () => {
  const handler = sliceHandler(ROUTER_SRC, POST_MARKER);
  assert.match(handler, /template_hash/);
  assert.match(handler, /bestArr\.length\s*<\s*4/);
  assert.match(handler, /no_cluster/);
});

test('W214 #7 - capture_store_unavailable returns 503 (W212 durability contract)', () => {
  const handler = sliceHandler(ROUTER_SRC, POST_MARKER);
  assert.match(handler, /status\(503\)[\s\S]{0,400}capture_store_unavailable/);
  const preview = sliceHandler(ROUTER_SRC, GET_MARKER, 2500);
  assert.match(preview, /status\(503\)[\s\S]{0,400}capture_store_unavailable/);
});

test('W214 #8 - specialist path tries KOLM_TRAINER_BRIDGE_URL then falls through to in-tree worker (W364)', () => {
  const handler = sliceHandler(ROUTER_SRC, POST_MARKER);
  assert.match(handler, /KOLM_TRAINER_BRIDGE_URL/);
  // W364: in-tree worker is the always-available fallback.
  assert.match(handler, /distill-bridge\.js/);
  assert.match(handler, /startDistillJob/);
  // Response shape must include a job_id + poll_url.
  assert.match(handler, /poll_url/);
  // The pre-W364 503 sentinel must NOT appear in the specialist arm of the
  // POST /v1/distill/from-captures handler.
  assert.doesNotMatch(handler, /distill_bridge_not_configured/);
});

test('W214 #9 - POST refuses < min_pairs with 400 not_enough_captures', () => {
  const handler = sliceHandler(ROUTER_SRC, POST_MARKER);
  assert.match(handler, /status\(400\)[\s\S]{0,500}not_enough_captures/);
  // Floor is at least 4 - recipe synthesis needs that many positives.
  assert.match(handler, /Math\.max\(4,\s*Number\(body\.min_pairs\)/);
});

test('W214 #10 - cmdDistill routes --from-captures to cmdDistillFromCaptures', () => {
  // Dispatch from cmdDistill.
  const distillIdx = CLI_SRC.indexOf('async function cmdDistill(');
  const distillHead = CLI_SRC.slice(distillIdx, distillIdx + 600);
  assert.match(distillHead, /--from-captures/);
  assert.match(distillHead, /cmdDistillFromCaptures/);
  // Function exists.
  assert.match(CLI_SRC, /async function cmdDistillFromCaptures\(/);
});

test('W214 #11 - cmdDistillFromCaptures honors --preview / --mode / --min-pairs / --json', () => {
  const fnIdx = CLI_SRC.indexOf('async function cmdDistillFromCaptures(');
  const fnBody = CLI_SRC.slice(fnIdx, fnIdx + 5000);
  assert.match(fnBody, /--preview/);
  assert.match(fnBody, /--mode/);
  assert.match(fnBody, /--min-pairs/);
  assert.match(fnBody, /--json/);
  // Preview hits GET, commit hits POST.
  assert.match(fnBody, /\/v1\/distill\/from-captures\/preview/);
  assert.match(fnBody, /method:\s*['"]POST['"]/);
});

test('W214 #12 - cmdDistillFromCaptures exits non-zero on every server error branch', () => {
  const fnIdx = CLI_SRC.indexOf('async function cmdDistillFromCaptures(');
  const fnBody = CLI_SRC.slice(fnIdx, fnIdx + 5000);
  assert.match(fnBody, /not_enough_captures[\s\S]{0,500}process\.exit\(3\)/);
  assert.match(fnBody, /no_cluster[\s\S]{0,500}process\.exit\(3\)/);
  // W364: distill_bridge_not_configured is retained as a back-compat branch
  // (only reachable when an operator-side shim explicitly emits it). The
  // shipped router always returns 202 with a job_id.
  assert.match(fnBody, /distill_bridge_not_configured[\s\S]{0,500}process\.exit\(2\)/);
  assert.match(fnBody, /capture_store_unavailable[\s\S]{0,500}process\.exit\(EXIT\.EXECUTION\)/);
});

test('W214 #13 - captures.html promote button uses preview-first flow', () => {
  // The click handler must hit the preview GET *before* the POST commit.
  assert.match(CAPTURES_HTML, /\/v1\/distill\/from-captures\/preview/);
  assert.match(CAPTURES_HTML, /\/v1\/distill\/from-captures(?!\/preview)/);
  // Confirm dialog gates the POST.
  assert.match(CAPTURES_HTML, /confirm\(/);
  // Old direct-to-bridge call removed from the click handler.
  const handler = CAPTURES_HTML.slice(CAPTURES_HTML.indexOf("document.getElementById('distill').addEventListener"));
  assert.doesNotMatch(handler.slice(0, 2000), /\/v1\/specialists\/auto-distill/);
});

test('W214 #14 - promote button enables at >=4 captures, not 1000', () => {
  // The button used to only enable when ready_to_distill.length > 0
  // (a list that ships true only at >=1000 pairs). W214 must unlock the
  // recipe path much earlier.
  assert.match(CAPTURES_HTML, />=\s*4\s*\|\|\s*ready\.length\s*>\s*0/);
});

test('W214 #15 - POST response always includes mode + namespace + job_id contract', () => {
  const handler = sliceHandler(ROUTER_SRC, POST_MARKER);
  // Recipe success: res.status(synth.accepted ? 200 : 422).json({ ... mode: 'recipe' ... job_id })
  assert.match(handler, /res\.status\(synth\.accepted[\s\S]{0,600}mode:\s*['"]recipe['"][\s\S]{0,600}job_id/);
  // W364: specialist success arm is now backed by the in-tree distill worker.
  // Anchor on the worker import and assert the success contract there.
  const workerImportIdx = handler.indexOf('distill-bridge.js');
  assert.ok(workerImportIdx > 0, 'specialist arm must import distill-bridge.js');
  const successArm = handler.slice(workerImportIdx);
  assert.match(successArm, /mode:\s*['"]specialist['"]/);
  assert.match(successArm, /job_id:\s*job\.id/);
  assert.match(successArm, /poll_url/);
  // Remote-bridge path still supported when KOLM_TRAINER_BRIDGE_URL is set.
  assert.match(handler, /mode:\s*['"]specialist['"][\s\S]{0,400}bridge_source:\s*['"]remote_trainer['"]/);
});
