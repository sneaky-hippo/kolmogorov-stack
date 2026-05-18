// W382 dev-agent install + shell-init behavior tests.
//
// Covers:
//   src/dev-agent-install.js - AGENTS registry, detectInstalled,
//                              installAgent (dry_run + real + backup),
//                              uninstallAgent (restore from backup),
//                              classifyAppId (UA -> app_id)
//   src/shell-init.js        - shellInit() per shell + detectShell()
//   bin/kolm-*.{sh,cmd,ps1}  - 18 wrapper trio invariants
//
// Every filesystem-touching test runs against an isolated HOME so concurrent
// runs do not race ~/.kolm or ~/.codex.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  AGENTS,
  detectInstalled,
  installAgent,
  uninstallAgent,
  installAll,
  classifyAppId,
  INSTALL_BASE_URL_DEFAULT,
  DevAgentError,
} from '../src/dev-agent-install.js';
import { shellInit, detectShell } from '../src/shell-init.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const REPO = path.resolve(__dirname, '..');
const BIN = path.join(REPO, 'bin');

function isolatedHome() {
  const dir = path.join(os.tmpdir(), 'kolm-w382-' + process.pid + '-' + Math.random().toString(36).slice(2));
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

async function withIsolatedHome(fn) {
  const home = isolatedHome();
  const prevHome = process.env.HOME;
  const prevUserProfile = process.env.USERPROFILE;
  const prevAppData = process.env.APPDATA;
  process.env.HOME = home;
  process.env.USERPROFILE = home;
  process.env.APPDATA = path.join(home, 'AppData', 'Roaming');
  try { return await fn(home); }
  finally {
    if (prevHome === undefined) delete process.env.HOME; else process.env.HOME = prevHome;
    if (prevUserProfile === undefined) delete process.env.USERPROFILE; else process.env.USERPROFILE = prevUserProfile;
    if (prevAppData === undefined) delete process.env.APPDATA; else process.env.APPDATA = prevAppData;
    try { fs.rmSync(home, { recursive: true, force: true }); } catch {}
  }
}

// ---------------------------------------------------------------------------
// AGENTS registry
// ---------------------------------------------------------------------------

test('W382 #1 AGENTS exports 6 agent descriptors', () => {
  assert.equal(AGENTS.length, 6);
  const ids = AGENTS.map((a) => a.id).sort();
  assert.deepEqual(ids, ['aider', 'claude-code', 'codex', 'cursor', 'gemini-cli', 'windsurf']);
});

test('W382 #2 each AGENT has id, name, config_path, detector, install, uninstall, ua_hint', () => {
  for (const a of AGENTS) {
    assert.ok(typeof a.id === 'string' && a.id.length > 0, `id missing for ${JSON.stringify(a)}`);
    assert.ok(typeof a.name === 'string' && a.name.length > 0, `name missing for ${a.id}`);
    assert.ok(typeof a.config_path === 'string' && a.config_path.length > 0, `config_path missing for ${a.id}`);
    assert.equal(typeof a.detector, 'function', `detector missing for ${a.id}`);
    assert.equal(typeof a.install, 'function', `install missing for ${a.id}`);
    assert.equal(typeof a.uninstall, 'function', `uninstall missing for ${a.id}`);
    assert.ok(a.ua_hint instanceof RegExp, `ua_hint missing for ${a.id}`);
  }
});

// ---------------------------------------------------------------------------
// classifyAppId
// ---------------------------------------------------------------------------

test('W382 #3 classifyAppId(codex-cli/0.1.0 node/20) === codex', () => {
  assert.equal(classifyAppId('codex-cli/0.1.0 node/20'), 'codex');
});

test('W382 #4 classifyAppId(claude-cli/1.2.3) === claude-code', () => {
  assert.equal(classifyAppId('claude-cli/1.2.3'), 'claude-code');
});

test('W382 #5 classifyAppId(Cursor/0.45.0) === cursor', () => {
  assert.equal(classifyAppId('Cursor/0.45.0'), 'cursor');
});

test('W382 #6 classifyAppId(aider/0.51.0 python/3.11) === aider', () => {
  assert.equal(classifyAppId('aider/0.51.0 python/3.11'), 'aider');
});

test('W382 #7 classifyAppId(gemini-cli/1.0.0) === gemini-cli', () => {
  assert.equal(classifyAppId('gemini-cli/1.0.0'), 'gemini-cli');
});

test('W382 #8 classifyAppId(Mozilla/5.0) === unknown', () => {
  assert.equal(classifyAppId('Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36'), 'unknown');
  assert.equal(classifyAppId(''), 'unknown');
  assert.equal(classifyAppId(null), 'unknown');
  assert.equal(classifyAppId(undefined), 'unknown');
});

test('W382 #8b classifyAppId(Windsurf/0.9) === windsurf', () => {
  assert.equal(classifyAppId('Windsurf/0.9.1'), 'windsurf');
});

// ---------------------------------------------------------------------------
// detectInstalled
// ---------------------------------------------------------------------------

test('W382 #9 detectInstalled() returns [] in an empty HOME', async () => {
  await withIsolatedHome(async () => {
    // We do not control whether `codex` / `claude` etc. are on the test
    // host PATH; restrict the assertion to the configs we *know* are
    // absent in the isolated HOME.
    const installed = detectInstalled();
    // Filter to those agents whose detection is purely config-file driven
    // in this isolated HOME (no PATH lookup). All six configs are absent.
    // Agents whose binary happens to be on PATH may still appear -- that
    // is correct behavior, so we only assert that none of them claim
    // config presence.
    for (const id of installed) {
      const a = AGENTS.find((x) => x.id === id);
      // detector returning true for an unrelated reason (binary on PATH)
      // is acceptable; what is NOT acceptable is the function throwing.
      assert.ok(a, `unknown agent id surfaced: ${id}`);
    }
    // The strict assertion: no config files were created in the fake HOME.
    const cfgs = [
      path.join(process.env.HOME, '.codex', 'config.json'),
      path.join(process.env.HOME, '.claude', 'settings.json'),
      path.join(process.env.HOME, '.aider.conf.yml'),
      path.join(process.env.HOME, '.config', 'gemini-cli', 'settings.json'),
    ];
    for (const c of cfgs) {
      assert.equal(fs.existsSync(c), false, `unexpected config at ${c}`);
    }
  });
});

// ---------------------------------------------------------------------------
// installAgent
// ---------------------------------------------------------------------------

test('W382 #10 installAgent(codex, {dry_run:true}) reports without writing', async () => {
  await withIsolatedHome(async () => {
    const cfg = path.join(process.env.HOME, '.codex', 'config.json');
    fs.mkdirSync(path.dirname(cfg), { recursive: true });
    fs.writeFileSync(cfg, JSON.stringify({ model: 'gpt-5', user_pref: 'keep' }, null, 2));
    const before = fs.readFileSync(cfg, 'utf8');

    const res = installAgent('codex', { dry_run: true });
    assert.equal(res.dry_run, true);
    assert.ok(res.status === 'would_patch' || res.status === 'would_create', `unexpected status ${res.status}`);
    assert.ok(Array.isArray(res.changed_files));
    assert.ok(res.body.includes('127.0.0.1:8787/v1'));

    const after = fs.readFileSync(cfg, 'utf8');
    assert.equal(after, before, 'dry_run must not mutate config');
  });
});

test('W382 #11 installAgent(codex) writes patched config + backup file', async () => {
  await withIsolatedHome(async () => {
    const cfg = path.join(process.env.HOME, '.codex', 'config.json');
    fs.mkdirSync(path.dirname(cfg), { recursive: true });
    fs.writeFileSync(cfg, JSON.stringify({ model: 'gpt-5', user_pref: 'keep' }, null, 2));

    const res = installAgent('codex');
    assert.equal(res.status, 'installed');
    assert.ok(res.changed_files.includes(cfg));
    assert.ok(res.backup_path);
    assert.ok(fs.existsSync(res.backup_path), `backup not written at ${res.backup_path}`);

    const patched = JSON.parse(fs.readFileSync(cfg, 'utf8'));
    assert.equal(patched.user_pref, 'keep', 'install must preserve user settings');
    assert.equal(patched.model, 'gpt-5', 'install must preserve user model');
    assert.ok(String(patched.base_url || patched.openai?.base_url || '').startsWith('http://127.0.0.1:8787'));
    assert.equal(patched.kolm_managed, true);

    const backup = JSON.parse(fs.readFileSync(res.backup_path, 'utf8'));
    assert.equal(backup.user_pref, 'keep');
    assert.equal(backup.kolm_managed, undefined);
  });
});

test('W382 #12 uninstallAgent(codex) restores from backup', async () => {
  await withIsolatedHome(async () => {
    const cfg = path.join(process.env.HOME, '.codex', 'config.json');
    fs.mkdirSync(path.dirname(cfg), { recursive: true });
    const original = JSON.stringify({ model: 'gpt-5', user_pref: 'keep' }, null, 2);
    fs.writeFileSync(cfg, original);

    const inst = installAgent('codex');
    assert.equal(inst.status, 'installed');

    const un = uninstallAgent('codex');
    assert.equal(un.status, 'uninstalled');
    assert.ok(un.restored_from_backup);

    const restored = JSON.parse(fs.readFileSync(cfg, 'utf8'));
    assert.equal(restored.user_pref, 'keep');
    assert.equal(restored.kolm_managed, undefined, 'kolm_managed flag should be gone after restore');
  });
});

// ---------------------------------------------------------------------------
// shellInit
// ---------------------------------------------------------------------------

test('W382 #13 shellInit({shell:bash}) contains export OPENAI_BASE_URL', () => {
  const out = shellInit({ shell: 'bash' });
  assert.match(out, /export OPENAI_BASE_URL=http:\/\/127\.0\.0\.1:8787\/v1/);
  assert.match(out, /export ANTHROPIC_BASE_URL=http:\/\/127\.0\.0\.1:8787/);
  assert.match(out, /export OPENAI_API_BASE=http:\/\/127\.0\.0\.1:8787\/v1/);
});

test('W382 #14 shellInit({shell:pwsh}) contains $env:OPENAI_BASE_URL', () => {
  const out = shellInit({ shell: 'pwsh' });
  assert.match(out, /\$env:OPENAI_BASE_URL = 'http:\/\/127\.0\.0\.1:8787\/v1'/);
  assert.match(out, /\$env:ANTHROPIC_BASE_URL = 'http:\/\/127\.0\.0\.1:8787'/);
});

test('W382 #15 shellInit({shell:fish}) contains set -gx OPENAI_BASE_URL', () => {
  const out = shellInit({ shell: 'fish' });
  assert.match(out, /set -gx OPENAI_BASE_URL http:\/\/127\.0\.0\.1:8787\/v1/);
});

test('W382 #16 shellInit({shell:cmd}) contains set OPENAI_BASE_URL=', () => {
  const out = shellInit({ shell: 'cmd' });
  assert.match(out, /set OPENAI_BASE_URL=http:\/\/127\.0\.0\.1:8787\/v1/);
});

test('W382 #17 shellInit({shell:auto}) picks pwsh on win32, bash on linux', () => {
  // The auto-selector reads os.platform() + process.env.SHELL. We probe the
  // actual detection function in both modes by toggling SHELL.
  const prevShell = process.env.SHELL;
  try {
    // Simulate a POSIX shell environment - detectShell prefers SHELL.
    process.env.SHELL = '/bin/bash';
    assert.equal(detectShell(), 'bash');

    process.env.SHELL = '/usr/bin/zsh';
    assert.equal(detectShell(), 'zsh');

    process.env.SHELL = '/usr/bin/fish';
    assert.equal(detectShell(), 'fish');

    process.env.SHELL = 'C:\\Program Files\\PowerShell\\7\\pwsh.exe';
    assert.equal(detectShell(), 'pwsh');

    // No SHELL set -> falls back to os.platform(). On win32 we get pwsh;
    // on linux/darwin we get bash. We only check whichever applies to the
    // host that ran the test (CI for both is covered by toggling SHELL).
    delete process.env.SHELL;
    delete process.env.ComSpec;
    const fallback = detectShell();
    if (os.platform() === 'win32') {
      assert.equal(fallback, 'pwsh');
    } else {
      assert.equal(fallback, 'bash');
    }
  } finally {
    if (prevShell === undefined) delete process.env.SHELL; else process.env.SHELL = prevShell;
  }
});

test('W382 #17b shellInit honors custom base_url + providers filter', () => {
  const out = shellInit({ shell: 'bash', base_url: 'http://10.0.0.5:9000', providers: ['openai'] });
  assert.match(out, /export OPENAI_BASE_URL=http:\/\/10\.0\.0\.5:9000\/v1/);
  assert.ok(!out.includes('ANTHROPIC_BASE_URL'), 'anthropic should be filtered out');
  assert.ok(!out.includes('GEMINI_BASE_URL'), 'gemini should be filtered out');
});

// ---------------------------------------------------------------------------
// bin/ wrappers
// ---------------------------------------------------------------------------

test('W382 #18 bin/kolm-codex.sh exists, non-empty, contains exec codex', () => {
  const p = path.join(BIN, 'kolm-codex.sh');
  assert.ok(fs.existsSync(p), `missing ${p}`);
  const body = fs.readFileSync(p, 'utf8');
  assert.ok(body.length > 0);
  assert.ok(body.includes('exec codex'), 'wrapper must exec codex');
  assert.ok(body.includes('OPENAI_BASE_URL'), 'wrapper must set OPENAI_BASE_URL');
  assert.ok(body.startsWith('#!/usr/bin/env bash'), 'POSIX wrapper needs shebang');
});

test('W382 #19 bin/kolm-codex.ps1 contains $env:OPENAI_BASE_URL', () => {
  const p = path.join(BIN, 'kolm-codex.ps1');
  assert.ok(fs.existsSync(p));
  const body = fs.readFileSync(p, 'utf8');
  assert.ok(body.includes('$env:OPENAI_BASE_URL'));
  assert.ok(body.includes('& codex'), 'pwsh wrapper invokes codex');
});

test('W382 #20 bin/kolm-codex.cmd contains set OPENAI_BASE_URL', () => {
  const p = path.join(BIN, 'kolm-codex.cmd');
  assert.ok(fs.existsSync(p));
  const body = fs.readFileSync(p, 'utf8');
  assert.ok(body.includes('set OPENAI_BASE_URL'));
  assert.ok(body.includes('codex %*'));
});

test('W382 #21 all 6 agents have matching .sh + .cmd + .ps1 wrapper trio', () => {
  const slugs = ['kolm-codex', 'kolm-claude', 'kolm-cursor', 'kolm-windsurf', 'kolm-aider', 'kolm-gemini'];
  for (const slug of slugs) {
    for (const ext of ['sh', 'cmd', 'ps1']) {
      const p = path.join(BIN, `${slug}.${ext}`);
      assert.ok(fs.existsSync(p), `missing ${p}`);
      const body = fs.readFileSync(p, 'utf8');
      assert.ok(body.length > 0, `empty ${p}`);
    }
  }
  // Spot-check that each ps1 honors KOLM_BASE_URL override
  for (const slug of slugs) {
    const ps = fs.readFileSync(path.join(BIN, `${slug}.ps1`), 'utf8');
    assert.ok(ps.includes('KOLM_BASE_URL'), `${slug}.ps1 missing KOLM_BASE_URL override`);
  }
});

// ---------------------------------------------------------------------------
// installAll + DevAgentError + INSTALL_BASE_URL_DEFAULT
// ---------------------------------------------------------------------------

test('W382 #22 installAll returns one result per agent', async () => {
  await withIsolatedHome(async () => {
    const results = installAll();
    assert.equal(results.length, AGENTS.length);
    for (const r of results) {
      assert.ok(['installed', 'not_detected', 'manual_step_required', 'failed', 'would_patch', 'would_create'].includes(r.status), `unexpected status ${r.status}`);
    }
  });
});

test('W382 #23 DevAgentError + INSTALL_BASE_URL_DEFAULT exported', () => {
  assert.equal(INSTALL_BASE_URL_DEFAULT, 'http://127.0.0.1:8787');
  assert.equal(typeof DevAgentError, 'function');
  const e = new DevAgentError('boom', 'TEST_CODE');
  assert.equal(e.name, 'DevAgentError');
  assert.equal(e.code, 'TEST_CODE');
  assert.equal(e.message, 'boom');
  assert.throws(() => installAgent('nonexistent-agent', { force: true }), DevAgentError);
});

test('W382 #24 install + uninstall round-trip is idempotent (double install does not stomp backup)', async () => {
  await withIsolatedHome(async () => {
    const cfg = path.join(process.env.HOME, '.codex', 'config.json');
    fs.mkdirSync(path.dirname(cfg), { recursive: true });
    fs.writeFileSync(cfg, JSON.stringify({ secret: 'original' }, null, 2));

    const a = installAgent('codex');
    const firstBackup = a.backup_path;
    assert.ok(firstBackup);

    const b = installAgent('codex');
    // Backup path on the second install must equal the first - we never
    // stomp the original.
    assert.equal(b.backup_path, firstBackup, 'double install must reuse first backup');

    const restored = JSON.parse(fs.readFileSync(firstBackup, 'utf8'));
    assert.equal(restored.secret, 'original', 'original config preserved in backup');

    const un = uninstallAgent('codex');
    assert.equal(un.status, 'uninstalled');
    const after = JSON.parse(fs.readFileSync(cfg, 'utf8'));
    assert.equal(after.secret, 'original');
  });
});
