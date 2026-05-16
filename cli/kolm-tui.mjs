// kolm tui — a full-screen, drag-drop friendly TUI.
//
// Drag-and-drop: when a user drops a file onto a terminal, the OS pastes
// the file *path* into the input buffer. The TUI watches every line for
// a *.kolm path (quoted or not, with or without surrounding whitespace),
// auto-strips quotes, validates it exists, and ingests it with a frame
// animation. No drivers, no deps.
//
// :serve — spins up a tiny http server bound to 127.0.0.1 that exposes
// the loaded artifact as POST /v1/run, so users can hit it from curl,
// Postman, Claude, etc. as easily as they hit kolm.ai.
//
// Brand colors match the neo-lab theme used on the web:
//   good   = #7ef0d2   accent green (success / verbs)
//   accent = #b3a8ff   electric lavender (k-score / ring 4)
//   bad    = #ff7e8a   alert red (errors only)
//   mute   = #6a7a85   ink-mute (chrome)

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import readline from 'node:readline';
import { spawn } from 'node:child_process';

// ---------- ANSI ---------------------------------------------------------
const ESC = '[';
const RESET = ESC + '0m';
const BOLD = ESC + '1m';
const DIM = ESC + '2m';
const FAINT = ESC + '2;37m';
const HIDE_CURSOR = ESC + '?25l';
const SHOW_CURSOR = ESC + '?25h';
const CLEAR_LINE = ESC + '2K\r';
const ALT_BUFFER_IN = ESC + '?1049h';
const ALT_BUFFER_OUT = ESC + '?1049l';

// truecolor 24-bit. fall back to 256-color in the rare TERM where this fails.
function rgb(r, g, b) { return ESC + '38;2;' + r + ';' + g + ';' + b + 'm'; }
function bgRgb(r, g, b) { return ESC + '48;2;' + r + ';' + g + ';' + b + 'm'; }
const C = {
  good:   rgb(126, 240, 210),
  accent: rgb(179, 168, 255),
  bad:    rgb(255, 126, 138),
  mute:   rgb(106, 122, 133),
  ink:    rgb(220, 230, 235),
  ring:   rgb(70,  220, 180),
};

function w(s) { process.stdout.write(s); }
function wln(s) { process.stdout.write((s || '') + '\n'); }
function clear() { w(ESC + '2J' + ESC + 'H'); }
function moveTo(row, col) { w(ESC + row + ';' + col + 'H'); }

// ---------- logo ---------------------------------------------------------
// Plain block-letter logo built for the neo-lab brand. Short enough to fit
// in 80×24 terminals while staying readable when the splash plays.
const LOGO = [
  '   __ __   ___    __    __  ___',
  '  / //_/  / _ \\  / /   /  |/  /',
  ' /   <_  / // / / /__ / /|_/ / ',
  '/_/|_(_)\\___/ /____//_/  /_/  ',
];

// ---------- splash animation --------------------------------------------
function sleep(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }

async function splash() {
  clear();
  w(HIDE_CURSOR);
  // Slow fade-in line by line.
  for (let i = 0; i < LOGO.length; i++) {
    wln('  ' + C.good + LOGO[i] + RESET);
    await sleep(70);
  }
  wln('');
  // Tagline typewriter.
  const tag = '   your AI · yours forever · audited every call';
  w('  ' + C.mute);
  for (let i = 0; i < tag.length; i++) {
    w(tag[i]);
    if (i % 3 === 0) await sleep(8);
  }
  wln(RESET);
  await sleep(120);
  // Spinner row
  const spinner = ['◜', '◝', '◞', '◟'];
  const steps = [
    'loading runtime',
    'verifying signing key',
    'opening artifact registry',
    'ready',
  ];
  for (let s = 0; s < steps.length; s++) {
    for (let k = 0; k < 6; k++) {
      w(CLEAR_LINE + '  ' + C.accent + spinner[k % spinner.length] + '  ' + C.mute + steps[s] + '…' + RESET);
      await sleep(40);
    }
  }
  w(CLEAR_LINE + '  ' + C.good + '●  ' + C.ink + 'ready' + RESET + '\n\n');
  w(SHOW_CURSOR);
}

// ---------- frame helpers -----------------------------------------------
function hr() {
  const cols = Math.min(process.stdout.columns || 80, 100);
  return C.mute + '─'.repeat(cols - 2) + RESET;
}

function box(title, lines) {
  const cols = Math.min(process.stdout.columns || 80, 100);
  const inner = cols - 4;
  const out = [];
  out.push(C.mute + '┌─ ' + C.ink + BOLD + title + RESET + ' ' + C.mute + '─'.repeat(Math.max(0, inner - title.length - 2)) + '┐' + RESET);
  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i];
    const visible = stripAnsi(raw);
    const pad = ' '.repeat(Math.max(0, inner - visible.length));
    out.push(C.mute + '│ ' + RESET + raw + pad + C.mute + ' │' + RESET);
  }
  out.push(C.mute + '└' + '─'.repeat(inner + 2) + '┘' + RESET);
  return out.join('\n');
}

function stripAnsi(s) {
  return String(s).replace(/\[[0-9;]*m/g, '');
}

function fmtBytes(n) {
  if (!Number.isFinite(n)) return '—';
  if (n < 1024) return n + ' B';
  if (n < 1024 * 1024) return (n / 1024).toFixed(1) + ' KB';
  return (n / 1024 / 1024).toFixed(2) + ' MB';
}

// ---------- .kolm parser (zip → manifest.json) --------------------------
//
// Tiny pure-Node zip reader. We only need to extract a few JSON files at
// known names; we do not need full DEFLATE for every entry. Most .kolm
// metadata files are STORED (no compression) or short enough that decoding
// via zlib.inflateRawSync is cheap.
import zlib from 'node:zlib';

function readZipEntries(buf) {
  // End of central directory record (EOCD) is in the last 22..(22+0xFFFF) bytes.
  const len = buf.length;
  let eocdOff = -1;
  for (let i = len - 22; i >= Math.max(0, len - 65557); i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) { eocdOff = i; break; }
  }
  if (eocdOff < 0) throw new Error('not a zip (no EOCD)');
  const cdSize = buf.readUInt32LE(eocdOff + 12);
  const cdOff = buf.readUInt32LE(eocdOff + 16);
  const entries = [];
  let p = cdOff;
  const end = cdOff + cdSize;
  while (p < end) {
    if (buf.readUInt32LE(p) !== 0x02014b50) break;
    const method = buf.readUInt16LE(p + 10);
    const compSize = buf.readUInt32LE(p + 20);
    const uncompSize = buf.readUInt32LE(p + 24);
    const nameLen = buf.readUInt16LE(p + 28);
    const extraLen = buf.readUInt16LE(p + 30);
    const commentLen = buf.readUInt16LE(p + 32);
    const localOff = buf.readUInt32LE(p + 42);
    const name = buf.slice(p + 46, p + 46 + nameLen).toString('utf8');
    entries.push({ name, method, compSize, uncompSize, localOff });
    p += 46 + nameLen + extraLen + commentLen;
  }
  return entries;
}

function readZipEntry(buf, entry) {
  // Local file header at entry.localOff
  if (buf.readUInt32LE(entry.localOff) !== 0x04034b50) return null;
  const nameLen = buf.readUInt16LE(entry.localOff + 26);
  const extraLen = buf.readUInt16LE(entry.localOff + 28);
  const dataOff = entry.localOff + 30 + nameLen + extraLen;
  const data = buf.slice(dataOff, dataOff + entry.compSize);
  if (entry.method === 0) return data; // stored
  if (entry.method === 8) return zlib.inflateRawSync(data);
  throw new Error('unsupported zip method ' + entry.method);
}

function readJSONFromZip(buf, entries, name) {
  const e = entries.find(function (x) { return x.name === name; });
  if (!e) return null;
  try {
    const raw = readZipEntry(buf, e);
    if (!raw) return null;
    return JSON.parse(raw.toString('utf8'));
  } catch (err) {
    return null;
  }
}

async function parseKolm(filePath) {
  const buf = fs.readFileSync(filePath);
  const entries = readZipEntries(buf);
  const manifest = readJSONFromZip(buf, entries, 'manifest.json');
  if (!manifest) throw new Error('no manifest.json — is this a .kolm artifact?');
  const recipes = readJSONFromZip(buf, entries, 'recipes.json');
  const receipt = readJSONFromZip(buf, entries, 'receipt.json');
  const evals   = readJSONFromZip(buf, entries, 'evals.json');
  return {
    filePath: filePath,
    fileName: path.basename(filePath),
    sizeBytes: buf.length,
    manifest: manifest,
    recipes: recipes,
    receipt: receipt,
    evals: evals,
    entryCount: entries.length,
  };
}

// ---------- artifact ingest animation -----------------------------------
async function ingestAnimation(filePath) {
  const frames = [
    '◴ reading bytes',
    '◷ decompressing',
    '◶ verifying manifest',
    '◵ ringing receipt chain',
    '● ready',
  ];
  for (let i = 0; i < frames.length; i++) {
    const isLast = i === frames.length - 1;
    const color = isLast ? C.good : C.accent;
    w(CLEAR_LINE + '  ' + color + frames[i] + RESET + '   ' + C.mute + path.basename(filePath) + RESET);
    await sleep(160);
  }
  w('\n');
}

// ---------- card render --------------------------------------------------
function fmtKScore(v) {
  if (v == null) return '—';
  const n = (typeof v === 'object' && v.composite != null) ? v.composite : v;
  if (typeof n !== 'number') return '—';
  return n.toFixed(3);
}

function renderCard(art) {
  const m = art.manifest || {};
  const kScore = fmtKScore(m.k_score);
  const gate = (m.k_score && m.k_score.gate) ? m.k_score.gate : (m.gate || '—');
  const lines = [
    C.mute + 'task     ' + RESET + (m.task || art.fileName),
    C.mute + 'model    ' + RESET + (m.base_model || m.runtime || '—'),
    C.mute + 'k-score  ' + RESET + C.accent + kScore + RESET + '   ' + C.mute + 'gate=' + gate + RESET,
    C.mute + 'cid      ' + RESET + (m.cid ? (String(m.cid).slice(0, 28) + '…') : '—'),
    C.mute + 'size     ' + RESET + fmtBytes(art.sizeBytes) + '   ' + C.mute + 'entries=' + art.entryCount + RESET,
    '',
    C.mute + 'commands ' + RESET + C.good + ':run' + RESET + '  ' + C.good + ':serve' + RESET + '  ' + C.good + ':receipt' + RESET + '  ' + C.good + ':eval' + RESET + '  ' + C.good + ':drop' + RESET + '  ' + C.good + ':help' + RESET,
  ];
  wln('');
  wln(box(' artifact ', lines));
  wln('');
}

// ---------- :run REPL (mock inference) ----------------------------------
//
// In wave 122 the TUI ships with a *local-only* deterministic mock that
// replays manifest.examples or computes a templated response from the
// loaded recipe. Wave 123 will wire it to /v1/wrap/verified when a
// network is available; for now the TUI never silently calls the cloud
// (per the offline-first stance).
function mockInfer(art, prompt) {
  const m = art.manifest || {};
  const examples = (m.examples || (art.recipes && art.recipes.examples) || []).slice(0, 200);
  // Lazy nearest-input lookup: substring scoring.
  const p = String(prompt).toLowerCase();
  let best = null, bestScore = 0;
  for (const ex of examples) {
    if (!ex || !ex.input) continue;
    const i = String(ex.input).toLowerCase();
    let score = 0;
    for (const word of p.split(/\s+/)) {
      if (word.length > 2 && i.includes(word)) score += word.length;
    }
    if (score > bestScore) { bestScore = score; best = ex; }
  }
  if (best && best.output) {
    return { text: String(best.output), source: 'examples', match_score: bestScore };
  }
  // No matched example: produce a templated stub.
  return {
    text: '(local mock) — no matching example in this artifact. Plug in the cloud with `kolm tui --cloud` to use /v1/wrap/verified.',
    source: 'stub',
    match_score: 0,
  };
}

async function runPrompt(art, prompt) {
  const t0 = Date.now();
  const r = mockInfer(art, prompt);
  const ms = Date.now() - t0;
  wln('');
  wln('  ' + C.good + '› ' + RESET + r.text);
  wln('  ' + C.mute + r.source + ' · ' + ms + 'ms' + (r.match_score ? ' · score=' + r.match_score : '') + RESET);
  wln('');
}

// ---------- :serve mode (one-click REST) --------------------------------
function startServe(art, port) {
  return new Promise(function (resolve, reject) {
    const server = http.createServer(function (req, res) {
      const setJson = function (code, obj) {
        res.statusCode = code;
        res.setHeader('Content-Type', 'application/json');
        res.setHeader('Access-Control-Allow-Origin', '*');
        res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
        res.end(JSON.stringify(obj));
      };
      if (req.method === 'OPTIONS') { setJson(204, {}); return; }
      if (req.url === '/' && req.method === 'GET') {
        setJson(200, {
          ok: true,
          artifact: art.fileName,
          manifest_cid: (art.manifest || {}).cid || null,
          endpoints: { run: 'POST /v1/run { input | messages }' },
        });
        return;
      }
      if (req.url === '/v1/run' && req.method === 'POST') {
        const chunks = [];
        req.on('data', function (c) { chunks.push(c); });
        req.on('end', function () {
          let body = {};
          try { body = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}'); }
          catch (e) { setJson(400, { error: 'invalid json' }); return; }
          const prompt = body.input
            || (Array.isArray(body.messages) && body.messages[body.messages.length - 1] && body.messages[body.messages.length - 1].content)
            || '';
          if (!prompt) { setJson(400, { error: 'input or messages required' }); return; }
          const r = mockInfer(art, prompt);
          setJson(200, {
            output: r.text,
            model: (art.manifest || {}).base_model || 'local-mock',
            _kolm: { artifact: art.fileName, cid: (art.manifest || {}).cid || null, source: r.source },
          });
        });
        return;
      }
      setJson(404, { error: 'not found' });
    });
    server.on('error', reject);
    server.listen(port, '127.0.0.1', function () {
      resolve(server);
    });
  });
}

// ---------- input parsing -----------------------------------------------
//
// Drag-drop pastes the file path into the prompt. On macOS/Linux the path
// is bare (with spaces escaped via backslash); on Windows it's typically
// wrapped in double quotes. Strip both, expand ~, and check existence.
function looksLikeKolmPath(s) {
  if (!s) return null;
  let v = s.trim();
  // Some terminals wrap drag-drop paths in single quotes on Linux.
  if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) {
    v = v.slice(1, -1);
  }
  // Unix-style escaped spaces.
  v = v.replace(/\\ /g, ' ');
  if (v.startsWith('~')) v = path.join(os.homedir(), v.slice(1));
  if (!/\.kolm$/i.test(v)) return null;
  try { if (fs.statSync(v).isFile()) return v; } catch (e) { return null; }
  return null;
}

// ---------- help screen --------------------------------------------------
function helpScreen() {
  wln('');
  wln('  ' + BOLD + C.ink + 'kolm tui · commands' + RESET);
  wln('');
  wln('  ' + C.good + ':run <text>' + RESET + '         ' + C.mute + 'run the loaded artifact on text (or just type at the prompt)' + RESET);
  wln('  ' + C.good + ':serve [port]' + RESET + '       ' + C.mute + 'expose POST /v1/run on localhost (default port 7777)' + RESET);
  wln('  ' + C.good + ':stop' + RESET + '               ' + C.mute + 'stop the local serve' + RESET);
  wln('  ' + C.good + ':recipe' + RESET + '             ' + C.mute + 'show the recipe block' + RESET);
  wln('  ' + C.good + ':receipt' + RESET + '            ' + C.mute + 'show the 4-ring receipt' + RESET);
  wln('  ' + C.good + ':eval' + RESET + '               ' + C.mute + 'show the evals.json (held-out grading set)' + RESET);
  wln('  ' + C.good + ':drop' + RESET + '               ' + C.mute + 'unload the current artifact' + RESET);
  wln('  ' + C.good + ':clear' + RESET + '              ' + C.mute + 'clear the screen' + RESET);
  wln('  ' + C.good + ':help' + RESET + '               ' + C.mute + 'this screen' + RESET);
  wln('  ' + C.good + ':exit' + RESET + '   ' + C.mute + '(or Ctrl-D)' + RESET);
  wln('');
  wln('  ' + C.mute + 'tip: drag a .kolm file onto this window and the TUI auto-loads it.' + RESET);
  wln('');
}

function statusLine(state) {
  const parts = [];
  if (state.artifact) parts.push(C.good + '● ' + state.artifact.fileName + RESET);
  else parts.push(C.mute + '○ no artifact' + RESET);
  if (state.server) parts.push(C.accent + 'serving :' + state.server.address().port + RESET);
  return '  ' + parts.join('   ' + C.mute + '·' + RESET + '   ');
}

// ---------- main loop ----------------------------------------------------
export async function runTui(opts) {
  opts = opts || {};
  const startPath = opts.startPath || null;

  process.stdout.write(ALT_BUFFER_IN);
  process.on('exit', function () { process.stdout.write(ALT_BUFFER_OUT + SHOW_CURSOR); });
  process.on('SIGINT', function () { process.stdout.write(ALT_BUFFER_OUT + SHOW_CURSOR); process.exit(0); });

  await splash();

  const state = { artifact: null, server: null };

  // Auto-load if a path was passed on the command line.
  if (startPath) {
    try {
      await ingestAnimation(startPath);
      state.artifact = await parseKolm(startPath);
      renderCard(state.artifact);
    } catch (e) {
      wln('  ' + C.bad + 'failed to load ' + startPath + ': ' + e.message + RESET + '\n');
    }
  } else {
    wln('  ' + C.mute + 'drag a ' + RESET + C.good + '.kolm' + RESET + C.mute + ' file onto this window — or type ' + RESET + C.good + ':help' + RESET);
    wln('');
  }

  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
    prompt: '  ' + C.good + '› ' + RESET,
  });

  function prompt() {
    // Re-render the status line above the prompt every cycle.
    wln(hr());
    wln(statusLine(state));
    wln(hr());
    rl.setPrompt('  ' + C.good + '› ' + RESET);
    rl.prompt();
  }

  prompt();

  rl.on('line', async function (line) {
    const raw = line == null ? '' : line.trim();
    if (!raw) { rl.prompt(); return; }

    // Drag-drop path detection takes priority over verb parsing.
    const dropped = looksLikeKolmPath(raw);
    if (dropped) {
      try {
        await ingestAnimation(dropped);
        state.artifact = await parseKolm(dropped);
        renderCard(state.artifact);
      } catch (e) {
        wln('  ' + C.bad + 'failed to load: ' + e.message + RESET);
      }
      prompt();
      return;
    }

    if (raw.startsWith(':')) {
      const [cmd, ...rest] = raw.slice(1).split(/\s+/);
      const arg = rest.join(' ').trim();

      if (cmd === 'help' || cmd === 'h' || cmd === '?') {
        helpScreen();
      } else if (cmd === 'exit' || cmd === 'quit' || cmd === 'q') {
        if (state.server) { try { state.server.close(); } catch (e) {} }
        rl.close();
        return;
      } else if (cmd === 'clear' || cmd === 'cls') {
        clear();
      } else if (cmd === 'drop' || cmd === 'unload') {
        if (state.server) { try { state.server.close(); } catch (e) {} state.server = null; }
        state.artifact = null;
        wln('  ' + C.mute + 'artifact unloaded.' + RESET);
      } else if (cmd === 'recipe') {
        if (!state.artifact) wln('  ' + C.bad + 'no artifact loaded.' + RESET);
        else wln(C.mute + JSON.stringify(state.artifact.recipes || { note: 'no recipes.json' }, null, 2) + RESET);
      } else if (cmd === 'receipt') {
        if (!state.artifact) wln('  ' + C.bad + 'no artifact loaded.' + RESET);
        else wln(C.mute + JSON.stringify(state.artifact.receipt || { note: 'no receipt.json' }, null, 2) + RESET);
      } else if (cmd === 'eval' || cmd === 'evals') {
        if (!state.artifact) wln('  ' + C.bad + 'no artifact loaded.' + RESET);
        else wln(C.mute + JSON.stringify(state.artifact.evals || { note: 'no evals.json' }, null, 2) + RESET);
      } else if (cmd === 'serve') {
        if (!state.artifact) { wln('  ' + C.bad + 'load a .kolm first.' + RESET); prompt(); return; }
        if (state.server) { wln('  ' + C.mute + 'already serving on :' + state.server.address().port + RESET); prompt(); return; }
        const port = parseInt(arg, 10) || 7777;
        try {
          state.server = await startServe(state.artifact, port);
          const url = 'http://127.0.0.1:' + port + '/v1/run';
          wln('');
          wln('  ' + C.good + '● serving' + RESET + '   ' + C.ink + url + RESET);
          wln('');
          wln('  ' + C.mute + 'curl example:' + RESET);
          wln('  ' + C.accent + 'curl -X POST ' + url + " -H 'Content-Type: application/json' \\" + RESET);
          wln('  ' + C.accent + "     -d '{\"input\":\"" + ((state.artifact.manifest && state.artifact.manifest.task) || 'hello').slice(0, 40).replace(/"/g, '\\"') + "\"}'" + RESET);
          wln('');
          wln('  ' + C.mute + ':stop to stop.' + RESET);
        } catch (e) {
          wln('  ' + C.bad + 'serve failed: ' + e.message + RESET);
        }
      } else if (cmd === 'stop') {
        if (state.server) { try { state.server.close(); } catch (e) {} state.server = null; wln('  ' + C.mute + 'stopped.' + RESET); }
        else wln('  ' + C.mute + 'not serving.' + RESET);
      } else if (cmd === 'run') {
        if (!state.artifact) { wln('  ' + C.bad + 'load a .kolm first.' + RESET); prompt(); return; }
        if (!arg) { wln('  ' + C.bad + 'usage: :run <prompt>' + RESET); prompt(); return; }
        await runPrompt(state.artifact, arg);
      } else {
        wln('  ' + C.bad + 'unknown command: :' + cmd + RESET + '   ' + C.mute + 'type :help' + RESET);
      }
      prompt();
      return;
    }

    // Bare input → run on current artifact (the codex/claude-style chat flow).
    if (!state.artifact) {
      wln('  ' + C.mute + 'drag a .kolm to load, or type :help' + RESET);
    } else {
      await runPrompt(state.artifact, raw);
    }
    prompt();
  });

  rl.on('close', function () {
    if (state.server) { try { state.server.close(); } catch (e) {} }
    process.stdout.write(ALT_BUFFER_OUT + SHOW_CURSOR);
    wln('');
    wln('  ' + C.mute + 'bye.' + RESET);
    process.exit(0);
  });
}

// Entry point if invoked directly (node cli/kolm-tui.mjs <path?>)
if (import.meta.url === 'file://' + process.argv[1] || process.argv[1] && process.argv[1].endsWith('kolm-tui.mjs')) {
  const startPath = process.argv[2] || null;
  runTui({ startPath: startPath }).catch(function (err) {
    process.stdout.write(ALT_BUFFER_OUT + SHOW_CURSOR);
    console.error(err);
    process.exit(1);
  });
}
