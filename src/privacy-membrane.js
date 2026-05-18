// src/privacy-membrane.js
//
// W370 - Full privacy membrane: 17-class detector + redactor + reinserter +
// policy engine, JS-only (node:fs / node:path / node:crypto) with the small
// FIRST/LAST name table living in src/data/names-list.js for the
// proper-noun bigram heuristic.
//
// API surface (W370 contract):
//   - scan(text, opts?)            -> { matches:[{class,start,end,value,confidence}], detector_version, ... }
//   - redact(text, opts?)          -> { redacted, vault, classes_seen, detector_version, ... }
//   - reinsert(redacted, vault)    -> original string
//   - policy(className)            -> 'allow' | 'redact' | 'block' | 'override'
//   - setPolicy({class, action})   -> persists to ~/.kolm/runtime/policy.json
//   - getFullPolicy()              -> { class: action, ... }
//   - loadPolicy()                 -> reload from disk (idempotent)
//   - redactWithPolicy(text, opts) -> honours per-class policy
//   - PolicyBlockError             -> Error subclass with .class field
//
// Backward-compat surface (W368 stub callers still in tree until Round 2):
//   - scan() result also carries .sensitive .classes .findings .placeholder_map
//   - redact() result also carries .redacted_text and .map (aliases of .redacted / .vault)
//   - policy() called with no args returns { default: 'redact' }-shaped object,
//     mirroring the W368 stub that the daemon-connector still reads.
//
// Storage:
//   - Policy   -> $KOLM_DATA_DIR/runtime/policy.json (default ~/.kolm/runtime/policy.json)
//   - Vault    -> $KOLM_DATA_DIR/redactions/<event_id>.json (opt-in via opts.persistVault)
//   - Terms    -> $KOLM_DATA_DIR/runtime/proprietary-terms.json (optional, hot-loaded)
//
// Detector version constant is exported so observability code can pin
// findings to a specific rule revision.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';

import { FIRST_NAMES, LAST_NAMES } from './data/names-list.js';

export const DETECTOR_VERSION = '2026-05-18.1';

// -----------------------------------------------------------------------
// Storage paths (honour KOLM_DATA_DIR for test isolation)
// -----------------------------------------------------------------------
function _home() {
  return process.env.HOME || process.env.USERPROFILE || os.homedir();
}
function _dataDir() {
  return process.env.KOLM_DATA_DIR
    ? path.resolve(process.env.KOLM_DATA_DIR)
    : path.join(_home(), '.kolm');
}
function _runtimeDir() {
  return path.join(_dataDir(), 'runtime');
}
function _ensureDir(p) {
  fs.mkdirSync(p, { recursive: true });
  return p;
}
function _policyPath() {
  return path.join(_ensureDir(_runtimeDir()), 'policy.json');
}
function _proprietaryTermsPath() {
  return path.join(_runtimeDir(), 'proprietary-terms.json');
}
function _redactionsDir() {
  return _ensureDir(path.join(_dataDir(), 'redactions'));
}

// -----------------------------------------------------------------------
// Policy engine
// -----------------------------------------------------------------------
//
// Four actions per class:
//   - 'allow'    - leave text alone, do not redact, do not block
//   - 'redact'   - swap matches for VAR_ placeholders (default for everything sensitive)
//   - 'block'    - throw PolicyBlockError so the caller can refuse upstream forward
//   - 'override' - mark text with a VAR_OVERRIDE_ comment but pass the original through
//
// The default map is conservative: we default-redact every sensitive class so
// a misconfigured deploy errs on the privacy-preserving side.

export const ALL_CLASSES = Object.freeze([
  'ssn',
  'malformed_ssn',
  'email',
  'phone',
  'address',
  'name',
  'dob',
  'mrn',
  'account_number',
  'api_key',
  'bearer_token',
  'private_key',
  'database_url',
  'internal_hostname',
  'customer_id',
  'proprietary_term',
  'ip_address',
]);

const VALID_ACTIONS = new Set(['allow', 'redact', 'block', 'override']);

const DEFAULT_POLICY = Object.freeze(
  Object.fromEntries(ALL_CLASSES.map((c) => [c, 'redact']))
);

let _policyCache = null;
let _policyCachePath = null;

export function loadPolicy() {
  const p = _policyPath();
  let onDisk = {};
  if (fs.existsSync(p)) {
    try { onDisk = JSON.parse(fs.readFileSync(p, 'utf-8')); }
    catch { onDisk = {}; }
  }
  const merged = { ...DEFAULT_POLICY };
  for (const [cls, action] of Object.entries(onDisk || {})) {
    if (ALL_CLASSES.includes(cls) && VALID_ACTIONS.has(action)) {
      merged[cls] = action;
    }
  }
  _policyCache = merged;
  _policyCachePath = p;
  return { ...merged };
}

export function getFullPolicy() {
  // Always re-resolve the path because KOLM_DATA_DIR can change between
  // test cases. If the resolved path differs from the cache, drop it.
  const p = _policyPath();
  if (!_policyCache || _policyCachePath !== p) loadPolicy();
  return { ..._policyCache };
}

export function setPolicy({ class: cls, action } = {}) {
  if (!cls || typeof cls !== 'string') {
    throw new TypeError('setPolicy requires {class, action}');
  }
  if (!ALL_CLASSES.includes(cls)) {
    throw new RangeError(`unknown privacy class: ${cls}`);
  }
  if (!VALID_ACTIONS.has(action)) {
    throw new RangeError(`invalid action ${action}; expected allow|redact|block|override`);
  }
  const current = getFullPolicy();
  current[cls] = action;
  const p = _policyPath();
  fs.writeFileSync(p, JSON.stringify(current, null, 2), 'utf-8');
  _policyCache = current;
  _policyCachePath = p;
  return { ...current };
}

export function policy(className) {
  // Legacy daemon-connector / router call: `policy()` with no args
  // expects an object shaped { default: '<action>' }.
  if (className === undefined || className === null) {
    const def = String(process.env.KOLM_PRIVACY_POLICY || '').toLowerCase();
    if (VALID_ACTIONS.has(def)) return { default: def };
    return { default: 'redact' };
  }
  const full = getFullPolicy();
  return full[className] || 'redact';
}

export class PolicyBlockError extends Error {
  constructor(message, cls) {
    super(message || `policy=block for class ${cls}`);
    this.name = 'PolicyBlockError';
    this.class = cls;
    this.code = 'POLICY_BLOCK';
  }
}

// -----------------------------------------------------------------------
// Detectors
// -----------------------------------------------------------------------
//
// Each detector takes `text` and returns an array of
// {start, end, value, confidence} ranges. They MUST NOT mutate text or
// reach across line boundaries unless the pattern explicitly opts in.
//
// We deliberately keep these regex-driven rather than ML-driven so the
// membrane is deterministic, audit-friendly, and runnable inside the
// daemon without any python dependency.

// SSN ---------------------------------------------------------------------

const SSN_STRICT = /(?<!\d)(?!000|666|9\d\d)(\d{3})-?(?!00)(\d{2})-?(?!0000)(\d{4})(?!\d)/g;
// The strict pattern above already rejects 000/666/9xx area, 00 group, 0000 serial.
// Malformed SSN: matches any 9-digit run that LOOKS like an SSN but fails the
// canonical-area / group / serial rules. Useful for incident response.
const SSN_LOOSE = /(?<!\d)(\d{3})[- ]?(\d{2})[- ]?(\d{4})(?!\d)/g;

function detectSSN(text) {
  const out = [];
  for (const m of text.matchAll(SSN_STRICT)) {
    out.push({ start: m.index, end: m.index + m[0].length, value: m[0], confidence: 0.95 });
  }
  return out;
}

function detectMalformedSSN(text, strictHits) {
  const taken = new Set();
  for (const h of strictHits) {
    for (let i = h.start; i < h.end; i++) taken.add(i);
  }
  const out = [];
  for (const m of text.matchAll(SSN_LOOSE)) {
    const start = m.index;
    const end = start + m[0].length;
    // Skip if already covered by strict.
    let overlap = false;
    for (let i = start; i < end; i++) if (taken.has(i)) { overlap = true; break; }
    if (overlap) continue;
    const area = m[1];
    const group = m[2];
    const serial = m[3];
    // Definitely-invalid area / group / serial -> malformed.
    const isMalformed =
      area === '000' || area === '666' || area.startsWith('9') ||
      group === '00' || serial === '0000';
    if (isMalformed) {
      out.push({ start, end, value: m[0], confidence: 0.4 });
    }
  }
  return out;
}

// Email -------------------------------------------------------------------

const EMAIL_RE = /\b[A-Za-z0-9._%+\-]+@[A-Za-z0-9](?:[A-Za-z0-9\-]{0,61}[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9\-]{0,61}[A-Za-z0-9])?)+\b/g;

function detectEmail(text) {
  const out = [];
  for (const m of text.matchAll(EMAIL_RE)) {
    out.push({ start: m.index, end: m.index + m[0].length, value: m[0], confidence: 0.95 });
  }
  return out;
}

// Phone -------------------------------------------------------------------

// E.164 (+ country code, 7-15 digits) OR US (xxx) xxx-xxxx / xxx-xxx-xxxx /
// xxx.xxx.xxxx / xxx xxx xxxx. We require enough separator/structure to avoid
// matching every 10-digit number in source code.
const PHONE_E164 = /(?<!\d)\+[1-9]\d{1,2}[\s\-.]?\(?\d{1,4}\)?[\s\-.]?\d{1,4}[\s\-.]?\d{1,9}(?!\d)/g;
const PHONE_US = /(?<![\w.])(?:\(\d{3}\)\s?|\d{3}[\-.])\d{3}[\-.]\d{4}(?!\d)/g;

function detectPhone(text) {
  const out = [];
  const seen = new Set();
  function push(start, end, value, confidence) {
    const k = `${start}:${end}`;
    if (seen.has(k)) return;
    seen.add(k);
    // Strip leading digits embedded in larger numbers (e.g. version strings).
    const looksLikePhone = value.replace(/\D/g, '').length >= 10;
    if (!looksLikePhone) return;
    out.push({ start, end, value, confidence });
  }
  for (const m of text.matchAll(PHONE_E164)) {
    push(m.index, m.index + m[0].length, m[0], 0.85);
  }
  for (const m of text.matchAll(PHONE_US)) {
    push(m.index, m.index + m[0].length, m[0], 0.9);
  }
  return out;
}

// Address -----------------------------------------------------------------

const STREET_KEYWORDS =
  '(?:Street|St|Avenue|Ave|Road|Rd|Boulevard|Blvd|Drive|Dr|Lane|Ln|Court|Ct|Way|Place|Pl|Highway|Hwy|Parkway|Pkwy|Circle|Cir|Terrace|Ter)';
const ADDRESS_RE = new RegExp(
  String.raw`\b\d{1,6}\s+[A-Z][A-Za-z0-9'\.\-]*(?:\s+[A-Z][A-Za-z0-9'\.\-]*){0,4}\s+${STREET_KEYWORDS}\b\.?`,
  'g'
);

function detectAddress(text) {
  const out = [];
  for (const m of text.matchAll(ADDRESS_RE)) {
    out.push({ start: m.index, end: m.index + m[0].length, value: m[0], confidence: 0.8 });
  }
  return out;
}

// Name --------------------------------------------------------------------
//
// Heuristic: capitalized-token bigram where the FIRST token hits FIRST_NAMES
// and the SECOND token hits LAST_NAMES. Single-name detection is intentionally
// off (too noisy). This is a conservative detector by design — we'd rather
// miss a name than redact "Smith" in "Adam Smith's invisible hand".

const NAME_BIGRAM_RE = /\b([A-Z][a-z'\-]{1,20})\s+([A-Z][a-z'\-]{1,20})\b/g;

function detectName(text) {
  const out = [];
  for (const m of text.matchAll(NAME_BIGRAM_RE)) {
    const first = m[1];
    const last = m[2];
    if (FIRST_NAMES.has(first) && LAST_NAMES.has(last)) {
      out.push({ start: m.index, end: m.index + m[0].length, value: m[0], confidence: 0.75 });
    }
  }
  return out;
}

// DOB ---------------------------------------------------------------------
//
// Patterns: 1900-2030 yyyy-mm-dd, yyyy/mm/dd, mm/dd/yyyy, mm-dd-yyyy,
// "January 1 1970", "1 January 1970".
const DOB_ISO_RE = /\b(19\d{2}|20[0-3]\d)[\-\/](0?[1-9]|1[0-2])[\-\/](0?[1-9]|[12]\d|3[01])\b/g;
const DOB_US_RE = /\b(0?[1-9]|1[0-2])[\-\/](0?[1-9]|[12]\d|3[01])[\-\/](19\d{2}|20[0-3]\d)\b/g;
const MONTHS = '(?:January|February|March|April|May|June|July|August|September|October|November|December|Jan|Feb|Mar|Apr|Jun|Jul|Aug|Sep|Sept|Oct|Nov|Dec)';
const DOB_LONG_RE = new RegExp(
  String.raw`\b(?:${MONTHS}\s+\d{1,2},?\s+(19\d{2}|20[0-3]\d)|\d{1,2}\s+${MONTHS}\s+(19\d{2}|20[0-3]\d))\b`,
  'g'
);

function detectDOB(text) {
  const out = [];
  const seen = new Set();
  function push(start, end, value) {
    const k = `${start}:${end}`;
    if (seen.has(k)) return;
    seen.add(k);
    out.push({ start, end, value, confidence: 0.7 });
  }
  for (const m of text.matchAll(DOB_ISO_RE)) push(m.index, m.index + m[0].length, m[0]);
  for (const m of text.matchAll(DOB_US_RE)) push(m.index, m.index + m[0].length, m[0]);
  for (const m of text.matchAll(DOB_LONG_RE)) push(m.index, m.index + m[0].length, m[0]);
  return out;
}

// MRN ---------------------------------------------------------------------
//
// 6-10 digits, optionally prefixed by `MRN`/`MRN:` /`MRN-` /`PT#`.
const MRN_RE = /\b(?:MRN|Mrn|mrn|PT#|PT-|Patient[- ]?ID)[\s:#\-]*([A-Z]?\d{6,10})\b/g;

function detectMRN(text) {
  const out = [];
  for (const m of text.matchAll(MRN_RE)) {
    out.push({ start: m.index, end: m.index + m[0].length, value: m[0], confidence: 0.85 });
  }
  return out;
}

// Account number ----------------------------------------------------------
//
// 8-16 digit run, optionally hyphen-grouped, with an explicit "account" /
// "acct" / "iban" / "routing" anchor in the surrounding text. Pure digit runs
// without an anchor would alias to MRN / phone / SSN_loose so we require the
// anchor here.

const ACCT_RE = /(?:\b(?:account|acct|routing|iban|wire)\b[\s:#\-]*)([A-Z0-9](?:[\- ]?[A-Z0-9]){7,15})/gi;

function detectAccountNumber(text) {
  const out = [];
  for (const m of text.matchAll(ACCT_RE)) {
    // Match the account-number group, not the anchor.
    const acctStart = m.index + m[0].indexOf(m[1]);
    const acctEnd = acctStart + m[1].length;
    const digitCount = m[1].replace(/[^0-9A-Z]/gi, '').length;
    if (digitCount < 8 || digitCount > 16) continue;
    out.push({ start: acctStart, end: acctEnd, value: m[1], confidence: 0.8 });
  }
  return out;
}

// API key -----------------------------------------------------------------

const API_KEY_RE = /\b(?:sk_[A-Za-z0-9_]{16,}|sk-[A-Za-z0-9_\-]{16,}|ant-[A-Za-z0-9_\-]{16,}|AKIA[0-9A-Z]{16}|AIza[0-9A-Za-z\-_]{16,}|ghp_[A-Za-z0-9]{16,}|gho_[A-Za-z0-9]{16,}|glpat-[A-Za-z0-9\-_]{16,}|xox[baprs]-[A-Za-z0-9\-]{10,})\b/g;

function detectApiKey(text) {
  const out = [];
  for (const m of text.matchAll(API_KEY_RE)) {
    out.push({ start: m.index, end: m.index + m[0].length, value: m[0], confidence: 0.95 });
  }
  return out;
}

// Bearer token (JWT) ------------------------------------------------------

const JWT_RE = /\b(eyJ[A-Za-z0-9_\-]{8,}\.[A-Za-z0-9_\-]{8,}\.[A-Za-z0-9_\-]{8,})\b/g;
const BEARER_RE = /\bBearer\s+([A-Za-z0-9_\-\.]{16,})\b/g;

function detectBearer(text) {
  const out = [];
  const seen = new Set();
  function push(start, end, value, confidence) {
    const k = `${start}:${end}`;
    if (seen.has(k)) return;
    seen.add(k);
    out.push({ start, end, value, confidence });
  }
  for (const m of text.matchAll(JWT_RE)) {
    push(m.index, m.index + m[0].length, m[0], 0.92);
  }
  for (const m of text.matchAll(BEARER_RE)) {
    push(m.index, m.index + m[0].length, m[0], 0.9);
  }
  return out;
}

// Private key -------------------------------------------------------------

const PRIVATE_KEY_RE = /-----BEGIN (?:RSA |EC |DSA |OPENSSH |PGP |ENCRYPTED )?PRIVATE KEY-----[\s\S]*?-----END (?:RSA |EC |DSA |OPENSSH |PGP |ENCRYPTED )?PRIVATE KEY-----/g;

function detectPrivateKey(text) {
  const out = [];
  for (const m of text.matchAll(PRIVATE_KEY_RE)) {
    out.push({ start: m.index, end: m.index + m[0].length, value: m[0], confidence: 0.99 });
  }
  return out;
}

// Database URL ------------------------------------------------------------

const DB_URL_RE = /\b(?:postgres(?:ql)?|mysql|mongodb(?:\+srv)?|redis|rediss|mariadb|cockroachdb|clickhouse|snowflake|jdbc:[a-z]+):\/\/[^\s'"`<>]+/gi;

function detectDatabaseUrl(text) {
  const out = [];
  for (const m of text.matchAll(DB_URL_RE)) {
    out.push({ start: m.index, end: m.index + m[0].length, value: m[0], confidence: 0.95 });
  }
  return out;
}

// Internal hostname -------------------------------------------------------
//
// FQDNs ending in .internal / .corp / .local plus dotted-quad RFC1918 hosts.
// We deliberately do NOT match private IPs here — those go via detectIp() so
// they can be sub-classified.

const INTERNAL_HOST_RE = /\b(?:[a-z0-9](?:[a-z0-9\-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9\-]{0,61}[a-z0-9])?)*\.(?:internal|corp|local|intranet|lan|i\.example|svc\.cluster\.local))\b/gi;

function detectInternalHost(text) {
  const out = [];
  for (const m of text.matchAll(INTERNAL_HOST_RE)) {
    out.push({ start: m.index, end: m.index + m[0].length, value: m[0], confidence: 0.85 });
  }
  return out;
}

// Customer ID -------------------------------------------------------------
//
// Default: CUST-XXXX / CID-XXXX / ACCT-XXXX. Override via KOLM_CUSTOMER_ID_PATTERN
// env var (must be a valid JS regex source string).

function _customerIdRe() {
  const src = process.env.KOLM_CUSTOMER_ID_PATTERN;
  if (src) {
    try { return new RegExp(src, 'g'); }
    catch { /* fall through to default */ }
  }
  return /\b(?:CUST|CID|ACCT|CUSTOMER)[\-_][A-Z0-9]{3,16}\b/g;
}

function detectCustomerId(text) {
  const re = _customerIdRe();
  const out = [];
  for (const m of text.matchAll(re)) {
    out.push({ start: m.index, end: m.index + m[0].length, value: m[0], confidence: 0.85 });
  }
  return out;
}

// Proprietary terms -------------------------------------------------------
//
// Loaded from $KOLM_DATA_DIR/runtime/proprietary-terms.json. Format:
//   { "terms": ["Acme Falcon", "Project Athena", ...] }
// Case-insensitive whole-word match.

function _loadProprietaryTerms() {
  const p = _proprietaryTermsPath();
  if (!fs.existsSync(p)) return [];
  try {
    const raw = JSON.parse(fs.readFileSync(p, 'utf-8'));
    if (Array.isArray(raw)) return raw.filter((t) => typeof t === 'string' && t.length > 0);
    if (raw && Array.isArray(raw.terms)) return raw.terms.filter((t) => typeof t === 'string' && t.length > 0);
    return [];
  } catch { return []; }
}

function _escapeRe(s) { return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }

function detectProprietary(text) {
  const terms = _loadProprietaryTerms();
  if (terms.length === 0) return [];
  const out = [];
  const seen = new Set();
  for (const term of terms) {
    const re = new RegExp(`\\b${_escapeRe(term)}\\b`, 'gi');
    for (const m of text.matchAll(re)) {
      const start = m.index;
      const end = start + m[0].length;
      const k = `${start}:${end}`;
      if (seen.has(k)) continue;
      seen.add(k);
      out.push({ start, end, value: m[0], confidence: 0.9 });
    }
  }
  return out;
}

// IP address --------------------------------------------------------------
//
// IPv4 + IPv6. We add `subclass` so callers can apply different policies to
// private-range hits (RFC1918) than to public IPs.

const IPV4_RE = /\b(?:(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)\.){3}(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)\b/g;
const IPV6_RE = /\b(?:[A-Fa-f0-9]{1,4}:){7}[A-Fa-f0-9]{1,4}\b|\b(?:[A-Fa-f0-9]{1,4}:){1,7}:(?:[A-Fa-f0-9]{1,4})?\b|::1\b|::\b/g;

function _ipv4Subclass(ip) {
  const parts = ip.split('.').map((p) => parseInt(p, 10));
  const [a, b] = parts;
  if (a === 10) return 'rfc1918';
  if (a === 172 && b >= 16 && b <= 31) return 'rfc1918';
  if (a === 192 && b === 168) return 'rfc1918';
  if (a === 127) return 'loopback';
  if (a === 169 && b === 254) return 'link_local';
  if (a >= 224 && a <= 239) return 'multicast';
  return 'public';
}
function _ipv6Subclass(ip) {
  const lower = ip.toLowerCase();
  if (lower === '::1' || lower === '0:0:0:0:0:0:0:1') return 'loopback';
  if (lower === '::') return 'unspecified';
  if (lower.startsWith('fe80:')) return 'link_local';
  if (lower.startsWith('fc') || lower.startsWith('fd')) return 'ula';
  if (lower.startsWith('ff')) return 'multicast';
  return 'public';
}

function detectIp(text) {
  const out = [];
  const seen = new Set();
  for (const m of text.matchAll(IPV4_RE)) {
    const k = `${m.index}:${m.index + m[0].length}`;
    if (seen.has(k)) continue;
    seen.add(k);
    out.push({
      start: m.index,
      end: m.index + m[0].length,
      value: m[0],
      confidence: 0.92,
      subclass: _ipv4Subclass(m[0]),
      family: 'ipv4',
    });
  }
  for (const m of text.matchAll(IPV6_RE)) {
    const k = `${m.index}:${m.index + m[0].length}`;
    if (seen.has(k)) continue;
    seen.add(k);
    out.push({
      start: m.index,
      end: m.index + m[0].length,
      value: m[0],
      confidence: 0.88,
      subclass: _ipv6Subclass(m[0]),
      family: 'ipv6',
    });
  }
  return out;
}

// -----------------------------------------------------------------------
// Orchestration
// -----------------------------------------------------------------------
//
// Run all detectors, dedupe overlaps (longest-wins), and return matches
// sorted by start index for deterministic VAR_ numbering.

function _runAllDetectors(text) {
  const ssn = detectSSN(text);
  const malformed = detectMalformedSSN(text, ssn);
  const all = [
    ...ssn.map((m) => ({ ...m, class: 'ssn' })),
    ...malformed.map((m) => ({ ...m, class: 'malformed_ssn' })),
    ...detectEmail(text).map((m) => ({ ...m, class: 'email' })),
    ...detectPhone(text).map((m) => ({ ...m, class: 'phone' })),
    ...detectAddress(text).map((m) => ({ ...m, class: 'address' })),
    ...detectName(text).map((m) => ({ ...m, class: 'name' })),
    ...detectDOB(text).map((m) => ({ ...m, class: 'dob' })),
    ...detectMRN(text).map((m) => ({ ...m, class: 'mrn' })),
    ...detectAccountNumber(text).map((m) => ({ ...m, class: 'account_number' })),
    ...detectApiKey(text).map((m) => ({ ...m, class: 'api_key' })),
    ...detectBearer(text).map((m) => ({ ...m, class: 'bearer_token' })),
    ...detectPrivateKey(text).map((m) => ({ ...m, class: 'private_key' })),
    ...detectDatabaseUrl(text).map((m) => ({ ...m, class: 'database_url' })),
    ...detectInternalHost(text).map((m) => ({ ...m, class: 'internal_hostname' })),
    ...detectCustomerId(text).map((m) => ({ ...m, class: 'customer_id' })),
    ...detectProprietary(text).map((m) => ({ ...m, class: 'proprietary_term' })),
    ...detectIp(text).map((m) => ({ ...m, class: 'ip_address' })),
  ];

  // Priority order for overlap resolution: classes earlier in this list
  // win when their span overlaps a later one. private_key beats everything
  // else because it's the largest blast radius.
  const PRIORITY = [
    'private_key',
    'api_key',
    'bearer_token',
    'database_url',
    'ssn',
    'malformed_ssn',
    'email',
    'mrn',
    'account_number',
    'customer_id',
    'dob',
    'phone',
    'internal_hostname',
    'address',
    'name',
    'proprietary_term',
    'ip_address',
  ];
  const rank = (c) => {
    const i = PRIORITY.indexOf(c);
    return i === -1 ? 999 : i;
  };

  // Sort by start ASC, then by (rank ASC, length DESC) so the highest-priority
  // / longest match at each start position wins.
  all.sort((a, b) => {
    if (a.start !== b.start) return a.start - b.start;
    const ra = rank(a.class);
    const rb = rank(b.class);
    if (ra !== rb) return ra - rb;
    return (b.end - b.start) - (a.end - a.start);
  });

  const kept = [];
  let cursor = -1;
  for (const m of all) {
    if (m.start < cursor) continue;
    kept.push(m);
    cursor = m.end;
  }
  return kept;
}

// VAR_ naming -------------------------------------------------------------

function _varClassLabel(cls) {
  // Per spec: name -> PATIENT_NAME.
  if (cls === 'name') return 'PATIENT_NAME';
  return cls.toUpperCase();
}

function _varName(cls, idx) {
  return `VAR_${_varClassLabel(cls)}_${idx}`;
}

// -----------------------------------------------------------------------
// Public API
// -----------------------------------------------------------------------

export function scan(text, _opts = {}) {
  const s = String(text == null ? '' : text);
  if (s.length === 0) {
    return {
      matches: [],
      detector_version: DETECTOR_VERSION,
      // Legacy aliases:
      sensitive: false,
      classes: [],
      findings: [],
      placeholder_map: {},
    };
  }
  const matches = _runAllDetectors(s);
  const classes = [...new Set(matches.map((m) => m.class))];
  return {
    matches,
    detector_version: DETECTOR_VERSION,
    // Legacy aliases for the W368 stub callers still in tree:
    sensitive: matches.length > 0,
    classes,
    findings: matches.map((m) => ({ class: m.class, value: m.value, index: m.start })),
    placeholder_map: {},
  };
}

export function redact(text, opts = {}) {
  const s = String(text == null ? '' : text);
  if (s.length === 0) {
    return {
      redacted: '',
      vault: {},
      classes_seen: [],
      detector_version: DETECTOR_VERSION,
      // Legacy aliases:
      redacted_text: '',
      map: {},
    };
  }
  const matches = _runAllDetectors(s);
  const vault = {};
  const counters = {};
  const replacements = []; // [{start, end, varName}]
  for (const m of matches) {
    const cls = m.class;
    counters[cls] = (counters[cls] || 0) + 1;
    const v = _varName(cls, counters[cls]);
    vault[v] = m.value;
    replacements.push({ start: m.start, end: m.end, varName: v });
  }
  // Rebuild text right-to-left so indices stay valid.
  replacements.sort((a, b) => b.start - a.start);
  let out = s;
  for (const r of replacements) {
    out = out.slice(0, r.start) + r.varName + out.slice(r.end);
  }
  const classes_seen = [...new Set(matches.map((m) => m.class))];

  if (opts && opts.persistVault) {
    try {
      const eid = String(opts.eventId || opts.event_id || crypto.randomBytes(8).toString('hex'));
      const fp = path.join(_redactionsDir(), `${eid}.json`);
      const payload = {
        event_id: eid,
        detector_version: DETECTOR_VERSION,
        created_at: new Date().toISOString(),
        vault,
        classes_seen,
      };
      fs.writeFileSync(fp, JSON.stringify(payload, null, 2), 'utf-8');
    } catch { /* persistence is best-effort; never break the caller */ }
  }

  return {
    redacted: out,
    vault,
    classes_seen,
    detector_version: DETECTOR_VERSION,
    // Legacy aliases:
    redacted_text: out,
    map: vault,
  };
}

export function reinsert(redacted, vault) {
  if (vault == null || typeof vault !== 'object') return String(redacted == null ? '' : redacted);
  let out = String(redacted == null ? '' : redacted);
  // Replace longest-named placeholders first so VAR_API_KEY_10 doesn't get
  // partially eaten by a VAR_API_KEY_1 match. Tampered vault entries
  // (non-string values) are skipped silently rather than crashing.
  const entries = Object.entries(vault).sort((a, b) => b[0].length - a[0].length);
  for (const [placeholder, value] of entries) {
    if (typeof placeholder !== 'string' || !/^VAR_[A-Z0-9_]+$/.test(placeholder)) continue;
    if (typeof value !== 'string') continue;
    out = out.split(placeholder).join(value);
  }
  return out;
}

export function redactWithPolicy(text, opts = {}) {
  const s = String(text == null ? '' : text);
  if (s.length === 0) {
    return {
      redacted: '',
      vault: {},
      classes_seen: [],
      blocked_classes: [],
      allowed_classes: [],
      overridden_classes: [],
      detector_version: DETECTOR_VERSION,
      redacted_text: '',
      map: {},
    };
  }
  const pol = getFullPolicy();
  const matches = _runAllDetectors(s);

  // First pass: detect block. Throw immediately so the caller can refuse upstream.
  const blockingHits = matches.filter((m) => pol[m.class] === 'block');
  if (blockingHits.length > 0 && !(opts && opts.dryRun)) {
    const cls = blockingHits[0].class;
    const err = new PolicyBlockError(
      `privacy policy blocked outbound text: class=${cls}, value=${JSON.stringify(blockingHits[0].value).slice(0, 64)}`,
      cls
    );
    err.blocked_classes = [...new Set(blockingHits.map((m) => m.class))];
    err.blocked_matches = blockingHits.map((m) => ({
      class: m.class, start: m.start, end: m.end, value: m.value,
    }));
    throw err;
  }

  const vault = {};
  const counters = {};
  const replacements = [];
  const allowed = new Set();
  const overridden = new Set();
  const redactedClasses = new Set();
  const blocked = new Set();

  for (const m of matches) {
    const action = pol[m.class] || 'redact';
    if (action === 'allow') {
      allowed.add(m.class);
      continue;
    }
    if (action === 'block') {
      blocked.add(m.class);
      continue;
    }
    if (action === 'override') {
      // Mark text by wrapping the value in a [[OVERRIDE:class]] comment so
      // downstream audit pipelines can see the operator intent. Original
      // value passes through.
      overridden.add(m.class);
      const marker = `[[OVERRIDE:${m.class}]]`;
      replacements.push({ start: m.start, end: m.end, replacement: `${marker}${m.value}${marker}` });
      continue;
    }
    // Default: 'redact'.
    counters[m.class] = (counters[m.class] || 0) + 1;
    const v = _varName(m.class, counters[m.class]);
    vault[v] = m.value;
    replacements.push({ start: m.start, end: m.end, replacement: v });
    redactedClasses.add(m.class);
  }

  replacements.sort((a, b) => b.start - a.start);
  let out = s;
  for (const r of replacements) {
    out = out.slice(0, r.start) + r.replacement + out.slice(r.end);
  }

  return {
    redacted: out,
    vault,
    classes_seen: [...redactedClasses],
    blocked_classes: [...blocked],
    allowed_classes: [...allowed],
    overridden_classes: [...overridden],
    detector_version: DETECTOR_VERSION,
    redacted_text: out,
    map: vault,
  };
}

// -----------------------------------------------------------------------
// Diagnostics / introspection
// -----------------------------------------------------------------------

export function listDetectors() {
  return ALL_CLASSES.map((c) => ({ class: c, default_action: DEFAULT_POLICY[c] }));
}

export function statePaths() {
  return {
    data_dir: _dataDir(),
    policy: _policyPath(),
    proprietary_terms: _proprietaryTermsPath(),
    redactions: _redactionsDir(),
  };
}

// Reset the in-memory caches. Tests that swap KOLM_DATA_DIR call this
// to force a re-read from disk.
export function _resetCacheForTests() {
  _policyCache = null;
  _policyCachePath = null;
}
