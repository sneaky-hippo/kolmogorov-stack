// examples/claims-redactor/recipe.js
//
// W343/W344 claims-redactor — sandbox-safe recipe that mirrors the detection
// surface of src/phi-redactor.js. Single source of truth pattern (W295,
// W258-ML-4): every regex below corresponds 1:1 to a DETECTOR in
// src/phi-redactor.js. Any change to that file MUST be mirrored here, and
// tests/wave344-phi-alignment.test.js asserts the alignment.
//
// Why a mirror (not an import): kolm recipes run inside a node:vm sandbox
// (see src/verifier.js) where ECMAScript modules and `import` are forbidden.
// The recipe must be a self-contained `function generate(input, lib)` body.
//
// Output schema:
//   input:  { text: string }
//   output: {
//     redacted: string,                  // input with PHI replaced by tokens
//     map:      { [token]: original },   // reverse map for re-injection
//     classes:  string[]                 // sorted unique PHI classes hit
//   }
//
// Token format: [PHI_<CLASS>_<INDEX>] where CLASS is one of the 20 from
// src/phi-redactor.js CLASSES plus the W343 additions for bare names and
// bare US-style street addresses (gated so the smoke-test claims note
// "Sandra Pham, 415 Oak St, MRN 9988123" masks all three identifiers).
//
// Determinism: same input -> same redacted output -> same map.

function generate(input, lib) {
  var text = (typeof input === 'string')
    ? input
    : (input && input.text != null) ? String(input.text) : '';
  if (!text) return { redacted: '', map: {}, classes: [] };

  // Order matters: URL before EMAIL (URL captures @ in path), labeled
  // identifiers before bare digits (so "MRN: 12345" wins over a generic
  // OTHER match), provider IDs before phone (10-digit NPI looks phone-ish).
  var DETECTORS = [
    // URL
    { cls: 'URL',   re: /\bhttps?:\/\/[^\s<>"'`)\]]+/gi },
    // Email
    { cls: 'EMAIL', re: /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g },
    // IPv4
    { cls: 'IP',    re: /\b(?:(?:25[0-5]|2[0-4]\d|1?\d?\d)\.){3}(?:25[0-5]|2[0-4]\d|1?\d?\d)\b/g },

    // Labeled provider IDs.
    { cls: 'NPI',      re: /\b(?:NPI|National Provider Identifier)\s*[#:]?\s*(\d{10})\b/gi, cap: 1 },
    { cls: 'DEA',      re: /\b(?:DEA)\s*[#:]?\s*([A-Z]{2}\d{7})\b/g,  cap: 1 },
    { cls: 'MEDICAID', re: /\b(?:Medicaid(?:\s+(?:ID|#))?)\s*[#:]?\s*([A-Z0-9-]{6,15})\b/gi, cap: 1 },

    // Labeled identifiers.
    { cls: 'MRN',  re: /\b(?:MRN|Medical Record(?:\s+#)?|Patient ID)\s*[#:]?\s*([A-Z0-9-]{4,20})\b/gi, cap: 1 },
    { cls: 'HPID', re: /\b(?:Member ID|Subscriber ID|Health Plan ID|Policy(?:\s+#)?)\s*[#:]?\s*([A-Z0-9-]{4,20})\b/gi, cap: 1 },
    { cls: 'ACCT', re: /\b(?:Account(?:\s+#)?|Acct(?:\s+#)?|Claim(?:\s+#)?|Claim Number)\s*[#:]?\s*([A-Z0-9-]{4,20})\b/gi, cap: 1 },
    { cls: 'LIC',  re: /\b(?:License(?:\s+#)?|Certificate(?:\s+#)?|Lic(?:\s+#)?)\s*[#:]?\s*([A-Z0-9-]{4,20})\b/gi, cap: 1 },
    { cls: 'VEH',  re: /\b(?:Plate|License Plate|VIN)\s*[#:]?\s*([A-Z0-9-]{5,20})\b/gi, cap: 1 },
    { cls: 'DEV',  re: /\b(?:Device(?:\s+#)?|Serial(?:\s+#)?|S\/N)\s*[#:]?\s*([A-Z0-9-]{4,20})\b/gi, cap: 1 },
    { cls: 'FAX',  re: /\b(?:Fax(?:\s+#)?)\s*[#:]?\s*([+()\d][\d().\s-]{8,20}\d)\b/gi, cap: 1 },

    // SSN.
    { cls: 'SSN',  re: /\b\d{3}-\d{2}-\d{4}\b/g },
    { cls: 'SSN',  re: /\b(?:SSN|Social Security(?:\s+#)?)\s*[#:]?\s*(\d{9}|\d{3}-?\d{2}-?\d{4})\b/gi, cap: 1 },

    // Phone (labeled, then US/intl shape).
    { cls: 'PHONE', re: /\b(?:Phone|Tel|Cell|Mobile)\s*[#:]?\s*([+()\d][\d().\s-]{8,20}\d)\b/gi, cap: 1 },
    { cls: 'PHONE', re: /\b\+?1?[\s.-]?\(?\d{3}\)?[\s.-]\d{3}[\s.-]\d{4}\b/g },

    // Dates. Labeled-date capture must contain at least one digit so phrases
    // like "Discharge home" (no date payload) don't shoplift "home" as a DATE
    // hit. The character class still allows month names ("Jan 3, 2024") and
    // ISO/slash forms; the `\d` anchor enforces date-ness.
    { cls: 'DATE', re: /\b(?:DOB|Date of Birth|Birthdate|Admission|Discharge|Death|Visit Date|DOS|Date of Service)\s*[#:]?\s*([A-Za-z0-9,./-]*\d[A-Za-z0-9,./-]{2,29})\b/gi, cap: 1 },
    { cls: 'DATE', re: /\b\d{1,2}\/\d{1,2}\/\d{2,4}\b/g },
    { cls: 'DATE', re: /\b\d{4}-\d{2}-\d{2}\b/g },
    { cls: 'DATE', re: /\b(?:January|February|March|April|May|June|July|August|September|October|November|December)\s+\d{1,2},?\s+\d{4}\b/gi },

    // Geo — ZIP+4 / ZIP / labeled address.
    { cls: 'GEO',  re: /\b\d{5}(?:-\d{4})?\b/g },
    { cls: 'GEO',  re: /\b(?:Address|Street|Addr)\s*[#:]?\s*([\d]+\s+[A-Za-z][A-Za-z\s.]+(?:Street|St|Avenue|Ave|Road|Rd|Boulevard|Blvd|Lane|Ln|Drive|Dr|Court|Ct|Place|Pl|Way))\b/gi, cap: 1 },

    // W343 — bare US street addresses (no "Address:" label). Matches a
    // building number plus street name plus standard suffix. Restricted to
    // titlecase street names so the bare-form doesn't shoplift unrelated
    // numbers from prose. Captures the full address span.
    { cls: 'GEO',  re: /\b(\d{1,5}\s+(?:[A-Z][a-z]+\s+){1,4}(?:Street|St|Avenue|Ave|Road|Rd|Boulevard|Blvd|Lane|Ln|Drive|Dr|Court|Ct|Place|Pl|Way|Highway|Hwy|Parkway|Pkwy|Terrace|Ter|Circle|Cir))\b/g, cap: 1 },

    // Names — labeled.
    { cls: 'NAME', re: /\b(?:Patient(?:\s+Name)?|Name|Member|Insured|Provider|Physician|Dr|Doctor|Beneficiary|Subscriber|Guarantor)\s*[#:]?\s*([A-Z][a-z]+(?:\s+[A-Z][a-z'-]+){0,3})\b/g, cap: 1 },
    { cls: 'NAME', re: /\b(?:Mr|Mrs|Ms|Miss|Dr|Prof)\.?\s+([A-Z][a-z]+(?:\s+[A-Z][a-z'-]+){0,3})\b/g, cap: 1 },

    // W343 — bare full names: First Last with both titlecased. Requires
    // surname >= 3 chars to avoid false hits on "I Met" / "He Said". Single
    // tokens (e.g., bare "Maria") are NOT matched — that behavior is locked
    // by tests/wave144-phi-redactor.test.js line 145-148.
    { cls: 'NAME', re: /\b([A-Z][a-z]{1,}(?:[-'][A-Z][a-z]+)?\s+[A-Z][a-z]{2,}(?:[-'][A-Z][a-z]+)?)\b/g, cap: 1 },
  ];

  var TOKEN_RE = /\[PHI_([A-Z]+)_(\d+)\]/g;
  var map = {};
  var reverse = {};
  var counters = {};

  function tokenFor(cls, original) {
    if (Object.prototype.hasOwnProperty.call(reverse, original)) return reverse[original];
    counters[cls] = (counters[cls] || 0) + 1;
    var tok = '[PHI_' + cls + '_' + counters[cls] + ']';
    map[tok] = original;
    reverse[original] = tok;
    return tok;
  }

  // Phase 1: protect existing tokens with sentinels so they aren't re-matched.
  var sentinels = [];
  var scratch = text.replace(TOKEN_RE, function (m) {
    var i = sentinels.length;
    sentinels.push(m);
    return ' TOK' + i + ' ';
  });

  // Phase 2: tenant-supplied identifier lists from lib.params.
  var supplied = [];
  var params = (lib && lib.params) || {};
  var pNames = Array.isArray(params.names) ? params.names : [];
  var pAddrs = Array.isArray(params.addresses) ? params.addresses : [];
  var pIds = (params.ids && typeof params.ids === 'object') ? params.ids : {};
  for (var i1 = 0; i1 < pNames.length; i1++) supplied.push({ cls: 'NAME', value: pNames[i1] });
  for (var i2 = 0; i2 < pAddrs.length; i2++) supplied.push({ cls: 'GEO', value: pAddrs[i2] });
  var idKeys = Object.keys(pIds);
  for (var i3 = 0; i3 < idKeys.length; i3++) {
    var vals = pIds[idKeys[i3]] || [];
    for (var i4 = 0; i4 < vals.length; i4++) supplied.push({ cls: idKeys[i3], value: vals[i4] });
  }
  supplied.sort(function (a, b) { return String(b.value).length - String(a.value).length; });
  for (var i5 = 0; i5 < supplied.length; i5++) {
    var s = supplied[i5];
    if (!s.value) continue;
    var esc = String(s.value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    var re = new RegExp(esc, 'g');
    (function (cls, value) {
      scratch = scratch.replace(re, function () { return tokenFor(cls, value); });
    })(s.cls, s.value);
  }

  // Phase 3: run the regex detectors in declaration order.
  for (var d = 0; d < DETECTORS.length; d++) {
    var det = DETECTORS[d];
    var cls = det.cls;
    var dre = new RegExp(det.re.source, det.re.flags);
    (function (cls2, dre2, cap2) {
      scratch = scratch.replace(dre2, function (full) {
        var args = [];
        for (var a = 1; a < arguments.length; a++) args.push(arguments[a]);
        var captured = cap2 != null ? args[cap2 - 1] : full;
        var original = String(captured == null ? full : captured);
        if (!original) return full;
        // Guard against re-matching inside a sentinel slot.
        if (/^TOK\d+$/.test(original)) return full;
        var tok = tokenFor(cls2, original);
        if (cap2 != null && captured) {
          var idx = full.indexOf(captured);
          return full.slice(0, idx) + tok + full.slice(idx + captured.length);
        }
        return tok;
      });
    })(cls, dre, det.cap);
  }

  // Phase 4: swap sentinels back.
  scratch = scratch.replace(/ TOK(\d+) /g, function (_m, i) { return sentinels[Number(i)]; });

  // Build sorted unique class list for the output (deterministic).
  var seen = {};
  var classes = [];
  var keys = Object.keys(map);
  for (var k = 0; k < keys.length; k++) {
    var mm = /^\[PHI_([A-Z]+)_/.exec(keys[k]);
    if (mm && !seen[mm[1]]) { seen[mm[1]] = true; classes.push(mm[1]); }
  }
  classes.sort();

  return { redacted: scratch, map: map, classes: classes };
}
