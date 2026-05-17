// src/tui-chat.js
//
// Wave Z — production-grade chat TUI for kolm artifacts + LLM bridges.
//
// The TUI is a thin shell over src/completions-api.js. Every model the
// completions API accepts (kolm:<name>, kolm-path:<abs>, anthropic:..,
// claude-.., openai:.., gpt-..) is selectable in-session via /model.
// Every conversation turn shows the model that produced it plus, when the
// model is a kolm artifact, the receipt provenance (sha256 prefix +
// latency) inline next to the assistant reply.
//
// Architecture:
//   - State is a plain object (history of messages, current model, loaded
//     artifacts, scratchpad).
//   - Render is a single render(state) -> string function that produces a
//     full-screen frame using ANSI escapes. Driven by either explicit
//     redraw or a streaming token tick.
//   - Input is line-based (readline) for portability. The composer is the
//     last few rows of the screen; everything above gets redrawn on each
//     turn.
//
// Slash commands:
//   /help                            show command list
//   /model <selector>                switch active model (any completions-api selector)
//   /models                          list models in scope (kolm artifacts + bridges)
//   /open <path>                     load a .kolm artifact into registry-by-name
//   /artifacts                       list artifacts loaded into the session
//   /research <topic>                start a research session, recording every turn
//   /save <file>                     dump transcript to JSONL
//   /clear                           clear chat history
//   /system <text>                   set the system prompt for subsequent turns
//   /verify                          verify the current model artifact (kolm only)
//   /quit                            exit
//
// Test surface (pure functions):
//   parseSlashCommand(line) -> {kind: 'message'|'command', name?, args?}
//   wordWrap(text, width) -> string[]
//   renderHeader(state, width)
//   renderChat(state, width, height)
//   renderComposer(state, width)
//   formatKolmReceipt(receipt) -> string
//   createSession(opts) -> session
//
// Non-pure side-effect surface:
//   runTuiChat({input, output, opts}) -> Promise that resolves when user quits

import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import { handleChatCompletion, handleListModels } from './completions-api.js';

const ANSI = {
  reset:    '\x1b[0m',
  bold:     '\x1b[1m',
  dim:      '\x1b[2m',
  ital:     '\x1b[3m',
  under:    '\x1b[4m',
  inv:      '\x1b[7m',
  black:    '\x1b[30m',
  red:      '\x1b[31m',
  green:    '\x1b[32m',
  yellow:   '\x1b[33m',
  blue:     '\x1b[34m',
  magenta:  '\x1b[35m',
  cyan:     '\x1b[36m',
  white:    '\x1b[37m',
  gray:     '\x1b[90m',
  bgBlue:   '\x1b[44m',
  bgGray:   '\x1b[100m',
  clear:    '\x1b[2J\x1b[H',
  altOn:    '\x1b[?1049h',
  altOff:   '\x1b[?1049l',
  hideCur:  '\x1b[?25l',
  showCur:  '\x1b[?25h',
  home:     '\x1b[H',
  clrLine:  '\x1b[2K',
  saveCur:  '\x1b7',
  restCur:  '\x1b8',
};

const COLOR_ENABLED = process.env.NO_COLOR === undefined && process.env.TERM !== 'dumb';

function c(code, s) { return COLOR_ENABLED ? code + s + ANSI.reset : s; }
function stripAnsi(s) { return String(s).replace(/\x1b\[[0-9;]*m/g, ''); }
function visibleLen(s) { return stripAnsi(s).length; }

// ---------------------------------------------------------------------------
// Pure: parseSlashCommand. Splits the first token off when it starts with '/'.
// Anything else (including empty) is treated as a chat message.
// ---------------------------------------------------------------------------
export function parseSlashCommand(line) {
  if (line == null) return { kind: 'message', text: '' };
  const trimmed = String(line);
  if (!trimmed.startsWith('/')) return { kind: 'message', text: trimmed };
  const sp = trimmed.indexOf(' ');
  if (sp < 0) return { kind: 'command', name: trimmed.slice(1).toLowerCase(), args: '' };
  return {
    kind: 'command',
    name: trimmed.slice(1, sp).toLowerCase(),
    args: trimmed.slice(sp + 1).trim(),
  };
}

// ---------------------------------------------------------------------------
// Pure: word-wrap. Breaks long lines on word boundaries, preserves blank
// lines, and handles hard newlines. Always returns an array of lines whose
// visible length is <= width.
// ---------------------------------------------------------------------------
export function wordWrap(text, width) {
  if (width <= 0) width = 1;
  const out = [];
  for (const rawLine of String(text ?? '').split('\n')) {
    if (rawLine.length <= width) { out.push(rawLine); continue; }
    const words = rawLine.split(/(\s+)/);
    let cur = '';
    for (const w of words) {
      if (visibleLen(cur) + visibleLen(w) > width) {
        if (cur.length) out.push(cur);
        // If the word itself is wider than the screen, hard-break it.
        if (visibleLen(w) > width) {
          for (let i = 0; i < w.length; i += width) out.push(w.slice(i, i + width));
          cur = '';
        } else {
          cur = w.trimStart();
        }
      } else {
        cur += w;
      }
    }
    if (cur.length) out.push(cur);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Pure: formatKolmReceipt. Produces a single-line provenance footer for a
// chat-completion response that carried a kolm sub-block.
// ---------------------------------------------------------------------------
export function formatKolmReceipt(receipt) {
  if (!receipt) return '';
  const sha = (receipt.artifact_sha256 || '').replace(/^sha256:/, '').slice(0, 12);
  const lat = receipt.latency_us != null ? `${receipt.latency_us}µs` : '?';
  const rec = receipt.recipe_id || '?';
  const k = receipt.k_score && typeof receipt.k_score === 'object'
    ? (receipt.k_score.composite ?? '?')
    : (receipt.k_score ?? '?');
  return `kolm · ${rec} · sha256:${sha}… · ${lat} · k=${k}`;
}

// ---------------------------------------------------------------------------
// Pure: createSession. Sets up the in-memory state.
// ---------------------------------------------------------------------------
export function createSession(opts = {}) {
  return {
    model: opts.model || 'kolm:echo',
    systemPrompt: opts.systemPrompt || '',
    messages: [],
    artifacts: {}, // name -> abs path (overrides registry lookup)
    registryDirs: opts.registryDirs || null,
    research: null, // { topic, file } when /research is active
    status: { ready: true, busy: false, lastLatencyMs: null, lastError: null },
    composer: '',
    scrollOffset: 0,
  };
}

// ---------------------------------------------------------------------------
// Pure: renderHeader / renderChat / renderComposer.
// These return strings of fixed visual width = `width`, with the right
// number of rows. The caller composes them into a full-screen frame.
// ---------------------------------------------------------------------------
export function renderHeader(state, width) {
  const title = ' kolm chat ';
  const status = state.status.busy
    ? c(ANSI.yellow, '● working')
    : state.status.lastError
      ? c(ANSI.red, '● error')
      : c(ANSI.green, '● ready');
  const model = `model: ${c(ANSI.cyan, state.model)}`;
  const arts = Object.keys(state.artifacts).length
    ? `  artifacts: ${c(ANSI.bold, String(Object.keys(state.artifacts).length))}`
    : '';
  const research = state.research ? `  research: ${c(ANSI.magenta, state.research.topic)}` : '';
  const left = c(ANSI.bold + ANSI.bgBlue + ANSI.white, title) + ' ' + model + arts + research;
  const right = `${status}  ${c(ANSI.gray, `${state.messages.length} msgs`)}`;
  const padLen = Math.max(0, width - visibleLen(left) - visibleLen(right));
  return left + ' '.repeat(padLen) + right;
}

// Render chat scrollback to fit in `height` rows (inclusive of any per-message
// header/footer rows). Newest messages stick to the bottom; older messages
// drop off the top when we run out of room.
export function renderChat(state, width, height) {
  if (height <= 0) return '';
  const rows = [];
  for (const m of state.messages) {
    const headRaw = m.role === 'user'
      ? c(ANSI.bold + ANSI.green, '› you')
      : m.role === 'system'
        ? c(ANSI.bold + ANSI.gray, '∘ system')
        : c(ANSI.bold + ANSI.cyan, `‹ ${m.modelLabel || 'assistant'}`);
    rows.push(headRaw);
    const bodyLines = wordWrap(m.content || '', width - 2);
    for (const ln of bodyLines) rows.push('  ' + ln);
    if (m.role === 'assistant' && m.kolm) {
      rows.push('  ' + c(ANSI.dim, formatKolmReceipt(m.kolm)));
    } else if (m.role === 'assistant' && m.upstream) {
      rows.push('  ' + c(ANSI.dim, `upstream · ${m.upstream.vendor} · ${m.upstream.model}`));
    }
    rows.push('');
  }
  // Tail-trim to fit.
  const visible = rows.slice(Math.max(0, rows.length - height));
  // Pad to fixed height so the composer stays at the same row each frame.
  while (visible.length < height) visible.push('');
  return visible.join('\n');
}

export function renderComposer(state, width) {
  const promptStr = state.status.busy
    ? c(ANSI.yellow, '… ')
    : c(ANSI.bold + ANSI.cyan, '› ');
  const hint = state.composer.length === 0
    ? c(ANSI.gray, 'type a message, or /help for commands, /quit to exit')
    : c(ANSI.white, state.composer);
  const sep = c(ANSI.gray, '─'.repeat(width));
  const errLine = state.status.lastError
    ? c(ANSI.red, '  ! ' + state.status.lastError)
    : '';
  const lines = [sep];
  if (errLine) lines.push(errLine);
  lines.push(promptStr + hint);
  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// Pure: renderFrame. Composes header + chat + composer into a single
// terminal-sized frame. Caller writes the result to stdout after clearing.
// ---------------------------------------------------------------------------
export function renderFrame(state, width, height) {
  // Allocate rows: 1 header, 1 blank, N chat, 2-3 composer.
  const composerRows = state.status.lastError ? 3 : 2;
  const chatRows = Math.max(1, height - 2 - composerRows);
  return [
    renderHeader(state, width),
    '',
    renderChat(state, width, chatRows),
    renderComposer(state, width),
  ].join('\n');
}

// ---------------------------------------------------------------------------
// Command handlers (each takes (state, args, ctx) and may async-mutate state).
// They return { reply?, error?, redraw? } for the caller to surface.
// ---------------------------------------------------------------------------
export const COMMANDS = {
  help(_state, _args) {
    return { reply: helpText() };
  },
  model(state, args) {
    if (!args) return { error: 'usage: /model <selector>  (e.g. kolm:echo, claude-sonnet-4-6, gpt-5)' };
    state.model = args;
    return { reply: `model set to ${args}` };
  },
  models: async (state) => {
    const out = await handleListModels({ registryDirs: state.registryDirs });
    const ids = out.data.map(m => `  ${m.id}${m.k_score != null ? `  k=${m.k_score}` : ''}`);
    return { reply: 'available models:\n' + ids.join('\n') };
  },
  open(state, args) {
    if (!args) return { error: 'usage: /open <path-to-.kolm>' };
    const abs = path.isAbsolute(args) ? args : path.resolve(process.cwd(), args);
    if (!fs.existsSync(abs)) return { error: `not found: ${abs}` };
    const name = path.basename(abs, '.kolm');
    state.artifacts[name] = abs;
    return { reply: `loaded ${name} -> ${abs}` };
  },
  artifacts(state) {
    const keys = Object.keys(state.artifacts);
    if (!keys.length) return { reply: 'no artifacts loaded — try /open <path>.kolm' };
    return { reply: 'loaded artifacts:\n' + keys.map(k => `  ${k} -> ${state.artifacts[k]}`).join('\n') };
  },
  system(state, args) {
    state.systemPrompt = args || '';
    return { reply: args ? `system prompt set (${args.length} chars)` : 'system prompt cleared' };
  },
  clear(state) {
    state.messages = [];
    state.status.lastError = null;
    return { reply: 'chat cleared' };
  },
  research(state, args) {
    if (!args) return { error: 'usage: /research <topic>' };
    const filename = `kolm-research-${slugify(args)}-${Date.now()}.jsonl`;
    const abs = path.resolve(process.cwd(), filename);
    state.research = { topic: args, file: abs };
    try {
      fs.writeFileSync(abs, JSON.stringify({ event: 'research_start', topic: args, started_at: new Date().toISOString(), model: state.model }) + '\n');
    } catch (e) { return { error: `could not open research file: ${e.message}` }; }
    return { reply: `research mode on. topic=${args}. recording to ${abs}` };
  },
  save(state, args) {
    const filename = args || `kolm-chat-${Date.now()}.jsonl`;
    const abs = path.isAbsolute(filename) ? filename : path.resolve(process.cwd(), filename);
    const lines = state.messages.map(m => JSON.stringify(m));
    fs.writeFileSync(abs, lines.join('\n') + (lines.length ? '\n' : ''));
    return { reply: `saved ${state.messages.length} messages to ${abs}` };
  },
  quit() {
    return { quit: true };
  },
};

function helpText() {
  return [
    'slash commands:',
    '  /help                       show this message',
    '  /model <selector>           switch active model',
    '  /models                     list models in scope',
    '  /open <path.kolm>           register an artifact by basename',
    '  /artifacts                  list registered artifacts',
    '  /system <text>              set system prompt',
    '  /research <topic>           start a research session, recording all turns',
    '  /save [file]                dump transcript to JSONL',
    '  /clear                      clear chat',
    '  /quit                       exit',
    '',
    'model selectors (any of):',
    '  kolm:<name>                 local artifact by short name (uses registry)',
    '  kolm-path:<absolute>        local artifact by absolute path',
    '  claude-* / anthropic:<id>   bridge to Anthropic (needs ANTHROPIC_API_KEY)',
    '  gpt-*    / openai:<id>      bridge to OpenAI   (needs OPENAI_API_KEY)',
    '',
    'any line not starting with / is a chat turn.',
  ].join('\n');
}

function slugify(s) {
  return String(s).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '').slice(0, 32) || 'topic';
}

// ---------------------------------------------------------------------------
// runTuiChat — the side-effecting orchestrator. Wires render + input + the
// completions API together. Stops when the user types /quit or sends EOF.
// ---------------------------------------------------------------------------
export async function runTuiChat({ input, output, opts } = {}) {
  input = input || process.stdin;
  output = output || process.stdout;
  opts = opts || {};

  const state = createSession(opts);
  if (opts.openArtifacts) for (const ap of opts.openArtifacts) COMMANDS.open(state, ap);
  if (opts.model) state.model = opts.model;

  const isTTY = output.isTTY === true;
  // Enter alt screen + hide cursor only on real TTY (tests pipe to a buffer).
  if (isTTY) {
    output.write(ANSI.altOn + ANSI.hideCur + ANSI.clear);
  }

  const redraw = () => {
    if (!isTTY) return;
    const cols = output.columns || 80;
    const rows = output.rows || 24;
    output.write(ANSI.home + ANSI.clear + renderFrame(state, cols, rows));
  };

  redraw();

  const rl = readline.createInterface({
    input, output: isTTY ? output : undefined,
    prompt: isTTY ? '' : '› ',
    terminal: isTTY,
  });

  // SIGWINCH (terminal resize) — just redraw.
  if (isTTY) output.on?.('resize', redraw);

  const pushMessage = (m) => {
    state.messages.push(m);
    if (state.research) {
      try { fs.appendFileSync(state.research.file, JSON.stringify({ event: 'message', ...m, ts: new Date().toISOString() }) + '\n'); } catch {}
    }
  };

  const runOneTurn = async (userText) => {
    pushMessage({ role: 'user', content: userText });
    state.status.busy = true;
    state.status.lastError = null;
    redraw();
    const req = {
      model: state.model,
      messages: [
        ...(state.systemPrompt ? [{ role: 'system', content: state.systemPrompt }] : []),
        ...state.messages.map(({ role, content }) => ({ role, content })),
      ],
    };
    const t0 = Date.now();
    try {
      const resp = await handleChatCompletion(req, { registryDirs: state.registryDirs, artifactByName: state.artifacts });
      const text = resp.choices?.[0]?.message?.content ?? '';
      pushMessage({
        role: 'assistant',
        content: text,
        modelLabel: resp.model || state.model,
        kolm: resp.kolm || null,
        upstream: resp.upstream || null,
      });
      state.status.lastLatencyMs = Date.now() - t0;
      if (!isTTY) {
        output.write(c(ANSI.cyan, `‹ ${resp.model || state.model}\n`));
        output.write(text + '\n');
        if (resp.kolm) output.write(c(ANSI.dim, formatKolmReceipt(resp.kolm) + '\n'));
      }
    } catch (e) {
      state.status.lastError = `${e.code || 'error'}: ${e.message}`;
      // Surface the error as a system message so it shows in scrollback too.
      pushMessage({
        role: 'system',
        content: `error: ${state.status.lastError}`,
      });
      if (!isTTY) output.write(c(ANSI.red, `error: ${state.status.lastError}\n`));
    } finally {
      state.status.busy = false;
      redraw();
    }
  };

  const exitClean = () => {
    if (isTTY) {
      output.write(ANSI.showCur + ANSI.altOff);
    }
    rl.close();
  };

  rl.on('SIGINT', () => {
    if (state.status.busy) {
      state.status.lastError = 'cancel requested (Ctrl-C again to quit)';
      redraw();
      return;
    }
    output.write('\n' + c(ANSI.dim, 'bye.') + '\n');
    exitClean();
  });

  // Non-TTY mode: prompt and read lines without alt-screen.
  if (!isTTY) {
    output.write(c(ANSI.gray, 'kolm chat (non-tty mode) — model=' + state.model + ', /help for commands\n'));
  }

  const linesP = new Promise((resolve) => {
    rl.on('line', async (raw) => {
      const line = raw.trim();
      const parsed = parseSlashCommand(line);
      if (parsed.kind === 'command') {
        const handler = COMMANDS[parsed.name];
        if (!handler) {
          state.status.lastError = `unknown command: /${parsed.name}`;
          if (!isTTY) output.write(c(ANSI.red, state.status.lastError) + '\n');
          redraw();
          if (!isTTY) rl.prompt();
          return;
        }
        try {
          const r = await handler(state, parsed.args, {});
          if (r?.quit) { resolve(); return; }
          if (r?.reply) {
            pushMessage({ role: 'system', content: r.reply });
            if (!isTTY) output.write(c(ANSI.gray, r.reply) + '\n');
          }
          if (r?.error) {
            state.status.lastError = r.error;
            if (!isTTY) output.write(c(ANSI.red, r.error) + '\n');
          } else {
            state.status.lastError = null;
          }
          redraw();
        } catch (e) {
          state.status.lastError = e.message;
          redraw();
        }
        if (!isTTY) rl.prompt();
        return;
      }
      if (!parsed.text) { if (!isTTY) rl.prompt(); return; }
      await runOneTurn(parsed.text);
      if (!isTTY) rl.prompt();
    });
    rl.on('close', resolve);
  });

  if (!isTTY) rl.prompt();
  await linesP;
  exitClean();
  return state;
}
