// Kolm - VS Code extension.
//
// Brings the kolm workflow into the editor: inspect, verify, and run .kolm
// artifacts, compile a new one from a spec, and (when an LLM call is
// detected) offer a CodeLens that swaps it for a signed kolm artifact.
//
// Zero dependencies - no bundler, no TypeScript build, just plain JS that
// the VS Code extension host loads directly. Talks to the kolm REST API
// (defaults to https://kolm.ai).

const vscode = require('vscode');
const fs = require('node:fs');
const https = require('node:https');
const http = require('node:http');
const path = require('node:path');
const { URL } = require('node:url');

const DEFAULT_BASE = 'https://kolm.ai';

// ---------------------------------------------------------------------------
// HTTP client (zero deps).
// ---------------------------------------------------------------------------
function request(method, urlString, { body, apiKey } = {}) {
  return new Promise((resolve, reject) => {
    const u = new URL(urlString);
    const headers = { 'Accept': 'application/json' };
    let data;
    if (body !== undefined) {
      data = JSON.stringify(body);
      headers['Content-Type'] = 'application/json';
      headers['Content-Length'] = Buffer.byteLength(data);
    }
    if (apiKey) headers['Authorization'] = `Bearer ${apiKey}`;
    const lib = u.protocol === 'http:' ? http : https;
    const req = lib.request(
      { method, hostname: u.hostname, port: u.port || (u.protocol === 'http:' ? 80 : 443), path: u.pathname + u.search, headers },
      (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => {
          const raw = Buffer.concat(chunks).toString('utf-8');
          let parsed; try { parsed = JSON.parse(raw); } catch { parsed = raw; }
          if (res.statusCode >= 200 && res.statusCode < 300) resolve(parsed);
          else reject(new Error((parsed && parsed.error) || `http ${res.statusCode}`));
        });
      }
    );
    req.on('error', reject);
    if (data) req.write(data);
    req.end();
  });
}

function cfg() {
  const c = vscode.workspace.getConfiguration('kolm');
  return {
    apiKey: c.get('apiKey') || process.env.KOLM_API_KEY || process.env.KOLMOGOROV_API_KEY,
    baseUrl: (c.get('baseUrl') || DEFAULT_BASE).replace(/\/$/, ''),
    suggest: c.get('suggestReplacements'),
    showRest: c.get('showRestEquivalent'),
  };
}

async function api(method, path_, body) {
  const { apiKey, baseUrl } = cfg();
  return request(method, baseUrl + path_, { apiKey, body });
}

// ---------------------------------------------------------------------------
// Output channel - shared across commands so users have one place to look.
// ---------------------------------------------------------------------------
let __chan = null;
function chan() {
  if (!__chan) __chan = vscode.window.createOutputChannel('Kolm');
  return __chan;
}

// CLI->REST translator. Mirrors the cmdTui + cmdRun + cmdVerify behavior so
// the editor doubles as an API tutorial. Goes to the output channel (which
// the user can ignore) instead of a notification.
function logRestEquivalent(verb, path_, body) {
  if (!cfg().showRest) return;
  const { baseUrl, apiKey } = cfg();
  const url = baseUrl + path_;
  const keyHint = apiKey ? apiKey.slice(0, 6) + '...' : 'ks_...';
  const c = chan();
  c.appendLine('');
  c.appendLine('> REST equivalent');
  c.appendLine(`  ${verb} ${url}`);
  c.appendLine(`  Authorization: Bearer ${keyHint}`);
  if (body) {
    c.appendLine('  Content-Type: application/json');
    const json = JSON.stringify(body, null, 2).split('\n').map((l) => '  ' + l).join('\n');
    c.appendLine(json);
  }
}

// ---------------------------------------------------------------------------
// .kolm artifact reader - best-effort manifest+receipt extraction by regex
// over the raw bytes. Same approach as cli/kolm.js cmdTui's loadArtifactSync;
// the canonical parser lives in src/artifact.js. For inspection only.
// ---------------------------------------------------------------------------
function readKolmArtifact(filePath) {
  const raw = fs.readFileSync(filePath);
  const head = raw.slice(0, 4).toString('hex');
  const size = raw.length;
  let manifest = null;
  let receipt = null;
  try {
    const text = raw.toString('utf8');
    const m = text.match(/\{\s*"version_id"\s*:[^}]+\}/);
    if (m) manifest = JSON.parse(m[0].replace(/[\x00-\x1f]+/g, ' '));
    const r = text.match(/\{[^{}]*"hmac"[^{}]*\}/);
    if (r) receipt = JSON.parse(r[0].replace(/[\x00-\x1f]+/g, ' '));
  } catch {}
  return { path: filePath, size, magic: head, manifest, receipt };
}

function fmtBytes(n) {
  if (n == null) return '?';
  if (n < 1024) return n + ' B';
  if (n < 1024 * 1024) return (n / 1024).toFixed(1) + ' KB';
  return (n / (1024 * 1024)).toFixed(1) + ' MB';
}

function fmtKScore(k) {
  if (k == null) return '?';
  if (typeof k === 'number') return k.toFixed(3);
  if (typeof k === 'object' && k.composite != null) return Number(k.composite).toFixed(3);
  return '?';
}

// Resolve the .kolm path for a command. Priority: explorer-context URI ->
// active editor URI -> file picker.
async function resolveKolmPath(uri) {
  if (uri && uri.fsPath && uri.fsPath.endsWith('.kolm')) return uri.fsPath;
  const ed = vscode.window.activeTextEditor;
  if (ed && ed.document.fileName.endsWith('.kolm')) return ed.document.fileName;
  const picked = await vscode.window.showOpenDialog({
    canSelectMany: false,
    filters: { 'Kolm artifact': ['kolm'] },
    openLabel: 'Pick a .kolm artifact',
  });
  return picked && picked[0] ? picked[0].fsPath : null;
}

// ---------------------------------------------------------------------------
// LLM-call detection - coarse but useful regex.
// ---------------------------------------------------------------------------
const LLM_PATTERNS = [
  /\b(?:openai|anthropic)\b[\.\w]*\.(?:create|messages|completions|chat)\s*\(/g,
  /\bawait\s+(?:fetch|axios|got)\s*\(\s*['"`](?:https?:\/\/)?(?:api\.openai\.com|api\.anthropic\.com)/g,
  /\bclient\.(?:chat\.completions\.create|messages\.create)\s*\(/g,
];

function findLLMCalls(doc) {
  const out = [];
  const text = doc.getText();
  for (const re of LLM_PATTERNS) {
    re.lastIndex = 0;
    let m;
    while ((m = re.exec(text))) {
      const start = doc.positionAt(m.index);
      const end = doc.positionAt(m.index + m[0].length);
      out.push(new vscode.Range(start, end));
    }
  }
  return out;
}

class KolmLensProvider {
  provideCodeLenses(doc) {
    if (!cfg().suggest) return [];
    return findLLMCalls(doc).map((range) => new vscode.CodeLens(range, {
      title: '> Replace with a signed kolm artifact (pay once, run free forever)',
      command: 'kolm.replaceLLMCall',
      arguments: [doc.uri, range],
    }));
  }
}

// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------
async function cmdInspect(uri) {
  const p = await resolveKolmPath(uri);
  if (!p) return;
  let info;
  try { info = readKolmArtifact(p); }
  catch (e) {
    vscode.window.showErrorMessage(`Kolm: could not read ${path.basename(p)}: ${e.message}`);
    return;
  }
  const m = info.manifest || {};
  const r = info.receipt || {};
  const c = chan();
  c.show(true);
  c.appendLine('');
  c.appendLine(`inspect: ${info.path}`);
  c.appendLine(`  size:        ${fmtBytes(info.size)}`);
  c.appendLine(`  magic:       0x${info.magic}  (${info.magic.startsWith('504b') ? 'zip-style .kolm' : 'unknown'})`);
  c.appendLine(`  version_id:  ${m.version_id || '(unknown)'}`);
  c.appendLine(`  base_model:  ${m.base_model || m.runtime || '(unknown)'}`);
  c.appendLine(`  k_score:     ${fmtKScore(m.k_score)}`);
  c.appendLine(`  signer:      ${m.signer || r.signer || '(unknown)'}`);
  c.appendLine(`  receipt:     ${r.hmac ? r.hmac.slice(0, 24) + '...' : '(none discovered in best-effort view)'}`);
  c.appendLine('');
  c.appendLine('hint: run `Kolm: Verify` to re-verify the receipt chain via the live API.');
}

async function cmdVerify(uri) {
  const p = await resolveKolmPath(uri);
  if (!p) return;
  const info = readKolmArtifact(p);
  if (!info.receipt) {
    vscode.window.showWarningMessage('Kolm: no receipt discovered in artifact view. Verify locally with `kolm verify <file>.kolm`.');
    return;
  }
  await vscode.window.withProgress(
    { location: vscode.ProgressLocation.Notification, title: `Verifying ${path.basename(p)}...` },
    async () => {
      try {
        const r = await api('POST', '/v1/receipts/verify', { receipt: info.receipt });
        const c = chan();
        c.show(true);
        c.appendLine('');
        c.appendLine(`verify: ${path.basename(p)}`);
        c.appendLine(`  valid:       ${r.valid === true ? 'yes' : 'no'}`);
        if (r.reason) c.appendLine(`  reason:      ${r.reason}`);
        if (r.manifest) c.appendLine(`  manifest:    ${r.manifest.version_id || ''} (cid=${r.manifest.cid || '?'})`);
        logRestEquivalent('POST', '/v1/receipts/verify', { receipt: info.receipt });
        if (r.valid) vscode.window.showInformationMessage(`Kolm: ${path.basename(p)} verified.`);
        else vscode.window.showWarningMessage(`Kolm: ${path.basename(p)} did not verify (${r.reason || 'unknown'}).`);
      } catch (e) {
        vscode.window.showErrorMessage(`Kolm verify failed: ${e.message}`);
      }
    }
  );
}

async function cmdRun(uri) {
  const p = await resolveKolmPath(uri);
  if (!p) return;
  const info = readKolmArtifact(p);
  const input = await vscode.window.showInputBox({ prompt: `Input for ${path.basename(p)}`, placeHolder: 'hello' });
  if (input == null) return;
  await vscode.window.withProgress(
    { location: vscode.ProgressLocation.Notification, title: `Running ${path.basename(p)}...` },
    async () => {
      try {
        const r = await api('POST', '/v1/run/inline', { artifact: path.basename(p), input });
        const c = chan();
        c.show(true);
        c.appendLine('');
        c.appendLine(`run: ${path.basename(p)}`);
        c.appendLine(`  input:       ${input}`);
        c.appendLine(`  output:      ${typeof r.output === 'string' ? r.output : JSON.stringify(r.output)}`);
        c.appendLine(`  latency:     ${r.latency_us != null ? r.latency_us + ' us' : '?'}`);
        c.appendLine(`  verified:    ${r.verified === true ? 'yes' : 'no'}`);
        if (info.manifest && info.manifest.k_score) c.appendLine(`  k_score:     ${fmtKScore(info.manifest.k_score)}`);
        logRestEquivalent('POST', '/v1/run/inline', { artifact: path.basename(p), input });
      } catch (e) {
        vscode.window.showErrorMessage(`Kolm run failed: ${e.message}`);
      }
    }
  );
}

async function cmdCompile() {
  const task = await vscode.window.showInputBox({
    prompt: 'Describe the task in plain English',
    placeHolder: 'classify support tickets as billing | technical | feedback',
  });
  if (!task) return;
  await vscode.window.withProgress(
    { location: vscode.ProgressLocation.Notification, title: `Compiling: ${task.slice(0, 60)}...` },
    async () => {
      try {
        const r = await api('POST', '/v1/compile', { task });
        const c = chan();
        c.show(true);
        c.appendLine('');
        c.appendLine(`compile: ${task}`);
        c.appendLine(`  job_id:      ${r.job_id || '(none)'}`);
        c.appendLine(`  status:      ${r.status || '(none)'}`);
        if (r.artifact_url) c.appendLine(`  artifact:    ${r.artifact_url}`);
        if (r.k_score) c.appendLine(`  k_score:     ${fmtKScore(r.k_score)}`);
        logRestEquivalent('POST', '/v1/compile', { task });
        vscode.window.showInformationMessage(`Kolm: compile job ${r.job_id || ''} started. Open the dashboard to track progress.`);
      } catch (e) {
        vscode.window.showErrorMessage(`Kolm compile failed: ${e.message}`);
      }
    }
  );
}

async function cmdSearch() {
  const q = await vscode.window.showInputBox({ prompt: 'Search the public registry', placeHolder: 'phi-redactor' });
  if (!q) return;
  try {
    const reg = await api('GET', '/v1/registry/export');
    const items = (reg.recipes || reg.artifacts || [])
      .filter((it) => {
        const blob = JSON.stringify(it).toLowerCase();
        return blob.includes(q.toLowerCase());
      })
      .slice(0, 25)
      .map((it) => ({
        label: it.name || it.slug || it.id,
        description: it.task || it.description || '',
        detail: `${it.base_model || ''}${it.k_score ? '  k=' + fmtKScore(it.k_score) : ''}`,
        slug: it.slug || it.name,
      }));
    if (!items.length) {
      vscode.window.showInformationMessage(`Kolm: no registry matches for "${q}".`);
      return;
    }
    const pick = await vscode.window.showQuickPick(items, { placeHolder: 'Pick to copy slug to clipboard' });
    if (pick) {
      vscode.env.clipboard.writeText(pick.slug);
      vscode.window.showInformationMessage(`Kolm: copied "${pick.slug}" to clipboard.`);
    }
    logRestEquivalent('GET', '/v1/registry/export', null);
  } catch (e) {
    vscode.window.showErrorMessage(`Kolm search failed: ${e.message}`);
  }
}

async function cmdReplaceLLMCall(uri, range) {
  const editor = vscode.window.activeTextEditor;
  if (!editor) return;
  const r = range || editor.selection;

  const ref = await vscode.window.showInputBox({
    prompt: 'Which kolm artifact should replace this LLM call?',
    placeHolder: 'phi-redactor  or  cpt_...  or  ./my-artifact.kolm',
  });
  if (!ref) return;

  const indent = editor.document.lineAt(r.start.line).text.match(/^\s*/)[0];
  void indent;
  const replacement = ref.endsWith('.kolm')
    ? `await kolm.run({ artifact: '${ref}', input })`
    : ref.startsWith('cpt_') || ref.startsWith('ver_')
      ? `await kolm.run({ recipe_id: '${ref}', input })`
      : `await kolm.${camelCase(ref)}(input)`;

  await editor.edit((eb) => eb.replace(r, replacement));
  vscode.window.showInformationMessage(`Kolm: swapped LLM call. Add \`import { kolm } from '@kolmogorov/kolm'\` at the top of the file.`);
}

function camelCase(name) {
  return name.replace(/-([a-z])/g, (_, c) => c.toUpperCase());
}

async function cmdOpenConsole() {
  const { baseUrl } = cfg();
  vscode.env.openExternal(vscode.Uri.parse(baseUrl + '/dashboard'));
}

// ---------------------------------------------------------------------------
// activate / deactivate
// ---------------------------------------------------------------------------
function activate(context) {
  context.subscriptions.push(
    vscode.languages.registerCodeLensProvider(
      [{ language: 'javascript' }, { language: 'typescript' }, { language: 'python' }, { language: 'javascriptreact' }, { language: 'typescriptreact' }],
      new KolmLensProvider()
    ),
    vscode.commands.registerCommand('kolm.inspect',        cmdInspect),
    vscode.commands.registerCommand('kolm.verify',         cmdVerify),
    vscode.commands.registerCommand('kolm.run',            cmdRun),
    vscode.commands.registerCommand('kolm.compile',        cmdCompile),
    vscode.commands.registerCommand('kolm.search',         cmdSearch),
    vscode.commands.registerCommand('kolm.replaceLLMCall', cmdReplaceLLMCall),
    vscode.commands.registerCommand('kolm.openConsole',    cmdOpenConsole),
  );
}

function deactivate() {
  if (__chan) __chan.dispose();
}

module.exports = { activate, deactivate };
