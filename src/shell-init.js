// W382 shell-init: emit shell-export snippets that point a user's terminal
// at the local kolm proxy (default http://127.0.0.1:8787). Each supported
// provider gets its own env var so any agent CLI the user runs picks up the
// proxy without per-tool patching.
//
// Public API:
//   shellInit({shell?, base_url?, providers?}) -> string snippet
//   detectShell() -> 'pwsh'|'cmd'|'bash'|'zsh'|'sh'|'fish'
//
// Notes:
//   - No external deps. No I/O. Pure string emit.
//   - 'auto' detection uses process.env.SHELL when present, otherwise falls
//     back to os.platform() (win32 -> pwsh, everything else -> bash).
//   - Aider reads OPENAI_API_BASE; OpenAI SDKs read OPENAI_BASE_URL.
//     We emit both so the user does not have to remember which one.

import os from 'node:os';
import path from 'node:path';

import { INSTALL_BASE_URL_DEFAULT } from './dev-agent-install.js';

const SUPPORTED_SHELLS = new Set(['sh', 'bash', 'zsh', 'fish', 'pwsh', 'cmd', 'auto']);

const DEFAULT_PROVIDERS = ['openai', 'anthropic', 'openrouter', 'gemini'];

// Each provider declares the env vars it expects + whether the proxy URL
// needs a /v1 suffix for that provider's SDK to treat it as the v1 API root.
const PROVIDER_VARS = {
  openai: [
    { name: 'OPENAI_BASE_URL', suffix: '/v1' },
    { name: 'OPENAI_API_BASE', suffix: '/v1' }, // aider compat
  ],
  anthropic: [
    { name: 'ANTHROPIC_BASE_URL', suffix: '' },
  ],
  openrouter: [
    { name: 'OPENROUTER_BASE_URL', suffix: '/v1' },
  ],
  gemini: [
    { name: 'GEMINI_BASE_URL', suffix: '' },
    { name: 'GOOGLE_AI_STUDIO_API_BASE', suffix: '' },
  ],
};

export function detectShell() {
  const plat = os.platform();
  const sh = process.env.SHELL || process.env.ComSpec || '';
  const lower = sh.toLowerCase();
  if (lower.includes('pwsh') || lower.includes('powershell')) return 'pwsh';
  if (lower.includes('cmd.exe')) return 'cmd';
  if (lower.includes('fish')) return 'fish';
  if (lower.includes('zsh')) return 'zsh';
  if (lower.includes('bash')) return 'bash';
  if (lower.includes('/sh') || lower.endsWith('sh')) return 'sh';
  if (plat === 'win32') return 'pwsh';
  return 'bash';
}

function _resolveShell(shell) {
  if (!shell || shell === 'auto') return detectShell();
  if (!SUPPORTED_SHELLS.has(shell)) {
    throw new Error(`unsupported shell: ${shell} (supported: ${[...SUPPORTED_SHELLS].join(', ')})`);
  }
  return shell;
}

function _resolveProviders(providers) {
  if (!providers || !providers.length) return DEFAULT_PROVIDERS;
  const out = [];
  for (const p of providers) {
    if (PROVIDER_VARS[p]) out.push(p);
  }
  return out.length ? out : DEFAULT_PROVIDERS;
}

function _vars(base, providers) {
  const cleaned = base.replace(/\/+$/, '');
  const rows = [];
  for (const p of providers) {
    for (const v of PROVIDER_VARS[p]) {
      rows.push({ name: v.name, value: cleaned + v.suffix, provider: p });
    }
  }
  return rows;
}

function _emitBash(rows, header) {
  const lines = [header];
  for (const r of rows) lines.push(`export ${r.name}=${r.value}`);
  return lines.join('\n') + '\n';
}
function _emitFish(rows, header) {
  const lines = [header];
  for (const r of rows) lines.push(`set -gx ${r.name} ${r.value}`);
  return lines.join('\n') + '\n';
}
function _emitPwsh(rows, header) {
  const lines = [header];
  for (const r of rows) lines.push(`$env:${r.name} = '${r.value}'`);
  return lines.join('\n') + '\n';
}
function _emitCmd(rows, header) {
  const lines = [header];
  for (const r of rows) lines.push(`set ${r.name}=${r.value}`);
  return lines.join('\n') + '\n';
}

export function shellInit(opts = {}) {
  const shell = _resolveShell(opts.shell);
  const base_url = (opts.base_url || INSTALL_BASE_URL_DEFAULT).replace(/\/+$/, '');
  const providers = _resolveProviders(opts.providers);
  const rows = _vars(base_url, providers);

  const note = `kolm dev-agent proxy at ${base_url}`;
  switch (shell) {
    case 'fish':
      return _emitFish(rows, `# ${note}`);
    case 'pwsh':
      return _emitPwsh(rows, `# ${note}`);
    case 'cmd':
      return _emitCmd(rows, `:: ${note}`);
    case 'sh':
    case 'bash':
    case 'zsh':
    default:
      return _emitBash(rows, `# ${note}`);
  }
}

export default { shellInit, detectShell };
