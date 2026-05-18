// Wave 211: CI hotfix lock-in.
//
// Behavior assertions (per Pablo correction — no page-text markers):
//   - kolm-compile-on-push.yml MUST NOT have a `push:` trigger (the trigger
//     that was firing 25995437069 with empty KOLM_KEY → exit 3).
//   - kolm-compile-on-push.yml MUST gate `compile` job on
//     `secrets.KOLM_KEY != ''` so forks without a key can still observe the
//     workflow listed but won't have it fire.
//   - kolm-ci-pipeline.yml MUST satisfy the same two invariants for
//     `compile-test-publish`.
//   - workflow_dispatch trigger MUST survive in both files (manual invocation
//     remains the supported entry).
//   - secret reference `secrets.KOLM_KEY` MUST still appear (otherwise the
//     workflow can never compile even on the dispatch path).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..');
const COMPILE_ON_PUSH = fs.readFileSync(path.join(ROOT, '.github/workflows/kolm-compile-on-push.yml'), 'utf8');
const CI_PIPELINE = fs.readFileSync(path.join(ROOT, '.github/workflows/kolm-ci-pipeline.yml'), 'utf8');

test('W211 #1 — kolm-compile-on-push.yml drops push trigger', () => {
  // The on: block must not contain `push:` as a trigger key.
  // YAML keys at indent 2 under `on:`. Search for `^  push:` line-anchored.
  const lines = COMPILE_ON_PUSH.split(/\r?\n/);
  const hasPushTrigger = lines.some((l) => /^\s{2}push:\s*$/.test(l));
  assert.equal(hasPushTrigger, false, 'push: trigger must be removed from kolm-compile-on-push.yml');
});

test('W211 #2 — kolm-compile-on-push.yml gates compile job on KOLM_KEY secret', () => {
  assert.match(
    COMPILE_ON_PUSH,
    /if:\s*\$\{\{\s*secrets\.KOLM_KEY\s*!=\s*''\s*\}\}/,
    'compile job must be gated on `secrets.KOLM_KEY != \'\''
  );
});

test('W211 #3 — kolm-compile-on-push.yml keeps workflow_dispatch entry', () => {
  assert.match(COMPILE_ON_PUSH, /workflow_dispatch:/);
});

test('W211 #4 — kolm-compile-on-push.yml still passes KOLM_KEY to action', () => {
  assert.match(COMPILE_ON_PUSH, /api-key:\s*\$\{\{\s*secrets\.KOLM_KEY\s*\}\}/);
});

test('W211 #5 — kolm-ci-pipeline.yml drops push trigger', () => {
  const lines = CI_PIPELINE.split(/\r?\n/);
  const hasPushTrigger = lines.some((l) => /^\s{2}push:\s*$/.test(l));
  assert.equal(hasPushTrigger, false, 'push: trigger must be removed from kolm-ci-pipeline.yml');
});

test('W211 #6 — kolm-ci-pipeline.yml gates compile-test-publish on KOLM_KEY', () => {
  assert.match(
    CI_PIPELINE,
    /if:\s*\$\{\{\s*secrets\.KOLM_KEY\s*!=\s*''\s*\}\}/,
    'compile-test-publish job must be gated on `secrets.KOLM_KEY != \'\''
  );
});

test('W211 #7 — kolm-ci-pipeline.yml keeps workflow_dispatch entry', () => {
  assert.match(CI_PIPELINE, /workflow_dispatch:/);
});

test('W211 #8 — kolm-ci-pipeline.yml still passes KOLM_KEY to action', () => {
  assert.match(CI_PIPELINE, /api-key:\s*\$\{\{\s*secrets\.KOLM_KEY\s*\}\}/);
});

test('W211 #9 — kolm-ci-pipeline.yml retains compile/test/verify/publish step chain', () => {
  // Behavior contract: the dispatch path must still exercise the full chain.
  assert.match(CI_PIPELINE, /uses:\s*\.\/\.github\/actions\/kolm-compile/);
  assert.match(CI_PIPELINE, /uses:\s*\.\/\.github\/actions\/kolm-test/);
  assert.match(CI_PIPELINE, /uses:\s*\.\/\.github\/actions\/kolm-verify/);
  assert.match(CI_PIPELINE, /uses:\s*\.\/\.github\/actions\/kolm-publish/);
});

test('W211 #10 — no auto-trigger on push of .jsonl/.json files', () => {
  // Combined invariant: examples/**.jsonl and schemas/**.json paths should
  // no longer cause a workflow run. Verify neither workflow mentions
  // `paths:` blocks under push: (since push: itself is gone, this is a
  // belt-and-suspenders check that no other trigger references the paths).
  for (const yml of [COMPILE_ON_PUSH, CI_PIPELINE]) {
    const lines = yml.split(/\r?\n/);
    let inPushBlock = false;
    for (const l of lines) {
      if (/^\s{2}push:\s*$/.test(l)) inPushBlock = true;
      else if (/^\s{2}\S/.test(l)) inPushBlock = false;
      if (inPushBlock && /paths:/.test(l)) {
        assert.fail('push.paths: block must not exist (would re-introduce empty-key failure)');
      }
    }
  }
});
