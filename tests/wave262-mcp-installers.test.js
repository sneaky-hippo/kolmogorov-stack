// Wave 262: one-click MCP installers for Cursor, Continue.dev, Claude Desktop,
// VS Code, and Windsurf. Five landing pages + one node installer + 5 vercel
// rewrites + sw.js bump.
//
// These tests assert: (a) all 5 install pages exist with hero text + copy-paste
// command box; (b) scripts/install-mcp.cjs behaves correctly on empty,
// different, and identical-existing configs (idempotency); (c) vercel.json has
// all 5 rewrites; (d) public/sw.js CACHE constant updated. All filesystem work
// happens in os.tmpdir() - we NEVER touch the user's real config files.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { createRequire } from 'node:module';

const ROOT = path.resolve(import.meta.dirname, '..');
const PUBLIC = path.join(ROOT, 'public');
const INSTALL_DIR = path.join(PUBLIC, 'install');
const INSTALLER = path.join(ROOT, 'scripts', 'install-mcp.cjs');
const VERCEL = path.join(ROOT, 'vercel.json');
const SW = path.join(PUBLIC, 'sw.js');
const CLI = path.join(ROOT, 'cli', 'kolm.js');

const HARNESSES = ['cursor', 'continue', 'claude-desktop', 'vscode', 'windsurf'];
const HERO_TEXT = {
  'cursor': 'kolm.ai for Cursor',
  'continue': 'kolm.ai for Continue.dev',
  'claude-desktop': 'kolm.ai for Claude Desktop',
  'vscode': 'kolm.ai for VS Code',
  'windsurf': 'kolm.ai for Windsurf',
};

function makeScratch() {
  const dir = path.join(os.tmpdir(), `kolm-w262-${crypto.randomBytes(6).toString('hex')}`);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function loadInstaller() {
  // The installer is a CJS module; load via createRequire so the ESM test
  // runner can call install() / KOLM_BLOCK / HARNESSES directly.
  const req = createRequire(import.meta.url);
  // Bust the require cache so per-test loads see fresh state if needed.
  delete req.cache[req.resolve(INSTALLER)];
  return req(INSTALLER);
}

// --------------------------------------------------------------------------
// Group A - five install pages exist with correct hero + copy-paste command.
// --------------------------------------------------------------------------

for (const harness of HARNESSES) {
  test(`W262 page - public/install/${harness}.html exists`, () => {
    const fp = path.join(INSTALL_DIR, `${harness}.html`);
    assert.ok(fs.existsSync(fp), `install page must exist: ${fp}`);
    const stat = fs.statSync(fp);
    assert.ok(stat.size > 2000, `install page must have real content (got ${stat.size}b)`);
  });

  test(`W262 page - ${harness} page has the expected hero text`, () => {
    const html = fs.readFileSync(path.join(INSTALL_DIR, `${harness}.html`), 'utf8');
    assert.ok(html.includes('<h1>' + HERO_TEXT[harness] + '</h1>'),
      `hero h1 must read exactly "${HERO_TEXT[harness]}"`);
    assert.ok(html.includes('kolm.ai'), 'kolm.ai must appear in title/branding');
    assert.match(html, /<title>[^<]*kolm\.ai[^<]*<\/title>/, 'title must include kolm.ai');
  });

  test(`W262 page - ${harness} page has a copy-paste install command box`, () => {
    const html = fs.readFileSync(path.join(INSTALL_DIR, `${harness}.html`), 'utf8');
    assert.ok(html.includes('class="cmdbox"'),
      'page must have a .cmdbox copy-paste container');
    assert.ok(html.includes(`node scripts/install-mcp.cjs ${harness}`),
      `cmdbox must contain "node scripts/install-mcp.cjs ${harness}"`);
    assert.ok(html.includes('class="copy"'),
      'cmdbox must have a copy button');
  });

  test(`W262 page - ${harness} page has the three-step setup-after-install grid`, () => {
    const html = fs.readFileSync(path.join(INSTALL_DIR, `${harness}.html`), 'utf8');
    assert.ok(html.includes('class="grid3"'), 'must have a three-step .grid3 container');
    assert.ok(html.match(/class="n">step 1</), 'must have step 1');
    assert.ok(html.match(/class="n">step 2</), 'must have step 2');
    assert.ok(html.match(/class="n">step 3</), 'must have step 3');
    assert.ok(html.includes('What this does'), 'must have a "What this does" expandable section');
  });

  test(`W262 page - ${harness} page uses kolm.ai dark theme tokens + light-theme switch`, () => {
    const html = fs.readFileSync(path.join(INSTALL_DIR, `${harness}.html`), 'utf8');
    assert.ok(html.includes('--ink:#ece7dc'), 'must include the dark-theme ink token');
    assert.ok(html.includes('--bg:#0b0d10'), 'must include the dark-theme bg token');
    assert.ok(html.includes('--accent:#10b981'), 'must include the kolm accent token');
    assert.ok(html.includes("data-theme='light'") || html.includes('data-theme="light"'),
      'must include the light-theme switch IIFE');
  });

  test(`W262 page - ${harness} page has no em-dashes (style budget)`, () => {
    const html = fs.readFileSync(path.join(INSTALL_DIR, `${harness}.html`), 'utf8');
    const emDashes = (html.match(/—/g) || []).length;
    assert.equal(emDashes, 0, `page must contain 0 em-dashes; found ${emDashes}`);
  });
}

// --------------------------------------------------------------------------
// Group B - installer behavior (empty, merge, idempotent, conflict, force).
// --------------------------------------------------------------------------

test('W262 installer - module exports the documented surface', () => {
  const mod = loadInstaller();
  for (const k of ['install', 'HARNESSES', 'KOLM_BLOCK', 'atomicWriteJson', 'readJsonSafe', 'jsonEqual', 'cli']) {
    assert.ok(k in mod, `installer must export ${k}`);
  }
  assert.equal(typeof mod.install, 'function');
  assert.deepEqual(mod.KOLM_BLOCK, { command: 'kolm', args: ['serve', '--mcp'], env: {} });
  for (const h of HARNESSES) {
    assert.ok(mod.HARNESSES[h], `installer must know harness ${h}`);
  }
});

test('W262 installer - empty config gets the kolm block written', () => {
  const mod = loadInstaller();
  const scratch = makeScratch();
  const cfg = path.join(scratch, 'mcp.json');
  const result = mod.install('cursor', { configPath: cfg });
  assert.equal(result.status, 'wrote');
  assert.equal(result.configPath, cfg);
  assert.ok(fs.existsSync(cfg), 'config file must be created on disk');
  const parsed = JSON.parse(fs.readFileSync(cfg, 'utf8'));
  assert.deepEqual(parsed.mcpServers.kolm, mod.KOLM_BLOCK,
    'kolm block must match the canonical KOLM_BLOCK exactly');
});

test('W262 installer - existing-but-different config gets merged, other servers preserved', () => {
  const mod = loadInstaller();
  const scratch = makeScratch();
  const cfg = path.join(scratch, 'mcp.json');
  const existing = {
    mcpServers: {
      other: { command: 'other-server', args: ['--foo'] },
      another: { command: 'another', args: [] },
    },
    settings: { themePreference: 'dark' },
  };
  fs.writeFileSync(cfg, JSON.stringify(existing, null, 2), 'utf8');

  const result = mod.install('claude-desktop', { configPath: cfg });
  assert.equal(result.status, 'wrote', 'fresh kolm install on existing-but-different config must write');

  const parsed = JSON.parse(fs.readFileSync(cfg, 'utf8'));
  assert.deepEqual(parsed.mcpServers.other, existing.mcpServers.other, 'other server must be preserved');
  assert.deepEqual(parsed.mcpServers.another, existing.mcpServers.another, 'another server must be preserved');
  assert.deepEqual(parsed.mcpServers.kolm, mod.KOLM_BLOCK, 'kolm block must be added');
  assert.deepEqual(parsed.settings, existing.settings, 'sibling keys outside mcpServers must be preserved');
});

test('W262 installer - existing-with-kolm-block stays identical on rerun (idempotency)', () => {
  const mod = loadInstaller();
  const scratch = makeScratch();
  const cfg = path.join(scratch, 'mcp.json');

  // First run: writes the kolm block.
  const r1 = mod.install('vscode', { configPath: cfg });
  assert.equal(r1.status, 'wrote');
  const body1 = fs.readFileSync(cfg, 'utf8');
  const mtime1 = fs.statSync(cfg).mtimeMs;

  // Second run: must be a no-op (status=unchanged, file untouched).
  const r2 = mod.install('vscode', { configPath: cfg });
  assert.equal(r2.status, 'unchanged', 'rerun on identical kolm block must be unchanged');
  const body2 = fs.readFileSync(cfg, 'utf8');
  assert.equal(body1, body2, 'file contents must be byte-identical on rerun');

  // Third run: still unchanged, idempotent across N reruns.
  const r3 = mod.install('vscode', { configPath: cfg });
  assert.equal(r3.status, 'unchanged');
});

test('W262 installer - differing kolm block triggers conflict (no overwrite without --force)', () => {
  const mod = loadInstaller();
  const scratch = makeScratch();
  const cfg = path.join(scratch, 'mcp.json');
  const evil = {
    mcpServers: {
      kolm: { command: 'evil-kolm', args: ['--rm', '-rf', '/'], env: { SECRET: 'leak' } },
    },
  };
  fs.writeFileSync(cfg, JSON.stringify(evil, null, 2), 'utf8');

  const result = mod.install('windsurf', { configPath: cfg });
  assert.equal(result.status, 'conflict', 'differing kolm block must produce conflict');
  assert.ok(result.diff, 'conflict result must include a diff');
  assert.ok(result.diff.includes('evil-kolm'), 'diff must surface the existing command');

  // Disk must NOT have been touched.
  const after = JSON.parse(fs.readFileSync(cfg, 'utf8'));
  assert.deepEqual(after, evil, 'conflict path must leave file untouched');
});

test('W262 installer - --force overwrites a differing kolm block, preserves siblings', () => {
  const mod = loadInstaller();
  const scratch = makeScratch();
  const cfg = path.join(scratch, 'mcp.json');
  const before = {
    mcpServers: {
      kolm: { command: 'old-kolm', args: ['old'] },
      keeper: { command: 'keeper', args: [] },
    },
  };
  fs.writeFileSync(cfg, JSON.stringify(before, null, 2), 'utf8');

  const result = mod.install('continue', { configPath: cfg, force: true });
  assert.equal(result.status, 'wrote', '--force on conflict must write');

  const after = JSON.parse(fs.readFileSync(cfg, 'utf8'));
  assert.deepEqual(after.mcpServers.kolm, mod.KOLM_BLOCK, 'kolm block must be canonical after --force');
  assert.deepEqual(after.mcpServers.keeper, before.mcpServers.keeper, 'sibling server must survive --force');
});

test('W262 installer - dry-run does not touch disk and returns the JSON body', () => {
  const mod = loadInstaller();
  const scratch = makeScratch();
  const cfg = path.join(scratch, 'mcp.json');

  const result = mod.install('cursor', { configPath: cfg, dryRun: true });
  assert.equal(result.status, 'dry-run');
  assert.ok(!fs.existsSync(cfg), 'dry-run must NOT create the config file');
  assert.ok(result.written, 'dry-run must return the would-be JSON body');
  const parsed = JSON.parse(result.written);
  assert.deepEqual(parsed.mcpServers.kolm, mod.KOLM_BLOCK);
});

test('W262 installer - unknown harness returns unknown-harness status', () => {
  const mod = loadInstaller();
  const result = mod.install('emacs-magit', {});
  assert.equal(result.status, 'unknown-harness');
});

test('W262 installer - cross-platform resolve() returns the documented path per harness', () => {
  const mod = loadInstaller();
  // Cursor: ~/.cursor/mcp.json on every platform.
  assert.ok(mod.HARNESSES.cursor.resolve().endsWith(path.join('.cursor', 'mcp.json')));
  // VS Code: ~/.vscode/mcp.json on every platform.
  assert.ok(mod.HARNESSES.vscode.resolve().endsWith(path.join('.vscode', 'mcp.json')));
  // Windsurf: ~/.windsurf/mcp.json on every platform.
  assert.ok(mod.HARNESSES.windsurf.resolve().endsWith(path.join('.windsurf', 'mcp.json')));
  // Continue: ~/.continue/config.json on every platform.
  assert.ok(mod.HARNESSES.continue.resolve().endsWith(path.join('.continue', 'config.json')));
  // Claude Desktop: per-platform - must end with claude_desktop_config.json on all.
  const cd = mod.HARNESSES['claude-desktop'].resolve();
  assert.ok(cd.endsWith('claude_desktop_config.json'),
    `claude-desktop path must end with claude_desktop_config.json (got ${cd})`);
  // Per-platform paths table must list all three OS variants.
  const paths = mod.HARNESSES['claude-desktop'].paths;
  assert.ok(paths.darwin.includes('Library/Application Support/Claude'),
    'darwin path must use Library/Application Support/Claude');
  assert.ok(paths.win32.includes('APPDATA') && paths.win32.includes('Claude'),
    'win32 path must reference APPDATA and Claude');
  assert.ok(paths.linux.includes('.config/Claude'),
    'linux path must use ~/.config/Claude');
});

test('W262 installer - atomic write produces well-formed JSON with trailing newline', () => {
  const mod = loadInstaller();
  const scratch = makeScratch();
  const cfg = path.join(scratch, 'mcp.json');
  mod.install('cursor', { configPath: cfg });
  const raw = fs.readFileSync(cfg, 'utf8');
  assert.ok(raw.endsWith('\n'), 'config file must end with a newline');
  // No tmp file left behind.
  const stragglers = fs.readdirSync(scratch).filter((n) => n.startsWith('mcp.json.tmp-'));
  assert.equal(stragglers.length, 0, 'atomic write must not leave .tmp- files behind');
});

test('W262 installer - unparseable existing JSON refuses without --force', () => {
  const mod = loadInstaller();
  const scratch = makeScratch();
  const cfg = path.join(scratch, 'mcp.json');
  fs.writeFileSync(cfg, '{ this is not valid json', 'utf8');
  const result = mod.install('cursor', { configPath: cfg });
  assert.equal(result.status, 'conflict', 'unparseable config must produce conflict');
  assert.equal(result.reason, 'unparseable');
  // Disk untouched.
  assert.equal(fs.readFileSync(cfg, 'utf8'), '{ this is not valid json');
});

// --------------------------------------------------------------------------
// Group C - vercel.json + sw.js wiring + CLI integration.
// --------------------------------------------------------------------------

test('W262 wiring - vercel.json has all 5 install rewrites', () => {
  const vc = JSON.parse(fs.readFileSync(VERCEL, 'utf8'));
  const rewrites = vc.rewrites || [];
  for (const h of HARNESSES) {
    const found = rewrites.find((r) => r.source === `/install/${h}`);
    assert.ok(found, `vercel.json must have a rewrite for /install/${h}`);
    assert.equal(found.destination, `/install/${h}.html`,
      `rewrite for /install/${h} must point to /install/${h}.html`);
  }
});

test('W262 wiring - public/sw.js CACHE constant bumped to >= wave262', () => {
  // Wave-floor pattern per W171 lesson: later wave bumps must not regress
  // this test. We assert the cache string has the canonical kolm-v7- prefix
  // and that the wave segment is a number >= 262.
  const sw = fs.readFileSync(SW, 'utf8');
  const m = sw.match(/const CACHE = 'kolm-v7-[0-9-]+-wave(\d+)-/);
  assert.ok(m, 'sw.js must have the canonical CACHE constant');
  const wave = Number(m[1]);
  assert.ok(wave >= 262, `sw.js CACHE wave must be >= 262 (got ${wave})`);
});

test('W262 wiring - cli/kolm.js HARNESS_SNIPPETS registers claude-desktop / vscode / windsurf', () => {
  const cli = fs.readFileSync(CLI, 'utf8');
  for (const h of ['claude-desktop', 'vscode', 'windsurf']) {
    assert.ok(cli.includes(`'${h}'`), `cli/kolm.js must register harness '${h}'`);
  }
  // The W262 router must delegate to scripts/install-mcp.cjs.
  assert.ok(cli.includes('w262-installer'), 'cli/kolm.js must have the w262-installer route');
  assert.ok(cli.includes('install-mcp.cjs'), 'cli/kolm.js must reference scripts/install-mcp.cjs');
});

test('W262 wiring - install help text lists all 7 harnesses', () => {
  const cli = fs.readFileSync(CLI, 'utf8');
  // The help block uses the format "HARNESSES" and lists each one.
  const helpStart = cli.indexOf('install: `kolm install');
  assert.ok(helpStart > -1, 'install help block must exist');
  const helpEnd = cli.indexOf('`,', helpStart + 30);
  const helpText = cli.slice(helpStart, helpEnd);
  for (const h of ['claude-code', 'cursor', 'continue', 'cline', 'claude-desktop', 'vscode', 'windsurf']) {
    assert.ok(helpText.includes(h), `install help must list harness '${h}'`);
  }
});

// --------------------------------------------------------------------------
// Group D - landing-page cross-link integrity (each page links to the other 4).
// --------------------------------------------------------------------------

for (const harness of HARNESSES) {
  test(`W262 cross-links - ${harness} page links to the other 4 install pages`, () => {
    const html = fs.readFileSync(path.join(INSTALL_DIR, `${harness}.html`), 'utf8');
    for (const other of HARNESSES) {
      if (other === harness) continue;
      assert.ok(html.includes(`/install/${other}`),
        `${harness}.html must cross-link to /install/${other}`);
    }
  });
}
