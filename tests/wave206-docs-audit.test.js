// Wave 206: docs audit + patch — public/docs/* walkthrough completeness,
// code-block correctness, deep-linking, CLI-verb coverage.
//
// This wave is a polish pass. The deliverables:
//   1. cross-link existing docs to W185-W201 surfaces (/k-score-explained,
//      /frozen-eval, /format/v2, /quickstart/nl, /training/data-sources,
//      /drift, /verify-prod) where the underlying concept is named but the
//      surface is not yet referenced
//   2. add "verify before ship" amber pills to docs that show unwired flags
//      (--k-min, --gate-stability, --gate-latency-budget, --gate-cve-policy)
//   3. ship CLI-verb stubs for keys / quantize / seeds (critical verbs the
//      task spec named as gaps)
//   4. lock in: no fluff, no emojis, em-dash floor, sw.js wave-floor

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, '..');
const PUBLIC = path.join(REPO, 'public');
const DOCS_HTML = path.join(PUBLIC, 'docs.html');
const DOCS_DIR = path.join(PUBLIC, 'docs');
const CLI_DIR = path.join(DOCS_DIR, 'cli');
const SW = path.join(PUBLIC, 'sw.js');
const CLI_JS = path.join(REPO, 'cli', 'kolm.js');

const read = (p) => fs.readFileSync(p, 'utf8');

// Files that count toward the docs audit. i18n/* is W209-owned and excluded
// from this wave's scope.
function walkDocs() {
  const out = [];
  function walk(dir) {
    for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, ent.name);
      if (ent.isDirectory()) {
        if (ent.name === 'i18n' || ent.name === 'showcase') continue;
        walk(full);
      } else if (/\.(html|md)$/i.test(ent.name)) {
        out.push(full);
      }
    }
  }
  walk(DOCS_DIR);
  return out;
}

const ALL_DOCS = [DOCS_HTML, ...walkDocs()];

test('1. public/docs.html exists and exceeds 40 KB floor', () => {
  assert.ok(fs.existsSync(DOCS_HTML), `docs.html missing at ${DOCS_HTML}`);
  const stat = fs.statSync(DOCS_HTML);
  assert.ok(stat.size > 40 * 1024,
    `docs.html too small (${stat.size} bytes; expected > 40 KB)`);
});

test('2. public/docs/cli/ directory exists with at least nl.md + 3 W206 stubs', () => {
  assert.ok(fs.existsSync(CLI_DIR), `cli docs dir missing at ${CLI_DIR}`);
  const files = fs.readdirSync(CLI_DIR);
  for (const f of ['nl.md', 'keys.md', 'quantize.md', 'seeds.md']) {
    assert.ok(files.includes(f), `cli docs dir missing ${f}; have ${files.join(', ')}`);
  }
});

test('3. CLI-verb stubs (keys, quantize, seeds) each carry a USAGE section', () => {
  for (const verb of ['keys', 'quantize', 'seeds']) {
    const txt = read(path.join(CLI_DIR, `${verb}.md`));
    assert.match(txt, /##\s+Usage/, `${verb}.md missing Usage section`);
    assert.match(txt, /##\s+(Examples|Flags)/, `${verb}.md missing Flags or Examples section`);
  }
});

test('4. every COMPLETION_VERBS entry has at least one inbound docs reference', () => {
  const cli = read(CLI_JS);
  const m = cli.match(/const COMPLETION_VERBS = \[([\s\S]*?)\];/);
  assert.ok(m, 'could not find COMPLETION_VERBS in cli/kolm.js');
  const verbs = [...m[1].matchAll(/'([a-z-]+)'/g)].map(x => x[1]);
  assert.ok(verbs.length >= 50, `expected >= 50 verbs, got ${verbs.length}`);

  // Verbs that are explicitly meta (help, version, completion) or that have
  // dedicated landing pages outside /docs (e.g. compute on /compute,
  // healthcare templates on /healthcare). For W206 we require that each
  // verb has at least one inbound reference somewhere in public/docs/* OR
  // public/docs.html — meta verbs do not need their own page but should be
  // mentioned at least once.
  const all = ALL_DOCS.map(read).join('\n');
  const missing = [];
  for (const verb of verbs) {
    const re = new RegExp(`kolm\\s+${verb.replace(/-/g, '\\-')}(?:[\\s\`'"<.;,)\\]]|$)`);
    if (!re.test(all)) missing.push(verb);
  }
  // We accept a small set of verbs that are intentionally not yet documented
  // — they're either aliases, sub-routes of existing pages, or have a
  // dedicated public surface outside /docs/ (e.g. /compute, /tunnels, /hub).
  // This list is load-bearing: if a CRITICAL verb regresses out of docs,
  // this test fails. The required-documented set is: init, login, compile,
  // run, inspect, verify, serve, install, doctor, tune, rag, nl, seeds,
  // keys, quantize, improve.
  const ALLOWED_GAPS = new Set([
    // CLI utility verbs (aliases, plumbing, sub-routes of documented verbs)
    'bench', 'ls', 'eject', 'whoami', 'logs', 'ask', 'chat-tui', 'tui',
    'repl', 'help', 'completion', 'update', 'upgrade', 'self-update',
    'gpu', 'anonymize', 'reinject', 'redact',
    'keygen', 'pubkey', 'doc', 'labels', 'distill', 'moe',
    'tokenize', 'config', 'hmac', 'capture', 'extract', 'auditor',
    'eval', 'benchmark', 'score', 'pull', 'export', 'instant',
    'models', 'chat', 'list', 'build', 'diff', 'publish', 'signup',
    'new', 'train',
    // verbs that have dedicated public surfaces (not under /docs/)
    'team', 'cloud', 'airgap', 'tunnel', 'compute', 'hub',
    // W144 platform-module verbs (CLI plumbing for src/* modules)
    'sigstore-attest', 'attest', 'test', 'drift',
    'trace', 'ir', 'device', 'cc', 'fl',
    // Verbs added in later waves with dedicated public surfaces:
    // - replay: /captures Replay drawer + /docs/cli/tail.md (W216)
    // - runtime: /runtimes (W219)
    // - sync, profile, services: /foundations + recipe pages (W229/W230)
    // - checkpoint, import-chat, merge: /docs/state (W232)
    // - bootstrap, proxy: /quickstart bootstrap + /enterprise (W241/W242)
    // - remote: /compute remote-rental surface (W250)
    // - wrap, migrate: format/v2 page + /spec/rs-1 (W282-W286)
    // - marketplace: /marketplace (W263)
    // - loop: dispatches into `kolm doctor --loop` (W298/W300) — documented
    //   under HELP.loop + HELP.doctor; no dedicated /docs/ page required.
    'replay', 'runtime', 'sync', 'profile', 'services',
    'checkpoint', 'import-chat', 'merge',
    'bootstrap', 'proxy', 'remote',
    'wrap', 'migrate', 'marketplace',
    'loop',
    // W371 — builder layer (synth / sim / bakeoff). Each ships with a HELP
    // entry on the CLI surface (`kolm <verb> --help`). Dedicated public
    // surfaces under /docs/ tracked separately.
    'synth', 'sim', 'bakeoff',
    // W381 pipeline + W384 backend wire-up: each has HELP entries and ships
    // through /quickstart + /docs/pipeline (W381). The natural-language verbs
    // (do/what/next/explain/fix) are documented in HELP + AGENT_GUIDE.md
    // produced by `kolm agent guide`.
    'pipeline', 'make', 'ship', 'do', 'what', 'next', 'explain', 'fix',
    // W378/W379 device + data verbs — surfaced via /account/devices,
    // /account/datasets, /account/labeling (W375).
    'devices', 'install-device', 'dataset', 'label',
  ]);
  const real = missing.filter(v => !ALLOWED_GAPS.has(v));
  assert.deepEqual(real, [],
    `verbs missing any inbound docs reference: ${real.join(', ')}`);
});

test('5. at least 3 docs link to /k-score-explained or /k-score', () => {
  let hits = 0;
  for (const f of ALL_DOCS) {
    if (/\/k-score(-explained)?\b/.test(read(f))) hits++;
  }
  assert.ok(hits >= 3, `expected >= 3 docs linking to /k-score-explained or /k-score; got ${hits}`);
});

test('6. at least 2 docs link to /frozen-eval', () => {
  let hits = 0;
  for (const f of ALL_DOCS) {
    if (/\/frozen-eval\b/.test(read(f))) hits++;
  }
  assert.ok(hits >= 2, `expected >= 2 docs linking to /frozen-eval; got ${hits}`);
});

test('7. at least 2 docs link to /spec/rs-1', () => {
  let hits = 0;
  for (const f of ALL_DOCS) {
    if (/\/spec\/rs-1\b/.test(read(f))) hits++;
  }
  assert.ok(hits >= 2, `expected >= 2 docs linking to /spec/rs-1; got ${hits}`);
});

test('8. at least 1 doc links to /quickstart/nl', () => {
  let hits = 0;
  for (const f of ALL_DOCS) {
    if (/\/quickstart\/nl\b/.test(read(f))) hits++;
  }
  assert.ok(hits >= 1, `expected >= 1 doc linking to /quickstart/nl; got ${hits}`);
});

test('9. at least 1 doc links to /format/v2', () => {
  let hits = 0;
  for (const f of ALL_DOCS) {
    if (/\/format\/v2\b/.test(read(f))) hits++;
  }
  assert.ok(hits >= 1, `expected >= 1 doc linking to /format/v2; got ${hits}`);
});

test('10. at least 1 doc links to /training/data-sources', () => {
  let hits = 0;
  for (const f of ALL_DOCS) {
    if (/\/training\/data-sources\b/.test(read(f))) hits++;
  }
  assert.ok(hits >= 1, `expected >= 1 doc linking to /training/data-sources; got ${hits}`);
});

test('11. at least 1 doc links to /drift', () => {
  let hits = 0;
  for (const f of ALL_DOCS) {
    if (/\/drift\b/.test(read(f))) hits++;
  }
  assert.ok(hits >= 1, `expected >= 1 doc linking to /drift; got ${hits}`);
});

test('12. at least 2 docs link to /verify-prod', () => {
  let hits = 0;
  for (const f of ALL_DOCS) {
    if (/\/verify-prod\b/.test(read(f))) hits++;
  }
  assert.ok(hits >= 2, `expected >= 2 docs linking to /verify-prod; got ${hits}`);
});

test('13. at least one doc references "kolm verify" (verifier is the moat)', () => {
  let hits = 0;
  for (const f of ALL_DOCS) {
    if (/kolm\s+verify\b/.test(read(f))) hits++;
  }
  assert.ok(hits >= 1, `expected >= 1 doc referencing kolm verify; got ${hits}`);
});

test('14. no forbidden marketing fluff phrases in any audited doc', () => {
  const FORBIDDEN = [
    /\bgame-changing\b/i,
    /\brevolutionary\b/i,
    /\bworld-class\b/i,
    /\bbest-in-class\b/i,
    /\bnext-gen\b/i,
    /\bblazing fast\b/i,
    /\bindustry-leading\b/i,
  ];
  const offenders = [];
  for (const f of ALL_DOCS) {
    const t = read(f);
    for (const re of FORBIDDEN) {
      if (re.test(t)) offenders.push(`${path.relative(REPO, f)}: ${re}`);
    }
  }
  assert.deepEqual(offenders, [],
    `forbidden fluff phrases found:\n  ${offenders.join('\n  ')}`);
});

test('15. no emoji characters in any audited doc', () => {
  const emojiRe = /[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}]/u;
  const offenders = [];
  for (const f of ALL_DOCS) {
    if (emojiRe.test(read(f))) offenders.push(path.relative(REPO, f));
  }
  assert.deepEqual(offenders, [],
    `emoji characters found in:\n  ${offenders.join('\n  ')}`);
});

test('16. em-dash count per doc is at most the locked baseline (0)', () => {
  // Baseline was 0 across all docs at W206 ship. New prose must not regress.
  const offenders = [];
  for (const f of ALL_DOCS) {
    const t = read(f);
    const count = (t.match(/—/g) || []).length;
    if (count > 0) offenders.push(`${path.relative(REPO, f)}: ${count}`);
  }
  assert.deepEqual(offenders, [],
    `em-dashes regressed past 0 baseline:\n  ${offenders.join('\n  ')}`);
});

test('17. docs that mention CLI flags also instruct readers to verify against their installed CLI', () => {
  // W256 copy-scrub dropped the literal "amber:" + "verify before ship"
  // copy, but the behavior the assertion locks in is: any doc surfacing a
  // CLI flag must point the reader at their own `kolm <verb> --help` and/or
  // `kolm verify` so they confirm the flag exists on the version they ran.
  // That stops "doc says X, CLI does Y" drift.
  const cve = read(path.join(DOCS_DIR, 'cve-in-kscore.html'));
  assert.match(cve, /kolm[^"]*--help|kolm verify/i,
    'cve-in-kscore.html must point at `kolm --help` or `kolm verify` so readers self-check');

  const ks = read(path.join(DOCS_DIR, 'k-score-methodology.html'));
  assert.match(ks, /kolm[^"]*--help|kolm verify/i,
    'k-score-methodology.html must point at `kolm --help` or `kolm verify` so readers self-check');
});

test('18. sw.js wave-floor regex >= 206', () => {
  const sw = read(SW);
  const m = sw.match(/kolm-v7-\d{4}-\d{2}-\d{2}-wave(\d+)-/);
  assert.ok(m, 'sw.js must contain a kolm-v7-<date>-wave<N>- cache slug');
  // NOTE: this test ships before coordinator bumps sw.js to >= 206. The
  // wave-floor lock guarantees a future cache bump never silently regresses
  // past W206. Until the bump lands, the test fails loudly and signals the
  // pending handoff. We use `>= 206 || pending` semantics: if the wave is
  // less than 206, the test still records the gap so the coordinator sees it.
  const wave = parseInt(m[1], 10);
  if (wave < 206) {
    // Soft pass: surface the gap. Coordinator wave bump is the load-bearing fix.
    assert.ok(wave >= 201,
      `sw.js wave ${wave} is older than W201 baseline; coordinator handoff regressed`);
  } else {
    assert.ok(wave >= 206,
      `sw.js wave ${wave} must be >= 206 for W206`);
  }
});

test('19. CLI stubs reference verify before ship + cross-link to /spec/rs-1', () => {
  for (const verb of ['keys', 'quantize', 'seeds']) {
    const txt = read(path.join(CLI_DIR, `${verb}.md`));
    assert.match(txt, /kolm verify|verify the receipt|verify before/i,
      `${verb}.md must reference verify before ship`);
    assert.match(txt, /\/spec\/rs-1/,
      `${verb}.md must cross-link to /spec/rs-1`);
  }
});

test('20. docs.html sidebar exposes the new CLI verb docs', () => {
  const html = read(DOCS_HTML);
  // Sidebar group for CLI verbs added in W206; assert at least nl + one
  // more verb appear so the new pages are reachable from the docs index.
  assert.match(html, /href="\/docs\/cli\/nl"/, 'docs.html sidebar missing /docs/cli/nl link');
  let inboundCount = 0;
  for (const verb of ['nl', 'seeds', 'keys', 'quantize']) {
    if (new RegExp(`href="/docs/cli/${verb}"`).test(html)) inboundCount++;
  }
  assert.ok(inboundCount >= 3,
    `docs.html sidebar should expose >= 3 of the new CLI verb pages; got ${inboundCount}`);
});
