// Device profile registry. The .kolm artifact declares a `target_device`
// at compile time; the runtime asserts that the actual host meets the
// profile before loading weights. This gives us "compile once, run on
// a specific class of device" with a verifiable receipt.
//
// Profiles include training-capable rigs (5090, 4090, A100, H100, M3 Max),
// inference-only consumer devices (iPhone 15 Pro, Pixel 8, generic laptop)
// and the lowest-common-denominator targets (WASM, CPU-only x86_64).

export const DEVICES = [
  // ----- Training rigs -----
  {
    id: 'rtx-5090',
    label: 'NVIDIA RTX 5090',
    class: 'training',
    arch: 'blackwell',
    sm: '12.0',
    vram_gb: 32,
    fp4: true,
    fp8: true,
    bf16: true,
    flash_attn: 'fa3',
    cuda_min: '12.8',
    torch_min: '2.7',
    notes: 'Local dev rig. FA3 + FP4 inference + NVFP4 training (with torch ≥ 2.8).',
  },
  {
    id: 'rtx-4090',
    label: 'NVIDIA RTX 4090',
    class: 'training',
    arch: 'ada-lovelace',
    sm: '8.9',
    vram_gb: 24,
    fp4: false,
    fp8: true,
    bf16: true,
    flash_attn: 'fa2',
    cuda_min: '12.1',
    torch_min: '2.4',
  },
  {
    id: 'rtx-3090',
    label: 'NVIDIA RTX 3090',
    class: 'training',
    arch: 'ampere',
    sm: '8.6',
    vram_gb: 24,
    fp4: false,
    fp8: false,
    bf16: true,
    flash_attn: 'fa2',
    cuda_min: '11.8',
    torch_min: '2.2',
  },
  {
    id: 'a100-40gb',
    label: 'NVIDIA A100 40GB',
    class: 'training',
    arch: 'ampere',
    sm: '8.0',
    vram_gb: 40,
    fp4: false,
    fp8: false,
    bf16: true,
    flash_attn: 'fa2',
    cuda_min: '11.8',
    torch_min: '2.2',
  },
  {
    id: 'a100-80gb',
    label: 'NVIDIA A100 80GB',
    class: 'training',
    arch: 'ampere',
    sm: '8.0',
    vram_gb: 80,
    fp4: false,
    fp8: false,
    bf16: true,
    flash_attn: 'fa2',
    cuda_min: '11.8',
    torch_min: '2.2',
  },
  {
    id: 'h100-80gb',
    label: 'NVIDIA H100 80GB',
    class: 'training',
    arch: 'hopper',
    sm: '9.0',
    vram_gb: 80,
    fp4: false,
    fp8: true,
    bf16: true,
    flash_attn: 'fa3',
    cuda_min: '12.4',
    torch_min: '2.4',
  },
  {
    id: 'h200-141gb',
    label: 'NVIDIA H200 141GB',
    class: 'training',
    arch: 'hopper',
    sm: '9.0',
    vram_gb: 141,
    fp4: false,
    fp8: true,
    bf16: true,
    flash_attn: 'fa3',
    cuda_min: '12.4',
    torch_min: '2.4',
  },

  // ----- Apple Silicon -----
  {
    id: 'apple-m3-max',
    label: 'Apple M3 Max',
    class: 'training',
    arch: 'apple-silicon',
    sm: null,
    vram_gb: 64,
    fp4: false,
    fp8: false,
    bf16: true,
    flash_attn: 'mlx',
    runtime: 'mlx',
    notes: 'MLX-native training via mlx_lm. No CUDA stack.',
  },
  {
    id: 'apple-m2-pro',
    label: 'Apple M2 Pro',
    class: 'inference',
    arch: 'apple-silicon',
    sm: null,
    vram_gb: 16,
    fp4: false,
    fp8: false,
    bf16: true,
    flash_attn: 'mlx',
    runtime: 'mlx',
  },

  // ----- Edge / mobile -----
  {
    id: 'iphone-15-pro',
    label: 'iPhone 15 Pro / 16 Pro',
    class: 'inference',
    arch: 'apple-silicon',
    sm: null,
    vram_gb: 4,
    fp4: false,
    fp8: false,
    bf16: false,
    runtime: 'mlc-llm',
    notes: 'Use Q4_K_M GGUF or MLC compiled. Max recommended: 1.5B params.',
  },
  {
    id: 'pixel-8-pro',
    label: 'Pixel 8 Pro / 9 Pro',
    class: 'inference',
    arch: 'arm64',
    sm: null,
    vram_gb: 3,
    fp4: false,
    fp8: false,
    bf16: false,
    runtime: 'mediapipe',
    notes: 'Tensor G3/G4 NPU via MediaPipe. Max recommended: 2B params Q4.',
  },
  {
    id: 'laptop-igpu',
    label: 'Laptop iGPU (Intel / AMD)',
    class: 'inference',
    arch: 'x86_64',
    sm: null,
    vram_gb: 2,
    fp4: false,
    fp8: false,
    bf16: false,
    runtime: 'directml',
    notes: 'DirectML or ONNX Runtime. Q4 only. Max: 1.5B params.',
  },
  {
    id: 'cpu-x86_64',
    label: 'Generic x86_64 CPU',
    class: 'inference',
    arch: 'x86_64',
    sm: null,
    vram_gb: 0,
    cpu_ram_gb_min: 8,
    runtime: 'llama-cpp',
    notes: 'llama.cpp Q4. Max practical: 3B at ~5 tok/s.',
  },
  {
    id: 'wasm',
    label: 'WASM (browser, Cloudflare Worker)',
    class: 'inference',
    arch: 'wasm32',
    sm: null,
    vram_gb: 0,
    cpu_ram_gb_min: 1,
    runtime: 'transformers-js',
    notes: 'transformers.js ONNX Q4. Max practical: 500M params.',
  },

  // ----- Real edge-AI dev kits -----
  {
    id: 'jetson-orin-nano-8gb',
    label: 'NVIDIA Jetson Orin Nano 8GB (Super)',
    class: 'inference',
    arch: 'aarch64',
    sm: '8.7',
    vram_gb: 8,
    fp4: false,
    fp8: false,
    bf16: true,
    flash_attn: 'fa2',
    cuda_min: '12.2',
    runtime: 'tensorrt-llm',
    notes: 'Unified memory (CPU+GPU share 8GB LPDDR5). 67 TOPS. Run Qwen 2.5 3B Q4 ~25 tok/s.',
  },
  {
    id: 'jetson-orin-agx-64gb',
    label: 'NVIDIA Jetson AGX Orin 64GB',
    class: 'training',
    arch: 'aarch64',
    sm: '8.7',
    vram_gb: 64,
    fp4: false,
    fp8: false,
    bf16: true,
    flash_attn: 'fa2',
    cuda_min: '12.2',
    runtime: 'tensorrt-llm',
    notes: '275 TOPS. Capable of QLoRA on 7B at the edge.',
  },
  {
    id: 'raspberry-pi-5',
    label: 'Raspberry Pi 5 (8GB)',
    class: 'inference',
    arch: 'aarch64',
    sm: null,
    vram_gb: 0,
    cpu_ram_gb_min: 8,
    runtime: 'llama-cpp',
    notes: 'CPU-only. Cortex-A76 quad. Max practical: SmolLM2 1.7B Q4 ~3 tok/s, Gemma 3 1B Q4 ~2 tok/s.',
  },

  // ----- Mobile devices (NPU class) -----
  {
    id: 'iphone-16-pro',
    label: 'iPhone 16 Pro / 17 Pro',
    class: 'inference',
    arch: 'apple-silicon',
    sm: null,
    vram_gb: 6,
    fp4: false,
    fp8: false,
    bf16: false,
    runtime: 'mlc-llm',
    notes: 'A18 Pro Neural Engine. Max practical: Gemma 3n E2B, Qwen 2.5 1.5B Q4.',
  },
  {
    id: 'pixel-9-pro-tpu',
    label: 'Pixel 9 Pro (Tensor G4)',
    class: 'inference',
    arch: 'arm64',
    sm: null,
    vram_gb: 4,
    fp4: false,
    fp8: false,
    bf16: false,
    runtime: 'aicore',
    notes: 'Tensor G4 + AICore. AICore exposes Gemini Nano 1.5/2.0 via system SDK. Max sideloaded: Gemma 3n E2B.',
  },
  {
    id: 'android-snapdragon-8-gen3',
    label: 'Android (Snapdragon 8 Gen 3)',
    class: 'inference',
    arch: 'arm64',
    sm: null,
    vram_gb: 4,
    fp4: false,
    fp8: false,
    bf16: false,
    runtime: 'mediapipe',
    notes: 'Hexagon NPU. Use MediaPipe LLM Inference API. Max practical: Gemma 3 1B Q4.',
  },

  // ----- Confidential compute (TEE) devices -----
  // These are server-class boxes that produce hardware attestations. Used
  // when the artifact must run inside a verified enclave. The verifier
  // consumes the device attestation + the artifact receipt together.
  {
    id: 'intel-tdx-icx',
    label: 'Intel TDX (Ice Lake / Sapphire Rapids)',
    class: 'inference',
    arch: 'x86_64',
    sm: null,
    vram_gb: 0,
    cpu_ram_gb_min: 32,
    runtime: 'llama-cpp',
    tee: 'intel-tdx',
    attestation: 'pccs',
    notes: 'Intel TDX trust domain. Attestation via PCCS / Intel Trust Authority. CPU-only inference inside the TD.',
  },
  {
    id: 'amd-sev-snp',
    label: 'AMD SEV-SNP (EPYC Milan / Genoa)',
    class: 'inference',
    arch: 'x86_64',
    sm: null,
    vram_gb: 0,
    cpu_ram_gb_min: 32,
    runtime: 'llama-cpp',
    tee: 'amd-sev-snp',
    attestation: 'snp-report',
    notes: 'AMD SEV-SNP confidential VM. Attestation report verifiable against AMD root key.',
  },
  {
    id: 'aws-nitro-enclave',
    label: 'AWS Nitro Enclave',
    class: 'inference',
    arch: 'x86_64',
    sm: null,
    vram_gb: 0,
    cpu_ram_gb_min: 16,
    runtime: 'llama-cpp',
    tee: 'aws-nitro',
    attestation: 'nitro-attestation',
    notes: 'AWS Nitro Enclave isolated from parent EC2. Attestation via /dev/nsm + KMS.',
  },
  {
    id: 'nvidia-h100-cc',
    label: 'NVIDIA H100 in Confidential Compute mode',
    class: 'training',
    arch: 'hopper',
    sm: '9.0',
    vram_gb: 80,
    fp4: false,
    fp8: true,
    bf16: true,
    flash_attn: 'fa3',
    cuda_min: '12.4',
    torch_min: '2.4',
    tee: 'nvidia-cc',
    attestation: 'nras',
    notes: 'H100 CC mode pairs with TDX or SEV-SNP host. Attestation via NRAS (NVIDIA Remote Attestation Service).',
  },
];

// What model the trainer should default to when training ON this device.
// Picks: max model that fits in 4-bit QLoRA + 2x activation overhead + KV cache.
export const TRAIN_DEFAULT_BY_DEVICE = {
  'rtx-5090': 'Qwen/Qwen2.5-7B-Instruct',
  'rtx-4090': 'Qwen/Qwen2.5-7B-Instruct',
  'rtx-3090': 'Qwen/Qwen2.5-7B-Instruct',
  'a100-40gb': 'Qwen/Qwen2.5-14B-Instruct',
  'a100-80gb': 'Qwen/Qwen2.5-14B-Instruct',
  'h100-80gb': 'Qwen/Qwen2.5-14B-Instruct',
  'h200-141gb': 'Qwen/Qwen2.5-14B-Instruct',
  'apple-m3-max': 'Qwen/Qwen2.5-7B-Instruct',
  'apple-m2-pro': 'Qwen/Qwen2.5-3B-Instruct',
};

// What target the .kolm artifact should compile FOR when shipping to this device.
// Picks: max model the device can actually inference at >= 30 tok/s.
export const INFER_DEFAULT_BY_DEVICE = {
  'rtx-5090': 'Qwen/Qwen2.5-7B-Instruct',
  'rtx-4090': 'Qwen/Qwen2.5-7B-Instruct',
  'rtx-3090': 'Qwen/Qwen2.5-7B-Instruct',
  'a100-40gb': 'Qwen/Qwen2.5-14B-Instruct',
  'apple-m3-max': 'Qwen/Qwen2.5-7B-Instruct',
  'apple-m2-pro': 'Qwen/Qwen2.5-3B-Instruct',
  'iphone-15-pro': 'Qwen/Qwen2.5-1.5B-Instruct',
  'iphone-16-pro': 'google/gemma-3n-E2B-it',
  'pixel-8-pro': 'google/gemma-2-2b-it',
  'pixel-9-pro-tpu': 'google/gemma-3n-E2B-it',
  'android-snapdragon-8-gen3': 'google/gemma-3-1b-it',
  'laptop-igpu': 'Qwen/Qwen2.5-1.5B-Instruct',
  'cpu-x86_64': 'Qwen/Qwen2.5-1.5B-Instruct',
  'wasm': 'Qwen/Qwen2.5-0.5B-Instruct',
  'jetson-orin-nano-8gb': 'Qwen/Qwen2.5-3B-Instruct',
  'jetson-orin-agx-64gb': 'Qwen/Qwen2.5-7B-Instruct',
  'raspberry-pi-5': 'HuggingFaceTB/SmolLM2-1.7B-Instruct',
  'intel-tdx-icx': 'Qwen/Qwen2.5-3B-Instruct',
  'amd-sev-snp': 'Qwen/Qwen2.5-3B-Instruct',
  'aws-nitro-enclave': 'Qwen/Qwen2.5-1.5B-Instruct',
  'nvidia-h100-cc': 'Qwen/Qwen2.5-14B-Instruct',
};

// Devices that produce hardware attestations. Used by src/confidential-compute.js
// to decide what attestation type to expect at runtime.
export const TEE_DEVICES = DEVICES.filter(d => d.tee).map(d => ({
  id: d.id,
  tee: d.tee,
  attestation: d.attestation,
}));

export function info(id) {
  return DEVICES.find(d => d.id === id) || null;
}

export function list(cls) {
  return cls ? DEVICES.filter(d => d.class === cls) : DEVICES.slice();
}

// Detect the local device. Best-effort using env hints and standard probes
// invoked from the JS side. Heavy GPU probes happen in compute/backends.
export async function detectLocal() {
  // Honor explicit override first.
  if (process.env.KOLM_DEVICE) {
    const d = info(process.env.KOLM_DEVICE);
    if (d) return { id: d.id, source: 'env', confidence: 1.0 };
  }

  // Try nvidia-smi for CUDA boxes.
  const { execFile } = await import('node:child_process');
  const { promisify } = await import('node:util');
  const run = promisify(execFile);
  try {
    const { stdout } = await run('nvidia-smi', ['--query-gpu=name,memory.total,compute_cap', '--format=csv,noheader']);
    const line = stdout.trim().split('\n')[0] || '';
    const m = line.match(/^([^,]+),\s*([\d.]+)\s*MiB,\s*([\d.]+)/);
    if (m) {
      const name = m[1];
      const vramMiB = Number(m[2]);
      const sm = m[3];
      const guess = matchGpuName(name, vramMiB, sm);
      if (guess) return { id: guess.id, source: 'nvidia-smi', confidence: 0.95, raw: { name, vram_gb: Number((vramMiB / 1024).toFixed(1)), sm } };
    }
  } catch { /* no nvidia-smi */ }

  // Try sysctl on macOS.
  if (process.platform === 'darwin') {
    try {
      const { stdout } = await run('sysctl', ['-n', 'machdep.cpu.brand_string']);
      const brand = stdout.trim();
      if (brand.includes('M3 Max')) return { id: 'apple-m3-max', source: 'sysctl', confidence: 0.9 };
      if (brand.includes('M2 Pro')) return { id: 'apple-m2-pro', source: 'sysctl', confidence: 0.9 };
      if (brand.includes('M2 Max')) return { id: 'apple-m3-max', source: 'sysctl', confidence: 0.7, note: 'approx as m3-max profile' };
    } catch {}
  }

  // Fallback: generic CPU.
  return { id: 'cpu-x86_64', source: 'fallback', confidence: 0.5 };
}

function matchGpuName(name, vramMiB, sm) {
  const n = String(name);
  if (n.includes('RTX 5090')) return { id: 'rtx-5090' };
  if (n.includes('RTX 4090')) return { id: 'rtx-4090' };
  if (n.includes('RTX 3090')) return { id: 'rtx-3090' };
  if (n.includes('H200')) return { id: 'h200-141gb' };
  if (n.includes('H100')) return { id: 'h100-80gb' };
  if (n.includes('A100')) {
    if (vramMiB >= 70000) return { id: 'a100-80gb' };
    return { id: 'a100-40gb' };
  }
  return null;
}

export default { DEVICES, TRAIN_DEFAULT_BY_DEVICE, INFER_DEFAULT_BY_DEVICE, TEE_DEVICES, list, info, detectLocal };
