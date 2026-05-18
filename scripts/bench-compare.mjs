#!/usr/bin/env node
// scripts/bench-compare.mjs
//
// Wave W — Run head-to-head comparison: compiled kolm artifact vs. LLM API
// vs. local LLM. Prints a human report + optionally writes JSON.
//
// Usage:
//   node scripts/bench-compare.mjs <artifact.kolm> [--runs N] [--json out.json]
//   node scripts/bench-compare.mjs zh-greeter.kolm --runs 10
//
// Env:
//   ANTHROPIC_API_KEY            enables llm-api path (skipped if unset)
//   KOLM_BENCH_LLM_MODEL         override (default: claude-haiku-4-5)
//   KOLM_BENCH_LLM_INPUT_RATE    USD per 1M input tokens (override estimate)
//   KOLM_BENCH_LLM_OUTPUT_RATE   USD per 1M output tokens
//   KOLM_BENCH_LOCAL_LLM_URL     ollama endpoint (default: http://127.0.0.1:11434)
//   KOLM_BENCH_LOCAL_LLM_MODEL   ollama model tag (default: llama3.2:1b)

import fs from 'node:fs';
import path from 'node:path';
import { compareArtifact } from '../src/benchmark-compare.js';

const args = process.argv.slice(2);
if (args.length === 0 || args[0] === '--help') {
  console.error('usage: node scripts/bench-compare.mjs <artifact.kolm> [--runs N] [--json out.json]');
  process.exit(1);
}

const artifactPath = path.resolve(args[0]);
if (!fs.existsSync(artifactPath)) {
  console.error(`artifact not found: ${artifactPath}`);
  process.exit(1);
}

const runs = parseFlag('--runs', 5, Number);
const outJson = parseFlag('--json', null, String);

const report = await compareArtifact(artifactPath, { runs, outPath: outJson });

printReport(report);

function parseFlag(name, fallback, coerce) {
  const i = args.indexOf(name);
  if (i < 0) return fallback;
  const v = args[i + 1];
  if (v === undefined) return fallback;
  return coerce(v);
}

function printReport(r) {
  const w = process.stdout.columns || 80;
  hr(w);
  console.log(`kolm benchmark — head-to-head comparison`);
  hr(w);
  console.log(`artifact: ${shortPath(r.artifact)}`);
  console.log(`task    : ${truncate(r.task, w - 12)}`);
  console.log(`cases   : ${r.cases} × ${r.runs_per_case} runs = ${r.cases * r.runs_per_case} calls per path`);
  console.log(`host    : ${r.host.platform}-${r.host.arch}, node ${r.host.node}`);
  console.log('');

  // Per-path detail.
  for (const name of ['kolm-js', 'kolm-native', 'llm-api', 'local-llm']) {
    const p = r.paths[name];
    console.log(label(name, w));
    if (p.skipped) { console.log(`  SKIPPED: ${p.reason}`); console.log(''); continue; }
    if (p.latency_us) {
      const l = p.latency_us;
      console.log(`  latency  n=${l.n}  min=${us(l.min)}  p50=${us(l.p50)}  p95=${us(l.p95)}  p99=${us(l.p99)}  max=${us(l.max)}`);
    }
    if (p.correctness) {
      const c = p.correctness;
      const acc = c.accuracy != null ? (c.accuracy * 100).toFixed(1) + '%' : '—';
      console.log(`  accuracy ${c.passed}/${c.graded}  (${acc})  [${c.comparator || 'exact-match'}]`);
    }
    if (p.tokens && (p.tokens.avg_input != null || p.tokens.avg_output != null)) {
      console.log(`  tokens   in=${p.tokens.avg_input}  out=${p.tokens.avg_output}`);
    }
    if (p.cost) {
      const cpc = p.cost.per_call_usd;
      const cpm = p.cost.per_million_calls_usd;
      if (cpc != null) console.log(`  cost     $${cpc}/call  ($${cpm}/1M calls)`);
      else if (p.cost.model) console.log(`  cost     ${p.cost.model}`);
    }
    if (p.model) console.log(`  model    ${p.model}`);
    if (p.endpoint) console.log(`  endpoint ${p.endpoint}`);
    if (p.bin_path) console.log(`  binary   ${shortPath(p.bin_path)}`);
    if (p.notes) console.log(`  notes    ${p.notes}`);
    console.log('');
  }

  // Head-to-head.
  hr(w);
  console.log('head-to-head (vs. kolm-js baseline):');
  hr(w);
  for (const [name, h] of Object.entries(r.head_to_head || {})) {
    if (h.skipped) { console.log(`  ${name.padEnd(12)}  SKIPPED: ${h.skipped}`); continue; }
    console.log(`  ${name.padEnd(12)}  ${h.summary}`);
    if (h.cost_per_million_usd_other != null) {
      console.log(`               cost: kolm-js $0  vs  ${name} $${h.cost_per_million_usd_other} per 1M calls`);
    }
  }
  hr(w);
}

function hr(w) { console.log('-'.repeat(Math.min(w, 100))); }
function label(name, w) { return name.toUpperCase().padEnd(Math.min(w, 100), '·'); }
function us(v) {
  if (v == null) return '—';
  if (v < 1000) return `${v.toFixed(0)}µs`;
  if (v < 1e6) return `${(v / 1e3).toFixed(2)}ms`;
  return `${(v / 1e6).toFixed(2)}s`;
}
function shortPath(p) { try { return path.relative(process.cwd(), p); } catch { return p; } }
function truncate(s, n) { s = String(s || ''); return s.length > n ? s.slice(0, n - 1) + '…' : s; }
