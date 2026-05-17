// Comparators for K-score accuracy axis on holdout pairs.
// Each comparator: (actual, expected, opts?) => { pass: boolean, reason?: string }
// Comparators are pure and side-effect-free; the artifact manifest records
// which comparator was used so a verifier can reproduce scoring deterministically.

export const SUPPORTED_COMPARATORS = ['exact', 'normalized_string', 'json_subset', 'label'];

function isPlainObject(v) {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

function deepEqual(a, b) {
  if (a === b) return true;
  if (typeof a !== typeof b) return false;
  if (a === null || b === null) return a === b;
  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b)) return false;
    if (a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) if (!deepEqual(a[i], b[i])) return false;
    return true;
  }
  if (typeof a === 'object') {
    const ka = Object.keys(a).sort();
    const kb = Object.keys(b).sort();
    if (ka.length !== kb.length) return false;
    for (let i = 0; i < ka.length; i++) if (ka[i] !== kb[i]) return false;
    for (const k of ka) if (!deepEqual(a[k], b[k])) return false;
    return true;
  }
  return false;
}

// Recursively check that every key/value pair in expected appears in actual
// with matching value. Extra keys in actual are allowed. Arrays must match
// element-for-element.
function objectSubset(actual, expected) {
  if (expected === null || typeof expected !== 'object') {
    return { pass: deepEqual(actual, expected) };
  }
  if (Array.isArray(expected)) {
    if (!Array.isArray(actual) || actual.length !== expected.length) {
      return { pass: false, reason: 'array length or shape mismatch' };
    }
    for (let i = 0; i < expected.length; i++) {
      const r = objectSubset(actual[i], expected[i]);
      if (!r.pass) return { pass: false, reason: 'index ' + i + ': ' + (r.reason || 'mismatch') };
    }
    return { pass: true };
  }
  if (!isPlainObject(actual)) return { pass: false, reason: 'actual not object' };
  for (const k of Object.keys(expected)) {
    if (!(k in actual)) return { pass: false, reason: 'missing key ' + k };
    const r = objectSubset(actual[k], expected[k]);
    if (!r.pass) return { pass: false, reason: 'key ' + k + ': ' + (r.reason || 'mismatch') };
  }
  return { pass: true };
}

export function normalizeString(s) {
  if (s === null || s === undefined) return '';
  return String(s)
    .normalize('NFKC')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim();
}

// String form used for label/exact when value is non-string. Stable canonical
// JSON for objects so { a: 1, b: 2 } and { b: 2, a: 1 } compare equal.
function canonicalize(v) {
  if (typeof v === 'string') return v;
  if (v === null || v === undefined) return '';
  if (typeof v === 'number' || typeof v === 'boolean') return String(v);
  return canonicalJson(v);
}

export function canonicalJson(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return '[' + value.map(canonicalJson).join(',') + ']';
  const keys = Object.keys(value).sort();
  return '{' + keys.map((k) => JSON.stringify(k) + ':' + canonicalJson(value[k])).join(',') + '}';
}

function compareExact(actual, expected) {
  if (typeof expected === 'string' && typeof actual === 'string') {
    return { pass: actual === expected };
  }
  if (canonicalize(actual) === canonicalize(expected)) return { pass: true };
  return { pass: false, reason: 'exact mismatch' };
}

function compareNormalizedString(actual, expected) {
  const a = normalizeString(typeof actual === 'string' ? actual : canonicalize(actual));
  const b = normalizeString(typeof expected === 'string' ? expected : canonicalize(expected));
  if (a === b) return { pass: true };
  return { pass: false, reason: 'normalized mismatch' };
}

function compareJsonSubset(actual, expected) {
  let aObj = actual;
  let eObj = expected;
  if (typeof expected === 'string') {
    try { eObj = JSON.parse(expected); } catch (_) { /* leave as string */ }
  }
  if (typeof actual === 'string') {
    try { aObj = JSON.parse(actual); } catch (_) { /* leave as string */ }
  }
  return objectSubset(aObj, eObj);
}

function compareLabel(actual, expected) {
  let aLabel = actual;
  let eLabel = expected;
  if (isPlainObject(actual)) aLabel = actual.label ?? actual.class ?? actual.tag ?? actual;
  if (isPlainObject(expected)) eLabel = expected.label ?? expected.class ?? expected.tag ?? expected;
  const a = normalizeString(canonicalize(aLabel));
  const b = normalizeString(canonicalize(eLabel));
  if (a === b) return { pass: true };
  return { pass: false, reason: 'label mismatch (' + a + ' != ' + b + ')' };
}

export function getComparator(name) {
  switch ((name || 'exact').toLowerCase()) {
    case 'exact':
      return compareExact;
    case 'normalized_string':
    case 'normalized-string':
    case 'normalized':
      return compareNormalizedString;
    case 'json_subset':
    case 'json-subset':
    case 'subset':
      return compareJsonSubset;
    case 'label':
    case 'classifier':
      return compareLabel;
    default:
      throw new Error('unsupported comparator: ' + name + ' (supported: ' + SUPPORTED_COMPARATORS.join(', ') + ')');
  }
}

export function compare(actual, expected, comparatorName) {
  const fn = getComparator(comparatorName);
  return fn(actual, expected);
}

// Score a recipe runner against a holdout set. Returns
//   { accuracy, total, correct, comparator, per_row: [{ index, pass, reason? }] }
// runner: (input, params?) => actual_output (synchronous; thrown errors count as fail)
export function scoreHoldout(holdout, runner, comparatorName) {
  if (!Array.isArray(holdout)) throw new Error('holdout must be array');
  const cmpName = comparatorName || 'exact';
  const fn = getComparator(cmpName);
  let correct = 0;
  const perRow = [];
  for (let i = 0; i < holdout.length; i++) {
    const row = holdout[i];
    let actual;
    let pass = false;
    let reason;
    try {
      actual = runner(row.input, row.metadata?.params);
      const r = fn(actual, row.expected);
      pass = !!r.pass;
      reason = r.reason;
    } catch (e) {
      pass = false;
      reason = 'runner threw: ' + (e && e.message ? e.message : String(e));
    }
    if (pass) correct++;
    perRow.push({ index: i, pass, reason });
  }
  const total = holdout.length;
  const accuracy = total > 0 ? correct / total : 0;
  return { accuracy, total, correct, comparator: cmpName, per_row: perRow };
}

