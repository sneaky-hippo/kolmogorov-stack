// Wave 353 - AGENT_GUIDE.md lock-in.
//
// AGENT_GUIDE.md is the canonical instruction sheet for AI agents driving the
// kolm CLI. The runtime IS the source of truth -- this test ensures the guide
// stays in sync with src/intent.js (VERB_DESCRIPTIONS) and cli/kolm.js (EXIT).
// If the guide drifts from runtime, the test fails so the next contributor
// updates the doc instead of letting it rot.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..');
const GUIDE_PATH = path.resolve(REPO_ROOT, 'AGENT_GUIDE.md');
// On Windows dynamic ESM import requires a file:// URL.
const INTENT_PATH = pathToFileURL(path.resolve(REPO_ROOT, 'src', 'intent.js')).href;
const CLI_PATH = path.resolve(REPO_ROOT, 'cli', 'kolm.js');

test('W353 #1 - AGENT_GUIDE.md exists at the repo root', () => {
  assert.ok(fs.existsSync(GUIDE_PATH), 'AGENT_GUIDE.md must exist at the repo root');
  const body = fs.readFileSync(GUIDE_PATH, 'utf8');
  assert.ok(body.length > 1500, `guide is too short (${body.length} chars). Expand it.`);
});

test('W353 #2 - guide documents the canonical JSON error envelope shape', () => {
  const body = fs.readFileSync(GUIDE_PATH, 'utf8');
  // The five keys of jsonErrorEnvelope() in cli/kolm.js must all appear in the
  // guide so an agent can pattern-match against the runtime output.
  for (const key of ['ok', 'error', 'code', 'exit', 'hint', 'next']) {
    assert.ok(body.includes('"' + key + '"') || body.includes(key + ':'),
      `guide must document the '${key}' field of the error envelope`);
  }
});

test('W353 #3 - guide documents all six EXIT constants from cli/kolm.js', () => {
  const body = fs.readFileSync(GUIDE_PATH, 'utf8');
  for (const name of ['OK', 'BAD_ARGS', 'GATE_FAIL', 'MISSING_PREREQ', 'EXECUTION', 'NOT_FOUND']) {
    assert.ok(body.includes(name), `guide must mention EXIT.${name}`);
  }
  // And the numeric values, so an agent can switch on them.
  for (const n of ['0', '1', '2', '3', '4', '5']) {
    assert.ok(body.includes(n), `guide must mention exit code ${n}`);
  }
});

test('W353 #4 - guide documents >= 20 verbs (covering the high-traffic surface)', async () => {
  const body = fs.readFileSync(GUIDE_PATH, 'utf8');
  const { listVerbs } = await import(INTENT_PATH);
  const allVerbs = listVerbs();
  let covered = 0;
  for (const v of allVerbs) {
    // Match `\`<verb>\`` (markdown inline code) so partial-word matches don't
    // count -- e.g. "do" shouldn't match "redactor".
    const tickPattern = new RegExp('`' + v.replace(/[-/\\^$*+?.()|[\]{}]/g, '\\$&') + '`');
    if (tickPattern.test(body)) covered++;
  }
  assert.ok(covered >= 20, `expected >= 20 verbs documented, got ${covered}/${allVerbs.length}`);
});

test('W353 #5 - guide cites the five W351-W353 natural-language verbs explicitly', () => {
  const body = fs.readFileSync(GUIDE_PATH, 'utf8');
  for (const v of ['do', 'what', 'next', 'explain', 'fix']) {
    assert.ok(body.includes('`' + v + '`'),
      `guide must explicitly mention the '${v}' verb in inline code`);
  }
});

test('W353 #6 - guide contains >= 10 numbered recipes', () => {
  const body = fs.readFileSync(GUIDE_PATH, 'utf8');
  // Recipes are numbered "### N. <title>" sections under the Recipes header.
  const recipeHeadings = body.match(/^###\s+\d+\.\s+/gm) || [];
  assert.ok(recipeHeadings.length >= 10,
    `expected >= 10 numbered recipes, got ${recipeHeadings.length}`);
});

test('W353 #7 - guide cross-references src/intent.js as the canonical source', () => {
  const body = fs.readFileSync(GUIDE_PATH, 'utf8');
  assert.ok(/src\/intent\.js/.test(body),
    'guide must reference src/intent.js as the canonical verb table source');
});

test('W353 #8 - guide documents the --json convention and KOLM_E_ error codes', () => {
  const body = fs.readFileSync(GUIDE_PATH, 'utf8');
  assert.ok(/--json/.test(body), 'guide must explain the --json convention');
  assert.ok(/KOLM_E_/.test(body), 'guide must mention the KOLM_E_* stable error code namespace');
});

test('W353 #9 - guide names recommended agent verbs (do, what, next) prominently in the TL;DR', () => {
  const body = fs.readFileSync(GUIDE_PATH, 'utf8');
  const tldr = body.split(/^---/m)[0] + (body.split(/^---/m)[1] || '');
  for (const v of ['do', 'what', 'next']) {
    assert.ok(tldr.includes(v), `TL;DR must mention '${v}'`);
  }
});

test('W353 #10 - new verbs are reachable from the CLI (smoke: dispatch table mentions all five)', () => {
  // Source-level guard: cli/kolm.js must dispatch all five W351-W353 verbs
  // from main()'s switch AND the _dispatchVerb table. If a future refactor
  // splits the dispatcher we want this test to surface the gap.
  const src = fs.readFileSync(CLI_PATH, 'utf8');
  for (const v of ['do', 'what', 'next', 'explain', 'fix']) {
    const caseLine = new RegExp(`case '${v}':`);
    assert.ok(caseLine.test(src), `cli/kolm.js must have case '${v}': in main()`);
  }
  // _dispatchVerb table also wires them.
  const table = src.match(/async function _dispatchVerb[\s\S]*?\n};?\n/);
  // The table may continue without a closing }; on its own line; instead grep
  // for the verb names inside the function body (between function-open and
  // the next top-level function-open).
  const fnStart = src.indexOf('async function _dispatchVerb');
  const fnEnd = src.indexOf('async function ', fnStart + 30);
  assert.ok(fnStart > 0 && fnEnd > fnStart, '_dispatchVerb must exist');
  const fnBody = src.slice(fnStart, fnEnd);
  for (const v of ['do', 'what', 'next', 'explain', 'fix']) {
    assert.ok(fnBody.includes(v + ':'),
      `_dispatchVerb table must wire '${v}: cmd...'`);
  }
});

test('W353 #11 - VERB_DESCRIPTIONS in src/intent.js stays in sync with the dispatch table', async () => {
  // The agent guide and the runtime are bound to VERB_DESCRIPTIONS. Every
  // verb name in VERB_DESCRIPTIONS should either be dispatchable or be a
  // pure-meta verb (do/what/next/explain/fix). We don't enforce a perfect
  // 1:1 because some verbs in the description table are aliases, but we do
  // require the new natural-language verbs to be present.
  const { listVerbs } = await import(INTENT_PATH);
  const verbs = listVerbs();
  for (const v of ['do', 'what', 'next', 'explain', 'fix']) {
    assert.ok(verbs.includes(v), `VERB_DESCRIPTIONS must include '${v}'`);
  }
  // And the top-of-table classics.
  for (const v of ['compile', 'run', 'verify', 'eval', 'inspect', 'list',
                   'tail', 'distill', 'capture', 'publish', 'pull']) {
    assert.ok(verbs.includes(v), `VERB_DESCRIPTIONS must include '${v}'`);
  }
});

test('W353 #12 - guide is plain markdown (no execution / no scripts)', () => {
  const body = fs.readFileSync(GUIDE_PATH, 'utf8');
  // A simple guard against accidentally embedding a script tag or HTML.
  assert.ok(!/<script\b/i.test(body), 'guide must not include <script>');
  // The guide should be heading-rich.
  const headings = body.match(/^#+\s/gm) || [];
  assert.ok(headings.length >= 8, `expected >= 8 markdown headings, got ${headings.length}`);
});
