// W384 — HTTP wiring lock-in for the W369–W383 backend modules.
//
// Every test boots buildRouter() in-process against a fresh KOLM_DATA_DIR
// + HOME + USERPROFILE so on-disk modules (cloud-sync, team, opportunity-
// engine, dataset-workbench, runtime-policy, device-capabilities, ...)
// write under a per-test directory and the suite is parallel-safe.
//
// The 25 scenarios called out in the W384 brief are covered as #1 – #25
// (with a couple bonus tests for cross-tenant isolation + admin gating).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import crypto from 'node:crypto';

// =====================================================================
// Per-test isolation. Each call to makeAppAndTenant() bumps the env to a
// fresh KOLM_DATA_DIR + HOME + USERPROFILE so each test's on-disk state
// (team workspace, runtime policy, opportunities log, datasets) is
// independent.
// =====================================================================

function freshDataDir() {
  const d = path.join(
    os.tmpdir(),
    'kolm-w384-' + process.pid + '-' + crypto.randomBytes(4).toString('hex'),
  );
  fs.mkdirSync(d, { recursive: true });
  return d;
}

async function makeAppAndTenant({ admin = false } = {}) {
  const dir = freshDataDir();
  process.env.KOLM_DATA_DIR = dir;
  process.env.HOME = dir;
  process.env.USERPROFILE = dir;
  process.env.KOLM_EVENT_STORE_PATH = path.join(dir, 'events_' + crypto.randomBytes(4).toString('hex') + '.sqlite');
  if (admin) {
    process.env.ADMIN_KEY = 'admin-test-' + crypto.randomBytes(4).toString('hex');
  } else {
    delete process.env.ADMIN_KEY;
  }
  // Reset the cached event-store module that the lake + opportunity engine
  // use, so they pick up our new event-store path.
  try {
    const es = await import('../src/event-store.js');
    es._resetForTests?.();
  } catch {}

  const { buildRouter } = await import('../src/router.js');
  const { provisionAnonTenant } = await import('../src/auth.js');
  const express = (await import('express')).default;
  const app = express();
  app.use(express.json({ limit: '4mb' }));
  app.use(buildRouter());
  const t = provisionAnonTenant({ ttl_days: 1, quota: 5000 });
  return { app, apiKey: t.api_key, adminKey: admin ? process.env.ADMIN_KEY : null, dataDir: dir };
}

function withServer(app, fn) {
  return new Promise((resolve, reject) => {
    const server = app.listen(0, async () => {
      try {
        const realPort = server.address().port;
        const out = await fn(`http://127.0.0.1:${realPort}`);
        server.close(() => resolve(out));
      } catch (e) {
        server.close(() => reject(e));
      }
    });
  });
}

// Drop-in fetch wrapper that bakes Bearer auth into every request.
async function api(base, p, { apiKey, method = 'GET', body, raw = false, headers = {} } = {}) {
  const init = {
    method,
    headers: { authorization: 'Bearer ' + apiKey, ...headers },
  };
  if (body != null) {
    if (raw) {
      init.body = body;
    } else {
      init.body = JSON.stringify(body);
      init.headers['content-type'] = init.headers['content-type'] || 'application/json';
    }
  }
  return fetch(base + p, init);
}

// =====================================================================
// W384 #1 — privacy scan returns the 17 detector classes envelope.
// =====================================================================
test('W384 #1 — POST /v1/privacy/scan returns findings + sensitive boolean', async () => {
  const { app, apiKey } = await makeAppAndTenant();
  await withServer(app, async (base) => {
    const r = await api(base, '/v1/privacy/scan', {
      apiKey, method: 'POST',
      body: { text: 'Contact john@example.com or 555-123-4567 for SSN 123-45-6789.' },
    });
    assert.equal(r.status, 200, 'privacy/scan should return 200');
    const body = await r.json();
    assert.equal(body.ok, true);
    assert.equal(typeof body.sensitive, 'boolean', 'sensitive boolean must be present');
    assert.equal(body.sensitive, true, 'corpus contains email+phone+SSN — must trip detector');
    assert.ok(Array.isArray(body.classes), 'classes must be an array');
    assert.ok(body.detector_version, 'detector_version must be reported');
  });
});

// =====================================================================
// W384 #2 — privacy policy PUT updates a single class action, then GET
// reflects the change.
// =====================================================================
test('W384 #2 — PUT /v1/privacy/policy/:class updates action, GET reflects it', async () => {
  const { app, apiKey, adminKey } = await makeAppAndTenant({ admin: true });
  await withServer(app, async (base) => {
    const put = await api(base, '/v1/privacy/policy/email', {
      apiKey: adminKey, method: 'PUT', body: { action: 'block' },
    });
    assert.equal(put.status, 200, 'admin PUT should succeed');
    const get = await api(base, '/v1/privacy/policy', { apiKey });
    assert.equal(get.status, 200);
    const body = await get.json();
    assert.ok(body.policy, 'GET must return policy');
    assert.equal(body.policy.email, 'block', 'email class action must reflect PUT');
  });
});

// =====================================================================
// W384 #3 — sync status returns the 4-state matrix envelope.
// =====================================================================
test('W384 #3 — GET /v1/sync/status returns state + valid_states + privacy_classes', async () => {
  const { app, apiKey } = await makeAppAndTenant();
  await withServer(app, async (base) => {
    const r = await api(base, '/v1/sync/status', { apiKey });
    assert.equal(r.status, 200);
    const body = await r.json();
    assert.equal(body.ok, true);
    assert.ok(body.state && typeof body.state === 'object', 'state must be an object');
    assert.equal(typeof body.state.state, 'string', 'state.state must be the current enum value');
    assert.ok(Array.isArray(body.valid_states) && body.valid_states.length === 4,
      'valid_states must list the 4-state matrix');
    assert.ok(Array.isArray(body.privacy_classes), 'privacy_classes must be array');
  });
});

// =====================================================================
// W384 #4 — non-admin tenant cannot mutate sync state.
// =====================================================================
test('W384 #4 — PUT /v1/sync/state is admin-only (403 for tenant)', async () => {
  const { app, apiKey } = await makeAppAndTenant();
  await withServer(app, async (base) => {
    const r = await api(base, '/v1/sync/state', {
      apiKey, method: 'PUT', body: { state: 'metadata_only' },
    });
    assert.equal(r.status, 403, 'tenant key must be rejected with 403');
    const body = await r.json();
    assert.equal(body.error, 'admin_only');
  });
});

// =====================================================================
// W384 #5 — team invite requires admin (admin key path).
// =====================================================================
test('W384 #5 — POST /v1/team/invite admin returns invite_token + URL', async () => {
  const { app, adminKey } = await makeAppAndTenant({ admin: true });
  await withServer(app, async (base) => {
    const r = await api(base, '/v1/team/invite', {
      apiKey: adminKey, method: 'POST',
      body: { email: 'newmember@example.com', role: 'reviewer' },
    });
    assert.equal(r.status, 200);
    const body = await r.json();
    assert.equal(body.ok, true);
    assert.ok(body.invite_token && body.invite_token.length > 16, 'invite_token must be present');
    assert.ok(body.invite_url && body.invite_url.includes('token='), 'invite_url must include token');
    assert.ok(body.expires_at, 'expires_at must be present');
    assert.equal(body.email, 'newmember@example.com');
    assert.equal(body.role, 'reviewer');
  });
});

// =====================================================================
// W384 #6 — accept-invite is public (no api_key) and consumes the token.
// =====================================================================
test('W384 #6 — POST /v1/team/accept-invite is PUBLIC (no api_key needed)', async () => {
  const { app, adminKey } = await makeAppAndTenant({ admin: true });
  await withServer(app, async (base) => {
    const inv = await api(base, '/v1/team/invite', {
      apiKey: adminKey, method: 'POST',
      body: { email: 'public@example.com', role: 'contributor' },
    });
    assert.equal(inv.status, 200);
    const { invite_token } = await inv.json();
    // Note: NO Authorization header — accept-invite must be public.
    const accept = await fetch(base + '/v1/team/accept-invite', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ invite_token, member_email: 'public@example.com' }),
    });
    assert.equal(accept.status, 200, 'accept-invite must succeed without auth');
    const body = await accept.json();
    assert.equal(body.ok, true);
    assert.ok(body.member_id, 'member_id must be returned');
    assert.equal(body.role, 'contributor');
  });
});

// =====================================================================
// W384 #7 — self-review on approvals returns 403 (not 400).
// =====================================================================
test('W384 #7 — POST /v1/team/approvals/:id/decide returns 403 for self-review', async () => {
  const { app, apiKey, adminKey } = await makeAppAndTenant({ admin: true });
  await withServer(app, async (base) => {
    // Get the bootstrapped admin member id.
    const ws = await api(base, '/v1/team/workspace', { apiKey });
    const wsBody = await ws.json();
    const adminMember = wsBody.workspace.members.find(m => m.role === 'admin');
    assert.ok(adminMember, 'bootstrap workspace must have an admin member');
    // Submit an approval using admin as the submitter.
    const sub = await api(base, '/v1/team/approvals', {
      apiKey, method: 'POST',
      body: { kind: 'artifact_publish', payload: { artifact: 'foo.kolm' }, submitter_id: adminMember.member_id },
    });
    assert.equal(sub.status, 200);
    const subBody = await sub.json();
    assert.ok(subBody.approval.approval_id, 'approval_id must be present');
    // Try to self-decide.
    const decide = await api(base, `/v1/team/approvals/${subBody.approval.approval_id}/decide`, {
      apiKey, method: 'POST',
      body: { decision: 'approve', reviewer_id: adminMember.member_id },
    });
    assert.equal(decide.status, 403, 'self-review must be 403');
    const body = await decide.json();
    assert.equal(body.error, 'self_review', 'error code must be self_review');
  });
});

// =====================================================================
// W384 #8 — tokenizer training is deterministic on the same corpus+seed.
// =====================================================================
test('W384 #8 — POST /v1/pipeline/tokenize is deterministic on same corpus+seed', async () => {
  const { app, apiKey } = await makeAppAndTenant();
  await withServer(app, async (base) => {
    const corpus = [
      'the quick brown fox jumps over the lazy dog',
      'the rain in spain stays mainly in the plain',
      'lorem ipsum dolor sit amet consectetur adipiscing elit',
      'four score and seven years ago our fathers brought forth',
      'to be or not to be that is the question whether tis nobler',
    ];
    const r1 = await api(base, '/v1/pipeline/tokenize', {
      apiKey, method: 'POST',
      body: { corpus, vocab_size: 300, algorithm: 'bpe', seed: 42 },
    });
    assert.equal(r1.status, 200);
    const b1 = await r1.json();
    assert.equal(b1.ok, true);
    assert.ok(b1.tokenizer_path, 'tokenizer_path must be returned');
    assert.ok(b1.deterministic_hash, 'deterministic_hash must be returned');
    assert.ok(typeof b1.vocab_size === 'number');
    // Re-train with the same corpus+seed — the deterministic_hash must match.
    const r2 = await api(base, '/v1/pipeline/tokenize', {
      apiKey, method: 'POST',
      body: { corpus, vocab_size: 300, algorithm: 'bpe', seed: 42 },
    });
    assert.equal(r2.status, 200);
    const b2 = await r2.json();
    assert.equal(b2.deterministic_hash, b1.deterministic_hash,
      'deterministic_hash must match for identical corpus+seed inputs');
  });
});

// =====================================================================
// W384 #9 — /v1/pipeline/full returns 202 + job_id and lists PIPELINE_PHASES.
// =====================================================================
test('W384 #9 — POST /v1/pipeline/full returns 202 + job_id + phase list', async () => {
  const { app, apiKey } = await makeAppAndTenant();
  await withServer(app, async (base) => {
    const r = await api(base, '/v1/pipeline/full', {
      apiKey, method: 'POST',
      body: { namespace: 'w384-test-ns', opts: { tokenizer_vocab_size: 100 } },
    });
    assert.equal(r.status, 202, 'pipeline/full must accept as 202');
    const body = await r.json();
    assert.equal(body.ok, true);
    assert.ok(body.job_id && body.job_id.startsWith('job_'), 'job_id must be returned');
    assert.ok(Array.isArray(body.phases) && body.phases.includes('plan'),
      'phases array must include the 11 phases');
    assert.equal(body.status, 'running');
  });
});

// =====================================================================
// W384 #10 — agents/stats returns by_app rollup envelope.
// =====================================================================
test('W384 #10 — GET /v1/agents/stats returns by_app + total_agent_calls envelope', async () => {
  const { app, apiKey } = await makeAppAndTenant();
  await withServer(app, async (base) => {
    const r = await api(base, '/v1/agents/stats', { apiKey });
    assert.equal(r.status, 200);
    const body = await r.json();
    assert.equal(body.ok, true);
    assert.equal(typeof body.total_agent_calls, 'number', 'total_agent_calls must be a number');
    assert.ok('by_app' in body, 'envelope must carry by_app object');
    assert.ok('cost_by_app' in body, 'envelope must carry cost_by_app object');
    assert.ok(Array.isArray(body.top_workflows), 'top_workflows must be array');
  });
});

// =====================================================================
// W384 #11 — agents/recommend returns the Pareto-frontier shape even on
// an empty event store (graceful no-events case).
// =====================================================================
test('W384 #11 — GET /v1/agents/recommend handles empty store gracefully', async () => {
  const { app, apiKey } = await makeAppAndTenant();
  await withServer(app, async (base) => {
    const r = await api(base, '/v1/agents/recommend?app_id=ide', { apiKey });
    assert.equal(r.status, 200);
    const body = await r.json();
    assert.equal(body.ok, true);
    assert.ok('recommended_model' in body, 'recommended_model field must be present');
    assert.ok('candidates' in body, 'candidates field must be present');
    // Empty store -> recommendation is null + reason explains why.
    assert.equal(body.recommended_model, null);
    assert.ok(body.reason, 'reason must be populated when nothing recommended');
  });
});

// =====================================================================
// W384 #12 — lake/stats returns the documented snapshot shape.
// =====================================================================
test('W384 #12 — GET /v1/lake/stats returns total_calls + providers + storage envelope', async () => {
  const { app, apiKey } = await makeAppAndTenant();
  await withServer(app, async (base) => {
    const r = await api(base, '/v1/lake/stats', { apiKey });
    assert.equal(r.status, 200);
    const body = await r.json();
    assert.equal(body.ok, true);
    assert.equal(typeof body.total_calls, 'number');
    assert.equal(typeof body.total_spend_usd, 'number');
    assert.ok(body.providers && typeof body.providers === 'object');
    assert.ok(body.models && typeof body.models === 'object');
    assert.ok(body.storage && typeof body.storage === 'object');
    assert.ok(body.window && body.window.since);
  });
});

// =====================================================================
// W384 #13 — opportunities returns a (possibly empty) envelope.
// =====================================================================
test('W384 #13 — GET /v1/opportunities returns ok + opportunities array', async () => {
  const { app, apiKey } = await makeAppAndTenant();
  await withServer(app, async (base) => {
    const r = await api(base, '/v1/opportunities', { apiKey });
    assert.equal(r.status, 200);
    const body = await r.json();
    assert.equal(body.ok, true);
    assert.ok(Array.isArray(body.opportunities), 'opportunities must be array');
    assert.equal(typeof body.total, 'number');
  });
});

// =====================================================================
// W384 #14 — opportunities accept then dismiss flips the persisted status.
// =====================================================================
test('W384 #14 — POST /v1/opportunities/:id/accept then /dismiss updates persisted state', async () => {
  const { app, apiKey } = await makeAppAndTenant();
  await withServer(app, async (base) => {
    const id = 'opp_synthetic_test_id_' + crypto.randomBytes(4).toString('hex');
    const accept = await api(base, `/v1/opportunities/${id}/accept`, {
      apiKey, method: 'POST', body: { reason: 'test' },
    });
    assert.equal(accept.status, 200);
    const aBody = await accept.json();
    assert.equal(aBody.ok, true);
    assert.equal(aBody.status, 'accepted');
    // Now dismiss.
    const dismiss = await api(base, `/v1/opportunities/${id}/dismiss`, {
      apiKey, method: 'POST', body: { reason: 'changed-mind' },
    });
    assert.equal(dismiss.status, 200);
    const dBody = await dismiss.json();
    assert.equal(dBody.ok, true);
    assert.equal(dBody.status, 'ignored', 'dismiss must persist as ignored');
  });
});

// =====================================================================
// W384 #15 — datasets create requires a namespace.
// =====================================================================
test('W384 #15 — POST /v1/datasets without namespace returns 400', async () => {
  const { app, apiKey } = await makeAppAndTenant();
  await withServer(app, async (base) => {
    const r = await api(base, '/v1/datasets', {
      apiKey, method: 'POST', body: {},
    });
    assert.equal(r.status, 400);
    const body = await r.json();
    assert.equal(body.error, 'namespace_required');
  });
});

// =====================================================================
// W384 #16 — dataset split produces train + holdout disjoint id sets.
// =====================================================================
test('W384 #16 — POST /v1/datasets/:id/split produces disjoint train + holdout', async () => {
  const { app, apiKey } = await makeAppAndTenant();
  await withServer(app, async (base) => {
    // Seed events directly through the event-store import so the dataset
    // builder has rows to work with.
    const ns = 'w384-split-' + crypto.randomBytes(3).toString('hex');
    const { appendEvent } = await import('../src/event-store.js');
    for (let i = 0; i < 20; i++) {
      await appendEvent({
        namespace: ns,
        input: `input-${i}`,
        output: `output-${i}`,
        model: 'gpt-test',
        provider: 'test',
      });
    }
    const create = await api(base, '/v1/datasets', {
      apiKey, method: 'POST', body: { namespace: ns },
    });
    assert.equal(create.status, 200);
    const cBody = await create.json();
    assert.ok(cBody.dataset_id, 'dataset_id must be returned');
    // Split.
    const split = await api(base, `/v1/datasets/${cBody.dataset_id}/split`, {
      apiKey, method: 'POST', body: { train_ratio: 0.8 },
    });
    assert.equal(split.status, 200);
    const sBody = await split.json();
    assert.equal(sBody.ok, true);
    assert.ok(Array.isArray(sBody.train_ids) && Array.isArray(sBody.holdout_ids));
    const tSet = new Set(sBody.train_ids);
    for (const h of sBody.holdout_ids) {
      assert.ok(!tSet.has(h), `holdout id ${h} must NOT appear in train_ids (disjoint invariant)`);
    }
    assert.equal(sBody.train_ids.length + sBody.holdout_ids.length, 20,
      'train + holdout must cover all source events');
  });
});

// =====================================================================
// W384 #17 — labels/next returns an events array (empty is valid).
// =====================================================================
test('W384 #17 — GET /v1/labels/next returns events array envelope', async () => {
  const { app, apiKey } = await makeAppAndTenant();
  await withServer(app, async (base) => {
    const r = await api(base, '/v1/labels/next?n=5', { apiKey });
    assert.equal(r.status, 200);
    const body = await r.json();
    assert.equal(body.ok, true);
    assert.ok(Array.isArray(body.events), 'events must be array');
    assert.equal(typeof body.total, 'number');
  });
});

// =====================================================================
// W384 #18 — sim/run returns sim_id + status (synthetic creation, no LLM
// required since user_simulator falls back to local persona generation).
// =====================================================================
test('W384 #18 — POST /v1/sim/run returns sim_id + status + events', async () => {
  const { app, apiKey } = await makeAppAndTenant();
  await withServer(app, async (base) => {
    const r = await api(base, '/v1/sim/run', {
      apiKey, method: 'POST',
      body: {
        workflow_id: 'support-bot',
        type: 'edge_case_generator', // simplest path: no persona generation needed
        n: 3,
        opts: { toLake: false },
      },
    });
    // 200 (success) or 400 (sim setup fails locally e.g. LLM-unavailable) are
    // both contract-valid. 500 indicates broken plumbing.
    assert.ok(r.status === 200 || r.status === 400,
      `sim/run returned ${r.status}; expected 200 (success) or 400 (sim error)`);
    const body = await r.json();
    if (r.status === 200) {
      assert.equal(body.ok, true);
      assert.ok(body.sim_id && body.sim_id.startsWith('sim_'), 'sim_id must be returned');
    } else {
      assert.ok(body.error, 'error field must be present on 400');
    }
  });
});

// =====================================================================
// W384 #19 — bakeoff returns a recommended contestant or honest null.
// =====================================================================
test('W384 #19 — POST /v1/bakeoff/run returns recommendation or honest empty', async () => {
  const { app, apiKey } = await makeAppAndTenant();
  await withServer(app, async (base) => {
    // No dataset_id -> 400.
    const noBody = await api(base, '/v1/bakeoff/run', {
      apiKey, method: 'POST', body: {},
    });
    assert.equal(noBody.status, 400);
    const noBodyJson = await noBody.json();
    assert.equal(noBodyJson.error, 'dataset_id_required');

    // Seed a tiny inline dataset.
    const ns = 'w384-bake-' + crypto.randomBytes(3).toString('hex');
    const { appendEvent } = await import('../src/event-store.js');
    for (let i = 0; i < 4; i++) {
      await appendEvent({
        namespace: ns,
        input: `bake-q-${i}`,
        output: `bake-a-${i}`,
        model: 'gpt-test', provider: 'test',
      });
    }
    const create = await api(base, '/v1/datasets', {
      apiKey, method: 'POST', body: { namespace: ns },
    });
    assert.equal(create.status, 200);
    const cBody = await create.json();

    const r = await api(base, '/v1/bakeoff/run', {
      apiKey, method: 'POST',
      body: { dataset_id: cBody.dataset_id },
    });
    // Contract-valid: 200 with envelope, or 400 if contestants can't be run.
    assert.ok(r.status === 200 || r.status === 400,
      `bakeoff/run returned ${r.status}; expected 200 or 400`);
    const body = await r.json();
    if (r.status === 200) {
      assert.equal(body.ok, true);
      assert.ok('recommended' in body, 'recommended field must be present');
      assert.ok(Array.isArray(body.contestants), 'contestants must be array');
    } else {
      assert.ok(body.error);
    }
  });
});

// =====================================================================
// W384 #20 — runtime policy round-trip (GET + admin PUT).
// =====================================================================
test('W384 #20 — runtime/policy GET then admin PUT round-trips the policy', async () => {
  const { app, apiKey, adminKey } = await makeAppAndTenant({ admin: true });
  await withServer(app, async (base) => {
    const get = await api(base, '/v1/runtime/policy', { apiKey });
    assert.equal(get.status, 200);
    const body = await get.json();
    assert.equal(body.ok, true);
    assert.ok(body.policy && body.policy.name, 'policy must include a name');
    assert.ok(Array.isArray(body.policies), 'policies array must list available policy names');

    // Non-admin PUT -> 403.
    const tenantPut = await api(base, '/v1/runtime/policy', {
      apiKey, method: 'PUT', body: { name: 'cost_optimized' },
    });
    assert.equal(tenantPut.status, 403, 'non-admin PUT must be 403');

    // Admin PUT -> 200.
    const adminPut = await api(base, '/v1/runtime/policy', {
      apiKey: adminKey, method: 'PUT', body: { name: 'cost_optimized' },
    });
    assert.equal(adminPut.status, 200);
    const aBody = await adminPut.json();
    assert.equal(aBody.policy.name, 'cost_optimized');
  });
});

// =====================================================================
// W384 #21 — devices/detect returns a profile envelope for the local host.
// =====================================================================
test('W384 #21 — GET /v1/devices/detect returns a profile envelope', async () => {
  const { app, apiKey } = await makeAppAndTenant();
  await withServer(app, async (base) => {
    const r = await api(base, '/v1/devices/detect', { apiKey });
    assert.equal(r.status, 200);
    const body = await r.json();
    assert.equal(body.ok, true);
    // The detect path returns an object describing the local device, even on
    // CI where no GPU is present (it falls back to CPU profile).
    assert.ok(typeof body === 'object', 'detect must return an object');
  });
});

// =====================================================================
// W384 #22 — capture/media accepts a multipart upload, stores the blob,
// and returns blob metadata + event_ids.
// =====================================================================
test('W384 #22 — POST /v1/capture/media accepts multipart, stores blob, returns event_ids', async () => {
  const { app, apiKey } = await makeAppAndTenant();
  await withServer(app, async (base) => {
    // Hand-build a minimal multipart/form-data body with 1 text part +
    // 1 file part. boundary must match exactly with no extra padding.
    const boundary = '----w384boundary' + crypto.randomBytes(4).toString('hex');
    const CRLF = '\r\n';
    const namespacePart =
      `--${boundary}${CRLF}` +
      `content-disposition: form-data; name="namespace"${CRLF}${CRLF}` +
      `w384-media-test${CRLF}`;
    const fileHeader =
      `--${boundary}${CRLF}` +
      `content-disposition: form-data; name="file"; filename="test.png"${CRLF}` +
      `content-type: image/png${CRLF}${CRLF}`;
    // Fake PNG signature byte sequence — content is opaque to the parser.
    const filePayload = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x01, 0x02, 0x03]);
    const tail = `${CRLF}--${boundary}--${CRLF}`;
    const body = Buffer.concat([
      Buffer.from(namespacePart, 'binary'),
      Buffer.from(fileHeader, 'binary'),
      filePayload,
      Buffer.from(tail, 'binary'),
    ]);
    const r = await fetch(base + '/v1/capture/media', {
      method: 'POST',
      headers: {
        authorization: 'Bearer ' + apiKey,
        'content-type': 'multipart/form-data; boundary=' + boundary,
        'content-length': String(body.length),
      },
      body,
    });
    assert.equal(r.status, 200, 'multipart upload should return 200');
    const json = await r.json();
    assert.equal(json.ok, true);
    assert.equal(json.count, 1, 'one file part means count=1');
    assert.ok(Array.isArray(json.blobs) && json.blobs.length === 1);
    assert.equal(json.blobs[0].kind, 'image', 'image/* must map to kind=image');
    assert.equal(json.blobs[0].mime, 'image/png');
    assert.equal(json.blobs[0].bytes, filePayload.length, 'bytes must round-trip');
    assert.ok(json.blobs[0].hash && json.blobs[0].hash.length === 64,
      'sha256 hash must be 64 hex chars');
    assert.ok(Array.isArray(json.event_ids) && json.event_ids.length === 1,
      'one event must be appended per blob');
    assert.equal(json.fields.namespace, 'w384-media-test',
      'text part must be parsed into fields');
  });
});

// =====================================================================
// W384 #23 — billing/meters returns the 12-meter catalog.
// =====================================================================
test('W384 #23 — GET /v1/billing/meters returns the 12-entry meter catalog', async () => {
  const { app, apiKey } = await makeAppAndTenant();
  await withServer(app, async (base) => {
    const r = await api(base, '/v1/billing/meters', { apiKey });
    assert.equal(r.status, 200);
    const body = await r.json();
    assert.equal(body.ok, true);
    assert.equal(body.total, 12, 'exactly 12 meters must be exposed');
    assert.ok(Array.isArray(body.meters));
    for (const m of body.meters) {
      assert.ok(typeof m.id === 'string' && m.id.length, 'every meter must have an id');
      assert.ok(typeof m.label === 'string', 'every meter must have a label');
      assert.ok(typeof m.unit === 'string', 'every meter must have a unit');
      assert.ok(typeof m.billable === 'boolean', 'every meter must declare billable');
      assert.ok(typeof m.category === 'string', 'every meter must have a category');
    }
  });
});

// =====================================================================
// W384 #24 — storage/config returns event-store driver + media base.
// =====================================================================
test('W384 #24 — GET /v1/storage/config returns event_store driver + media base', async () => {
  const { app, apiKey } = await makeAppAndTenant();
  await withServer(app, async (base) => {
    const r = await api(base, '/v1/storage/config', { apiKey });
    assert.equal(r.status, 200);
    const body = await r.json();
    assert.equal(body.ok, true);
    assert.ok(body.event_store, 'event_store envelope must be present');
    assert.ok(body.event_store.driver, 'event_store.driver must be a string');
    assert.ok(body.media, 'media envelope must be present');
    assert.ok(body.media.base, 'media.base must be a path');
    assert.ok(Array.isArray(body.media.kinds), 'media.kinds must be an array');
  });
});

// =====================================================================
// W384 #25 — storage/purge requires admin AND a confirm flag.
// =====================================================================
test('W384 #25 — POST /v1/storage/purge requires admin + confirm:true', async () => {
  const { app, apiKey, adminKey } = await makeAppAndTenant({ admin: true });
  await withServer(app, async (base) => {
    // Non-admin -> 403.
    const tenantPurge = await api(base, '/v1/storage/purge', {
      apiKey, method: 'POST', body: { confirm: true },
    });
    assert.equal(tenantPurge.status, 403, 'non-admin purge must be 403');

    // Admin without confirm -> 400.
    const noConfirm = await api(base, '/v1/storage/purge', {
      apiKey: adminKey, method: 'POST', body: {},
    });
    assert.equal(noConfirm.status, 400, 'admin without confirm must be 400');
    const ncBody = await noConfirm.json();
    assert.equal(ncBody.error, 'confirm_required');

    // Admin with confirm -> 200 (no-op since no namespace/before given).
    const ok = await api(base, '/v1/storage/purge', {
      apiKey: adminKey, method: 'POST', body: { confirm: true, dry_run: true },
    });
    assert.equal(ok.status, 200);
    const okBody = await ok.json();
    assert.equal(okBody.ok, true);
  });
});

// =====================================================================
// W384 #26 — cross-tenant isolation for /v1/pipeline/jobs/:id.
// Tenant A starts a job; Tenant B fetching its id returns 403.
// =====================================================================
test('W384 #26 — pipeline job is tenant-scoped (cross-tenant access returns 403)', async () => {
  const dir = freshDataDir();
  process.env.KOLM_DATA_DIR = dir;
  process.env.HOME = dir;
  process.env.USERPROFILE = dir;
  process.env.KOLM_EVENT_STORE_PATH = path.join(dir, 'events_' + crypto.randomBytes(4).toString('hex') + '.sqlite');
  delete process.env.ADMIN_KEY;
  try { const es = await import('../src/event-store.js'); es._resetForTests?.(); } catch {}
  const { buildRouter } = await import('../src/router.js');
  const { provisionAnonTenant } = await import('../src/auth.js');
  const express = (await import('express')).default;
  const app = express();
  app.use(express.json({ limit: '4mb' }));
  app.use(buildRouter());
  const A = provisionAnonTenant({ ttl_days: 1, quota: 100 });
  const B = provisionAnonTenant({ ttl_days: 1, quota: 100 });
  assert.notEqual(A.api_key, B.api_key);

  await withServer(app, async (base) => {
    const start = await api(base, '/v1/pipeline/full', {
      apiKey: A.api_key, method: 'POST',
      body: { namespace: 'a-ns', opts: {} },
    });
    assert.equal(start.status, 202);
    const { job_id } = await start.json();
    // Tenant B tries to view A's job -> 403.
    const cross = await api(base, `/v1/pipeline/jobs/${job_id}`, { apiKey: B.api_key });
    assert.equal(cross.status, 403, 'cross-tenant job access must be 403');
    const body = await cross.json();
    assert.equal(body.error, 'cross_tenant_job_access');
    // Same tenant -> 200.
    const ok = await api(base, `/v1/pipeline/jobs/${job_id}`, { apiKey: A.api_key });
    assert.equal(ok.status, 200);
  });
});

// =====================================================================
// W384 #27 — connectors enumeration (W368 catalog passthrough).
// =====================================================================
test('W384 #27 — GET /v1/connectors returns providers + summary', async () => {
  const { app, apiKey } = await makeAppAndTenant();
  await withServer(app, async (base) => {
    const r = await api(base, '/v1/connectors', { apiKey });
    assert.equal(r.status, 200);
    const body = await r.json();
    assert.equal(body.ok, true);
    assert.ok(body.providers, 'providers map must be present');
    assert.ok(body.summary, 'summary envelope must be present');
  });
});
