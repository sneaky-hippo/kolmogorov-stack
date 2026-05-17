// src/bench-report-md.js
//
// Render the JSON report produced by compareArtifact() as a human-readable
// Markdown document. Used by `kolm bench --compare ... --md <out.md>`.
//
// The report shape is the kolm-benchmark-compare-1 spec defined in
// src/benchmark-compare.js. Skipped paths render as a single-line table
// row rather than being omitted, so a reviewer can see which paths the
// run did and didn't measure (and why each was skipped).

export function renderMarkdownReport(report) {
  const lines = [];
  const r = report;
  const paths = r.paths || {};

  lines.push(`# Kolm vs. LLM — Head-to-Head Benchmark`);
  lines.push('');
  lines.push(`**Artifact**: \`${r.artifact}\``);
  lines.push(`**Artifact sha256**: \`${r.artifact_sha256}\``);
  lines.push(`**Task**: ${r.task || '(unspecified)'}`);
  lines.push(`**Started**: ${r.started_at}`);
  lines.push(`**Finished**: ${r.finished_at}`);
  lines.push(`**Host**: ${r.host?.platform || '?'}/${r.host?.arch || '?'}, Node ${r.host?.node || '?'}`);
  lines.push('');

  lines.push(`## Corpus`);
  lines.push('');
  lines.push(`- **${r.cases}** total cases scored against the kolm paths (full corpus, ${r.runs_per_case} run(s) per case)`);
  if (r.llm_sample_n != null && r.llm_sample_n < r.cases) {
    lines.push(`- **${r.llm_sample_n}** sampled cases scored against the LLM paths (cost-bounded; first N rows)`);
  } else {
    lines.push(`- **${r.llm_sample_n ?? r.cases}** cases scored against the LLM paths (full corpus)`);
  }
  lines.push('');

  lines.push(`## Latency`);
  lines.push('');
  lines.push(`| Path | n | min (µs) | p50 (µs) | p95 (µs) | p99 (µs) | max (µs) |`);
  lines.push(`|------|---|---------:|---------:|---------:|---------:|---------:|`);
  for (const key of ['kolm-js', 'kolm-native', 'llm-api', 'local-llm']) {
    const p = paths[key];
    if (!p || p.skipped) {
      lines.push(`| ${key} | – | – | – | – | – | _skipped: ${escMd(p?.reason || 'not run')}_ |`);
      continue;
    }
    const l = p.latency_us || {};
    lines.push(`| ${key} | ${fmtNum(l.n)} | ${fmtNum(l.min)} | ${fmtNum(l.p50)} | ${fmtNum(l.p95)} | ${fmtNum(l.p99)} | ${fmtNum(l.max)} |`);
  }
  lines.push('');

  lines.push(`## Correctness`);
  lines.push('');
  lines.push(`| Path | Graded | Passed | Accuracy | Comparator |`);
  lines.push(`|------|-------:|-------:|---------:|------------|`);
  for (const key of ['kolm-js', 'kolm-native', 'llm-api', 'local-llm']) {
    const p = paths[key];
    if (!p || p.skipped) {
      lines.push(`| ${key} | – | – | – | _skipped_ |`);
      continue;
    }
    const c = p.correctness || {};
    const pct = c.accuracy != null ? (c.accuracy * 100).toFixed(1) + '%' : '–';
    lines.push(`| ${key} | ${fmtNum(c.graded)} | ${fmtNum(c.passed)} | ${pct} | ${c.comparator || 'exact'} |`);
  }
  lines.push('');

  // Head-to-head — speedup ratios over kolm-js baseline.
  lines.push(`## Head-to-head (vs. kolm-js p50)`);
  lines.push('');
  const h2h = r.head_to_head || {};
  if (h2h.note) {
    lines.push(`_${h2h.note}_`);
  } else {
    lines.push(`| Path | Other p50 (µs) | kolm-js p50 (µs) | Ratio | Verdict |`);
    lines.push(`|------|---------------:|-----------------:|------:|---------|`);
    for (const key of Object.keys(h2h)) {
      const e = h2h[key];
      if (e.skipped) {
        lines.push(`| ${key} | – | – | – | _skipped: ${escMd(e.skipped)}_ |`);
        continue;
      }
      lines.push(`| ${key} | ${fmtNum(e.p50_other_us)} | ${fmtNum(e.p50_kolm_js_us)} | ${e.p50_latency_ratio != null ? e.p50_latency_ratio + '×' : '–'} | ${e.summary || ''} |`);
    }
  }
  lines.push('');

  lines.push(`## Cost`);
  lines.push('');
  lines.push(`| Path | Per call (USD) | Per million calls (USD) | Notes |`);
  lines.push(`|------|--------------:|------------------------:|-------|`);
  for (const key of ['kolm-js', 'kolm-native', 'llm-api', 'local-llm']) {
    const p = paths[key];
    if (!p || p.skipped) {
      lines.push(`| ${key} | – | – | _skipped_ |`);
      continue;
    }
    const c = p.cost || {};
    const per = c.per_call_usd != null ? '$' + Number(c.per_call_usd).toFixed(6) : '–';
    const perM = c.per_million_calls_usd != null ? '$' + Number(c.per_million_calls_usd).toFixed(2) : '–';
    const notes = [p.model && `model ${p.model}`, p.vendor && `vendor ${p.vendor}`].filter(Boolean).join('; ');
    lines.push(`| ${key} | ${per} | ${perM} | ${notes || (c.model || '')} |`);
  }
  lines.push('');

  // First few correctness failures (if any) — surfaces the actual model
  // mismatches so a reviewer doesn't have to spelunk into the JSON to see
  // what went wrong. Limited to first 5 per path so the report stays
  // skimmable on 1000-row runs.
  const failureBlocks = [];
  for (const key of ['kolm-js', 'kolm-native', 'llm-api', 'local-llm']) {
    const p = paths[key];
    if (!p || p.skipped) continue;
    const fails = p.correctness?.failures;
    if (!fails || !fails.length) continue;
    failureBlocks.push({ key, fails });
  }
  if (failureBlocks.length) {
    lines.push(`## Sample failures`);
    lines.push('');
    for (const block of failureBlocks) {
      lines.push(`### ${block.key}`);
      lines.push('');
      for (const f of block.fails.slice(0, 5)) {
        lines.push(`- **${f.id}** — expected \`${escMd(JSON.stringify(f.expected))}\`, got \`${escMd(JSON.stringify(f.got))}\`${f.error ? ` (error: ${escMd(f.error)})` : ''}`);
      }
      lines.push('');
    }
  }

  lines.push(`---`);
  lines.push(`*Generated by \`kolm bench --compare\`. Latency numbers are observed from THIS run on this host; cost-per-million is per-call × 1M (linear). Skipped paths cite their reason inline.*`);
  lines.push('');
  return lines.join('\n');
}

function fmtNum(v) {
  if (v == null) return '–';
  if (typeof v !== 'number') return String(v);
  if (v >= 1000) return Math.round(v).toLocaleString('en-US');
  return String(v);
}

function escMd(s) {
  if (s == null) return '';
  return String(s).replace(/\|/g, '\\|').replace(/\n/g, ' ').slice(0, 200);
}
