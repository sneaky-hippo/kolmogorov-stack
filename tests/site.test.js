import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';

const TEXT_EXTENSIONS = new Set([
  '.html', '.css', '.js', '.svg', '.json', '.webmanifest', '.xml', '.txt', '.md',
]);

const LEGACY_BRAND_PATTERNS = [
  '#05040a',
  '#080908',
  '#10120f',
  '#151712',
  '#f6f1e7',
  '#a9aaa2',
  '#70756d',
  '#a7ff5f',
  '#63e7ff',
  '#ff8a5f',
  '#0b0d16',
  '#101522',
  '#8ea4ff',
  '#78f0d4',
  '#ffca7a',
  'rgba(142,164,255',
  'rgba(120,240,212',
  'rgba(255,202,122',
  'rgba(5,4,10',
  'rgba(10,10,10',
  'rgba(170, 156, 255',
  'rgba(170,156,255',
  '#7c8cff',
  '#93a1ff',
  '#7ce3b6',
  '#e3deff',
  'rgba(124,140,255',
  'rgba(124,232,182',
  '#aa9cff',
  '#d4c8ff',
  '#65d4ff',
  '#5be8b6',
  '#0d1224',
  '#11172a',
  'rgba(22,19,42',
  'rgba(14,12,28',
  'Compile any AI task into a Specialist',
  'Compile your data into a model',
  'AI that ships as a',
];

const FORBIDDEN_PUBLIC_PATTERNS = [
  'install.sh',
  'brew install kolmogorov/tap/kolm',
  'brew install kolm',
  'cargo install kolm',
  'pip install kolm',
  'curl kolm.ai/install',
  'curl -fsSL https://kolm.ai/install',
  'npm i -g @kolmogorov/kolm',
  'kolm key add',
  'kolm bundle',
  '$ kolm verify',
  '>kolm verify',
  'kolm verify<',
  'kolm anchor ',
  'kolm diff ',
  'kolm recall ',
  'kolm resolve ',
  'kolm trace ',
  'kolm config set ',
  '--tpl',
  '~/.kolm/credentials',
  'phone cold-start',
  '3B INT4',
  'kolmogorov-stack-production.up.railway.app',
  'Type I evidence available now',
  'SOC 2 Type II evidence',
  'EU AI Act compliant',
  'HIPAA-ready',
  'DPA signed at sign-up',
  'Conformity assessment in flight',
  'On-chain receipt anchoring',
  'On-chain receipt anchor',
  'on-chain receipt anchoring',
  'Bitcoin OP_RETURN',
  'Arweave',
  'kolm anchor --on-chain',
  'Air-gap mode',
  'Air-gapped registry mirror',
  'On-prem compile bridge',
  'Mobile SDK',
  'kolm-swift',
  'ai.kolm:kolm-runtime',
  '@kolm-ai/runtime',
  'Cleared App Review',
  'iOS 繚 Android SDK',
  'WASM runtime',
  'kolm WASM',
  'HMAC chain to registry',
  'anchored to the public registry',
  'PHI never leaves',
  'runs on any modern phone',
  'FedRAMP Moderate roadmap',
  'CMMC 2.0 Level 2 evidence',
  'ITAR-aware',
  'SAML 繚 SCIM',
  'unlimited Specialists',
  'Postgres database on Railway',
  'Cloudflare R2',
  'zero runtime egress',
  'inside your VPC',
  'fully self-contained',
  'anchored to public registry',
  'anchored to the public registry',
  'HMAC chain ??public registry',
  'every phone shipped',
  'wllama.wasm',
  'Executorch bindings',
  'never persisted server-side',
  'Public append-only registry',
  '繚',
  '繕',
  '??/span',
  '??/a',
  'ks_??',
  '蝜',
  '?',
];

const REQUIRED_SITEMAP_ROUTES = [
  '/',
  '/compile',
  '/run',
  '/recall',
  '/serve',
  '/anatomy',
  '/k-score',
  '/benchmarks',
  '/compare',
  '/pricing',
  '/docs',
  '/quickstart',
  '/security',
  '/privacy',
  '/terms',
  '/articles',
  '/articles/ai-compiler',
  '/articles/hipaa-on-device',
  '/articles/k-sample-verified-inference',
  '/articles/kolm-file-format',
  '/articles/speculative-decoding-recipes',
];

const STALE_SOURCE_PATTERNS = [
  '# Recipe',
  'kolmogorov-stack-production.up.railway.app',
  'Retail brand: **Recipe**',
  'Recipe is the **Skills** layer',
  '@kolmogorov/recipe',
  'kolmogorov-recipe',
];

function walkFiles(dir, predicate, out = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const file = path.join(dir, entry.name);
    if (entry.isDirectory()) walkFiles(file, predicate, out);
    else if (!predicate || predicate(file)) out.push(file);
  }
  return out;
}

function freePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const port = server.address().port;
      server.close(() => resolve(port));
    });
  });
}

async function waitForHealth(base, retries = 50) {
  for (let i = 0; i < retries; i++) {
    try {
      const res = await fetch(base + '/health');
      if (res.ok) return;
    } catch {}
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw new Error('server did not come up');
}

function normalizeInternalUrl(raw) {
  if (!raw) return null;
  let value = raw.trim().replace(/^['"]|['"]$/g, '');
  if (!value || value.startsWith('#')) return null;
  if (/^(mailto|tel|javascript|data|blob):/i.test(value)) return null;
  if (value.startsWith('https://kolm.ai/')) value = value.slice('https://kolm.ai'.length);
  if (value.startsWith('http://kolm.ai/')) value = value.slice('http://kolm.ai'.length);
  if (!value.startsWith('/')) return null;
  if (value.startsWith('/v1/')) return null;
  return value.split('#')[0];
}

function collectInternalReferences() {
  const refs = new Set(['/sitemap.xml']);
  const htmlFiles = walkFiles('public', file =>
    file.endsWith('.html') &&
    !file.includes(`${path.sep}_archive${path.sep}`)
  );

  for (const file of htmlFiles) {
    const html = fs.readFileSync(file, 'utf8');
    for (const match of html.matchAll(/\b(?:href|src|poster|action)=["']([^"']+)["']/gi)) {
      const ref = normalizeInternalUrl(match[1]);
      if (ref) refs.add(ref);
    }
    for (const match of html.matchAll(/url\(([^)]+)\)/gi)) {
      const ref = normalizeInternalUrl(match[1]);
      if (ref) refs.add(ref);
    }
  }

  for (const cssFile of walkFiles('public', file => file.endsWith('.css'))) {
    const css = fs.readFileSync(cssFile, 'utf8');
    for (const match of css.matchAll(/url\(([^)]+)\)/gi)) {
      const ref = normalizeInternalUrl(match[1]);
      if (ref) refs.add(ref);
    }
  }

  const sitemap = fs.readFileSync(path.join('public', 'sitemap.xml'), 'utf8');
  for (const match of sitemap.matchAll(/<loc>https:\/\/kolm\.ai([^<]+)<\/loc>/g)) {
    const ref = normalizeInternalUrl(match[1]);
    if (ref) refs.add(ref);
  }

  return [...refs].sort();
}

test('static text assets have clean encoding and current brand tokens', () => {
  const files = walkFiles('public', file => TEXT_EXTENSIONS.has(path.extname(file)));
  const failures = [];

  for (const file of files) {
    const buf = fs.readFileSync(file);
    if (buf.length >= 3 && buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf) {
      failures.push(`${file}: UTF-8 BOM`);
      continue;
    }

    const text = buf.toString('utf8');
    if (text.includes('`r`n')) failures.push(`${file}: literal PowerShell newline escape`);
    for (let i = 0; i < text.length; i++) {
      const code = text.charCodeAt(i);
      if (code === 0xfffd || (code >= 0xe000 && code <= 0xf8ff)) {
        failures.push(`${file}: mojibake/private-use glyph at offset ${i}`);
        break;
      }
    }

    if (!file.includes(`${path.sep}_archive${path.sep}`)) {
      for (const pattern of LEGACY_BRAND_PATTERNS) {
        if (text.includes(pattern)) failures.push(`${file}: legacy brand token ${pattern}`);
      }
      for (const pattern of FORBIDDEN_PUBLIC_PATTERNS) {
        if (text.includes(pattern)) failures.push(`${file}: forbidden public pattern ${pattern}`);
      }
      if (file.endsWith('.html') && text.includes('href="/benchmarks"') && !text.includes('href="/compare"')) {
        failures.push(`${file}: benchmarks nav without compare nav`);
      }
    }
  }

  assert.deepEqual(failures, []);
});

test('signup wires API-key auth and OAuth surfaces', () => {
  const signup = fs.readFileSync(path.join('public', 'signup.html'), 'utf8');

  assert.match(signup, /\/v1\/signup/);
  assert.match(signup, /\/v1\/signin/);
  assert.match(signup, /kolm_api_key/);
  assert.match(signup, /recipeApiKey/);
  assert.match(signup, /Continue with Google/);
  assert.match(signup, /Continue with GitHub/);
  assert.match(signup, /\/v1\/oauth\//);
  assert.match(signup, /tryOAuth\(['"]google['"]\)/);
  assert.match(signup, /tryOAuth\(['"]github['"]\)/);
});

test('server and source text assets have clean encoding', () => {
  const sourceFiles = [
    'README.md',
    'server.js',
    '.env.example',
    'package.json',
    'cli/kolm.js',
    ...walkFiles(path.join('sdk', 'node'), file => TEXT_EXTENSIONS.has(path.extname(file))),
    ...walkFiles('docs', file => TEXT_EXTENSIONS.has(path.extname(file))),
    ...walkFiles('src', file => TEXT_EXTENSIONS.has(path.extname(file))),
    ...walkFiles('tests', file =>
      TEXT_EXTENSIONS.has(path.extname(file)) &&
      !file.endsWith(path.join('tests', 'site.test.js'))
    ),
  ];
  const failures = [];

  for (const file of sourceFiles) {
    const buf = fs.readFileSync(file);
    if (buf.length >= 3 && buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf) {
      failures.push(`${file}: UTF-8 BOM`);
      continue;
    }

    const text = buf.toString('utf8');
    for (let i = 0; i < text.length; i++) {
      const code = text.charCodeAt(i);
      if (code === 0xfffd || (code >= 0xe000 && code <= 0xf8ff)) {
        failures.push(`${file}: mojibake/private-use glyph at offset ${i}`);
        break;
      }
    }

    const scansPositioningCopy =
      file === 'README.md' ||
      file.startsWith('docs' + path.sep) ||
      file.startsWith(path.join('sdk', 'node') + path.sep);
    if (scansPositioningCopy) {
      for (const pattern of STALE_SOURCE_PATTERNS) {
        if (text.includes(pattern)) failures.push(`${file}: stale source pattern ${pattern}`);
      }
    }
  }

  assert.deepEqual(failures, []);
});

test('public inline scripts parse successfully', () => {
  const htmlFiles = walkFiles('public', file =>
    file.endsWith('.html') &&
    !file.includes(`${path.sep}_archive${path.sep}`)
  );
  const failures = [];

  for (const file of htmlFiles) {
    const html = fs.readFileSync(file, 'utf8');
    for (const match of html.matchAll(/<script([^>]*)>([\s\S]*?)<\/script>/gi)) {
      const attrs = match[1] || '';
      if (/\bsrc\s*=/.test(attrs)) continue;
      const type = (attrs.match(/\btype=["']([^"']+)/i) || [])[1] || '';
      if (type && !/javascript|module/i.test(type)) continue;
      if (/module/i.test(type)) continue;
      try {
        new Function(match[2]);
      } catch (error) {
        failures.push(`${file}: ${error.message}`);
      }
    }
  }

  assert.deepEqual(failures, []);
});

test('node SDK package presents the current kolm brand', () => {
  const pkg = JSON.parse(fs.readFileSync(path.join('sdk', 'node', 'package.json'), 'utf8'));
  const readme = fs.readFileSync(path.join('sdk', 'node', 'README.md'), 'utf8');
  const esm = fs.readFileSync(path.join('sdk', 'node', 'index.mjs'), 'utf8');
  const cjs = fs.readFileSync(path.join('sdk', 'node', 'index.cjs'), 'utf8');

  assert.equal(pkg.name, '@kolmogorov/kolm-sdk');
  assert.equal(pkg.homepage, 'https://kolm.ai');
  assert.equal(pkg.repository.url, 'git+https://github.com/sneaky-hippo/kolmogorov-stack.git');
  assert.match(readme, /KOLM_API_KEY/);
  assert.match(esm, /const DEFAULT_BASE = "https:\/\/kolm\.ai"/);
  assert.match(cjs, /const DEFAULT_BASE = "https:\/\/kolm\.ai"/);
});

test('public site routes, sitemap URLs, and referenced assets resolve', async (t) => {
  const port = await freePort();
  const base = `http://127.0.0.1:${port}`;
  const dataDir = path.join(os.tmpdir(), `kolm-site-${process.pid}-${Date.now()}`);

  fs.rmSync(dataDir, { recursive: true, force: true });
  fs.mkdirSync(dataDir, { recursive: true });
  t.after(() => fs.rmSync(dataDir, { recursive: true, force: true }));

  const child = spawn(process.execPath, ['server.js'], {
    env: {
      ...process.env,
      PORT: String(port),
      DEFAULT_TENANT: 'site-test',
      ANTHROPIC_API_KEY: '',
      KOLM_DATA_DIR: dataDir,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stdout.on('data', () => {});
  child.stderr.on('data', data => process.stderr.write(data));
  t.after(() => { try { child.kill(); } catch {} });

  await waitForHealth(base);

  const failures = [];
  for (const ref of [...collectInternalReferences(), '/ready']) {
    const res = await fetch(base + ref, { redirect: 'follow' });
    if (res.status >= 400) failures.push(`${ref}: ${res.status}`);
  }

  assert.deepEqual(failures, []);
});

test('sitemap includes indexable product/docs/article routes only', () => {
  const sitemap = fs.readFileSync(path.join('public', 'sitemap.xml'), 'utf8');
  const robots = fs.readFileSync(path.join('public', 'robots.txt'), 'utf8');
  const urls = [...sitemap.matchAll(/<loc>https:\/\/kolm\.ai([^<]+)<\/loc>/g)]
    .map(match => match[1])
    .sort();
  const urlSet = new Set(urls);

  const missing = REQUIRED_SITEMAP_ROUTES.filter(route => !urlSet.has(route));
  assert.deepEqual(missing, []);

  const disallowed = robots.split(/\r?\n/)
    .map(line => line.match(/^Disallow:\s*(\S+)/))
    .filter(Boolean)
    .map(match => match[1]);
  const blockedInSitemap = urls.filter(url =>
    disallowed.some(rule => rule !== '/' && (url === rule || url.startsWith(rule.endsWith('/') ? rule : rule + '/')))
  );

  assert.deepEqual(blockedInSitemap, []);
});
