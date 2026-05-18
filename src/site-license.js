// W279 — BYO air-gap enterprise compiler site-license tier.
//
// The hosted tiers (Team / Business / Enterprise) on /pricing cover the
// 99% case: kolm.ai runs the compiler, customers ship .kolm artifacts
// out. Site-license is the explicit additional product for the regulated
// 1%: a copy of the compiler runs inside the customer's network, on
// their hardware, behind their firewall, with zero outbound traffic.
//
// This module is the single source of truth for what tiers exist, what
// the price band is, what is included, and what compliance posture each
// tier supports. The /pricing page reads it (rendered server-side via
// the build step), the /site-license page renders the full matrix, and
// the enterprise inquiry flow uses it to pre-fill the deal form.
//
// Honest scope:
//   - The numbers are price BANDS, not quotes. A real quote depends on
//     org size, support level, and deployment topology — fields the
//     /enterprise/inquiry flow captures.
//   - Compliance certifications listed are the postures the deployment
//     can support given customer-side controls. kolm.ai does not hold
//     the certification on behalf of the customer; the customer's
//     audit-evidence binder includes kolm receipts.

export const SITE_LICENSE_TIERS = Object.freeze([
  Object.freeze({
    id: 'compiler-only',
    name: 'BYO Compiler · Compiler-Only',
    price_band_usd_annual: [250_000, 500_000],
    deployment: 'Air-gapped or DMZ-isolated; customer-controlled hardware',
    included: Object.freeze([
      'kolm compile, distill, verify, redactor binaries for Linux x86_64 + arm64',
      'Signed-receipt verification keyset on customer infra',
      'Offline base-model catalog mirror',
      'Quarterly major-release pinning (no auto-update)',
      'Air-gapped install runbook + signed bootstrap manifest',
    ]),
    excluded: Object.freeze([
      'Training pipeline (separate tier)',
      'Hosted dashboard mirror (separate tier)',
    ]),
    support_sla: 'Business-hours email; named TAM at the upper band',
    compliance_supports: Object.freeze(['HIPAA', 'SOC 2 (customer-side)', 'ITAR-friendly install profile']),
    floor_seats: null,
  }),
  Object.freeze({
    id: 'compiler-plus-training',
    name: 'BYO Compiler · Compiler + Training Pipeline',
    price_band_usd_annual: [500_000, 1_200_000],
    deployment: 'Air-gapped or DMZ-isolated; customer-controlled hardware + GPU pool',
    included: Object.freeze([
      'Everything in Compiler-Only',
      'Training pipeline binaries (distillation, LoRA, INT4 quantization)',
      'Frozen-eval gate + K-score auditor on customer infra',
      'Drift detection cron + supersession chain',
      'On-prem capture corpus retention + redactor with PHI dictionaries',
      'Annual major-release pinning (LTS path)',
    ]),
    excluded: Object.freeze([
      'Customer-side hardware (GPU pool, storage)',
      'White-glove customer model selection (separate consulting SOW)',
    ]),
    support_sla: '24/5 email + Slack-shared channel; named TAM',
    compliance_supports: Object.freeze(['HIPAA', 'SOC 2 (customer-side)', 'HITRUST-friendly profile', 'GDPR data-residency by region']),
    floor_seats: null,
  }),
  Object.freeze({
    id: 'compiler-plus-everything-sla',
    name: 'BYO Compiler · Full Stack + Production SLA',
    price_band_usd_annual: [1_200_000, 2_000_000],
    deployment: 'Air-gapped multi-region; customer-controlled hardware + GPU pool + HA cluster',
    included: Object.freeze([
      'Everything in Compiler + Training Pipeline',
      'Hosted-equivalent dashboard for on-prem (replicated)',
      '24/7 paging tier with 99.5% deploy SLA target',
      'Quarterly compliance evidence package (HIPAA + SOC 2 attest, customer-side)',
      'Custom base-model intake + supply-chain attestation',
      'Customer-named release branch with security patch backports',
    ]),
    excluded: Object.freeze([
      'Customer-side hardware',
      'Classified-environment deployment (separate Defense tier)',
    ]),
    support_sla: '24/7 paging; 15-minute Sev-1 acknowledgment; named TAM + named SRE',
    compliance_supports: Object.freeze(['HIPAA', 'SOC 2', 'HITRUST', 'GDPR', 'PCI-DSS', 'ITAR-friendly install profile']),
    floor_seats: null,
  }),
  Object.freeze({
    id: 'defense',
    name: 'BYO Compiler · Defense / Classified',
    price_band_usd_annual: [1_500_000, 2_500_000],
    deployment: 'SCIF-installable; classified network; physical-media bootstrap',
    included: Object.freeze([
      'Everything in Full Stack + Production SLA',
      'CMMC L3 path documentation + DFARS 7012 alignment',
      'FIPS-friendly receipt mode (HMAC-only, no outbound)',
      'Physical-media (sneakernet) update workflow',
      'Cleared TAM (US persons; reference-checked)',
      'Defense-Industrial-Base distribution agreement',
    ]),
    excluded: Object.freeze([
      'Classification authority (customer\'s responsibility)',
    ]),
    support_sla: '24/7 paging via cleared channels',
    compliance_supports: Object.freeze(['CMMC L3', 'DFARS 7012', 'FedRAMP-Moderate profile', 'ITAR']),
    floor_seats: null,
  }),
]);

export function getSiteLicenseTier(id) {
  if (!id) return null;
  return SITE_LICENSE_TIERS.find(t => t.id === id) || null;
}

// Quote helper — given a tier id and an annual seat count hint, return a
// rough price within the band. Used by the inquiry flow to pre-fill a
// starting number before the deal team takes over.
export function approximateQuote(tierId, opts = {}) {
  const tier = getSiteLicenseTier(tierId);
  if (!tier) return null;
  const [lo, hi] = tier.price_band_usd_annual;
  const seats = Number(opts.seats || 0);
  // Simple linear lerp on a log-ish seat ramp; capped at the band.
  let frac = 0.2;
  if (seats >= 100) frac = 0.4;
  if (seats >= 500) frac = 0.6;
  if (seats >= 2500) frac = 0.85;
  const est = Math.round(lo + (hi - lo) * frac);
  return {
    tier_id: tierId,
    estimate_usd_annual: est,
    band_low: lo,
    band_high: hi,
    band_position: frac,
    note: 'Indicative only. Real quote depends on deployment topology, support tier, and compliance scope.',
  };
}

export function listTierIds() {
  return SITE_LICENSE_TIERS.map(t => t.id);
}

export default {
  SITE_LICENSE_TIERS,
  getSiteLicenseTier,
  approximateQuote,
  listTierIds,
};
