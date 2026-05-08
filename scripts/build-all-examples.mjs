// Build every public example .kolm artifact into test/fixtures/.
// One script so anyone can verify-then-publish in a single command:
//
//   RECIPE_RECEIPT_SECRET=kolm-public-fixture-v0-1-0 node scripts/build-all-examples.mjs
//
// Verifies determinism: every script in scripts/build-example-*.mjs (and
// scripts/build-public-fixture.mjs) is deterministic given the secret + the
// recipe source. Run this script twice; sha256s must match.

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { spawn } from 'node:child_process';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repo = path.resolve(__dirname, '..');
const scriptsDir = path.join(repo, 'scripts');

const builders = [
  'build-public-fixture.mjs',
  'build-example-redactor.mjs',
  'build-example-extractor.mjs',
  'build-example-classifier.mjs',
];

function run(script) {
  return new Promise((resolve, reject) => {
    const p = spawn(process.execPath, [path.join(scriptsDir, script)], {
      stdio: 'inherit',
      env: { ...process.env, RECIPE_RECEIPT_SECRET: process.env.RECIPE_RECEIPT_SECRET || 'kolm-public-fixture-v0-1-0' },
    });
    p.on('close', (code) => code === 0 ? resolve() : reject(new Error(`${script} exited ${code}`)));
  });
}

for (const s of builders) {
  console.log(`\n--- ${s} ---`);
  await run(s);
}

// Final inventory: friendly-named .kolm files only.
const fixturesDir = path.join(repo, 'test', 'fixtures');
const friendly = ['sample.kolm', 'redactor.kolm', 'extractor.kolm', 'classifier.kolm'];
console.log('\n--- inventory ---');
for (const f of friendly) {
  const p = path.join(fixturesDir, f);
  if (!fs.existsSync(p)) { console.log(`MISSING: ${f}`); continue; }
  const sha = crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex');
  const bytes = fs.statSync(p).size;
  console.log(`${f.padEnd(20)} ${bytes.toString().padStart(6)}B  sha256:${sha.slice(0, 16)}…`);
}
