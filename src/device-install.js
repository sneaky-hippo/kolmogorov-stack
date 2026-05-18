// W372 device-install: push a .kolm artifact onto a registered device.
//
// Three transports keyed off the registered device profile shape:
//   - kind === 'local'        → copy bytes into ~/.kolm/installed/<id>/
//   - device.ssh ≠ null       → scp + (optional) ssh smoke
//   - device.manifest_url     → HTTP PUT to the URL
//
// All installs land under ~/.kolm/installed/<device_id>/<artifact_id>/
// (the local cache for the local install, the staging area for everything
// else). A manifest.json next to each install records when, where, and
// the source sha256 so `kolm runtime install` and `kolm devices test`
// can answer "is this device fresh?" without re-reading the .kolm zip.
//
// Public API:
//   installToDevice(artifactPath, {deviceId, opts}) -> {device_id, artifact_id, installed_path, installed_at}
//   listInstalled({deviceId?})                       -> [{device_id, artifact_id, installed_path, installed_at, source_sha256}]
//   uninstall(deviceId, artifactId)                  -> {removed: true}
//   testInstall(deviceId, artifactId)                -> {ok, latency_ms?, reason?}

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';

import { listDevices, getDevice } from './device-capabilities.js';

function _home() { return process.env.HOME || process.env.USERPROFILE || os.homedir(); }
function _kolmDir() {
  const base = process.env.KOLM_DATA_DIR ? path.resolve(process.env.KOLM_DATA_DIR) : path.join(_home(), '.kolm');
  return base;
}
function _installedRoot() {
  const p = path.join(_kolmDir(), 'installed');
  fs.mkdirSync(p, { recursive: true });
  return p;
}
function _deviceRoot(deviceId) {
  const p = path.join(_installedRoot(), deviceId);
  fs.mkdirSync(p, { recursive: true });
  return p;
}

function _sha256File(p) {
  const h = crypto.createHash('sha256');
  h.update(fs.readFileSync(p));
  return h.digest('hex');
}

function _artifactIdFromPath(artifactPath) {
  return path.basename(artifactPath).replace(/\.kolm$/, '');
}

function _writeInstallManifest(installDir, payload) {
  fs.writeFileSync(path.join(installDir, 'install.manifest.json'), JSON.stringify(payload, null, 2));
}

function _readInstallManifest(installDir) {
  const f = path.join(installDir, 'install.manifest.json');
  if (!fs.existsSync(f)) return null;
  try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return null; }
}

// SSH safety: reject anything that looks like a flag, requires `--` between
// the args and the host string. Mirrors src/sync-git.js#assertSafeGitUrl.
function _assertSafeSshHost(host) {
  const s = String(host || '');
  if (!s) throw new Error('ssh host required');
  if (s.startsWith('-')) throw new Error('ssh host cannot start with `-`');
  if (!/^[A-Za-z0-9][A-Za-z0-9_.@:-]*$/.test(s)) throw new Error('ssh host has unsafe characters');
  return s;
}

function _assertSafeRemotePath(p) {
  const s = String(p || '');
  if (!s) throw new Error('remote path required');
  if (s.startsWith('-')) throw new Error('remote path cannot start with `-`');
  if (s.includes('..')) throw new Error('remote path cannot contain ..');
  return s;
}

export async function installToDevice(artifactPath, { deviceId, opts = {} } = {}) {
  if (!artifactPath || !fs.existsSync(artifactPath)) {
    const err = new Error(`artifact not found: ${artifactPath}`);
    err.code = 'KOLM_E_ARTIFACT_NOT_FOUND';
    throw err;
  }
  if (!deviceId) {
    const err = new Error('deviceId is required');
    err.code = 'KOLM_E_NO_DEVICE_ID';
    throw err;
  }

  const device = await getDevice(deviceId);
  if (!device) {
    const err = new Error(`unknown device: ${deviceId}. try: kolm devices list`);
    err.code = 'KOLM_E_UNKNOWN_DEVICE';
    throw err;
  }

  const artifact_id = _artifactIdFromPath(artifactPath);
  const sha256 = _sha256File(artifactPath);
  const installed_at = new Date().toISOString();
  const installDir = path.join(_deviceRoot(deviceId), artifact_id);

  if (!opts.force && fs.existsSync(path.join(installDir, path.basename(artifactPath)))) {
    const existing = _readInstallManifest(installDir);
    if (existing && existing.source_sha256 === sha256) {
      return {
        device_id: deviceId,
        artifact_id,
        installed_path: installDir,
        installed_at: existing.installed_at,
        source_sha256: sha256,
        unchanged: true,
      };
    }
  }

  fs.mkdirSync(installDir, { recursive: true });

  // Always keep a local copy under ~/.kolm/installed for traceability. The
  // remote leg copies that same byte stream over the wire.
  const localCopy = path.join(installDir, path.basename(artifactPath));
  fs.copyFileSync(artifactPath, localCopy);

  let transport = 'local';
  let remoteResult = null;

  if (device.kind && device.kind !== 'local' && device.kind !== 'laptop') {
    if (device.ssh) {
      transport = 'ssh';
      remoteResult = _scpToHost(localCopy, device);
    } else if (device.manifest_url) {
      transport = 'http';
      remoteResult = await _httpPutToManifest(localCopy, device);
    } else {
      transport = 'manual';
      remoteResult = { ok: false, reason: 'device has no ssh or manifest_url; staged locally only' };
    }
  }

  const payload = {
    device_id: deviceId,
    artifact_id,
    installed_path: installDir,
    installed_at,
    source_sha256: sha256,
    transport,
    remote_result: remoteResult,
  };
  _writeInstallManifest(installDir, payload);
  return payload;
}

function _scpToHost(localPath, device) {
  try {
    const host = _assertSafeSshHost(device.ssh.host);
    const remote = _assertSafeRemotePath(device.ssh.path || '~/.kolm/installed/');
    const user = device.ssh.user ? `${device.ssh.user}@` : '';
    const args = ['-o', 'StrictHostKeyChecking=accept-new'];
    if (device.ssh.port) { args.push('-P', String(Number(device.ssh.port))); }
    if (device.ssh.identity_file) { args.push('-i', String(device.ssh.identity_file)); }
    args.push('--', localPath, `${user}${host}:${remote}`);
    const r = spawnSync('scp', args, { encoding: 'utf8', timeout: 60_000 });
    if (r.error) return { ok: false, transport: 'ssh', reason: r.error.message };
    if (r.status !== 0) return { ok: false, transport: 'ssh', reason: (r.stderr || r.stdout || '').trim() };
    return { ok: true, transport: 'ssh', host, remote };
  } catch (e) {
    return { ok: false, transport: 'ssh', reason: e.message };
  }
}

async function _httpPutToManifest(localPath, device) {
  try {
    const url = String(device.manifest_url || '');
    if (!/^https?:\/\//.test(url)) throw new Error('manifest_url must be http(s)://');
    const body = fs.readFileSync(localPath);
    const headers = { 'content-type': 'application/zip' };
    if (device.api_key) headers.authorization = `Bearer ${device.api_key}`;
    const resp = await fetch(url, { method: 'PUT', headers, body });
    return { ok: resp.ok, transport: 'http', status: resp.status, url };
  } catch (e) {
    return { ok: false, transport: 'http', reason: e.message };
  }
}

export async function listInstalled({ deviceId } = {}) {
  const root = _installedRoot();
  if (!fs.existsSync(root)) return [];
  const devices = deviceId ? [deviceId] : fs.readdirSync(root).filter(d => fs.statSync(path.join(root, d)).isDirectory());
  const out = [];
  for (const d of devices) {
    const dDir = path.join(root, d);
    if (!fs.existsSync(dDir)) continue;
    for (const a of fs.readdirSync(dDir)) {
      const aDir = path.join(dDir, a);
      const stat = fs.statSync(aDir);
      if (!stat.isDirectory()) continue;
      const m = _readInstallManifest(aDir);
      out.push(m || { device_id: d, artifact_id: a, installed_path: aDir, installed_at: stat.birthtime.toISOString() });
    }
  }
  return out;
}

export async function uninstall(deviceId, artifactId) {
  if (!deviceId || !artifactId) {
    const err = new Error('deviceId and artifactId required'); err.code = 'KOLM_E_BAD_ARGS'; throw err;
  }
  const dir = path.join(_installedRoot(), deviceId, artifactId);
  if (!fs.existsSync(dir)) return { removed: false, reason: 'not installed' };
  fs.rmSync(dir, { recursive: true, force: true });
  return { removed: true, dir };
}

export async function testInstall(deviceId, artifactId) {
  const dir = path.join(_installedRoot(), deviceId, artifactId);
  if (!fs.existsSync(dir)) return { ok: false, reason: 'not installed' };
  const device = await getDevice(deviceId);
  if (!device) return { ok: false, reason: `unknown device ${deviceId}` };

  // Find the .kolm file inside the install dir.
  const kolm = fs.readdirSync(dir).find(f => f.endsWith('.kolm'));
  if (!kolm) return { ok: false, reason: 'no .kolm in install dir' };
  const artifactPath = path.join(dir, kolm);

  if (device.kind === 'local' || !device.kind || device.kind === 'laptop' || device.kind === 'server') {
    const t0 = Date.now();
    try {
      const { runArtifactViaBundle } = await import('./bundle-runner.js');
      const r = await runArtifactViaBundle(artifactPath, '', {});
      return { ok: true, latency_ms: Date.now() - t0, recipe_id: r.recipe_id || null, transport: 'local' };
    } catch (eBundle) {
      try {
        const { runArtifact } = await import('./artifact-runner.js');
        const r = await runArtifact(artifactPath, '', {});
        return { ok: true, latency_ms: Date.now() - t0, recipe_id: r.recipe_id || null, transport: 'local-recipe' };
      } catch (e) {
        return { ok: false, reason: e.message, code: e.code || 'RUN_FAILED' };
      }
    }
  }

  if (device.ssh) {
    try {
      const host = _assertSafeSshHost(device.ssh.host);
      const user = device.ssh.user ? `${device.ssh.user}@` : '';
      const args = ['-o', 'StrictHostKeyChecking=accept-new', '-o', 'ConnectTimeout=5'];
      if (device.ssh.port) { args.push('-p', String(Number(device.ssh.port))); }
      if (device.ssh.identity_file) { args.push('-i', String(device.ssh.identity_file)); }
      args.push('--', `${user}${host}`, 'echo kolm-ok');
      const r = spawnSync('ssh', args, { encoding: 'utf8', timeout: 10_000 });
      if (r.status === 0 && /kolm-ok/.test(r.stdout)) {
        return { ok: true, transport: 'ssh', reachable: true };
      }
      return { ok: false, transport: 'ssh', reason: (r.stderr || r.stdout || 'ssh failed').trim() };
    } catch (e) {
      return { ok: false, transport: 'ssh', reason: e.message };
    }
  }

  if (device.manifest_url) {
    try {
      const resp = await fetch(device.manifest_url, { method: 'HEAD' });
      return { ok: resp.ok, transport: 'http', status: resp.status };
    } catch (e) {
      return { ok: false, transport: 'http', reason: e.message };
    }
  }

  return { ok: false, reason: 'device has no reachable transport (no ssh, no manifest_url)' };
}

export default { installToDevice, listInstalled, uninstall, testInstall };
