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

// ---------------------------------------------------------------------------
// Wave 291 — Structured validation findings.
//
// The legacy redact()/reinject() pair above is a placement transform: it
// rewrites the input so a downstream teacher API never sees raw PHI. Callers
// also need a STRUCTURED view of what was found so they can make a
// fail-closed decision (e.g., "this input contains a malformed SSN, do not
// forward to the teacher at all"). The functions below add that view without
// changing the legacy contract.
//
// Public surface added by this wave:
//   redactPhi(text, opts)  -> { redacted_text, map, findings, safe_to_send }
//   classifyPhi(text)      -> { findings, safe_to_send }   (no redaction)
//   isValidNpi(s)          -> boolean   (NPI Luhn-mod-10 check)
//   isValidSsn(s)          -> boolean   (SSA-issuance range check)
//
// Finding shape:
//   {
//     type, severity, span: [s, e], raw_hash, normalized_candidate?,
//     reason, redacted, safe_to_send
//   }
// raw_hash is sha256 of the raw matched substring so we can audit without
// logging the raw value. The top-level safe_to_send is the AND across
// findings (every finding must individually be safe_to_send=true).
// ---------------------------------------------------------------------------

const PHI_DEFAULT_TOKEN = (cls, n) => `[PHI_${cls}_${n}]`;

function sha256Hex(s) {
  return 'sha256:' + crypto.createHash('sha256').update(String(s)).digest('hex');
}

// NPI Luhn-mod-10 with the NPI-spec 80840 prefix.
// Per the NPI Final Rule, the 10th digit of a valid NPI is the Luhn check
// computed over the string "80840" + first nine digits. Returns boolean.
export function isValidNpi(s) {
  const str = String(s == null ? '' : s).trim();
  if (!/^\d{10}$/.test(str)) return false;
  const composed = '80840' + str.slice(0, 9);
  let sum = 0;
  let alt = true; // rightmost digit of composed is doubled (per NPI Final Rule)
  for (let i = composed.length - 1; i >= 0; i--) {
    let n = composed.charCodeAt(i) - 48;
    if (n < 0 || n > 9) return false;
    if (alt) {
      n *= 2;
      if (n > 9) n -= 9;
    }
    sum += n;
    alt = !alt;
  }
  const check = (10 - (sum % 10)) % 10;
  return check === (str.charCodeAt(9) - 48);
}

// SSN issuance ranges. SSA-published rules:
//   area 000, 666, and 900-999 are invalid.
//   group 00 is invalid.
//   serial 0000 is invalid.
// Accepts 9 digit run with optional separators (- . space).
export function isValidSsn(s) {
  const digits = String(s == null ? '' : s).replace(/[^\d]/g, '');
  if (digits.length !== 9) return false;
  const area = digits.slice(0, 3);
  const group = digits.slice(3, 5);
  const serial = digits.slice(5, 9);
  if (area === '000' || area === '666') return false;
  if (Number(area) >= 900) return false;
  if (group === '00') return false;
  if (serial === '0000') return false;
  return true;
}

// Internal: normalize a 9-digit run to canonical 3-2-4 form.
function normalizeSsn(digitsOnly) {
  if (digitsOnly.length !== 9) return digitsOnly;
  return `${digitsOnly.slice(0, 3)}-${digitsOnly.slice(3, 5)}-${digitsOnly.slice(5, 9)}`;
}

// Internal: validate an ISO date YYYY-MM-DD or US date M/D/YY[YY].
// Returns { ok, reason } where reason is 'impossible date' when shape parses
// but the calendar slot doesn't exist or year is out of plausible range.
function validateDate(raw) {
  const isoM = /^(\d{4})-(\d{2})-(\d{2})$/.exec(raw);
  const usM = /^(\d{1,2})\/(\d{1,2})\/(\d{2,4})$/.exec(raw);
  let y, mo, d;
  if (isoM) {
    y = Number(isoM[1]); mo = Number(isoM[2]); d = Number(isoM[3]);
  } else if (usM) {
    mo = Number(usM[1]); d = Number(usM[2]);
    let yr = Number(usM[3]);
    if (usM[3].length === 2) yr += yr < 50 ? 2000 : 1900;
    y = yr;
  } else {
    return { ok: false, reason: 'impossible date' };
  }
  const nowYear = new Date().getUTCFullYear();
  if (y < 1900 || y > nowYear + 5) return { ok: false, reason: 'impossible date' };
  if (mo < 1 || mo > 12) return { ok: false, reason: 'impossible date' };
  if (d < 1 || d > 31) return { ok: false, reason: 'impossible date' };
  // Strict day-in-month check via Date round-trip.
  const dt = new Date(Date.UTC(y, mo - 1, d));
  if (dt.getUTCFullYear() !== y || dt.getUTCMonth() !== mo - 1 || dt.getUTCDate() !== d) {
    return { ok: false, reason: 'impossible date' };
  }
  return { ok: true };
}

// Internal: a finding factory that defaults sensible flags.
function makeFinding({
  type, severity, span, raw, normalized_candidate, reason,
  redacted, safe_to_send,
}) {
  const f = {
    type,
    severity,
    span,
    raw_hash: sha256Hex(raw),
    reason: reason || '',
    redacted: !!redacted,
    safe_to_send: !!safe_to_send,
  };
  if (normalized_candidate != null) f.normalized_candidate = normalized_candidate;
  return f;
}

// Internal: scan for findings + (optionally) build a replacement plan. The
// plan is an array of { start, end, replacement } sorted in source order
// without overlap; applyPlan() walks it to build the redacted_text.
function scanFindings(text, opts = {}) {
  const src = String(text == null ? '' : text);
  const findings = [];
  // Track [start,end) ranges already claimed so detectors don't double-fire.
  const claimed = [];
  function isClaimed(s, e) {
    for (const [cs, ce] of claimed) {
      if (s < ce && e > cs) return true;
    }
    return false;
  }
  function claim(s, e) { claimed.push([s, e]); }

  // Plan entries created when redacted:true; applied later.
  const plan = [];
  // Per-class counters for token indices.
  const counters = {};
  function nextTok(cls) {
    counters[cls] = (counters[cls] || 0) + 1;
    return PHI_DEFAULT_TOKEN(cls, counters[cls]);
  }
  function pushPlan(start, end, replacement) {
    plan.push({ start, end, replacement });
  }

  // ----- (a) SSN — separated 3-2-4 (well-formed) -----
  {
    const re = /\b(\d{3})-(\d{2})-(\d{4})\b/g;
    let m;
    while ((m = re.exec(src)) !== null) {
      const s = m.index; const e = s + m[0].length;
      if (isClaimed(s, e)) continue;
      const digits = m[1] + m[2] + m[3];
      const valid = isValidSsn(digits);
      const normalized = normalizeSsn(digits);
      if (valid) {
        findings.push(makeFinding({
          type: 'ssn', severity: 'critical', span: [s, e], raw: m[0],
          normalized_candidate: normalized, reason: 'well-formed SSN',
          redacted: true, safe_to_send: true,
        }));
        pushPlan(s, e, nextTok('SSN'));
      } else {
        findings.push(makeFinding({
          type: 'ssn_malformed', severity: 'medium', span: [s, e], raw: m[0],
          normalized_candidate: normalized, reason: 'invalid SSN range',
          redacted: true, safe_to_send: false,
        }));
        pushPlan(s, e, nextTok('SSN'));
      }
      claim(s, e);
    }
  }

  // ----- (a) SSN — space-separated 3 2 4 -----
  {
    const re = /\b(\d{3}) (\d{2}) (\d{4})\b/g;
    let m;
    while ((m = re.exec(src)) !== null) {
      const s = m.index; const e = s + m[0].length;
      if (isClaimed(s, e)) continue;
      const digits = m[1] + m[2] + m[3];
      const valid = isValidSsn(digits);
      findings.push(makeFinding({
        type: 'ssn_malformed', severity: valid ? 'high' : 'medium',
        span: [s, e], raw: m[0],
        normalized_candidate: normalizeSsn(digits),
        reason: valid ? 'space-separated SSN' : 'invalid SSN range',
        redacted: true, safe_to_send: !!valid,
      }));
      pushPlan(s, e, nextTok('SSN'));
      claim(s, e);
    }
  }

  // ----- (a) SSN — dot-separated 3.2.4 -----
  {
    const re = /\b(\d{3})\.(\d{2})\.(\d{4})\b/g;
    let m;
    while ((m = re.exec(src)) !== null) {
      const s = m.index; const e = s + m[0].length;
      if (isClaimed(s, e)) continue;
      const digits = m[1] + m[2] + m[3];
      const valid = isValidSsn(digits);
      findings.push(makeFinding({
        type: 'ssn_malformed', severity: valid ? 'high' : 'medium',
        span: [s, e], raw: m[0],
        normalized_candidate: normalizeSsn(digits),
        reason: valid ? 'dot-separated SSN' : 'invalid SSN range',
        redacted: true, safe_to_send: !!valid,
      }));
      pushPlan(s, e, nextTok('SSN'));
      claim(s, e);
    }
  }

  // ----- (b) NPI — 10 digit runs validated against Luhn -----
  // Walk every standalone 10-digit run (not adjacent to letters/digits) and
  // classify Luhn-valid vs Luhn-invalid. Done BEFORE the unseparated SSN
  // scan so a 10-digit run is not also reported as a 9-digit SSN.
  {
    const re = /(?<![A-Za-z0-9])(\d{10})(?![A-Za-z0-9])/g;
    let m;
    while ((m = re.exec(src)) !== null) {
      const s = m.index; const e = s + m[1].length;
      if (isClaimed(s, e)) continue;
      // Skip if it sits inside an obvious phone shape like (555) 123-4567,
      // which won't actually look like 10 contiguous digits anyway, but
      // be defensive: require non-digit on both sides (already enforced).
      const digits = m[1];
      const npiOk = isValidNpi(digits);
      if (npiOk) {
        findings.push(makeFinding({
          type: 'npi', severity: 'high', span: [s, e], raw: digits,
          normalized_candidate: digits, reason: 'NPI Luhn-mod-10 pass',
          redacted: true, safe_to_send: true,
        }));
        pushPlan(s, e, nextTok('NPI'));
        claim(s, e);
      } else {
        // 10-digit runs that fail NPI Luhn are not auto-redacted (could be a
        // device serial or any other identifier), but they ARE flagged so the
        // caller fails closed before sending to a teacher.
        findings.push(makeFinding({
          type: 'npi_invalid', severity: 'high', span: [s, e], raw: digits,
          normalized_candidate: digits, reason: 'failed NPI Luhn check',
          redacted: false, safe_to_send: false,
        }));
        claim(s, e);
      }
    }
  }

  // ----- (a) SSN — unseparated 9-digit run -----
  {
    const re = /(?<![A-Za-z0-9])(\d{9})(?![A-Za-z0-9])/g;
    let m;
    while ((m = re.exec(src)) !== null) {
      const s = m.index; const e = s + m[1].length;
      if (isClaimed(s, e)) continue;
      // Heuristic: only flag as suspicious if SSN ranges are plausible.
      // Otherwise leave the run alone (lots of 9-digit numbers are not SSNs).
      const digits = m[1];
      // Skip if surrounded by phone-call syntax like "( " on the left or "-"
      // on the immediate right (would have been picked up by phone detector
      // upstream when wired). Here in classify we still want the finding.
      if (!isValidSsn(digits)) {
        // Still flag the obvious bad ones (000000000, 666...) as malformed.
        findings.push(makeFinding({
          type: 'ssn_malformed', severity: 'medium', span: [s, e], raw: digits,
          normalized_candidate: normalizeSsn(digits),
          reason: 'invalid SSN range',
          redacted: true, safe_to_send: false,
        }));
        pushPlan(s, e, nextTok('SSN'));
      } else {
        findings.push(makeFinding({
          type: 'ssn_malformed', severity: 'high', span: [s, e], raw: digits,
          normalized_candidate: normalizeSsn(digits),
          reason: 'unseparated 9-digit run resembling SSN',
          redacted: true, safe_to_send: true,
        }));
        pushPlan(s, e, nextTok('SSN'));
      }
      claim(s, e);
    }
  }

  // ----- (c) DOB — ISO -----
  {
    const re = /\b(\d{4}-\d{2}-\d{2})\b/g;
    let m;
    while ((m = re.exec(src)) !== null) {
      const s = m.index; const e = s + m[0].length;
      if (isClaimed(s, e)) continue;
      const v = validateDate(m[0]);
      if (v.ok) {
        findings.push(makeFinding({
          type: 'dob', severity: 'medium', span: [s, e], raw: m[0],
          normalized_candidate: m[0], reason: 'ISO date',
          redacted: true, safe_to_send: true,
        }));
        pushPlan(s, e, nextTok('DATE'));
      } else {
        findings.push(makeFinding({
          type: 'dob_malformed', severity: 'low', span: [s, e], raw: m[0],
          normalized_candidate: m[0], reason: v.reason,
          redacted: false, safe_to_send: true,
        }));
      }
      claim(s, e);
    }
  }

  // ----- (c) DOB — US M/D/YY or M/D/YYYY -----
  {
    const re = /\b(\d{1,2}\/\d{1,2}\/\d{2,4})\b/g;
    let m;
    while ((m = re.exec(src)) !== null) {
      const s = m.index; const e = s + m[0].length;
      if (isClaimed(s, e)) continue;
      const v = validateDate(m[0]);
      if (v.ok) {
        findings.push(makeFinding({
          type: 'dob', severity: 'medium', span: [s, e], raw: m[0],
          normalized_candidate: m[0], reason: 'US date',
          redacted: true, safe_to_send: true,
        }));
        pushPlan(s, e, nextTok('DATE'));
      } else {
        findings.push(makeFinding({
          type: 'dob_malformed', severity: 'low', span: [s, e], raw: m[0],
          normalized_candidate: m[0], reason: v.reason,
          redacted: false, safe_to_send: true,
        }));
      }
      claim(s, e);
    }
  }

  // ----- (d) MRN — context-labeled alphanumeric token -----
  {
    const re = /\b(MRN|MR#|MedRec)\s*[:#]?\s*([A-Z0-9-]{4,20})\b/gi;
    let m;
    while ((m = re.exec(src)) !== null) {
      const tokenStart = m.index + m[0].indexOf(m[2]);
      const tokenEnd = tokenStart + m[2].length;
      if (isClaimed(tokenStart, tokenEnd)) continue;
      findings.push(makeFinding({
        type: 'mrn', severity: 'high', span: [tokenStart, tokenEnd],
        raw: m[2], normalized_candidate: m[2],
        reason: 'context-labeled MRN', redacted: true, safe_to_send: true,
      }));
      pushPlan(tokenStart, tokenEnd, nextTok('MRN'));
      claim(tokenStart, tokenEnd);
    }
  }

  // ----- (e) Address fragments — ZIP+4 -----
  {
    const re = /\b(\d{5})-(\d{4})\b/g;
    let m;
    while ((m = re.exec(src)) !== null) {
      const s = m.index; const e = s + m[0].length;
      if (isClaimed(s, e)) continue;
      findings.push(makeFinding({
        type: 'address_fragment', severity: 'low', span: [s, e],
        raw: m[0], normalized_candidate: m[0], reason: 'ZIP+4',
        redacted: true, safe_to_send: true,
      }));
      pushPlan(s, e, nextTok('GEO'));
      claim(s, e);
    }
  }

  // ----- (f) Account numbers — context-labeled 8-16 digit run -----
  {
    const re = /\b(Acct|Account|Member)\s*[:#]?\s*(\d{8,16})\b/gi;
    let m;
    while ((m = re.exec(src)) !== null) {
      const tokenStart = m.index + m[0].indexOf(m[2]);
      const tokenEnd = tokenStart + m[2].length;
      if (isClaimed(tokenStart, tokenEnd)) continue;
      findings.push(makeFinding({
        type: 'account_no', severity: 'high', span: [tokenStart, tokenEnd],
        raw: m[2], normalized_candidate: m[2],
        reason: 'context-labeled account number',
        redacted: true, safe_to_send: true,
      }));
      pushPlan(tokenStart, tokenEnd, nextTok('ACCT'));
      claim(tokenStart, tokenEnd);
    }
  }

  // ----- Generic helpers (email + phone) folded into findings -----
  // We surface emails + phones as findings even though the legacy redact()
  // call also catches them; the structured view is what fail-closed callers
  // read. They are auto-redacted and safe_to_send.
  {
    const re = /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g;
    let m;
    while ((m = re.exec(src)) !== null) {
      const s = m.index; const e = s + m[0].length;
      if (isClaimed(s, e)) continue;
      findings.push(makeFinding({
        type: 'email', severity: 'medium', span: [s, e],
        raw: m[0], normalized_candidate: m[0].toLowerCase(),
        reason: 'email address',
        redacted: true, safe_to_send: true,
      }));
      pushPlan(s, e, nextTok('EMAIL'));
      claim(s, e);
    }
  }
  {
    // Conservative US/intl phone (require separator so we don't double-up
    // with the 9/10 digit SSN/NPI scans above).
    const re = /\b\+?1?[\s.-]?\(?\d{3}\)?[\s.-]\d{3}[\s.-]\d{4}\b/g;
    let m;
    while ((m = re.exec(src)) !== null) {
      const s = m.index; const e = s + m[0].length;
      if (isClaimed(s, e)) continue;
      findings.push(makeFinding({
        type: 'phone', severity: 'medium', span: [s, e],
        raw: m[0], normalized_candidate: m[0].replace(/[^\d+]/g, ''),
        reason: 'phone number',
        redacted: true, safe_to_send: true,
      }));
      pushPlan(s, e, nextTok('PHONE'));
      claim(s, e);
    }
  }

  // Plan sorted in source order, non-overlapping by construction (claim()).
  plan.sort((a, b) => a.start - b.start);
  // Findings sorted in source order so callers can rely on it.
  findings.sort((a, b) => a.span[0] - b.span[0] || a.span[1] - b.span[1]);

  return { findings, plan };
}

// Internal: apply a non-overlapping plan to source text, return the new text
// plus a map of placeholder -> original raw substring (parallel to legacy
// redact() map shape).
function applyPlan(src, plan) {
  if (!plan.length) return { text: src, map: {} };
  const out = [];
  const map = {};
  let cursor = 0;
  for (const { start, end, replacement } of plan) {
    if (start < cursor) continue; // safety: overlap, skip
    out.push(src.slice(cursor, start));
    out.push(replacement);
    map[replacement] = src.slice(start, end);
    cursor = end;
  }
  out.push(src.slice(cursor));
  return { text: out.join(''), map };
}

// Public: classify-only. Runs detectors WITHOUT redaction. Useful for
// teacher-bridge fail-closed decisions before deciding whether to attempt
// redaction at all.
export function classifyPhi(text) {
  const { findings } = scanFindings(text);
  const safe_to_send = findings.every((f) => f.safe_to_send);
  return { findings, safe_to_send };
}

// Public: full redact + structured findings. The redacted_text + map fields
// are the legacy redact() output renamed; findings + safe_to_send are new.
// Existing callers using the old redact() function continue to work; new
// callers should prefer redactPhi() for the richer return shape.
export function redactPhi(text, opts = {}) {
  const src = String(text == null ? '' : text);
  const { findings, plan } = scanFindings(src, opts);
  const { text: redacted_text, map } = applyPlan(src, plan);
  const safe_to_send = findings.every((f) => f.safe_to_send);
  return { redacted_text, map, findings, safe_to_send };
}
