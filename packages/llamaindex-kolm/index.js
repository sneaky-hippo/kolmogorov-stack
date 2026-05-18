// @kolm/llamaindex — LlamaIndex adapter for kolm.ai compiled artifacts.
//
// Same transport bridge as @kolm/langchain (subprocess + HTTP). Exposes a
// LlamaIndex-shaped LLM with `complete(prompt)` and `chat(messages)` that
// returns the receipt chain in the response metadata.

import { spawn } from 'node:child_process';
import { Buffer } from 'node:buffer';

let BaseLLM;
try {
  // eslint-disable-next-line import/no-unresolved
  const mod = await import('llamaindex');
  BaseLLM = mod.BaseLLM || mod.LLM || class {};
} catch (_) {
  BaseLLM = class StandinLLM {};
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
  const trimmed = (raw || '').trim();
  if (!trimmed) return { text: '', receipt: null };
  if (trimmed.startsWith('{')) {
    try {
      const obj = JSON.parse(trimmed);
      return {
        text: typeof obj.text === 'string' ? obj.text : (obj.output || ''),
        receipt: obj.receipt || obj.audit || null,
      };
    } catch (_) { /* fall through */ }
  }
  return { text: trimmed, receipt: null };
}

export class KolmLLM extends BaseLLM {
  constructor(fields = {}) {
    super();
    this.artifactPath = fields.artifactPath || null;
    this.baseUrl = fields.baseUrl || null;
    this.apiKey = fields.apiKey || process.env.KOLM_API_KEY || null;
    this.bin = fields.bin || KOLM_BIN;
    this.timeoutMs = fields.timeoutMs || 30000;
    this.lastReceipt = null;
    if (!this.artifactPath && !this.baseUrl) {
      throw new Error('KolmLLM: either artifactPath (subprocess) or baseUrl (HTTP) is required');
    }
    // LlamaIndex inspects these to pick context-window and tokenizer defaults.
    this.metadata = {
      model: 'kolm-artifact',
      temperature: fields.temperature ?? 0,
      topP: fields.topP ?? 1,
      contextWindow: fields.contextWindow ?? 4096,
      tokenizer: undefined,
    };
  }

  // LlamaIndex BaseLLM contract — completion endpoint.
  async complete(params) {
    const prompt = typeof params === 'string' ? params : (params?.prompt ?? '');
    const { text, receipt } = await this._run(prompt);
    this.lastReceipt = receipt;
    return {
      text,
      raw: receipt ? { receipt } : null,
    };
  }

  // LlamaIndex chat: collapse messages to a single prompt, run, return assistant message.
  async chat(params) {
    const messages = Array.isArray(params) ? params : (params?.messages ?? []);
    const prompt = messages
      .map((m) => `${(m.role || 'user').toUpperCase()}: ${m.content}`)
      .join('\n\n');
    const { text, receipt } = await this._run(prompt);
    this.lastReceipt = receipt;
    return {
      message: { role: 'assistant', content: text },
      raw: receipt ? { receipt } : null,
    };
  }

  async invokeWithReceipt(prompt) {
    const out = await this._run(prompt);
    this.lastReceipt = out.receipt;
    return out;
  }

  async _run(prompt) {
    return this.baseUrl ? this._callHttp(prompt) : this._callSubprocess(prompt);
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
