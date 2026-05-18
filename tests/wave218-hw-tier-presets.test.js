// Wave 218: hardware-tier presets. `kolm compile --tier=<slug>` auto-picks
// a frontier base model + recommended quant from src/model-registry.js
// (W217), and `kolm doctor --detect-hw` recommends a tier slug by reading
// nvidia-smi / system_profiler. Behavior assertions only (no page-text).
//
// Contract:
//   1. resolveTier() returns the lowest-VRAM frontier model for the tier.
//   2. resolveTier() returns null for unknown tiers.
//   3. resolveTier() supports modality + arch filtering when multiple
//      candidates exist.
//   4. detectTierFromGpuName() maps common GPU names to tier slugs.
//   5. cmdCompile parses --tier and appends --base-model + sets KOLM_*
//      env vars when --base-model is not explicitly set.
//   6. cmdCompile leaves --base-model alone when both --tier and
//      --base-model are passed (explicit override wins).
//   7. cmdDoctor --detect-hw path is wired with detectHardware() helper
//      and exits 3 when no confident tier match.
//   8. sw.js CACHE wave-floor >= 218.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..');
const CLI_SRC = fs.readFileSync(path.join(ROOT, 'cli/kolm.js'), 'utf8');
const SW_JS = fs.readFileSync(path.join(ROOT, 'public/sw.js'), 'utf8');

test('W218 #1 - resolveTier returns frontier pick for a known tier', async () => {
  const R = await import('../src/model-registry.js');
  const out = R.resolveTier('3090');
  assert.ok(out, 'resolveTier 3090 should return a pick');
  assert.equal(out.tier.slug, '3090');
  assert.ok(out.base_model);
  assert.ok(R.QUANTS.includes(out.recommended_quant));
  assert.ok(out.vram_gb > 0);
  assert.ok(out.ctx_k > 0);
  assert.ok(Array.isArray(out.candidates) && out.candidates.length >= 1);
});

test('W218 #2 - resolveTier returns null for unknown tier', async () => {
  const R = await import('../src/model-registry.js');
  assert.equal(R.resolveTier('not-a-tier'), null);
  assert.equal(R.resolveTier(''), null);
  assert.equal(R.resolveTier(null), null);
});

test('W218 #3 - resolveTier honors modality + arch filter (degrades gracefully when filter narrows to zero)', async () => {
  const R = await import('../src/model-registry.js');
  // W295 split: omni / vision modal picks live in CANDIDATE_MODELS until
  // promoted with exact model-card URLs. resolveTier now reads ONLY verified
  // rows, so a modality filter that no verified row satisfies must fall
  // back to the full pool for the tier (the helper's documented behavior:
  // "if filtered is empty, keep the original pool").
  const sparkAnyMod = R.resolveTier('dgx-spark', { modality: 'video' });
  assert.ok(sparkAnyMod, 'should still return a verified Spark pick when no video row exists');
  assert.equal(sparkAnyMod.tier.slug, 'dgx-spark');

  // Arch filter narrows when at least one verified row matches.
  const dense3090 = R.resolveTier('3090', { arch: 'dense' });
  assert.ok(dense3090, 'should resolve a dense 3090 pick');
  assert.equal(dense3090.arch, 'dense');
});

test('W218 #4 - detectTierFromGpuName maps common GPU names', async () => {
  const R = await import('../src/model-registry.js');
  assert.equal(R.detectTierFromGpuName('NVIDIA GeForce RTX 5090'), '5090');
  assert.equal(R.detectTierFromGpuName('NVIDIA RTX 4090'), '4090');
  assert.equal(R.detectTierFromGpuName('GeForce RTX 3090 Ti'), '3090');
  assert.equal(R.detectTierFromGpuName('NVIDIA A100-SXM4-80GB'), 'a100-80');
  assert.equal(R.detectTierFromGpuName('NVIDIA H100 80GB HBM3'), 'h100-80');
  assert.equal(R.detectTierFromGpuName('NVIDIA H200'), 'h200-141');
  assert.equal(R.detectTierFromGpuName('Apple M3 Ultra'), 'm3-ultra-512');
  assert.equal(R.detectTierFromGpuName('Apple M4 Max'), 'm4-max-128');
  assert.equal(R.detectTierFromGpuName('NVIDIA GB10 (DGX Spark)'), 'dgx-spark');
  assert.equal(R.detectTierFromGpuName('UnknownCard 9000'), null);
  assert.equal(R.detectTierFromGpuName(''), null);
  assert.equal(R.detectTierFromGpuName(null), null);
});

test('W218 #5 - cmdCompile parses --tier and sets KOLM_HW_TIER + base-model', () => {
  // The injection point is at the top of cmdCompile, after --gate handling.
  const cmpIdx = CLI_SRC.indexOf('async function cmdCompile(');
  const body = CLI_SRC.slice(cmpIdx, cmpIdx + 12000);
  assert.match(body, /const tierIdxC = args\.indexOf\('--tier'\)/);
  assert.match(body, /resolveTier\(tierSlug\)/);
  assert.match(body, /KOLM_HW_TIER\s*=\s*resolved\.tier\.slug/);
  assert.match(body, /KOLM_QUANT\s*=\s*resolved\.recommended_quant/);
  assert.match(body, /args\.push\(['"]--base-model['"]\s*,\s*resolved\.base_model\)/);
});

test('W218 #6 - cmdCompile lets explicit --base-model override --tier pick', () => {
  const cmpIdx = CLI_SRC.indexOf('async function cmdCompile(');
  const body = CLI_SRC.slice(cmpIdx, cmpIdx + 12000);
  // The override branch: only push base-model when explicitBase < 0.
  assert.match(body, /explicitBase\s*=\s*args\.indexOf\(['"]--base-model['"]\)/);
  assert.match(body, /if\s*\(\s*explicitBase\s*<\s*0\s*\)/);
  assert.match(body, /--base-model overrides/);
});

test('W218 #7 - cmdDoctor --detect-hw path wired with detectHardware()', () => {
  assert.match(CLI_SRC, /async function detectHardware\(/);
  assert.match(CLI_SRC, /nvidia-smi/);
  assert.match(CLI_SRC, /system_profiler/);
  const docIdx = CLI_SRC.indexOf('async function cmdDoctor(');
  const docBody = CLI_SRC.slice(docIdx, docIdx + 14000);
  assert.match(docBody, /args\.includes\(['"]--detect-hw['"]\)/);
  assert.match(docBody, /detectHardware\(/);
  assert.match(docBody, /process\.exit\(3\)/);
});

test('W218 #8 - sw.js CACHE wave-floor >= 218', () => {
  const m = SW_JS.match(/const\s+CACHE\s*=\s*'kolm-v7-2026-05-\d+-wave(\d+)/);
  assert.ok(m, 'CACHE slug present');
  assert.ok(parseInt(m[1], 10) >= 218, 'CACHE wave >= 218 (got ' + m[1] + ')');
});

test('W218 #9 - every named hw tier in the plan resolves to a frontier model', async () => {
  const R = await import('../src/model-registry.js');
  // The plan named these 4 tiers explicitly as `kolm compile --tier=` values.
  // Each one MUST resolve to at least one model. (Other tiers in HW_TIERS may
  // legitimately have no frontier model and are left for the user to override.)
  for (const slug of ['3090', '5090', 'dgx-spark', 'm3-ultra-512']) {
    const out = R.resolveTier(slug);
    assert.ok(out, `tier ${slug} must resolve (plan named it as a compile preset)`);
    assert.ok(out.base_model, `tier ${slug} must pick a base model`);
  }
});

test('W218 #10 - detectHardware shape stable when no GPU is present', async () => {
  // Just verify the helper module-level shape — we cannot reliably mock
  // spawnSync inside cli/kolm.js, but we can require the export contract via
  // a probe: every detectHardware result has {source, gpu_name, vram_gb,
  // tier_slug}. The CLI body has the path; this test asserts the doctor JSON
  // output references those fields so the contract is locked.
  const docIdx = CLI_SRC.indexOf('async function cmdDoctor(');
  const docBody = CLI_SRC.slice(docIdx, docIdx + 14000);
  for (const f of ['detected.source', 'detected.gpu_name', 'detected.vram_gb', 'detected.tier_slug']) {
    assert.ok(docBody.includes(f), `doctor --detect-hw should surface ${f}`);
  }
});
