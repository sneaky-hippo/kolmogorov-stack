// Device-capability layer.
//
// devices.js is the *registry* of known device profiles. This module is the
// *capability matcher* an artifact uses at runtime to decide:
//   - can this artifact even load on the current device?
//   - what runtime should it pick (llama.cpp, MLC, MediaPipe, transformers.js,
//     TensorRT-LLM, MLX)?
//   - can the device produce a hardware attestation that the verifier will
//     trust (TEE: TDX, SEV-SNP, Nitro, NVIDIA CC)?
//   - which input modalities does the device support (text/image/audio/video)?
//
// The .kolm manifest carries a `target_device` profile id; this module is
// what the runtime calls to assert that the actual host meets that profile.
//
// The capability *types* are deliberately small and JSON-serializable so they
// can ride along inside manifest.target_device.capabilities and the verifier
// can reproduce them from devices.js without running any host probes.
//
// W372 extended this module with the "device fleet" API:
//   - DEVICE_KINDS / RUNTIMES / MODALITIES enums for fleet UX
//   - detectLocalDevice()    : write a profile of THIS machine to ~/.kolm/devices/local.json
//   - listDevices()          : enumerate every saved profile
//   - getDevice(deviceId)    : load one profile
//   - registerDevice(profile): write a profile + return the canonical form
//   - testDevice(deviceId)   : reachability + runtime probe
//   - compatibleArtifacts()  : filter a list of artifacts against a profile
//
// The static profiles from devices.js are still available through
// allProfiles()/profileFor(): the fleet API stores ADDITIONAL operator-
// registered devices (laptops, servers, phones, browsers, edge boxes)
// under ~/.kolm/devices/<id>.json.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';

import { DEVICES, info as deviceInfo, detectLocal } from './devices.js';
import { info as modelInfo, fitsOn, trainOn } from './models.js';

export const CAPABILITY_VERSION = 'device-cap-v1';

// All known runtimes the registry understands. Adding a runtime here without
// adding a backend in src/artifact-runner is a lie; the runtime check in
// supportsRuntime is the gate that prevents that lie from shipping.
export const KNOWN_RUNTIMES = new Set([
  'llama-cpp',     // CPU + GPU; widest support
  'mlc-llm',       // Apple Silicon iOS / Android compiled
  'mediapipe',     // Google AICore / on-device Android
  'aicore',        // Pixel 9 Pro Tensor G4 system NPU
  'transformers-js', // Browser / Cloudflare Worker WASM
  'tensorrt-llm',  // NVIDIA Jetson + dGPU
  'mlx',           // Apple Silicon native (mlx_lm)
  'directml',      // Windows Intel/AMD iGPU
  'vllm',          // Server-class batched serving
  'onnxruntime',   // Cross-platform ONNX
]);

export const KNOWN_MODALITIES = new Set(['text', 'image', 'audio', 'video']);

// The 4 attestation flavors we currently know how to verify.
export const KNOWN_ATTESTATIONS = new Set(['pccs', 'snp-report', 'nitro-attestation', 'nras']);

// Static lookup: which runtimes does this device profile support?
// Derived from each device entry's `runtime` field plus architecture.
export function runtimesFor(deviceId) {
  const d = deviceInfo(deviceId);
  if (!d) return [];
  const out = new Set();
  if (d.runtime) out.add(d.runtime);
  // Linux/Mac CPU x86_64 / aarch64 always also has llama-cpp + onnxruntime.
  if (d.arch === 'x86_64' || d.arch === 'aarch64') {
    out.add('llama-cpp');
    out.add('onnxruntime');
  }
  // Apple silicon: MLX is always available.
  if (d.arch === 'apple-silicon') {
    out.add('mlx');
  }
  // CUDA boxes can run vLLM and TensorRT-LLM in addition to llama-cpp.
  if (d.cuda_min) {
    out.add('vllm');
    out.add('llama-cpp');
    out.add('onnxruntime');
  }
  // WASM is its own one-runtime world.
  if (d.arch === 'wasm32') {
    return ['transformers-js'];
  }
  return Array.from(out).sort();
}

// Modalities a device can usefully handle. Conservative: text always, images
// only when a GPU/NPU exists, audio/video only when the device profile says so.
export function modalitiesFor(deviceId) {
  const d = deviceInfo(deviceId);
  if (!d) return [];
  if (d.arch === 'wasm32') return ['text'];
  const out = new Set(['text']);
  if (d.vram_gb >= 2 || d.runtime === 'mediapipe' || d.runtime === 'aicore' || d.runtime === 'mlc-llm') {
    out.add('image');
  }
  // Apple Silicon + Jetson + dGPU class can handle audio/video.
  if (d.arch === 'apple-silicon' || d.runtime === 'tensorrt-llm' || d.cuda_min) {
    out.add('audio');
    out.add('video');
  }
  return Array.from(out).sort();
}

export function supportsRuntime(deviceId, runtime) {
  if (!KNOWN_RUNTIMES.has(runtime)) return false;
  return runtimesFor(deviceId).includes(runtime);
}

export function supportsModality(deviceId, modality) {
  if (!KNOWN_MODALITIES.has(modality)) return false;
  return modalitiesFor(deviceId).includes(modality);
}

export function supportsConfidentialCompute(deviceId) {
  const d = deviceInfo(deviceId);
  if (!d || !d.tee) return false;
  return KNOWN_ATTESTATIONS.has(d.attestation);
}

export function attestationKind(deviceId) {
  const d = deviceInfo(deviceId);
  return d?.attestation || null;
}

// Capability profile: JSON-serializable, riding inside the .kolm manifest
// under target_device.capabilities. The verifier rebuilds this from devices.js
// using the same code path; equality is the contract.
export function profileFor(deviceId) {
  const d = deviceInfo(deviceId);
  if (!d) return null;
  return {
    version: CAPABILITY_VERSION,
    device_id: d.id,
    arch: d.arch,
    vram_gb: d.vram_gb,
    cpu_ram_gb_min: d.cpu_ram_gb_min || null,
    runtimes: runtimesFor(d.id),
    modalities: modalitiesFor(d.id),
    tee: d.tee || null,
    attestation: d.attestation || null,
    confidential_compute: supportsConfidentialCompute(d.id),
  };
}

// Capability check at artifact load time. The runtime calls this with the
// manifest's target_device profile and the locally-detected device. Returns
// {ok: true} or {ok: false, reason: string, want: ..., got: ...}.
export function meetsRequirement(targetProfile, hostDeviceId) {
  if (!targetProfile) return { ok: false, reason: 'no target profile' };
  const host = profileFor(hostDeviceId);
  if (!host) return { ok: false, reason: `unknown host device: ${hostDeviceId}` };

  // VRAM gate. Accept either `min_vram_gb` (capability-block format from
  // artifact-lineage.buildCapability) or `vram_gb` (raw device profile shape).
  const targetVram = targetProfile.min_vram_gb != null ? targetProfile.min_vram_gb : targetProfile.vram_gb;
  if (targetVram != null && host.vram_gb < targetVram) {
    return { ok: false, reason: 'insufficient_vram', want: targetVram, got: host.vram_gb };
  }
  // Runtime intersection: host must offer at least one runtime the target lists.
  if (Array.isArray(targetProfile.runtimes) && targetProfile.runtimes.length > 0) {
    const overlap = targetProfile.runtimes.filter(r => host.runtimes.includes(r));
    if (overlap.length === 0) {
      return { ok: false, reason: 'no_compatible_runtime', want: targetProfile.runtimes, got: host.runtimes };
    }
  }
  // Modality coverage: every modality the target requires must be supported.
  if (Array.isArray(targetProfile.modalities) && targetProfile.modalities.length > 0) {
    const missing = targetProfile.modalities.filter(m => !host.modalities.includes(m));
    if (missing.length > 0) {
      return { ok: false, reason: 'missing_modality', want: targetProfile.modalities, got: host.modalities, missing };
    }
  }
  // Confidential compute: if the target requires TEE, host must offer it.
  if (targetProfile.confidential_compute && !host.confidential_compute) {
    return { ok: false, reason: 'no_confidential_compute', want: targetProfile.attestation, got: null };
  }
  if (targetProfile.attestation && targetProfile.attestation !== host.attestation) {
    return { ok: false, reason: 'attestation_mismatch', want: targetProfile.attestation, got: host.attestation };
  }
  return { ok: true };
}

// Pick a runtime for the artifact given (artifact-target-profile, host) pair.
// Returns the first runtime that the artifact target *and* the host both
// support, preferring the artifact's first-listed (== preferred) runtime.
export function chooseRuntime(targetProfile, hostDeviceId) {
  const host = profileFor(hostDeviceId);
  if (!host) return null;
  const targetRuntimes = Array.isArray(targetProfile?.runtimes) ? targetProfile.runtimes : [];
  for (const r of targetRuntimes) {
    if (host.runtimes.includes(r)) return r;
  }
  // No overlap with the target's listed runtimes: fall back to llama-cpp
  // when host supports it (universal fallback), else null.
  if (host.runtimes.includes('llama-cpp')) return 'llama-cpp';
  return null;
}

// Surface used by the CLI's `kolm device` command and by the runtime probe.
export async function probeHost() {
  const detected = await detectLocal();
  return profileFor(detected.id);
}

// Cross-check: does the model fit on the device under the inference budget?
// Re-exports fitsOn / trainOn for callers that already have models.js but
// want the device-capabilities one-stop shop.
export function modelFits(modelId, deviceId) {
  const d = deviceInfo(deviceId);
  return fitsOn(modelId, d);
}

export function modelTrains(modelId, deviceId) {
  const d = deviceInfo(deviceId);
  return trainOn(modelId, d);
}

// Bundle of every device profile, used for the registry catalog endpoint.
export function allProfiles() {
  return DEVICES.map(d => profileFor(d.id));
}

// ====================================================================
// W372 device-fleet API. Operator-registered device profiles live in
// ~/.kolm/devices/<device_id>.json. The static catalog in src/devices.js is
// the "what shapes exist?" reference; this fleet API is "what devices does
// THIS operator actually own?".
// ====================================================================

export const DEVICE_KINDS = Object.freeze([
  'laptop', 'server', 'browser', 'phone', 'gpu_box', 'edge', 'vpc', 'air_gapped', 'local',
]);
export const RUNTIMES = Object.freeze([
  'node', 'bun', 'deno', 'mlx', 'llama.cpp', 'onnx', 'wasm', 'executorch', 'coreml', 'litert',
]);
export const MODALITIES = Object.freeze(['text', 'vision', 'audio', 'video']);

function _home() { return process.env.HOME || process.env.USERPROFILE || os.homedir(); }
function _devicesDir() {
  const base = process.env.KOLM_DATA_DIR ? path.resolve(process.env.KOLM_DATA_DIR) : path.join(_home(), '.kolm');
  const p = path.join(base, 'devices');
  fs.mkdirSync(p, { recursive: true });
  return p;
}

export function deviceProfileSchema() {
  return {
    $schema: 'https://json-schema.org/draft/2020-12/schema',
    type: 'object',
    required: ['device_id', 'kind'],
    properties: {
      device_id: { type: 'string', pattern: '^[a-z0-9][a-z0-9._-]{0,62}$' },
      kind:      { type: 'string', enum: Array.from(DEVICE_KINDS) },
      os:        { type: 'string' },
      chip:      { type: 'string' },
      ram_gb:    { type: 'number' },
      gpu:       { type: ['object', 'null'] },
      runtimes:  { type: 'array', items: { type: 'string' } },
      supports:  { type: 'object' },
      ssh:       { type: ['object', 'null'] },
      manifest_url: { type: ['string', 'null'] },
      api_key:   { type: ['string', 'null'] },
      registered_at: { type: 'string' },
    },
  };
}

function _validateProfile(profile) {
  const errors = [];
  if (!profile || typeof profile !== 'object') { errors.push('profile must be an object'); return errors; }
  if (!profile.device_id || typeof profile.device_id !== 'string') errors.push('device_id required');
  else if (!/^[a-z0-9][a-z0-9._-]{0,62}$/.test(profile.device_id)) errors.push('device_id must match ^[a-z0-9][a-z0-9._-]{0,62}$');
  if (!profile.kind || !DEVICE_KINDS.includes(profile.kind)) errors.push(`kind must be one of: ${DEVICE_KINDS.join(', ')}`);
  if (profile.runtimes && !Array.isArray(profile.runtimes)) errors.push('runtimes must be an array');
  return errors;
}

function _profilePath(deviceId) {
  return path.join(_devicesDir(), `${deviceId}.json`);
}

// detectLocalDevice() probes the host using the same nvidia-smi /
// system_profiler / sysctl logic as cli/kolm.js#detectHardware and
// src/devices.js#detectLocal. Builds a device profile + persists it under
// ~/.kolm/devices/local.json so subsequent CLIs (kolm runtime, kolm
// install-device) can refer to "local" without re-probing.
export async function detectLocalDevice() {
  const profile = {
    device_id: 'local',
    kind: 'local',
    os: `${process.platform}-${process.arch}`,
    chip: null,
    ram_gb: Math.round(os.totalmem() / 1024 / 1024 / 1024),
    gpu: null,
    runtimes: [],
    supports: { text: true, vision: false, audio: false, video: false },
    registered_at: new Date().toISOString(),
  };

  // Node is always present (we're running inside it).
  profile.runtimes.push('node');

  // Try nvidia-smi.
  try {
    const r = spawnSync('nvidia-smi', ['--query-gpu=name,memory.total,driver_version,compute_cap', '--format=csv,noheader,nounits'], { encoding: 'utf8', timeout: 5000 });
    if (r.status === 0 && r.stdout && r.stdout.trim()) {
      const [name, memMiB, driver, sm] = r.stdout.trim().split(/\r?\n/)[0].split(',').map(s => s.trim());
      profile.gpu = {
        vendor: 'nvidia',
        name,
        vram_gb: Math.round(Number(memMiB) / 1024),
        driver,
        compute_cap: sm,
      };
      profile.chip = name;
      profile.runtimes.push('llama.cpp');
      profile.runtimes.push('onnx');
      profile.supports.vision = true;
    }
  } catch {}

  // macOS sysctl / system_profiler.
  if (!profile.gpu && process.platform === 'darwin') {
    try {
      const sys = spawnSync('sysctl', ['-n', 'machdep.cpu.brand_string'], { encoding: 'utf8', timeout: 3000 });
      if (sys.status === 0) profile.chip = sys.stdout.trim();
    } catch {}
    try {
      const sp = spawnSync('system_profiler', ['SPDisplaysDataType'], { encoding: 'utf8', timeout: 5000 });
      if (sp.status === 0 && sp.stdout) {
        const lines = sp.stdout.split(/\r?\n/);
        const chipset = (lines.find(l => /Chipset Model:/.test(l)) || '').split(':')[1];
        const m = (lines.find(l => /VRAM/.test(l)) || '').match(/(\d+)\s*GB/);
        if (chipset) profile.gpu = profile.gpu || { vendor: 'apple', name: chipset.trim(), vram_gb: m ? Number(m[1]) : null };
      }
      if (process.platform === 'darwin') {
        profile.runtimes.push('mlx');
        profile.runtimes.push('coreml');
      }
    } catch {}
  }

  // Windows wmic for CPU/GPU. system_profiler doesn't exist; nvidia-smi
  // covered the GPU case. Try wmic if no GPU yet (best-effort, may not be
  // present on Win11 24H2+).
  if (!profile.gpu && process.platform === 'win32') {
    try {
      const r = spawnSync('wmic', ['path', 'win32_VideoController', 'get', 'name,adapterram'], { encoding: 'utf8', timeout: 5000 });
      if (r.status === 0 && r.stdout) {
        const line = r.stdout.split(/\r?\n/).slice(1).find(l => l.trim());
        if (line) {
          const tokens = line.trim().split(/\s+/);
          const ram = Number(tokens[0]);
          const name = tokens.slice(1).join(' ');
          if (name) profile.gpu = { vendor: 'unknown', name, vram_gb: ram ? Math.round(ram / 1024 / 1024 / 1024) : null };
        }
      }
    } catch {}
  }

  // CPU-only fallback.
  if (!profile.runtimes.includes('llama.cpp')) profile.runtimes.push('llama.cpp');
  if (!profile.runtimes.includes('onnx')) profile.runtimes.push('onnx');

  // Persist + return.
  const f = _profilePath('local');
  fs.writeFileSync(f, JSON.stringify(profile, null, 2));
  return profile;
}

export async function listDevices() {
  const dir = _devicesDir();
  if (!fs.existsSync(dir)) return [];
  const out = [];
  for (const f of fs.readdirSync(dir)) {
    if (!f.endsWith('.json')) continue;
    try {
      const p = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'));
      out.push(p);
    } catch {}
  }
  // Newest-first by registered_at.
  out.sort((a, b) => String(b.registered_at || '').localeCompare(String(a.registered_at || '')));
  return out;
}

export async function getDevice(deviceId) {
  const f = _profilePath(deviceId);
  if (!fs.existsSync(f)) return null;
  try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return null; }
}

export async function registerDevice(profile) {
  const errs = _validateProfile(profile);
  if (errs.length) {
    const e = new Error('invalid device profile: ' + errs.join('; '));
    e.code = 'KOLM_E_INVALID_PROFILE';
    e.errors = errs;
    throw e;
  }
  const canonical = {
    ...profile,
    runtimes: Array.from(new Set(profile.runtimes || [])),
    supports: profile.supports || { text: true, vision: false, audio: false, video: false },
    registered_at: profile.registered_at || new Date().toISOString(),
  };
  fs.writeFileSync(_profilePath(canonical.device_id), JSON.stringify(canonical, null, 2));
  return canonical;
}

export async function testDevice(deviceId) {
  const d = await getDevice(deviceId);
  if (!d) return { reachable: false, reason: 'unknown device' };
  if (d.kind === 'local' || d.kind === 'laptop' || d.kind === 'server') {
    // Local: process is the device.
    return {
      reachable: true,
      runtime_status: { node: true },
      capacity: { ram_gb: d.ram_gb || null, gpu_vram_gb: d.gpu?.vram_gb || null },
    };
  }
  if (d.ssh) {
    try {
      const host = String(d.ssh.host || '');
      if (!host || host.startsWith('-')) return { reachable: false, reason: 'ssh.host missing/unsafe' };
      const user = d.ssh.user ? `${d.ssh.user}@` : '';
      const args = ['-o', 'StrictHostKeyChecking=accept-new', '-o', 'ConnectTimeout=5'];
      if (d.ssh.port) args.push('-p', String(Number(d.ssh.port)));
      if (d.ssh.identity_file) args.push('-i', String(d.ssh.identity_file));
      args.push('--', `${user}${host}`, 'echo kolm-ping');
      const r = spawnSync('ssh', args, { encoding: 'utf8', timeout: 10_000 });
      return {
        reachable: r.status === 0 && /kolm-ping/.test(r.stdout),
        runtime_status: { ssh: r.status === 0 },
        capacity: { ram_gb: d.ram_gb || null },
        stderr: (r.stderr || '').trim().slice(0, 200) || undefined,
      };
    } catch (e) {
      return { reachable: false, reason: e.message };
    }
  }
  if (d.manifest_url) {
    try {
      const resp = await fetch(d.manifest_url, { method: 'HEAD' });
      return { reachable: resp.ok, runtime_status: { http: resp.ok }, status: resp.status };
    } catch (e) {
      return { reachable: false, reason: e.message };
    }
  }
  return { reachable: false, reason: 'no transport (no ssh, no manifest_url)' };
}

// compatibleArtifacts(profile, artifactsList): filter artifacts a device can
// actually load. Conservative rules: every artifact runs on node (we
// generate recipe.bundle.mjs, W367), so the gate is mostly "does the host
// have node + sufficient RAM"; modality/runtime mismatches drop the row.
export function compatibleArtifacts(deviceProfile, artifactsList) {
  if (!deviceProfile || !Array.isArray(artifactsList)) return [];
  const hasNode = (deviceProfile.runtimes || []).includes('node');
  return artifactsList.filter(a => {
    if (!a) return false;
    // .kolm bundle path requires node-compatible runtime
    if (!hasNode && !deviceProfile.runtimes?.includes('bun') && !deviceProfile.runtimes?.includes('deno')) return false;
    // Modality coverage: if the artifact declares modalities, the device must support all of them.
    const mods = Array.isArray(a.modalities) ? a.modalities : [];
    for (const m of mods) {
      if (!(deviceProfile.supports && deviceProfile.supports[m])) return false;
    }
    // RAM gate.
    if (a.min_ram_gb && deviceProfile.ram_gb && deviceProfile.ram_gb < a.min_ram_gb) return false;
    return true;
  });
}

export default {
  CAPABILITY_VERSION,
  KNOWN_RUNTIMES,
  KNOWN_MODALITIES,
  KNOWN_ATTESTATIONS,
  DEVICE_KINDS,
  RUNTIMES,
  MODALITIES,
  runtimesFor,
  modalitiesFor,
  supportsRuntime,
  supportsModality,
  supportsConfidentialCompute,
  attestationKind,
  profileFor,
  meetsRequirement,
  chooseRuntime,
  probeHost,
  modelFits,
  modelTrains,
  allProfiles,
  deviceProfileSchema,
  detectLocalDevice,
  listDevices,
  getDevice,
  registerDevice,
  testDevice,
  compatibleArtifacts,
};
