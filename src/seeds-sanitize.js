// src/seeds-sanitize.js
//
// Wave 357 — PHI-safe seed sanitizer.
//
// API:
//   sanitize(rows, opts) -> { kept, dropped }
//
// Logic:
//   - For each row, run phi-redactor's redact() on the input.
//   - If redaction would mask more than `opts.maxMaskRatio` (default 0.05)
//     of the input characters, the row contains real PHI and is dropped.
//   - Special case: if the row's `expected` (or `output`) equals the redacted
//     form of the input, the row IS a phi-redactor training pair by
//     definition — keep it even if many chars are masked.
//   - Returns {kept, dropped} arrays. Each dropped row carries `reason` and
//     `mask_ratio`.

import { redact } from './phi-redactor.js';

function pickOutput(row) {
  if (row == null) return '';
  if (row.expected !== undefined) return row.expected;
  if (row.output !== undefined) return row.output;
  return '';
}

function toStr(v) {
  if (v == null) return '';
  if (typeof v === 'string') return v;
  try { return JSON.stringify(v); } catch { return String(v); }
}

// Ratio of input characters that would be replaced by [PHI_*] tokens.
// Computed as (sum of original lengths in map) / max(1, original length).
function maskRatio(original, map) {
  const totalLen = original.length;
  if (totalLen === 0) return 0;
  let masked = 0;
  for (const orig of Object.values(map || {})) {
    masked += String(orig).length;
  }
  return masked / totalLen;
}

export async function sanitize(rows, opts = {}) {
  const maxRatio = typeof opts.maxMaskRatio === 'number' ? opts.maxMaskRatio : 0.05;
  const redactorOpts = opts.redactorOpts || {};
  const kept = [];
  const dropped = [];
  const arr = Array.isArray(rows) ? rows : [];

  for (const row of arr) {
    if (!row || typeof row !== 'object') {
      dropped.push({ row, reason: 'malformed', mask_ratio: 0 });
      continue;
    }
    const inputStr = toStr(row.input);
    const expectedStr = toStr(pickOutput(row));
    if (!inputStr) {
      dropped.push({ row, reason: 'empty_input', mask_ratio: 0 });
      continue;
    }
    const { redacted, map } = redact(inputStr, redactorOpts);
    const ratio = maskRatio(inputStr, map);

    // Phi-redactor training row by definition: the expected output is itself
    // the redacted form of the input. Keep as-is.
    if (expectedStr && expectedStr.trim() === redacted.trim()) {
      kept.push(row);
      continue;
    }
    // If output also already equals the input's redacted shape with some
    // whitespace difference, count as redactor pair.
    if (expectedStr && expectedStr.replace(/\s+/g, ' ').trim() === redacted.replace(/\s+/g, ' ').trim()) {
      kept.push(row);
      continue;
    }

    if (ratio > maxRatio) {
      dropped.push({
        row,
        reason: 'phi_present',
        mask_ratio: Math.round(ratio * 1000) / 1000,
        classes_found: Object.keys(map).map(t => (t.match(/\[PHI_([A-Z]+)_\d+\]/) || [])[1]).filter(Boolean),
      });
      continue;
    }
    kept.push(row);
  }
  return { kept, dropped };
}
