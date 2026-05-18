// Wave 371 - Training planner (builder layer, pillar 9/12).
//
// Public surface:
//   plan(datasetId, opts) -> training plan envelope
//
// Returns:
//   {
//     plan_id,
//     dataset_id,
//     task,                  // classification | extraction | generation | redaction | unknown
//     examples_real,
//     examples_synthetic,
//     labels,                // count of distinct labels (for classification)
//     label_diversity,       // 0..1 entropy ratio
//     input_length: {p50, p95},
//     sensitive_data_detected: bool,
//     recommended_path,      // rule_first | classifier | lora | distill
//     backbone,              // gemma-3n-e2b | qwen-0.5b | phi-mini | claude-haiku-4-5
//     expected_replacement_rate,
//     holdout_size,
//     estimated_latency_ms,
//     estimated_training_cost_usd,
//     warnings: [],
//   }

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

function sha(s) { return crypto.createHash('sha256').update(String(s)).digest('hex'); }

function loadDataset(datasetId, opts) {
  if (Array.isArray(opts && opts.rows) && opts.rows.length) return { rows: opts.rows, source: 'inline' };
  if (Array.isArray(datasetId)) return { rows: datasetId, source: 'inline' };
  if (typeof datasetId === 'string' && fs.existsSync(datasetId)) {
    const text = fs.readFileSync(datasetId, 'utf8').trim();
    if (text.startsWith('[')) {
      try { return { rows: JSON.parse(text), source: 'file' }; } catch { /* fall through to jsonl */ }
    }
    if (text.startsWith('{') && text.indexOf('\n') === -1) {
      try {
        const j = JSON.parse(text);
        if (Array.isArray(j.rows)) return { rows: j.rows, source: 'file', envelope: j };
      } catch { /* fall through to jsonl */ }
    }
    // JSONL: one JSON object per line (handles both `[`-starting and `{`-starting multiline).
    return {
      rows: text.split(/\r?\n/).filter(Boolean).map((ln) => {
        try { return JSON.parse(ln); } catch { return null; }
      }).filter(Boolean),
      source: 'file',
    };
  }
  if (typeof datasetId === 'string' && datasetId.startsWith('ds_')) {
    const p = path.join(os.homedir(), '.kolm', 'simulations', datasetId + '.json');
    if (fs.existsSync(p)) {
      const j = JSON.parse(fs.readFileSync(p, 'utf8'));
      return { rows: j.rows || [], source: 'sim_dataset', envelope: j };
    }
  }
  return { rows: [], source: 'unknown' };
}

function pctl(arr, p) {
  if (!arr.length) return 0;
  const s = arr.slice().sort((a, b) => a - b);
  const idx = Math.min(s.length - 1, Math.max(0, Math.floor(p * s.length)));
  return s[idx];
}

function detectTask(rows) {
  if (!rows.length) return 'unknown';
  // Sample 50 rows.
  const sample = rows.slice(0, 50);
  // Redaction: outputs look like the input with [PHI_*] tokens inserted.
  const redactionHits = sample.filter((r) => /\[PHI_|\[\w+_\d+\]/.test(String(r.output || ''))).length;
  if (redactionHits >= sample.length * 0.4) return 'redaction';
  // Classification: outputs are short labels, very few distinct values.
  const outputs = sample.map((r) => String(r.output || '').trim());
  const distinct = new Set(outputs);
  const avgLen = outputs.reduce((s, o) => s + o.length, 0) / Math.max(1, outputs.length);
  if (distinct.size <= 20 && avgLen <= 60) return 'classification';
  // Extraction: outputs look like JSON with key extraction.
  const jsonHits = sample.filter((r) => /^[{[]/.test(String(r.output || '').trim())).length;
  if (jsonHits >= sample.length * 0.4) return 'extraction';
  // Default: generation.
  return 'generation';
}

function entropy(map) {
  const total = [...map.values()].reduce((s, v) => s + v, 0);
  if (total === 0) return 0;
  let H = 0;
  for (const v of map.values()) {
    const p = v / total;
    if (p > 0) H -= p * Math.log2(p);
  }
  const max = Math.log2(map.size || 1);
  return max > 0 ? H / max : 0;
}

const SENSITIVE_RE = [/\b\d{3}-\d{2}-\d{4}\b/, /\bMRN\d{4,}\b/i, /\b[\w.-]+@[\w-]+\.[a-z]{2,}\b/i, /\b\d{3}-\d{3}-\d{4}\b/, /\[PHI_/, /\[PII_/];
function hasSensitive(rows) {
  return rows.slice(0, 100).some((r) => SENSITIVE_RE.some((re) => re.test(String(r.input || '') + ' ' + String(r.output || ''))));
}

// Heuristic latency + cost estimates per recommended path. These mirror the
// numbers in MEMORY.md (W354-W358) so the user trial doesn't see a contradiction.
const PATH_PROFILES = {
  rule_first:  { latency_ms: 1,    cost_per_call_usd: 0,        training_cost_usd: 0,    replacement: 0.7 },
  classifier:  { latency_ms: 15,   cost_per_call_usd: 0.000005, training_cost_usd: 3,    replacement: 0.85 },
  lora:        { latency_ms: 80,   cost_per_call_usd: 0.00002,  training_cost_usd: 25,   replacement: 0.9 },
  distill:     { latency_ms: 40,   cost_per_call_usd: 0.00002,  training_cost_usd: 80,   replacement: 0.93 },
};

const BACKBONE_BY_PATH = {
  rule_first: 'none',
  classifier: 'gemma-3n-e2b',
  lora: 'qwen-0.5b',
  distill: 'phi-mini',
};

function pickPath(task, examplesReal, labelDiversity) {
  if (task === 'classification' && labelDiversity < 0.3) return 'rule_first';
  if (task === 'classification') return 'classifier';
  if (task === 'redaction' && examplesReal < 200) return 'classifier';
  if (task === 'generation' && examplesReal >= 1000) return 'distill';
  if (task === 'generation') return 'lora';
  if (task === 'extraction' && examplesReal < 500) return 'classifier';
  if (task === 'extraction') return 'lora';
  // Fallback
  if (examplesReal >= 1000) return 'distill';
  return 'lora';
}

export async function plan(datasetId, opts = {}) {
  const { rows, source, envelope } = loadDataset(datasetId, opts);
  const warnings = [];
  if (rows.length === 0) {
    warnings.push('dataset_empty');
    return {
      plan_id: 'plan_empty_' + sha(String(datasetId)).slice(0, 12),
      dataset_id: typeof datasetId === 'string' ? datasetId : 'inline',
      dataset_source: source,
      task: 'unknown',
      examples_real: 0,
      examples_synthetic: 0,
      labels: 0,
      label_diversity: 0,
      input_length: { p50: 0, p95: 0 },
      sensitive_data_detected: false,
      recommended_path: 'rule_first',
      backbone: 'none',
      expected_replacement_rate: 0,
      holdout_size: 0,
      estimated_latency_ms: 0,
      estimated_training_cost_usd: 0,
      warnings,
    };
  }
  const examplesSynthetic = rows.filter((r) => r.source_type === 'synthetic').length;
  const examplesReal = rows.length - examplesSynthetic;
  const task = detectTask(rows);
  // Label diversity for classification/redaction.
  const labelMap = new Map();
  for (const r of rows.slice(0, 2000)) {
    const lbl = String(r.output || '').trim().slice(0, 200);
    labelMap.set(lbl, (labelMap.get(lbl) || 0) + 1);
  }
  const labels = labelMap.size;
  const labelDiversity = entropy(labelMap);
  // Input length distribution.
  const lens = rows.slice(0, 2000).map((r) => String(r.input || '').length);
  const inputLength = { p50: pctl(lens, 0.5), p95: pctl(lens, 0.95) };
  const sensitive = hasSensitive(rows);
  // Pick path + backbone.
  const recommendedPath = pickPath(task, examplesReal, labelDiversity);
  const backbone = BACKBONE_BY_PATH[recommendedPath] || 'qwen-0.5b';
  const profile = PATH_PROFILES[recommendedPath];
  const holdoutSize = Math.max(1, Math.floor(rows.length * 0.2));
  // Warnings.
  if (examplesSynthetic > 0 && envelope && Array.isArray(envelope.holdout) && envelope.holdout.some((h) => h.source_type === 'synthetic')) {
    warnings.push('synthetic_in_holdout: holdout contains synthetic rows. Pass holdoutFromSim=false (default) and re-split for an honest evaluation.');
  }
  if (examplesReal < 30) warnings.push('few_real_examples: <30 real examples reduces the floor of every recommendation; consider mining more captures first.');
  if (sensitive && recommendedPath === 'distill') warnings.push('sensitive_data_in_distill: distill copies prompts to a third-party teacher unless you set KOLM_LLM_PROVIDER to a local backend. Verify privacy_membrane first.');
  if (labels > 50 && task === 'classification') warnings.push('too_many_labels_for_classifier: consider switching to lora or hierarchical classification.');
  // Replacement rate estimate is the path baseline, scaled down 5%/100 missing
  // real examples below 200.
  const realPenalty = examplesReal < 200 ? Math.max(0, 0.05 * Math.floor((200 - examplesReal) / 100)) : 0;
  const expectedReplacement = Math.max(0, profile.replacement - realPenalty);

  return {
    plan_id: 'plan_' + sha(String(datasetId) + ':' + recommendedPath + ':' + rows.length).slice(0, 12),
    dataset_id: typeof datasetId === 'string' ? datasetId : 'inline',
    dataset_source: source,
    task,
    examples_real: examplesReal,
    examples_synthetic: examplesSynthetic,
    labels,
    label_diversity: Math.round(labelDiversity * 100) / 100,
    input_length: inputLength,
    sensitive_data_detected: sensitive,
    recommended_path: recommendedPath,
    backbone,
    expected_replacement_rate: Math.round(expectedReplacement * 100) / 100,
    holdout_size: holdoutSize,
    estimated_latency_ms: profile.latency_ms,
    estimated_training_cost_usd: profile.training_cost_usd,
    warnings,
  };
}

export function planReport(plan) {
  if (!plan) return 'no plan';
  const lines = [];
  lines.push('Training Plan: ' + plan.plan_id);
  lines.push('');
  lines.push('  Dataset:                  ' + plan.dataset_id);
  lines.push('    Real examples:          ' + plan.examples_real);
  lines.push('    Synthetic examples:     ' + plan.examples_synthetic);
  lines.push('    Labels (distinct):      ' + plan.labels);
  lines.push('    Label diversity:        ' + plan.label_diversity);
  lines.push('    Input length p50/p95:   ' + plan.input_length.p50 + ' / ' + plan.input_length.p95);
  lines.push('    Sensitive data:         ' + (plan.sensitive_data_detected ? 'YES' : 'no'));
  lines.push('');
  lines.push('  Detected task:            ' + plan.task);
  lines.push('  Recommended path:         ' + plan.recommended_path);
  lines.push('  Backbone:                 ' + plan.backbone);
  lines.push('  Expected replacement:     ' + (Math.round(plan.expected_replacement_rate * 100)) + '%');
  lines.push('  Holdout size:             ' + plan.holdout_size + ' examples');
  lines.push('  Estimated p50 latency:    ' + plan.estimated_latency_ms + ' ms');
  lines.push('  Estimated training cost:  $' + plan.estimated_training_cost_usd);
  if (plan.warnings && plan.warnings.length) {
    lines.push('');
    lines.push('Warnings:');
    for (const w of plan.warnings) lines.push('  - ' + w);
  }
  return lines.join('\n');
}

export default { plan, planReport };
