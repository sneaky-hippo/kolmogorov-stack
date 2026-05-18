// W263 — kolm.ai marketplace catalog.
//
// Single source of truth for the public marketplace surface at /marketplace.
// Every artifact entry MUST point to a real .kolm file on disk under
// public/registry-pack/ or examples/. K-scores and sha256 hashes are read
// from the existing public/registry-pack/manifest.json so the marketplace
// listing and the registry-pack stay in lockstep. If a backing file is
// missing at process startup, the entry is dropped from the catalog and
// `verified: false` is recorded so the UI cannot show a green badge for an
// artifact whose bytes are gone.
//
// The catalog manifest's `signature` field is a deterministic sha256 of the
// canonical JSON (sorted keys, signature/signed_at/signature_algo stripped
// before hashing). This is an anchor, not an ed25519 signature; the
// signature_algo string is "sha256-anchor" so a future wave can swap it for
// real ed25519 without breaking callers. Verifiers should recompute the
// canonical hash and compare.

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT = path.resolve(__dirname, '..');

// Roots we will look in for backing .kolm files. First hit wins.
const ARTIFACT_ROOTS = [
  path.join(ROOT, 'examples'),
  path.join(ROOT, 'public', 'registry-pack'),
];

// Categories the UI surfaces as filter chips. Each artifact picks one.
export const MARKETPLACE_CATEGORIES = Object.freeze([
  'compliance',
  'data extraction',
  'classification',
  'dev tooling',
  'edge',
]);

// Compliance badges that may appear on a card. Only set on entries where
// the underlying artifact actually supports the claim (PHI redactor =>
// HIPAA + BAA; legal extractor => GDPR-friendly only because it processes
// no PII by design; everything else gets Permissive). "Verified" is a
// separate axis tracked by `verified: true` on the artifact entry and is
// rendered as its own pill.
export const MARKETPLACE_BADGES = Object.freeze([
  'HIPAA',
  'GDPR',
  'BAA',
  'Permissive',
  'Verified',
]);

// SEED CATALOG — every slug here MUST resolve to a real file on disk via
// ARTIFACT_ROOTS. The five entries below back the five .kolm files in
// public/registry-pack/ (built by scripts/build-registry-pack.js, sha256
// recorded in public/registry-pack/manifest.json). The sixth slot is the
// Predibase-style customer-support intent classifier under
// examples/predibase-style-customer-support/.
//
// The brief originally listed candidate slugs (msa-clause-extractor,
// pr-review-bot, sql-safety-classifier) but the strict constraint is "no
// fake artifacts". The canonical names below are the ones whose bytes
// actually exist; the per-slug detail pages document the real recipe.
const SEED_CATALOG = [
  {
    slug: 'phi-redactor',
    name: 'PHI Redactor',
    description: 'PHI redaction for HIPAA Safe Harbor. Strips SSN, MRN, DOB, NPI, phone, email, dates from clinical notes.',
    category: 'compliance',
    license: 'Apache-2.0',
    badges: ['HIPAA', 'BAA', 'Verified'],
    source_path: path.join('public', 'registry-pack', 'phi-redactor.kolm'),
    download_url: '/registry-pack/phi-redactor.kolm',
    vertical: 'healthcare',
    tags: ['redaction', 'healthcare', 'phi', 'hipaa'],
  },
  {
    slug: 'invoice-parser',
    name: 'Invoice Parser',
    description: 'Extracts invoice_number, iso_date, amount, currency from AR/AP text.',
    category: 'data extraction',
    license: 'Apache-2.0',
    badges: ['Permissive', 'Verified'],
    source_path: path.join('public', 'registry-pack', 'invoice-parser.kolm'),
    download_url: '/registry-pack/invoice-parser.kolm',
    vertical: 'finance',
    tags: ['extraction', 'finance', 'invoice', 'billing'],
  },
  {
    slug: 'legal-clause-extractor',
    name: 'Legal Clause Extractor',
    description: 'Pulls governing_law, parties, term_months, effective_date from NDA-style master service agreements.',
    category: 'data extraction',
    license: 'Apache-2.0',
    badges: ['GDPR', 'Permissive', 'Verified'],
    source_path: path.join('public', 'registry-pack', 'legal-clause-extractor.kolm'),
    download_url: '/registry-pack/legal-clause-extractor.kolm',
    vertical: 'legal',
    tags: ['extraction', 'legal', 'nda', 'contracts'],
  },
  {
    slug: 'code-issue-classifier',
    name: 'Code Issue Classifier',
    description: 'Routes code-review comments into security, performance, style, test, docs, or refactor.',
    category: 'dev tooling',
    license: 'Apache-2.0',
    badges: ['Permissive', 'Verified'],
    source_path: path.join('public', 'registry-pack', 'code-issue-classifier.kolm'),
    download_url: '/registry-pack/code-issue-classifier.kolm',
    vertical: 'code',
    tags: ['classification', 'code', 'review', 'devtools'],
  },
  {
    slug: 'multilingual-greeter',
    name: 'Multilingual Greeter',
    description: 'Detects english, spanish, french, german, portuguese, italian, dutch in short greetings. Sized for edge devices.',
    category: 'classification',
    license: 'Apache-2.0',
    badges: ['Permissive', 'Verified'],
    source_path: path.join('public', 'registry-pack', 'multilingual-greeter.kolm'),
    download_url: '/registry-pack/multilingual-greeter.kolm',
    vertical: 'edge',
    tags: ['classification', 'edge', 'i18n', 'language'],
  },
  {
    slug: 'cs-intent-classifier',
    name: 'Customer Support Intent Classifier',
    description: 'Routes a support message into one of 10 intents (refund, cancel, billing, shipping, password_reset, account_lock, complaint, feedback, escalate, other).',
    category: 'classification',
    license: 'Apache-2.0',
    badges: ['Permissive', 'Verified'],
    source_path: path.join('examples', 'predibase-style-customer-support', 'cs-intent.kolm'),
    download_url: '/v1/marketplace/cs-intent-classifier/download',
    vertical: 'support',
    tags: ['classification', 'support', 'intent', 'predibase-style'],
  },
];

// Manifest from public/registry-pack/ — populated at startup. Used to pull
// real K-scores. If the file is missing or malformed we keep `null` so the
// UI shows "unverified" rather than a fake number.
let REGISTRY_PACK_MANIFEST = null;
function loadRegistryPackManifest() {
  if (REGISTRY_PACK_MANIFEST !== null) return REGISTRY_PACK_MANIFEST;
  try {
    const p = path.join(ROOT, 'public', 'registry-pack', 'manifest.json');
    if (fs.existsSync(p)) {
      const raw = fs.readFileSync(p, 'utf8');
      REGISTRY_PACK_MANIFEST = JSON.parse(raw);
    } else {
      REGISTRY_PACK_MANIFEST = { artifacts: [] };
    }
  } catch (_e) {
    REGISTRY_PACK_MANIFEST = { artifacts: [] };
  }
  return REGISTRY_PACK_MANIFEST;
}

function findRegistryPackEntry(slug) {
  const mani = loadRegistryPackManifest();
  if (!mani || !Array.isArray(mani.artifacts)) return null;
  // Match against the registry-pack `name` field (one of the 5 known names).
  return mani.artifacts.find((a) => a && a.name === slug) || null;
}

function resolveAbsolute(rel) {
  return path.join(ROOT, rel);
}

function fileExists(rel) {
  try { return fs.statSync(resolveAbsolute(rel)).isFile(); } catch (_e) { return false; }
}

function sha256File(rel) {
  try {
    const buf = fs.readFileSync(resolveAbsolute(rel));
    return {
      sha256: crypto.createHash('sha256').update(buf).digest('hex'),
      bytes: buf.length,
    };
  } catch (_e) { return null; }
}

// Hydrate a seed entry with on-disk facts. Returns an artifact record with
// fully resolved sha256/bytes/k_score/verified or `null` if the backing
// file is missing.
function hydrate(seed) {
  if (!fileExists(seed.source_path)) {
    // Drop the entry rather than ship a slug that 404s. Strict constraint
    // from the wave brief: "If a file isn't present yet, skip that entry."
    return null;
  }
  const hash = sha256File(seed.source_path);
  if (!hash) return null;
  const regEntry = findRegistryPackEntry(seed.slug);
  // K-score: prefer the registry-pack value (real, measured). If absent,
  // try a bench-report.json sibling. Else null + verified:false.
  let k_score = null;
  let k_score_source = null;
  if (regEntry && typeof regEntry.k_score === 'number') {
    k_score = regEntry.k_score;
    k_score_source = 'registry-pack-manifest';
  } else {
    // Try a sibling bench-report.json next to the artifact (cs-intent path).
    const siblingBench = path.join(path.dirname(seed.source_path), 'bench-report.json');
    if (fileExists(siblingBench)) {
      try {
        const br = JSON.parse(fs.readFileSync(resolveAbsolute(siblingBench), 'utf8'));
        // Bench report shape: paths['kolm-js'].correctness.accuracy
        const acc = br?.paths?.['kolm-js']?.correctness?.accuracy
                 ?? br?.paths?.['kolm-js']?.accuracy;
        if (typeof acc === 'number' && acc > 0) {
          k_score = acc;
          k_score_source = 'bench-report.json';
        }
      } catch (_e) { /* leave null */ }
    }
  }
  const badges = Array.isArray(seed.badges) ? [...seed.badges] : [];
  const verified = k_score != null && badges.includes('Verified');
  // If we could not load a K-score, demote the Verified badge so the UI
  // never advertises an unverified artifact.
  let finalBadges = badges;
  if (k_score == null) {
    finalBadges = badges.filter((b) => b !== 'Verified');
  }
  return {
    slug: seed.slug,
    name: seed.name,
    description: seed.description,
    category: seed.category,
    license: seed.license,
    badges: finalBadges,
    verified,
    sha256: hash.sha256,
    bytes: hash.bytes,
    k_score,
    k_score_source,
    vertical: seed.vertical,
    tags: seed.tags,
    source_path: seed.source_path,
    download_url: seed.download_url,
    detail_url: `/marketplace/${seed.slug}`,
  };
}

// Hydrate the full catalog at module-load time. We re-hydrate on each call
// to listArtifacts/getArtifact to keep tests deterministic when fixtures
// change between cases.
function hydrateAll() {
  const out = [];
  for (const seed of SEED_CATALOG) {
    const rec = hydrate(seed);
    if (rec) out.push(rec);
  }
  return out;
}

// MARKETPLACE_ARTIFACTS is exposed as a getter so callers see the current
// on-disk view, not a snapshot from module-load time. Tests that touch the
// filesystem fixtures still see fresh data.
export const MARKETPLACE_ARTIFACTS = new Proxy([], {
  get(_target, prop) {
    const arr = hydrateAll();
    const v = arr[prop];
    return typeof v === 'function' ? v.bind(arr) : (prop in arr ? arr[prop] : Reflect.get(arr, prop));
  },
});

// listArtifacts({filter}) — return the hydrated, filtered catalog.
// Filter keys (all optional, all AND-ed together):
//   category     — exact match against artifact.category
//   license      — exact match
//   min_k_score  — drops artifacts whose k_score is null or below the floor
//   verified     — true => only entries with verified:true
//   badge        — string => only entries whose badges include the value
//   q            — free-text search across slug/name/description/tags
export function listArtifacts({ filter = {} } = {}) {
  const all = hydrateAll();
  return all.filter((a) => {
    if (filter.category && a.category !== filter.category) return false;
    if (filter.license && a.license !== filter.license) return false;
    if (filter.min_k_score != null) {
      if (a.k_score == null) return false;
      if (a.k_score < Number(filter.min_k_score)) return false;
    }
    if (filter.verified === true && !a.verified) return false;
    if (filter.badge && !a.badges.includes(filter.badge)) return false;
    if (filter.q) {
      const q = String(filter.q).toLowerCase();
      const hay = [a.slug, a.name, a.description, ...(a.tags || [])].join(' ').toLowerCase();
      if (!hay.includes(q)) return false;
    }
    return true;
  });
}

export function getArtifact(slug) {
  if (!slug || typeof slug !== 'string') return null;
  const all = hydrateAll();
  return all.find((a) => a.slug === slug) || null;
}

// Canonical JSON: stable key ordering for deterministic hashing. Strip the
// signature block so the hash is computed over the body the signature
// covers.
function canonicalJson(v) {
  const sortRecursive = (x) => {
    if (Array.isArray(x)) return x.map(sortRecursive);
    if (x && typeof x === 'object') {
      const out = {};
      for (const k of Object.keys(x).sort()) out[k] = sortRecursive(x[k]);
      return out;
    }
    return x;
  };
  return JSON.stringify(sortRecursive(v));
}

const CATALOG_SPEC_VERSION = 'kolm-marketplace-1';
const SIGNATURE_ALGO = 'sha256-anchor';

// getCatalogManifest() — returns the full signed catalog. Signature is a
// deterministic sha256 over the canonical JSON of the manifest body (with
// signature/signed_at/signature_algo stripped). Future wave will swap this
// for an ed25519 signature; the signature_algo field carries the swap
// breadcrumb.
export function getCatalogManifest() {
  const artifacts = hydrateAll();
  const body = {
    spec: CATALOG_SPEC_VERSION,
    version: '1.0.0',
    artifacts,
  };
  const signature = crypto.createHash('sha256').update(canonicalJson(body)).digest('hex');
  return {
    ...body,
    signed_at: new Date(0).toISOString(), // stable timestamp for deterministic hash; callers stamp real time on the wire.
    signature_algo: SIGNATURE_ALGO,
    signature,
  };
}

// Helper for the download endpoint — returns an absolute path to the
// backing file if it exists, null otherwise.
export function resolveArtifactPath(slug) {
  const a = getArtifact(slug);
  if (!a) return null;
  const abs = resolveAbsolute(a.source_path);
  if (!fileExists(a.source_path)) return null;
  return abs;
}

// Verify a catalog manifest — recompute the signature over the body and
// compare. Returns { ok, expected, got } so the caller can surface the
// mismatch.
export function verifyCatalogManifest(manifest) {
  if (!manifest || typeof manifest !== 'object') return { ok: false, error: 'not an object' };
  const { signature, signed_at: _sa, signature_algo: _sal, ...body } = manifest;
  const expected = crypto.createHash('sha256').update(canonicalJson(body)).digest('hex');
  return { ok: expected === signature, expected, got: signature };
}

export const SPEC = Object.freeze({
  version: CATALOG_SPEC_VERSION,
  signature_algo: SIGNATURE_ALGO,
});
