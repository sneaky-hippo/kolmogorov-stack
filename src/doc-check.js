// Multimodal document completeness checker for .kolm pipelines.
//
// `kolm doc check <file>` runs a declarative completeness spec over a document
// (PDF, HTML, plain text, JSON). It answers: "does this document have every
// section / field / signal a downstream pipeline needs to process it?"
//
// Output is a verdict (pass / warn / fail) plus a per-check result list and a
// completeness score. Built-in doc specs ship for common health-insurance
// document classes (claim-packet, denial-letter, pa-request, eob, appeal-letter)
// so the common case is one command:
//
//   kolm doc check denial.pdf --type denial-letter
//
// A custom spec is JSON conforming to:
//   {
//     "spec": "kolm-docspec-1",
//     "name": "<docname>",
//     "min_words": <int>?,
//     "max_words": <int>?,
//     "required_patterns": [
//       { "name": "<id>", "regex": "<re>", "flags": "i"?, "severity": "error"|"warn"  }
//     ],
//     "forbidden_patterns": [ ... ],   // a hit on any of these fails the check
//     "required_sections": [ { "name": "<id>", "heading_regex": "<re>", "flags": "i"?, "severity": "error" } ]
//   }
//
// A score is computed as (required_passed + 0.5*warn_passed) / required_total.
// A document with all required_patterns + required_sections matched and no
// forbidden_patterns hit returns verdict='pass'. Any error-severity miss
// returns 'fail'. warn-severity misses return 'warn'.

import fs from 'node:fs';

export const DOCSPEC_SPEC = 'kolm-docspec-1';

export const BUILTIN_SPECS = {
  'claim-packet': {
    spec: DOCSPEC_SPEC,
    name: 'claim-packet',
    description: 'CMS-1500 / 837P claim packet',
    min_words: 50,
    required_patterns: [
      { name: 'member_id',  regex: '\\b(member|subscriber|patient)\\s*(id|#|number)\\b', flags: 'i', severity: 'error' },
      { name: 'npi',        regex: '\\b(NPI|National Provider Identifier)\\b.*?\\d{10}\\b', flags: 'is', severity: 'error' },
      { name: 'service_dt', regex: '\\b(date\\s*of\\s*service|service\\s*date|DOS)\\b', flags: 'i', severity: 'error' },
      { name: 'cpt_or_icd', regex: '\\b(CPT|HCPCS|ICD[- ]?10|ICD[- ]?9)\\b', flags: 'i', severity: 'error' },
      { name: 'charges',    regex: '\\$\\s*\\d+(?:[.,]\\d{2})?', severity: 'error' },
      { name: 'diagnosis',  regex: '\\b(diagnosis|dx)\\b', flags: 'i', severity: 'warn' },
    ],
  },
  'denial-letter': {
    spec: DOCSPEC_SPEC,
    name: 'denial-letter',
    description: 'Payer denial / adverse benefit determination letter',
    min_words: 100,
    required_patterns: [
      { name: 'member_id',       regex: '\\b(member|subscriber|patient)\\s*(id|#|number)\\b', flags: 'i', severity: 'error' },
      { name: 'denial_keyword',  regex: '\\b(deny|denied|denial|not\\s+covered|adverse\\s+benefit|non[- ]?coverage)\\w*\\b', flags: 'i', severity: 'error' },
      { name: 'reason',          regex: '\\b(reason|rationale|because|basis)\\w*\\b', flags: 'i', severity: 'error' },
      { name: 'appeal_rights',   regex: '\\b(appeal|reconsider|grievance)\\w*\\b', flags: 'i', severity: 'error' },
      { name: 'appeal_deadline', regex: '\\b(within|by)\\s+\\d+\\s*(days|months|business\\s+days)\\b', flags: 'i', severity: 'error' },
      { name: 'contact',         regex: '\\b\\d{3}[\\s.\\-]\\d{3}[\\s.\\-]\\d{4}\\b', severity: 'warn' },
    ],
  },
  'pa-request': {
    spec: DOCSPEC_SPEC,
    name: 'pa-request',
    description: 'Prior authorization request packet',
    min_words: 80,
    required_patterns: [
      { name: 'patient',           regex: '\\b(patient|member|enrollee)\\b', flags: 'i', severity: 'error' },
      { name: 'requested_service', regex: '\\b(request\\w*\\s+(for|service|procedure)|prior\\s+auth\\w*)\\b', flags: 'i', severity: 'error' },
      { name: 'clinical_justify',  regex: '\\b(clinical|medical)\\s+(justification|necessity|rationale)\\b', flags: 'i', severity: 'error' },
      { name: 'provider_npi',      regex: '\\b(NPI|provider\\s*id)\\b.*?\\d{10}', flags: 'is', severity: 'error' },
      { name: 'diagnosis_code',    regex: '\\b(ICD[- ]?10|diagnosis\\s+code)\\b', flags: 'i', severity: 'error' },
      { name: 'prior_treatments',  regex: '\\b(prior|previous|history\\s+of)\\s+(treatment|therap|medication)\\w*\\b', flags: 'i', severity: 'warn' },
    ],
  },
  'eob': {
    spec: DOCSPEC_SPEC,
    name: 'eob',
    description: 'Explanation of Benefits',
    min_words: 60,
    required_patterns: [
      { name: 'eob_header',       regex: '\\b(explanation\\s+of\\s+benefits|EOB)\\b', flags: 'i', severity: 'error' },
      { name: 'claim_number',     regex: '\\b(claim|reference)\\s*(#|number|id)\\b', flags: 'i', severity: 'error' },
      { name: 'amount_billed',    regex: '\\b(billed|charged|amount\\s+billed)\\b', flags: 'i', severity: 'error' },
      { name: 'amount_paid',      regex: '\\b(paid|payment|allowed\\s+amount)\\b', flags: 'i', severity: 'error' },
      { name: 'patient_resp',     regex: '\\b(patient\\s+responsibility|copay|coinsurance|deductible|you\\s+owe)\\b', flags: 'i', severity: 'error' },
      { name: 'service_dt',       regex: '\\b(date\\s*of\\s*service|service\\s*date|DOS)\\b', flags: 'i', severity: 'warn' },
    ],
  },
  'appeal-letter': {
    spec: DOCSPEC_SPEC,
    name: 'appeal-letter',
    description: 'Member or provider appeal letter',
    min_words: 100,
    required_patterns: [
      { name: 'salutation',     regex: '\\b(dear|to whom|re:|regarding)\\b', flags: 'i', severity: 'warn' },
      { name: 'appeal_subject', regex: '\\b(appeal|reconsider|grievance)\\w*\\b', flags: 'i', severity: 'error' },
      { name: 'denial_ref',     regex: '\\b(denial|deny|denied|determination|claim)\\w*\\b', flags: 'i', severity: 'error' },
      { name: 'argument',       regex: '\\b(because|reason|medical\\s+necessity|policy|covered)\\w*\\b', flags: 'i', severity: 'error' },
      { name: 'request_action', regex: '\\b(request|please|ask|overturn|reverse|reconsider)\\w*\\b', flags: 'i', severity: 'error' },
      { name: 'signoff',        regex: '\\b(sincerely|regards|respectfully|thank\\s+you)\\b', flags: 'i', severity: 'warn' },
    ],
    forbidden_patterns: [
      { name: 'lorem',   regex: '\\blorem\\s+ipsum\\b', flags: 'i', severity: 'error' },
      { name: 'todo',    regex: '\\b(TODO|TBD|XXX|FIXME)\\b', severity: 'warn' },
      { name: 'placeholder', regex: '\\[(insert|placeholder|name|date|claim\\s*#)\\]', flags: 'i', severity: 'error' },
    ],
  },
};

function compileRule(rule) {
  return new RegExp(rule.regex, rule.flags || '');
}

export function checkDocument(text, spec) {
  if (!spec || spec.spec !== DOCSPEC_SPEC) {
    throw new Error(`invalid docspec: expected spec=${DOCSPEC_SPEC}`);
  }
  const wordCount = (text.match(/\S+/g) || []).length;
  const checks = [];
  let errors = 0;
  let warnings = 0;
  let requiredPassed = 0;
  let requiredTotal = 0;
  let warnPassed = 0;
  let warnTotal = 0;

  const pushCheck = (c) => {
    checks.push(c);
    const sev = c.severity || 'error';
    if (c.required) {
      if (sev === 'error') {
        requiredTotal += 1;
        if (c.passed) requiredPassed += 1;
        else errors += 1;
      } else {
        warnTotal += 1;
        if (c.passed) warnPassed += 1;
        else warnings += 1;
      }
    } else if (!c.passed) {
      if (sev === 'error') errors += 1;
      else warnings += 1;
    }
  };

  if (typeof spec.min_words === 'number') {
    pushCheck({
      name: 'min_words', kind: 'word_count', required: true, severity: 'error',
      passed: wordCount >= spec.min_words,
      detail: { observed: wordCount, threshold: spec.min_words },
    });
  }
  if (typeof spec.max_words === 'number') {
    pushCheck({
      name: 'max_words', kind: 'word_count', required: true, severity: 'error',
      passed: wordCount <= spec.max_words,
      detail: { observed: wordCount, threshold: spec.max_words },
    });
  }

  for (const rule of (spec.required_patterns || [])) {
    const re = compileRule(rule);
    const m = text.match(re);
    pushCheck({
      name: rule.name, kind: 'required_pattern', required: true,
      severity: rule.severity || 'error',
      passed: Boolean(m),
      detail: m ? { match: m[0].slice(0, 80) } : { regex: rule.regex },
    });
  }
  for (const rule of (spec.required_sections || [])) {
    const re = new RegExp(rule.heading_regex, rule.flags || 'im');
    const m = text.match(re);
    pushCheck({
      name: rule.name, kind: 'required_section', required: true,
      severity: rule.severity || 'error',
      passed: Boolean(m),
      detail: m ? { match: m[0].slice(0, 80) } : { regex: rule.heading_regex },
    });
  }
  for (const rule of (spec.forbidden_patterns || [])) {
    const re = compileRule(rule);
    const m = text.match(re);
    pushCheck({
      name: rule.name, kind: 'forbidden_pattern', required: false,
      severity: rule.severity || 'error',
      passed: !m,
      detail: m ? { match: m[0].slice(0, 80) } : null,
    });
  }

  const total = requiredTotal + warnTotal;
  const numerator = requiredPassed + 0.5 * warnPassed;
  const score = total === 0 ? 1 : Math.max(0, Math.min(1, numerator / total));
  const verdict = errors > 0 ? 'fail' : (warnings > 0 ? 'warn' : 'pass');

  return {
    spec: spec.name,
    verdict,
    score: Number(score.toFixed(4)),
    word_count: wordCount,
    counts: { errors, warnings, checks: checks.length },
    checks,
  };
}

export function loadBuiltinSpec(type) {
  const s = BUILTIN_SPECS[type];
  if (!s) throw new Error(`unknown built-in doc type: ${type}. known: ${Object.keys(BUILTIN_SPECS).join(', ')}`);
  return s;
}

export function loadSpecFromFile(filePath) {
  const raw = fs.readFileSync(filePath, 'utf-8');
  const obj = JSON.parse(raw);
  if (obj.spec !== DOCSPEC_SPEC) {
    throw new Error(`invalid docspec at ${filePath}: expected spec=${DOCSPEC_SPEC}, got ${obj.spec}`);
  }
  return obj;
}
