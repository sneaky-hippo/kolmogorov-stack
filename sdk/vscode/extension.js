// Recipe — VS Code extension.
// Detects calls like:
//   await openai.chat.completions.create({ ... messages: [{ role: 'user', content: prompt }] })
//   await anthropic.messages.create({ model: 'claude-...', messages: [...] })
//   const r = await fetch('https://api.openai.com/v1/...')
// and offers a CodeLens "↳ Replace with Recipe — saves $X/mo, 17,000× faster".
//
// Heavy lifting (synthesis + run) goes through the Recipe HTTP API. This file
// is intentionally dependency-free — no bundler, no TypeScript build step,
// just plain JS that the VS Code extension host can load directly.

const vscode = require('vscode');
const https = require('node:https');
const http = require('node:http');
const { URL } = require('node:url');

const DEFAULT_BASE = 'https://kolmogorov-stack-production.up.railway.app';

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
  const c = vscode.workspace.getConfiguration('recipe');
  return {
    apiKey: c.get('apiKey') || process.env.RECIPE_API_KEY || process.env.KOLMOGOROV_API_KEY,
    baseUrl: (c.get('baseUrl') || DEFAULT_BASE).replace(/\/$/, ''),
    suggest: c.get('suggestReplacements'),
  };
}

async function api(method, path, body) {
  const { apiKey, baseUrl } = cfg();
  return request(method, baseUrl + path, { apiKey, body });
}

// ---------------------------------------------------------------------------
// LLM-call detection — coarse but useful regex.
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

// ---------------------------------------------------------------------------
// CodeLens provider — surfaces "Replace with Recipe" inline.
// ---------------------------------------------------------------------------
class RecipeLensProvider {
  provideCodeLenses(doc) {
    if (!cfg().suggest) return [];
    return findLLMCalls(doc).map((range) => new vscode.CodeLens(range, {
      title: '↳ Replace with Recipe — pay once, run free forever',
      command: 'recipe.replaceLLMCall',
      arguments: [doc.uri, range],
    }));
  }
}

// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------
async function cmdSynthesizeFromSelection() {
  const editor = vscode.window.activeTextEditor;
  if (!editor) return;
  const sel = editor.document.getText(editor.selection);
  if (!sel.trim()) {
    vscode.window.showWarningMessage('Recipe: select 4-8 example pairs first (JSON or `input → expected` lines).');
    return;
  }

  let positives;
  try {
    const parsed = JSON.parse(sel);
    positives = Array.isArray(parsed) ? parsed : parsed.positives;
  } catch {
    positives = sel.split(/\r?\n/).map((line) => {
      const m = line.match(/^(.+?)\s*(?:→|=>|->|\|\s*)\s*(.+)$/);
      return m ? { input: m[1].trim(), expected: parseValue(m[2].trim()) } : null;
    }).filter(Boolean);
  }
  if (!positives || positives.length < 4) {
    vscode.window.showErrorMessage('Recipe: need at least 4 examples (JSON array or "input → expected" lines).');
    return;
  }

  const name = await vscode.window.showInputBox({ prompt: 'Recipe name (kebab-case)', placeHolder: 'is-spam' });
  if (!name) return;

  await vscode.window.withProgress(
    { location: vscode.ProgressLocation.Notification, title: `Synthesizing recipe "${name}"…` },
    async () => {
      try {
        const r = await api('POST', '/v1/synthesize', { name, positives });
        if (!r.accepted) {
          vscode.window.showWarningMessage(`Recipe "${name}" did not synthesize: ${r.reason || 'examples too inconsistent'}`);
          return;
        }
        vscode.window.showInformationMessage(`Recipe "${name}" synthesized — ${r.concept_id}. Use \`recipe.run({ recipe_id, input })\`.`);
      } catch (e) {
        vscode.window.showErrorMessage(`Recipe synthesis failed: ${e.message}`);
      }
    }
  );
}

function parseValue(s) {
  if (s === 'true') return true;
  if (s === 'false') return false;
  if (s === 'null') return null;
  if (/^-?\d+(\.\d+)?$/.test(s)) return Number(s);
  return s.replace(/^['"`]|['"`]$/g, '');
}

async function cmdRunRecipe() {
  const ref = await vscode.window.showInputBox({ prompt: 'Recipe id or name', placeHolder: 'is-spam or cpt_…' });
  if (!ref) return;
  const input = await vscode.window.showInputBox({ prompt: 'Input to classify' });
  if (input == null) return;
  try {
    const path = ref.startsWith('cpt_') || ref.startsWith('ver_')
      ? '/v1/run'
      : '/v1/public/run';
    const body = path === '/v1/public/run'
      ? { name: ref, input }
      : { [ref.startsWith('ver_') ? 'version_id' : 'concept_id']: ref, input };
    const r = await api('POST', path, body);
    vscode.window.showInformationMessage(`Recipe output: ${JSON.stringify(r.output)} (${r.latency_us ?? '–'} µs${r.cache ? ', cache hit' : ''})`);
  } catch (e) {
    vscode.window.showErrorMessage(`Recipe run failed: ${e.message}`);
  }
}

async function cmdSearch() {
  const q = await vscode.window.showInputBox({ prompt: 'Search query', placeHolder: 'detect spam in support tickets' });
  if (!q) return;
  try {
    const r = await api('POST', '/v1/search', { query: q, k: 5 });
    const items = (r.matches || []).map((m) => ({ label: m.name, description: m.description, detail: `${m.concept_id} • score=${m.score?.toFixed(3) ?? '?'}` }));
    if (!items.length) {
      vscode.window.showInformationMessage('No matching recipes — try synthesizing one.');
      return;
    }
    const pick = await vscode.window.showQuickPick(items, { placeHolder: 'Pick a recipe to copy its id' });
    if (pick) {
      vscode.env.clipboard.writeText(pick.detail.split(' • ')[0]);
      vscode.window.showInformationMessage(`Copied ${pick.label} id to clipboard.`);
    }
  } catch (e) {
    vscode.window.showErrorMessage(`Recipe search failed: ${e.message}`);
  }
}

async function cmdReplaceLLMCall(uri, range) {
  const editor = vscode.window.activeTextEditor;
  if (!editor) return;
  const r = range || editor.selection;

  const ref = await vscode.window.showInputBox({
    prompt: 'Recipe to swap in (id or name)',
    placeHolder: 'is-spam or cpt_…',
  });
  if (!ref) return;

  const indent = editor.document.lineAt(r.start.line).text.match(/^\s*/)[0];
  const replacement = ref.startsWith('cpt_') || ref.startsWith('ver_')
    ? `await recipeClient.run({ recipe_id: '${ref}', input })`
    : `await recipe.${camelCase(ref)}(input)`;

  await editor.edit((eb) => eb.replace(r, replacement));
  vscode.window.showInformationMessage(`Swapped LLM call → ${ref}. Don't forget: \`import { recipe } from '@kolmogorov/recipe'\``);
}

function camelCase(name) {
  return name.replace(/-([a-z])/g, (_, c) => c.toUpperCase());
}

async function cmdOpenConsole() {
  const { baseUrl } = cfg();
  vscode.env.openExternal(vscode.Uri.parse(baseUrl));
}

// ---------------------------------------------------------------------------
// activate / deactivate
// ---------------------------------------------------------------------------
function activate(context) {
  context.subscriptions.push(
    vscode.languages.registerCodeLensProvider(
      [{ language: 'javascript' }, { language: 'typescript' }, { language: 'python' }, { language: 'javascriptreact' }, { language: 'typescriptreact' }],
      new RecipeLensProvider()
    ),
    vscode.commands.registerCommand('recipe.synthesizeFromSelection', cmdSynthesizeFromSelection),
    vscode.commands.registerCommand('recipe.runRecipe', cmdRunRecipe),
    vscode.commands.registerCommand('recipe.search', cmdSearch),
    vscode.commands.registerCommand('recipe.replaceLLMCall', cmdReplaceLLMCall),
    vscode.commands.registerCommand('recipe.openConsole', cmdOpenConsole),
  );
}

function deactivate() {}

module.exports = { activate, deactivate };
