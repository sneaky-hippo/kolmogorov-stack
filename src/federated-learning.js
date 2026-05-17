// Federated learning foundations.
//
// HONEST SCOPE — what this module is and is not:
//
//   IS:
//   - The protocol *contract* and *data shapes* a kolm federated round runs
//     over. Specifies round_id, model_hash, participant_id, delta encoding,
//     contribution receipt fields.
//   - A reference *coordinator-side aggregator* that supports FedAvg, FedSGD,
//     and FedProx-style weighted averaging across N participants who have
//     handed in their local deltas.
//   - A *participant-side helper* that wraps "(start_with_global_state) ->
//     (compute_local_update_however_you_compute_it) -> (sign_and_emit_delta)"
//     so the surface matches everyone else in the round.
//   - Differential-privacy noise helpers (Gaussian and Laplace) with explicit
//     epsilon/delta accounting hooks. The DP budget is the caller's
//     responsibility; this module records what noise was applied so a downstream
//     auditor can compute the resulting privacy cost.
//   - Honest aggregator-side verification of contribution receipts: signature
//     present, model hash matches the round's announced base, delta is the
//     declared shape.
//
//   IS NOT:
//   - A network transport. Participants exchange JSON blobs via whatever
//     channel the tenant runs (HTTPS, mTLS to a hub, S3/GCS dropbox,
//     Cloudflare R2). This module hands you the blob; you ship it.
//   - Secure multi-party computation. There is no MPC primitive here. The
//     aggregator sees individual contributions in cleartext unless the
//     tenant wires a real SecAgg layer below this module.
//   - Production-grade Byzantine robustness. The aggregator detects shape /
//     hash mismatches and per-round duplicate participant IDs; it does not
//     run Krum, Multi-Krum, trimmed mean, or any other Byzantine-resilient
//     aggregator out of the box.
//   - A trained-model output. This module aggregates *deltas*; the training
//     loop that produces a delta lives in the kolm distill worker (Task J).
//
// What "foundations" earns you:
//   - You can stand up a federated round between N kolm tenants today, with
//     real signatures, real round bookkeeping, real DP noise, and a
//     receipt chain. What you *cannot* claim is that the aggregation is
//     cryptographically private (no SecAgg) or Byzantine-robust (no Krum).
//     Both are explicit follow-on waves.

import crypto from 'node:crypto';

export const FL_SPEC_VERSION = 'fl-v1';

// Aggregation strategies the reference aggregator supports.
export const STRATEGIES = Object.freeze({
  FEDAVG:  'fedavg',   // weighted mean of deltas by participant.sample_count
  FEDSGD:  'fedsgd',   // simple mean of deltas (equal weight)
  FEDPROX: 'fedprox',  // FedAvg + proximal-term scaling (uses participant.mu)
});

// What's in a Round? The coordinator broadcasts this before participants
// compute their local updates. Embedded verbatim in every contribution receipt.
export function newRound({ round_id, model_hash, base_artifact_version, target_strategy, target_dp = null, min_participants = 3, deadline = null }) {
  if (!round_id || typeof round_id !== 'string') throw new Error('round_id required');
  if (!model_hash || typeof model_hash !== 'string') throw new Error('model_hash required');
  if (!Object.values(STRATEGIES).includes(target_strategy)) {
    throw new Error(`unknown target_strategy: ${target_strategy}`);
  }
  if (target_dp && (target_dp.epsilon == null || target_dp.delta == null)) {
    throw new Error('target_dp requires { epsilon, delta }');
  }
  return {
    spec: FL_SPEC_VERSION,
    round_id,
    model_hash,
    base_artifact_version: base_artifact_version || null,
    target_strategy,
    target_dp,
    min_participants,
    deadline: deadline || null,
    issued_at: new Date().toISOString(),
  };
}

// Compute the round hash that goes into every participant's receipt so the
// aggregator + verifier can confirm everyone trained against the same base.
export function roundHash(round) {
  return _shortHash(_canonicalize(round));
}

// PARTICIPANT SIDE -------------------------------------------------------
//
// The participant (each kolm tenant) is given a Round and produces a
// Contribution. The local training step is opaque to this module — you hand
// us the delta tensor (in our compact representation), the sample_count, and
// optionally a mu (for FedProx). We add the signature + receipt fields.

// Build a contribution. `delta` is a plain object — keys are tensor names,
// values are 1-D numeric arrays of update values. Shape and key names must
// match what the round's base model expects; the aggregator checks this.
//
// `private_key` is an Ed25519 PEM. The contribution is signed so the
// aggregator + downstream auditor can confirm provenance.
export function buildContribution({ round, participant_id, delta, sample_count, mu, private_key, dp_applied }) {
  if (!round || round.spec !== FL_SPEC_VERSION) throw new Error('invalid round');
  if (!participant_id || typeof participant_id !== 'string') throw new Error('participant_id required');
  if (!delta || typeof delta !== 'object' || Array.isArray(delta)) throw new Error('delta must be an object');
  if (sample_count == null || sample_count < 0) throw new Error('sample_count required');
  if (round.target_strategy === STRATEGIES.FEDPROX && (mu == null || mu < 0)) {
    throw new Error('fedprox requires mu >= 0');
  }
  const r_hash = roundHash(round);
  const d_hash = _shortHash(_canonicalize(delta));
  const dp = dp_applied ? {
    mechanism: dp_applied.mechanism,
    noise_scale: dp_applied.noise_scale,
    sensitivity: dp_applied.sensitivity,
    epsilon_spent: dp_applied.epsilon_spent,
    delta_spent: dp_applied.delta_spent,
  } : null;
  const base = {
    spec: FL_SPEC_VERSION,
    round_id: round.round_id,
    round_hash: r_hash,
    participant_id,
    sample_count,
    mu: mu == null ? null : mu,
    delta_hash: d_hash,
    delta_shapes: _shapesOf(delta),
    dp_applied: dp,
    submitted_at: new Date().toISOString(),
  };
  base.signature = private_key ? _sign(_canonicalize(base), private_key) : null;
  // Delta is attached separately so it can travel as a binary attachment
  // when the receipt itself is logged. Round-tripped together in tests.
  return { receipt: base, delta };
}

// AGGREGATOR SIDE --------------------------------------------------------
//
// The coordinator collects N contributions, verifies them, and applies the
// chosen strategy to produce a single aggregated delta to broadcast back.

export function verifyContribution({ contribution, round, public_key }) {
  if (!contribution || !contribution.receipt) return { ok: false, reason: 'no_receipt' };
  const r = contribution.receipt;
  if (r.spec !== FL_SPEC_VERSION) return { ok: false, reason: 'spec_mismatch' };
  if (r.round_id !== round.round_id) return { ok: false, reason: 'wrong_round_id' };
  if (r.round_hash !== roundHash(round)) return { ok: false, reason: 'round_hash_mismatch' };
  const recomputed_delta = _shortHash(_canonicalize(contribution.delta));
  if (recomputed_delta !== r.delta_hash) return { ok: false, reason: 'delta_hash_mismatch' };
  const shapes = _shapesOf(contribution.delta);
  if (_canonicalize(shapes) !== _canonicalize(r.delta_shapes)) return { ok: false, reason: 'shape_mismatch' };
  if (public_key) {
    const { signature, ...unsigned } = r;
    const sigOk = _verify(_canonicalize(unsigned), signature, public_key);
    if (!sigOk) return { ok: false, reason: 'signature_failed' };
  }
  return { ok: true };
}

// FedAvg / FedSGD / FedProx in pure JS. Inputs are an array of verified
// contributions (use verifyContribution first; the aggregator should refuse
// to fold in anything that didn't pass). Returns the aggregated delta in
// the same shape as the inputs, plus the receipt the aggregator publishes.
export function aggregate({ round, contributions }) {
  if (!round || round.spec !== FL_SPEC_VERSION) throw new Error('invalid round');
  if (!Array.isArray(contributions) || contributions.length === 0) {
    throw new Error('contributions must be a non-empty array');
  }
  if (contributions.length < round.min_participants) {
    throw new Error(`too few participants: ${contributions.length} < min ${round.min_participants}`);
  }
  // Reject duplicate participant_ids — basic sybil guard, NOT a real
  // Byzantine defense.
  const seen = new Set();
  for (const c of contributions) {
    if (seen.has(c.receipt.participant_id)) {
      throw new Error(`duplicate participant_id: ${c.receipt.participant_id}`);
    }
    seen.add(c.receipt.participant_id);
  }

  const first = contributions[0].delta;
  const keys = Object.keys(first).sort();
  // Initialize accumulator with zeros matching shape of first contribution.
  const acc = {};
  for (const k of keys) acc[k] = new Array(first[k].length).fill(0);

  const total_weight = _totalWeight(round.target_strategy, contributions);

  for (const c of contributions) {
    const w = _participantWeight(round.target_strategy, c) / total_weight;
    for (const k of keys) {
      const v = c.delta[k];
      if (!v || v.length !== acc[k].length) throw new Error(`shape mismatch for key ${k} in participant ${c.receipt.participant_id}`);
      for (let i = 0; i < v.length; i++) acc[k][i] += w * v[i];
    }
  }

  const aggregated_delta = acc;
  const aggregated_hash = _shortHash(_canonicalize(aggregated_delta));
  const dp_summary = _summarizeDp(contributions);

  const receipt = {
    spec: FL_SPEC_VERSION,
    round_id: round.round_id,
    round_hash: roundHash(round),
    strategy: round.target_strategy,
    participant_count: contributions.length,
    participant_ids: contributions.map(c => c.receipt.participant_id).sort(),
    total_samples: contributions.reduce((s, c) => s + (c.receipt.sample_count || 0), 0),
    aggregated_delta_hash: aggregated_hash,
    aggregated_at: new Date().toISOString(),
    dp_summary,
  };
  return { receipt, aggregated_delta };
}

function _participantWeight(strategy, c) {
  switch (strategy) {
    case STRATEGIES.FEDAVG:  return Math.max(1, c.receipt.sample_count || 1);
    case STRATEGIES.FEDSGD:  return 1;
    case STRATEGIES.FEDPROX: return Math.max(1, c.receipt.sample_count || 1) * (1 + (c.receipt.mu || 0));
    default: return 1;
  }
}
function _totalWeight(strategy, contributions) {
  return contributions.reduce((s, c) => s + _participantWeight(strategy, c), 0);
}

function _summarizeDp(contributions) {
  const applied = contributions.filter(c => c.receipt.dp_applied);
  if (applied.length === 0) return null;
  return {
    participants_with_dp: applied.length,
    epsilon_min: Math.min(...applied.map(c => c.receipt.dp_applied.epsilon_spent || Infinity)),
    epsilon_max: Math.max(...applied.map(c => c.receipt.dp_applied.epsilon_spent || 0)),
    mechanisms: Array.from(new Set(applied.map(c => c.receipt.dp_applied.mechanism))).sort(),
    note: 'Per-round DP bookkeeping is the participant\'s responsibility. The aggregator surfaces what was claimed; it does not recompute the budget.',
  };
}

// DIFFERENTIAL PRIVACY HELPERS ------------------------------------------
//
// Gaussian and Laplace noise injection. The CALLER is responsible for the
// privacy budget (epsilon, delta) bookkeeping. These helpers add the noise
// and emit the dp_applied record that the participant attaches to their
// receipt — they DO NOT track cumulative budget across rounds.

// Gaussian mechanism: noise ~ N(0, (sensitivity * sigma)^2). Returns the
// noised array and the dp_applied record.
export function applyGaussianNoise(array, { sensitivity, sigma, epsilon_spent, delta_spent }) {
  if (!Array.isArray(array)) throw new Error('array required');
  if (sensitivity == null || sigma == null) throw new Error('sensitivity + sigma required');
  const out = new Array(array.length);
  for (let i = 0; i < array.length; i++) {
    out[i] = array[i] + _gaussian() * sensitivity * sigma;
  }
  return {
    noised: out,
    dp_applied: {
      mechanism: 'gaussian',
      noise_scale: sensitivity * sigma,
      sensitivity,
      sigma,
      epsilon_spent: epsilon_spent ?? null,
      delta_spent: delta_spent ?? null,
    },
  };
}

// Laplace mechanism: noise ~ Lap(0, sensitivity / epsilon). Epsilon required.
export function applyLaplaceNoise(array, { sensitivity, epsilon, epsilon_spent }) {
  if (!Array.isArray(array)) throw new Error('array required');
  if (sensitivity == null || epsilon == null) throw new Error('sensitivity + epsilon required');
  const scale = sensitivity / epsilon;
  const out = new Array(array.length);
  for (let i = 0; i < array.length; i++) {
    out[i] = array[i] + _laplace(scale);
  }
  return {
    noised: out,
    dp_applied: {
      mechanism: 'laplace',
      noise_scale: scale,
      sensitivity,
      epsilon,
      epsilon_spent: epsilon_spent ?? epsilon,
      delta_spent: 0,
    },
  };
}

// Approximate clipping for per-example gradient norms. Standard sanity step
// before DP noise injection. Operates in place on a single 1-D array.
export function clipNorm(array, max_norm) {
  if (!Array.isArray(array)) throw new Error('array required');
  if (!(max_norm > 0)) throw new Error('max_norm must be > 0');
  let sq = 0;
  for (const v of array) sq += v * v;
  const norm = Math.sqrt(sq);
  if (norm <= max_norm) return { clipped: array.slice(), clip_applied: false, original_norm: norm };
  const scale = max_norm / norm;
  const clipped = array.map(v => v * scale);
  return { clipped, clip_applied: true, original_norm: norm, max_norm };
}

// INTERNALS --------------------------------------------------------------

function _shortHash(s) { return crypto.createHash('sha256').update(s).digest('hex').slice(0, 16); }
function _canonicalize(v) {
  if (v === null || typeof v !== 'object') return JSON.stringify(v);
  if (Array.isArray(v)) return '[' + v.map(_canonicalize).join(',') + ']';
  const keys = Object.keys(v).sort();
  return '{' + keys.map(k => JSON.stringify(k) + ':' + _canonicalize(v[k])).join(',') + '}';
}
function _shapesOf(delta) {
  const out = {};
  for (const k of Object.keys(delta).sort()) {
    out[k] = Array.isArray(delta[k]) ? [delta[k].length] : null;
  }
  return out;
}
function _gaussian() {
  // Box-Muller. Pulls fresh randomness; not seeded.
  let u = 0, v = 0;
  while (u === 0) u = Math.random();
  while (v === 0) v = Math.random();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}
function _laplace(scale) {
  const u = Math.random() - 0.5;
  return -scale * Math.sign(u) * Math.log(1 - 2 * Math.abs(u));
}

function _sign(payload, privKeyPem) {
  const key = crypto.createPrivateKey(privKeyPem);
  const sig = crypto.sign(null, Buffer.from(payload, 'utf8'), key);
  return sig.toString('base64');
}
function _verify(payload, sigB64, pubKeyPem) {
  if (!sigB64) return false;
  try {
    const key = crypto.createPublicKey(pubKeyPem);
    return crypto.verify(null, Buffer.from(payload, 'utf8'), key, Buffer.from(sigB64, 'base64'));
  } catch { return false; }
}

// Tiny helper for tests — generate an ephemeral Ed25519 keypair.
// Returns snake_case keys to match the rest of the FL module's API
// (buildContribution takes `private_key`; verifyContribution takes `public_key`).
export function generateKeypair() {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519', { publicKeyEncoding: { type: 'spki', format: 'pem' }, privateKeyEncoding: { type: 'pkcs8', format: 'pem' } });
  return { public_key: publicKey, private_key: privateKey };
}

export default {
  FL_SPEC_VERSION,
  STRATEGIES,
  newRound,
  roundHash,
  buildContribution,
  verifyContribution,
  aggregate,
  applyGaussianNoise,
  applyLaplaceNoise,
  clipNorm,
  generateKeypair,
};
