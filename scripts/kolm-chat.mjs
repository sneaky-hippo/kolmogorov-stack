#!/usr/bin/env node
// scripts/kolm-chat.mjs
//
// Wave Z — launcher for the kolm chat TUI. Wires stdin/stdout to the
// runTuiChat orchestrator in src/tui-chat.js.
//
// Usage:
//   node scripts/kolm-chat.mjs
//     [--model=kolm:echo]              initial model
//     [--registry=<dir>]               (repeatable) extra registry dir
//     [--open=<path.kolm>]             (repeatable) preload artifact
//     [--system="<prompt>"]            initial system prompt
//
// Env:
//   ANTHROPIC_API_KEY                  enables anthropic: / claude-* bridge
//   OPENAI_API_KEY                     enables openai:    / gpt-*    bridge

import path from 'node:path';
import process from 'node:process';
import { runTuiChat } from '../src/tui-chat.js';

const args = parseArgs(process.argv.slice(2));
const registryDirs = args.registry
  ? (Array.isArray(args.registry) ? args.registry : [args.registry])
  : null;
const openArtifacts = args.open
  ? (Array.isArray(args.open) ? args.open : [args.open])
  : [];

await runTuiChat({
  input: process.stdin,
  output: process.stdout,
  opts: {
    model: args.model || undefined,
    systemPrompt: args.system || '',
    registryDirs,
    openArtifacts,
  },
});

process.exit(0);

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith('--')) continue;
    const eq = a.indexOf('=');
    if (eq > 0) {
      const k = a.slice(2, eq);
      const v = a.slice(eq + 1);
      pushArg(out, k, v);
    } else {
      const k = a.slice(2);
      const next = argv[i + 1];
      if (next !== undefined && !next.startsWith('--')) {
        pushArg(out, k, next);
        i++;
      } else {
        out[k] = true;
      }
    }
  }
  return out;
}
function pushArg(out, k, v) {
  if (out[k] === undefined) out[k] = v;
  else if (Array.isArray(out[k])) out[k].push(v);
  else out[k] = [out[k], v];
}
