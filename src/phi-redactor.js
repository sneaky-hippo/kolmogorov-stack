// src/phi-redactor.js
//
// Wave Q+3a — PHI/PII redactor + reinjector.
//
// Pure-JS regex-based detector for the 18 HIPAA Safe Harbor identifiers
// (45 CFR 164.514(b)(2)) plus three kolm extensions for healthcare-provider
// identifiers (NPI, DEA, state Medicaid IDs). The motivating use case is the
// "Opus-in-the-middle" pattern (kolm distill against a frontier teacher API
// with PHI in the training corpus): wrap the teacher call so raw PHI never
// leaves the tenant's trust boundary, then re-inject the originals after the
// teacher response so the resulting training pair preserves fidelity.
//
// CONTRACT
//   redact(input, opts?) -> { redacted, map }
//   reinject(text, map)  -> string
//   For any string x:    reinject(redact(x).redacted, redact(x).map) === x
//   For any string x:    redact(redact(x).redacted).redacted === redact(x).redacted
//   (idempotency — re-redacting an already-redacted string is a no-op on tokens)
//
// TOKEN FORMAT
//   [PHI_<CLASS>_<INDEX>] where CLASS is one of the constants in CLASSES.
//   INDEX is 1-based per-class within a single redact() call. Same identifier
//   occurring twice in the same input gets the same token so structure is
//   preserved (e.g., "John told John" -> "[PHI_NAME_1] told [PHI_NAME_1]").
//
// NON-GOALS
//   - No ML/NER. Names + addresses are best-effort regex + the names/addresses
//     opts.lists. For richer detection wrap this module with a downstream NER.
//   - Not a sufficient PHI control. HIPAA Expert Determination per 164.514(b)(1)
//     is the deeper control; this module is the "necessary" half of the
//     Safe Harbor pathway plus a token boundary against API leakage.
//   - No semantic-context re-identification protection (rare demographic
//     combinations can still re-identify). Callers must do their own review.

import crypto from 'node:crypto';

// HIPAA Safe Harbor (18) + kolm provider extensions (3).
export const CLASSES = Object.freeze([
  'NAME', 'GEO', 'DATE', 'PHONE', 'FAX', 'EMAIL', 'SSN', 'MRN',
  'HPID', 'ACCT', 'LIC', 'VEH', 'DEV', 'URL', 'IP', 'BIO', 'OTHER',
  'NPI', 'DEA', 'MEDICAID',
]);

// Detector ordering matters: URL before EMAIL (URL captures the @ in path),
// EMAIL before PHONE (email local-part can look phone-ish), labeled forms
// before bare digits (so "MRN: 12345" wins over "[PHI_OTHER_1]: 12345").
const DETECTORS = [
  // 14. URL
  { class: 'URL',   re: /\bhttps?:\/\/[^\s<>"'`)\]]+/gi },
  // 6. Email
  { class: 'EMAIL', re: /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g },
  // 15. IP (v4)
  { class: 'IP',    re: /\b(?:(?:25[0-5]|2[0-4]\d|1?\d?\d)\.){3}(?:25[0-5]|2[0-4]\d|1?\d?\d)\b/g },

  // Labeled provider IDs (run before the generic 10-digit phone path).
  // 19. NPI — 10 digits; labeled "NPI" or "NPI #" to avoid false positives on phones.
  { class: 'NPI', re: /\b(?:NPI|National Provider Identifier)\s*[#:]?\s*(\d{10})\b/gi, capture: 1 },
  // 20. DEA — letter, letter, 7 digits.
  { class: 'DEA', re: /\b(?:DEA)\s*[#:]?\s*([A-Z]{2}\d{7})\b/g,  capture: 1 },
  // 21. Medicaid — provider IDs vary by state; labeled "Medicaid ID:".
  { class: 'MEDICAID', re: /\b(?:Medicaid(?:\s+(?:ID|#))?)\s*[#:]?\s*([A-Z0-9-]{6,15})\b/gi, capture: 1 },

  // Labeled identifiers (always require a label to avoid generic-number false hits).
  // 8. MRN — medical record number.
  { class: 'MRN',  re: /\b(?:MRN|Medical Record(?:\s+#)?|Patient ID)\s*[#:]?\s*([A-Z0-9-]{4,20})\b/gi, capture: 1 },
  // 9. Health plan ID.
  { class: 'HPID', re: /\b(?:Member ID|Subscriber ID|Health Plan ID|Policy(?:\s+#)?)\s*[#:]?\s*([A-Z0-9-]{4,20})\b/gi, capture: 1 },
  // 10. Account numbers.
  { class: 'ACCT', re: /\b(?:Account(?:\s+#)?|Acct(?:\s+#)?)\s*[#:]?\s*([A-Z0-9-]{4,20})\b/gi, capture: 1 },
  // 11. Certificate/license numbers.
  { class: 'LIC',  re: /\b(?:License(?:\s+#)?|Certificate(?:\s+#)?|Lic(?:\s+#)?)\s*[#:]?\s*([A-Z0-9-]{4,20})\b/gi, capture: 1 },
  // 12. Vehicle (license plate).
  { class: 'VEH',  re: /\b(?:Plate|License Plate|VIN)\s*[#:]?\s*([A-Z0-9-]{5,20})\b/gi, capture: 1 },
  // 13. Device identifier.
  { class: 'DEV',  re: /\b(?:Device(?:\s+#)?|Serial(?:\s+#)?|S\/N)\s*[#:]?\s*([A-Z0-9-]{4,20})\b/gi, capture: 1 },
  // 5. Fax (labeled).
  { class: 'FAX',  re: /\b(?:Fax(?:\s+#)?)\s*[#:]?\s*([+()\d][\d().\s-]{8,20}\d)\b/gi, capture: 1 },

  // 7. SSN — 3-2-4 with separators OR 9 digits with a label.
  { class: 'SSN',  re: /\b\d{3}-\d{2}-\d{4}\b/g },
  { class: 'SSN',  re: /\b(?:SSN|Social Security(?:\s+#)?)\s*[#:]?\s*(\d{9}|\d{3}-?\d{2}-?\d{4})\b/gi, capture: 1 },

  // 4. Phone — labeled or US/international shapes.
  { class: 'PHONE', re: /\b(?:Phone|Tel|Cell|Mobile)\s*[#:]?\s*([+()\d][\d().\s-]{8,20}\d)\b/gi, capture: 1 },
  { class: 'PHONE', re: /\b\+?1?[\s.-]?\(?\d{3}\)?[\s.-]\d{3}[\s.-]\d{4}\b/g },

  // 3. Dates — strip year-precision identifiers (DOB, admission, etc.). Match
  // common US/ISO/long forms. (Year-only is technically Safe Harbor-OK, but
  // we still redact when it's clearly a DOB context — see opts.preserveYears.)
  { class: 'DATE', re: /\b(?:DOB|Date of Birth|Birthdate|Admission|Discharge|Death|Visit Date)\s*[#:]?\s*([A-Za-z0-9,./-]{4,30})\b/gi, capture: 1 },
  { class: 'DATE', re: /\b\d{1,2}\/\d{1,2}\/\d{2,4}\b/g },
  { class: 'DATE', re: /\b\d{4}-\d{2}-\d{2}\b/g },
  { class: 'DATE', re: /\b(?:January|February|March|April|May|June|July|August|September|October|November|December)\s+\d{1,2},?\s+\d{4}\b/gi },

  // 2. Geographic — ZIP+4 / ZIP / labeled address.
  { class: 'GEO',  re: /\b\d{5}(?:-\d{4})?\b/g },
  { class: 'GEO',  re: /\b(?:Address|Street|Addr)\s*[#:]?\s*([\d]+\s+[A-Za-z][A-Za-z\s.]+(?:Street|St|Avenue|Ave|Road|Rd|Boulevard|Blvd|Lane|Ln|Drive|Dr|Court|Ct|Place|Pl|Way))\b/gi, capture: 1 },

  // 1. Names — labeled (Name:, Patient:, etc.) or honorific prefix.
  { class: 'NAME', re: /\b(?:Patient(?:\s+Name)?|Name|Member|Insured|Provider|Physician|Dr|Doctor)\s*[#:]?\s*([A-Z][a-z]+(?:\s+[A-Z][a-z'-]+){0,3})\b/g, capture: 1 },
  { class: 'NAME', re: /\b(?:Mr|Mrs|Ms|Miss|Dr|Prof)\.?\s+([A-Z][a-z]+(?:\s+[A-Z][a-z'-]+){0,3})\b/g, capture: 1 },
];

// Token format is [PHI_CLASS_N]. We anchor both ends with \[ / \] so the
// pattern never bleeds into surrounding chars (important for reinjection).
const TOKEN_RE = /\[PHI_([A-Z]+)_(\d+)\]/g;

export function tokenPattern() {
  return new RegExp(TOKEN_RE.source, 'g');
}

// Public: extract every token mentioned in a string. Useful for diff / replay.
export function findTokens(s) {
  const out = [];
  const re = tokenPattern();
  let m;
  while ((m = re.exec(String(s))) !== null) {
    out.push({ token: m[0], class: m[1], index: Number(m[2]) });
  }
  return out;
}

// Public: redact the input. Returns { redacted, map }.
//   redacted: input with every detected identifier replaced by a token.
//   map:      { '[PHI_FOO_1]': 'original value', ... } — every reverse lookup
//             the caller needs to reinject after the teacher call.
//
// Options:
//   names:    string[]   extra tenant-supplied names to redact
//   addresses: string[]  extra tenant-supplied addresses
//   ids:      Record<string, string[]>  extra IDs keyed by CLASS
//             e.g., { MRN: ['ABC123'], ACCT: ['9988'] }
//   classes:  string[]   restrict to these CLASSES (others left alone)
//   skipTokens: boolean  treat existing tokens as opaque (default true)
export function redact(input, opts = {}) {
  const text = String(input == null ? '' : input);
  if (!text) return { redacted: '', map: {} };

  const map = {};
  const reverse = {};            // original -> token, for de-dupe
  const counters = {};           // class -> next index
  const skipClasses = new Set(opts.classes || CLASSES);
  const skipTokens = opts.skipTokens !== false;

  function tokenFor(cls, original) {
    if (reverse[original]) return reverse[original];
    counters[cls] = (counters[cls] || 0) + 1;
    const tok = `[PHI_${cls}_${counters[cls]}]`;
    map[tok] = original;
    reverse[original] = tok;
    return tok;
  }

  // Phase 1: protect existing tokens so they aren't re-matched as OTHER.
  // We replace each [PHI_*_*] occurrence with a sentinel that no detector
  // can match, then swap them back as the final step.
  const sentinels = [];
  let scratch = text;
  if (skipTokens) {
    scratch = scratch.replace(TOKEN_RE, (m) => {
      const i = sentinels.length;
      sentinels.push(m);
      return ` TOK${i} `;
    });
  }

  // Phase 2: tenant-supplied identifier lists (run first so they win over the
  // generic detectors). Length-descending so longer matches take precedence
  // (e.g., "John Smith" before "John").
  const supplied = [];
  for (const n of opts.names || []) supplied.push({ class: 'NAME', value: n });
  for (const a of opts.addresses || []) supplied.push({ class: 'GEO', value: a });
  for (const [cls, vals] of Object.entries(opts.ids || {})) {
    for (const v of vals || []) supplied.push({ class: cls, value: v });
  }
  supplied.sort((a, b) => b.value.length - a.value.length);
  for (const { class: cls, value } of supplied) {
    if (!skipClasses.has(cls)) continue;
    if (!value) continue;
    const re = new RegExp(escapeRegExp(value), 'g');
    scratch = scratch.replace(re, () => tokenFor(cls, value));
  }

  // Phase 3: run the regex detectors in declaration order.
  for (const det of DETECTORS) {
    if (!skipClasses.has(det.class)) continue;
    const cls = det.class;
    const re = new RegExp(det.re.source, det.re.flags);
    scratch = scratch.replace(re, (full, ...rest) => {
      const captured = det.capture != null ? rest[det.capture - 1] : full;
      const original = String(captured == null ? full : captured);
      if (!original) return full;
      // Never re-token a substring that's already inside a sentinel.
      if (/[ ]/.test(original)) return full;
      const tok = tokenFor(cls, original);
      // If we used a capture group, only replace the captured slice within
      // the match so labels like "MRN:" are preserved.
      if (det.capture != null && captured) {
        const idx = full.indexOf(captured);
        return full.slice(0, idx) + tok + full.slice(idx + captured.length);
      }
      return tok;
    });
  }

  // Phase 4: swap sentinels back.
  if (skipTokens) {
    scratch = scratch.replace(/ TOK(\d+) /g, (_m, i) => sentinels[Number(i)]);
  }

  return { redacted: scratch, map };
}

// Public: reinject the original values into a (presumably teacher-returned)
// string. Unknown tokens are left as-is (so callers see when the teacher
// dropped or paraphrased a placeholder).
export function reinject(text, map) {
  if (text == null) return '';
  const out = String(text).replace(TOKEN_RE, (m) => {
    return Object.hasOwn(map || {}, m) ? map[m] : m;
  });
  return out;
}

// Public: build a deterministic hash of a redaction map for inclusion in
// the receipt chain. Sorted by token so reordering doesn't change the hash.
export function mapHash(map) {
  const keys = Object.keys(map || {}).sort();
  const lines = keys.map((k) => `${k}\t${map[k]}`).join('\n');
  return 'sha256:' + crypto.createHash('sha256').update(lines).digest('hex');
}

// Public: assert that a teacher's response preserved every token from the
// original redacted input. Returns { ok, missing, extra } so callers can
// decide whether to fall back to a per-field call pattern. Used by the
// distill pipeline's "canary" step (Doc 7 §3.8).
export function verifyTokenPreservation(redactedInput, teacherResponse) {
  const inTokens = new Set(findTokens(redactedInput).map(t => t.token));
  const outTokens = new Set(findTokens(teacherResponse).map(t => t.token));
  const missing = [...inTokens].filter(t => !outTokens.has(t));
  const extra = [...outTokens].filter(t => !inTokens.has(t));
  return { ok: missing.length === 0 && extra.length === 0, missing, extra };
}

function escapeRegExp(s) {
  return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
