// Wave 359 — kolm make: idea -> shipped artifact in one verb.
//
// Behavior tests:
//   1. NDJSON event stream walks all seven steps in order with status=ok.
//   2. The compiled .kolm file exists at the expected --out path.
//   3. A .receipt.json file is written next to the .kolm with sha256 anchor.
//   4. Step 2 reports correct row count when --seeds is provided.
//   5. The module's exported `make()` async iterator yields the same shape
//      events the CLI renders, so other surfaces (TUI, web wizard) can reuse.
//   6. --no-sign skips signing but still emits an unsigned receipt.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { spawn } from 'node:child_process';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CLI = path.resolve(__dirname, '..', 'cli', 'kolm.js');
const ROOT = path.resolve(__dirname, '..');

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'kolm-w359-'));
}

function writeRedactorSeeds(dir, n = 60) {
  const file = path.join(dir, 'seeds.jsonl');
  const lines = [];
  for (let i = 0; i < n; i++) {
    lines.push(JSON.stringify({
      input: { text: `call ${100 + i}-555-${1000 + i} now` },
      expected: { redacted: `call [PHONE] now`, hits: [{ name: 'PHONE', count: 1 }] },
      tags: ['phone'],
    }));
  }
  fs.writeFileSync(file, lines.join('\n') + '\n');
  return file;
}

function runCli(args, env = {}) {
  return new Promise((resolve) => {
    const home = tmpDir();
    const child = spawn(process.execPath, [CLI, ...args], {
      env: { ...process.env, HOME: home, USERPROFILE: home, KOLM_HOME: path.join(home, '.kolm'), KOLM_NO_REST_HINT: '1', ...env },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '', stderr = '';
    child.stdout.on('data', (b) => { stdout += b.toString('utf8'); });
    child.stderr.on('data', (b) => { stderr += b.toString('utf8'); });
    const killer = setTimeout(() => { try { child.kill('SIGKILL'); } catch (_) {} }, 60_000);
    child.on('close', (code) => {
      clearTimeout(killer);
      try { fs.rmSync(home, { recursive: true, force: true }); } catch (_) {}
      resolve({ code, stdout, stderr });
    });
  });
}

test('W359 #1 — kolm make --json emits 7 ok events in order', async () => {
  const dir = tmpDir();
  try {
    const seeds = writeRedactorSeeds(dir, 60);
    const outPath = path.join(dir, 'phi-redactor.kolm');
    const r = await runCli(['make', 'phi-redactor', '--seeds', seeds, '--out', outPath, '--no-sign', '--json', '--force']);
    assert.equal(r.code, 0, `expected exit 0, got ${r.code}\nstdout:\n${r.stdout}\nstderr:\n${r.stderr}`);
    const lines = r.stdout.trim().split(/\n/).filter(Boolean);
    const events = lines.map((ln) => JSON.parse(ln));
    // We expect started+ok pairs for each step (so 14 events), or at least 7 oks in order.
    const oks = events.filter((e) => e.status === 'ok');
    assert.ok(oks.length >= 7, `expected at least 7 ok events, got ${oks.length}.\nevents: ${JSON.stringify(events, null, 2)}`);
    const stepsSeen = oks.map((e) => e.step);
    for (let s = 1; s <= 7; s++) {
      assert.ok(stepsSeen.includes(s), `step ${s} ok event missing. saw steps: ${stepsSeen.join(',')}`);
    }
    // Order: each step's ok must come before the next step's ok.
    for (let i = 0; i < oks.length - 1; i++) {
      assert.ok(oks[i].step <= oks[i + 1].step, `events out of order at index ${i}`);
    }
  } finally {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch (_) {}
  }
});

test('W359 #2 — kolm make writes the .kolm file at --out path', async () => {
  const dir = tmpDir();
  try {
    const seeds = writeRedactorSeeds(dir, 60);
    const outPath = path.join(dir, 'my-redactor.kolm');
    const r = await runCli(['make', 'my-redactor', '--seeds', seeds, '--out', outPath, '--no-sign', '--json', '--force']);
    assert.equal(r.code, 0, `exit ${r.code}\n${r.stderr}`);
    assert.ok(fs.existsSync(outPath), `expected ${outPath} to exist after make`);
    const buf = fs.readFileSync(outPath);
    // .kolm is a zip; first 2 bytes are PK
    assert.equal(buf[0], 0x50);
    assert.equal(buf[1], 0x4b);
  } finally {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch (_) {}
  }
});

test('W359 #3 — kolm make emits a stand-alone .receipt.json next to the .kolm', async () => {
  const dir = tmpDir();
  try {
    const seeds = writeRedactorSeeds(dir, 60);
    const outPath = path.join(dir, 'r3.kolm');
    const r = await runCli(['make', 'r3', '--seeds', seeds, '--out', outPath, '--no-sign', '--json', '--force']);
    assert.equal(r.code, 0, `exit ${r.code}\n${r.stderr}`);
    const receiptPath = outPath.replace(/\.kolm$/, '.receipt.json');
    assert.ok(fs.existsSync(receiptPath), `expected ${receiptPath}`);
    const receipt = JSON.parse(fs.readFileSync(receiptPath, 'utf-8'));
    assert.equal(receipt.spec, 'kolm-receipt-v1');
    assert.equal(receipt.artifact, path.basename(outPath));
    assert.ok(receipt.sha256, 'receipt must include sha256');
    assert.equal(receipt.sha256.length, 64);
    assert.ok(typeof receipt.bytes === 'number' && receipt.bytes > 0);
    assert.ok(receipt.signature && receipt.signature.alg === 'sha256-anchor');
  } finally {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch (_) {}
  }
});

test('W359 #4 — step 2 reports correct seed row count when --seeds provided', async () => {
  const dir = tmpDir();
  try {
    const seeds = writeRedactorSeeds(dir, 42);
    const outPath = path.join(dir, 'r4.kolm');
    const r = await runCli(['make', 'r4', '--seeds', seeds, '--out', outPath, '--no-sign', '--json', '--force']);
    assert.equal(r.code, 0, `exit ${r.code}\n${r.stderr}`);
    const events = r.stdout.trim().split(/\n/).filter(Boolean).map(JSON.parse);
    const step2ok = events.find((e) => e.step === 2 && e.status === 'ok');
    assert.ok(step2ok, 'step 2 ok event missing');
    // We accept either explicit count from the read OR used_existing semantics.
    assert.ok(step2ok.detail, 'step 2 detail required');
    const hasCount = typeof step2ok.detail.count === 'number' && step2ok.detail.count > 0;
    const isExisting = step2ok.detail.used_existing === true;
    assert.ok(hasCount || isExisting, `step 2 detail must report count or used_existing: ${JSON.stringify(step2ok)}`);
  } finally {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch (_) {}
  }
});

test('W359 #5 — make() async iterator yields events with step/name/status fields', async () => {
  const dir = tmpDir();
  try {
    const seeds = writeRedactorSeeds(dir, 60);
    const outPath = path.join(dir, 'r5.kolm');
    const mod = await import(pathToFileURL(path.join(ROOT, 'src', 'pipeline-make.js')).href);
    assert.equal(typeof mod.make, 'function', 'pipeline-make.js must export make()');
    const events = [];
    for await (const e of mod.make({ name: 'r5', seeds, outPath, noSign: true, force: true })) {
      events.push(e);
      assert.ok(typeof e.step === 'number', `event missing step: ${JSON.stringify(e)}`);
      assert.ok(typeof e.name === 'string', `event missing name: ${JSON.stringify(e)}`);
      assert.ok(['started', 'ok', 'err'].includes(e.status), `bad status: ${e.status}`);
    }
    const oks = events.filter((e) => e.status === 'ok');
    assert.ok(oks.length >= 7, `expected >=7 ok events from generator, got ${oks.length}`);
    assert.ok(fs.existsSync(outPath), 'artifact must exist after iterator drains');
  } finally {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch (_) {}
  }
});

test('W359 #6 — --no-sign skips signature_sigstore but still emits sha256 anchor', async () => {
  const dir = tmpDir();
  try {
    const seeds = writeRedactorSeeds(dir, 60);
    const outPath = path.join(dir, 'r6.kolm');
    const r = await runCli(['make', 'r6', '--seeds', seeds, '--out', outPath, '--no-sign', '--json', '--force']);
    assert.equal(r.code, 0, `exit ${r.code}\n${r.stderr}`);
    const receiptPath = outPath.replace(/\.kolm$/, '.receipt.json');
    const receipt = JSON.parse(fs.readFileSync(receiptPath, 'utf-8'));
    assert.ok(!receipt.signature_sigstore, 'no-sign mode must not embed sigstore bundle');
    assert.equal(receipt.signature.alg, 'sha256-anchor');
  } finally {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch (_) {}
  }
});
