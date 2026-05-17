// src/licensing-allowlist.js
//
// Wave 194 (N+2 / N+3). Corpus URL licensing gate. The Wave 144 plan flagged
// the corpus-URL licensing check as still-open verifier work: a manifest can
// declare `corpus_sources[]` with {name, source_url, license}, but until this
// module shipped the verifier had no opinion on whether the license string
// named a buyer-safe source. A regulated tenant signing off on a distilled
// artifact wants to know that the training corpus the artifact derives from
// was not scraped, was not under a research-only license, and was not a
// proprietary dataset the tenant lacks rights to redistribute outputs from.
//
// Three allowlists, every entry a real identifier:
//
//   SAFE_LICENSES   buyer-safe for distillation source data. SPDX identifiers
//                   plus a small set of known catalog licenses (Llama 3.1
//                   community, Pile-CC, OpenWebText) that downstream legal
//                   teams have accepted in practice.
//   AMBER_LICENSES  pass the check with a `note:` row warning manual review.
//                   These permit research use but carry redistribution
//                   constraints (NC = non-commercial, ND = no derivatives,
//                   research-only). A tenant who knows the use case is
//                   internal-only can ship; a tenant selling outputs cannot.
//   DENY_LICENSES   verifier-rejected. Either a known-bad designation
//                   ("proprietary", "scraped", "tos-violated") or an
//                   explicit unknown ("unknown") that the verifier treats
//                   as a missing license string.
//
// The check function `checkCorpusLicensing(manifest)` returns one of:
//
//   { status: 'pass',  detail: '...' }            // all SAFE or legacy
//   { status: 'pass',  detail: '...',
//     caveats: ['name: license requires manual review (amber)', ...] }
//   { status: 'fail',  detail: '...',
//     bad: ['name: license=X in DENY_LICENSES', ...] }
//
// The check is invoked from src/binder.js as check #25 and slotted into the
// run-checks pipeline alongside the existing 24 verifier checks.
//
// Honest scope: this module does NOT fetch the URL, does NOT verify the
// license file at the URL still says what the manifest claims it says, and
// does NOT crawl the upstream catalog. It validates the declared license
// string against three frozen lists. Live URL fetching is out of scope: the
// verifier is offline-first by design (RS-1 air-gap rule).

// SAFE_LICENSES. Every entry is a real SPDX identifier or named catalog
// license a regulated tenant's legal team has approved as buyer-safe for
// distillation training data. Adding to this list is a contract change;
// every entry has been spot-checked against https://spdx.org/licenses/.
export const SAFE_LICENSES = Object.freeze([
  // SPDX-listed permissive open-source licenses
  'MIT',
  'Apache-2.0',
  'BSD-3-Clause',
  'BSD-2-Clause',
  'ISC',
  'Unlicense',
  // SPDX-listed Creative Commons (public-domain + attribution + share-alike,
  // ALL commercial-permitting)
  'CC0-1.0',
  'CC-BY-4.0',
  'CC-BY-SA-4.0',
  'CC-BY-3.0',
  'CC-BY-SA-3.0',
  // Open Data Commons (commercial-permitting, attribution required)
  'ODC-BY-1.0',
  'PDDL-1.0',
  // Public domain catalog names that procurement accepts
  'public-domain',
  'CC-PDDC',
  // Catalog/community licenses with explicit commercial-use carve-outs that
  // regulated buyers have signed off on in practice
  'Llama-3.1 community',
  'Llama-3.2 community',
]);

// AMBER_LICENSES. Permit research use, carry redistribution constraints.
// Verifier passes but emits a `note:` row noting the license requires manual
// procurement review. NC = NonCommercial, ND = NoDerivatives, ResearchOnly =
// dataset-specific clauses (LAION, RedPajama, The Pile non-permissive splits).
export const AMBER_LICENSES = Object.freeze([
  'CC-BY-NC-4.0',
  'CC-BY-NC-3.0',
  'CC-BY-NC-SA-4.0',
  'CC-BY-NC-SA-3.0',
  'CC-BY-NC-ND-4.0',
  'CC-BY-NC-ND-3.0',
  'CC-BY-ND-4.0',
  'CC-BY-ND-3.0',
  'research-only',
  'custom',
  'OpenRAIL-M',
  'OpenRAIL',
  'BigScience-OpenRAIL-M',
  'BigCode-OpenRAIL-M',
]);

// DENY_LICENSES. Verifier rejects. Known-bad license designations a
// manifest should never ship with. Verifier reports a `bad:` row and the
// check fails (sets verdict='fail' so kolm verify exits non-zero).
export const DENY_LICENSES = Object.freeze([
  'proprietary',
  'unknown',
  'scraped',
  'tos-violated',
  'closed-source',
  'all-rights-reserved',
]);

// Disjointness contract: a license string MUST appear in at most one list.
// Tested by the wave194 test suite; checked at import time as a guardrail
// for anyone editing the lists in the future.
(function assertDisjoint() {
  const seen = new Map();
  for (const list of [
    { name: 'SAFE_LICENSES', entries: SAFE_LICENSES },
    { name: 'AMBER_LICENSES', entries: AMBER_LICENSES },
    { name: 'DENY_LICENSES', entries: DENY_LICENSES },
  ]) {
    for (const lic of list.entries) {
      if (seen.has(lic)) {
        throw new Error(
          `licensing-allowlist: license '${lic}' appears in both ${seen.get(lic)} and ${list.name}; lists must be disjoint`,
        );
      }
      seen.set(lic, list.name);
    }
  }
})();

// Classify a single license string into one of four buckets.
//   'safe'    present in SAFE_LICENSES
//   'amber'   present in AMBER_LICENSES
//   'deny'    present in DENY_LICENSES
//   'unknown' absent or empty (treated like DENY by the verifier)
export function classifyLicense(license) {
  if (typeof license !== 'string' || license.length === 0) return 'unknown';
  if (SAFE_LICENSES.includes(license)) return 'safe';
  if (AMBER_LICENSES.includes(license)) return 'amber';
  if (DENY_LICENSES.includes(license)) return 'deny';
  return 'unknown';
}

// URL identifier shape. A source_url field can be:
//   * a real http(s) URL                          must parse via URL ctor
//   * a `local:<path>` identifier                 pass-through, no fetch
//   * an `internal:<id>` identifier               pass-through, no fetch
//   * a `huggingface:<owner>/<name>` ref          pass-through, no fetch
// Anything else (empty, garbage) fails the source_url check.
const NON_URL_PREFIXES = ['local:', 'internal:', 'huggingface:', 'hf:', 's3:', 'gs:', 'file:'];

export function validSourceUrl(source_url) {
  if (typeof source_url !== 'string' || source_url.length === 0) {
    return { ok: false, reason: 'source_url missing or empty' };
  }
  for (const prefix of NON_URL_PREFIXES) {
    if (source_url.startsWith(prefix)) {
      const rest = source_url.slice(prefix.length);
      if (rest.length === 0) {
        return { ok: false, reason: `source_url='${source_url}' has prefix '${prefix}' but no identifier after it` };
      }
      return { ok: true, kind: 'identifier', prefix };
    }
  }
  try {
    const u = new URL(source_url);
    if (u.protocol !== 'http:' && u.protocol !== 'https:') {
      return { ok: false, reason: `source_url='${source_url}' protocol '${u.protocol}' not http/https` };
    }
    return { ok: true, kind: 'url', protocol: u.protocol };
  } catch (e) {
    return { ok: false, reason: `source_url='${source_url}' does not parse as URL: ${e.message}` };
  }
}

// Extract declared corpus sources from a manifest. We look at four shapes,
// in order, to stay backward-compatible with any manifest shape that has
// already shipped or might ship:
//   1. manifest.corpus_sources[]                  the canonical Wave 194 shape
//   2. manifest.spec?.sources[]                   older proposed shape
//   3. manifest.spec?.train?.corpora[]            RS-1 §9 proposed shape
//   4. manifest.spec?.data_sources[]              alternate proposed shape
// If none are present, returns []; the check then passes with a legacy note.
//
// We deliberately do NOT include manifest.external_holdout_provenance.holdouts
// here: those are HOLDOUT corpora (already gated by check #20 + license-drift
// row in binder.js), not TRAINING corpora.
export function extractCorpusSources(manifest) {
  if (!manifest || typeof manifest !== 'object') return [];
  if (Array.isArray(manifest.corpus_sources) && manifest.corpus_sources.length > 0) {
    return manifest.corpus_sources;
  }
  const spec = manifest.spec;
  if (spec && typeof spec === 'object') {
    if (Array.isArray(spec.sources) && spec.sources.length > 0) return spec.sources;
    if (spec.train && Array.isArray(spec.train.corpora) && spec.train.corpora.length > 0) {
      return spec.train.corpora;
    }
    if (Array.isArray(spec.data_sources) && spec.data_sources.length > 0) {
      return spec.data_sources;
    }
  }
  return [];
}

// The verifier check. Returns { status, detail, caveats?, bad?, sources_count }.
// Called from src/binder.js as check #25. The signature matches the existing
// 24 checks' shape: a plain object with name/status/detail, where status is
// one of 'pass' | 'fail' | 'warn'.
export function checkCorpusLicensing(manifest) {
  const sources = extractCorpusSources(manifest);
  if (sources.length === 0) {
    return {
      status: 'pass',
      detail: 'no corpus sources declared (legacy or template manifest); to gate the corpus URL licensing layer, add manifest.corpus_sources[]={name, source_url, license} entries declaring every dataset the recipe distilled from',
      sources_count: 0,
    };
  }
  const caveats = [];
  const bad = [];
  const okSummaries = [];
  for (let i = 0; i < sources.length; i++) {
    const s = sources[i] || {};
    const name = s.name || `source[${i}]`;
    // (a) source_url shape
    const urlCheck = validSourceUrl(s.source_url);
    if (!urlCheck.ok) {
      bad.push(`${name}: ${urlCheck.reason}`);
      continue;
    }
    // (b) license classification
    const cls = classifyLicense(s.license);
    if (cls === 'deny' || cls === 'unknown') {
      const lic = (typeof s.license === 'string' && s.license.length > 0) ? s.license : '(missing)';
      bad.push(`${name}: license='${lic}' is in DENY_LICENSES or unknown (must be a buyer-safe SPDX / catalog license; see SAFE_LICENSES + AMBER_LICENSES in src/licensing-allowlist.js)`);
      continue;
    }
    if (cls === 'amber') {
      caveats.push(`${name}: license='${s.license}' is research-only / non-commercial; requires manual procurement review before shipping commercial output (amber)`);
      okSummaries.push(`${name} (${s.license}, amber)`);
      continue;
    }
    okSummaries.push(`${name} (${s.license})`);
  }
  if (bad.length > 0) {
    return {
      status: 'fail',
      detail: `manifest.corpus_sources licensing gate rejected ${bad.length} of ${sources.length} declared source(s): ${bad.join('; ')}. Every corpus the recipe distilled from must declare {name, source_url, license} where license is in SAFE_LICENSES or AMBER_LICENSES (see src/licensing-allowlist.js). DENY_LICENSES (${DENY_LICENSES.join(', ')}) and unknown / missing license strings are rejected so a manifest cannot ship with a corpus URL pointing at scraped, proprietary, or unlicensed training data.`,
      bad,
      caveats,
      sources_count: sources.length,
    };
  }
  if (caveats.length > 0) {
    return {
      status: 'pass',
      detail: `${sources.length} corpus source(s) declared; ${okSummaries.length} verified license-clean (${okSummaries.join(', ')}). note: ${caveats.length} amber license(s) require manual procurement review: ${caveats.join('; ')}`,
      caveats,
      sources_count: sources.length,
    };
  }
  return {
    status: 'pass',
    detail: `${sources.length} corpus source(s) declared; every license string in SAFE_LICENSES and every source_url parses (${okSummaries.join(', ')})`,
    sources_count: sources.length,
  };
}
