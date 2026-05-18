// W382 dev-agent-install: route Codex CLI / Claude Code / Cursor / Windsurf /
// Aider / Gemini CLI through the local kolm proxy at 127.0.0.1:8787.
//
// Public API:
//   AGENTS                            - array of agent descriptors
//   detectInstalled()                 - ids of agents whose config_path exists
//                                       or whose binary is on PATH
//   installAgent(id, opts)            - {status, changed_files[], backup_path}
//   uninstallAgent(id, opts)          - {status, restored_from_backup}
//   installAll(opts)                  - per-agent install results
//   classifyAppId(userAgent)          - 'codex'|'claude-code'|...|'unknown'
//   INSTALL_BASE_URL_DEFAULT          - 'http://127.0.0.1:8787'
//   DevAgentError                     - typed error class
//
// All filesystem writes preserve the user's existing config and stash a
// .kolm-backup-<ts> sibling that uninstallAgent() restores from. We never
// overwrite a pre-existing backup so a double install is non-destructive.
//
// For Cursor / Windsurf the picture is uglier: Cursor's settings.json does
// not currently expose a first-class "openai_base_url" knob (the OpenAI
// provider key is fixed by the IDE and routed through Cursor's own
// gateway). When we cannot detect a settings shape we recognize, install
// returns status:'manual_step_required' and the caller is expected to fall
// back to shellInit() so the user sets OPENAI_BASE_URL globally.
//
// Cross-platform notes:
//   - HOME / USERPROFILE / KOLM_DATA_DIR are honored.
//   - PATH detection uses where.exe on win32, command -v on POSIX.
//   - Cursor settings location:
//       darwin : ~/Library/Application Support/Cursor/User/settings.json
//       linux  : ~/.config/Cursor/User/settings.json
//       win32  : %APPDATA%/Cursor/User/settings.json
//   - Windsurf mirrors Cursor with `Windsurf` replacing `Cursor`.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

export const INSTALL_BASE_URL_DEFAULT = 'http://127.0.0.1:8787';

export class DevAgentError extends Error {
  constructor(message, code = 'DEV_AGENT_ERROR') {
    super(message);
    this.name = 'DevAgentError';
    this.code = code;
  }
}

// ---------------------------------------------------------------------------
// path helpers
// ---------------------------------------------------------------------------

function _home() {
  return process.env.HOME || process.env.USERPROFILE || os.homedir();
}

function _expandHome(p) {
  if (!p) return p;
  if (p === '~') return _home();
  if (p.startsWith('~/') || p.startsWith('~\\')) return path.join(_home(), p.slice(2));
  return p;
}

function _appData() {
  return process.env.APPDATA || path.join(_home(), 'AppData', 'Roaming');
}

function _platform() {
  return os.platform();
}

function _onPath(cmd) {
  try {
    const which = _platform() === 'win32' ? 'where' : 'command';
    const args = _platform() === 'win32' ? [cmd] : ['-v', cmd];
    const res = spawnSync(which, args, { encoding: 'utf8', timeout: 4000 });
    return res.status === 0 && (res.stdout || '').trim().length > 0;
  } catch {
    return false;
  }
}

function _exists(p) {
  try { fs.accessSync(p); return true; } catch { return false; }
}

function _readSafe(p) {
  try { return fs.readFileSync(p, 'utf8'); } catch { return null; }
}

function _writeAtomic(p, body) {
  fs.mkdirSync(path.dirname(p), { recursive: true });
  const tmp = p + '.kolm-tmp-' + Date.now();
  fs.writeFileSync(tmp, body);
  fs.renameSync(tmp, p);
}

function _ts() {
  return new Date().toISOString().replace(/[:.]/g, '-');
}

function _backupOnce(cfgPath) {
  // Return existing backup if we already have one (so a double install does
  // not stomp the original config we want uninstall to restore).
  const dir = path.dirname(cfgPath);
  const base = path.basename(cfgPath);
  let existing = null;
  try {
    for (const f of fs.readdirSync(dir)) {
      if (f.startsWith(base + '.kolm-backup-')) { existing = path.join(dir, f); break; }
    }
  } catch {}
  if (existing) return existing;
  const fresh = cfgPath + '.kolm-backup-' + _ts();
  fs.copyFileSync(cfgPath, fresh);
  return fresh;
}

function _latestBackup(cfgPath) {
  const dir = path.dirname(cfgPath);
  const base = path.basename(cfgPath);
  let latest = null;
  try {
    for (const f of fs.readdirSync(dir)) {
      if (f.startsWith(base + '.kolm-backup-')) {
        const p = path.join(dir, f);
        if (!latest || fs.statSync(p).mtimeMs > fs.statSync(latest).mtimeMs) latest = p;
      }
    }
  } catch {}
  return latest;
}

// ---------------------------------------------------------------------------
// Per-agent paths
// ---------------------------------------------------------------------------

function _codexConfigPath() { return path.join(_home(), '.codex', 'config.json'); }
function _claudeSettingsPath() { return path.join(_home(), '.claude', 'settings.json'); }
function _aiderConfigPath() { return path.join(_home(), '.aider.conf.yml'); }
function _geminiConfigPath() { return path.join(_home(), '.config', 'gemini-cli', 'settings.json'); }

function _ideUserSettingsPath(productName) {
  const plat = _platform();
  if (plat === 'win32') return path.join(_appData(), productName, 'User', 'settings.json');
  if (plat === 'darwin') return path.join(_home(), 'Library', 'Application Support', productName, 'User', 'settings.json');
  return path.join(_home(), '.config', productName, 'User', 'settings.json');
}

function _cursorConfigPath() { return _ideUserSettingsPath('Cursor'); }
function _windsurfConfigPath() { return _ideUserSettingsPath('Windsurf'); }

// ---------------------------------------------------------------------------
// Generic JSON / YAML patchers
// ---------------------------------------------------------------------------

function _patchJson(cfgPath, patcher) {
  const had = _exists(cfgPath);
  let parsed = {};
  if (had) {
    const raw = _readSafe(cfgPath);
    try { parsed = raw ? JSON.parse(raw) : {}; } catch { parsed = {}; }
  }
  const next = patcher(parsed) || parsed;
  return { had, body: JSON.stringify(next, null, 2) + '\n' };
}

function _patchYamlFlat(cfgPath, keyValues) {
  // Minimal YAML mutation that keeps unrelated lines alone and rewrites
  // top-level `key: value` entries when present. New keys append.
  const had = _exists(cfgPath);
  const raw = had ? (_readSafe(cfgPath) || '') : '';
  const lines = raw.length ? raw.split(/\r?\n/) : [];
  const seen = new Set();
  const out = [];
  for (const line of lines) {
    const m = line.match(/^([A-Za-z0-9_.-]+)\s*:\s*.*$/);
    if (m && Object.prototype.hasOwnProperty.call(keyValues, m[1])) {
      out.push(`${m[1]}: ${keyValues[m[1]]}`);
      seen.add(m[1]);
    } else {
      out.push(line);
    }
  }
  if (out.length && out[out.length - 1] !== '') out.push('');
  for (const [k, v] of Object.entries(keyValues)) {
    if (!seen.has(k)) out.push(`${k}: ${v}`);
  }
  if (out.length && out[out.length - 1] !== '') out.push('');
  return { had, body: out.join('\n') };
}

// ---------------------------------------------------------------------------
// Per-agent install/uninstall
// ---------------------------------------------------------------------------

function _commonInstallJson({ cfgPath, base_url, patcher, dry_run, id }) {
  const changed = [];
  let backup_path = null;
  const { had, body } = _patchJson(cfgPath, patcher);
  if (dry_run) {
    return { status: had ? 'would_patch' : 'would_create', changed_files: [cfgPath], backup_path: null, dry_run: true, body };
  }
  if (had) backup_path = _backupOnce(cfgPath);
  _writeAtomic(cfgPath, body);
  changed.push(cfgPath);
  return { status: 'installed', changed_files: changed, backup_path, agent_id: id, base_url };
}

function _commonUninstallJson({ cfgPath, dry_run }) {
  if (!_exists(cfgPath)) {
    return { status: 'not_installed', restored_from_backup: null };
  }
  const backup = _latestBackup(cfgPath);
  if (!backup) {
    return { status: 'not_installed', restored_from_backup: null };
  }
  if (dry_run) {
    return { status: 'would_restore', restored_from_backup: backup, dry_run: true };
  }
  fs.copyFileSync(backup, cfgPath);
  return { status: 'uninstalled', restored_from_backup: backup };
}

// ---- codex ----------------------------------------------------------------

function _codexDetect() {
  return _exists(_codexConfigPath()) || _onPath('codex');
}
function _codexInstall({ base_url, dry_run } = {}) {
  const cfgPath = _codexConfigPath();
  return _commonInstallJson({
    cfgPath, base_url, dry_run, id: 'codex',
    patcher: (cur) => {
      cur.openai = cur.openai && typeof cur.openai === 'object' ? cur.openai : {};
      cur.openai.base_url = base_url + '/v1';
      cur.base_url = base_url + '/v1';
      cur.kolm_managed = true;
      return cur;
    },
  });
}
function _codexUninstall({ dry_run } = {}) {
  return _commonUninstallJson({ cfgPath: _codexConfigPath(), dry_run });
}

// ---- claude-code ----------------------------------------------------------
// Claude Code reads ANTHROPIC_BASE_URL from the environment and also honours
// `env` overrides in settings.json. We patch the env block so launches from
// the IDE pick up the proxy without the user editing their shell rc.
function _claudeDetect() {
  return _exists(_claudeSettingsPath()) || _onPath('claude');
}
function _claudeInstall({ base_url, dry_run } = {}) {
  const cfgPath = _claudeSettingsPath();
  return _commonInstallJson({
    cfgPath, base_url, dry_run, id: 'claude-code',
    patcher: (cur) => {
      cur.env = cur.env && typeof cur.env === 'object' ? cur.env : {};
      cur.env.ANTHROPIC_BASE_URL = base_url;
      cur.apiBaseUrl = base_url;
      cur.kolm_managed = true;
      return cur;
    },
  });
}
function _claudeUninstall({ dry_run } = {}) {
  return _commonUninstallJson({ cfgPath: _claudeSettingsPath(), dry_run });
}

// ---- cursor ---------------------------------------------------------------
// Cursor's user settings.json accepts arbitrary keys but the OpenAI provider
// gateway is fixed by the IDE. We write a marker + the conventional
// `openai.baseUrl` field; if Cursor ignores it the user is still covered by
// shellInit. If the settings.json does not exist we report
// 'manual_step_required' so callers know to push the env-var fallback.
function _cursorDetect() {
  return _exists(_cursorConfigPath());
}
function _cursorInstall({ base_url, dry_run } = {}) {
  const cfgPath = _cursorConfigPath();
  if (!_exists(cfgPath)) {
    return {
      status: 'manual_step_required',
      changed_files: [],
      backup_path: null,
      reason: 'cursor settings.json not found - use shellInit() to export OPENAI_BASE_URL globally',
    };
  }
  return _commonInstallJson({
    cfgPath, base_url, dry_run, id: 'cursor',
    patcher: (cur) => {
      cur.openai = cur.openai && typeof cur.openai === 'object' ? cur.openai : {};
      cur.openai.baseUrl = base_url + '/v1';
      cur['openai.baseUrl'] = base_url + '/v1';
      cur.kolm_managed = true;
      return cur;
    },
  });
}
function _cursorUninstall({ dry_run } = {}) {
  return _commonUninstallJson({ cfgPath: _cursorConfigPath(), dry_run });
}

// ---- windsurf ------------------------------------------------------------
function _windsurfDetect() {
  return _exists(_windsurfConfigPath());
}
function _windsurfInstall({ base_url, dry_run } = {}) {
  const cfgPath = _windsurfConfigPath();
  if (!_exists(cfgPath)) {
    return {
      status: 'manual_step_required',
      changed_files: [],
      backup_path: null,
      reason: 'windsurf settings.json not found - use shellInit() to export OPENAI_BASE_URL globally',
    };
  }
  return _commonInstallJson({
    cfgPath, base_url, dry_run, id: 'windsurf',
    patcher: (cur) => {
      cur.openai = cur.openai && typeof cur.openai === 'object' ? cur.openai : {};
      cur.openai.baseUrl = base_url + '/v1';
      cur.kolm_managed = true;
      return cur;
    },
  });
}
function _windsurfUninstall({ dry_run } = {}) {
  return _commonUninstallJson({ cfgPath: _windsurfConfigPath(), dry_run });
}

// ---- aider ----------------------------------------------------------------

function _aiderDetect() {
  return _exists(_aiderConfigPath()) || _onPath('aider');
}
function _aiderInstall({ base_url, dry_run } = {}) {
  const cfgPath = _aiderConfigPath();
  const url = base_url + '/v1';
  const { had, body } = _patchYamlFlat(cfgPath, {
    'openai-api-base': url,
    'openai_api_base': url,
    'kolm_managed': 'true',
  });
  if (dry_run) {
    return { status: had ? 'would_patch' : 'would_create', changed_files: [cfgPath], backup_path: null, dry_run: true, body };
  }
  let backup_path = null;
  if (had) backup_path = _backupOnce(cfgPath);
  _writeAtomic(cfgPath, body);
  return { status: 'installed', changed_files: [cfgPath], backup_path, agent_id: 'aider', base_url };
}
function _aiderUninstall({ dry_run } = {}) {
  return _commonUninstallJson({ cfgPath: _aiderConfigPath(), dry_run });
}

// ---- gemini-cli -----------------------------------------------------------

function _geminiDetect() {
  return _exists(_geminiConfigPath()) || _onPath('gemini');
}
function _geminiInstall({ base_url, dry_run } = {}) {
  const cfgPath = _geminiConfigPath();
  return _commonInstallJson({
    cfgPath, base_url, dry_run, id: 'gemini-cli',
    patcher: (cur) => {
      cur.base_url = base_url + '/v1';
      cur.api_base = base_url + '/v1';
      cur.kolm_managed = true;
      return cur;
    },
  });
}
function _geminiUninstall({ dry_run } = {}) {
  return _commonUninstallJson({ cfgPath: _geminiConfigPath(), dry_run });
}

// ---------------------------------------------------------------------------
// Agent registry
// ---------------------------------------------------------------------------

export const AGENTS = [
  {
    id: 'codex',
    name: 'OpenAI Codex CLI',
    config_path: '~/.codex/config.json',
    env_var: 'OPENAI_BASE_URL',
    detector: _codexDetect,
    install: _codexInstall,
    uninstall: _codexUninstall,
    ua_hint: /codex-cli|openai-cli/i,
  },
  {
    id: 'claude-code',
    name: 'Anthropic Claude Code CLI',
    config_path: '~/.claude/settings.json',
    env_var: 'ANTHROPIC_BASE_URL',
    detector: _claudeDetect,
    install: _claudeInstall,
    uninstall: _claudeUninstall,
    ua_hint: /claude-cli|claude-code|anthropic-cli/i,
  },
  {
    id: 'cursor',
    name: 'Cursor IDE',
    get config_path() { return _cursorConfigPath(); },
    env_var: null,
    detector: _cursorDetect,
    install: _cursorInstall,
    uninstall: _cursorUninstall,
    ua_hint: /Cursor\//i,
  },
  {
    id: 'windsurf',
    name: 'Windsurf IDE',
    get config_path() { return _windsurfConfigPath(); },
    env_var: null,
    detector: _windsurfDetect,
    install: _windsurfInstall,
    uninstall: _windsurfUninstall,
    ua_hint: /Windsurf\//i,
  },
  {
    id: 'aider',
    name: 'aider',
    config_path: '~/.aider.conf.yml',
    env_var: 'OPENAI_API_BASE',
    detector: _aiderDetect,
    install: _aiderInstall,
    uninstall: _aiderUninstall,
    ua_hint: /aider\//i,
  },
  {
    id: 'gemini-cli',
    name: 'Google Gemini CLI',
    config_path: '~/.config/gemini-cli/settings.json',
    env_var: 'GEMINI_BASE_URL',
    detector: _geminiDetect,
    install: _geminiInstall,
    uninstall: _geminiUninstall,
    ua_hint: /gemini-cli\//i,
  },
];

function _findAgent(agent_id) {
  const a = AGENTS.find((x) => x.id === agent_id);
  if (!a) throw new DevAgentError(`unknown agent id: ${agent_id}`, 'UNKNOWN_AGENT');
  return a;
}

// ---------------------------------------------------------------------------
// Public surface
// ---------------------------------------------------------------------------

export function detectInstalled() {
  const out = [];
  for (const a of AGENTS) {
    try { if (a.detector()) out.push(a.id); } catch {}
  }
  return out;
}

export function installAgent(agent_id, opts = {}) {
  const a = _findAgent(agent_id);
  if (!a.detector() && !opts.force) {
    return { status: 'not_detected', agent_id, changed_files: [], backup_path: null };
  }
  const base_url = (opts.base_url || INSTALL_BASE_URL_DEFAULT).replace(/\/+$/, '');
  try {
    const res = a.install({ base_url, dry_run: !!opts.dry_run }) || {};
    if (!res.agent_id) res.agent_id = agent_id;
    return res;
  } catch (e) {
    return { status: 'failed', agent_id, changed_files: [], backup_path: null, error: String(e && e.message || e) };
  }
}

export function uninstallAgent(agent_id, opts = {}) {
  const a = _findAgent(agent_id);
  try {
    const res = a.uninstall({ dry_run: !!opts.dry_run }) || {};
    res.agent_id = agent_id;
    return res;
  } catch (e) {
    return { status: 'failed', agent_id, restored_from_backup: null, error: String(e && e.message || e) };
  }
}

export function installAll(opts = {}) {
  const results = [];
  for (const a of AGENTS) {
    results.push(installAgent(a.id, opts));
  }
  return results;
}

export function classifyAppId(userAgent) {
  if (!userAgent || typeof userAgent !== 'string') return 'unknown';
  for (const a of AGENTS) {
    if (a.ua_hint && a.ua_hint.test(userAgent)) return a.id;
  }
  return 'unknown';
}

// Helpful re-exports for tests / introspection.
export const _paths = {
  codex: _codexConfigPath,
  claude: _claudeSettingsPath,
  cursor: _cursorConfigPath,
  windsurf: _windsurfConfigPath,
  aider: _aiderConfigPath,
  gemini: _geminiConfigPath,
};

export default {
  AGENTS,
  detectInstalled,
  installAgent,
  uninstallAgent,
  installAll,
  classifyAppId,
  INSTALL_BASE_URL_DEFAULT,
  DevAgentError,
};
