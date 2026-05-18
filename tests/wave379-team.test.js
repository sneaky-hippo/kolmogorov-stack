// W379 — team backend behavior tests.
//
// Covers src/team.js: shared namespaces + RBAC + reviewer queues + approval
// gates. Round 2 wires the routes + CLI verbs — this suite locks in the data
// model and permission matrix.
//
// Every test runs against an isolated KOLM_DATA_DIR + HOME so concurrent W379
// runs don't race ~/.kolm/team. We re-import the module per test (cache-bust
// via a query string) so each test sees a clean module state.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const SRC = path.resolve(process.cwd(), 'src', 'team.js');

function isolatedDataDir(tag) {
  return fs.mkdtempSync(path.join(os.tmpdir(), `kolm-w379-${tag}-`));
}

// Per-test sandbox: fresh KOLM_DATA_DIR, fresh module load. Restores env on
// exit. The module is pure-file storage so re-import gives a clean view.
async function withSandbox(tag, fn) {
  const dir = isolatedDataDir(tag);
  const prevData = process.env.KOLM_DATA_DIR;
  const prevSelf = process.env.KOLM_TEAM_SELF_EMAIL;
  process.env.KOLM_DATA_DIR = dir;
  process.env.KOLM_TEAM_SELF_EMAIL = 'admin@example.test';
  // Cache-bust the dynamic import so module-level state doesn't leak across
  // tests in the same node --test run.
  const url = pathToFileURL(SRC).href + `?t=${Date.now()}-${Math.random().toString(36).slice(2)}`;
  const mod = await import(url);
  try {
    return await fn({ mod, dir });
  } finally {
    if (prevData === undefined) delete process.env.KOLM_DATA_DIR; else process.env.KOLM_DATA_DIR = prevData;
    if (prevSelf === undefined) delete process.env.KOLM_TEAM_SELF_EMAIL; else process.env.KOLM_TEAM_SELF_EMAIL = prevSelf;
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch (_) {}
  }
}

// Helpers ----------------------------------------------------------------------

function adminOf(mod) {
  const ws = mod.getWorkspace();
  return ws.members.find(m => m.role === 'admin');
}

async function seedMember(mod, role, email) {
  const admin = adminOf(mod);
  const inv = mod.invite({ email, role, invited_by: admin.member_id });
  const acc = mod.acceptInvite({ invite_token: inv.invite_token, member_email: email });
  return { member_id: acc.member_id, role: acc.role, email };
}

// ─── tests ────────────────────────────────────────────────────────────────────

test('W379 #1 — default workspace has exactly one admin member (self)', async () => {
  await withSandbox('t1', async ({ mod }) => {
    const ws = mod.getWorkspace();
    assert.ok(ws.workspace_id, 'workspace_id required');
    assert.ok(ws.name, 'workspace.name required');
    assert.equal(Array.isArray(ws.members), true);
    assert.equal(ws.members.length, 1, 'exactly one default member');
    assert.equal(ws.members[0].role, 'admin');
    assert.equal(ws.members[0].email, 'admin@example.test');
    assert.equal(Array.isArray(ws.shared_namespaces), true);
    assert.equal(ws.shared_namespaces.length, 0);
  });
});

test('W379 #2 — invite() returns token + URL and persists to invites.jsonl', async () => {
  await withSandbox('t2', async ({ mod, dir }) => {
    const admin = adminOf(mod);
    const inv = mod.invite({ email: 'bob@example.test', role: 'reviewer', invited_by: admin.member_id });
    assert.ok(inv.invite_token && inv.invite_token.length >= 32, 'token >= 32 chars');
    assert.match(inv.invite_url, /token=/, 'url contains token');
    assert.ok(inv.expires_at && Date.parse(inv.expires_at) > Date.now(), 'expires in the future');
    const log = path.join(dir, 'team', 'invites.jsonl');
    assert.ok(fs.existsSync(log), 'invites.jsonl exists');
    const lines = fs.readFileSync(log, 'utf8').trim().split('\n');
    assert.equal(lines.length, 1);
    const rec = JSON.parse(lines[0]);
    assert.equal(rec.email, 'bob@example.test');
    assert.equal(rec.role, 'reviewer');
    assert.equal(rec.invite_token, inv.invite_token);
  });
});

test('W379 #3 — acceptInvite() with valid token creates member with declared role', async () => {
  await withSandbox('t3', async ({ mod }) => {
    const admin = adminOf(mod);
    const inv = mod.invite({ email: 'carol@example.test', role: 'contributor', invited_by: admin.member_id });
    const result = mod.acceptInvite({ invite_token: inv.invite_token, member_email: 'carol@example.test' });
    assert.equal(result.role, 'contributor');
    assert.ok(result.member_id);
    const members = mod.listMembers();
    assert.equal(members.length, 2);
    const carol = members.find(m => m.email === 'carol@example.test');
    assert.ok(carol);
    assert.equal(carol.role, 'contributor');
    assert.equal(carol.invited_by, admin.member_id);
  });
});

test('W379 #4 — acceptInvite() with expired token throws TeamError(invite_expired)', async () => {
  await withSandbox('t4', async ({ mod }) => {
    const admin = adminOf(mod);
    // Invite with -1ms ttl: expires immediately in the past.
    const inv = mod.invite({ email: 'dan@example.test', role: 'viewer', invited_by: admin.member_id, ttl_ms: 1 });
    // Sleep 5ms to guarantee expiry.
    await new Promise(r => setTimeout(r, 5));
    try {
      mod.acceptInvite({ invite_token: inv.invite_token, member_email: 'dan@example.test' });
      assert.fail('expected throw');
    } catch (e) {
      assert.equal(e.name, 'TeamError');
      assert.equal(e.code, 'invite_expired');
    }
  });
});

test('W379 #5 — acceptInvite() with consumed token throws TeamError(invite_consumed)', async () => {
  await withSandbox('t5', async ({ mod }) => {
    const admin = adminOf(mod);
    const inv = mod.invite({ email: 'eve@example.test', role: 'viewer', invited_by: admin.member_id });
    mod.acceptInvite({ invite_token: inv.invite_token, member_email: 'eve@example.test' });
    try {
      mod.acceptInvite({ invite_token: inv.invite_token, member_email: 'eve@example.test' });
      assert.fail('expected throw');
    } catch (e) {
      assert.equal(e.name, 'TeamError');
      assert.equal(e.code, 'invite_consumed');
    }
  });
});

test('W379 #6 — setRole() by admin updates role', async () => {
  await withSandbox('t6', async ({ mod }) => {
    const admin = adminOf(mod);
    const m = await seedMember(mod, 'viewer', 'fred@example.test');
    const updated = mod.setRole({ member_id: m.member_id, role: 'reviewer', actor_member_id: admin.member_id });
    assert.equal(updated.role, 'reviewer');
    assert.equal(mod.listMembers().find(x => x.member_id === m.member_id).role, 'reviewer');
  });
});

test('W379 #7 — setRole() by non-admin throws TeamError(forbidden)', async () => {
  await withSandbox('t7', async ({ mod }) => {
    const viewer = await seedMember(mod, 'viewer', 'gina@example.test');
    const target = await seedMember(mod, 'contributor', 'hank@example.test');
    try {
      mod.setRole({ member_id: target.member_id, role: 'reviewer', actor_member_id: viewer.member_id });
      assert.fail('expected throw');
    } catch (e) {
      assert.equal(e.code, 'forbidden');
    }
  });
});

test('W379 #8 — setRole() demoting last admin throws TeamError(last_admin)', async () => {
  await withSandbox('t8', async ({ mod }) => {
    const admin = adminOf(mod);
    try {
      mod.setRole({ member_id: admin.member_id, role: 'viewer', actor_member_id: admin.member_id });
      assert.fail('expected throw');
    } catch (e) {
      assert.equal(e.code, 'last_admin');
    }
    // But if there's a second admin, demoting one works.
    const second = await seedMember(mod, 'admin', 'second-admin@example.test');
    const updated = mod.setRole({ member_id: admin.member_id, role: 'viewer', actor_member_id: second.member_id });
    assert.equal(updated.role, 'viewer');
  });
});

test('W379 #9 — removeMember() by admin works', async () => {
  await withSandbox('t9', async ({ mod }) => {
    const admin = adminOf(mod);
    const m = await seedMember(mod, 'contributor', 'iris@example.test');
    const before = mod.listMembers().length;
    const res = mod.removeMember({ member_id: m.member_id, actor_member_id: admin.member_id });
    assert.equal(res.ok, true);
    assert.equal(mod.listMembers().length, before - 1);
    assert.equal(mod.listMembers().find(x => x.member_id === m.member_id), undefined);
  });
});

test('W379 #10 — removeMember() of last admin throws TeamError(last_admin)', async () => {
  await withSandbox('t10', async ({ mod }) => {
    const admin = adminOf(mod);
    try {
      mod.removeMember({ member_id: admin.member_id, actor_member_id: admin.member_id });
      assert.fail('expected throw');
    } catch (e) {
      assert.equal(e.code, 'last_admin');
    }
  });
});

test('W379 #11 — permits() matrix: 8 actions × 4 roles all cells assert', async () => {
  await withSandbox('t11', async ({ mod }) => {
    const admin = adminOf(mod);
    const reviewer = await seedMember(mod, 'reviewer', 'r@example.test');
    const contributor = await seedMember(mod, 'contributor', 'c@example.test');
    const viewer = await seedMember(mod, 'viewer', 'v@example.test');

    const expected = {
      capture:           { admin: true,  reviewer: true,  contributor: true,  viewer: false },
      label:             { admin: true,  reviewer: true,  contributor: true,  viewer: false },
      split_dataset:     { admin: true,  reviewer: true,  contributor: false, viewer: false },
      publish_artifact:  { admin: true,  reviewer: true,  contributor: false, viewer: false },
      enable_cloud_sync: { admin: true,  reviewer: false, contributor: false, viewer: false },
      change_plan:       { admin: true,  reviewer: false, contributor: false, viewer: false },
      invite_member:     { admin: true,  reviewer: false, contributor: false, viewer: false },
      view:              { admin: true,  reviewer: true,  contributor: true,  viewer: true  },
    };
    const idOf = { admin: admin.member_id, reviewer: reviewer.member_id, contributor: contributor.member_id, viewer: viewer.member_id };

    for (const action of Object.keys(expected)) {
      for (const role of ['admin', 'reviewer', 'contributor', 'viewer']) {
        const got = mod.permits(idOf[role], action);
        assert.equal(got, expected[action][role],
          `permits(${role}, ${action}) expected ${expected[action][role]} got ${got}`);
      }
    }
  });
});

test('W379 #12 — submitApproval(publish_artifact) by contributor returns pending; reviewer can decide', async () => {
  await withSandbox('t12', async ({ mod }) => {
    const contributor = await seedMember(mod, 'contributor', 'c@example.test');
    const reviewer = await seedMember(mod, 'reviewer', 'r@example.test');
    const sub = mod.submitApproval({
      kind: 'artifact_publish',
      payload: { artifact: 'phi-redactor.kolm', version: '1.0.0' },
      submitter_id: contributor.member_id,
    });
    assert.ok(sub.approval_id);
    assert.equal(sub.status, 'pending');
    const decided = mod.decideApproval({
      approval_id: sub.approval_id,
      decision: 'approve',
      reviewer_id: reviewer.member_id,
    });
    assert.equal(decided.status, 'approved');
    assert.equal(decided.reviewer_id, reviewer.member_id);
  });
});

test('W379 #13 — decideApproval(approve) by reviewer changes status', async () => {
  await withSandbox('t13', async ({ mod }) => {
    const contributor = await seedMember(mod, 'contributor', 'c@example.test');
    const reviewer = await seedMember(mod, 'reviewer', 'r@example.test');
    const sub = mod.submitApproval({
      kind: 'dataset_split',
      payload: { dataset: 'phi-corpus', ratio: 0.8 },
      submitter_id: contributor.member_id,
    });
    const all1 = mod.listApprovals({ status: 'pending' });
    assert.equal(all1.length, 1);
    const decided = mod.decideApproval({
      approval_id: sub.approval_id,
      decision: 'approve',
      reviewer_id: reviewer.member_id,
    });
    assert.equal(decided.status, 'approved');
    assert.ok(decided.decided_at);
    const pendingAfter = mod.listApprovals({ status: 'pending' });
    assert.equal(pendingAfter.length, 0);
    const approvedAfter = mod.listApprovals({ status: 'approved' });
    assert.equal(approvedAfter.length, 1);
  });
});

test('W379 #14 — decideApproval by submitter throws TeamError(self_review)', async () => {
  await withSandbox('t14', async ({ mod }) => {
    // Reviewer submits their own approval — they're the submitter.
    const reviewer = await seedMember(mod, 'reviewer', 'r@example.test');
    const sub = mod.submitApproval({
      kind: 'sync_state_change',
      payload: { sync: 'on' },
      submitter_id: reviewer.member_id,
    });
    try {
      mod.decideApproval({
        approval_id: sub.approval_id,
        decision: 'approve',
        reviewer_id: reviewer.member_id,
      });
      assert.fail('expected throw');
    } catch (e) {
      assert.equal(e.code, 'self_review');
    }
  });
});

test('W379 #15 — decideApproval(reject) with comment persists comment', async () => {
  await withSandbox('t15', async ({ mod }) => {
    const contributor = await seedMember(mod, 'contributor', 'c@example.test');
    const reviewer = await seedMember(mod, 'reviewer', 'r@example.test');
    const sub = mod.submitApproval({
      kind: 'artifact_publish',
      payload: { artifact: 'risky.kolm' },
      submitter_id: contributor.member_id,
    });
    const decided = mod.decideApproval({
      approval_id: sub.approval_id,
      decision: 'reject',
      reviewer_id: reviewer.member_id,
      comment: 'too risky — needs human review',
    });
    assert.equal(decided.status, 'rejected');
    assert.equal(decided.comment, 'too risky — needs human review');
    // And it survives a re-read.
    const fromList = mod.listApprovals({}).find(r => r.approval_id === sub.approval_id);
    assert.equal(fromList.comment, 'too risky — needs human review');
  });
});

test('W379 #16 — addSharedNamespace by admin; canSee for shared vs private', async () => {
  await withSandbox('t16', async ({ mod }) => {
    const admin = adminOf(mod);
    const reviewer = await seedMember(mod, 'reviewer', 'r@example.test');
    const contributor = await seedMember(mod, 'contributor', 'c@example.test');

    // Shared namespace — everyone can see.
    mod.addSharedNamespace({
      namespace: 'team/phi-redactor',
      namespace_owner_id: reviewer.member_id,
      actor_member_id: admin.member_id,
    });
    for (const id of [admin.member_id, reviewer.member_id, contributor.member_id]) {
      assert.equal(mod.canSee(id, 'team/phi-redactor'), true,
        `member ${id} should see shared namespace`);
    }

    // Private namespace — only the owner (and admins) can see.
    mod.addSharedNamespace({
      namespace: 'private/contributor-scratch',
      namespace_owner_id: contributor.member_id,
      actor_member_id: admin.member_id,
      shared: false,
    });
    assert.equal(mod.canSee(contributor.member_id, 'private/contributor-scratch'), true,
      'owner sees their private namespace');
    assert.equal(mod.canSee(admin.member_id, 'private/contributor-scratch'), true,
      'admin sees every namespace');
    assert.equal(mod.canSee(reviewer.member_id, 'private/contributor-scratch'), false,
      'non-owner non-admin does NOT see private namespace');
  });
});

test('W379 #17 — listApprovals filters by status + kind', async () => {
  await withSandbox('t17', async ({ mod }) => {
    const contributor = await seedMember(mod, 'contributor', 'c@example.test');
    const reviewer = await seedMember(mod, 'reviewer', 'r@example.test');

    const s1 = mod.submitApproval({ kind: 'artifact_publish', payload: { id: 1 }, submitter_id: contributor.member_id });
    const s2 = mod.submitApproval({ kind: 'dataset_split',    payload: { id: 2 }, submitter_id: contributor.member_id });
    const s3 = mod.submitApproval({ kind: 'artifact_publish', payload: { id: 3 }, submitter_id: contributor.member_id });

    mod.decideApproval({ approval_id: s1.approval_id, decision: 'approve', reviewer_id: reviewer.member_id });
    mod.decideApproval({ approval_id: s3.approval_id, decision: 'reject',  reviewer_id: reviewer.member_id, comment: 'no' });

    const allPending = mod.listApprovals({ status: 'pending' });
    assert.equal(allPending.length, 1);
    assert.equal(allPending[0].approval_id, s2.approval_id);

    const allApproved = mod.listApprovals({ status: 'approved' });
    assert.equal(allApproved.length, 1);
    assert.equal(allApproved[0].approval_id, s1.approval_id);

    const allRejected = mod.listApprovals({ status: 'rejected' });
    assert.equal(allRejected.length, 1);
    assert.equal(allRejected[0].approval_id, s3.approval_id);

    const allPublish = mod.listApprovals({ kind: 'artifact_publish' });
    assert.equal(allPublish.length, 2);

    const pendingPublish = mod.listApprovals({ status: 'pending', kind: 'artifact_publish' });
    assert.equal(pendingPublish.length, 0);

    const all = mod.listApprovals({});
    assert.equal(all.length, 3);
  });
});

test('W379 #18 — durability: every mutation round-trips through re-import', async () => {
  await withSandbox('t18', async ({ mod, dir }) => {
    const admin = adminOf(mod);

    // Mutation 1: setWorkspace
    mod.setWorkspace({ name: 'My Team', plan_tier: 'pro', actor_member_id: admin.member_id });

    // Mutation 2: invite + accept
    const reviewer = await seedMember(mod, 'reviewer', 'r@example.test');

    // Mutation 3: setRole
    mod.setRole({ member_id: reviewer.member_id, role: 'admin', actor_member_id: admin.member_id });

    // Mutation 4: addSharedNamespace
    mod.addSharedNamespace({
      namespace: 'team/redactor',
      namespace_owner_id: reviewer.member_id,
      actor_member_id: admin.member_id,
    });

    // Mutation 5: submitApproval + decideApproval
    const contributor = await seedMember(mod, 'contributor', 'c@example.test');
    const sub = mod.submitApproval({ kind: 'dataset_split', payload: { ds: 'x' }, submitter_id: contributor.member_id });
    mod.decideApproval({ approval_id: sub.approval_id, decision: 'approve', reviewer_id: reviewer.member_id, comment: 'lgtm' });

    // Re-import a clean module — all state should round-trip from disk.
    const url2 = pathToFileURL(SRC).href + `?t=${Date.now()}-reimport`;
    const mod2 = await import(url2);

    const ws2 = mod2.getWorkspace();
    assert.equal(ws2.name, 'My Team');
    assert.equal(ws2.plan_tier, 'pro');
    assert.equal(ws2.members.length, 3, 'admin + reviewer-promoted + contributor');
    const reviewerAfter = ws2.members.find(m => m.email === 'r@example.test');
    assert.equal(reviewerAfter.role, 'admin');
    assert.equal(ws2.shared_namespaces.length, 1);
    assert.equal(ws2.shared_namespaces[0].namespace, 'team/redactor');

    const apr = mod2.listApprovals({});
    assert.equal(apr.length, 1);
    assert.equal(apr[0].status, 'approved');
    assert.equal(apr[0].comment, 'lgtm');

    // Files exist where the spec says they should.
    assert.ok(fs.existsSync(path.join(dir, 'team', 'workspace.json')));
    assert.ok(fs.existsSync(path.join(dir, 'team', 'invites.jsonl')));
    assert.ok(fs.existsSync(path.join(dir, 'team', 'approvals.jsonl')));
  });
});
