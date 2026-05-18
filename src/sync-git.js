// W229 — `kolm sync` helper. Pushes a .kolm artifact + manifest + receipt-chain
// to a private git repo so a fleet of agents can share the same compiled
// memory. Wraps the system `git` CLI; we do not bundle a git library.
//
// Layout written into the repo:
//   <subdir>/
//     manifest.json       — full artifact manifest (signature trailer included)
//     receipt-chain.json  — Merkle leaves, in declared order
//     artifact.kolm       — copy of the .kolm blob (LFS-friendly path)
//     synced_at.txt       — ISO timestamp of the sync that landed this rev
//
// Commands:
//   push(artifactPath, gitUrl, opts)  — clone-or-pull, write, commit, push
//   pull(gitUrl, opts)                — clone-or-pull, return list of artifacts
//   status(gitUrl, opts)              — clone-or-pull, summarize latest commit
//
// Authentication is whatever the user's git already does (ssh-agent / netrc /
// GH_TOKEN env). We never read or store credentials.

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';

// W253 sec#4: a gitUrl starting with `--upload-pack=...`, `--config=...`,
// `-c protocol.ext.allow=always`, or `--exec=...` is interpreted by git as a
// flag and yields local command execution. Two-layer defense: (a) reject any
// URL that looks like a flag or contains a protocol git doesn't transport
// safely, and (b) pass `--` before the URL on every invocation so git treats
// it as a positional even if validation regresses.
const SAFE_URL = /^(?:https?:\/\/|git@|ssh:\/\/git@|git:\/\/|file:\/\/)[^\s]+$/i;
function assertSafeGitUrl(gitUrl) {
  const s = String(gitUrl || '');
  if (!s) throw new Error('git url required');
  if (s.startsWith('-')) throw new Error('git url cannot start with `-` (would be parsed as a flag)');
  if (!SAFE_URL.test(s)) {
    throw new Error('git url must be http(s)://, ssh://, git@, git://, or file://');
  }
  return s;
}
function assertSafeSubdir(subdir) {
  const s = String(subdir || '');
  if (!s) throw new Error('subdir required');
  if (s.startsWith('-')) throw new Error('subdir cannot start with `-`');
  if (s.includes('..') || path.isAbsolute(s)) throw new Error('subdir must be relative without ..');
  return s;
}

export function workdirFor(gitUrl) {
  const slug = crypto.createHash('sha1').update(String(gitUrl)).digest('hex').slice(0, 12);
  return path.join(os.tmpdir(), `kolm-sync-${slug}`);
}

function run(cmd, args, cwd) {
  const r = spawnSync(cmd, args, { cwd, encoding: 'utf8' });
  if (r.error) throw new Error(`${cmd} ${args.join(' ')}: ${r.error.message}`);
  return { stdout: r.stdout || '', stderr: r.stderr || '', status: r.status };
}

export function ensureClone(gitUrl, opts = {}) {
  const safe = assertSafeGitUrl(gitUrl);
  const dir = opts.workdir || workdirFor(safe);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(path.dirname(dir), { recursive: true });
    const r = run('git', ['clone', '--depth=1', '--', safe, dir]);
    if (r.status !== 0) throw new Error(`git clone failed: ${r.stderr.trim()}`);
  } else {
    const r = run('git', ['pull', '--ff-only'], dir);
    if (r.status !== 0) throw new Error(`git pull failed: ${r.stderr.trim()}`);
  }
  return dir;
}

function sha256File(filePath) {
  const h = crypto.createHash('sha256');
  h.update(fs.readFileSync(filePath));
  return h.digest('hex');
}

function readManifestFromArtifact(artifactPath) {
  const sib = artifactPath.replace(/\.kolm$/, '.manifest.json');
  if (fs.existsSync(sib)) {
    try { return JSON.parse(fs.readFileSync(sib, 'utf8')); } catch (_) {}
  }
  const stat = fs.existsSync(artifactPath) ? fs.statSync(artifactPath) : null;
  return {
    artifact: path.basename(artifactPath),
    size: stat ? stat.size : 0,
    sha256: stat ? sha256File(artifactPath) : null,
    note: 'manifest reconstructed by kolm sync; ship distill output for full manifest',
  };
}

function readReceiptChain(artifactPath) {
  const sib = artifactPath.replace(/\.kolm$/, '.receipts.json');
  if (fs.existsSync(sib)) {
    try { return JSON.parse(fs.readFileSync(sib, 'utf8')); } catch (_) {}
  }
  return { leaves: [], note: 'no receipt chain found next to artifact' };
}

export function push(artifactPath, gitUrl, opts = {}) {
  if (!fs.existsSync(artifactPath)) throw new Error(`artifact not found: ${artifactPath}`);
  const dir = ensureClone(gitUrl, opts);
  const rawSubdir = opts.subdir || path.basename(artifactPath, '.kolm');
  const subdir = assertSafeSubdir(rawSubdir);
  const target = path.join(dir, subdir);
  fs.mkdirSync(target, { recursive: true });

  const manifest = readManifestFromArtifact(artifactPath);
  const receipts = readReceiptChain(artifactPath);
  fs.copyFileSync(artifactPath, path.join(target, 'artifact.kolm'));
  fs.writeFileSync(path.join(target, 'manifest.json'), JSON.stringify(manifest, null, 2), 'utf8');
  fs.writeFileSync(path.join(target, 'receipt-chain.json'), JSON.stringify(receipts, null, 2), 'utf8');
  fs.writeFileSync(path.join(target, 'synced_at.txt'), new Date().toISOString() + '\n', 'utf8');

  run('git', ['add', '--', subdir], dir);
  const message = opts.message || `kolm sync: ${subdir}`;
  const commit = run('git', ['commit', '-m', message], dir);
  if (commit.status !== 0 && !/nothing to commit/.test(commit.stdout + commit.stderr)) {
    throw new Error(`git commit failed: ${commit.stderr.trim()}`);
  }
  if (opts.noPush) return { dir, subdir, pushed: false };
  const pushed = run('git', ['push'], dir);
  if (pushed.status !== 0) throw new Error(`git push failed: ${pushed.stderr.trim()}`);
  return { dir, subdir, pushed: true };
}

export function pull(gitUrl, opts = {}) {
  const dir = ensureClone(gitUrl, opts);
  const entries = fs.readdirSync(dir, { withFileTypes: true })
    .filter((e) => e.isDirectory() && !e.name.startsWith('.'))
    .map((e) => {
      const sub = path.join(dir, e.name);
      const hasArtifact = fs.existsSync(path.join(sub, 'artifact.kolm'));
      const hasManifest = fs.existsSync(path.join(sub, 'manifest.json'));
      return { name: e.name, hasArtifact, hasManifest };
    })
    .filter((e) => e.hasArtifact || e.hasManifest);
  return { dir, artifacts: entries };
}

export function status(gitUrl, opts = {}) {
  const dir = ensureClone(gitUrl, opts);
  const head = run('git', ['log', '-1', '--pretty=format:%H %ai %s'], dir);
  return {
    dir,
    head: head.stdout.trim(),
    artifacts: pull(gitUrl, { ...opts, workdir: dir }).artifacts.length,
  };
}

export default { push, pull, status, workdirFor, ensureClone };
