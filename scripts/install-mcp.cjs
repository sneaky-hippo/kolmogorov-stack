#!/usr/bin/env node
// W262 - one-click MCP installer.
//
//   node scripts/install-mcp.cjs <harness> [--force] [--dry-run] [--config <path>]
//
// Detects the OS, resolves the harness config path, reads any existing JSON,
// merges in `mcpServers.kolm = { command: "kolm", args: ["serve", "--mcp"], env: {} }`,
// and writes atomically (tmp + rename). Idempotent: re-running on a config that
// already contains an identical kolm block is a no-op. If the existing kolm
// block differs, the installer prints a diff and exits 1 unless --force is
// passed. Other mcpServers entries are always preserved.
//
// Supported harnesses (-h prints all):
//   cursor          ~/.cursor/mcp.json
//   continue        ~/.continue/config.json
//   claude-desktop  ~/Library/Application Support/Claude/claude_desktop_config.json (mac)
//                   %APPDATA%\Claude\claude_desktop_config.json                       (win)
//                   ~/.config/Claude/claude_desktop_config.json                       (linux)
//   vscode          ~/.vscode/mcp.json
//   windsurf        ~/.windsurf/mcp.json
//
// Best-effort: on an unknown platform / harness we print the JSON block + the
// best-guess path so the user can paste manually. We never crash.
//
// No new npm deps; pure node:fs / node:os / node:path / node:crypto.

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const HOME = os.homedir();
const PLATFORM = process.platform; // 'darwin' | 'win32' | 'linux' | other

// Canonical kolm MCP block — keep in sync with public/install/*.html.
const KOLM_BLOCK = {
  command: 'kolm',
  args: ['serve', '--mcp'],
  env: {},
};

// Per-harness config resolver. Each entry returns the absolute path on the
// current platform, or null if the platform is unknown (best-effort fallback).
const HARNESSES = {
  'cursor': {
    label: 'Cursor',
    resolve: () => path.join(HOME, '.cursor', 'mcp.json'),
    paths: {
      darwin: '~/.cursor/mcp.json',
      win32:  '%USERPROFILE%\\.cursor\\mcp.json',
      linux:  '~/.cursor/mcp.json',
    },
  },
  'continue': {
    label: 'Continue.dev',
    resolve: () => path.join(HOME, '.continue', 'config.json'),
    paths: {
      darwin: '~/.continue/config.json',
      win32:  '%USERPROFILE%\\.continue\\config.json',
      linux:  '~/.continue/config.json',
    },
  },
  'claude-desktop': {
    label: 'Claude Desktop',
    resolve: () => {
      if (PLATFORM === 'darwin') {
        return path.join(HOME, 'Library', 'Application Support', 'Claude', 'claude_desktop_config.json');
      }
      if (PLATFORM === 'win32') {
        const appdata = process.env.APPDATA || path.join(HOME, 'AppData', 'Roaming');
        return path.join(appdata, 'Claude', 'claude_desktop_config.json');
      }
      // Linux + everything else.
      return path.join(HOME, '.config', 'Claude', 'claude_desktop_config.json');
    },
    paths: {
      darwin: '~/Library/Application Support/Claude/claude_desktop_config.json',
      win32:  '%APPDATA%\\Claude\\claude_desktop_config.json',
      linux:  '~/.config/Claude/claude_desktop_config.json',
    },
  },
  'vscode': {
    label: 'VS Code',
    resolve: () => path.join(HOME, '.vscode', 'mcp.json'),
    paths: {
      darwin: '~/.vscode/mcp.json',
      win32:  '%USERPROFILE%\\.vscode\\mcp.json',
      linux:  '~/.vscode/mcp.json',
    },
  },
  'windsurf': {
    label: 'Windsurf',
    resolve: () => path.join(HOME, '.windsurf', 'mcp.json'),
    paths: {
      darwin: '~/.windsurf/mcp.json',
      win32:  '%USERPROFILE%\\.windsurf\\mcp.json',
      linux:  '~/.windsurf/mcp.json',
    },
  },
};

function printUsage(stream) {
  const out = stream || process.stderr;
  out.write('usage: node scripts/install-mcp.cjs <harness> [--force] [--dry-run] [--config <path>]\n');
  out.write('\n');
  out.write('harnesses:\n');
  for (const [k, v] of Object.entries(HARNESSES)) {
    out.write('  ' + k.padEnd(16) + v.label + '  ' + (v.paths[PLATFORM] || v.paths.linux) + '\n');
  }
  out.write('\n');
  out.write('flags:\n');
  out.write('  --force            overwrite an existing mcpServers.kolm block (default: refuse on conflict)\n');
  out.write('  --dry-run          print what would be written, do not touch disk\n');
  out.write('  --config <path>    override the auto-detected config path (useful for tests)\n');
}

function printManualFallback(harnessKey) {
  const cfg = HARNESSES[harnessKey];
  const guess = cfg ? cfg.resolve() : '(unknown - see your IDE docs)';
  process.stderr.write('could not auto-detect a writable config path. paste this block manually:\n\n');
  process.stderr.write('path: ' + guess + '\n\n');
  process.stderr.write(JSON.stringify({ mcpServers: { kolm: KOLM_BLOCK } }, null, 2) + '\n');
}

// Atomic write: write to tmp in same dir, then rename. Falls back to direct
// write if rename fails (e.g. cross-device tmp on some Linux configurations).
function atomicWriteJson(filePath, obj) {
  const dir = path.dirname(filePath);
  fs.mkdirSync(dir, { recursive: true });
  const tmp = filePath + '.tmp-' + process.pid + '-' + Date.now();
  const body = JSON.stringify(obj, null, 2) + '\n';
  fs.writeFileSync(tmp, body, 'utf8');
  try {
    fs.renameSync(tmp, filePath);
  } catch (e) {
    // Fallback for the rare cross-device case.
    try { fs.unlinkSync(tmp); } catch (_) {}
    fs.writeFileSync(filePath, body, 'utf8');
  }
  return body;
}

function readJsonSafe(filePath) {
  if (!fs.existsSync(filePath)) return {};
  try {
    const txt = fs.readFileSync(filePath, 'utf8');
    if (!txt.trim()) return {};
    const parsed = JSON.parse(txt);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed;
    return {};
  } catch (e) {
    process.stderr.write('warning: existing config at ' + filePath + ' is not valid JSON. refusing to overwrite without --force.\n');
    return null; // signal "unparseable" so install() can decide
  }
}

// Deep equality for the KOLM block (simple — no functions, no Dates).
function jsonEqual(a, b) {
  return JSON.stringify(a) === JSON.stringify(b);
}

// Diff helper. Returns a short text describing the difference between the
// existing kolm block and the canonical KOLM_BLOCK.
function describeDiff(existing) {
  const lines = [];
  lines.push('existing block:');
  lines.push(JSON.stringify(existing, null, 2).split('\n').map((l) => '  ' + l).join('\n'));
  lines.push('canonical block:');
  lines.push(JSON.stringify(KOLM_BLOCK, null, 2).split('\n').map((l) => '  ' + l).join('\n'));
  return lines.join('\n');
}

// Main entry point. Returns { status, configPath, written, conflict } where:
//   status      = 'wrote' | 'unchanged' | 'conflict' | 'dry-run' | 'manual'
//   configPath  = absolute path of the (intended) config file
//   written     = the final JSON body that was written (or would be), if any
//   conflict    = true iff an existing different kolm block blocked the write
function install(harnessKey, opts) {
  opts = opts || {};
  const force = !!opts.force;
  const dryRun = !!opts.dryRun;
  const cfg = HARNESSES[harnessKey];
  if (!cfg) {
    return { status: 'unknown-harness', configPath: null, written: null, conflict: false };
  }
  const configPath = opts.configPath || cfg.resolve();
  let existing = readJsonSafe(configPath);
  if (existing === null && !force) {
    return { status: 'conflict', configPath, written: null, conflict: true, reason: 'unparseable' };
  }
  if (existing === null) existing = {}; // --force on unparseable -> start fresh
  const next = Object.assign({}, existing);
  next.mcpServers = Object.assign({}, existing.mcpServers || {});
  const existingKolm = next.mcpServers.kolm;
  if (existingKolm && !force && !jsonEqual(existingKolm, KOLM_BLOCK)) {
    return {
      status: 'conflict',
      configPath,
      written: null,
      conflict: true,
      reason: 'kolm-block-differs',
      diff: describeDiff(existingKolm),
    };
  }
  // If the existing block is already identical, no write is needed (idempotent).
  if (existingKolm && jsonEqual(existingKolm, KOLM_BLOCK)) {
    return { status: 'unchanged', configPath, written: null, conflict: false };
  }
  next.mcpServers.kolm = KOLM_BLOCK;
  if (dryRun) {
    return { status: 'dry-run', configPath, written: JSON.stringify(next, null, 2) + '\n', conflict: false };
  }
  const written = atomicWriteJson(configPath, next);
  return { status: 'wrote', configPath, written, conflict: false };
}

function cli(argv) {
  const args = argv.slice(2);
  if (args.length === 0 || args.includes('-h') || args.includes('--help')) {
    printUsage(args.length === 0 ? process.stderr : process.stdout);
    return args.length === 0 ? 1 : 0;
  }
  const harness = args.find((a) => !a.startsWith('--'));
  if (!harness || !HARNESSES[harness]) {
    process.stderr.write('error: unknown harness: ' + (harness || '(none)') + '\n\n');
    printUsage();
    return 1;
  }
  const force = args.includes('--force');
  const dryRun = args.includes('--dry-run');
  let configPath = null;
  const cIdx = args.indexOf('--config');
  if (cIdx !== -1 && args[cIdx + 1]) configPath = args[cIdx + 1];

  let result;
  try {
    result = install(harness, { force, dryRun, configPath });
  } catch (e) {
    process.stderr.write('error: ' + (e && e.message ? e.message : String(e)) + '\n');
    printManualFallback(harness);
    return 1;
  }

  if (result.status === 'unknown-harness') {
    process.stderr.write('error: unknown harness: ' + harness + '\n');
    printUsage();
    return 1;
  }
  if (result.status === 'conflict') {
    process.stderr.write('refusing to overwrite: ' + result.configPath + '\n');
    process.stderr.write('reason: ' + result.reason + '\n');
    if (result.diff) {
      process.stderr.write('\n' + result.diff + '\n\n');
    }
    process.stderr.write('rerun with --force to replace the existing kolm block.\n');
    return 1;
  }
  if (result.status === 'unchanged') {
    process.stdout.write('ok (unchanged): ' + result.configPath + '\n');
    process.stdout.write('kolm MCP server is already wired up.\n');
    return 0;
  }
  if (result.status === 'dry-run') {
    process.stdout.write('dry-run: would write ' + result.configPath + '\n\n');
    process.stdout.write(result.written);
    return 0;
  }
  // status === 'wrote'
  process.stdout.write('wrote: ' + result.configPath + '\n');
  process.stdout.write('\n');
  process.stdout.write('next:\n');
  if (harness === 'cursor') {
    process.stdout.write('  reload Cursor MCP: Cmd+Shift+P -> "MCP: Reload"\n');
  } else if (harness === 'continue') {
    process.stdout.write('  restart the Continue extension to pick up the new tool\n');
  } else if (harness === 'claude-desktop') {
    process.stdout.write('  quit and relaunch Claude Desktop. Look for the kolm tools in the tools menu.\n');
  } else if (harness === 'vscode') {
    process.stdout.write('  reload the VS Code window (Cmd+Shift+P -> "Developer: Reload Window")\n');
  } else if (harness === 'windsurf') {
    process.stdout.write('  restart Windsurf so the new MCP server is discovered\n');
  }
  return 0;
}

module.exports = {
  install,
  HARNESSES,
  KOLM_BLOCK,
  atomicWriteJson,
  readJsonSafe,
  jsonEqual,
  describeDiff,
  cli,
};

if (require.main === module) {
  process.exit(cli(process.argv));
}
