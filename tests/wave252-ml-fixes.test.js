// Wave 252: ML correctness fixes surfaced by an independent audit.
//
// Seven bugs were fixed in this wave; each test below pins one of them so
// future refactors cannot silently re-open the hole. Citations on each test
// point back to the bug number from the audit memo.
//
//   Bug 1 — src/artifact.js buildPayload did not actually enforce the K-score
//           0.85 ship gate despite the comment. Now throws unless
//           allow_below_gate=true (in which case the manifest stamps
//           ship_gate_overridden:true).
//   Bug 2 — apps/trainer/distill.py used a deterministic tail/head split that
//           was BIASED whenever input JSONL was sorted. Now uses
//           random.seed(cfg.seed) + random.shuffle(rows). Test exercises
//           --help and --print-config via subprocess.
//   Bug 3 — src/recipe-class.js validateRecipeClass accepted distilled_model
//           recipes whose weights_file pointed at a 0-byte file. Now
//           fs.statSync the file and reject size===0.
//   Bug 4 — src/kscore.js silently redistributed T axis weight when the
//           teacher_holdout_accuracy was missing on a distilled_model with
//           teacher_vendor. Now emits a T_axis_unverifiable warning; throws
//           when input.strict_teacher_fidelity is set.
//   Bug 5 — src/recipe-class.js inferRecipeClass did not detect the ambiguous
//           shape where both teacher_vendor (=> synthesized_rule) and
//           weights_file (=> distilled_model) are present. Now throws.
//   Bug 6 — src/external-holdout.js validateCatalogEntry accepted entries
//           without expected_sha256. Now expected_sha256 is REQUIRED.
//   Bug 7 — src/drift-supersession.js detectDrift compared snapshots without
//           checking that both were built under the same K-score spec.
//           Now throws when baseline and current k_score.spec differ.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

// Make the artifact module's signer happy without touching prod secrets.
process.env.RECIPE_RECEIPT_SECRET = process.env.RECIPE_RECEIPT_SECRET || 'wave252-test-secret-32-characters-long';

const ROOT = path.resolve(import.meta.dirname, '..');

// ---------- Bug 1: K-score ship gate enforced ----------

test('W252 #1a - buildPayload throws when k_score.ships !== true and override not set', async () => {
  const A = await import('../src/artifact.js');
  const subGateKscore = {
    composite: 0.70,
    ships: false,
    gate: 0.85,
    spec: 'k-score-1',
  };
  assert.throws(() => {
    A.buildPayload({
      job_id: 'wave252-gate-throw',
      task: 'classify',
      base_model: 'rule',
      recipes: [{ id: 'r0', kind: 'rule', src: 'function x(i){return i}' }],
      training_stats: { pass_rate_positive: 0.7 },
      evals: { coverage: 0.7 },
      k_score: subGateKscore,
    });
  }, /k_score below ship gate.*0\.7/);
});

test('W252 #1b - buildPayload accepts allow_below_gate=true and stamps ship_gate_overridden', async () => {
  const A = await import('../src/artifact.js');
  const subGateKscore = {
    composite: 0.70,
    ships: false,
    gate: 0.85,
    spec: 'k-score-1',
  };
  const payload = A.buildPayload({
    job_id: 'wave252-gate-override',
    task: 'classify',
    base_model: 'rule',
    recipes: [{ id: 'r0', kind: 'rule', src: 'function x(i){return i}' }],
    training_stats: { pass_rate_positive: 0.7 },
    evals: { coverage: 0.7 },
    k_score: subGateKscore,
    allow_below_gate: true,
  });
  assert.equal(payload.manifest.ship_gate_overridden, true,
    'manifest must record the override so downstream verifiers can flag it');
});

test('W252 #1c - buildPayload with passing k_score does NOT stamp ship_gate_overridden', async () => {
  const A = await import('../src/artifact.js');
  const passKscore = {
    composite: 0.92,
    ships: true,
    gate: 0.85,
    spec: 'k-score-1',
  };
  const payload = A.buildPayload({
    job_id: 'wave252-gate-pass',
    task: 'classify',
    base_model: 'rule',
    recipes: [{ id: 'r0', kind: 'rule', src: 'function x(i){return i}' }],
    training_stats: { pass_rate_positive: 0.95 },
    evals: { coverage: 0.95 },
    k_score: passKscore,
  });
  assert.notEqual(payload.manifest.ship_gate_overridden, true,
    'passing artifact must not carry the override flag');
});

test('W252 #1d - cli/kolm.js routes --allow-below-gate + maps gate error to EXIT.GATE_FAIL (=2)', () => {
  const cli = fs.readFileSync(path.join(ROOT, 'cli/kolm.js'), 'utf8');
  assert.match(cli, /--allow-below-gate/, 'cmdCompile must accept --allow-below-gate flag');
  assert.match(cli, /allow_below_gate/, 'flag must thread through to compileSpec opts');
  assert.match(cli, /k_score below ship gate/, 'cli must pattern-match the gate error');
  assert.match(cli, /EXIT\.GATE_FAIL/, 'gate error must map to EXIT.GATE_FAIL exit code');
});

// ---------- Bug 2: distill.py shuffle-split + receipt seed + main() ----------

test('W252 #2a - distill.py uses random.shuffle on rows, not tail/head slice', () => {
  const src = fs.readFileSync(path.join(ROOT, 'apps/trainer/distill.py'), 'utf8');
  assert.match(src, /random\.seed\(cfg\.seed\)/, 'must seed PRNG with cfg.seed');
  assert.match(src, /random\.shuffle\(rows\)/, 'must shuffle in place before splitting');
  // After the fix the shuffle must precede the actual code-line split. The
  // pre-fix audit had no shuffle at all; the post-fix code has the shuffle
  // calls (lines ~386-387) preceding the split assignment (line ~389).
  const seedIdx = src.indexOf('random.seed(cfg.seed)');
  const shuffleIdx = src.indexOf('random.shuffle(rows)');
  // The split-assignment line — look for the exact RHS pair.
  const splitIdx = src.indexOf('rows[:-cut], rows[-cut:]');
  assert.ok(seedIdx > 0, 'random.seed call must exist');
  assert.ok(shuffleIdx > seedIdx, 'shuffle must come after seed');
  assert.ok(splitIdx > shuffleIdx, `split must come after shuffle (split=${splitIdx}, shuffle=${shuffleIdx})`);
});

test('W252 #2b - distill.py validates non-empty train AND eval sides of split', () => {
  const src = fs.readFileSync(path.join(ROOT, 'apps/trainer/distill.py'), 'utf8');
  assert.match(src, /len\(rows\) == 0 or len\(eval_rows\) == 0/,
    'must refuse degenerate splits where either side is empty');
  assert.match(src, /train\/eval split produced empty side/,
    'error message must mention degenerate split');
});

test('W252 #2c - receipt_block surfaces seed at top level for reproducibility', () => {
  const src = fs.readFileSync(path.join(ROOT, 'apps/trainer/distill.py'), 'utf8');
  // The seed must appear OUTSIDE the cfg dict (cfg already carries it; this
  // is a courtesy hoist so receipt scanners see it without descending).
  assert.match(src, /"seed":\s*int\(session\.config\.seed\)/,
    'receipt_block must include "seed" as a top-level field');
});

test('W252 #2d - distill.py --help loads successfully and exits 0', () => {
  const r = spawnSync('python', [path.join(ROOT, 'apps/trainer/distill.py'), '--help'], {
    encoding: 'utf8',
    timeout: 30_000,
  });
  if (r.error && r.error.code === 'ENOENT') {
    // Skip if python not on PATH; the static text check above still covers
    // the structural shape of the file.
    return;
  }
  assert.equal(r.status, 0, `--help must exit 0; got ${r.status}, stderr=${r.stderr}`);
  assert.match(r.stdout, /--teacher-model/, '--help must enumerate --teacher-model');
  assert.match(r.stdout, /--student-model/, '--help must enumerate --student-model');
  assert.match(r.stdout, /--seed/, '--help must enumerate --seed');
  assert.match(r.stdout, /--eval-split/, '--help must enumerate --eval-split');
});

test('W252 #2e - distill.py --print-config emits valid JSON containing user-supplied seed', () => {
  const r = spawnSync('python', [
    path.join(ROOT, 'apps/trainer/distill.py'),
    '--print-config', '--seed', '1337', '--eval-split', '0.1',
  ], { encoding: 'utf8', timeout: 30_000 });
  if (r.error && r.error.code === 'ENOENT') return; // python missing → skip
  assert.equal(r.status, 0, `--print-config must exit 0; stderr=${r.stderr}`);
  const cfg = JSON.parse(r.stdout);
  assert.equal(cfg.seed, 1337, 'config must reflect --seed override');
  assert.equal(cfg.eval_split, 0.1, 'config must reflect --eval-split override');
});

// ---------- Bug 3: 0-byte weights file rejected ----------

test('W252 #3a - validateRecipeClass rejects distilled_model with 0-byte weights file', async () => {
  const RC = await import('../src/recipe-class.js');
  const tmp = path.join(os.tmpdir(), `wave252-empty-weights-${process.pid}.gguf`);
  fs.writeFileSync(tmp, '');
  try {
    assert.equal(fs.statSync(tmp).size, 0, 'sanity: file is 0 bytes');
    assert.throws(() => {
      RC.validateRecipeClass({
        id: 'empty-distilled',
        class: 'distilled_model',
        weights_file: tmp,
        teacher_vendor: 'anthropic.claude',
      });
    }, /weights file is empty.*0 bytes/);
  } finally {
    try { fs.unlinkSync(tmp); } catch {}
  }
});

test('W252 #3b - validateRecipeClass rejects distilled_model with missing weights file', async () => {
  const RC = await import('../src/recipe-class.js');
  const missing = path.join(os.tmpdir(), `wave252-missing-${process.pid}-${Date.now()}.gguf`);
  // Make sure it does not exist.
  try { fs.unlinkSync(missing); } catch {}
  assert.throws(() => {
    RC.validateRecipeClass({
      id: 'absent-distilled',
      class: 'distilled_model',
      weights_file: missing,
      teacher_vendor: 'anthropic.claude',
    });
  }, /weights file does not exist/);
});

test('W252 #3c - validateRecipeClass accepts distilled_model with non-empty weights file', async () => {
  const RC = await import('../src/recipe-class.js');
  const tmp = path.join(os.tmpdir(), `wave252-real-weights-${process.pid}.gguf`);
  fs.writeFileSync(tmp, Buffer.from('GGUF\0\0\0\0fake-but-nonempty'));
  try {
    const c = RC.validateRecipeClass({
      id: 'good-distilled',
      class: 'distilled_model',
      weights_file: tmp,
      teacher_vendor: 'anthropic.claude',
    });
    assert.equal(c, 'distilled_model');
  } finally {
    try { fs.unlinkSync(tmp); } catch {}
  }
});

// ---------- Bug 4: T axis unverifiable warning + strict mode ----------

test('W252 #4a - computeKScore emits T_axis_unverifiable warning when teacher_holdout missing', async () => {
  const KS = await import('../src/kscore.js');
  const ks = KS.computeKScore({
    accuracy: 0.95,
    coverage: 0.95,
    size_bytes: 50000,
    p50_latency_us: 100,
    cost_usd_per_call: 0,
    holdout_accuracy: 0.93,
    // teacher_holdout_accuracy intentionally absent
    recipe_class: 'distilled_model',
    teacher_vendor: 'anthropic.claude',
    teacher_model: 'claude-3.7-sonnet',
  });
  assert.ok(Array.isArray(ks.warnings), 'k_score must carry warnings array');
  const t = ks.warnings.find(w => w && w.code === 'T_axis_unverifiable');
  assert.ok(t, 'must include T_axis_unverifiable warning');
  assert.match(t.message, /teacher_holdout_accuracy not provided/);
});

test('W252 #4b - strict_teacher_fidelity throws when teacher_holdout missing', async () => {
  const KS = await import('../src/kscore.js');
  assert.throws(() => {
    KS.computeKScore({
      accuracy: 0.95,
      coverage: 0.95,
      size_bytes: 50000,
      p50_latency_us: 100,
      cost_usd_per_call: 0,
      holdout_accuracy: 0.93,
      recipe_class: 'distilled_model',
      teacher_vendor: 'anthropic.claude',
      strict_teacher_fidelity: true,
    });
  }, /strict-teacher-fidelity:.*teacher_holdout_accuracy not provided/);
});

test('W252 #4c - no warning when artifact is a plain rule (no teacher claim)', async () => {
  const KS = await import('../src/kscore.js');
  const ks = KS.computeKScore({
    accuracy: 0.95,
    coverage: 0.95,
    size_bytes: 5000,
    p50_latency_us: 50,
    cost_usd_per_call: 0,
    recipe_class: 'rule',
  });
  const warnings = ks.warnings || [];
  assert.equal(
    warnings.filter(w => w && w.code === 'T_axis_unverifiable').length,
    0,
    'rule-class artifact must not emit T_axis_unverifiable'
  );
});

test('W252 #4d - no warning when teacher_holdout_accuracy IS supplied', async () => {
  const KS = await import('../src/kscore.js');
  const ks = KS.computeKScore({
    accuracy: 0.95,
    coverage: 0.95,
    size_bytes: 50000,
    p50_latency_us: 100,
    cost_usd_per_call: 0,
    holdout_accuracy: 0.93,
    teacher_holdout_accuracy: 0.96,
    recipe_class: 'distilled_model',
    teacher_vendor: 'anthropic.claude',
  });
  const warnings = ks.warnings || [];
  assert.equal(
    warnings.filter(w => w && w.code === 'T_axis_unverifiable').length,
    0,
    'supplying teacher_holdout_accuracy must suppress the warning'
  );
});

// ---------- Bug 5: ambiguous recipe shape rejected ----------

test('W252 #5a - inferRecipeClass throws when both teacher_vendor and weights_file are set', async () => {
  const RC = await import('../src/recipe-class.js');
  assert.throws(() => {
    RC.inferRecipeClass({
      id: 'ambiguous-r0',
      teacher_vendor: 'anthropic.claude',
      weights_file: '/tmp/somefile.gguf',
    });
  }, /recipe class ambiguous.*teacher_vendor.*weights_file/);
});

test('W252 #5b - inferRecipeClass still works for unambiguous shapes', async () => {
  const RC = await import('../src/recipe-class.js');
  assert.equal(RC.inferRecipeClass({ id: 'r0' }), 'rule');
  assert.equal(RC.inferRecipeClass({ id: 'r0', teacher_vendor: 'anthropic.claude' }), 'synthesized_rule');
  assert.equal(RC.inferRecipeClass({ id: 'r0', weights_file: '/tmp/m.gguf' }), 'distilled_model');
  assert.equal(RC.inferRecipeClass({ id: 'r0', compiled_targets: { linux_x86_64: 'sha:abc' } }), 'compiled_rule');
});

test('W252 #5c - inferRecipeClass also catches synthesized_by + weights_file pair', async () => {
  const RC = await import('../src/recipe-class.js');
  assert.throws(() => {
    RC.inferRecipeClass({
      id: 'ambiguous-r1',
      synthesized_by: 'openai.gpt',
      gguf_file: '/tmp/m.gguf',
    });
  }, /recipe class ambiguous/);
});

// ---------- Bug 6: external holdout catalog requires expected_sha256 ----------

test('W252 #6a - validateCatalogEntry throws when expected_sha256 is missing', async () => {
  const EH = await import('../src/external-holdout.js');
  assert.throws(() => {
    EH.validateCatalogEntry({
      name: 'unverified-corpus',
      kind: 'external',
      file: 'holdouts/external/foo.jsonl',
      license: 'CC0-1.0',
      source_url: 'https://example.org/corpus',
      accessed_at: '2026-05-18',
      // expected_sha256 intentionally absent
    });
  }, /missing required expected_sha256/);
});

test('W252 #6b - validateCatalogEntry throws when expected_sha256 is empty string', async () => {
  const EH = await import('../src/external-holdout.js');
  assert.throws(() => {
    EH.validateCatalogEntry({
      name: 'empty-hash-corpus',
      kind: 'external',
      file: 'holdouts/external/foo.jsonl',
      license: 'CC0-1.0',
      source_url: 'https://example.org/corpus',
      accessed_at: '2026-05-18',
      expected_sha256: '',
    });
  }, /missing required expected_sha256/);
});

test('W252 #6c - validateCatalogEntry accepts entry with expected_sha256 present', async () => {
  const EH = await import('../src/external-holdout.js');
  // Should not throw.
  EH.validateCatalogEntry({
    name: 'good-corpus',
    kind: 'external',
    file: 'holdouts/external/foo.jsonl',
    license: 'CC0-1.0',
    source_url: 'https://example.org/corpus',
    accessed_at: '2026-05-18',
    expected_sha256: 'a'.repeat(64),
  });
});

test('W252 #6d - shipped holdouts/catalog.json has expected_sha256 on every entry', () => {
  const cat = JSON.parse(fs.readFileSync(path.join(ROOT, 'holdouts/catalog.json'), 'utf8'));
  assert.ok(Array.isArray(cat.holdouts) && cat.holdouts.length > 0, 'catalog has entries');
  for (const entry of cat.holdouts) {
    assert.ok(typeof entry.expected_sha256 === 'string' && entry.expected_sha256.length === 64,
      `entry '${entry.name}' must have 64-char expected_sha256`);
  }
});

// ---------- Bug 7: drift detection refuses mismatched K-score specs ----------

test('W252 #7a - detectDrift throws when baseline and current have different k_score.spec', async () => {
  const DS = await import('../src/drift-supersession.js');
  const artifactHash = 'a'.repeat(64);
  const baseSnap = DS.buildDriftSnapshot({
    artifact_hash: artifactHash,
    captured_at: '2026-05-01T00:00:00Z',
    eval_score: 0.93,
    k_score: { composite: 0.91, spec: 'k-score-1' },
  });
  const curSnap = DS.buildDriftSnapshot({
    artifact_hash: artifactHash,
    captured_at: '2026-05-18T00:00:00Z',
    eval_score: 0.92,
    k_score: { composite: 0.90, spec: 'k-score-2' },
  });
  assert.throws(() => DS.detectDrift(baseSnap, curSnap),
    /drift comparison invalid.*k-score-1.*k-score-2/);
});

test('W252 #7b - detectDrift succeeds when baseline and current share the same k_score.spec', async () => {
  const DS = await import('../src/drift-supersession.js');
  const artifactHash = 'b'.repeat(64);
  const baseSnap = DS.buildDriftSnapshot({
    artifact_hash: artifactHash,
    captured_at: '2026-05-01T00:00:00Z',
    eval_score: 0.93,
    k_score: { composite: 0.91, spec: 'k-score-2' },
  });
  const curSnap = DS.buildDriftSnapshot({
    artifact_hash: artifactHash,
    captured_at: '2026-05-18T00:00:00Z',
    eval_score: 0.92,
    k_score: { composite: 0.90, spec: 'k-score-2' },
  });
  // detectDrift returns the signals array directly.
  const signals = DS.detectDrift(baseSnap, curSnap);
  assert.ok(Array.isArray(signals), 'signals array returned');
  assert.ok(signals.length > 0, 'at least one signal');
  // Sanity: eval_score and k_score.composite axes should both be present.
  const axes = signals.map(s => s.axis);
  assert.ok(axes.includes('eval_score'), `eval_score axis present (got ${axes.join(', ')})`);
  assert.ok(axes.includes('k_score.composite'), `k_score.composite axis present (got ${axes.join(', ')})`);
});

test('W252 #7c - buildDriftSnapshot captures k_score.spec into the snapshot', async () => {
  const DS = await import('../src/drift-supersession.js');
  const snap = DS.buildDriftSnapshot({
    artifact_hash: 'c'.repeat(64),
    captured_at: '2026-05-18T00:00:00Z',
    k_score: { composite: 0.91, spec: 'k-score-2' },
  });
  assert.equal(snap.k_score.spec, 'k-score-2', 'snapshot must round-trip k_score.spec');
});
