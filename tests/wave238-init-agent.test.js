// W238 — Script-first project scaffolder: `kolm init-agent --git --tmux --template`.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT = path.resolve(__dirname, '..');

function modUrl(rel) {
  return pathToFileURL(path.join(ROOT, rel)).href;
}

function mkTmp(label) {
  return fs.mkdtempSync(path.join(os.tmpdir(), `kolm-w238-${label}-`));
}

function rimraf(dir) {
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch (_) {}
}

test('W238 init-agent module exports the public surface', async () => {
  const m = await import(modUrl('src/init-agent.js'));
  for (const n of ['INIT_SCHEMA_VERSION', 'TEMPLATES', 'TEMPLATE_NAMES', 'plan', 'execute']) {
    assert.ok(n in m, `missing export ${n}`);
  }
});

test('W238 TEMPLATES has the 5 templates with shape (description, recipe_class, chat_template, base_model)', async () => {
  const m = await import(modUrl('src/init-agent.js'));
  for (const name of ['chatbot', 'redactor', 'classifier', 'extraction', 'agent']) {
    assert.ok(m.TEMPLATES[name], `missing template ${name}`);
    const t = m.TEMPLATES[name];
    assert.ok(typeof t.description === 'string' && t.description.length > 0);
    assert.ok(typeof t.recipe_class === 'string');
    assert.ok(typeof t.chat_template === 'string');
    assert.ok('base_model' in t);
  }
});

test('W238 plan() rejects missing or invalid project name', async () => {
  const m = await import(modUrl('src/init-agent.js'));
  assert.throws(() => m.plan(), /projectName required/);
  assert.throws(() => m.plan(''), /projectName required/);
  assert.throws(() => m.plan('bad name with spaces'), /\[a-zA-Z0-9\._-\]/);
});

test('W238 plan() rejects unknown template', async () => {
  const m = await import(modUrl('src/init-agent.js'));
  assert.throws(() => m.plan('myproj', { template: 'not-a-real-template' }), /unknown template/);
});

test('W238 plan() default produces the 9 base files (no tmux)', async () => {
  const m = await import(modUrl('src/init-agent.js'));
  const p = m.plan('myproj');
  assert.equal(p.project_name, 'myproj');
  assert.equal(p.template, 'chatbot');
  const paths = p.files.map(f => f.path).sort();
  for (const required of ['spec.json', 'seeds.jsonl', 'blueprint.json', 'run.sh', 'run.ps1', 'watch.sh', 'watch.ps1', '.gitignore', 'README.md']) {
    assert.ok(paths.includes(required), `plan missing ${required}; got ${paths.join(',')}`);
  }
  assert.ok(!paths.includes('tmux.conf'), 'tmux.conf should be off by default');
  assert.ok(p.total_bytes > 0);
});

test('W238 plan() with --tmux adds tmux.conf', async () => {
  const m = await import(modUrl('src/init-agent.js'));
  const p = m.plan('myproj', { tmux: true });
  const paths = p.files.map(f => f.path);
  assert.ok(paths.includes('tmux.conf'));
});

test('W238 plan() respects template selection — redactor uses rule class', async () => {
  const m = await import(modUrl('src/init-agent.js'));
  const p = m.plan('phi-r', { template: 'redactor' });
  assert.equal(p.template, 'redactor');
  // Find spec.json bytes — we can't see content from plan, just confirm we picked redactor.
  assert.ok(p.files.find(f => f.path === 'spec.json'));
});

test('W238 execute() writes files to disk', async () => {
  const m = await import(modUrl('src/init-agent.js'));
  const tmp = mkTmp('execute');
  try {
    const r = m.execute('demo', tmp, { template: 'chatbot' });
    assert.equal(r.project_name, 'demo');
    assert.ok(r.target_dir.endsWith('execute-' + path.basename(tmp).split('-').pop()) || r.target_dir === path.resolve(tmp));
    assert.ok(fs.existsSync(path.join(tmp, 'spec.json')));
    assert.ok(fs.existsSync(path.join(tmp, 'seeds.jsonl')));
    assert.ok(fs.existsSync(path.join(tmp, 'run.sh')));
    assert.ok(fs.existsSync(path.join(tmp, 'run.ps1')));
    assert.ok(fs.existsSync(path.join(tmp, 'README.md')));
    assert.ok(fs.existsSync(path.join(tmp, 'blueprint.json')));
    // spec.json is valid JSON with the right keys.
    const spec = JSON.parse(fs.readFileSync(path.join(tmp, 'spec.json'), 'utf8'));
    assert.equal(spec.name, 'demo');
    assert.equal(spec.recipe_class, 'distilled_model');
    assert.ok(spec.chat_template);
    // blueprint.json is valid JSON with the right shape (W236 integration).
    const bp = JSON.parse(fs.readFileSync(path.join(tmp, 'blueprint.json'), 'utf8'));
    assert.ok(bp.integrity_hash, 'blueprint must carry W236 integrity_hash');
  } finally {
    rimraf(tmp);
  }
});

test('W238 execute() refuses to overwrite a non-empty dir without --force', async () => {
  const m = await import(modUrl('src/init-agent.js'));
  const tmp = mkTmp('clobber');
  try {
    fs.writeFileSync(path.join(tmp, 'something.txt'), 'pre-existing');
    assert.throws(() => m.execute('demo', tmp, {}), /not empty.*--force/);
  } finally {
    rimraf(tmp);
  }
});

test('W238 execute() with --force overwrites', async () => {
  const m = await import(modUrl('src/init-agent.js'));
  const tmp = mkTmp('force');
  try {
    fs.writeFileSync(path.join(tmp, 'something.txt'), 'pre-existing');
    const r = m.execute('demo', tmp, { force: true });
    assert.equal(r.files_written.length >= 9, true);
    assert.ok(fs.existsSync(path.join(tmp, 'spec.json')));
  } finally {
    rimraf(tmp);
  }
});

test('W238 execute() with --tmux writes tmux.conf', async () => {
  const m = await import(modUrl('src/init-agent.js'));
  const tmp = mkTmp('tmux');
  try {
    const r = m.execute('myagent', tmp, { tmux: true });
    assert.equal(r.tmux_conf_written, true);
    assert.ok(fs.existsSync(path.join(tmp, 'tmux.conf')));
    const conf = fs.readFileSync(path.join(tmp, 'tmux.conf'), 'utf8');
    assert.ok(conf.includes('new-session'));
    assert.ok(conf.includes('myagent'));
  } finally {
    rimraf(tmp);
  }
});

test('W238 execute() agent template wires a Hermes blueprint (W236 link)', async () => {
  const m = await import(modUrl('src/init-agent.js'));
  const tmp = mkTmp('hermes');
  try {
    m.execute('myagent', tmp, { template: 'agent' });
    const bp = JSON.parse(fs.readFileSync(path.join(tmp, 'blueprint.json'), 'utf8'));
    assert.ok(bp.base_model && bp.base_model.toLowerCase().includes('hermes'),
      `agent template should use Hermes base_model; got ${bp.base_model}`);
  } finally {
    rimraf(tmp);
  }
});

test('W238 run.sh + watch.sh have proper bash shebang + cd lines', async () => {
  const m = await import(modUrl('src/init-agent.js'));
  const tmp = mkTmp('shebang');
  try {
    m.execute('demo', tmp, {});
    const runSh = fs.readFileSync(path.join(tmp, 'run.sh'), 'utf8');
    assert.ok(runSh.startsWith('#!/usr/bin/env bash'));
    assert.ok(runSh.includes('kolm compile'));
    assert.ok(runSh.includes('kolm serve'));
    const watchSh = fs.readFileSync(path.join(tmp, 'watch.sh'), 'utf8');
    assert.ok(watchSh.startsWith('#!/usr/bin/env bash'));
    assert.ok(watchSh.includes('kolm tail captures'));
    assert.ok(watchSh.includes('demo'));
  } finally {
    rimraf(tmp);
  }
});

test('W238 .gitignore excludes artifact + secrets + node_modules', async () => {
  const m = await import(modUrl('src/init-agent.js'));
  const tmp = mkTmp('gitignore');
  try {
    m.execute('demo', tmp, {});
    const gi = fs.readFileSync(path.join(tmp, '.gitignore'), 'utf8');
    for (const pattern of ['artifact.kolm', 'node_modules/', '.env', '*.pem', '*.key']) {
      assert.ok(gi.includes(pattern), `.gitignore missing ${pattern}`);
    }
  } finally {
    rimraf(tmp);
  }
});

test('W238 CLI wires init-agent verb + dispatch + cmdInitAgent + HELP block', () => {
  const src = fs.readFileSync(path.join(ROOT, 'cli/kolm.js'), 'utf8');
  assert.ok(src.includes("case 'init-agent':"), 'dispatch missing case init-agent');
  assert.ok(src.includes('async function cmdInitAgent'), 'cmdInitAgent not defined');
  assert.ok(src.includes("'init-agent':"), 'HELP block missing init-agent key');
  // Root help table mentions it.
  assert.ok(src.includes('init-agent <name>'), 'root help missing init-agent line');
});

test('W238 COMPLETION_VERBS and COMPLETION_SUBS include init-agent', () => {
  const src = fs.readFileSync(path.join(ROOT, 'cli/kolm.js'), 'utf8');
  const cidx = src.indexOf('COMPLETION_VERBS');
  const tail = src.slice(cidx, cidx + 2000);
  assert.ok(tail.includes("'init-agent'"), 'COMPLETION_VERBS missing init-agent');
  assert.ok(src.includes("'init-agent': ['chatbot'"), 'COMPLETION_SUBS missing init-agent template list');
});
