#!/usr/bin/env node
// Notion sync for kolm — pushes current project state + collaborator changes.
// Requires NOTION_TOKEN env var (Notion integration token, "secret_...").
// Optional: NOTION_KOLM_PAGE_ID (the Notion page ID where kolm lives — if set,
// the script appends a versioned block; if not, it lists matching pages so the
// user can pick one and re-run with the ID set.

import https from 'node:https';

const TOKEN = process.env.NOTION_TOKEN || process.env.NOTION_KEY || process.env.notion_key;
if (!TOKEN) {
  console.error('NOTION_TOKEN env var not set. Aborting. Export your integration secret first.');
  process.exit(1);
}

const PAGE_ID = process.env.NOTION_KOLM_PAGE_ID || '';
const TODAY = new Date().toISOString().slice(0, 10);
const VERSION = 'v7.8.7';

function req(method, pathStr, body) {
  const opts = {
    method,
    hostname: 'api.notion.com',
    path: pathStr,
    headers: {
      'Authorization': 'Bearer ' + TOKEN,
      'Content-Type': 'application/json',
      'Notion-Version': '2022-06-28'
    }
  };
  return new Promise((resolve, reject) => {
    const r = https.request(opts, (res) => {
      let buf = '';
      res.on('data', (c) => buf += c);
      res.on('end', () => {
        try { resolve({ status: res.statusCode, body: JSON.parse(buf) }); }
        catch { resolve({ status: res.statusCode, body: buf }); }
      });
    });
    r.on('error', reject);
    if (body) r.write(JSON.stringify(body));
    r.end();
  });
}

// 1. If no PAGE_ID, search and report matches.
if (!PAGE_ID) {
  console.log('NOTION_KOLM_PAGE_ID not set — searching for "kolm" pages so you can pick one.');
  const search = await req('POST', '/v1/search', { query: 'kolm', filter: { property: 'object', value: 'page' } });
  if (search.status !== 200) {
    console.error('Search failed:', search.status, JSON.stringify(search.body).slice(0, 240));
    process.exit(2);
  }
  const hits = (search.body.results || []).map((p) => {
    const title = (p.properties && (
      (p.properties.title && p.properties.title.title) ||
      (p.properties.Name && p.properties.Name.title)
    )) || [];
    const text = title.map((t) => t.plain_text).join('') || '(untitled)';
    return { id: p.id, title: text, url: p.url };
  });
  console.log('Matched pages:');
  for (const h of hits) console.log(`  ${h.id}  ${h.title}  ${h.url}`);
  console.log('\nRe-run with NOTION_KOLM_PAGE_ID=<picked id> node scripts/notion-sync.mjs');
  process.exit(0);
}

// 2. Build a versioned changelog block.
const changelogBlocks = [
  {
    object: 'block', type: 'heading_2',
    heading_2: { rich_text: [{ type: 'text', text: { content: `kolm ${VERSION} — ${TODAY}` } }] }
  },
  {
    object: 'block', type: 'bulleted_list_item',
    bulleted_list_item: { rich_text: [{ type: 'text', text: { content: 'Light theme 100x polish: hardcoded #050607/#0b0f10 backgrounds now invert in light mode (plate, preview, kcalc, pipeline, bytemap, reg-tele).' } }] }
  },
  {
    object: 'block', type: 'bulleted_list_item',
    bulleted_list_item: { rich_text: [{ type: 'text', text: { content: 'Pre-baked theme-toggle button into 110 pages, eliminating the first-paint menu jump caused by runtime DOM insertion.' } }] }
  },
  {
    object: 'block', type: 'bulleted_list_item',
    bulleted_list_item: { rich_text: [{ type: 'text', text: { content: 'Mystery nav-toggle button on desktop removed — .nav-toggle now lives in brand-refresh.css (loaded everywhere) instead of styles.css (loaded on 3 pages).' } }] }
  },
  {
    object: 'block', type: 'bulleted_list_item',
    bulleted_list_item: { rich_text: [{ type: 'text', text: { content: 'OAuth buttons (Google + GitHub) re-styled as white-bordered cards with brand logos — readable in both themes; dim cleanly when providers unset on Railway.' } }] }
  },
  {
    object: 'block', type: 'bulleted_list_item',
    bulleted_list_item: { rich_text: [{ type: 'text', text: { content: 'btn-primary alias added to light-mode override (was rendering beige on healthcare/finance/legal).' } }] }
  },
  {
    object: 'block', type: 'bulleted_list_item',
    bulleted_list_item: { rich_text: [{ type: 'text', text: { content: 'Light-mode body gets a subtle paper-grain wash (emerald + ink radial gradients) so the surface no longer feels empty.' } }] }
  },
  {
    object: 'block', type: 'heading_3',
    heading_3: { rich_text: [{ type: 'text', text: { content: 'Team' } }] }
  },
  {
    object: 'block', type: 'bulleted_list_item',
    bulleted_list_item: { rich_text: [{ type: 'text', text: { content: 'Harrison joined as a PhD-level technical collaborator (added 2026-05-12).' } }] }
  }
];

const append = await req('PATCH', `/v1/blocks/${PAGE_ID}/children`, { children: changelogBlocks });
if (append.status !== 200) {
  console.error('Append failed:', append.status, JSON.stringify(append.body).slice(0, 300));
  process.exit(3);
}
console.log(`appended ${changelogBlocks.length} blocks to ${PAGE_ID}`);
