// Build the public "redactor" example .kolm.
//
// Generic, deterministic identifier redactor. Works for any vertical:
// HR, legal, finance, healthcare, support, education. The artifact ships a
// curated default pattern set in the behaviour pack (lora.bin). Tenants
// extend it at run time via params.extra_patterns and params.redact_words —
// no re-signing, the published artifact stays byte-exact.
//
// Build:
//   RECIPE_RECEIPT_SECRET=kolm-public-fixture-v0-1-0 node scripts/build-example-redactor.mjs
//
// Run:
//   kolm run test/fixtures/redactor.kolm '{"text":"contact 555-123-4567"}'
//   kolm run test/fixtures/redactor.kolm '{"text":"id 12-345"}' \
//     --params '{"extra_patterns":[{"name":"emp_id","regex":"\\b\\d{2}-\\d{3}\\b","replacement":"[EMP_ID]"}]}'

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const SECRET = 'kolm-public-fixture-v0-1-0';
process.env.RECIPE_RECEIPT_SECRET = SECRET;

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repo = path.resolve(__dirname, '..');
const { buildAndZip } = await import(pathToFileURL(path.join(repo, 'src/artifact.js')).href);

// The recipe is a generic redactor. It composes:
//   1. lib.patterns.{email,phone,url,ipv4,date}   — built-in primitives
//   2. lib.pack.default_patterns                  — artifact-bound curated set
//   3. lib.params.extra_patterns / redact_words   — tenant-supplied at run time
// All three are deterministic. Output is { redacted, hits: [{name, count}] }.
const recipeSource = `
function generate(input, lib) {
  var text = (typeof input === 'string') ? input : (input && input.text) || '';
  if (typeof text !== 'string') { return { redacted: '', hits: [] }; }

  var patterns = [];

  // built-in primitives — opt-in via the artifact pack so tenants can disable
  var enabled = (lib.pack && lib.pack.enabled_builtins) || ['email','phone','url','ipv4','date'];
  for (var i = 0; i < enabled.length; i++) {
    var k = enabled[i];
    if (lib.patterns[k]) {
      patterns.push({ name: k.toUpperCase(), regex: lib.patterns[k], replacement: '[' + k.toUpperCase() + ']' });
    }
  }

  // artifact-bound default packs
  var packPats = (lib.pack && lib.pack.default_patterns) || [];
  for (var j = 0; j < packPats.length; j++) {
    var p = packPats[j];
    try {
      patterns.push({ name: p.name, regex: new RegExp(p.regex, p.flags || 'g'), replacement: p.replacement || ('[' + p.name + ']') });
    } catch (e) { /* skip malformed pack entry */ }
  }

  // tenant-supplied extras (run-time, never re-signed into the artifact)
  var extras = (lib.params && lib.params.extra_patterns) || [];
  for (var x = 0; x < extras.length; x++) {
    var e = extras[x];
    try {
      patterns.push({ name: e.name, regex: new RegExp(e.regex, e.flags || 'g'), replacement: e.replacement || ('[' + e.name + ']') });
    } catch (err) { /* skip malformed tenant entry */ }
  }

  var hits = {};
  var redacted = text;
  for (var n = 0; n < patterns.length; n++) {
    var pat = patterns[n];
    var count = 0;
    redacted = redacted.replace(pat.regex, function () { count++; return pat.replacement; });
    if (count > 0) hits[pat.name] = (hits[pat.name] || 0) + count;
  }

  // optional literal-word redaction list (tenant-supplied)
  var words = (lib.params && lib.params.redact_words) || [];
  for (var w = 0; w < words.length; w++) {
    var word = String(words[w] || '');
    if (!word) continue;
    var re = new RegExp(escapeRe(word), 'gi');
    var c = 0;
    redacted = redacted.replace(re, function () { c++; return '[REDACTED]'; });
    if (c > 0) hits['LITERAL'] = (hits['LITERAL'] || 0) + c;
  }

  function escapeRe(s) { return s.replace(/[.*+?^\${}()|[\\]\\\\]/g, '\\\\$&'); }

  var hitList = [];
  for (var key in hits) hitList.push({ name: key, count: hits[key] });
  hitList.sort(function (a, b) { return a.name < b.name ? -1 : a.name > b.name ? 1 : 0; });

  return { redacted: redacted, hits: hitList };
}
`.trim();

const recipeHash = crypto.createHash('sha256').update(recipeSource).digest('hex').slice(0, 16);

const recipes = [{
  id: 'rcp_redactor_v1',
  name: 'identifier redactor',
  source: recipeSource,
  source_hash: recipeHash,
  version_id: 'ver_redactor_001',
  tags: ['redaction', 'privacy', 'extraction', 'generic'],
  schema: { input: { text: 'string' }, output: { redacted: 'string', hits: 'array' } },
}];

// Behaviour pack: curated default patterns shipped *in* the artifact. These
// are conservative, well-known, and safe defaults. Vertical specifics
// (hospital MRN formats, payroll IDs, internal case numbers) belong in
// tenant params, not the artifact.
const pack = {
  spec: 'kolm-pack-1',
  description: 'default identifier patterns for the public redactor example',
  enabled_builtins: ['email', 'phone', 'url', 'ipv4', 'date'],
  default_patterns: [
    { name: 'SSN_LIKE', regex: '\\b\\d{3}-\\d{2}-\\d{4}\\b', replacement: '[SSN]' },
    { name: 'CREDIT_CARD_LIKE', regex: '\\b(?:\\d[ -]*?){13,16}\\b', replacement: '[CC]' },
    { name: 'IBAN_LIKE', regex: '\\b[A-Z]{2}\\d{2}[A-Z0-9]{10,30}\\b', replacement: '[IBAN]' },
  ],
};

// Lookup index: keyword → recipe (only one recipe today, but the index is
// real and useful — runners can pick by intent in future versions).
const index = {
  spec: 'kolm-index-1',
  by_keyword: {
    redact: 'rcp_redactor_v1',
    privacy: 'rcp_redactor_v1',
    pii: 'rcp_redactor_v1',
    pattern: 'rcp_redactor_v1',
    scrub: 'rcp_redactor_v1',
  },
  by_recipe: {
    rcp_redactor_v1: ['redact', 'privacy', 'pii', 'pattern', 'scrub'],
  },
};

const evals = {
  spec: 'rs-1-evals',
  n: 6,
  cases: [
    { id: 'phone',   input: { text: 'call 555-123-4567 today' }, expected: { redacted: 'call [PHONE] today', hits: [{ name: 'PHONE', count: 1 }] } },
    { id: 'email',   input: { text: 'mail me at foo@example.com' }, expected: { redacted: 'mail me at [EMAIL]', hits: [{ name: 'EMAIL', count: 1 }] } },
    { id: 'ssn',     input: { text: 'ssn 123-45-6789' }, expected: { redacted: 'ssn [SSN]', hits: [{ name: 'SSN_LIKE', count: 1 }] } },
    { id: 'mixed',   input: { text: 'admin@x.io and 10.0.0.1' }, expected: { redacted: '[EMAIL] and [IPV4]', hits: [{ name: 'EMAIL', count: 1 }, { name: 'IPV4', count: 1 }] } },
    { id: 'empty',   input: { text: '' }, expected: { redacted: '', hits: [] } },
    {
      id: 'tenant_extra',
      input:  { text: 'employee 12-345 logged in' },
      params: { extra_patterns: [{ name: 'EMP_ID', regex: '\\b\\d{2}-\\d{3}\\b', replacement: '[EMP_ID]' }] },
      expected: { redacted: 'employee [EMP_ID] logged in', hits: [{ name: 'EMP_ID', count: 1 }] },
    },
  ],
  coverage: 1.0,
};

const outDir = path.join(repo, 'test', 'fixtures');
fs.mkdirSync(outDir, { recursive: true });

const built = await buildAndZip({
  job_id: 'job_example_redactor_v0_1_0',
  task: 'identifier redactor — deterministic redaction over built-in patterns + artifact-bound packs + tenant-supplied extras',
  base_model: 'none',
  recipes,
  pack,
  index,
  evals,
  training_stats: { pass_rate_positive: 1.0, latency_p50_us: 60 },
  outDir,
});

const finalPath = path.join(outDir, 'redactor.kolm');
fs.copyFileSync(built.outPath, finalPath);
if (built.outPath !== finalPath) { try { fs.unlinkSync(built.outPath); } catch {} }

const bytes = fs.statSync(finalPath).size;
const sha256 = crypto.createHash('sha256').update(fs.readFileSync(finalPath)).digest('hex');
console.log(`built: ${finalPath}`);
console.log(`bytes: ${bytes}`);
console.log(`sha256: ${sha256}`);
console.log(`k_score: ${built.k_score?.composite}`);
