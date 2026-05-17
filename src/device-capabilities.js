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

// Capability profile — JSON-serializable, riding inside the .kolm manifest
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

export default {
  CAPABILITY_VERSION,
  KNOWN_RUNTIMES,
  KNOWN_MODALITIES,
  KNOWN_ATTESTATIONS,
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
};
