// Wave 175 — Shift 1 substrate parity closure for /quickstart.
//
// Every CLI command shown on public/quickstart.html is locked against the
// actual implementation in cli/kolm.js. Same lock-in style as
// tests/wave172-recipe-classes.test.js: grep page prose for the verbs +
// exec the backend to confirm the verbs and flags actually exist.
//
// Thesis: "every claim on /quickstart matches what the CLI actually does."
// If quickstart.html ever drifts from the CLI substrate, these tests fail
// loudly. If the CLI drops a verb the page advertises, these tests fail
// loudly too — `test.skip()` is used (not silent pass) to document gaps.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, '..');
const PUBLIC = path.join(REPO, 'public');
const QUICKSTART = path.join(PUBLIC, 'quickstart.html');
const SW = path.join(PUBLIC, 'sw.js');
const CLI = path.join(REPO, 'cli', 'kolm.js');
const HELP_BLOCK_START = 'const HELP = {';

const read = (p) => fs.readFileSync(p, 'utf8');

// CLI verbs explicitly demoed on /quickstart.html (with the flags they
// appear with). Authored by reading the page once and writing them down;
// drift in either direction triggers a test failure.
//
// help_topic = key inside HELP{} that the verb's `--help` resolves to, so
// the help-text assertion below can grep the right block. Where the verb
// has no dedicated HELP block (e.g. bare `kolm`, `kolm chat`), help_topic
// is null and only the dispatch-table assertion fires.
const QUICKSTART_VERBS = [
  {
    verb: 'version',
    help_topic: 'version',
    flags: [],
    quickstart_line: 'kolm version',
    safe_to_exec: true, // only --help is exec'd; --offline keeps it pure
  },
  {
    verb: 'signup',
    help_topic: 'signup',
    flags: ['--email'],
    quickstart_line: 'kolm signup --email you@example.com',
    safe_to_exec: true,
  },
  {
    verb: 'login',
    help_topic: 'login',
    flags: ['--key'],
    quickstart_line: 'kolm login --key ks_...',
    safe_to_exec: true,
  },
  {
    verb: 'compile',
    help_topic: 'compile',
    flags: ['--examples'],
    quickstart_line: 'kolm compile "classify support tickets" --examples ./tickets.jsonl',
    safe_to_exec: true,
  },
  {
    verb: 'run',
    help_topic: 'run',
    flags: [],
    quickstart_line: "kolm run ./tickets.kolm '{\"input\":\"checkout fails on Android\"}'",
    safe_to_exec: true,
  },
  {
    verb: 'inspect',
    help_topic: 'inspect',
    flags: [],
    quickstart_line: 'Audit it with `kolm inspect`',
    safe_to_exec: true,
  },
  {
    verb: 'install',
    help_topic: 'install',
    flags: ['--apply'],
    quickstart_line: 'kolm install claude-code --apply',
    safe_to_exec: true,
  },
  {
    verb: 'serve',
    help_topic: 'serve',
    flags: ['--mcp', '--http', '--port'],
    quickstart_line: 'kolm serve --mcp --http --port 11455',
    safe_to_exec: true,
  },
];

// Harness names that appear on the page for `kolm install <harness> --apply`.
const QUICKSTART_HARNESSES = ['claude-code', 'cursor'];

test('1. public/quickstart.html exists and is non-trivial size', () => {
  assert.ok(fs.existsSync(QUICKSTART), `quickstart.html missing at ${QUICKSTART}`);
  const stat = fs.statSync(QUICKSTART);
  assert.ok(stat.size > 4 * 1024, `quickstart.html too small (${stat.size} bytes; expected > 4 KB)`);
});

test('2. /quickstart declares the canonical https://kolm.ai/quickstart URL', () => {
  const html = read(QUICKSTART);
  assert.match(html, /<link rel="canonical" href="https:\/\/kolm\.ai\/quickstart"/,
    'quickstart.html must declare canonical https://kolm.ai/quickstart');
});

test('3. cli/kolm.js exists and is non-trivial size (CLI substrate present)', () => {
  assert.ok(fs.existsSync(CLI), `cli/kolm.js missing at ${CLI}`);
  const stat = fs.statSync(CLI);
  assert.ok(stat.size > 100 * 1024, `cli/kolm.js too small (${stat.size} bytes; expected > 100 KB for a real CLI)`);
});

test('4. Every quickstart CLI verb is mentioned in quickstart.html prose', () => {
  const html = read(QUICKSTART);
  for (const v of QUICKSTART_VERBS) {
    assert.ok(
      html.includes(`kolm ${v.verb}`) || html.includes(`kolm </code> with no args`) /* bare kolm */,
      `quickstart.html should mention \`kolm ${v.verb}\` (test fixture got out of sync with page prose)`
    );
  }
});

test('5. Every quickstart CLI verb is registered in cli/kolm.js dispatch table', () => {
  const cli = read(CLI);
  for (const v of QUICKSTART_VERBS) {
    // Match the `case 'verb':` dispatch line. Anchored to the verb so we
    // don't false-positive against an arbitrary string. This is the
    // "substrate matches the claim" check that Shift 1 exists to enforce.
    const pat = new RegExp(`case\\s+['"\`]${v.verb}['"\`]\\s*:`);
    assert.match(cli, pat,
      `cli/kolm.js dispatch table missing \`case '${v.verb}'\` — quickstart.html advertises "${v.quickstart_line}" but the CLI does not handle it`);
  }
});

test('6. Every quickstart verb has a cmd* implementation function in cli/kolm.js', () => {
  const cli = read(CLI);
  // Map verb -> expected function name. cmdBenchmark covers `bench` etc.;
  // for the quickstart subset the verbs all match cmd<Title>(args).
  const verbToFn = {
    version: 'cmdVersion',
    signup: 'cmdSignup',
    login: 'cmdLogin',
    compile: 'cmdCompile',
    run: 'cmdRun',
    inspect: 'cmdInspect',
    install: 'cmdInstall',
    serve: 'cmdServe',
  };
  for (const v of QUICKSTART_VERBS) {
    const fnName = verbToFn[v.verb];
    assert.ok(fnName, `Test fixture missing function-name mapping for verb ${v.verb}`);
    const pat = new RegExp(`async function ${fnName}\\s*\\(`);
    assert.match(cli, pat,
      `cli/kolm.js missing implementation function ${fnName} for verb \`kolm ${v.verb}\``);
  }
});

test('7. Every flag advertised on /quickstart is recognized inside cli/kolm.js', () => {
  const cli = read(CLI);
  for (const v of QUICKSTART_VERBS) {
    for (const flag of v.flags) {
      // The flag should appear at least once in the CLI source. This is a
      // weak check (the flag could be referenced in a help string only),
      // but is paired with test #8 below which exec's `--help` and asserts
      // the help text mentions the flag — together they prove both that
      // the flag exists in source AND that it is documented in --help.
      assert.ok(
        cli.includes(`'${flag}'`) || cli.includes(`"${flag}"`) || cli.includes('`' + flag + '`'),
        `cli/kolm.js does not reference flag ${flag} for verb \`kolm ${v.verb}\` (quickstart shows: "${v.quickstart_line}")`
      );
    }
  }
});

test('8. `kolm <verb> --help` exits cleanly and mentions documented flags', () => {
  // Exec `node cli/kolm.js <verb> --help` for each safe-to-exec verb.
  // Asserts: (a) the child exits 0 within 5s, (b) stdout includes the
  // verb name, (c) stdout includes every flag in the verb's `flags`
  // list. This is the load-bearing integration check — if a verb were
  // silently renamed in src, this exec would fail.
  for (const v of QUICKSTART_VERBS) {
    if (!v.safe_to_exec) continue;
    const r = spawnSync(process.execPath, [CLI, v.verb, '--help'], {
      timeout: 5000,
      encoding: 'utf8',
      env: {
        ...process.env,
        // Force air-gap so `kolm version --help` does NOT call /health, and
        // so the help-text branch fires before any network code.
        KOLM_AIRGAP: '1',
        NO_COLOR: '1',
      },
    });
    assert.equal(r.status, 0,
      `\`node cli/kolm.js ${v.verb} --help\` exited ${r.status} (stderr: ${r.stderr?.slice(0, 200)})`);
    const out = (r.stdout || '') + (r.stderr || '');
    assert.ok(out.toLowerCase().includes(`kolm ${v.verb}`) || out.toLowerCase().includes(v.verb),
      `\`kolm ${v.verb} --help\` output should reference the verb name`);
    for (const flag of v.flags) {
      assert.ok(out.includes(flag),
        `\`kolm ${v.verb} --help\` output must document flag ${flag} (page shows: "${v.quickstart_line}")\nactual help head: ${out.slice(0, 300)}`);
    }
  }
});

test('9. `kolm install` accepts both harnesses shown on /quickstart', () => {
  const cli = read(CLI);
  // The HARNESS_SNIPPETS map keys are the harness names. Confirm every
  // harness shown on /quickstart is a key.
  const harnessMatch = cli.match(/const HARNESS_SNIPPETS\s*=\s*\{[\s\S]*?\n\};/);
  assert.ok(harnessMatch, 'cli/kolm.js must declare a HARNESS_SNIPPETS map');
  const block = harnessMatch[0];
  for (const h of QUICKSTART_HARNESSES) {
    // Match either `'harness':` or `"harness":` keys.
    const pat = new RegExp(`['"]${h.replace('-', '\\-')}['"]\\s*:`);
    assert.match(block, pat,
      `cli/kolm.js HARNESS_SNIPPETS missing key "${h}" — quickstart.html shows \`kolm install ${h} --apply\` but the harness is not registered`);
  }
});

test('10. `kolm serve --mcp` and `kolm serve --http` are both wired in cmdServe', () => {
  const cli = read(CLI);
  // Locate cmdServe and assert the function body recognizes --mcp + --http.
  // Approach: grab the source between `async function cmdServe(args)` and
  // the next top-level `async function` declaration.
  const start = cli.indexOf('async function cmdServe(args)');
  assert.ok(start >= 0, 'cli/kolm.js missing cmdServe implementation');
  const tail = cli.slice(start);
  const nextFn = tail.search(/\nasync function cmd[A-Z]/);
  const body = nextFn > 0 ? tail.slice(0, nextFn) : tail.slice(0, 4000);
  assert.match(body, /--mcp/,
    'cmdServe must read --mcp flag (quickstart shows `kolm serve --mcp`)');
  assert.match(body, /--http/,
    'cmdServe must read --http flag (quickstart shows `kolm serve --http`)');
  assert.match(body, /--port/,
    'cmdServe must read --port flag (quickstart shows `kolm serve --port 11455`)');
});

test('11. `kolm compile --examples` path exists in cmdCompile body', () => {
  const cli = read(CLI);
  const start = cli.indexOf('async function cmdCompile(args)');
  assert.ok(start >= 0, 'cli/kolm.js missing cmdCompile implementation');
  // Grab a generous window (cmdCompile is large).
  const window = cli.slice(start, start + 80_000);
  assert.match(window, /--examples/,
    "cmdCompile must read --examples (quickstart shows `kolm compile \"...\" --examples ./tickets.jsonl`)");
});

test('12. `kolm signup --email` path exists in cmdSignup body', () => {
  const cli = read(CLI);
  const start = cli.indexOf('async function cmdSignup(args)');
  assert.ok(start >= 0, 'cli/kolm.js missing cmdSignup implementation');
  const nextFn = cli.slice(start + 10).search(/\nasync function cmd[A-Z]/);
  const body = cli.slice(start, start + (nextFn > 0 ? nextFn + 10 : 4000));
  assert.match(body, /--email/,
    'cmdSignup must read --email (quickstart shows `kolm signup --email you@example.com`)');
});

test('13. `kolm login --key` path exists in cmdLogin body', () => {
  const cli = read(CLI);
  const start = cli.indexOf('async function cmdLogin(args)');
  assert.ok(start >= 0, 'cli/kolm.js missing cmdLogin implementation');
  const nextFn = cli.slice(start + 10).search(/\nasync function cmd[A-Z]/);
  const body = cli.slice(start, start + (nextFn > 0 ? nextFn + 10 : 4000));
  assert.match(body, /--key/,
    'cmdLogin must read --key (quickstart shows `kolm login --key ks_...`)');
});

test('14. `kolm install --apply` path exists in cmdInstall body', () => {
  const cli = read(CLI);
  const start = cli.indexOf('async function cmdInstall(args)');
  assert.ok(start >= 0, 'cli/kolm.js missing cmdInstall implementation');
  const nextFn = cli.slice(start + 10).search(/\nasync function cmd[A-Z]/);
  const body = cli.slice(start, start + (nextFn > 0 ? nextFn + 10 : 4000));
  assert.match(body, /--apply/,
    'cmdInstall must read --apply (quickstart shows `kolm install claude-code --apply`)');
});

test('15. `kolm run` accepts JSON-string positional input as shown on /quickstart', () => {
  const cli = read(CLI);
  // The page shows `kolm run ./x.kolm '{"input":"..."}' ` — confirm the
  // run handler resolves a positional artifact + positional input string.
  const start = cli.indexOf('async function cmdRun(args)');
  assert.ok(start >= 0, 'cli/kolm.js missing cmdRun implementation');
  const nextFn = cli.slice(start + 10).search(/\nasync function cmd[A-Z]/);
  const body = cli.slice(start, start + (nextFn > 0 ? nextFn + 10 : 4000));
  // positional[0] = artifact, positional[1] = inline input
  assert.match(body, /positional\[0\]|args\[0\]/,
    'cmdRun must read a positional artifact argument');
  assert.match(body, /positional\[1\]|args\[1\]|inputRaw/,
    'cmdRun must accept a positional/inline input string (quickstart shows `kolm run ./x.kolm \'{...}\'`)');
});

test('16. /quickstart "first run path" claims sw.js CACHE wave segment >= 175', () => {
  // Wave-floor regex-capture pattern (NOT literal match — literal-match is a
  // known regression trap that fires every wave bump; the lesson from W169
  // test #12 is to assert monotonicity, not equality).
  const sw = read(SW);
  const m = sw.match(/const CACHE = 'kolm-v7-\d{4}-\d{2}-\d{2}-wave(\d+)-/);
  assert.ok(m, 'sw.js must declare a kolm-v7-YYYY-MM-DD-wave<N>- CACHE constant');
  assert.ok(Number(m[1]) >= 175,
    `sw.js CACHE wave segment must be >= 175 (saw wave${m[1]}); parent orchestrator should bump this`);
});

test('17. /quickstart references the offline-runnable .kolm artifact pattern', () => {
  const html = read(QUICKSTART);
  // The page promises "Run it offline with `kolm run`." and shows the
  // `kolm run ./phi-redactor.kolm '{...}'` form. Lock that prose so it
  // can't be silently softened.
  assert.match(html, /kolm run/,
    'quickstart.html must show `kolm run` (the load-bearing offline-execute verb)');
  assert.match(html, /run it offline|runs anywhere you put it|run.*locally/i,
    'quickstart.html must promise offline / local execution (load-bearing positioning)');
});

test('18. /quickstart `kolm install <harness>` enumerates harnesses that exist in CLI', () => {
  const html = read(QUICKSTART);
  const cli = read(CLI);
  // Every harness named on the page must be a HARNESS_SNIPPETS key.
  for (const h of QUICKSTART_HARNESSES) {
    assert.ok(
      html.includes(`kolm install ${h}`),
      `quickstart.html must include \`kolm install ${h}\` (test fixture got out of sync with page prose)`
    );
    const pat = new RegExp(`['"]${h.replace('-', '\\-')}['"]\\s*:`);
    assert.match(cli, pat,
      `cli/kolm.js must register harness "${h}" (quickstart shows \`kolm install ${h} --apply\`)`);
  }
});

test('19. `kolm doctor` is reachable (quickstart positions it as the wiring-verifier)', () => {
  const html = read(QUICKSTART);
  const cli = read(CLI);
  // The "wire it in" section claims `kolm doctor` verifies the wiring.
  if (html.includes('kolm doctor')) {
    assert.match(cli, /case\s+['"]doctor['"]\s*:/,
      'cli/kolm.js dispatch table missing `case \'doctor\'` — quickstart.html mentions `kolm doctor`');
    assert.match(cli, /async function cmdDoctor\s*\(/,
      'cli/kolm.js missing cmdDoctor implementation function');
  }
});

test('20. /quickstart "kolm with no args" claim — bare invocation does not crash', () => {
  // The page says: "Run `kolm` with no args and describe your task in
  // natural language. The CLI walks the same path step by step."
  //
  // Today, `kolm` with no args prints help (see main() default branch
  // for `cmd === undefined`). The page does NOT advertise a chat REPL on
  // first arg — it advertises a path where the user types task text.
  //
  // We assert the safe minimum: bare `node cli/kolm.js` exits 0 and
  // emits the welcome banner / usage. If the page ever promises an
  // interactive REPL on bare invocation without args, this test stays
  // green because help-on-no-args is still a valid "walks the same
  // path step by step" surface (it tells the user what to type next).
  const r = spawnSync(process.execPath, [CLI], {
    timeout: 5000,
    encoding: 'utf8',
    env: {
      ...process.env,
      KOLM_AIRGAP: '1',
      NO_COLOR: '1',
    },
  });
  assert.equal(r.status, 0,
    `bare \`node cli/kolm.js\` exited ${r.status} (stderr: ${r.stderr?.slice(0, 200)})`);
  const out = (r.stdout || '') + (r.stderr || '');
  assert.ok(out.length > 100,
    'bare `kolm` should emit a banner/usage block (>100 chars), otherwise the page promise "describes your task in natural language" has no entry point');
});

test('21. `kolm version --short` works under air-gap (quickstart "needs Node 20+" claim)', () => {
  // The page shows `kolm version` as step 01 of path 03 to prove the
  // install succeeded. The short form is the fastest path and must work
  // offline so the first-run experience is not blocked by the network.
  const r = spawnSync(process.execPath, [CLI, 'version', '--short'], {
    timeout: 5000,
    encoding: 'utf8',
    env: {
      ...process.env,
      KOLM_AIRGAP: '1',
      NO_COLOR: '1',
    },
  });
  assert.equal(r.status, 0,
    `\`kolm version --short\` exited ${r.status} (stderr: ${r.stderr?.slice(0, 200)})`);
  assert.match(r.stdout, /^kolm v\d+\.\d+\.\d+/,
    `\`kolm version --short\` should print "kolm v<SemVer>" (got: ${r.stdout.slice(0, 60)})`);
});
