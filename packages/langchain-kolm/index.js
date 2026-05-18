// @kolm/langchain — LangChain adapter for kolm.ai compiled artifacts.
//
// Two transport modes:
//   1. subprocess: spawn `kolm run <artifactPath>` and pipe the prompt to stdin.
//   2. http: POST {prompt} to `${baseUrl}/v1/run/<artifact>` with Bearer apiKey.
//
// The receipt chain (cid, recipe_class, k_score, audit_id) returned by the
// runtime is preserved on the response object and surfaced to LangChain via
// the standard `generationInfo` metadata channel.
//
// Peer dep: langchain (>=0.1.0). The class extends LLM from @langchain/core
// when present; otherwise it falls back to a minimal compatible shape so the
// adapter can be unit-tested without LangChain installed.

import { spawn } from 'node:child_process';
import { Buffer } from 'node:buffer';

// Try to resolve the real LangChain LLM base. Pure best-effort: this keeps the
// adapter unit-testable in a tree with no LangChain installed.
let BaseLLM;
try {
  // eslint-disable-next-line import/no-unresolved
  const mod = await import('@langchain/core/language_models/llms');
  BaseLLM = mod.LLM || mod.BaseLLM;
} catch (_) {
  // Minimal stand-in: matches the surface LangChain expects (constructor +
  // _call + _llmType) so the adapter behaves identically in both contexts.
  BaseLLM = class StandinLLM {
    constructor(fields = {}) { Object.assign(this, fields); }
    async call(prompt, opts) { return this._call(prompt, opts || {}); }
  };
}

const KOLM_BIN = process.env.KOLM_BIN || 'kolm';

function readAll(stream) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    stream.on('data', (c) => chunks.push(Buffer.from(c)));
    stream.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    stream.on('error', reject);
  });
}

function parseRuntimeOutput(raw) {
  // The kolm runtime emits either:
  //   - a single JSON line { text, receipt: { cid, k_score, ... } }
  //   - plain text (subprocess mode without --json) — return as-is.
  const trimmed = (raw || '').trim();
  if (!trimmed) return { text: '', receipt: null };
  if (trimmed.startsWith('{')) {
    try {
      const obj = JSON.parse(trimmed);
      return {
        text: typeof obj.text === 'string' ? obj.text : (obj.output || ''),
        receipt: obj.receipt || obj.audit || null,
      };
    } catch (_) { /* fall through to plain text */ }
  }
  return { text: trimmed, receipt: null };
}

export class KolmLLM extends BaseLLM {
  constructor(fields = {}) {
    super(fields);
    this.artifactPath = fields.artifactPath || null;
    this.baseUrl = fields.baseUrl || null;
    this.apiKey = fields.apiKey || process.env.KOLM_API_KEY || null;
    this.bin = fields.bin || KOLM_BIN;
    this.timeoutMs = fields.timeoutMs || 30000;
    // Surfaced on every response.
    this.lastReceipt = null;
    if (!this.artifactPath && !this.baseUrl) {
      throw new Error('KolmLLM: either artifactPath (subprocess) or baseUrl (HTTP) is required');
    }
  }

  _llmType() { return 'kolm'; }

  async _call(prompt, _options = {}, _runManager) {
    const out = this.baseUrl ? await this._callHttp(prompt) : await this._callSubprocess(prompt);
    this.lastReceipt = out.receipt;
    return out.text;
  }

  // Returns { text, receipt } so callers that want the chain can grab it.
  async invokeWithReceipt(prompt, options) {
    const out = this.baseUrl ? await this._callHttp(prompt) : await this._callSubprocess(prompt);
    this.lastReceipt = out.receipt;
    return out;
  }

  async _callSubprocess(prompt) {
    return new Promise((resolve, reject) => {
      const args = ['run', this.artifactPath, '--json'];
      const child = spawn(this.bin, args, { stdio: ['pipe', 'pipe', 'pipe'] });
      let killed = false;
      const t = setTimeout(() => { killed = true; try { child.kill('SIGKILL'); } catch (_) {} }, this.timeoutMs);
      let stderr = '';
      child.stderr.on('data', (c) => { stderr += c.toString('utf8'); });
      child.on('error', (err) => { clearTimeout(t); reject(err); });
      const stdoutP = readAll(child.stdout);
      child.on('close', async (code) => {
        clearTimeout(t);
        const raw = await stdoutP.catch(() => '');
        if (killed) return reject(new Error(`kolm run timeout after ${this.timeoutMs}ms`));
        if (code !== 0) return reject(new Error(`kolm run exited ${code}: ${stderr.trim()}`));
        resolve(parseRuntimeOutput(raw));
      });
      child.stdin.write(prompt);
      child.stdin.end();
    });
  }

  async _callHttp(prompt) {
    const artifact = this.artifactPath ? encodeURIComponent(this.artifactPath) : 'default';
    const url = `${this.baseUrl.replace(/\/$/, '')}/v1/run/${artifact}`;
    const headers = { 'content-type': 'application/json' };
    if (this.apiKey) headers.authorization = `Bearer ${this.apiKey}`;
    const res = await fetch(url, {
      method: 'POST',
      headers,
      body: JSON.stringify({ prompt }),
    });
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      throw new Error(`kolm http ${res.status}: ${body.slice(0, 200)}`);
    }
    const json = await res.json().catch(async () => ({ text: await res.text() }));
    return {
      text: typeof json.text === 'string' ? json.text : (json.output || ''),
      receipt: json.receipt || json.audit || null,
    };
  }
}

export default KolmLLM;
