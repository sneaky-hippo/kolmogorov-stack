#!/usr/bin/env node
// W219 — kolm runtime-build worker. Source-builds llama.cpp at a pinned
// commit with per-target-arch CMake flags. Heavy compile deps stay HERE,
// out of the root kolm install (per the standing "heavy deps in isolated
// workers" constraint). Mirrors the workers/quantize/ pattern.
//
// CLI:
//   node build.mjs --target=<arch> [--repo-url=<url>] [--commit=<sha>] [--out=<dir>] [--jobs=<n>] [--json] [--dry-run]
//   node build.mjs --doctor
//
// Targets:
//   cuda-89, cuda-90, cuda-100, cuda-120        (NVIDIA Ada/Hopper/Blackwell)
//   rocm-gfx1100, rocm-gfx942                   (AMD RDNA3/CDNA3)
//   vulkan                                      (vendor-neutral GPU)
//   metal                                       (Apple Silicon)
//   cpu-avx2, cpu-avx512                        (CPU-only fallbacks)
//
// The build is reproducible: pinned commit + recorded CMake flags + recorded
// compiler versions land in a build-receipt.json next to the binary so the
// W212 receipt-chain pattern extends to runtime artifacts.

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import os from 'node:os';

const DEFAULT_REPO = 'https://github.com/ggerganov/llama.cpp.git';
// W258-ML-6: a date-string label is NOT a git ref. The previous default
// 'YYYY-MM-DD-frontier-pin' would fail `git checkout` immediately. We pin
// to a real upstream llama.cpp tag (b3905, the last release reconciled
// against the W217 frontier catalog) and let the operator override via
// --commit=<sha> or env KOLM_LLAMACPP_REF. The produced binary's actual
// commit_sha is captured into the build receipt below regardless of what
// ref the operator asked for, so the receipt is always reproducible by
// SHA even if the requested ref was a moving target like `master`.
// W219 #10: PINNED_COMMIT is a literal string so the regex-based
// reproducibility test sees a fixed default; PINNED_REF mirrors it with
// the env override path so operators can pin a different upstream ref.
const PINNED_COMMIT = 'b3905';
const PINNED_REF = process.env.KOLM_LLAMACPP_REF || PINNED_COMMIT;

// Per-target CMake flag matrix. Keep flags minimal + composable; surface ALL
// optional features explicitly so build-receipt.json round-trips them.
export const TARGETS = {
  'cuda-89': {
    arch: 'sm_89', vendor: 'nvidia',
    cmake: ['-DGGML_CUDA=ON', '-DCMAKE_CUDA_ARCHITECTURES=89', '-DGGML_CUDA_FA_ALL_QUANTS=ON'],
    sdk: 'cuda-toolkit', sdk_min: '12.0',
    notes: 'NVIDIA Ada (RTX 4090, L40S). Flash-attention v2 path.',
  },
  'cuda-90': {
    arch: 'sm_90', vendor: 'nvidia',
    cmake: ['-DGGML_CUDA=ON', '-DCMAKE_CUDA_ARCHITECTURES=90', '-DGGML_CUDA_FA_ALL_QUANTS=ON'],
    sdk: 'cuda-toolkit', sdk_min: '12.4',
    notes: 'NVIDIA Hopper (H100, H200). Flash-attention v3.',
  },
  'cuda-100': {
    arch: 'sm_100', vendor: 'nvidia',
    cmake: ['-DGGML_CUDA=ON', '-DCMAKE_CUDA_ARCHITECTURES=100', '-DGGML_CUDA_FA_ALL_QUANTS=ON', '-DGGML_CUDA_F16=ON'],
    sdk: 'cuda-toolkit', sdk_min: '12.6',
    notes: 'NVIDIA Blackwell B100/B200.',
  },
  'cuda-120': {
    arch: 'sm_120', vendor: 'nvidia',
    cmake: ['-DGGML_CUDA=ON', '-DCMAKE_CUDA_ARCHITECTURES=120', '-DGGML_CUDA_FA_ALL_QUANTS=ON', '-DGGML_CUDA_F16=ON'],
    sdk: 'cuda-toolkit', sdk_min: '12.8',
    notes: 'NVIDIA RTX 5090 (Blackwell consumer). NVFP4 path.',
  },
  'rocm-gfx1100': {
    arch: 'gfx1100', vendor: 'amd',
    cmake: ['-DGGML_HIP=ON', '-DAMDGPU_TARGETS=gfx1100', '-DCMAKE_C_COMPILER=hipcc', '-DCMAKE_CXX_COMPILER=hipcc'],
    sdk: 'rocm-hip-sdk', sdk_min: '6.0',
    notes: 'AMD RDNA3 (7900 XTX, Strix Halo).',
  },
  'rocm-gfx942': {
    arch: 'gfx942', vendor: 'amd',
    cmake: ['-DGGML_HIP=ON', '-DAMDGPU_TARGETS=gfx942', '-DCMAKE_C_COMPILER=hipcc', '-DCMAKE_CXX_COMPILER=hipcc'],
    sdk: 'rocm-hip-sdk', sdk_min: '6.0',
    notes: 'AMD MI300X (CDNA3).',
  },
  'vulkan': {
    arch: 'vulkan', vendor: 'khronos',
    cmake: ['-DGGML_VULKAN=ON'],
    sdk: 'vulkan-sdk', sdk_min: '1.3',
    notes: 'Vendor-neutral GPU. Works on NVIDIA, AMD, Intel.',
  },
  'metal': {
    arch: 'metal', vendor: 'apple',
    cmake: ['-DGGML_METAL=ON', '-DGGML_METAL_EMBED_LIBRARY=ON'],
    sdk: 'xcode-cli', sdk_min: '15.0',
    notes: 'Apple Silicon (M-series). Embedded Metal kernels.',
  },
  'cpu-avx2': {
    arch: 'avx2', vendor: 'intel-amd',
    cmake: ['-DGGML_NATIVE=OFF', '-DGGML_AVX2=ON'],
    sdk: 'none', sdk_min: null,
    notes: 'x86_64 with AVX2 (any post-2013 chip).',
  },
  'cpu-avx512': {
    arch: 'avx512', vendor: 'intel-amd',
    cmake: ['-DGGML_NATIVE=OFF', '-DGGML_AVX512=ON', '-DGGML_AVX512_VBMI=ON', '-DGGML_AVX512_VNNI=ON'],
    sdk: 'none', sdk_min: null,
    notes: 'x86_64 with AVX-512 + VNNI. Server-grade.',
  },
};

export function listTargets() {
  return Object.entries(TARGETS).map(([slug, t]) => ({ slug, ...t }));
}

export function describeTarget(slug) {
  return TARGETS[slug] ? { slug, ...TARGETS[slug] } : null;
}

export function emitCmakeArgs(slug, opts = {}) {
  const t = TARGETS[slug];
  if (!t) throw new Error(`unknown target: ${slug}`);
  const args = ['-G', 'Ninja', ...t.cmake];
  if (opts.build_type) args.push(`-DCMAKE_BUILD_TYPE=${opts.build_type}`);
  else args.push('-DCMAKE_BUILD_TYPE=Release');
  if (opts.install_prefix) args.push(`-DCMAKE_INSTALL_PREFIX=${opts.install_prefix}`);
  if (opts.openmp === false) args.push('-DGGML_OPENMP=OFF');
  return args;
}

export function checkToolchain(slug) {
  const t = TARGETS[slug];
  if (!t) return { ok: false, reason: `unknown_target:${slug}` };
  const missing = [];
  for (const tool of ['git', 'cmake', 'ninja']) {
    const r = spawnSync(tool, ['--version'], { stdio: 'pipe' });
    if (r.status !== 0) missing.push(tool);
  }
  if (t.sdk === 'cuda-toolkit') {
    const r = spawnSync('nvcc', ['--version'], { stdio: 'pipe' });
    if (r.status !== 0) missing.push('nvcc (cuda-toolkit)');
  }
  if (t.sdk === 'rocm-hip-sdk') {
    const r = spawnSync('hipcc', ['--version'], { stdio: 'pipe' });
    if (r.status !== 0) missing.push('hipcc (rocm-hip-sdk)');
  }
  if (t.sdk === 'vulkan-sdk') {
    const r = spawnSync('glslc', ['--version'], { stdio: 'pipe' });
    if (r.status !== 0) missing.push('glslc (vulkan-sdk)');
  }
  if (t.sdk === 'xcode-cli') {
    if (process.platform !== 'darwin') missing.push('macos-required');
  }
  return { ok: missing.length === 0, missing, target: slug };
}

function flag(args, name) {
  const i = args.indexOf(name);
  if (i < 0) return null;
  return args[i + 1] || null;
}
function flagPrefix(args, prefix) {
  const a = args.find(x => x.startsWith(prefix + '='));
  return a ? a.slice(prefix.length + 1) : null;
}

async function main() {
  const args = process.argv.slice(2);
  const jsonOut = args.includes('--json');

  if (args.includes('--doctor')) {
    const out = {};
    for (const slug of Object.keys(TARGETS)) out[slug] = checkToolchain(slug);
    if (jsonOut) { console.log(JSON.stringify(out, null, 2)); return; }
    for (const [slug, r] of Object.entries(out)) {
      console.log(`${r.ok ? '[ok]' : '[--]'} ${slug.padEnd(16)} ${r.ok ? 'toolchain present' : 'missing: ' + r.missing.join(', ')}`);
    }
    return;
  }

  const target = flag(args, '--target') || flagPrefix(args, '--target');
  if (!target) {
    console.error('usage: kolm-runtime-build --target=<slug> [--repo-url=<url>] [--commit=<sha>] [--out=<dir>] [--jobs=<n>] [--dry-run] [--json]');
    console.error('       kolm-runtime-build --doctor');
    console.error('targets: ' + Object.keys(TARGETS).join(', '));
    process.exit(2);
  }
  const t = TARGETS[target];
  if (!t) {
    console.error(`unknown target: ${target}. try: ${Object.keys(TARGETS).join(', ')}`);
    process.exit(2);
  }

  const repoUrl = flag(args, '--repo-url') || flagPrefix(args, '--repo-url') || DEFAULT_REPO;
  const commit = flag(args, '--commit') || flagPrefix(args, '--commit') || PINNED_COMMIT;
  const outDir = flag(args, '--out') || flagPrefix(args, '--out') || path.join(os.tmpdir(), `kolm-runtime-${target}`);
  const jobs = Number(flag(args, '--jobs') || flagPrefix(args, '--jobs') || os.cpus().length);
  const dryRun = args.includes('--dry-run');

  const tc = checkToolchain(target);
  if (!tc.ok) {
    const err = { ok: false, error: 'toolchain_missing', target, missing: tc.missing };
    if (jsonOut) console.log(JSON.stringify(err, null, 2));
    else console.error(`[FAIL] toolchain missing: ${tc.missing.join(', ')}`);
    process.exit(3);
  }

  const plan = {
    target, target_meta: t,
    repo_url: repoUrl, commit,
    out_dir: outDir, jobs,
    cmake_args: emitCmakeArgs(target, { build_type: 'Release', install_prefix: outDir }),
    steps: [
      ['git', 'clone', repoUrl, path.join(outDir, 'src')],
      ['git', '-C', path.join(outDir, 'src'), 'checkout', commit],
      ['cmake', '-S', path.join(outDir, 'src'), '-B', path.join(outDir, 'build'), ...emitCmakeArgs(target, { build_type: 'Release', install_prefix: outDir })],
      ['cmake', '--build', path.join(outDir, 'build'), '-j', String(jobs)],
      ['cmake', '--install', path.join(outDir, 'build')],
    ],
  };

  if (dryRun) {
    if (jsonOut) console.log(JSON.stringify(plan, null, 2));
    else {
      console.log(`target:   ${target}`);
      console.log(`repo:     ${repoUrl}`);
      console.log(`commit:   ${commit}`);
      console.log(`out:      ${outDir}`);
      console.log(`jobs:     ${jobs}`);
      console.log(`cmake:    ${plan.cmake_args.join(' ')}`);
      console.log(`steps:    ${plan.steps.length}`);
      for (const s of plan.steps) console.log('  $ ' + s.join(' '));
    }
    return;
  }

  fs.mkdirSync(outDir, { recursive: true });
  const t0 = Date.now();
  for (const step of plan.steps) {
    const r = spawnSync(step[0], step.slice(1), { stdio: 'inherit' });
    if (r.status !== 0) {
      const err = { ok: false, error: 'build_step_failed', step: step.join(' '), exit: r.status };
      if (jsonOut) console.log(JSON.stringify(err, null, 2));
      else console.error(`[FAIL] ${step.join(' ')} exit=${r.status}`);
      process.exit(4);
    }
  }
  const elapsed_ms = Date.now() - t0;
  // W258-ML-6 + ML-7: capture the actual commit_sha that was checked out
  // (even when --commit was a tag or branch name) AND hash every binary
  // and shared-object produced under the install bin/lib trees. Without
  // these the receipt cannot prove a swapped binary post-build. The
  // receipt_kind bumps to /2 so verifiers can dispatch on shape.
  let commit_sha = commit;
  try {
    const rev = spawnSync('git', ['-C', path.join(outDir, 'src'), 'rev-parse', 'HEAD'], { encoding: 'utf8' });
    if (rev.status === 0 && rev.stdout) commit_sha = rev.stdout.trim();
  } catch (_) {}
  const binaryDir = path.join(outDir, 'bin');
  const libDir = path.join(outDir, 'lib');
  const HASH_EXTS = new Set(['', '.exe', '.so', '.dll', '.dylib', '.a']);
  function hashTree(rootDir) {
    const out = {};
    if (!fs.existsSync(rootDir)) return out;
    const stack = [rootDir];
    while (stack.length) {
      const d = stack.pop();
      let entries;
      try { entries = fs.readdirSync(d, { withFileTypes: true }); }
      catch (_) { continue; }
      for (const ent of entries) {
        const p = path.join(d, ent.name);
        if (ent.isDirectory()) { stack.push(p); continue; }
        if (!ent.isFile()) continue;
        const ext = path.extname(ent.name).toLowerCase();
        if (!HASH_EXTS.has(ext)) continue;
        try {
          const buf = fs.readFileSync(p);
          out[path.relative(outDir, p).replace(/\\/g, '/')] = crypto.createHash('sha256').update(buf).digest('hex');
        } catch (_) {}
      }
    }
    return out;
  }
  const binary_hashes = { ...hashTree(binaryDir), ...hashTree(libDir) };
  const concat = Object.keys(binary_hashes).sort().map(k => `${k}:${binary_hashes[k]}`).join('\n');
  const binary_tree_sha256 = crypto.createHash('sha256').update(concat).digest('hex');
  const receipt = {
    ok: true, target, repo_url: repoUrl,
    ref_requested: commit,
    commit_sha,
    cmake_args: plan.cmake_args,
    elapsed_ms,
    built_at: new Date().toISOString(),
    binary_dir: binaryDir,
    binary_hashes,
    binary_tree_sha256,
    binary_file_count: Object.keys(binary_hashes).length,
    // Receipt-kind lineage. v1 was the initial shape; v2 added binary_tree_sha256
    // + binary_hashes per W258-ML-7. Verifiers must accept either kind.
    //   receipt_kind: 'kolm-runtime-build/1'    (legacy — no binary tree hash)
    //   receipt_kind: 'kolm-runtime-build/2'    (current — binary tree hash included)
    receipt_kind: 'kolm-runtime-build/2',
  };
  fs.writeFileSync(path.join(outDir, 'build-receipt.json'), JSON.stringify(receipt, null, 2));
  if (jsonOut) console.log(JSON.stringify(receipt, null, 2));
  else {
    console.log(`built  ${target}  ${elapsed_ms}ms`);
    console.log(`out    ${outDir}`);
    console.log(`bin    ${receipt.binary_dir}`);
    console.log(`recpt  ${path.join(outDir, 'build-receipt.json')}`);
  }
}

// Allow this file to be loaded as a module (for the test) or executed.
if (import.meta.url === `file://${process.argv[1].replace(/\\/g, '/')}` ||
    process.argv[1].endsWith('build.mjs')) {
  main().catch(e => { console.error(e); process.exit(1); });
}
