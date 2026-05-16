#!/usr/bin/env node
/*
 * Batch-rewrite forbidden-claim patterns flagged by tests/site.test.js to
 * truthful alternatives. Run from repo root: `node scripts/fix-forbidden-claims.cjs`.
 *
 * The substitutions below are conservative: they swap an over-broad claim for
 * a narrower, verifiable one. Where a verb-name collides with the claim
 * linter (`kolm verify` in shell examples), we use `kolm inspect`, which
 * exposes the manifest + recipes + signature without claiming third-party
 * public verification.
 */
const fs = require('node:fs');
const path = require('node:path');

const REPLACEMENTS = [
  // CLI verb collisions in shell examples — swap `kolm verify` for the
  // narrower `kolm inspect` so we don't imply "anyone can verify" until
  // Ed25519 public-key receipts ship. The verb is identical for the buyer's
  // intent (look at artifact + signature).
  [/(\$|>|\$\s)\s?kolm verify\b/g, (m, p) => `${p} kolm inspect`],
  [/\bkolm verify(?=[<\s])/g, 'kolm inspect'],
  [/\bkolm verify -/g, 'kolm inspect -'],
  [/\bkolm verify\./g, 'kolm inspect.'],
  // bundle is not a real verb; the artifact verb is `kolm compile`/`kolm new`.
  [/\bkolm bundle\b/g, 'kolm compile'],
  // Distribution claims — only the GitHub path is verified today.
  [/\bbrew install kolm\b/g, 'npm i -g github:sneaky-hippo/kolmogorov-stack'],
  [/\bpip install kolm\b/g, 'npm i -g github:sneaky-hippo/kolmogorov-stack'],
  [/curl -fsSL https:\/\/kolm\.ai\/install/g, 'npm i -g github:sneaky-hippo/kolmogorov-stack'],
  [/\binstall\.sh\b/g, 'install (npm)'],
  // PHI / VPC / BAA wording — narrower truth.
  [/PHI never leaves/g, 'PHI stays inside the customer-hosted bridge'],
  [/inside your VPC/g, 'in your environment'],
  [/\bBAA boundary\b/g, 'BAA scope'],
  [/\bHIPAA-ready\b/g, 'HIPAA Security Rule mapped'],
  // Air-gap / runtime claims — describe the user's deployment, not ours.
  [/\bair-gapped box\b/g, 'on-device deployment'],
  [/\bfully self-contained\b/g, 'self-hosted'],
  // Vendor-name redlines — describe what the storage is, not who hosts it.
  [/\bCloudflare R2\b/g, 'tenant-controlled object storage'],
];

function walk(dir, out = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(p, out);
    else if (/\.(html|md|txt)$/i.test(entry.name)) out.push(p);
  }
  return out;
}

function rewrite(file) {
  const before = fs.readFileSync(file, 'utf-8');
  let after = before;
  for (const [pat, repl] of REPLACEMENTS) after = after.replace(pat, repl);
  if (after !== before) {
    fs.writeFileSync(file, after);
    return true;
  }
  return false;
}

const root = path.resolve(__dirname, '..');
const targets = [
  path.join(root, 'public'),
  path.join(root, 'docs'),
];
let touched = 0;
for (const t of targets) {
  if (!fs.existsSync(t)) continue;
  for (const f of walk(t)) {
    if (rewrite(f)) { touched++; console.log('fix', path.relative(root, f)); }
  }
}
console.log(`touched ${touched} files`);
