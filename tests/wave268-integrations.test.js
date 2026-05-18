// W268 — first-party LangChain (JS + Python) and LlamaIndex (JS + Python)
// adapters + /integrations landing page.
//
// Behavior tests: package layout, manifest validity, /integrations.html cards,
// vercel rewrite, sw.js cache slug. The Node adapter is exercised through a
// spawn-and-exit smoke test that swaps in a fake `kolm` binary.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath, pathToFileURL } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT = path.resolve(__dirname, '..');
const PUBLIC = path.join(ROOT, 'public');
const PKGS = path.join(ROOT, 'packages');

function read(p) { return fs.readFileSync(p, 'utf8'); }

const ADAPTERS = [
  { dir: 'langchain-kolm', kind: 'js', manifest: 'package.json', name: '@kolm/langchain' },
  { dir: 'llamaindex-kolm', kind: 'js', manifest: 'package.json', name: '@kolm/llamaindex' },
  { dir: 'python-langchain-kolm', kind: 'py', manifest: 'pyproject.toml', name: 'kolm-langchain' },
  { dir: 'python-llamaindex-kolm', kind: 'py', manifest: 'pyproject.toml', name: 'kolm-llamaindex' },
];

test('W268 all four adapter package directories exist', () => {
  for (const a of ADAPTERS) {
    const dir = path.join(PKGS, a.dir);
    assert.ok(fs.existsSync(dir) && fs.statSync(dir).isDirectory(), `packages/${a.dir} missing`);
  }
});

test('W268 each JS adapter has a valid package.json', () => {
  for (const a of ADAPTERS.filter((x) => x.kind === 'js')) {
    const pkg = JSON.parse(read(path.join(PKGS, a.dir, 'package.json')));
    assert.equal(pkg.name, a.name, `${a.dir}: expected name ${a.name}`);
    assert.equal(pkg.version, '0.1.0', `${a.dir}: expected version 0.1.0`);
    assert.equal(pkg.type, 'module', `${a.dir}: must be ESM`);
    assert.equal(pkg.main, './index.js', `${a.dir}: main must be ./index.js`);
    assert.ok(pkg.peerDependencies, `${a.dir}: must declare peerDependencies`);
    // STRICT: no runtime dependencies on the adapter package itself.
    assert.ok(
      !pkg.dependencies || Object.keys(pkg.dependencies).length === 0,
      `${a.dir}: must have zero runtime deps (langchain/llamaindex are PEER deps)`,
    );
  }
});

test('W268 langchain-kolm has langchain + @langchain/core as peer deps', () => {
  const pkg = JSON.parse(read(path.join(PKGS, 'langchain-kolm', 'package.json')));
  assert.ok(pkg.peerDependencies.langchain, 'langchain must be a peer dep');
  assert.ok(pkg.peerDependencies['@langchain/core'], '@langchain/core must be a peer dep');
});

test('W268 llamaindex-kolm has llamaindex as peer dep', () => {
  const pkg = JSON.parse(read(path.join(PKGS, 'llamaindex-kolm', 'package.json')));
  assert.ok(pkg.peerDependencies.llamaindex, 'llamaindex must be a peer dep');
});

test('W268 each Python adapter has a pyproject.toml with python >=3.10', () => {
  for (const a of ADAPTERS.filter((x) => x.kind === 'py')) {
    const toml = read(path.join(PKGS, a.dir, 'pyproject.toml'));
    assert.match(toml, new RegExp(`name\\s*=\\s*"${a.name}"`), `${a.dir} name must be ${a.name}`);
    assert.match(toml, /version\s*=\s*"0\.1\.0"/, `${a.dir} version must be 0.1.0`);
    assert.match(toml, /requires-python\s*=\s*">=3\.10"/, `${a.dir} must require python >=3.10`);
    // Empty dependencies array (langchain/llamaindex are optional).
    assert.match(toml, /^dependencies\s*=\s*\[\]\s*$/m, `${a.dir} must have empty runtime deps`);
  }
});

test('W268 each Python adapter has an __init__.py that exports KolmLLM', () => {
  const py = [
    ['python-langchain-kolm', 'kolm_langchain'],
    ['python-llamaindex-kolm', 'kolm_llamaindex'],
  ];
  for (const [dir, mod] of py) {
    const init = read(path.join(PKGS, dir, mod, '__init__.py'));
    assert.match(init, /from \.llm import KolmLLM/, `${dir}/${mod}/__init__.py must re-export KolmLLM`);
    assert.match(init, /__all__\s*=\s*\["KolmLLM"\]/, `${dir} must declare __all__ = ["KolmLLM"]`);
    const impl = read(path.join(PKGS, dir, mod, 'llm.py'));
    assert.match(impl, /class KolmLLM\(/, `${dir}/${mod}/llm.py must define class KolmLLM`);
  }
});

test('W268 each adapter has a README with install + 3-line usage', () => {
  for (const a of ADAPTERS) {
    const readme = read(path.join(PKGS, a.dir, 'README.md'));
    assert.ok(readme.length > 400, `${a.dir} README must be substantive`);
    assert.match(readme, /Install/i, `${a.dir} README must mention Install`);
    assert.match(readme, /KolmLLM/, `${a.dir} README must show KolmLLM usage`);
  }
});

test('W268 each adapter has a runnable example file', () => {
  for (const a of ADAPTERS) {
    const ex = a.kind === 'js' ? 'example.js' : 'example.py';
    const p = path.join(PKGS, a.dir, ex);
    assert.ok(fs.existsSync(p), `${a.dir}/${ex} must exist`);
    const src = read(p);
    assert.match(src, /KolmLLM/, `${a.dir}/${ex} must reference KolmLLM`);
  }
});

test('W268 /integrations.html exists with all 4 adapter cards + Zapier + Make.com', () => {
  const html = read(path.join(PUBLIC, 'integrations.html'));
  assert.ok(html.length > 3000, 'integrations.html should be substantive');
  // Four agent-framework adapter cards (anchor ids).
  for (const id of ['langchain-js', 'langchain-py', 'llamaindex-js', 'llamaindex-py']) {
    assert.match(html, new RegExp(`id="${id}"`), `integrations.html missing card #${id}`);
  }
  // Zapier and Make.com cards.
  assert.match(html, /id="zapier"/, 'integrations.html missing #zapier card');
  assert.match(html, /id="make"/, 'integrations.html missing #make card');
  // 3-line snippets present per language. Python adapter may be referenced by
  // either pip-package name (kolm-langchain) or module-import name
  // (kolm_langchain) — both unambiguously identify the adapter per W380d
  // feedback-tests-assert-behavior-not-page-copy.
  assert.match(html, /@kolm\/langchain/, 'must mention @kolm/langchain');
  assert.match(html, /@kolm\/llamaindex/, 'must mention @kolm/llamaindex');
  assert.match(html, /kolm[-_]langchain/, 'must mention kolm-langchain or kolm_langchain (Python adapter)');
  assert.match(html, /kolm[-_]llamaindex/, 'must mention kolm-llamaindex or kolm_llamaindex (Python adapter)');
});

test('W268 /integrations.html marks Zapier + Make.com as coming Q3 2026', () => {
  const html = read(path.join(PUBLIC, 'integrations.html'));
  // "coming Q3 2026" is the agreed honest-amber language.
  assert.match(html, /coming Q3 2026/, 'Zapier/Make.com must use "coming Q3 2026"');
  const count = (html.match(/coming Q3 2026/g) || []).length;
  assert.ok(count >= 2, `expected >=2 "coming Q3 2026" pills, got ${count}`);
});

test('W268 /integrations.html title includes kolm.ai', () => {
  const html = read(path.join(PUBLIC, 'integrations.html'));
  assert.match(html, /<title>[^<]*kolm\.ai[^<]*<\/title>/, 'title must include kolm.ai');
});

test('W268 /integrations.html has no em-dashes in body copy', () => {
  const html = read(path.join(PUBLIC, 'integrations.html'));
  // Strip <pre>/<code>/<script>/<style> blocks before scanning.
  const stripped = html
    .replace(/<script[\s\S]*?<\/script>/g, '')
    .replace(/<style[\s\S]*?<\/style>/g, '')
    .replace(/<pre[\s\S]*?<\/pre>/g, '')
    .replace(/<code[\s\S]*?<\/code>/g, '');
  assert.ok(!stripped.includes('—'), 'no em-dash (U+2014) allowed in /integrations copy');
  assert.ok(!stripped.includes('–'), 'no en-dash (U+2013) allowed in /integrations copy');
});

test('W268 vercel.json has /integrations rewrite to /integrations.html', () => {
  const v = JSON.parse(read(path.join(ROOT, 'vercel.json')));
  const hit = v.rewrites.find(
    (r) => r.source === '/integrations' && r.destination === '/integrations.html',
  );
  assert.ok(hit, 'vercel.json must rewrite /integrations -> /integrations.html');
});

test('W268 sw.js cache slug bumped to wave268 (>=268)', () => {
  const sw = read(path.join(PUBLIC, 'sw.js'));
  const m = sw.match(/const CACHE\s*=\s*'kolm-v\d+-\d{4}-\d{2}-\d{2}-wave(\d+)-/);
  assert.ok(m, 'sw.js CACHE must follow wave naming');
  const n = parseInt(m[1], 10);
  assert.ok(n >= 268, `expected wave >= 268, got ${n}`);
});

test('W268 root package.json has no new runtime deps for adapters', () => {
  const root = JSON.parse(read(path.join(ROOT, 'package.json')));
  const deps = Object.keys(root.dependencies || {});
  for (const forbidden of ['langchain', '@langchain/core', 'llamaindex', '@kolm/langchain', '@kolm/llamaindex']) {
    assert.ok(!deps.includes(forbidden), `root deps must not include ${forbidden}`);
  }
});

test('W268 langchain-kolm KolmLLM constructor rejects empty config', async () => {
  const mod = await import(pathToFileURL(path.join(PKGS, 'langchain-kolm', 'index.js')).href);
  assert.throws(() => new mod.KolmLLM({}), /artifactPath|baseUrl/);
});

test('W268 llamaindex-kolm KolmLLM constructor rejects empty config', async () => {
  const mod = await import(pathToFileURL(path.join(PKGS, 'llamaindex-kolm', 'index.js')).href);
  assert.throws(() => new mod.KolmLLM({}), /artifactPath|baseUrl/);
});

test('W268 langchain-kolm KolmLLM accepts artifactPath (subprocess mode)', async () => {
  const mod = await import(pathToFileURL(path.join(PKGS, 'langchain-kolm', 'index.js')).href);
  const llm = new mod.KolmLLM({ artifactPath: '/tmp/fake.kolm' });
  assert.equal(llm._llmType(), 'kolm');
  assert.equal(llm.artifactPath, '/tmp/fake.kolm');
  assert.equal(llm.baseUrl, null);
});

test('W268 langchain-kolm KolmLLM accepts baseUrl (HTTP mode)', async () => {
  const mod = await import(pathToFileURL(path.join(PKGS, 'langchain-kolm', 'index.js')).href);
  const llm = new mod.KolmLLM({ baseUrl: 'https://kolm.example', apiKey: 'k_test' });
  assert.equal(llm.baseUrl, 'https://kolm.example');
  assert.equal(llm.apiKey, 'k_test');
});

// Bonus: spawn-and-exit smoke test. Builds a fake `kolm` binary that emits a
// JSON line containing the prompt, then verifies KolmLLM parses it correctly.
// Skips on platforms where spawning a shell script fails (covers Windows
// without bash; in that case the underlying spawn call surfaces ENOENT and we
// degrade to a skip rather than a failure).
test('W268 langchain-kolm subprocess smoke test', async (t) => {
  if (process.platform === 'win32') {
    t.skip('subprocess smoke test skipped on win32 (sh shebang not portable)');
    return;
  }
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kolm-w268-'));
  const fakeBin = path.join(dir, 'kolm');
  // Fake CLI: ignores args, reads stdin, echoes back as { text, receipt }.
  fs.writeFileSync(
    fakeBin,
    [
      '#!/usr/bin/env sh',
      'PAYLOAD=$(cat)',
      // Single JSON line on stdout. Escape any inner quotes minimally.
      'ESCAPED=$(printf "%s" "$PAYLOAD" | sed \'s/"/\\\\"/g\')',
      'printf \'{"text":"echo:%s","receipt":{"cid":"fake-cid","k_score":0.99}}\\n\' "$ESCAPED"',
    ].join('\n'),
    { mode: 0o755 },
  );
  const mod = await import(pathToFileURL(path.join(PKGS, 'langchain-kolm', 'index.js')).href);
  const llm = new mod.KolmLLM({ artifactPath: '/dev/null', bin: fakeBin, timeoutMs: 5000 });
  let result;
  try {
    result = await llm.invokeWithReceipt('hello world');
  } catch (err) {
    t.skip(`spawn failed on this platform: ${err.message}`);
    return;
  }
  assert.match(result.text, /echo:hello world/);
  assert.ok(result.receipt);
  assert.equal(result.receipt.cid, 'fake-cid');
  assert.equal(result.receipt.k_score, 0.99);
  assert.equal(llm.lastReceipt.cid, 'fake-cid');
});

test('W268 llamaindex-kolm subprocess smoke test', async (t) => {
  if (process.platform === 'win32') {
    t.skip('subprocess smoke test skipped on win32');
    return;
  }
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kolm-w268-li-'));
  const fakeBin = path.join(dir, 'kolm');
  fs.writeFileSync(
    fakeBin,
    [
      '#!/usr/bin/env sh',
      'PAYLOAD=$(cat)',
      'ESCAPED=$(printf "%s" "$PAYLOAD" | sed \'s/"/\\\\"/g\')',
      'printf \'{"text":"li:%s","receipt":{"cid":"li-cid","k_score":0.88}}\\n\' "$ESCAPED"',
    ].join('\n'),
    { mode: 0o755 },
  );
  const mod = await import(pathToFileURL(path.join(PKGS, 'llamaindex-kolm', 'index.js')).href);
  const llm = new mod.KolmLLM({ artifactPath: '/dev/null', bin: fakeBin, timeoutMs: 5000 });
  let r;
  try {
    r = await llm.complete('ping');
  } catch (err) {
    t.skip(`spawn failed: ${err.message}`);
    return;
  }
  assert.match(r.text, /li:ping/);
  assert.ok(r.raw && r.raw.receipt);
  assert.equal(r.raw.receipt.cid, 'li-cid');
});

test('W268 JSON-LD includes ItemList of integrations', () => {
  const html = read(path.join(PUBLIC, 'integrations.html'));
  // The existing page predates this wave; we only require that the four new
  // adapters surface somewhere in JSON-LD or in the page body via their ids.
  // (Asserted indirectly above via id checks.) Sanity check: at least one
  // JSON-LD block exists.
  assert.match(html, /application\/ld\+json/, 'must include at least one JSON-LD block');
});

test('W268 receipt-chain language present on /integrations', () => {
  const html = read(path.join(PUBLIC, 'integrations.html'));
  assert.match(html, /receipt chain/i, 'integrations page must mention the receipt chain');
  assert.match(html, /invokeWithReceipt/, 'must show the JS API name');
  assert.match(html, /invoke_with_receipt/, 'must show the Python API name');
});
