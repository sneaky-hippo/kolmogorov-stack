// Build the public "extractor" example .kolm.
//
// Generic structured-field extractor. Each artifact-bound or tenant-supplied
// rule is { name, regex, group?, transform? }. Recipe runs every rule
// against the input text and returns { fields: {name: value or null}, raw }.
// Vertical-agnostic: tenants ship invoice extractors, ticket extractors,
// case-id extractors, ticker extractors etc. via params.extra_rules.
//
// Build:
//   RECIPE_RECEIPT_SECRET=kolm-public-fixture-v0-1-0 node scripts/build-example-extractor.mjs

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
  if (typeof text !== 'string') { return { fields: {}, raw: '' }; }

  var rules = [];
  var packRules = (lib.pack && lib.pack.default_rules) || [];
  for (var i = 0; i < packRules.length; i++) rules.push(packRules[i]);
  var tenantRules = (lib.params && lib.params.extra_rules) || [];
  for (var j = 0; j < tenantRules.length; j++) rules.push(tenantRules[j]);

  var fields = {};
  for (var k = 0; k < rules.length; k++) {
    var r = rules[k];
    if (!r || !r.name || !r.regex) continue;
    var re;
    try { re = new RegExp(r.regex, r.flags || ''); }
    catch (err) { fields[r.name] = null; continue; }
    var m = text.match(re);
    if (!m) { fields[r.name] = null; continue; }
    var raw = (typeof r.group === 'number' && r.group >= 0) ? (m[r.group] != null ? m[r.group] : null) : m[0];
    if (raw == null) { fields[r.name] = null; continue; }
    if (r.transform === 'upper') raw = String(raw).toUpperCase();
    else if (r.transform === 'lower') raw = String(raw).toLowerCase();
    else if (r.transform === 'trim') raw = String(raw).trim();
    else if (r.transform === 'number') {
      var n = lib.parseFloatSafe(raw);
      raw = isNaN(n) ? null : n;
    }
    fields[r.name] = raw;
  }

  return { fields: fields, raw: text };
}
`.trim();

const recipeHash = crypto.createHash('sha256').update(recipeSource).digest('hex').slice(0, 16);

const recipes = [{
  id: 'rcp_extractor_v1',
  name: 'structured field extractor',
  source: recipeSource,
  source_hash: recipeHash,
  version_id: 'ver_extractor_001',
  tags: ['extraction', 'parsing', 'structured', 'generic'],
  schema: { input: { text: 'string' }, output: { fields: 'object', raw: 'string' } },
}];

const pack = {
  spec: 'kolm-pack-1',
  description: 'default extraction rules — generic, vertical-agnostic',
  default_rules: [
    { name: 'invoice_number', regex: '(?:invoice|inv)\\s*#?\\s*(\\d{3,})', flags: 'i', group: 1, transform: 'trim' },
    { name: 'amount_usd', regex: '\\$\\s*(\\d+(?:\\.\\d{2})?)', group: 1, transform: 'number' },
    { name: 'order_id', regex: '\\border-(\\d{4,})\\b', flags: 'i', group: 1, transform: 'upper' },
    { name: 'iso_date', regex: '\\b(\\d{4}-\\d{2}-\\d{2})\\b', group: 1 },
    { name: 'tracking_id', regex: '\\b1Z[0-9A-Z]{16}\\b' },
  ],
};

const index = {
  spec: 'kolm-index-1',
  by_keyword: { extract: 'rcp_extractor_v1', parse: 'rcp_extractor_v1', invoice: 'rcp_extractor_v1', amount: 'rcp_extractor_v1' },
  by_recipe: { rcp_extractor_v1: ['extract', 'parse', 'invoice', 'amount'] },
};

const evals = {
  spec: 'rs-1-evals',
  n: 5,
  cases: [
    {
      id: 'invoice',
      input: { text: 'Invoice #12345 dated 2026-05-09 totals $199.50' },
      expected: { fields: { invoice_number: '12345', amount_usd: 199.5, order_id: null, iso_date: '2026-05-09', tracking_id: null }, raw: 'Invoice #12345 dated 2026-05-09 totals $199.50' },
    },
    {
      id: 'order',
      input: { text: 'Your Order-9001 has shipped via 1ZABCDEF1234567890' },
      expected: { fields: { invoice_number: null, amount_usd: null, order_id: '9001', iso_date: null, tracking_id: '1ZABCDEF1234567890' }, raw: 'Your Order-9001 has shipped via 1ZABCDEF1234567890' },
    },
    {
      id: 'empty',
      input: { text: '' },
      expected: { fields: { invoice_number: null, amount_usd: null, order_id: null, iso_date: null, tracking_id: null }, raw: '' },
    },
    {
      id: 'tenant_rule',
      input: { text: 'CASE-2026-0042 priority high' },
      params: { extra_rules: [{ name: 'case_id', regex: 'CASE-\\d{4}-\\d{4}' }] },
      expected: { fields: { invoice_number: null, amount_usd: null, order_id: null, iso_date: null, tracking_id: null, case_id: 'CASE-2026-0042' }, raw: 'CASE-2026-0042 priority high' },
    },
    {
      id: 'multi_amount',
      input: { text: 'subtotal $50.00 tax $5.00' },
      expected: { fields: { invoice_number: null, amount_usd: 50, order_id: null, iso_date: null, tracking_id: null }, raw: 'subtotal $50.00 tax $5.00' },
    },
  ],
  coverage: 1.0,
};

const outDir = path.join(repo, 'test', 'fixtures');
fs.mkdirSync(outDir, { recursive: true });

const built = await buildAndZip({
  job_id: 'job_example_extractor_v0_1_0',
  task: 'structured-field extractor — pull named fields from text via artifact-bound + tenant-supplied regex rules',
  base_model: 'none',
  recipes,
  pack,
  index,
  evals,
  training_stats: { pass_rate_positive: 1.0, latency_p50_us: 70 },
  outDir,
});

const finalPath = path.join(outDir, 'extractor.kolm');
fs.copyFileSync(built.outPath, finalPath);
if (built.outPath !== finalPath) { try { fs.unlinkSync(built.outPath); } catch {} }

const bytes = fs.statSync(finalPath).size;
const sha256 = crypto.createHash('sha256').update(fs.readFileSync(finalPath)).digest('hex');
console.log(`built: ${finalPath}`);
console.log(`bytes: ${bytes}`);
console.log(`sha256: ${sha256}`);
console.log(`k_score: ${built.k_score?.composite}`);
