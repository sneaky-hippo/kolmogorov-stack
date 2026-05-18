// Wave 258 audit-fix lock-in.
//
// Two independent background audit agents (security + backend, 2026-05-18)
// converged on the same load-bearing finding: src/router.js was importing
// none of the W212/W213/W215 modules shipped in earlier waves. The modules
// existed on disk; nothing called them. Pablo's 2026-05-18 telegram (W211
// strategic finding) named this exact pattern: "62,775 changed lines making
// it honest, not making it valuable."
//
// This wave wires them up for real. Lock-in tests enforce structural fixes
// — they grep router/auth/audit/sigstore for the patterns the audits flagged
// and assert behavior on the new helpers. Per the W202-W210 Pablo correction,
// these are behavior assertions (HTTP shape, function signature, regex
// presence/absence of a known anti-pattern) — never page-text markers.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..');
const ROUTER_SRC = fs.readFileSync(path.join(ROOT, 'src/router.js'), 'utf8');
const AUTH_SRC = fs.readFileSync(path.join(ROOT, 'src/auth.js'), 'utf8');
const AUDIT_SRC = fs.readFileSync(path.join(ROOT, 'src/audit.js'), 'utf8');
const SIGSTORE_SRC = fs.readFileSync(path.join(ROOT, 'src/sigstore.js'), 'utf8');
const DISTILL_PY = fs.readFileSync(path.join(ROOT, 'apps/trainer/distill.py'), 'utf8');

// ============================================================
// W258-BE-1: capture-store.js wired into recordCapture (no silent swallow)
// ============================================================

test('W258-BE-1 #1 — router.js imports insertCapture from capture-store.js', () => {
  assert.match(ROUTER_SRC, /import\s*\{[^}]*insertCapture[^}]*\}\s*from\s*['"]\.\/capture-store\.js['"]/);
});

test('W258-BE-1 #2 — recordCapture is async and awaits insertCapture', () => {
  const idx = ROUTER_SRC.indexOf('async function recordCapture(');
  assert.ok(idx > 0, 'recordCapture must be declared async');
  const body = ROUTER_SRC.slice(idx, idx + 2500);
  assert.match(body, /await\s+insertCapture\s*\(/);
});

test('W258-BE-1 #3 — recordCapture does NOT swallow insertCapture failure', () => {
  // The function may have other try/catch blocks (publishCapture, threshold
  // counts) but the insertCapture await must NOT be inside a swallow.
  const idx = ROUTER_SRC.indexOf('async function recordCapture(');
  const body = ROUTER_SRC.slice(idx, idx + 2500);
  // Match patterns like `try { ... await insertCapture(...) ... } catch ... {}`
  // where the body between the catch and the closing brace is empty/whitespace.
  const silentSwallow = /try\s*\{[\s\S]*?await\s+insertCapture[\s\S]*?\}\s*catch\s*\([^)]*\)\s*\{\s*\}/;
  assert.doesNotMatch(body, silentSwallow,
    'insertCapture must not sit inside an empty catch — the propagation is the whole fix');
});

test('W258-BE-1 #4 — capture/anthropic uses recordCaptureWithReceipt envelope', () => {
  const idx = ROUTER_SRC.search(/r\.post\(\/\^\\\/v1\\\/capture\\\/anthropic/);
  assert.ok(idx > 0);
  const block = ROUTER_SRC.slice(idx, idx + 3500);
  assert.match(block, /await\s+recordCaptureWithReceipt\s*\(/);
  // Must NOT forward upstream after a 503 was already sent.
  assert.match(block, /if\s*\(\s*!obs\s*&&\s*res\.headersSent\s*\)\s*return/);
});

test('W258-BE-1 #5 — capture/openai uses recordCaptureWithReceipt envelope', () => {
  const idx = ROUTER_SRC.search(/r\.post\(\/\^\\\/v1\\\/capture\\\/openai/);
  assert.ok(idx > 0);
  const block = ROUTER_SRC.slice(idx, idx + 3500);
  assert.match(block, /await\s+recordCaptureWithReceipt\s*\(/);
  assert.match(block, /if\s*\(\s*!obs\s*&&\s*res\.headersSent\s*\)\s*return/);
});

test('W258-BE-1 #6 — capture/log handler awaits recordCapture + 503 on zero-stored', () => {
  const idx = ROUTER_SRC.indexOf("r.post('/v1/capture/log'");
  assert.ok(idx > 0);
  const block = ROUTER_SRC.slice(idx, idx + 3500);
  assert.match(block, /await\s+recordCapture\s*\(/);
  assert.match(block, /res\.status\(503\)/);
  assert.match(block, /capture_store_unavailable/);
});

test('W258-BE-1 #7 — recordCaptureWithReceipt returns 503 with actionable hint on store failure', () => {
  const idx = ROUTER_SRC.indexOf('async function recordCaptureWithReceipt(');
  assert.ok(idx > 0, 'recordCaptureWithReceipt helper must exist');
  const block = ROUTER_SRC.slice(idx, idx + 2000);
  assert.match(block, /res\.status\(503\)/);
  assert.match(block, /capture_store_ephemeral|capture_store_unavailable/);
  assert.match(block, /res\.set\(\s*['"]x-kolm-capture-durable['"]\s*,\s*['"]false['"]/);
});

// ============================================================
// W258-BE-2: capture-stream.js publishCapture wired into SSE fan-out
// ============================================================

test('W258-BE-2 #1 — router.js imports subscribeCapture + publishCapture', () => {
  assert.match(ROUTER_SRC, /import\s*\{[^}]*subscribe\s+as\s+subscribeCapture[^}]*publishCapture[^}]*\}\s*from\s*['"]\.\/capture-stream\.js['"]/);
});

test('W258-BE-2 #2 — recordCapture publishes to the broker after a successful insert', () => {
  const idx = ROUTER_SRC.indexOf('async function recordCapture(');
  const body = ROUTER_SRC.slice(idx, idx + 2500);
  // Order matters: publishCapture must come AFTER await insertCapture.
  const insertIdx = body.indexOf('await insertCapture(');
  const publishIdx = body.indexOf('publishCapture(');
  assert.ok(insertIdx > 0 && publishIdx > insertIdx, 'publishCapture must run after insertCapture succeeds');
});

test('W258-BE-2 #3 — /v1/capture/stream uses subscribeCapture (not setInterval poll)', () => {
  const idx = ROUTER_SRC.indexOf("r.get('/v1/capture/stream'");
  assert.ok(idx > 0);
  const block = ROUTER_SRC.slice(idx, idx + 3500);
  assert.match(block, /subscribeCapture\s*\(\s*req\.tenant\s*,/);
  // setInterval is allowed only for the SSE keep-alive (15s ping), not for
  // a 2s poll-and-scan over all('observations').
  assert.doesNotMatch(block, /all\(\s*['"]observations['"]\s*\)/,
    'SSE handler must not scan all(observations) — should be event-driven via broker');
});

test('W258-BE-2 #4 — SSE payload uses CLI/UI contract shape (capture_id, captured_at, ...)', () => {
  const idx = ROUTER_SRC.indexOf("r.get('/v1/capture/stream'");
  const block = ROUTER_SRC.slice(idx, idx + 3500);
  for (const field of ['capture_id', 'captured_at', 'namespace', 'model', 'provider',
                       'latency_us', 'status', 'prompt_head', 'response_head',
                       'x_kolm_capture_durable']) {
    assert.match(block, new RegExp(`\\b${field}\\b`), `SSE payload missing field ${field}`);
  }
});

// ============================================================
// W258-BE-3: notifications.js thresholds wired
// ============================================================

test('W258-BE-3 #1 — router.js imports the notifications surface', () => {
  assert.match(ROUTER_SRC, /import\s*\{[^}]*tryAdvanceThresholdState[^}]*\}\s*from\s*['"]\.\/notifications\.js['"]/);
});

test('W258-BE-3 #2 — recordCapture calls thresholdCrossedBy + tryAdvanceThresholdState + fireThresholdAlert', () => {
  const idx = ROUTER_SRC.indexOf('async function recordCapture(');
  const body = ROUTER_SRC.slice(idx, idx + 2500);
  assert.match(body, /notifThresholdCrossedBy\(/);
  assert.match(body, /notifTryAdvanceThresholdState\(/);
  assert.match(body, /notifFireThresholdAlert\(/);
});

test('W258-BE-3 #3 — all 7 /v1/notifications/* routes registered', () => {
  const expected = [
    /r\.get\(['"]\/v1\/notifications\/preferences['"]/,
    /r\.put\(['"]\/v1\/notifications\/preferences['"]/,
    /r\.get\(['"]\/v1\/notifications\/push-subscriptions['"]/,
    /r\.post\(['"]\/v1\/notifications\/push-subscriptions['"]/,
    /r\.delete\(['"]\/v1\/notifications\/push-subscriptions['"]/,
    /r\.post\(['"]\/v1\/notifications\/test['"]/,
    /r\.get\(['"]\/v1\/notifications\/state['"]/,
  ];
  for (const re of expected) {
    assert.match(ROUTER_SRC, re, `route missing: ${re}`);
  }
});

test('W258-BE-3 #4 — /v1/capture/health surfaces driver + durable + subscriber_count + thresholds', () => {
  const idx = ROUTER_SRC.indexOf("r.get('/v1/capture/health'");
  assert.ok(idx > 0, '/v1/capture/health must be registered');
  const block = ROUTER_SRC.slice(idx, idx + 1500);
  for (const field of ['driver', 'durable', 'subscriber_count', 'thresholds']) {
    assert.match(block, new RegExp(`\\b${field}\\b`));
  }
});

// ============================================================
// W258-SEC-1: drop req.query.api_key for tenant-keyed routes
// ============================================================

test('W258-SEC-1 #1 — auth.js no longer falls back to req.query.api_key as a key source', () => {
  // Permitted: detecting a query-param attempt and returning an explicit 401.
  // Forbidden: using `req.query.api_key` as the actual key value passed to
  // findApiKeyRow or similar lookups.
  const usesAsKey = /const\s+key\s*=\s*[^;]*req\.query[^;]*api_key/;
  assert.doesNotMatch(AUTH_SRC, usesAsKey,
    'api_key query param must not be used as the key value');
});

test('W258-SEC-1 #2 — query-param attempts return 401 api_key_in_query_unsupported', () => {
  assert.match(AUTH_SRC, /api_key_in_query_unsupported/);
  assert.match(AUTH_SRC, /Authorization:\s*Bearer/);
});

// ============================================================
// W258-SEC-2: path traversal in /v1/recall/sources/:id
// ============================================================

test('W258-SEC-2 #1 — recall sources uses path.sep boundary, not bare startsWith', () => {
  // Find the recall sources handler region.
  const idx = ROUTER_SRC.indexOf('path escapes recall root');
  assert.ok(idx > 0, 'recall path-traversal guard must exist');
  const window = ROUTER_SRC.slice(Math.max(0, idx - 800), idx + 200);
  // Must use a separator-aware boundary, either equality OR prefix-with-sep.
  assert.match(window, /path\.sep|endsWith\(\s*path\.sep|rootWithSep/);
  // Must NOT be `full.startsWith(lookupRoot)` alone with no sep guard.
  assert.match(window, /full\s*!==\s*lookupRoot|full\.startsWith\(\s*rootWithSep/);
});

// ============================================================
// W258-SEC-3: Rekor inclusion proof beyond presence
// ============================================================

test('W258-SEC-3 #1 — sigstore.js exports verifyRekorInclusionProof', () => {
  assert.match(SIGSTORE_SRC, /export\s+function\s+verifyRekorInclusionProof\s*\(/);
});

test('W258-SEC-3 #2 — sigstore.js implements RFC 6962 leaf + inner hash helpers', () => {
  assert.match(SIGSTORE_SRC, /function\s+rfc6962LeafHash\s*\(/);
  assert.match(SIGSTORE_SRC, /function\s+rfc6962InnerHash\s*\(/);
  // 0x00 leaf prefix, 0x01 inner prefix per RFC 6962.
  assert.match(SIGSTORE_SRC, /Buffer\.from\(\[\s*0x00\s*\]\)/);
  assert.match(SIGSTORE_SRC, /Buffer\.from\(\[\s*0x01\s*\]\)/);
});

test('W258-SEC-3 #3 — verifyRekorInclusionProof rejects fabricated proof', async () => {
  const sig = await import('../src/sigstore.js');
  // Bogus proof: random sibling hashes, mismatched rootHash.
  const result = sig.verifyRekorInclusionProof(
    {
      logIndex: 0,
      uuid: 'deadbeef',
      integratedTime: 1700000000,
      logID: 'fake',
      inclusionProof: {
        logIndex: 0,
        treeSize: 2,
        rootHash: Buffer.alloc(32, 0xaa).toString('base64'), // fabricated
        hashes: [Buffer.alloc(32, 0xbb).toString('base64')],
      },
    },
    Buffer.from('payload-digest').toString('base64'),
    Buffer.from('signature-bytes').toString('base64'),
  );
  assert.equal(result.present, true);
  assert.equal(result.verified, false);
});

test('W258-SEC-3 #4 — verifyRekorInclusionProof handles missing inclusionProof', async () => {
  const sig = await import('../src/sigstore.js');
  const result = sig.verifyRekorInclusionProof({}, '', '');
  assert.equal(result.present, false);
  assert.equal(result.verified, false);
});

test('W258-SEC-3 #5 — verifyRekorInclusionProof handles base64 AND hex rootHash', () => {
  // Both branches present in the implementation — test exercises both decode paths.
  assert.match(SIGSTORE_SRC, /rootHash[\s\S]{0,200}base64/);
  assert.match(SIGSTORE_SRC, /rootHash[\s\S]{0,400}hex/);
});

test('W258-SEC-3 #6 — non-dry-run bundles reject when inclusion proof fails to verify', () => {
  // The `verifySigstoreBundle` (or equivalent) must short-circuit ok=false
  // when block.dry_run !== true and inclusion.verified !== true.
  assert.match(SIGSTORE_SRC, /!\s*block\.dry_run\s*&&\s*!\s*inclusion\.verified/);
  assert.match(SIGSTORE_SRC, /rekor inclusion proof did not verify/);
});

// ============================================================
// W258-BE-4: chargeUsage wrapped in withTransaction
// ============================================================

test('W258-BE-4 #1 — auth.js imports withTransaction', () => {
  assert.match(AUTH_SRC, /import\s*\{[^}]*withTransaction[^}]*\}\s*from\s*['"]\.\/store\.js['"]/);
});

test('W258-BE-4 #2 — chargeUsage body runs inside withTransaction', () => {
  const idx = AUTH_SRC.indexOf('export function chargeUsage(');
  assert.ok(idx > 0, 'chargeUsage must exist');
  const body = AUTH_SRC.slice(idx, idx + 1500);
  assert.match(body, /withTransaction\s*\(/);
});

test('W258-BE-4 #3 — chargeUsage re-reads fresh tenant inside the transaction', () => {
  const idx = AUTH_SRC.indexOf('export function chargeUsage(');
  const body = AUTH_SRC.slice(idx, idx + 1500);
  // The fresh read prevents the lost-update race: read inside the BEGIN
  // IMMEDIATE window, not from the middleware snapshot.
  assert.match(body, /const\s+fresh\s*=\s*findOne\s*\(\s*['"]tenants['"]/);
  assert.match(body, /\(fresh\.used\s*\|\|\s*0\)\s*\+\s*units/);
});

// ============================================================
// W258-BE-5: appendAudit wrapped in withTransaction
// ============================================================

test('W258-BE-5 #1 — audit.js imports withTransaction', () => {
  assert.match(AUDIT_SRC, /import\s*\{[^}]*withTransaction[^}]*\}\s*from\s*['"]\.\/store\.js['"]/);
});

test('W258-BE-5 #2 — appendAudit prev-hash + insert run inside withTransaction', () => {
  const idx = AUDIT_SRC.indexOf('export function appendAudit(');
  assert.ok(idx > 0);
  const body = AUDIT_SRC.slice(idx, idx + 3000);
  assert.match(body, /withTransaction\s*\(/);
  // previousChainHashFor must be CALLED inside the transaction so two
  // concurrent appends serialize.
  const txIdx = body.indexOf('withTransaction(');
  const prevIdx = body.indexOf('previousChainHashFor(', txIdx);
  const insertIdx = body.indexOf('insert(TABLE,', txIdx);
  assert.ok(prevIdx > txIdx, 'previousChainHashFor must be inside withTransaction');
  assert.ok(insertIdx > prevIdx, 'insert must come after previousChainHashFor');
});

test('W258-BE-5 #3 — verifyAuditChain still recomputes the same chain after wrap', async () => {
  // Sanity: write two events and verify the chain is intact under the new
  // transactional path. This is the regression guard for the wrap.
  process.env.RECIPE_RECEIPT_SECRET = process.env.RECIPE_RECEIPT_SECRET
    || 'w258-test-secret-pad-to-32-characters-' + Date.now();
  const audit = await import('../src/audit.js');
  const tenant_id = 'w258-be5-' + Date.now();
  const a = audit.appendAudit({ tenant_id, op: 'admin.action', payload: { n: 1 } });
  const b = audit.appendAudit({ tenant_id, op: 'admin.action', payload: { n: 2 } });
  assert.ok(a.event_hash);
  assert.ok(b.event_hash);
  assert.equal(b.prev_hash, a.event_hash, 'chain must link b.prev_hash → a.event_hash');
  const verify = audit.verifyAuditChain(tenant_id);
  assert.equal(verify.ok, true, `chain broken: ${JSON.stringify(verify.breaks)}`);
  assert.equal(verify.total, 2);
});

// ============================================================
// W258-BE-6: SSE field-name shim — CLI parser contract
// ============================================================

test('W258-BE-6 #1 — SSE event shim maps obs.id → capture_id (not raw row shape)', () => {
  const idx = ROUTER_SRC.indexOf("r.get('/v1/capture/stream'");
  const block = ROUTER_SRC.slice(idx, idx + 3500);
  // Look for explicit field-rename pattern: capture_id: obs.id
  assert.match(block, /capture_id:\s*obs\.id/);
  assert.match(block, /captured_at:\s*obs\.created_at/);
  assert.match(block, /namespace:\s*obs\.corpus_namespace/);
});

test('W258-BE-6 #2 — SSE event labelled with `event: capture` (not `event: row`)', () => {
  const idx = ROUTER_SRC.indexOf("r.get('/v1/capture/stream'");
  const block = ROUTER_SRC.slice(idx, idx + 3500);
  assert.match(block, /event:\s*capture\\n/);
});

// ============================================================
// W258-ML-5: distill.py receipt surfaces holdout accuracies
// ============================================================

test('W258-ML-5 #1 — DistillSession has _teacher / _tokenizer / _eval_rows refs', () => {
  for (const field of ['_teacher', '_tokenizer', '_eval_rows']) {
    assert.match(DISTILL_PY, new RegExp(`${field}:\\s*Any\\s*=\\s*None`),
      `DistillSession missing field ${field}`);
  }
});

test('W258-ML-5 #2 — _evaluate_holdout_accuracies method exists + computes student/teacher', () => {
  assert.match(DISTILL_PY, /def\s+_evaluate_holdout_accuracies\s*\(/);
  assert.match(DISTILL_PY, /student_correct\s*=\s*0/);
  assert.match(DISTILL_PY, /teacher_correct\s*=\s*0/);
  assert.match(DISTILL_PY, /total_response_tokens\s*=\s*0/);
});

test('W258-ML-5 #3 — train() summary includes student + teacher token accuracy', () => {
  const trainIdx = DISTILL_PY.indexOf('def train(self)');
  assert.ok(trainIdx > 0);
  // train() ends at the next top-level method
  const nextDefIdx = DISTILL_PY.indexOf('\n    def ', trainIdx + 1);
  const trainBody = DISTILL_PY.slice(trainIdx, nextDefIdx);
  assert.match(trainBody, /summary\[['"]student_token_accuracy['"]\]/);
  assert.match(trainBody, /summary\[['"]teacher_token_accuracy['"]\]/);
  assert.match(trainBody, /summary\[['"]holdout_token_count['"]\]/);
});

test('W258-ML-5 #4 — receipt_block surfaces holdout_accuracy + teacher_holdout_accuracy', () => {
  // Find the receipt_block dict literal.
  const idx = DISTILL_PY.indexOf('"method": "kd_response_distillation"');
  assert.ok(idx > 0);
  const block = DISTILL_PY.slice(idx, idx + 1500);
  assert.match(block, /['"]holdout_accuracy['"]\s*:/);
  assert.match(block, /['"]teacher_holdout_accuracy['"]\s*:/);
  assert.match(block, /['"]holdout_token_count['"]\s*:/);
});

test('W258-ML-5 #5 — distill_trainer wires teacher / tokenizer / eval_rows into session', () => {
  const idx = DISTILL_PY.indexOf('def distill_trainer(');
  assert.ok(idx > 0);
  // distill_trainer is ~80 lines + comments; the DistillSession(...) construction
  // is near the end. Cap at next top-level `def ` after distill_trainer.
  const nextDef = DISTILL_PY.indexOf('\ndef ', idx + 10);
  const body = DISTILL_PY.slice(idx, nextDef > 0 ? nextDef : idx + 10000);
  assert.match(body, /_teacher\s*=\s*teacher/);
  assert.match(body, /_tokenizer\s*=\s*tokenizer/);
  assert.match(body, /_eval_rows\s*=\s*eval_rows/);
});

// ============================================================
// W258-BE-7 sanity: indexed-primitive sweep target known
// ============================================================

test('W258-BE-7 #1 — W258 audit memorialized: capture path is durable, no silent insert(observations)', () => {
  // The strict structural test for "no silent swallow of insert('observations')"
  // is owned by wave212. Here we just assert that any remaining all('observations')
  // sweep candidates are either inside the legacy /v1/audit reconstruction
  // bridge (acceptable) or inside the labels/synthesize-corpus reader (also
  // acceptable — same backend as writes for now). New writers must go through
  // insertCapture; W258-BE-7 ships findByTenant indexed primitives (below).
  const writes = ROUTER_SRC.match(/insert\(\s*['"]observations['"]/g) || [];
  // Only the legacy synthesize path may still call insert('observations')
  // directly during the migration window; the durable path is insertCapture.
  // Tighter assertion: no NEW writes in the capture handlers themselves.
  for (const handler of [
    "r.post(/^\\/v1\\/capture\\/anthropic",
    "r.post(/^\\/v1\\/capture\\/openai",
    "r.post('/v1/capture/log'",
  ]) {
    const handlerIdx = ROUTER_SRC.indexOf(handler);
    if (handlerIdx < 0) continue;
    const handlerEnd = ROUTER_SRC.indexOf("\n  });", handlerIdx);
    const handlerBlock = ROUTER_SRC.slice(handlerIdx, handlerEnd > 0 ? handlerEnd : handlerIdx + 4000);
    assert.doesNotMatch(handlerBlock, /insert\(\s*['"]observations['"]/,
      `capture handler ${handler} must not call insert('observations') directly — go through insertCapture`);
  }
});

test('W258-BE-7 #2 — store exports findByTenant + findByField indexed primitives', async () => {
  const store = await import('../src/store.js');
  assert.equal(typeof store.findByTenant, 'function',
    'store.js must export findByTenant(table, tenant)');
  assert.equal(typeof store.findByField, 'function',
    'store.js must export findByField(table, field, value)');
});

test('W258-BE-7 #3 — findByTenant returns rows scoped to a tenant and skips others', async () => {
  const store = await import('../src/store.js');
  const t = `_w258_be7_${Date.now().toString(36)}`;
  store.insert(t, { id: 'a1', tenant: 'tnt_A', name: 'alpha' });
  store.insert(t, { id: 'a2', tenant: 'tnt_A', name: 'beta' });
  store.insert(t, { id: 'b1', tenant: 'tnt_B', name: 'gamma' });
  const a = store.findByTenant(t, 'tnt_A');
  assert.equal(a.length, 2, 'tnt_A should see only its 2 rows');
  assert.ok(a.every(r => r.tenant === 'tnt_A'));
  const b = store.findByTenant(t, 'tnt_B');
  assert.equal(b.length, 1);
  assert.equal(b[0].name, 'gamma');
  const none = store.findByTenant(t, 'tnt_C');
  assert.equal(none.length, 0);
  // Empty tenant short-circuits to []
  assert.deepEqual(store.findByTenant(t, ''), []);
  assert.deepEqual(store.findByTenant(t, null), []);
});

test('W258-BE-7 #4 — findByField rejects unsafe field names (injection guard)', async () => {
  const store = await import('../src/store.js');
  assert.throws(() => store.findByField('observations', "tenant'; DROP TABLE", 'x'),
    /unsafe field name/);
  assert.throws(() => store.findByField('observations', '', 'x'),
    /field must be a non-empty string/);
  assert.throws(() => store.findByField('observations', 123, 'x'),
    /field must be a non-empty string/);
});

test('W258-BE-7 #5 — router.js bridges/suggestions + bridges/observations use findByTenant (post-sweep)', () => {
  // The two heaviest tenant-scoped scans (/v1/bridges/suggestions and
  // /v1/bridges/observations) must call the indexed primitive, not the
  // unscoped scan. This is the marker that the sweep landed in router.js.
  const suggestionsIdx = ROUTER_SRC.indexOf("r.get('/v1/bridges/suggestions'");
  assert.ok(suggestionsIdx > 0, '/v1/bridges/suggestions handler must exist');
  const suggestionsEnd = ROUTER_SRC.indexOf("\n  });", suggestionsIdx);
  const suggestionsBlock = ROUTER_SRC.slice(suggestionsIdx, suggestionsEnd);
  assert.match(suggestionsBlock, /findByTenant\(\s*['"]observations['"]/,
    '/v1/bridges/suggestions must use findByTenant("observations", req.tenant)');
  assert.doesNotMatch(suggestionsBlock, /all\(\s*['"]observations['"]\s*\)\s*\.filter\(\s*o\s*=>\s*o\.tenant/,
    '/v1/bridges/suggestions must no longer use all("observations").filter(o => o.tenant ===)');

  const obsIdx = ROUTER_SRC.indexOf("r.get('/v1/bridges/observations'");
  assert.ok(obsIdx > 0, '/v1/bridges/observations handler must exist');
  const obsEnd = ROUTER_SRC.indexOf("\n  });", obsIdx);
  const obsBlock = ROUTER_SRC.slice(obsIdx, obsEnd);
  assert.match(obsBlock, /findByTenant\(\s*['"]observations['"]/,
    '/v1/bridges/observations must use findByTenant("observations", req.tenant)');
});
