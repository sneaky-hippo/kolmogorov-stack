// Build the public "classifier" example .kolm.
//
// Generic rule-based classifier. Each category is { name, keywords, weight? }.
// Recipe scores the input against each category by counting case-insensitive
// keyword matches (weighted), returns the top category + scores.
// Vertical-agnostic: tenants ship support-ticket categories, dispute
// reasons, intent labels, etc. via params.extra_categories.
//
// Build:
//   RECIPE_RECEIPT_SECRET=kolm-public-fixture-v0-1-0 node scripts/build-example-classifier.mjs

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const SECRET = 'kolm-public-fixture-v0-1-0';
process.env.RECIPE_RECEIPT_SECRET = SECRET;

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repo = path.resolve(__dirname, '..');
const { buildAndZip } = await import(pathToFileURL(path.join(repo, 'src/artifact.js')).href);

const recipeSource = `
function generate(input, lib) {
  var text = (typeof input === 'string') ? input : (input && input.text) || '';
  if (typeof text !== 'string') text = String(text);

  var cats = [];
  var packCats = (lib.pack && lib.pack.categories) || [];
  for (var i = 0; i < packCats.length; i++) cats.push(packCats[i]);
  var tenantCats = (lib.params && lib.params.extra_categories) || [];
  for (var j = 0; j < tenantCats.length; j++) cats.push(tenantCats[j]);

  var lower = text.toLowerCase();
  var scores = {};
  for (var k = 0; k < cats.length; k++) {
    var c = cats[k];
    if (!c || !c.name || !Array.isArray(c.keywords)) continue;
    var weight = (typeof c.weight === 'number' && c.weight > 0) ? c.weight : 1;
    var score = 0;
    for (var n = 0; n < c.keywords.length; n++) {
      var kw = String(c.keywords[n] || '').toLowerCase();
      if (!kw) continue;
      var idx = 0;
      var hits = 0;
      while ((idx = lower.indexOf(kw, idx)) !== -1) { hits++; idx += kw.length; }
      score += hits * weight;
    }
    if (score > 0) scores[c.name] = (scores[c.name] || 0) + score;
  }

  var sortedNames = Object.keys(scores).sort(function (a, b) {
    if (scores[b] !== scores[a]) return scores[b] - scores[a];
    return a < b ? -1 : 1;
  });

  var fallback = (lib.pack && lib.pack.fallback_label) || 'unclassified';
  var top = sortedNames.length ? sortedNames[0] : fallback;

  return { label: top, score: scores[top] || 0, scores: scores };
}
`.trim();

const recipeHash = crypto.createHash('sha256').update(recipeSource).digest('hex').slice(0, 16);

const recipes = [{
  id: 'rcp_classifier_v1',
  name: 'rule-based keyword classifier',
  source: recipeSource,
  source_hash: recipeHash,
  version_id: 'ver_classifier_001',
  tags: ['classification', 'routing', 'rules', 'generic'],
  schema: { input: { text: 'string' }, output: { label: 'string', score: 'number', scores: 'object' } },
}];

// Default categories show the SHAPE; tenants ship their own via params.
const pack = {
  spec: 'kolm-pack-1',
  description: 'default support-ticket categories — meant as a starter set; tenants extend via params.extra_categories',
  fallback_label: 'general',
  categories: [
    { name: 'billing', keywords: ['invoice', 'charge', 'refund', 'payment', 'subscription'] },
    { name: 'bug',     keywords: ['error', 'crash', 'exception', 'broken', "doesn't work", 'fails', 'bug'] },
    { name: 'feature', keywords: ['feature', 'request', 'wish', 'add support', 'would love'] },
    { name: 'auth',    keywords: ['login', 'password', 'signin', 'sign in', '2fa', 'mfa', 'session'] },
  ],
};

const index = {
  spec: 'kolm-index-1',
  by_keyword: { classify: 'rcp_classifier_v1', route: 'rcp_classifier_v1', label: 'rcp_classifier_v1', tag: 'rcp_classifier_v1' },
  by_recipe: { rcp_classifier_v1: ['classify', 'route', 'label', 'tag'] },
};

const evals = {
  spec: 'rs-1-evals',
  n: 5,
  cases: [
    {
      id: 'billing',
      input: { text: 'I need a refund on my last invoice — payment was wrong.' },
      expected: { label: 'billing', score: 3, scores: { billing: 3 } },
    },
    {
      id: 'bug',
      input: { text: 'The app crashes with an exception when I click save.' },
      expected: { label: 'bug', score: 2, scores: { bug: 2 } },
    },
    {
      id: 'feature',
      input: { text: 'I would love a feature request for dark mode.' },
      expected: { label: 'feature', score: 3, scores: { feature: 3 } },
    },
    {
      id: 'fallback',
      input: { text: 'hello there' },
      expected: { label: 'general', score: 0, scores: {} },
    },
    {
      id: 'tenant_extension',
      input:  { text: 'Hardware order DOA-1234 arrived dead' },
      params: { extra_categories: [{ name: 'rma', keywords: ['doa', 'rma', 'dead on arrival'], weight: 2 }] },
      expected: { label: 'rma', score: 2, scores: { rma: 2 } },
    },
  ],
  coverage: 1.0,
};

const outDir = path.join(repo, 'test', 'fixtures');
fs.mkdirSync(outDir, { recursive: true });

const built = await buildAndZip({
  job_id: 'job_example_classifier_v0_1_0',
  task: 'rule-based classifier — score the input against artifact-bound + tenant-supplied keyword categories, return the top label',
  base_model: 'none',
  recipes,
  pack,
  index,
  evals,
  training_stats: { pass_rate_positive: 1.0, latency_p50_us: 80 },
  outDir,
});

const finalPath = path.join(outDir, 'classifier.kolm');
fs.copyFileSync(built.outPath, finalPath);
if (built.outPath !== finalPath) { try { fs.unlinkSync(built.outPath); } catch {} }

const bytes = fs.statSync(finalPath).size;
const sha256 = crypto.createHash('sha256').update(fs.readFileSync(finalPath)).digest('hex');
console.log(`built: ${finalPath}`);
console.log(`bytes: ${bytes}`);
console.log(`sha256: ${sha256}`);
console.log(`k_score: ${built.k_score?.composite}`);
