import 'dotenv/config';
import express from 'express';
import compression from 'compression';
import helmet from 'helmet';
import cookieParser from 'cookie-parser';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildRouter } from './src/router.js';
import { provisionTenant } from './src/auth.js';
import { synthesize } from './src/synthesis.js';
import { createConcept, publishVersion } from './src/registry.js';
import { all } from './src/store.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const app = express();
app.disable('x-powered-by');

// Security headers (S3, S4) — mounted BEFORE express.static so static
// assets get HSTS, CSP, nosniff, etc. CSP allows 'unsafe-inline' for now
// because every page still has inline <script> blocks; Sprint 1 moves
// inline scripts to /js/<page>.js and tightens CSP. 'wasm-unsafe-eval' is
// required by the on-device runtime (wllama, sqlite-vec).
app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      scriptSrc: ["'self'", "'unsafe-inline'", "'wasm-unsafe-eval'"],
      styleSrc: ["'self'", "'unsafe-inline'"],
      imgSrc: ["'self'", 'data:', 'blob:'],
      fontSrc: ["'self'", 'data:'],
      connectSrc: ["'self'", 'https://api.anthropic.com'],
      workerSrc: ["'self'", 'blob:'],
      frameAncestors: ["'none'"],
      objectSrc: ["'none'"],
      baseUri: ["'self'"],
      formAction: ["'self'"],
    },
  },
  crossOriginEmbedderPolicy: false,  // breaks inline images otherwise
  crossOriginResourcePolicy: { policy: 'cross-origin' },  // /sdk.js is cross-origin by design
  strictTransportSecurity: { maxAge: 31536000, includeSubDomains: true },
  referrerPolicy: { policy: 'strict-origin-when-cross-origin' },
  frameguard: { action: 'deny' },
  noSniff: true,
}));

// gzip everything except SSE streams (compression breaks event delivery).
app.use(compression({ filter: (req, res) => res.getHeader('Content-Type') !== 'text/event-stream' && compression.filter(req, res) }));
app.use(cookieParser());
app.use(express.json({ limit: '4mb' }));
app.use(express.urlencoded({ extended: true }));

// Static dashboard with strong caching for hashed assets, weak for HTML.
// /sdk.js gets a versioned alias (S6) — the unversioned URL stays for
// back-compat but we encourage `/sdk-<sha>.js` for SRI-pinned imports.
app.use(express.static(path.join(__dirname, 'public'), {
  setHeaders: (res, filePath) => {
    if (filePath.endsWith('.html')) res.setHeader('Cache-Control', 'public, max-age=60, must-revalidate');
    else if (/sdk-[a-f0-9]{8,}\.js$/.test(filePath)) res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
    else if (filePath.match(/\.(css|js|svg|png|jpg|webp|wasm)$/)) res.setHeader('Cache-Control', 'public, max-age=300');
  },
}));

// RS-1 schema bundle — canonical JSON Schemas + spec markdown live in /docs
// so the homepage anchors (/docs#rs-1, #manifest, #receipts) and direct
// schema fetches both work. We mount the directory at /docs-static so the
// /docs SPA route below can still own the HTML page; specific filenames
// are then aliased back into /docs/* via explicit routes.
const DOCS_DIR = path.join(__dirname, 'docs');
for (const name of ['manifest-v0.1.json', 'receipt-v0.1.json', 'rs-1.md']) {
  app.get('/docs/' + name, (_req, res) => {
    const file = path.join(DOCS_DIR, name);
    if (!fs.existsSync(file)) return res.status(404).json({ error: 'spec asset not found' });
    if (name.endsWith('.json')) res.type('application/schema+json');
    else if (name.endsWith('.md')) res.type('text/markdown');
    res.set('Cache-Control', 'public, max-age=300');
    res.sendFile(file);
  });
}

app.use('/', buildRouter());

// SPA fallback for HTML routes — every public page maps to a static file under /public.
// /compile, /run, /recall, /cloud, /manual, /mobile are the v5 (`kolm`) surfaces.
// Legacy v4 pages (/optimize, /audit, /why, /how-it-works, /economics, /spec,
// /receipts, /verified, /specialists) stay reachable until Sprint 1's kill-list
// pass — the static files still live in public/.
for (const route of ['/', '/dashboard', '/playground', '/docs', '/registry', '/signup', '/why', '/pricing', '/status', '/specialists', '/onboarding', '/account', '/optimize', '/audit', '/spec', '/receipts', '/how-it-works', '/verified', '/economics', '/device', '/compile', '/run', '/recall', '/cloud', '/manual', '/mobile']) {
  app.get(route, (_req, res) => {
    const name = route === '/' ? 'index' : route.slice(1);
    const file = path.join(__dirname, 'public', name + '.html');
    if (fs.existsSync(file)) return res.sendFile(file);
    res.status(404).sendFile(path.join(__dirname, 'public', '404.html'));
  });
}

// 404 fallback for unknown HTML routes — branded page from /public/404.html if it exists.
const _404Path = path.join(__dirname, 'public', '404.html');
app.use((req, res, next) => {
  if (req.method === 'GET' && req.accepts('html') && !req.path.startsWith('/v1') && !req.path.startsWith('/health') && !req.path.startsWith('/pricing') && req.path !== '/404') {
    if (fs.existsSync(_404Path)) return res.status(404).sendFile(_404Path);
    return res.status(404).type('html').send(`<!DOCTYPE html><html><head><title>404 · kolm</title><link rel="stylesheet" href="/styles.css"></head><body style="padding:48px;text-align:center;font-family:system-ui;color:#e8ecf3;background:#0a0b0e;min-height:100vh;"><h1 style="font-size:48px;margin:0;letter-spacing:-0.02em;">404</h1><p style="color:#8b94a8;margin-top:8px">That page doesn't exist.</p><p style="margin-top:24px;"><a href="/" style="color:#7dd3fc;">&larr; Home</a> &middot; <a href="/registry" style="color:#7dd3fc;">Registry</a> &middot; <a href="/docs" style="color:#7dd3fc;">Docs</a></p></body></html>`);
  }
  next();
});

// Generic 500 — catches any unhandled error in routes.
app.use((err, req, res, _next) => {
  console.error('[500]', err);
  if (req.accepts('html')) {
    const _500Path = path.join(__dirname, 'public', '500.html');
    if (fs.existsSync(_500Path)) return res.status(500).sendFile(_500Path);
  }
  res.status(500).json({ error: 'internal server error', message: String(err.message || err) });
});

const PORT = parseInt(process.env.PORT || '8787');

async function bootSeedDemoConcepts(tenant) {
  const dir = path.resolve('examples');
  if (!fs.existsSync(dir)) return { added: 0, skipped: 0 };
  const files = fs.readdirSync(dir).filter(f => f.endsWith('.json'));
  const existing = new Set(all('concepts').filter(c => c.tenant === tenant).map(c => c.name));
  let added = 0, skipped = 0;
  for (const file of files) {
    try {
      const ex = JSON.parse(fs.readFileSync(path.join(dir, file), 'utf8'));
      if (existing.has(ex.name)) { skipped++; continue; }
      const r = await synthesize({ positives: ex.positives, negatives: ex.negatives || [], output_spec: ex.output_spec, priors: ex.priors || {} });
      if (!r.accepted) { skipped++; continue; }
      const concept = createConcept({
        name: ex.name, description: ex.description || ex.name, tenant,
        schema: ex.output_spec || null, tags: ex.tags || [], visibility: ex.visibility || 'public',
      });
      publishVersion({
        concept_id: concept.id, source: r.source,
        evaluation: { quality_score: r.quality_score, pass_rate_positive: r.pass_rate_positive, reject_rate_negative: r.reject_rate_negative, latency_p50_us: r.latency_p50_us, size_bytes: r.size_bytes, source_hash: r.source_hash, strategy: r.strategy, trace: r.test_trace },
        lineage: { synthesized_from_n: ex.positives.length + (ex.negatives?.length || 0), attempts_n: r.attempts_n },
      });
      added++;
    } catch { skipped++; }
  }
  return { added, skipped };
}

if (process.argv[1] && process.argv[1].endsWith('server.js')) {
  // Auto-provision the demo tenant.
  const demo = provisionTenant(process.env.DEFAULT_TENANT || 'demo');

  // Idempotent seed: synthesizes any missing example/*.json concepts.
  const { added, skipped } = await bootSeedDemoConcepts(demo.name);
  if (added > 0 || skipped > 0) console.log(`  · seed: +${added} added, ${skipped} skipped`);

  app.listen(PORT, () => {
    console.log(`\n╔══════════════════════════════════════════════════╗`);
    console.log(`║  KOLMOGOROV STACK · Synthesis · Registry · Edge  ║`);
    console.log(`╚══════════════════════════════════════════════════╝`);
    console.log(`  ➜ http://localhost:${PORT}`);
    console.log(`  ➜ Dashboard:  http://localhost:${PORT}/dashboard`);
    console.log(`  ➜ Playground: http://localhost:${PORT}/playground`);
    console.log(`  ➜ Docs:       http://localhost:${PORT}/docs`);
    console.log(`  ➜ Demo API key configured: ${!!demo.api_key}`);
    console.log(`  ➜ Admin key configured:    ${!!process.env.ADMIN_KEY}`);
    console.log(`  ➜ Synthesis backend: ${process.env.ANTHROPIC_API_KEY ? 'Claude (' + (process.env.ANTHROPIC_MODEL || 'claude-opus-4-7') + ') + Pattern' : 'Pattern (no API key set)'}`);
    console.log('');
  });
}

export { app };
export default app;
