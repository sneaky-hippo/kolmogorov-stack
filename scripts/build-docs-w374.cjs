#!/usr/bin/env node
// W374 — generate the /docs/* tree (12-pillar product mirror).
//
// Each page is a real, useful doc with a TechArticle JSON-LD, 5-anchor nav,
// canonical link, skip-link, brand anchor, code example, and 2+ cross-links.
//
// Pages produced (19 total):
//   /docs/quickstart                                        (hand-written)
//   /docs/connect/openai                                    (hand-written)
//   /docs/connect/anthropic /openrouter /gemini
//   /docs/privacy /lake /optimizer /datasets /training
//   /docs/distillation /evals /runtime /devices /storage
//   /docs/cloud-sync /team /enterprise /api
//
// Run: node scripts/build-docs-w374.cjs

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const DOCS = path.join(ROOT, 'public', 'docs');
const CONNECT = path.join(DOCS, 'connect');

if (!fs.existsSync(CONNECT)) fs.mkdirSync(CONNECT, { recursive: true });

const SHARED_HEAD = `<style>html,body{background:#08090c;color:#faf2e1}html{color-scheme:dark}</style>`;
const THEME_SCRIPT = `<script>(function(){try{var t=localStorage.getItem('kolm-theme');if(t==='light'){document.documentElement.setAttribute('data-theme','light');document.documentElement.style.background='#f7f4ec';document.documentElement.style.colorScheme='light';}}catch(e){}})();</script>`;

const SHARED_CSS = `
:root{--ink:#ece7dc;--ink-mute:#b5bdb1;--ink-faint:#737c73;--line:rgba(236,231,220,0.08);--bg:#0b0d10;--bg-elev:#101316;--accent:#10b981;--accent-soft:rgba(16,185,129,0.10);--mono:ui-monospace,SFMono-Regular,Menlo,Monaco,Consolas,monospace}
[data-theme=light]{--ink:#1f2429;--ink-mute:#4b5158;--ink-faint:#737c73;--line:rgba(0,0,0,0.08);--bg:#fdfcf8;--bg-elev:#ffffff;--accent:#059669;--accent-soft:rgba(5,150,105,0.10)}
*{box-sizing:border-box}
body{background:var(--bg);color:var(--ink);font:16px/1.6 -apple-system,Inter,system-ui,sans-serif;margin:0}
.skip-link{position:absolute;left:-9999px}
.skip-link:focus{position:static;background:var(--accent);color:#fff;padding:8px 14px}
.wrap{max-width:1080px;margin:0 auto;padding:0 24px}
header.site{padding:18px 0;border-bottom:1px solid var(--line)}
header.site .wrap{display:flex;justify-content:space-between;align-items:center}
header.site nav{display:flex;gap:18px;font-family:var(--mono);font-size:12px;flex-wrap:wrap}
header.site nav a{color:inherit;text-decoration:none}
header.site .logo{font-family:var(--mono);font-size:13px;color:inherit;text-decoration:none}
main{padding:48px 0 96px}
.crumbs{font-family:var(--mono);font-size:11.5px;letter-spacing:0.16em;text-transform:uppercase;color:var(--ink-faint);margin:0 0 18px}
.crumbs a{color:inherit;text-decoration:none;border-bottom:1px dashed var(--line)}
h1{font-size:42px;line-height:1.08;font-weight:500;letter-spacing:-0.02em;margin:0 0 18px;max-width:920px}
.lede{font-size:18px;line-height:1.55;color:var(--ink-mute);max-width:780px;margin:0 0 36px}
h2{font-size:24px;font-weight:500;letter-spacing:-0.018em;margin:48px 0 12px;max-width:780px;scroll-margin-top:80px}
h3{font-size:16px;font-weight:500;letter-spacing:-0.01em;margin:28px 0 8px;max-width:780px}
p{color:var(--ink-mute);font-size:15px;line-height:1.65;max-width:780px}
pre{background:#06080a;color:#e9eef3;border:1px solid var(--line);border-radius:10px;padding:16px 18px;overflow-x:auto;font:12.5px/1.55 var(--mono);margin:14px 0 18px}
pre code{background:none;border:none;padding:0;color:inherit;font:inherit}
code{font-family:var(--mono);font-size:13px;color:var(--ink);background:var(--bg-elev);padding:1px 6px;border-radius:4px;border:1px solid var(--line)}
ul,ol{color:var(--ink-mute);font-size:15px;line-height:1.7;max-width:780px}
li{margin:4px 0}
table{border-collapse:collapse;width:100%;max-width:840px;margin:14px 0;font-size:13.5px}
th,td{text-align:left;padding:8px 12px;border-bottom:1px solid var(--line);vertical-align:top}
th{color:var(--ink);font-weight:500}
td code{font-size:12px}
.related{display:grid;grid-template-columns:repeat(3,1fr);gap:14px;margin-top:18px}
@media(max-width:820px){.related{grid-template-columns:1fr}}
.related a{padding:16px 18px;border:1px solid var(--line);border-radius:10px;background:var(--bg-elev);text-decoration:none;color:inherit;display:flex;flex-direction:column;gap:4px}
.related a:hover{border-color:var(--accent-soft)}
.related b{font-size:14px;color:var(--ink);font-weight:500}
.related span{font-size:12.5px;color:var(--ink-mute);line-height:1.5}
footer{padding:32px 0;color:var(--ink-faint);font-family:var(--mono);font-size:11.5px;border-top:1px solid var(--line)}
footer a{color:inherit;text-decoration:none;border-bottom:1px dashed var(--line)}
`;

function renderPage(p) {
  // p = { slug, urlPath, ogSlug, title, description, lede, crumbs, body, relatedCards }
  const titleFull = `${p.title} &middot; kolm.ai`;
  const titlePlain = `${p.title} · kolm.ai`;
  const url = `https://kolm.ai${p.urlPath}`;
  const og = `https://kolm.ai/og/${p.ogSlug}.svg`;
  const ld = {
    "@context": "https://schema.org",
    "@type": "TechArticle",
    headline: p.title,
    description: p.description,
    url,
    datePublished: "2026-05-18",
    dateModified: "2026-05-18",
    author: { "@type": "Organization", name: "kolm.ai" },
    publisher: { "@type": "Organization", name: "kolm.ai" }
  };
  const crumbsHtml = p.crumbs.map((c, i) => i === p.crumbs.length - 1
    ? c.label
    : `<a href="${c.href}">${c.label}</a>`).join(' / ');
  const relatedHtml = (p.relatedCards || []).map(r =>
    `  <a href="${r.href}"><b>${r.title} &rarr;</b><span>${r.blurb}</span></a>`
  ).join('\n');

  return `<!DOCTYPE html>
<html lang="en" style="background:#08090c;color-scheme:dark">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
${THEME_SCRIPT}
${SHARED_HEAD}
<title>${titlePlain}</title>
<meta name="description" content="${p.description}">
<meta name="theme-color" content="#0b0d10" media="(prefers-color-scheme: dark)">
<meta name="theme-color" content="#f7f4ec" media="(prefers-color-scheme: light)">
<meta property="og:title" content="${titleFull}">
<meta property="og:description" content="${p.description}">
<meta property="og:type" content="article">
<meta property="og:url" content="${url}">
<meta property="og:image" content="${og}">
<meta name="twitter:card" content="summary_large_image">
<meta name="twitter:title" content="${titleFull}">
<meta name="twitter:description" content="${p.description}">
<meta name="twitter:image" content="${og}">
<link rel="canonical" href="${url}">
<link rel="icon" href="/favicon.svg" type="image/svg+xml">
<script type="application/ld+json">${JSON.stringify(ld)}</script>
<style>${SHARED_CSS}</style>
</head>
<body>
<a class="skip-link" href="#main">Skip to content</a>
<header class="site"><div class="wrap">
  <a class="logo" href="/">kolm.ai</a>
  <nav aria-label="Primary"><a href="/product">Product</a><a href="/models">Models</a><a href="/docs">Docs</a><a href="/pricing">Pricing</a><a href="/enterprise">Enterprise</a></nav>
</div></header>

<main id="main" tabindex="-1"><div class="wrap">

<div class="crumbs">${crumbsHtml}</div>
<h1>${p.title}</h1>
<p class="lede">${p.lede}</p>

${p.body}

<div class="related">
${relatedHtml}
</div>

</div></main>

<footer><div class="wrap">
  kolm.ai &middot; the AI compiler &middot; <a href="/articles/kolm-ai-vs-kolm-therapeutics">not the band, not the therapeutics company</a>
</div></footer>

</body>
</html>
`;
}

// 17 detector classes per the W374 spec.
const DETECTOR_CLASSES = [
  'email','phone','ssn','credit_card','iban','us_passport','dob','street_address',
  'mrn','npi','icd10','cpt','rxnorm','ip_v4','mac','jwt','api_key'
];

// 11 optimizer opportunity types per the W374 spec.
const OPP_TYPES = [
  'cache','cheaper_model','local_replacement','privacy_leak','prompt_compression',
  'repeated_extraction','repeated_classification','log_triage','routing_policy',
  'dataset_ready','training_ready'
];

// 8 bakeoff contestants per the W374 spec.
const BAKEOFF = [
  'cache','rule','prompt_only','gemma-3n-e2b','qwen-0.5b','phi-mini','claude-haiku-4-5','gpt-4o-mini'
];

const pages = [
  // ---------- connect/anthropic ----------
  {
    slug: 'connect/anthropic',
    urlPath: '/docs/connect/anthropic',
    ogSlug: 'docs-connect-anthropic',
    title: 'Connect Anthropic',
    description: 'Wire the Anthropic Messages SDK and raw fetch through the kolm.ai local proxy. Streaming, tool use, vision all preserved.',
    lede: 'The kolm.ai proxy serves the Anthropic <code>/v1/messages</code> surface on the same port as the OpenAI surface. Set <code>ANTHROPIC_BASE_URL</code>, leave the rest of your SDK alone, and every <code>messages.create</code> lands in the local lake before forwarding to api.anthropic.com.',
    crumbs: [
      { href: '/', label: 'kolm.ai' },
      { href: '/docs', label: 'docs' },
      { label: 'connect / anthropic' }
    ],
    body: `<h2 id="env">One env var</h2>
<p>The Anthropic SDK reads <code>ANTHROPIC_BASE_URL</code> (Python and TS) for the endpoint and <code>ANTHROPIC_API_KEY</code> for the upstream key. The proxy forwards the key unchanged.</p>
<pre><code>export ANTHROPIC_BASE_URL=http://127.0.0.1:8787
export ANTHROPIC_API_KEY=sk-ant-your-upstream-key
kolm connect start</code></pre>

<h2 id="sdk-py">Python SDK</h2>
<pre><code>from anthropic import Anthropic
client = Anthropic(base_url="http://127.0.0.1:8787")

msg = client.messages.create(
    model="claude-haiku-4-5",
    max_tokens=512,
    messages=[{"role": "user", "content": "Summarize this support ticket."}],
)
print(msg.content[0].text)</code></pre>

<h2 id="sdk-ts">TypeScript SDK</h2>
<pre><code>import Anthropic from "@anthropic-ai/sdk";
const client = new Anthropic({ baseURL: "http://127.0.0.1:8787" });

const msg = await client.messages.create({
  model: "claude-haiku-4-5",
  max_tokens: 512,
  messages: [{ role: "user", content: "Summarize this support ticket." }],
});
console.log(msg.content[0].text);</code></pre>

<h2 id="streaming">Streaming</h2>
<p>The proxy preserves Anthropic SSE frames exactly. <code>message_start</code>, <code>content_block_delta</code>, <code>message_delta</code>, <code>message_stop</code> all pass through. The assembled message is written to the lake on <code>message_stop</code>.</p>
<pre><code>const stream = client.messages.stream({
  model: "claude-haiku-4-5",
  max_tokens: 1024,
  messages: [{ role: "user", content: "Walk through this stack trace." }],
});
for await (const ev of stream) if (ev.type === "content_block_delta") process.stdout.write(ev.delta.text || "");</code></pre>

<h2 id="tools">Tool use</h2>
<p>Tool definitions, tool calls, and <code>tool_result</code> blocks are captured verbatim. Tool turns count as one event per turn so downstream cost and latency rollups stay accurate.</p>
<pre><code>const msg = await client.messages.create({
  model: "claude-haiku-4-5",
  max_tokens: 1024,
  tools: [{ name: "get_weather", input_schema: { type: "object" } }],
  messages: [{ role: "user", content: "What is the weather in Tokyo?" }],
});</code></pre>

<h2 id="fetch">Raw fetch</h2>
<pre><code>curl http://127.0.0.1:8787/v1/messages \\
  -H "x-api-key: $ANTHROPIC_API_KEY" \\
  -H "anthropic-version: 2023-06-01" \\
  -H "Content-Type: application/json" \\
  -d '{"model":"claude-haiku-4-5","max_tokens":256,"messages":[{"role":"user","content":"hi"}]}'</code></pre>

<h2 id="next">Next steps</h2>
<p>Captures are flowing. Read <a href="/docs/lake">the lake schema</a> to know what fields you can query and <a href="/docs/privacy">privacy</a> to wire the detectors before any traffic leaves your machine. Start from <a href="/docs/quickstart">/docs/quickstart</a> if you have not installed the CLI yet.</p>`,
    relatedCards: [
      { href: '/docs/connect/openai', title: 'OpenAI', blurb: 'Same proxy, OpenAI /v1 surface.' },
      { href: '/docs/connect/openrouter', title: 'OpenRouter', blurb: 'One key, 100+ models, OpenAI-compatible.' },
      { href: '/docs/connect/gemini', title: 'Gemini', blurb: 'Google AI Studio, OpenAI-compat endpoint.' },
    ],
  },

  // ---------- connect/openrouter ----------
  {
    slug: 'connect/openrouter',
    urlPath: '/docs/connect/openrouter',
    ogSlug: 'docs-connect-openrouter',
    title: 'Connect OpenRouter',
    description: 'Wire OpenRouter through the kolm.ai local proxy. One key, 100+ upstream models, OpenAI-compatible wire format. Streaming preserved.',
    lede: 'OpenRouter exposes 100+ frontier and open-weight models behind one OpenAI-compatible endpoint. Because the kolm.ai proxy speaks the OpenAI wire format, OpenRouter just works: set <code>OPENAI_BASE_URL</code> at the local proxy, set <code>OPENAI_API_KEY</code> to your OpenRouter key, and the proxy forwards to <code>openrouter.ai/api/v1</code> on your behalf.',
    crumbs: [
      { href: '/', label: 'kolm.ai' },
      { href: '/docs', label: 'docs' },
      { label: 'connect / openrouter' }
    ],
    body: `<h2 id="env">Setup</h2>
<p>OpenRouter requires a per-call <code>HTTP-Referer</code> and an optional <code>X-Title</code> for attribution. The proxy passes both through unmodified.</p>
<pre><code>export OPENAI_BASE_URL=http://127.0.0.1:8787/v1
export OPENAI_API_KEY=sk-or-v1-your-openrouter-key
export KOLM_FORWARD_TO=https://openrouter.ai/api/v1
kolm connect start --upstream openrouter</code></pre>

<h2 id="model-id">Model IDs</h2>
<p>OpenRouter model IDs are namespaced. The proxy does not rewrite them. Use the literal string from <a href="https://openrouter.ai/models">openrouter.ai/models</a>.</p>
<table>
<thead><tr><th>Upstream</th><th>OpenRouter model id</th></tr></thead>
<tbody>
<tr><td>OpenAI gpt-4o-mini</td><td><code>openai/gpt-4o-mini</code></td></tr>
<tr><td>Anthropic Claude Haiku 4.5</td><td><code>anthropic/claude-haiku-4-5</code></td></tr>
<tr><td>Google Gemini 2.5 Flash</td><td><code>google/gemini-2.5-flash</code></td></tr>
<tr><td>Meta Llama 3.3 70B</td><td><code>meta-llama/llama-3.3-70b-instruct</code></td></tr>
<tr><td>Qwen 3.5 32B</td><td><code>qwen/qwen-3.5-32b-instruct</code></td></tr>
</tbody>
</table>

<h2 id="sdk">OpenAI SDK</h2>
<pre><code>from openai import OpenAI
client = OpenAI(base_url="http://127.0.0.1:8787/v1")

r = client.chat.completions.create(
    model="anthropic/claude-haiku-4-5",
    extra_headers={"HTTP-Referer": "https://your.app", "X-Title": "your-app"},
    messages=[{"role": "user", "content": "Compare cosmic ray flux at LEO vs GEO."}],
)
print(r.choices[0].message.content)</code></pre>

<h2 id="routing">Routing across providers</h2>
<p>OpenRouter lets you fall back across providers per-call. The proxy captures the <em>final</em> resolved provider in the <code>upstream_provider</code> lake field so you can attribute cost correctly.</p>
<pre><code>r = client.chat.completions.create(
    model="qwen/qwen-3.5-32b-instruct",
    extra_body={"route": "fallback", "models": ["qwen/qwen-3.5-32b-instruct", "meta-llama/llama-3.3-70b-instruct"]},
    messages=[{"role": "user", "content": "List five MMU TLB miss causes."}],
)</code></pre>

<h2 id="cost">Cost tracking</h2>
<p>OpenRouter returns per-call cost in the <code>x-ratelimit-cost</code> response header. The proxy reads it and writes to the <code>cost_usd</code> lake field. <code>kolm lake stats --by upstream_provider</code> shows the per-provider spend roll-up.</p>
<pre><code>kolm lake stats --window 24h --by upstream_provider</code></pre>

<h2 id="next">Next steps</h2>
<p>Read <a href="/docs/lake">the lake schema</a> for the full 35-field row and <a href="/docs/optimizer">optimizer</a> for what to do with the data. Start from <a href="/docs/quickstart">/docs/quickstart</a> if you have not installed the CLI yet.</p>`,
    relatedCards: [
      { href: '/docs/connect/openai', title: 'OpenAI', blurb: 'Same proxy, native OpenAI /v1 surface.' },
      { href: '/docs/connect/anthropic', title: 'Anthropic', blurb: 'Same proxy, /v1/messages surface.' },
      { href: '/docs/connect/gemini', title: 'Gemini', blurb: 'Google AI Studio OpenAI-compat endpoint.' },
    ],
  },

  // ---------- connect/gemini ----------
  {
    slug: 'connect/gemini',
    urlPath: '/docs/connect/gemini',
    ogSlug: 'docs-connect-gemini',
    title: 'Connect Gemini',
    description: 'Wire Google AI Studio (Gemini) through the kolm.ai local proxy. Use the OpenAI-compatible Gemini endpoint, captures land in your local lake.',
    lede: 'Google AI Studio ships an OpenAI-compatible surface at <code>generativelanguage.googleapis.com/v1beta/openai</code>. Point the kolm.ai proxy at it, point your OpenAI SDK at the proxy, and Gemini calls land in your local lake just like any other provider.',
    crumbs: [
      { href: '/', label: 'kolm.ai' },
      { href: '/docs', label: 'docs' },
      { label: 'connect / gemini' }
    ],
    body: `<h2 id="env">Setup</h2>
<p>Set the proxy upstream to the Gemini OpenAI-compat URL. The API key is your AI Studio key, forwarded unchanged.</p>
<pre><code>export OPENAI_BASE_URL=http://127.0.0.1:8787/v1
export OPENAI_API_KEY=AIza-your-gemini-key
export KOLM_FORWARD_TO=https://generativelanguage.googleapis.com/v1beta/openai
kolm connect start --upstream gemini</code></pre>

<h2 id="model-id">Model IDs</h2>
<p>Use the same model ids you would send to AI Studio directly.</p>
<table>
<thead><tr><th>Model</th><th>Model id</th></tr></thead>
<tbody>
<tr><td>Gemini 2.5 Flash</td><td><code>gemini-2.5-flash</code></td></tr>
<tr><td>Gemini 2.5 Pro</td><td><code>gemini-2.5-pro</code></td></tr>
<tr><td>Gemini 3.0 Flash</td><td><code>gemini-3.0-flash</code></td></tr>
<tr><td>Gemini 3.0 Pro</td><td><code>gemini-3.0-pro</code></td></tr>
</tbody>
</table>

<h2 id="sdk-py">Python SDK</h2>
<pre><code>from openai import OpenAI
client = OpenAI(base_url="http://127.0.0.1:8787/v1")

r = client.chat.completions.create(
    model="gemini-2.5-flash",
    messages=[{"role": "user", "content": "Three SQL window function gotchas."}],
)
print(r.choices[0].message.content)</code></pre>

<h2 id="sdk-ts">TypeScript SDK</h2>
<pre><code>import OpenAI from "openai";
const client = new OpenAI({ baseURL: "http://127.0.0.1:8787/v1" });
const r = await client.chat.completions.create({
  model: "gemini-3.0-flash",
  messages: [{ role: "user", content: "Two ways to detect memory leaks in Go." }],
});
console.log(r.choices[0].message.content);</code></pre>

<h2 id="vision">Vision and multimodal</h2>
<p>The OpenAI-compat Gemini endpoint accepts the same <code>image_url</code> content blocks the OpenAI SDK uses. Base64 data URLs work. The captured row carries <code>modality=multimodal</code> on the event.</p>
<pre><code>r = client.chat.completions.create(
    model="gemini-2.5-flash",
    messages=[{
        "role": "user",
        "content": [
            {"type": "text", "text": "What is in this image?"},
            {"type": "image_url", "image_url": {"url": "data:image/png;base64,iVBORw0..."}}
        ],
    }],
)</code></pre>

<h2 id="streaming">Streaming</h2>
<p>The proxy forwards SSE chunks unchanged. Latency to first token is measured on the upstream side, written to the <code>ttft_ms</code> lake field.</p>
<pre><code>const stream = await client.chat.completions.create({
  model: "gemini-3.0-flash",
  stream: true,
  messages: [{ role: "user", content: "Stream a definition of CAP theorem." }],
});
for await (const c of stream) process.stdout.write(c.choices[0]?.delta?.content || "");</code></pre>

<h2 id="next">Next steps</h2>
<p>See <a href="/docs/lake">the lake schema</a> for the row shape and <a href="/docs/optimizer">the optimizer</a> to learn what to do with Gemini-heavy traffic. Start from <a href="/docs/quickstart">/docs/quickstart</a> if you have not installed the CLI yet.</p>`,
    relatedCards: [
      { href: '/docs/connect/openai', title: 'OpenAI', blurb: 'Native /v1 surface, no upstream override needed.' },
      { href: '/docs/connect/anthropic', title: 'Anthropic', blurb: '/v1/messages surface, tool use preserved.' },
      { href: '/docs/connect/openrouter', title: 'OpenRouter', blurb: 'One key, 100+ models, fallback routing.' },
    ],
  },

  // ---------- privacy ----------
  {
    slug: 'privacy',
    urlPath: '/docs/privacy',
    ogSlug: 'docs-privacy',
    title: 'Privacy',
    description: 'kolm.ai detects 17 PHI/PII/secret classes inline, replaces them with VAR_ placeholders, and enforces allow/redact/block/override policies before traffic leaves your laptop.',
    lede: 'Every prompt and response that goes through the proxy is scanned by 17 detector classes before it is written to the lake. You set the per-class policy in <code>~/.kolm/runtime/policy.json</code>. Detected spans are replaced with <code>VAR_*</code> placeholders, blocked classes 4xx the request, and the full audit trail is appended to <code>~/.kolm/runtime/audit.log</code>.',
    crumbs: [
      { href: '/', label: 'kolm.ai' },
      { href: '/docs', label: 'docs' },
      { label: 'privacy' }
    ],
    body: `<h2 id="classes">The 17 detector classes</h2>
<p>Each detector returns 0..N spans per text body with a confidence score and a class id. The class id is what the policy engine matches on.</p>
<table>
<thead><tr><th>Class</th><th>What it catches</th><th>VAR_ placeholder</th></tr></thead>
<tbody>
<tr><td><code>email</code></td><td>RFC 5321 addresses</td><td><code>VAR_EMAIL_n</code></td></tr>
<tr><td><code>phone</code></td><td>E.164 and common US/EU/JP formats</td><td><code>VAR_PHONE_n</code></td></tr>
<tr><td><code>ssn</code></td><td>US Social Security Numbers</td><td><code>VAR_SSN_n</code></td></tr>
<tr><td><code>credit_card</code></td><td>PAN, Luhn-validated</td><td><code>VAR_CC_n</code></td></tr>
<tr><td><code>iban</code></td><td>International Bank Account Numbers</td><td><code>VAR_IBAN_n</code></td></tr>
<tr><td><code>us_passport</code></td><td>US passport numbers</td><td><code>VAR_PASSPORT_n</code></td></tr>
<tr><td><code>dob</code></td><td>Date of birth, multiple locales</td><td><code>VAR_DOB_n</code></td></tr>
<tr><td><code>street_address</code></td><td>US/EU postal addresses</td><td><code>VAR_ADDR_n</code></td></tr>
<tr><td><code>mrn</code></td><td>Medical Record Number</td><td><code>VAR_MRN_n</code></td></tr>
<tr><td><code>npi</code></td><td>National Provider Identifier</td><td><code>VAR_NPI_n</code></td></tr>
<tr><td><code>icd10</code></td><td>ICD-10-CM diagnosis codes</td><td><code>VAR_ICD10_n</code></td></tr>
<tr><td><code>cpt</code></td><td>CPT procedure codes</td><td><code>VAR_CPT_n</code></td></tr>
<tr><td><code>rxnorm</code></td><td>RxNorm drug ids</td><td><code>VAR_RXNORM_n</code></td></tr>
<tr><td><code>ip_v4</code></td><td>IPv4 addresses</td><td><code>VAR_IP_n</code></td></tr>
<tr><td><code>mac</code></td><td>MAC addresses</td><td><code>VAR_MAC_n</code></td></tr>
<tr><td><code>jwt</code></td><td>JWT bearer tokens</td><td><code>VAR_JWT_n</code></td></tr>
<tr><td><code>api_key</code></td><td>OpenAI sk-*, Anthropic sk-ant-*, AWS AKIA*, Google AIza*, generic high-entropy</td><td><code>VAR_KEY_n</code></td></tr>
</tbody>
</table>

<h2 id="actions">Policy actions</h2>
<p>Each class is configured with one of four actions. The action runs <em>before</em> the request leaves the proxy and <em>before</em> the response is returned to the client.</p>
<ul>
<li><code>allow</code> - pass through unchanged. The span is still logged but the original text reaches the upstream.</li>
<li><code>redact</code> - replace each detected span with a deterministic <code>VAR_*</code> placeholder. The mapping is kept in the local lake row, never sent upstream.</li>
<li><code>block</code> - 451 the request with a structured error body. Nothing is forwarded.</li>
<li><code>override</code> - log only. Use this when you have explicit user consent for the class on this namespace.</li>
</ul>

<h2 id="policy-json">policy.json schema</h2>
<p>The policy file lives at <code>~/.kolm/runtime/policy.json</code> and is hot-reloaded on every request. Per-namespace overrides take precedence over the default.</p>
<pre><code>{
  "version": 1,
  "default": {
    "ssn": "block",
    "credit_card": "block",
    "api_key": "block",
    "jwt": "redact",
    "email": "redact",
    "phone": "redact",
    "mrn": "redact",
    "npi": "redact",
    "icd10": "allow",
    "cpt": "allow",
    "ip_v4": "allow"
  },
  "namespaces": {
    "billing": {
      "credit_card": "redact",
      "iban": "redact"
    },
    "support": {
      "email": "redact",
      "phone": "redact"
    }
  }
}</code></pre>

<h2 id="audit-log">Audit log</h2>
<p>Every detection, every action, every override is appended to <code>~/.kolm/runtime/audit.log</code> as one JSON line. Rotates daily, never overwritten. <code>kolm privacy audit</code> tails it with structured filters.</p>
<pre><code>kolm privacy audit --window 24h --class ssn
# 2026-05-18T09:14:21Z  ns=billing  class=ssn  action=block  count=1
# 2026-05-18T09:18:02Z  ns=support  class=ssn  action=redact count=2</code></pre>

<h2 id="dry-run">Dry-run a policy</h2>
<p>Before you flip an <code>allow</code> to a <code>block</code>, see what would have been blocked in the last 24 hours.</p>
<pre><code>kolm privacy dry-run --window 24h --policy ~/.kolm/runtime/policy.proposed.json</code></pre>

<h2 id="next">Next steps</h2>
<p>Once detectors are wired you can safely run <a href="/docs/cloud-sync">cloud sync</a> and <a href="/docs/distillation">distillation</a>. Start from <a href="/docs/quickstart">/docs/quickstart</a> if the proxy is not running yet.</p>`,
    relatedCards: [
      { href: '/docs/lake', title: 'Lake', blurb: 'How redacted spans get stored alongside the raw row.' },
      { href: '/docs/cloud-sync', title: 'Cloud sync', blurb: 'Per-class gating before any bytes leave the laptop.' },
      { href: '/docs/optimizer', title: 'Optimizer', blurb: 'Privacy leaks are one of the 11 opportunity types.' },
    ],
  },

  // ---------- lake ----------
  {
    slug: 'lake',
    urlPath: '/docs/lake',
    ogSlug: 'docs-lake',
    title: 'Lake',
    description: 'The canonical 35-field event schema and the local SQLite layout backing it. Query directly with kolm lake or with sqlite3 against ~/.kolm/events/events.sqlite.',
    lede: 'Everything that goes through the kolm.ai proxy lands in a local event lake. One row per request, 35 fields, indexed for time-range, namespace, and model queries. The lake is plain SQLite at <code>~/.kolm/events/events.sqlite</code> and is the single source of truth for cost, latency, drift, and dataset building.',
    crumbs: [
      { href: '/', label: 'kolm.ai' },
      { href: '/docs', label: 'docs' },
      { label: 'lake' }
    ],
    body: `<h2 id="layout">Storage layout</h2>
<p>Per-tenant, per-machine. The SQLite file uses WAL mode and is safe for concurrent readers + one writer (the proxy).</p>
<pre><code>~/.kolm/
  events/
    events.sqlite       # main row store
    events.sqlite-wal   # write-ahead log
    events.sqlite-shm   # shared memory index
  runtime/
    policy.json
    audit.log
  artifacts/            # compiled .kolm files
  datasets/             # train/val/holdout exports</code></pre>

<h2 id="schema">The 35-field event row</h2>
<table>
<thead><tr><th>Column</th><th>Type</th><th>Meaning</th></tr></thead>
<tbody>
<tr><td><code>id</code></td><td>TEXT PK</td><td>ULID, monotonic</td></tr>
<tr><td><code>ts_ms</code></td><td>INTEGER</td><td>Unix ms at proxy receive</td></tr>
<tr><td><code>namespace</code></td><td>TEXT</td><td>Tag from <code>x-kolm-namespace</code> header</td></tr>
<tr><td><code>tenant_id</code></td><td>TEXT</td><td>Local tenant (single-tenant by default)</td></tr>
<tr><td><code>upstream_provider</code></td><td>TEXT</td><td>openai, anthropic, gemini, openrouter, local</td></tr>
<tr><td><code>upstream_model</code></td><td>TEXT</td><td>Final resolved model id</td></tr>
<tr><td><code>requested_model</code></td><td>TEXT</td><td>Model the caller asked for</td></tr>
<tr><td><code>surface</code></td><td>TEXT</td><td>chat, messages, embeddings, completions</td></tr>
<tr><td><code>modality</code></td><td>TEXT</td><td>text, multimodal, audio, tool</td></tr>
<tr><td><code>messages_json</code></td><td>BLOB</td><td>Full request body (after redaction)</td></tr>
<tr><td><code>response_json</code></td><td>BLOB</td><td>Full upstream response (after redaction)</td></tr>
<tr><td><code>messages_raw_json</code></td><td>BLOB</td><td>Pre-redaction body, gated by privacy mode</td></tr>
<tr><td><code>response_raw_json</code></td><td>BLOB</td><td>Pre-redaction response, gated by privacy mode</td></tr>
<tr><td><code>template_hash</code></td><td>TEXT</td><td>Structural hash for clustering</td></tr>
<tr><td><code>prompt_sha</code></td><td>TEXT</td><td>sha256 of canonical prompt</td></tr>
<tr><td><code>response_sha</code></td><td>TEXT</td><td>sha256 of canonical response</td></tr>
<tr><td><code>in_tokens</code></td><td>INTEGER</td><td>Reported input tokens</td></tr>
<tr><td><code>out_tokens</code></td><td>INTEGER</td><td>Reported output tokens</td></tr>
<tr><td><code>cached_tokens</code></td><td>INTEGER</td><td>Provider-reported cache hits</td></tr>
<tr><td><code>cost_usd</code></td><td>REAL</td><td>Per-call USD spend</td></tr>
<tr><td><code>cost_source</code></td><td>TEXT</td><td>header, table, estimate</td></tr>
<tr><td><code>latency_ms</code></td><td>INTEGER</td><td>End-to-end at the proxy</td></tr>
<tr><td><code>ttft_ms</code></td><td>INTEGER</td><td>Time-to-first-token, streaming only</td></tr>
<tr><td><code>status</code></td><td>INTEGER</td><td>HTTP status returned to client</td></tr>
<tr><td><code>error_class</code></td><td>TEXT</td><td>upstream_timeout, upstream_4xx, etc</td></tr>
<tr><td><code>finish_reason</code></td><td>TEXT</td><td>stop, length, tool_calls</td></tr>
<tr><td><code>tools_json</code></td><td>BLOB</td><td>Tool definitions if any</td></tr>
<tr><td><code>tool_calls_json</code></td><td>BLOB</td><td>Tool invocations if any</td></tr>
<tr><td><code>privacy_actions_json</code></td><td>BLOB</td><td>Per-class actions taken</td></tr>
<tr><td><code>privacy_classes</code></td><td>TEXT</td><td>Comma list of detected classes</td></tr>
<tr><td><code>privacy_var_map</code></td><td>BLOB</td><td>VAR_* to original mapping, local-only</td></tr>
<tr><td><code>client_ip</code></td><td>TEXT</td><td>Caller IP (loopback by default)</td></tr>
<tr><td><code>client_user_agent</code></td><td>TEXT</td><td>SDK + version</td></tr>
<tr><td><code>request_id</code></td><td>TEXT</td><td>Upstream request id for tracing</td></tr>
<tr><td><code>artifact_id</code></td><td>TEXT</td><td>Set when served by a local .kolm</td></tr>
</tbody>
</table>

<h2 id="query">Querying</h2>
<p>The CLI wraps the most common rollups. For anything else, talk to SQLite directly.</p>
<pre><code>kolm lake stats --window 24h --by namespace
kolm lake stats --window 7d --by upstream_model
kolm lake list --namespace summarizer --limit 10 --json
sqlite3 ~/.kolm/events/events.sqlite "SELECT upstream_model, AVG(latency_ms) FROM events WHERE ts_ms > strftime('%s','now','-1 day')*1000 GROUP BY 1;"</code></pre>

<h2 id="retention">Retention</h2>
<p>By default the lake keeps everything forever. Set <code>retention_days</code> in <code>~/.kolm/config.json</code> to vacuum older rows on proxy start.</p>
<pre><code>{
  "retention_days": 90,
  "retention_keep_artifact_rows": true
}</code></pre>

<h2 id="next">Next steps</h2>
<p>Read <a href="/docs/optimizer">optimizer</a> to see what kolm.ai does with the lake automatically, <a href="/docs/datasets">datasets</a> to turn rows into training data, and <a href="/docs/storage">storage</a> for the local-first guarantees. Start from <a href="/docs/quickstart">/docs/quickstart</a> if you have not yet captured any traffic.</p>`,
    relatedCards: [
      { href: '/docs/optimizer', title: 'Optimizer', blurb: 'The 11 opportunity types kolm.ai finds in your lake.' },
      { href: '/docs/datasets', title: 'Datasets', blurb: 'Split the lake into train/val/holdout disjointly.' },
      { href: '/docs/storage', title: 'Storage', blurb: 'Which modes keep raw rows local vs sync to cloud.' },
    ],
  },

  // ---------- optimizer ----------
  {
    slug: 'optimizer',
    urlPath: '/docs/optimizer',
    ogSlug: 'docs-optimizer',
    title: 'Optimizer',
    description: 'kolm.ai reads your local lake and surfaces 11 opportunity types ranked by expected dollar savings. Cache, cheaper-model, local-replacement, log-triage, routing-policy, and six more.',
    lede: 'The optimizer is a read-only scanner over the event lake. It runs on demand or on a schedule, scores every detected pattern by expected dollar savings, and emits a ranked list of opportunities. You pick which ones to act on. The optimizer never modifies traffic on its own.',
    crumbs: [
      { href: '/', label: 'kolm.ai' },
      { href: '/docs', label: 'docs' },
      { label: 'optimizer' }
    ],
    body: `<h2 id="run">Run it</h2>
<pre><code>kolm optimize --window 7d
# scanning 18,442 events ... 11 detectors ... 7 opportunities found
# total addressable savings: $312.40 / month
#
# 1. [local_replacement]  classifier on gpt-4o-mini, 4,200 calls/day  -> $186/mo
# 2. [cache]              81% duplicate prompts in /summarize        -> $58/mo
# 3. [cheaper_model]      gpt-4o on simple_translate                 -> $41/mo
# ...</code></pre>

<h2 id="types">The 11 opportunity types</h2>
<p>Each detector looks for a specific cost or quality regression in the lake. Each finds a pattern that has a concrete remediation.</p>
<table>
<thead><tr><th>Type</th><th>Pattern</th><th>Remediation</th></tr></thead>
<tbody>
<tr><td><code>cache</code></td><td>Identical prompt seen N+ times in the window with identical response</td><td>Turn on the proxy response cache for that template hash</td></tr>
<tr><td><code>cheaper_model</code></td><td>Calls where a cheaper model would have scored within tolerance on the bakeoff</td><td>Swap the upstream model id; gate behind a holdout</td></tr>
<tr><td><code>local_replacement</code></td><td>Repetitive narrow task with stable structure</td><td>Distill into a local .kolm artifact, serve via runtime</td></tr>
<tr><td><code>privacy_leak</code></td><td>Calls where a detector class fired but the policy was set to <code>allow</code></td><td>Flip the per-class action to <code>redact</code> or <code>block</code></td></tr>
<tr><td><code>prompt_compression</code></td><td>Verbose system prompts that compress losslessly</td><td>Replace with a shorter equivalent; verify on holdout</td></tr>
<tr><td><code>repeated_extraction</code></td><td>Same JSON-schema extraction over and over on similar inputs</td><td>Compile to an extractor artifact</td></tr>
<tr><td><code>repeated_classification</code></td><td>Single-label outputs from a finite class set</td><td>Compile to a classifier artifact</td></tr>
<tr><td><code>log_triage</code></td><td>Unstructured logs being summarized one at a time</td><td>Batch through a triage artifact</td></tr>
<tr><td><code>routing_policy</code></td><td>Calls that crossed providers but did not need to</td><td>Pin the cheaper provider, gate with a fallback policy</td></tr>
<tr><td><code>dataset_ready</code></td><td>Namespace has crossed the per-task minimum row count</td><td>Build a labelled dataset</td></tr>
<tr><td><code>training_ready</code></td><td>Dataset is split, labelled, and within budget for a training run</td><td>Kick off the training plan</td></tr>
</tbody>
</table>

<h2 id="json">JSON output</h2>
<p>For piping into your own dashboard, ticket system, or CI gate.</p>
<pre><code>kolm optimize --window 30d --json | jq '.[0]'
# {
#   "type": "local_replacement",
#   "namespace": "ticket-classifier",
#   "evidence_event_count": 12640,
#   "addressable_spend_usd": 186.42,
#   "confidence": 0.91,
#   "remediation": {
#     "command": "kolm distill ticket-classifier --kind classifier",
#     "estimated_run_minutes": 22
#   }
# }</code></pre>

<h2 id="schedule">Schedule</h2>
<p>The recommended cadence is daily. Wire it into your scheduler of choice and pipe high-confidence findings to a channel.</p>
<pre><code>0 9 * * * kolm optimize --window 24h --json --min-confidence 0.8 | tee /var/log/kolm/optimizer.json</code></pre>

<h2 id="thresholds">Thresholds</h2>
<p>Tune the per-type minimums in <code>~/.kolm/config.json</code> so you do not get noise on a small lake.</p>
<pre><code>{
  "optimizer": {
    "cache_min_repeats": 5,
    "local_replacement_min_events": 500,
    "dataset_ready_min_rows": 1000
  }
}</code></pre>

<h2 id="next">Next steps</h2>
<p>The most common follow-on is <a href="/docs/distillation">distillation</a> for <code>local_replacement</code>, or <a href="/docs/runtime">runtime</a> to set up routing for <code>routing_policy</code>. Start from <a href="/docs/quickstart">/docs/quickstart</a> if your lake is still empty.</p>`,
    relatedCards: [
      { href: '/docs/lake', title: 'Lake', blurb: 'The 35-field event row the optimizer scans.' },
      { href: '/docs/distillation', title: 'Distillation', blurb: 'Act on local_replacement findings.' },
      { href: '/docs/datasets', title: 'Datasets', blurb: 'Act on dataset_ready findings.' },
    ],
  },

  // ---------- datasets ----------
  {
    slug: 'datasets',
    urlPath: '/docs/datasets',
    ogSlug: 'docs-datasets',
    title: 'Datasets',
    description: 'The kolm.ai dataset workbench. Build train/val/holdout splits with sha256-mod disjointness, label rows in a queue, freeze a dataset for reproducible training.',
    lede: 'A dataset in kolm.ai is a deterministic, frozen view over the event lake. You pick a namespace, you pick a window, you split by <code>sha256_mod</code> for guaranteed disjointness, you label what needs labelling, and you freeze. Every training and eval run pins to a dataset id so results are reproducible months later.',
    crumbs: [
      { href: '/', label: 'kolm.ai' },
      { href: '/docs', label: 'docs' },
      { label: 'datasets' }
    ],
    body: `<h2 id="build">Build a dataset</h2>
<p>One command. The workbench reads the lake, applies the selector, splits, and writes the manifest to <code>~/.kolm/datasets/&lt;id&gt;/</code>.</p>
<pre><code>kolm datasets build summarizer-v1 \\
  --namespace summarizer \\
  --window 30d \\
  --split 0.80/0.10/0.10 \\
  --min-rows 1000</code></pre>

<h2 id="split">Splits with sha256-mod disjointness</h2>
<p>The split function is <code>int(sha256(prompt_canonical), 16) % 100</code>. Train is buckets 0..79, val is 80..89, holdout is 90..99. Any future call with the same canonical prompt always falls into the same bucket, so a row cannot accidentally move from val to train when you rebuild.</p>
<pre><code># A prompt with sha256-mod = 87 always lands in val
# A prompt with sha256-mod = 92 always lands in holdout
# Re-running the build the next day cannot move it.</code></pre>

<h2 id="label-queue">Label queue</h2>
<p>For tasks that need human labels, the workbench surfaces unlabelled rows in priority order (high uncertainty first, then frequency). Labels are stored alongside the row in <code>~/.kolm/datasets/&lt;id&gt;/labels.sqlite</code>.</p>
<pre><code>kolm datasets label summarizer-v1 --kind classification --classes urgent,normal,low
# 12 rows pending. press y/n/s/q.
# [1/12] "Production is down, customers..." -> u
# [2/12] "Quick question about billing..." -> n</code></pre>

<h2 id="freeze">Freeze</h2>
<p>Freezing computes a sha256 over the row ids + labels + split assignments and stamps a manifest. Any training run that pins this id is reproducible bit-for-bit.</p>
<pre><code>kolm datasets freeze summarizer-v1
# frozen as ds_018e... sha256=8f3a... rows=4204 train=3363 val=420 holdout=421</code></pre>

<h2 id="export">Export</h2>
<p>For external tooling. Emits JSONL with one example per line, one file per split.</p>
<pre><code>kolm datasets export summarizer-v1 --out ./out
# ./out/train.jsonl  (3363 rows)
# ./out/val.jsonl    (420 rows)
# ./out/holdout.jsonl(421 rows)
# ./out/manifest.json</code></pre>

<h2 id="stats">Stats</h2>
<pre><code>kolm datasets stats summarizer-v1
# rows:              4204
# label coverage:    98.4%
# class balance:     urgent=18% normal=64% low=18%
# avg prompt tokens: 412
# avg response tok:  88</code></pre>

<h2 id="next">Next steps</h2>
<p>Hand the frozen dataset id to <a href="/docs/training">training</a> or <a href="/docs/distillation">distillation</a>. Run <a href="/docs/evals">evals</a> against the holdout once you have an artifact. Start from <a href="/docs/quickstart">/docs/quickstart</a> if the lake is still empty.</p>`,
    relatedCards: [
      { href: '/docs/training', title: 'Training', blurb: 'Feed a frozen dataset into a training run.' },
      { href: '/docs/evals', title: 'Evals', blurb: 'Score artifacts against the holdout split.' },
      { href: '/docs/lake', title: 'Lake', blurb: 'The source rows behind every dataset.' },
    ],
  },

  // ---------- training ----------
  {
    slug: 'training',
    urlPath: '/docs/training',
    ogSlug: 'docs-training',
    title: 'Training',
    description: 'kolm.ai auto-detects the task (redaction, classification, extraction, generation), picks a path profile, picks a backbone, and prints a training plan you can approve.',
    lede: 'Training in kolm.ai is plan-first. You hand the planner a frozen dataset, the planner detects the task kind from row shape, picks a path profile, picks a backbone, prints the GPU-minute budget and the expected score, and waits for your approval. Then it runs.',
    crumbs: [
      { href: '/', label: 'kolm.ai' },
      { href: '/docs', label: 'docs' },
      { label: 'training' }
    ],
    body: `<h2 id="plan">The plan command</h2>
<pre><code>kolm training plan ds_018e...
# task detected:   classification (3 classes, balanced)
# path profile:    distill-small
# backbone:        qwen-0.5b-instruct
# budget:          22 GPU-min on a single 3090
# expected k:      0.94 +/- 0.02 on holdout
# expected cost:   $0.31 amortized over 10k inferences
# ---
# approve with: kolm training run ds_018e... --plan plan_018f...</code></pre>

<h2 id="task-detection">Task detection</h2>
<p>The planner inspects the dataset rows to pick a task kind.</p>
<table>
<thead><tr><th>Task</th><th>Detected from</th></tr></thead>
<tbody>
<tr><td><code>redaction</code></td><td>VAR_* placeholders dominate the response; response is a redacted echo of input</td></tr>
<tr><td><code>classification</code></td><td>Finite output set, &le; 100 distinct labels, short responses</td></tr>
<tr><td><code>extraction</code></td><td>JSON responses conforming to a stable schema</td></tr>
<tr><td><code>generation</code></td><td>Free-form responses, variable length, no detectable schema</td></tr>
</tbody>
</table>

<h2 id="profiles">Path profiles</h2>
<p>A path profile bundles the recipe pipeline: data prep, augmentation, training loop, eval gate, export format. Profiles are matched to task kind + hardware tier.</p>
<table>
<thead><tr><th>Profile</th><th>Use when</th><th>Output</th></tr></thead>
<tbody>
<tr><td><code>recipe-only</code></td><td>&lt; 1000 rows, narrow task</td><td>Rule + prompt template, no weights</td></tr>
<tr><td><code>distill-small</code></td><td>1k-10k rows, classification or extraction</td><td>LoRA on small backbone, &lt; 1 GB</td></tr>
<tr><td><code>distill-medium</code></td><td>10k-100k rows, generation</td><td>LoRA on medium backbone</td></tr>
<tr><td><code>specialist</code></td><td>100k+ rows, high-value task</td><td>Full fine-tune, quantized</td></tr>
</tbody>
</table>

<h2 id="backbones">Backbone selection</h2>
<p>The planner picks the smallest backbone that hits the holdout score target. You can override.</p>
<pre><code>kolm training plan ds_018e... --backbone gemma-3n-e2b
kolm training plan ds_018e... --tier 3090
kolm training plan ds_018e... --max-budget-min 60</code></pre>

<h2 id="run">Run</h2>
<pre><code>kolm training run ds_018e... --plan plan_018f...
# job_018g ... running
# epoch 1/3 step 142/420 loss=0.51 val_k=0.88
# epoch 2/3 step 280/420 loss=0.34 val_k=0.92
# epoch 3/3 step 420/420 loss=0.28 val_k=0.94
# holdout: k=0.943 latency_p50=22ms cost_per_1k=$0.03
# artifact ready: ~/.kolm/artifacts/summarizer-v1.kolm</code></pre>

<h2 id="resume">Resume</h2>
<p>Training jobs are checkpointed every epoch. Interrupted runs resume from the last checkpoint.</p>
<pre><code>kolm training resume job_018g</code></pre>

<h2 id="next">Next steps</h2>
<p>Hand the artifact to <a href="/docs/distillation">distillation</a> for packaging, <a href="/docs/evals">evals</a> for the bakeoff, and <a href="/docs/runtime">runtime</a> to swap live traffic onto it. Start from <a href="/docs/quickstart">/docs/quickstart</a> if you have not built a dataset yet.</p>`,
    relatedCards: [
      { href: '/docs/datasets', title: 'Datasets', blurb: 'Freeze a dataset before training.' },
      { href: '/docs/distillation', title: 'Distillation', blurb: 'Package the trained weights into a .kolm.' },
      { href: '/docs/evals', title: 'Evals', blurb: 'Bakeoff the trained artifact against contestants.' },
    ],
  },

  // ---------- distillation ----------
  {
    slug: 'distillation',
    urlPath: '/docs/distillation',
    ogSlug: 'docs-distillation',
    title: 'Distillation',
    description: 'kolm.ai distillation: distill vs compile, recipe vs specialist, the .kolm artifact format (manifest + seeds + recipe.bundle.mjs + receipt chain).',
    lede: 'Distillation in kolm.ai turns lake rows into a portable artifact. The artifact is a single signed file: <code>.kolm</code>. It carries the manifest, the seed examples, the executable recipe, optional weights, and a chain of receipts proving how it was made. You can hand it to anyone with the runtime and they get the same outputs you do.',
    crumbs: [
      { href: '/', label: 'kolm.ai' },
      { href: '/docs', label: 'docs' },
      { label: 'distillation' }
    ],
    body: `<h2 id="distill-vs-compile">Distill vs compile</h2>
<p>Both produce a <code>.kolm</code>. The difference is the input.</p>
<ul>
<li><strong>Distill</strong> reads lake rows and learns from them. The teacher is the prompts-and-responses you already captured. Use this when you have traffic.</li>
<li><strong>Compile</strong> reads a hand-written spec (rules, prompts, schemas) and produces an artifact without any captured traffic. Use this when you are bootstrapping.</li>
</ul>

<h2 id="recipe-vs-specialist">Recipe vs specialist</h2>
<table>
<thead><tr><th>Output kind</th><th>Bytes on disk</th><th>What it is</th></tr></thead>
<tbody>
<tr><td><code>recipe</code></td><td>~5 KB to ~50 KB</td><td>Pure JS module + JSON schemas, no weights. Runs anywhere a JS runtime runs.</td></tr>
<tr><td><code>specialist</code></td><td>~100 MB to ~4 GB</td><td>Recipe + quantized weights for the backbone. Runs on the runtime targets in <a href="/docs/devices">devices</a>.</td></tr>
</tbody>
</table>

<h2 id="artifact">The .kolm artifact format</h2>
<p>A <code>.kolm</code> is a deterministic zip. Open one with any zip tool. The layout is fixed.</p>
<pre><code>artifact.kolm/
  manifest.json           # name, version, kind, sha256s, runtimes, modalities
  seeds.jsonl             # the N representative examples
  recipe.bundle.mjs       # the executable. ES module, no deps.
  schema.json             # input + output schemas, JSON Schema 2020-12
  weights/                # specialists only
    weights.gguf
    weights.gguf.sig
  receipts/
    spec.json             # the source spec
    seeds.json            # the seed selection trace
    split.json            # train/val/holdout assignments
    train.json            # training metrics if any
    recipes.json          # recipe compile log
    evals.json            # bakeoff results
    export.json           # how the bundle was assembled
    signatures.json       # ed25519 over every other receipt
    rekor.json            # sigstore transparency log entry</code></pre>

<h2 id="distill">Distill from captures</h2>
<pre><code>kolm distill --from-captures summarizer --kind recipe
# selecting seeds ... 240 of 4204 rows
# compiling recipe ... ./out/summarizer.kolm (38 KB, 9 receipts signed)</code></pre>

<h2 id="compile">Compile from spec</h2>
<pre><code>kolm compile ./summarizer.spec.json --kind specialist --tier 3090
# parsing spec ... 1 input schema, 1 output schema, 3 rules
# distilling ... 22 GPU-min on 3090
# quantizing ... int4 weights, 412 MB
# signing ... 9/9 receipts
# ./out/summarizer.kolm</code></pre>

<h2 id="verify">Verify</h2>
<p>Verify replays the receipt chain offline. Never trust an artifact you cannot verify. <code>kolm verify</code> exits non-zero if any signature is invalid, any sha256 is wrong, or any receipt is missing.</p>
<pre><code>kolm verify ./summarizer.kolm
# verify OK. 9/9 receipts signed, sha matches, recipe ESM parses clean.</code></pre>

<h2 id="run">Run</h2>
<pre><code>kolm run ./summarizer.kolm --prompt "Summarize this PR diff."
# This PR refactors the auth middleware to fail-closed on token expiry...</code></pre>

<h2 id="next">Next steps</h2>
<p>Once you have an artifact, plug it into <a href="/docs/runtime">runtime</a> so live calls hit it instead of the upstream provider, and run <a href="/docs/evals">evals</a> to confirm it wins the bakeoff. Start from <a href="/docs/quickstart">/docs/quickstart</a> if you have not built a dataset yet.</p>`,
    relatedCards: [
      { href: '/docs/training', title: 'Training', blurb: 'The training run feeds into the specialist artifact.' },
      { href: '/docs/runtime', title: 'Runtime', blurb: 'Serve the .kolm to live traffic.' },
      { href: '/docs/evals', title: 'Evals', blurb: 'Bakeoff the .kolm against contestants.' },
    ],
  },

  // ---------- evals ----------
  {
    slug: 'evals',
    urlPath: '/docs/evals',
    ogSlug: 'docs-evals',
    title: 'Evals',
    description: 'kolm.ai bakeoff: 8 contestants (cache, rule, prompt_only, gemma-3n-e2b, qwen-0.5b, phi-mini, claude-haiku-4-5, gpt-4o-mini), score-per-dollar recommendation, holdout disjointness.',
    lede: 'The bakeoff is how kolm.ai picks the cheapest contestant that hits your quality bar. It runs every contestant against the same holdout split, scores them on the same metric, prices them per inference, and ranks by score-per-dollar. You never have to guess which model to deploy.',
    crumbs: [
      { href: '/', label: 'kolm.ai' },
      { href: '/docs', label: 'docs' },
      { label: 'evals' }
    ],
    body: `<h2 id="contestants">The 8 bakeoff contestants</h2>
<p>Every bakeoff runs the same 8 contestants by default. You can disable contestants per task, but the default set covers the cost-quality frontier from $0 to $1 per 1k inferences.</p>
<table>
<thead><tr><th>Contestant</th><th>Kind</th><th>Cost class</th></tr></thead>
<tbody>
<tr><td><code>cache</code></td><td>Exact-match memoization of prior calls</td><td>$0</td></tr>
<tr><td><code>rule</code></td><td>Compiled rule pack, no LLM</td><td>$0</td></tr>
<tr><td><code>prompt_only</code></td><td>Tuned prompt against a frontier model, no fine-tune</td><td>varies</td></tr>
<tr><td><code>gemma-3n-e2b</code></td><td>Local small LM, on-device</td><td>~$0 amortized</td></tr>
<tr><td><code>qwen-0.5b</code></td><td>Local tiny LM, edge-friendly</td><td>~$0 amortized</td></tr>
<tr><td><code>phi-mini</code></td><td>Local mid LM, CPU-friendly</td><td>~$0 amortized</td></tr>
<tr><td><code>claude-haiku-4-5</code></td><td>Cheap frontier hosted</td><td>cheap</td></tr>
<tr><td><code>gpt-4o-mini</code></td><td>Cheap frontier hosted</td><td>cheap</td></tr>
</tbody>
</table>

<h2 id="run">Run a bakeoff</h2>
<pre><code>kolm bakeoff ds_018e...
# scoring 8 contestants on holdout (421 rows) ...
#                    k_score   p50_ms  cost_per_1k  score_per_$
# cache              0.31         1      $0.000     +inf
# rule               0.58         2      $0.000     +inf
# qwen-0.5b          0.81        18      $0.010     81
# gemma-3n-e2b       0.86        22      $0.012     71
# phi-mini           0.89        35      $0.018     49
# prompt_only        0.91       412      $0.480      1.9
# claude-haiku-4-5   0.94       380      $0.250      3.8
# gpt-4o-mini        0.94       360      $0.150      6.3
#
# recommendation: gpt-4o-mini wins on score-per-$ above the 0.90 quality bar.
# runner-up:      phi-mini wins on score-per-$ above the 0.85 quality bar.</code></pre>

<h2 id="holdout-disjointness">Holdout disjointness</h2>
<p>Every contestant is scored on the same holdout split (sha256-mod buckets 90..99). The same rows the contestant has never seen during training or prompt-tuning. The disjointness is enforced by the dataset id; you cannot accidentally bakeoff against your own train set.</p>
<pre><code>kolm bakeoff ds_018e... --proof
# holdout sha256 = 8f3a...
# any prompt with sha256_mod &lt; 90 was excluded from scoring.
# any artifact whose receipts reference this holdout is rejected.</code></pre>

<h2 id="metric">The k_score metric</h2>
<p>The metric is task-specific. For classification it is balanced accuracy. For extraction it is F1 on the JSON Schema fields. For generation it is a held-out judge model scoring 1..5 normalized to [0,1]. The metric for the run is recorded in the eval receipt.</p>

<h2 id="ci">CI gate</h2>
<p>Wire the bakeoff into your deploy pipeline. Reject any new artifact that does not match or beat the incumbent on holdout.</p>
<pre><code>kolm bakeoff ds_018e... --incumbent ./prod.kolm --candidate ./new.kolm --gate
# exit 0 if candidate k_score &gt;= incumbent - tolerance
# exit 1 otherwise</code></pre>

<h2 id="next">Next steps</h2>
<p>Once a contestant wins, point <a href="/docs/runtime">runtime</a> at it. Use the <a href="/docs/optimizer">optimizer</a> on a schedule to find new bakeoff candidates from your lake. Start from <a href="/docs/quickstart">/docs/quickstart</a> if you have not built a dataset yet.</p>`,
    relatedCards: [
      { href: '/docs/runtime', title: 'Runtime', blurb: 'Deploy the bakeoff winner to live traffic.' },
      { href: '/docs/distillation', title: 'Distillation', blurb: 'Package the winner as a .kolm.' },
      { href: '/docs/optimizer', title: 'Optimizer', blurb: 'Find new candidates to bakeoff.' },
    ],
  },

  // ---------- runtime ----------
  {
    slug: 'runtime',
    urlPath: '/docs/runtime',
    ogSlug: 'docs-runtime',
    title: 'Runtime',
    description: 'kolm.ai runtime policies (local_first, frontier_first, cost_optimized, privacy_only) and the decision chain: privacy -> cache -> local artifact -> cheaper model -> frontier.',
    lede: 'Runtime is what happens at request time. The proxy walks a deterministic decision chain on every call: privacy gate, cache lookup, local artifact lookup, cheaper-model swap, frontier fallback. You pick the policy that matches your risk tolerance. The runtime records every decision so you can audit and revert.',
    crumbs: [
      { href: '/', label: 'kolm.ai' },
      { href: '/docs', label: 'docs' },
      { label: 'runtime' }
    ],
    body: `<h2 id="policies">The 4 runtime policies</h2>
<table>
<thead><tr><th>Policy</th><th>Behavior</th></tr></thead>
<tbody>
<tr><td><code>local_first</code></td><td>Try local artifact, fall back to cheaper model, fall back to requested frontier model. Default.</td></tr>
<tr><td><code>frontier_first</code></td><td>Always call the requested model. Local artifacts are scored offline but never serve traffic.</td></tr>
<tr><td><code>cost_optimized</code></td><td>Try cache, try local artifact, try cheaper model, fall back to requested frontier. Aggressive.</td></tr>
<tr><td><code>privacy_only</code></td><td>Only call local artifacts. Block anything that would require a network call. Strict.</td></tr>
</tbody>
</table>

<h2 id="chain">The decision chain</h2>
<p>Every request walks this chain in order. The first stage that produces a confident response wins. Every decision is recorded in <code>privacy_actions_json</code> and <code>artifact_id</code> on the lake row.</p>
<ol>
<li><strong>Privacy</strong>. Run the 17 detectors. Apply <code>allow / redact / block / override</code> from the policy. If the result is <code>block</code>, return 451 immediately.</li>
<li><strong>Cache</strong>. Hash the redacted prompt. If a cache row exists in the window, return it.</li>
<li><strong>Local artifact</strong>. Look up artifacts registered for this namespace. Score the prompt against the artifact's seeds. If above the confidence threshold, run locally and return.</li>
<li><strong>Cheaper model</strong>. If a cheaper-model routing rule fires for this template, rewrite the upstream model id.</li>
<li><strong>Frontier</strong>. Forward to the originally requested upstream model. Capture as usual.</li>
</ol>

<h2 id="register">Register an artifact</h2>
<pre><code>kolm runtime register ./summarizer.kolm --namespace summarizer --policy local_first
# artifact summarizer-v1.kolm bound to namespace=summarizer
# next call to /summarize will try local first</code></pre>

<h2 id="set-policy">Set the policy</h2>
<pre><code># Default policy for this machine
kolm runtime policy set local_first

# Per-namespace override
kolm runtime policy set privacy_only --namespace medical-claims

# Inspect
kolm runtime policy show
# default     local_first
# namespaces:
#   medical-claims  privacy_only</code></pre>

<h2 id="stats">Replacement stats</h2>
<p>How often did each stage win? The runtime maintains a rolling counter.</p>
<pre><code>kolm runtime stats --window 24h
# total requests:     18,442
# blocked (privacy):    312    1.7%
# cache hits:         3,118   16.9%
# local artifact:     9,420   51.1%
# cheaper model:      1,840   10.0%
# frontier:           3,752   20.3%
# avg savings vs frontier-first: $0.083 per call</code></pre>

<h2 id="rollback">Rollback</h2>
<p>Unregister an artifact or switch policy back. Live traffic switches on the next call. No restart.</p>
<pre><code>kolm runtime unregister summarizer-v1
kolm runtime policy set frontier_first --namespace summarizer</code></pre>

<h2 id="next">Next steps</h2>
<p>Read <a href="/docs/devices">devices</a> to know which targets the runtime can dispatch to and <a href="/docs/storage">storage</a> for the local-first guarantees. Start from <a href="/docs/quickstart">/docs/quickstart</a> if you have not yet shipped an artifact.</p>`,
    relatedCards: [
      { href: '/docs/distillation', title: 'Distillation', blurb: 'Where the local artifact comes from.' },
      { href: '/docs/devices', title: 'Devices', blurb: 'Where the runtime dispatches.' },
      { href: '/docs/privacy', title: 'Privacy', blurb: 'The first stage of the decision chain.' },
    ],
  },

  // ---------- devices ----------
  {
    slug: 'devices',
    urlPath: '/docs/devices',
    ogSlug: 'docs-devices',
    title: 'Devices',
    description: 'kolm.ai device transports: DEVICE_KINDS, RUNTIMES, MODALITIES, detectLocalDevice, install transports (local copy, scp, HTTP PUT).',
    lede: 'A device in kolm.ai is anywhere a <code>.kolm</code> can run. That includes your laptop, a colleague&apos;s laptop, a single-board computer at the edge, a phone in airplane mode, or a server in a colo. The device shell discovers what hardware is available, picks the right runtime, and installs the artifact over one of three transports.',
    crumbs: [
      { href: '/', label: 'kolm.ai' },
      { href: '/docs', label: 'docs' },
      { label: 'devices' }
    ],
    body: `<h2 id="kinds">DEVICE_KINDS</h2>
<table>
<thead><tr><th>Kind</th><th>Typical hardware</th></tr></thead>
<tbody>
<tr><td><code>laptop</code></td><td>Apple Silicon, x86_64, integrated or discrete GPU</td></tr>
<tr><td><code>workstation</code></td><td>Single 3090/4090/5090 or M-series Ultra</td></tr>
<tr><td><code>server</code></td><td>Multi-GPU rack, dgx-spark, hgx, h200</td></tr>
<tr><td><code>edge</code></td><td>Jetson, single-board, embedded</td></tr>
<tr><td><code>phone</code></td><td>iOS, Android, on-device ML</td></tr>
<tr><td><code>browser</code></td><td>WASM in a tab, no install</td></tr>
</tbody>
</table>

<h2 id="runtimes">RUNTIMES</h2>
<p>The runtime is the executor. The device shell picks the fastest one that supports the artifact's runtime requirement (declared in the manifest).</p>
<table>
<thead><tr><th>Runtime</th><th>Supports</th></tr></thead>
<tbody>
<tr><td><code>js</code></td><td>recipe artifacts, pure JS, runs anywhere</td></tr>
<tr><td><code>wasm</code></td><td>recipe artifacts compiled to WASM</td></tr>
<tr><td><code>onnx</code></td><td>specialist artifacts in ONNX format</td></tr>
<tr><td><code>gguf</code></td><td>specialist artifacts in GGUF, via llama.cpp</td></tr>
<tr><td><code>tflite</code></td><td>phone-bound specialist artifacts</td></tr>
<tr><td><code>coreml</code></td><td>Apple Silicon specialist artifacts</td></tr>
</tbody>
</table>

<h2 id="modalities">MODALITIES</h2>
<p>What the artifact takes and returns. Declared in the manifest, enforced at register time.</p>
<ul>
<li><code>text</code> - text in, text out</li>
<li><code>multimodal</code> - image, audio, or video plus text in</li>
<li><code>audio</code> - speech in or out</li>
<li><code>structured</code> - JSON in, JSON out, schema-bound</li>
</ul>

<h2 id="detect">detectLocalDevice</h2>
<p>The shell auto-detects on first run. Output is cached in <code>~/.kolm/device.json</code>.</p>
<pre><code>kolm device detect
# kind:       workstation
# cpu:        AMD Ryzen 9 7950X3D
# gpu:        NVIDIA RTX 5090, 32 GB VRAM
# memory:     128 GB
# runtimes:   js, wasm, onnx, gguf
# modalities: text, multimodal, structured
# tier:       5090</code></pre>

<h2 id="install-transports">Install transports</h2>
<p>Three ways to put a <code>.kolm</code> on a remote device. The device shell normalizes all three so the runtime side does not care.</p>
<table>
<thead><tr><th>Transport</th><th>When</th><th>Command</th></tr></thead>
<tbody>
<tr><td><code>local-copy</code></td><td>Same machine</td><td><code>kolm device install ./summarizer.kolm</code></td></tr>
<tr><td><code>scp</code></td><td>Remote SSH-reachable host</td><td><code>kolm device install ./summarizer.kolm --to user@host:/path</code></td></tr>
<tr><td><code>http-put</code></td><td>Edge device with HTTP endpoint, browser drag-drop</td><td><code>kolm device install ./summarizer.kolm --to http://edge.local/install</code></td></tr>
</tbody>
</table>

<h2 id="list">List installed</h2>
<pre><code>kolm device list
# summarizer-v1.kolm   workstation  gguf  registered to namespace=summarizer
# redactor-v3.kolm     workstation  js    registered to namespace=phi-redact</code></pre>

<h2 id="next">Next steps</h2>
<p>Read <a href="/docs/runtime">runtime</a> for the decision chain that picks devices and <a href="/docs/storage">storage</a> for where the artifact bytes live. Start from <a href="/docs/quickstart">/docs/quickstart</a> if you have not shipped an artifact yet.</p>`,
    relatedCards: [
      { href: '/docs/runtime', title: 'Runtime', blurb: 'The decision chain that picks the device.' },
      { href: '/docs/storage', title: 'Storage', blurb: 'Where the artifact bytes live on the device.' },
      { href: '/docs/distillation', title: 'Distillation', blurb: 'How the .kolm gets built before it is installed.' },
    ],
  },

  // ---------- storage ----------
  {
    slug: 'storage',
    urlPath: '/docs/storage',
    ogSlug: 'docs-storage',
    title: 'Storage',
    description: 'kolm.ai storage modes: metadata_only, redacted_local (default), raw_local, redacted_cloud_sync, raw_cloud_sync. Local-first paths under ~/.kolm/.',
    lede: 'kolm.ai is local-first. The lake, the artifacts, the receipts, the audit log, the device map all live under <code>~/.kolm/</code> on the machine that captured them. Storage modes control which fields get persisted and, if cloud sync is on, which fields get synced. Default is <code>redacted_local</code>: redacted bodies on disk, no cloud bytes.',
    crumbs: [
      { href: '/', label: 'kolm.ai' },
      { href: '/docs', label: 'docs' },
      { label: 'storage' }
    ],
    body: `<h2 id="modes">The 5 storage modes</h2>
<table>
<thead><tr><th>Mode</th><th>Locally stored</th><th>Sent to cloud</th></tr></thead>
<tbody>
<tr><td><code>metadata_only</code></td><td>Row metadata, no message bodies</td><td>nothing</td></tr>
<tr><td><code>redacted_local</code> (default)</td><td>Redacted message bodies + VAR_ map, no raw bytes</td><td>nothing</td></tr>
<tr><td><code>raw_local</code></td><td>Both raw and redacted bodies, both encrypted at rest</td><td>nothing</td></tr>
<tr><td><code>redacted_cloud_sync</code></td><td>Same as redacted_local</td><td>Redacted bodies only, per-class gated</td></tr>
<tr><td><code>raw_cloud_sync</code></td><td>Same as raw_local</td><td>Raw + redacted, per-class gated</td></tr>
</tbody>
</table>

<h2 id="paths">Local-first paths</h2>
<p>Everything kolm.ai writes lives under <code>~/.kolm/</code>. The folder is the unit of backup; copy it to keep your state.</p>
<pre><code>~/.kolm/
  config.json             # local config: base URL, retention, optimizer thresholds
  device.json             # detected hardware
  events/
    events.sqlite         # the lake (WAL mode)
  runtime/
    policy.json           # privacy + runtime policy
    audit.log             # one JSON line per detection / action
  artifacts/
    summarizer-v1.kolm    # installed artifacts
  datasets/
    ds_018e.../           # frozen datasets
  jobs/
    jobs.jsonl            # training / distill job ledger
  keys/
    signing.ed25519       # local signing key (0600)
    signing.pub           # public key</code></pre>

<h2 id="what-stays-local">What stays local in every mode</h2>
<p>Some fields never leave the machine, regardless of mode.</p>
<ul>
<li>The signing private key under <code>~/.kolm/keys/</code>.</li>
<li>The <code>privacy_var_map</code> column in the lake (the VAR_ to original mapping).</li>
<li>The upstream <code>OPENAI_API_KEY</code> / <code>ANTHROPIC_API_KEY</code> / etc. The proxy forwards them but never persists them to the lake.</li>
<li>The full <code>audit.log</code>. Sync sends summarized counters only.</li>
</ul>

<h2 id="set-mode">Set the mode</h2>
<pre><code>kolm storage mode set redacted_local
kolm storage mode set raw_local --namespace forensics
kolm storage mode show
# default     redacted_local
# namespaces:
#   forensics  raw_local</code></pre>

<h2 id="encrypt">Encryption at rest</h2>
<p>When mode is <code>raw_local</code> or <code>raw_cloud_sync</code>, the <code>messages_raw_json</code> and <code>response_raw_json</code> columns are encrypted with a per-machine AES-256-GCM key under <code>~/.kolm/keys/at-rest.aes</code>. Lose the key and the raw rows are unreadable.</p>

<h2 id="vacuum">Vacuum</h2>
<p>Reclaim space after a retention sweep.</p>
<pre><code>kolm storage vacuum
# scanning events.sqlite ... 1.2 GB before
# rebuilding ... 412 MB after
# done in 18s</code></pre>

<h2 id="next">Next steps</h2>
<p>If you intend to share data across machines, read <a href="/docs/cloud-sync">cloud sync</a>. To keep everything strictly local, read <a href="/docs/privacy">privacy</a> for the policy that gates what leaves the machine. Start from <a href="/docs/quickstart">/docs/quickstart</a> if you have not yet captured anything.</p>`,
    relatedCards: [
      { href: '/docs/cloud-sync', title: 'Cloud sync', blurb: 'When and how data leaves the machine.' },
      { href: '/docs/privacy', title: 'Privacy', blurb: 'Per-class gating before storage and sync.' },
      { href: '/docs/lake', title: 'Lake', blurb: 'The schema of what gets stored.' },
    ],
  },

  // ---------- cloud-sync ----------
  {
    slug: 'cloud-sync',
    urlPath: '/docs/cloud-sync',
    ogSlug: 'docs-cloud-sync',
    title: 'Cloud sync',
    description: 'kolm.ai cloud sync states (disabled, metadata_only, redacted_only, raw_enabled) and per-class privacy gating before bytes leave the laptop.',
    lede: 'Cloud sync is opt-in. By default nothing about your traffic leaves your machine. When you turn sync on you pick one of four states, and the privacy policy gates every byte that goes upstream. The sync target can be the hosted kolm.ai backend or a self-hosted bucket you control.',
    crumbs: [
      { href: '/', label: 'kolm.ai' },
      { href: '/docs', label: 'docs' },
      { label: 'cloud-sync' }
    ],
    body: `<h2 id="states">The 4 sync states</h2>
<table>
<thead><tr><th>State</th><th>What gets sent</th></tr></thead>
<tbody>
<tr><td><code>disabled</code></td><td>Nothing. The default. Sync daemon is not even running.</td></tr>
<tr><td><code>metadata_only</code></td><td>Row count, latency p50/p95, cost totals, error rate. No message text. No prompt shas. No detector spans.</td></tr>
<tr><td><code>redacted_only</code></td><td>Redacted message bodies (VAR_ placeholders only), redacted response bodies, schema-bound. Privacy classes set to <code>block</code> still block sync.</td></tr>
<tr><td><code>raw_enabled</code></td><td>Raw and redacted bodies. Only available when storage mode is <code>raw_local</code> or <code>raw_cloud_sync</code>. Requires explicit per-namespace opt-in.</td></tr>
</tbody>
</table>

<h2 id="per-class-gating">Per-class privacy gating</h2>
<p>Even with cloud sync on, the privacy policy is the gatekeeper. Each detector class can have a different action for local storage and cloud sync.</p>
<pre><code>{
  "default": {
    "ssn":        { "local": "redact", "sync": "block" },
    "credit_card":{ "local": "redact", "sync": "block" },
    "email":      { "local": "redact", "sync": "redact" },
    "mrn":        { "local": "redact", "sync": "block" },
    "ip_v4":      { "local": "allow",  "sync": "redact" }
  }
}</code></pre>
<p>If the sync action for a class is <code>block</code>, any row that contained that class is held back from sync entirely, even if the local action redacted it.</p>

<h2 id="set">Turn it on</h2>
<pre><code>kolm sync set redacted_only
kolm sync set disabled
kolm sync show
# state:      redacted_only
# target:     https://kolm.ai/v1/sync
# pending:    412 rows queued
# last-sync:  2026-05-18T09:02:14Z (124 rows, 312 KB)</code></pre>

<h2 id="target">Sync target</h2>
<p>The default target is the hosted kolm.ai sync endpoint. Self-hosted is a single env var pointing at your own S3-compatible bucket or kolm.ai cloud relay.</p>
<pre><code>export KOLM_SYNC_TARGET=s3://my-bucket/kolm-lake
kolm sync set redacted_only</code></pre>

<h2 id="encryption">Wire encryption</h2>
<p>Sync uses TLS to the target and signs each batch with the local ed25519 key. The cloud cannot accept a batch that does not verify against the device's public key registered on first sync.</p>

<h2 id="audit">Audit what was sent</h2>
<p>Every sync run writes a line to <code>~/.kolm/runtime/sync.log</code> with batch sha, row count, class counts, and the public key fingerprint.</p>
<pre><code>kolm sync audit --window 7d
# 2026-05-18T09:02 batch_sha=8f3a... rows=124 classes=email:18,phone:4,jwt:1
# 2026-05-17T09:01 batch_sha=4d12... rows=98  classes=email:14,phone:3</code></pre>

<h2 id="pause">Pause and resume</h2>
<pre><code>kolm sync pause
kolm sync resume
kolm sync flush  # send everything queued now</code></pre>

<h2 id="next">Next steps</h2>
<p>Pair sync with <a href="/docs/team">team</a> shared namespaces if other people will read this data, and revisit <a href="/docs/privacy">privacy</a> any time you flip a class to <code>allow</code>. Start from <a href="/docs/quickstart">/docs/quickstart</a> if your lake is still empty.</p>`,
    relatedCards: [
      { href: '/docs/storage', title: 'Storage', blurb: 'Decides what local rows exist to sync at all.' },
      { href: '/docs/privacy', title: 'Privacy', blurb: 'The gate that controls what bytes leave the machine.' },
      { href: '/docs/team', title: 'Team', blurb: 'Share synced namespaces with teammates.' },
    ],
  },

  // ---------- team ----------
  {
    slug: 'team',
    urlPath: '/docs/team',
    ogSlug: 'docs-team',
    title: 'Team',
    description: 'kolm.ai team: shared namespaces, RBAC (admin, reviewer, contributor, viewer), approval queue for sensitive operations.',
    lede: 'Once more than one person works on a kolm.ai project, you want shared namespaces, role-based access, and an approval queue for the operations that matter (publishing an artifact, changing a privacy policy, enabling raw cloud sync). The team layer is opt-in and works on top of the local-first lake.',
    crumbs: [
      { href: '/', label: 'kolm.ai' },
      { href: '/docs', label: 'docs' },
      { label: 'team' }
    ],
    body: `<h2 id="shared-namespaces">Shared namespaces</h2>
<p>A namespace is a tag on lake events. A <em>shared</em> namespace is a namespace whose synced rows are visible to other members of the same team. Members see each other&apos;s captures, datasets, and artifacts in real time.</p>
<pre><code>kolm team namespace share summarizer --team my-team
# summarizer is now shared with my-team (4 members)</code></pre>

<h2 id="roles">RBAC roles</h2>
<table>
<thead><tr><th>Role</th><th>Can do</th></tr></thead>
<tbody>
<tr><td><code>admin</code></td><td>Everything. Invite, remove, change policy, approve, delete.</td></tr>
<tr><td><code>reviewer</code></td><td>Approve queue items. Read everything. Cannot change policy.</td></tr>
<tr><td><code>contributor</code></td><td>Capture, build datasets, train, publish artifacts. Cannot change policy.</td></tr>
<tr><td><code>viewer</code></td><td>Read-only. Browse captures, datasets, artifacts.</td></tr>
</tbody>
</table>

<h2 id="invite">Invite</h2>
<pre><code>kolm team invite teammate@example.com --role contributor
# invite_018h ... sent. accept link valid 7 days.</code></pre>

<h2 id="approval-queue">Approval queue</h2>
<p>Sensitive operations require an approval from a second member. The queue lives in the synced lake so anyone with <code>reviewer</code> or <code>admin</code> can act on it.</p>
<table>
<thead><tr><th>Operation</th><th>Needs approval?</th></tr></thead>
<tbody>
<tr><td>Publish artifact to shared namespace</td><td>yes (any reviewer)</td></tr>
<tr><td>Change privacy policy on shared namespace</td><td>yes (admin only)</td></tr>
<tr><td>Enable <code>raw_enabled</code> cloud sync</td><td>yes (admin only)</td></tr>
<tr><td>Delete a shared dataset</td><td>yes (admin only)</td></tr>
<tr><td>Capture into a shared namespace</td><td>no</td></tr>
<tr><td>Train against a shared dataset</td><td>no</td></tr>
</tbody>
</table>

<pre><code>kolm team approvals list
# req_018i  publish summarizer-v2.kolm  proposed by alice  age=4m
# req_018j  policy change on /billing   proposed by bob    age=22m

kolm team approvals approve req_018i
kolm team approvals reject  req_018j --reason "lowered ssn from block to redact"</code></pre>

<h2 id="audit">Team audit log</h2>
<p>Every team operation is mirrored into <code>~/.kolm/runtime/team-audit.log</code> on every member&apos;s machine. The audit is content-addressed so members can compare hashes and detect divergence.</p>
<pre><code>kolm team audit --window 7d
# 2026-05-18T09:14  alice  publish artifact summarizer-v2 (req_018i)
# 2026-05-17T16:02  bob    invite carol@ as contributor</code></pre>

<h2 id="rotate">Rotate signing keys</h2>
<p>When a member leaves, their public key is removed from the team trust file and any future sync from their device is rejected.</p>
<pre><code>kolm team member remove carol@example.com
# carol@example.com revoked. trust file updated. next sync from her device will 401.</code></pre>

<h2 id="next">Next steps</h2>
<p>Once a team is wired, read <a href="/docs/enterprise">enterprise</a> for on-prem deployment, SSO, and SLA, and <a href="/docs/cloud-sync">cloud sync</a> for the sync states. Start from <a href="/docs/quickstart">/docs/quickstart</a> if you have not yet captured anything.</p>`,
    relatedCards: [
      { href: '/docs/enterprise', title: 'Enterprise', blurb: 'On-prem, SSO, SCIM, SLA.' },
      { href: '/docs/cloud-sync', title: 'Cloud sync', blurb: 'The sync states team mode runs on top of.' },
      { href: '/docs/privacy', title: 'Privacy', blurb: 'Policy changes on shared namespaces need approval.' },
    ],
  },

  // ---------- enterprise ----------
  {
    slug: 'enterprise',
    urlPath: '/docs/enterprise',
    ogSlug: 'docs-enterprise',
    title: 'Enterprise',
    description: 'kolm.ai enterprise: on-prem deployment, audit log retention, SLA, dedicated support, custom SSO and SCIM scaffolding.',
    lede: 'The enterprise tier is the same kolm.ai stack you can run on a laptop, packaged for procurement. On-prem deploy, retention policies measured in years, an uptime SLA, named support, and SSO / SCIM that fits inside an Okta or Entra org. The product surface is unchanged. The contract surface is what differs.',
    crumbs: [
      { href: '/', label: 'kolm.ai' },
      { href: '/docs', label: 'docs' },
      { label: 'enterprise' }
    ],
    body: `<h2 id="on-prem">On-prem deploy</h2>
<p>The enterprise tarball is the same binary that ships in the <code>@kolm/cli</code> npm package plus a docker-compose for the cloud-side services (sync relay, team coordinator, audit aggregator). Air-gapped installs are supported; the install bundle includes all model weights you license.</p>
<pre><code>curl -O https://download.kolm.ai/enterprise/kolm-onprem-7.x.tar.gz
tar xzf kolm-onprem-7.x.tar.gz
cd kolm-onprem
./install.sh --domain kolm.internal.example --license ./license.key</code></pre>

<h2 id="audit-retention">Audit log retention</h2>
<p>The audit log default is unlimited. Enterprise customers usually pick a policy that aligns with their compliance regime.</p>
<table>
<thead><tr><th>Regime</th><th>Typical retention</th></tr></thead>
<tbody>
<tr><td>HIPAA</td><td>6 years</td></tr>
<tr><td>SOX</td><td>7 years</td></tr>
<tr><td>GDPR (data subject access)</td><td>30 days after request</td></tr>
<tr><td>SOC 2</td><td>1 year minimum, 7 typical</td></tr>
</tbody>
</table>
<p>Configure with one line in <code>~/.kolm/config.json</code>:</p>
<pre><code>{
  "audit_retention_days": 2555
}</code></pre>

<h2 id="sla">SLA</h2>
<p>The hosted control plane carries a 99.9% monthly uptime SLA. Self-hosted installs do not require a control plane to operate; the proxy, lake, and runtime keep working with zero control-plane connectivity.</p>
<table>
<thead><tr><th>Service</th><th>SLA</th></tr></thead>
<tbody>
<tr><td>Hosted sync relay</td><td>99.9% monthly</td></tr>
<tr><td>License server</td><td>99.95% monthly</td></tr>
<tr><td>Hosted artifact registry</td><td>99.9% monthly</td></tr>
<tr><td>Self-hosted proxy / lake / runtime</td><td>your infra</td></tr>
</tbody>
</table>

<h2 id="support">Dedicated support</h2>
<ul>
<li>Named engineer on Slack Connect</li>
<li>P1 response within 30 minutes business hours, 2 hours after-hours</li>
<li>Quarterly architecture review</li>
<li>White-glove migration from existing observability stacks</li>
</ul>

<h2 id="sso">SSO and SCIM scaffolding</h2>
<p>OIDC and SAML 2.0 are supported via the control plane. SCIM 2.0 provisions and deprovisions members in lockstep with your IdP.</p>
<pre><code># In ~/.kolm-control/config.json on the enterprise control plane
{
  "auth": {
    "oidc": {
      "issuer": "https://login.example.com",
      "client_id": "kolm-prod",
      "client_secret_env": "KOLM_OIDC_CLIENT_SECRET"
    },
    "scim": {
      "enabled": true,
      "bearer_env": "KOLM_SCIM_BEARER"
    }
  }
}</code></pre>

<h2 id="compliance">Compliance posture</h2>
<ul>
<li>SOC 2 Type II report available under MNDA</li>
<li>HIPAA BAA for healthcare customers on request</li>
<li>EU data residency on hosted plan</li>
<li>Pen test reports refreshed annually</li>
</ul>

<h2 id="next">Next steps</h2>
<p>If you are evaluating, read <a href="/docs/team">team</a> for the RBAC model that scales into the enterprise tier and <a href="/docs/storage">storage</a> for local-first guarantees that still hold on-prem. Start from <a href="/docs/quickstart">/docs/quickstart</a> if you have not yet installed the CLI.</p>`,
    relatedCards: [
      { href: '/docs/team', title: 'Team', blurb: 'RBAC + approval queue for multi-member orgs.' },
      { href: '/docs/cloud-sync', title: 'Cloud sync', blurb: 'Self-hosted sync target options.' },
      { href: '/docs/api', title: 'API', blurb: 'The REST surface the enterprise control plane speaks.' },
    ],
  },

  // ---------- api ----------
  {
    slug: 'api',
    urlPath: '/docs/api',
    ogSlug: 'docs-api',
    title: 'API',
    description: 'The kolm.ai REST surface. /v1/chat/completions, /v1/messages, /v1/capture, /v1/lake, /v1/optimize, /v1/datasets, /v1/sim, /v1/bakeoff, /v1/training, /v1/runtime, /v1/devices, /v1/sync.',
    lede: 'The kolm.ai REST surface is the same whether you are talking to the local proxy on <code>127.0.0.1:8787</code> or the hosted control plane on <code>kolm.ai</code>. Every endpoint is JSON in, JSON out, bearer-auth on protected routes, and rate-limited per tenant. Every endpoint has a stable response envelope.',
    crumbs: [
      { href: '/', label: 'kolm.ai' },
      { href: '/docs', label: 'docs' },
      { label: 'api' }
    ],
    body: `<h2 id="base">Base URL</h2>
<p>Local proxy: <code>http://127.0.0.1:8787</code>. Hosted: <code>https://kolm.ai</code>. Self-hosted enterprise: your domain.</p>
<pre><code>export KOLM_BASE=http://127.0.0.1:8787
curl -s $KOLM_BASE/v1/health | jq .</code></pre>

<h2 id="auth">Auth</h2>
<p>All <code>/v1/*</code> routes except <code>/v1/health</code> require a bearer key. Local proxy uses the fingerprint of <code>~/.kolm/keys/signing.pub</code>; hosted uses the issued tenant key.</p>
<pre><code>curl -s $KOLM_BASE/v1/lake/stats \\
  -H "Authorization: Bearer $(kolm key fingerprint --raw)"</code></pre>

<h2 id="chat">/v1/chat/completions</h2>
<p>OpenAI-compatible chat. Captures every call to the lake before forwarding.</p>
<pre><code>curl $KOLM_BASE/v1/chat/completions \\
  -H "Authorization: Bearer $KEY" \\
  -H "Content-Type: application/json" \\
  -d '{"model":"gpt-4o-mini","messages":[{"role":"user","content":"hi"}]}'</code></pre>

<h2 id="messages">/v1/messages</h2>
<p>Anthropic-compatible messages. Captures every call.</p>
<pre><code>curl $KOLM_BASE/v1/messages \\
  -H "x-api-key: $ANTHROPIC_KEY" \\
  -H "anthropic-version: 2023-06-01" \\
  -d '{"model":"claude-haiku-4-5","max_tokens":256,"messages":[{"role":"user","content":"hi"}]}'</code></pre>

<h2 id="capture">/v1/capture/*</h2>
<table>
<thead><tr><th>Method</th><th>Path</th><th>Purpose</th></tr></thead>
<tbody>
<tr><td>GET</td><td><code>/v1/capture/stream</code></td><td>SSE live tail of captures, filterable by namespace</td></tr>
<tr><td>GET</td><td><code>/v1/capture/health</code></td><td>Durability probe; returns <code>x-kolm-capture-durable</code></td></tr>
<tr><td>POST</td><td><code>/v1/capture/promote</code></td><td>Promote in-memory captures to durable storage</td></tr>
</tbody>
</table>
<pre><code>curl -N $KOLM_BASE/v1/capture/stream?namespace=summarizer \\
  -H "Authorization: Bearer $KEY"</code></pre>

<h2 id="lake">/v1/lake/*</h2>
<table>
<thead><tr><th>Method</th><th>Path</th><th>Purpose</th></tr></thead>
<tbody>
<tr><td>GET</td><td><code>/v1/lake/stats</code></td><td>Cost, latency, error rollups</td></tr>
<tr><td>GET</td><td><code>/v1/lake/events</code></td><td>List events with filters</td></tr>
<tr><td>GET</td><td><code>/v1/lake/events/:id</code></td><td>Single event</td></tr>
</tbody>
</table>
<pre><code>curl "$KOLM_BASE/v1/lake/stats?window=24h&by=namespace" -H "Authorization: Bearer $KEY"</code></pre>

<h2 id="optimize">/v1/optimize/*</h2>
<pre><code>curl "$KOLM_BASE/v1/optimize?window=7d&min_confidence=0.8" -H "Authorization: Bearer $KEY"</code></pre>

<h2 id="datasets">/v1/datasets/*</h2>
<table>
<thead><tr><th>Method</th><th>Path</th><th>Purpose</th></tr></thead>
<tbody>
<tr><td>POST</td><td><code>/v1/datasets</code></td><td>Build a new dataset from a selector</td></tr>
<tr><td>GET</td><td><code>/v1/datasets</code></td><td>List datasets</td></tr>
<tr><td>GET</td><td><code>/v1/datasets/:id</code></td><td>Dataset manifest</td></tr>
<tr><td>POST</td><td><code>/v1/datasets/:id/freeze</code></td><td>Freeze the dataset for reproducibility</td></tr>
</tbody>
</table>
<pre><code>curl -X POST $KOLM_BASE/v1/datasets \\
  -H "Authorization: Bearer $KEY" -H "Content-Type: application/json" \\
  -d '{"name":"summarizer-v1","namespace":"summarizer","window":"30d","split":[0.8,0.1,0.1]}'</code></pre>

<h2 id="labels">/v1/labels/*</h2>
<pre><code>curl $KOLM_BASE/v1/labels?dataset=ds_018e -H "Authorization: Bearer $KEY"
curl -X POST $KOLM_BASE/v1/labels -H "Authorization: Bearer $KEY" \\
  -d '{"row_id":"r_18a","label":"urgent"}'</code></pre>

<h2 id="synth">/v1/synth/*</h2>
<p>Generate synthetic seed examples for cold-start tasks.</p>
<pre><code>curl -X POST $KOLM_BASE/v1/synth \\
  -H "Authorization: Bearer $KEY" \\
  -d '{"kind":"classification","classes":["urgent","normal","low"],"n":120}'</code></pre>

<h2 id="sim">/v1/sim/*</h2>
<p>Simulate a candidate policy against captured traffic, no live mutation.</p>
<pre><code>curl -X POST $KOLM_BASE/v1/sim \\
  -H "Authorization: Bearer $KEY" \\
  -d '{"policy":"local_first","window":"7d","artifact":"summarizer-v1"}'</code></pre>

<h2 id="bakeoff">/v1/bakeoff/*</h2>
<pre><code>curl -X POST $KOLM_BASE/v1/bakeoff \\
  -H "Authorization: Bearer $KEY" \\
  -d '{"dataset":"ds_018e","contestants":["cache","rule","prompt_only","gemma-3n-e2b","qwen-0.5b","phi-mini","claude-haiku-4-5","gpt-4o-mini"]}'</code></pre>

<h2 id="training">/v1/training/plan</h2>
<pre><code>curl -X POST $KOLM_BASE/v1/training/plan \\
  -H "Authorization: Bearer $KEY" -d '{"dataset":"ds_018e","tier":"3090"}'</code></pre>

<h2 id="runtime">/v1/runtime/*</h2>
<table>
<thead><tr><th>Method</th><th>Path</th><th>Purpose</th></tr></thead>
<tbody>
<tr><td>POST</td><td><code>/v1/runtime/register</code></td><td>Register an artifact for a namespace</td></tr>
<tr><td>POST</td><td><code>/v1/runtime/policy</code></td><td>Set the policy (per-namespace optional)</td></tr>
<tr><td>GET</td><td><code>/v1/runtime/stats</code></td><td>Replacement stats by stage</td></tr>
</tbody>
</table>
<pre><code>curl -X POST $KOLM_BASE/v1/runtime/policy -H "Authorization: Bearer $KEY" \\
  -d '{"policy":"local_first","namespace":"summarizer"}'</code></pre>

<h2 id="devices">/v1/devices/*</h2>
<pre><code>curl $KOLM_BASE/v1/devices -H "Authorization: Bearer $KEY"
curl -X POST $KOLM_BASE/v1/devices/install -H "Authorization: Bearer $KEY" \\
  -d '{"artifact":"summarizer-v1","transport":"scp","target":"user@host:/srv/kolm"}'</code></pre>

<h2 id="sync">/v1/sync/*</h2>
<pre><code>curl -X POST $KOLM_BASE/v1/sync/state -H "Authorization: Bearer $KEY" \\
  -d '{"state":"redacted_only"}'
curl $KOLM_BASE/v1/sync/audit?window=7d -H "Authorization: Bearer $KEY"</code></pre>

<h2 id="team">/v1/team/*</h2>
<pre><code>curl -X POST $KOLM_BASE/v1/team/invite -H "Authorization: Bearer $KEY" \\
  -d '{"email":"alice@example.com","role":"contributor"}'
curl $KOLM_BASE/v1/team/approvals -H "Authorization: Bearer $KEY"</code></pre>

<h2 id="errors">Error envelope</h2>
<p>Every 4xx and 5xx response carries the same shape.</p>
<pre><code>{
  "error": {
    "code": "privacy_blocked",
    "message": "ssn class set to block in policy.json",
    "request_id": "req_018k",
    "details": { "class": "ssn", "namespace": "billing" }
  }
}</code></pre>

<h2 id="next">Next steps</h2>
<p>Read <a href="/docs/lake">the lake schema</a> for the field reference behind <code>/v1/lake/*</code> and <a href="/docs/runtime">runtime</a> for the policy model behind <code>/v1/runtime/*</code>. Start from <a href="/docs/quickstart">/docs/quickstart</a> if you have not installed the CLI yet.</p>`,
    relatedCards: [
      { href: '/docs/lake', title: 'Lake', blurb: 'Field reference for /v1/lake responses.' },
      { href: '/docs/runtime', title: 'Runtime', blurb: 'Policy model behind /v1/runtime.' },
      { href: '/docs/quickstart', title: 'Quickstart', blurb: 'Install the CLI first.' },
    ],
  },
];

let written = 0;
for (const p of pages) {
  const out = path.join(ROOT, 'public', 'docs', `${p.slug}.html`);
  const dir = path.dirname(out);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(out, renderPage(p), 'utf8');
  written++;
}
console.log(`build-docs-w374: wrote ${written} pages`);
module.exports = { pages, renderPage, DETECTOR_CLASSES, OPP_TYPES, BAKEOFF };
