// W367 — recipe.bundle.mjs runner. Extracts the bundle from a .kolm zip to a
// per-run temp dir and imports it via pathToFileURL. The default export is the
// dispatcher synthesized by src/artifact.js#buildRecipeBundleMjs.
//
// This is the "portable runtime" path that proves the homepage hero claim
// "same file runs on a laptop, a phone, or an air-gapped server": no kolm
// runtime is in scope when the bundle executes, only node:fs and the bundle
// itself. Any host with Node 18+, Bun 1+, or Deno 1.40+ can `import` the
// extracted recipe.bundle.mjs file directly.
//
// Hardening: the bundle is staged in os.tmpdir() under a unique kolm-bundle-*
// directory and removed (best-effort) after the import resolves. The import
// uses pathToFileURL so Windows backslash paths don't break ESM resolution.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { pathToFileURL } from 'node:url';
import AdmZip from 'adm-zip';

function kolmError(code, message) {
  const e = new Error(message);
  e.code = code;
  return e;
}

// runArtifactViaBundle(artifactPath, input, opts) -> { output, recipe_id, recipe_name, latency_us }
//
// Steps:
//   1. Read the .kolm zip and parse manifest.json + manifest.entry block.
//   2. Verify the entry.sha256 matches the entry file bytes in the zip.
//   3. Extract the entry file to a fresh temp dir.
//   4. Dynamic-import via pathToFileURL.
//   5. Invoke default(input, { params, pack, index }) and return.
//   6. Clean up the temp dir.
export async function runArtifactViaBundle(artifactPath, input, opts = {}) {
  const buf = fs.readFileSync(artifactPath);
  const zip = new AdmZip(buf);
  const manifestEntry = zip.getEntry('manifest.json');
  if (!manifestEntry) {
    throw kolmError('KOLM_E_BUNDLE_MALFORMED', 'manifest.json missing from .kolm zip');
  }
  let manifest;
  try {
    manifest = JSON.parse(manifestEntry.getData().toString('utf8'));
  } catch (e) {
    throw kolmError('KOLM_E_BUNDLE_MALFORMED', `manifest.json parse failed: ${e.message}`);
  }
  if (!manifest.entry || typeof manifest.entry !== 'object') {
    throw kolmError('KOLM_E_NO_EXECUTABLE_BUNDLE', 'manifest.entry missing — this artifact ships metadata only and cannot run via --bundle. Rebuild with a current kolm to include recipe.bundle.mjs.');
  }
  const entryFile = manifest.entry.file;
  const declaredSha = manifest.entry.sha256;
  if (typeof entryFile !== 'string' || !entryFile) {
    throw kolmError('KOLM_E_NO_EXECUTABLE_BUNDLE', 'manifest.entry.file missing');
  }
  const entryZipNode = zip.getEntry(entryFile);
  if (!entryZipNode) {
    throw kolmError('KOLM_E_NO_EXECUTABLE_BUNDLE', `entry file ${entryFile} not present in .kolm zip`);
  }
  const entryBytes = entryZipNode.getData();
  const actualSha = crypto.createHash('sha256').update(entryBytes).digest('hex');
  if (typeof declaredSha === 'string' && declaredSha && actualSha !== declaredSha) {
    throw kolmError('KOLM_E_BUNDLE_SHA_MISMATCH', `entry sha256 mismatch (declared ${declaredSha.slice(0, 16)}…, actual ${actualSha.slice(0, 16)}…)`);
  }
  // Stage to a fresh temp dir so concurrent runs don't collide and so a host
  // that restricts file:// imports to specific roots still works.
  const stage = fs.mkdtempSync(path.join(os.tmpdir(), 'kolm-bundle-'));
  const stagedPath = path.join(stage, path.basename(entryFile));
  fs.writeFileSync(stagedPath, entryBytes);
  let mod;
  try {
    const url = pathToFileURL(stagedPath).href;
    mod = await import(url);
  } catch (e) {
    try { fs.rmSync(stage, { recursive: true, force: true }); } catch {}
    throw kolmError('KOLM_E_BUNDLE_IMPORT_FAILED', `import recipe.bundle.mjs failed: ${e.message}`);
  }
  const fn = mod && (mod.default || mod.run);
  if (typeof fn !== 'function') {
    try { fs.rmSync(stage, { recursive: true, force: true }); } catch {}
    throw kolmError('KOLM_E_BUNDLE_EXPORT_MISSING', 'recipe.bundle.mjs must default-export a function');
  }
  try {
    const t0 = process.hrtime.bigint();
    const result = await fn(input, {
      params: opts.params || null,
      pack: opts.pack || null,
      index: opts.index || null,
    });
    const us = Number(process.hrtime.bigint() - t0) / 1000;
    // Dispatcher returns { output, recipe_id, recipe_name, latency_us }
    // already; we just normalize the latency to the outer measurement so
    // callers see end-to-end-including-import time on the first call.
    return {
      output: result?.output ?? result,
      recipe_id: result?.recipe_id || null,
      recipe_name: result?.recipe_name || null,
      latency_us: typeof result?.latency_us === 'number' ? result.latency_us : Math.round(us),
    };
  } finally {
    // Best-effort cleanup. A leaked temp dir is annoying but not fatal; the
    // OS reaper handles os.tmpdir() entries eventually.
    try { fs.rmSync(stage, { recursive: true, force: true }); } catch {}
  }
}

// loadBundleModule(artifactPath) -> ESM module namespace. Same staging logic
// as runArtifactViaBundle but returns the imported module so tests (and the
// /v1/run/bundle endpoint, if/when added) can poke at RECIPES directly.
export async function loadBundleModule(artifactPath) {
  const buf = fs.readFileSync(artifactPath);
  const zip = new AdmZip(buf);
  const manifestEntry = zip.getEntry('manifest.json');
  if (!manifestEntry) throw kolmError('KOLM_E_BUNDLE_MALFORMED', 'manifest.json missing');
  const manifest = JSON.parse(manifestEntry.getData().toString('utf8'));
  if (!manifest.entry || !manifest.entry.file) {
    throw kolmError('KOLM_E_NO_EXECUTABLE_BUNDLE', 'manifest.entry.file missing');
  }
  const entryZipNode = zip.getEntry(manifest.entry.file);
  if (!entryZipNode) throw kolmError('KOLM_E_NO_EXECUTABLE_BUNDLE', `entry file ${manifest.entry.file} missing from zip`);
  const stage = fs.mkdtempSync(path.join(os.tmpdir(), 'kolm-bundle-load-'));
  const stagedPath = path.join(stage, path.basename(manifest.entry.file));
  fs.writeFileSync(stagedPath, entryZipNode.getData());
  const url = pathToFileURL(stagedPath).href;
  const mod = await import(url);
  // Caller is responsible for cleanup since they hold the module reference.
  // We return the stage path so they can call cleanupBundleStage(stage).
  return { mod, stage };
}

export function cleanupBundleStage(stage) {
  try { fs.rmSync(stage, { recursive: true, force: true }); } catch {}
}
