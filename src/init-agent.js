// W238 — script-first boilerplate: `kolm init-agent --git --tmux --template`.
//
// Scaffolds a complete kolm agent project directory the user can `cd` into
// and run `./run.sh`. No magic — just files. Every file is plain text the
// user can hand-edit. The point is: zero "config wizards", no globals, just
// a working starting point that survives `git init` and `tmux attach`.
//
// Directories scaffolded:
//   <project-dir>/
//     spec.json            kolm compile spec
//     seeds.jsonl          empty seed file (with one stub example)
//     run.sh / run.ps1     compile + serve script (executable on POSIX)
//     watch.sh / watch.ps1 capture + auto-distill watcher
//     tmux.conf            optional tmux session layout (if --tmux)
//     blueprint.json       self-growing agent blueprint (W236)
//     .gitignore           sensible defaults for kolm projects
//     README.md            one-paragraph "what is this" + how-to-run
//
// Templates ship as functions of (projectName, opts). Templates are NOT
// instantiated until the caller asks — keeps this module pure and testable.

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { buildSelfGrowingBlueprint } from './agent-blueprint.js';

export const INIT_SCHEMA_VERSION = '1.0.0';

export const TEMPLATES = Object.freeze({
  chatbot:    { description: 'General-purpose chatbot. Base = Qwen 2.5 3B Instruct, chatml.', recipe_class: 'distilled_model', chat_template: 'chatml',          base_model: 'Qwen/Qwen2.5-3B-Instruct' },
  redactor:   { description: 'PHI/PII redactor. Rule-class, no model bytes.',                  recipe_class: 'rule',             chat_template: 'plain',           base_model: null },
  classifier: { description: 'Text classifier. Distilled student over a label set.',           recipe_class: 'distilled_model', chat_template: 'chatml',          base_model: 'Qwen/Qwen2.5-0.5B-Instruct' },
  extraction: { description: 'Structured extraction (JSON output). Distilled small model.',    recipe_class: 'distilled_model', chat_template: 'chatml',          base_model: 'Qwen/Qwen2.5-3B-Instruct' },
  agent:      { description: 'Hermes-tool-use agent with self-growing blueprint.',             recipe_class: 'distilled_model', chat_template: 'qwen-3-thinking', base_model: 'NousResearch/Hermes-4.3-36B' },
});

export const TEMPLATE_NAMES = Object.freeze(Object.keys(TEMPLATES));

function fileTree(projectName, opts) {
  const tpl = TEMPLATES[opts.template] || TEMPLATES.chatbot;
  const spec = {
    schema_version: INIT_SCHEMA_VERSION,
    name: projectName,
    task: opts.task || `${tpl.description}`,
    recipe_class: tpl.recipe_class,
    chat_template: tpl.chat_template,
    base_model: tpl.base_model,
    k_threshold: opts.k_threshold || 0.80,
    created_at: new Date().toISOString(),
  };
  const seedExample = (() => {
    if (opts.template === 'redactor') return { input: 'Patient John Doe (DOB 01/02/1980) was seen.', output: 'Patient [NAME] (DOB [DATE]) was seen.' };
    if (opts.template === 'classifier') return { input: 'My laptop won\'t turn on.', output: 'hardware' };
    if (opts.template === 'extraction') return { input: 'Order #1234, qty 3, ship 2026-05-20.', output: { order_id: 1234, qty: 3, ship_date: '2026-05-20' } };
    if (opts.template === 'agent') return { input: 'Find the 5 most-recent invoices.', output: 'I will call list_invoices with limit=5.' };
    return { input: 'Hello!', output: 'Hi! How can I help?' };
  })();
  const runSh = [
    '#!/usr/bin/env bash',
    `# ${projectName} — kolm compile + serve.`,
    'set -euo pipefail',
    'cd "$(dirname "$0")"',
    'kolm compile spec.json --seeds seeds.jsonl --out artifact.kolm',
    'kolm serve artifact.kolm --port 7480',
  ].join('\n') + '\n';
  const runPs = [
    `# ${projectName} - kolm compile + serve (PowerShell).`,
    '$ErrorActionPreference = "Stop"',
    'Set-Location $PSScriptRoot',
    'kolm compile spec.json --seeds seeds.jsonl --out artifact.kolm',
    'kolm serve artifact.kolm --port 7480',
  ].join('\n') + '\n';
  const watchSh = [
    '#!/usr/bin/env bash',
    `# ${projectName} - capture + auto-distill watcher.`,
    'set -euo pipefail',
    'cd "$(dirname "$0")"',
    `kolm tail captures --namespace ${projectName} | tee captures.log`,
  ].join('\n') + '\n';
  const watchPs = [
    `# ${projectName} - capture + auto-distill watcher (PowerShell).`,
    '$ErrorActionPreference = "Stop"',
    'Set-Location $PSScriptRoot',
    `kolm tail captures --namespace ${projectName} | Tee-Object captures.log`,
  ].join('\n') + '\n';
  const tmuxConf = [
    `# ${projectName} - tmux session: 3 panes (compile/serve | watch captures | shell).`,
    `new-session -d -s ${projectName} './run.sh; bash'`,
    `split-window -h -t ${projectName} './watch.sh; bash'`,
    `split-window -v -t ${projectName}:0.1 'bash'`,
    `select-pane -t ${projectName}:0.0`,
    `attach-session -t ${projectName}`,
  ].join('\n') + '\n';
  const gitignore = [
    '# kolm project',
    'artifact.kolm',
    'artifact.kolm.manifest.json',
    '*.log',
    'captures.log',
    'node_modules/',
    '.kolm-state/',
    '.env',
    '.env.*',
    '*.pem',
    '*.key',
    '',
  ].join('\n');
  const readme = [
    `# ${projectName}`,
    '',
    tpl.description,
    '',
    '## Run',
    '',
    'POSIX:',
    '```bash',
    './run.sh        # compile + serve on :7480',
    './watch.sh      # watch captures + auto-distill at 1000 pairs',
    '```',
    '',
    'Windows / PowerShell:',
    '```powershell',
    '.\\run.ps1',
    '.\\watch.ps1',
    '```',
    '',
    opts.tmux ? '## Multi-pane workflow\n\n```bash\ntmux source-file tmux.conf\n```\n' : '',
    '## Files',
    '',
    '- `spec.json` - kolm compile spec.',
    '- `seeds.jsonl` - one example per line. Add your real examples here.',
    '- `blueprint.json` - self-growing agent blueprint (W236).',
    '- `run.sh` / `run.ps1` - compile + serve.',
    '- `watch.sh` / `watch.ps1` - capture tail + auto-distill.',
    '',
    '## What kolm does',
    '',
    'Compiles your spec + seeds into a signed `.kolm` artifact and serves it',
    'on `:7480`. Captures every prompt + response into a namespace. At 1000',
    'captured pairs, the watcher auto-distills a fresh artifact and hot-swaps.',
    '',
    `Generated by kolm init-agent (W238) at ${new Date().toISOString()}.`,
    '',
  ].filter(Boolean).join('\n');
  const blueprint = buildSelfGrowingBlueprint({
    id: `agent_${projectName}`,
    name: projectName,
    description: tpl.description,
    base_model: tpl.base_model || 'Qwen/Qwen2.5-3B-Instruct',
    capture_namespace: projectName,
    chat_template: tpl.chat_template,
  });
  const files = [
    { path: 'spec.json',      content: JSON.stringify(spec, null, 2) + '\n', mode: 0o644 },
    { path: 'seeds.jsonl',    content: JSON.stringify(seedExample) + '\n',   mode: 0o644 },
    { path: 'blueprint.json', content: JSON.stringify(blueprint, null, 2) + '\n', mode: 0o644 },
    { path: 'run.sh',         content: runSh,   mode: 0o755 },
    { path: 'run.ps1',        content: runPs,   mode: 0o644 },
    { path: 'watch.sh',       content: watchSh, mode: 0o755 },
    { path: 'watch.ps1',      content: watchPs, mode: 0o644 },
    { path: '.gitignore',     content: gitignore, mode: 0o644 },
    { path: 'README.md',      content: readme,  mode: 0o644 },
  ];
  if (opts.tmux) files.push({ path: 'tmux.conf', content: tmuxConf, mode: 0o644 });
  return files;
}

// Plan-only: returns the files that would be written without touching disk.
// Used by the CLI in --dry-run mode and by the test suite.
export function plan(projectName, opts = {}) {
  if (!projectName || typeof projectName !== 'string') throw new Error('plan: projectName required');
  if (!/^[a-zA-Z0-9._-]+$/.test(projectName)) throw new Error(`plan: projectName must be [a-zA-Z0-9._-]+; got ${projectName}`);
  const template = opts.template || 'chatbot';
  if (!TEMPLATE_NAMES.includes(template)) {
    throw new Error(`plan: unknown template '${template}'. try: ${TEMPLATE_NAMES.join(', ')}`);
  }
  const files = fileTree(projectName, { ...opts, template });
  const total_bytes = files.reduce((n, f) => n + Buffer.byteLength(f.content), 0);
  return {
    schema_version: INIT_SCHEMA_VERSION,
    project_name: projectName,
    template,
    file_count: files.length,
    total_bytes,
    files: files.map(f => ({ path: f.path, bytes: Buffer.byteLength(f.content) })),
  };
}

// Execute: write the files to disk. Idempotent on existing dir IF --force is
// passed; otherwise throws so the user does not clobber an existing project.
export function execute(projectName, targetDir, opts = {}) {
  if (!targetDir) throw new Error('execute: targetDir required');
  const absDir = path.resolve(targetDir);
  if (fs.existsSync(absDir)) {
    const existing = fs.readdirSync(absDir).filter(f => f !== '.git' && !f.startsWith('.'));
    if (existing.length > 0 && !opts.force) {
      throw new Error(`execute: ${absDir} is not empty (use --force to overwrite)`);
    }
  } else {
    fs.mkdirSync(absDir, { recursive: true });
  }
  const files = fileTree(projectName, opts);
  const written = [];
  for (const f of files) {
    const dst = path.join(absDir, f.path);
    fs.writeFileSync(dst, f.content);
    try { fs.chmodSync(dst, f.mode); } catch (_) {}
    written.push({ path: f.path, bytes: Buffer.byteLength(f.content) });
  }
  let git_initialized = false;
  if (opts.git) {
    git_initialized = tryGitInit(absDir);
  }
  return {
    schema_version: INIT_SCHEMA_VERSION,
    project_name: projectName,
    target_dir: absDir,
    template: opts.template || 'chatbot',
    files_written: written,
    git_initialized,
    tmux_conf_written: Boolean(opts.tmux),
  };
}

function tryGitInit(absDir) {
  try {
    const r = spawnSync('git', ['init', '-q'], { cwd: absDir, encoding: 'utf8' });
    if (r.status === 0) {
      const stage = spawnSync('git', ['add', '.'], { cwd: absDir, encoding: 'utf8' });
      const commit = spawnSync('git', ['commit', '-q', '-m', 'init: kolm init-agent scaffold (W238)'], { cwd: absDir, encoding: 'utf8' });
      return stage.status === 0 && commit.status === 0;
    }
    return false;
  } catch (_) { return false; }
}

export default {
  INIT_SCHEMA_VERSION,
  TEMPLATES,
  TEMPLATE_NAMES,
  plan,
  execute,
};
