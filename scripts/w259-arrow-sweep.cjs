#!/usr/bin/env node
// W259: canonicalize arrows to &rarr; inside <a class="btn...">...</a> and <button>...</button>
// labels. We must NOT touch arrows in <pre>/<code> blocks (might be CLI examples).
//
// Rules:
//   - Raw U+2192 → inside <a> or <button> text → &rarr;
//   - ASCII "->" inside <a class="btn..."> or <button> text → &rarr;
//   - Do NOT touch arrows inside <pre>...</pre> or <code>...</code>.
//   - Do NOT touch <a> tags inside <pre>/<code> (rare but possible).
//   - Idempotent.

const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..', 'public');

// Strip <pre>...</pre> and <code>...</code> chunks before sweep, then re-stitch.
function maskBlocks(html) {
  const blocks = [];
  let i = 0;
  const masked = html.replace(/<(pre|code|script|style)\b[^>]*>[\s\S]*?<\/\1>/gi, (m) => {
    const key = `__BLOCK_${i++}__`;
    blocks.push(m);
    return key;
  });
  return { masked, blocks };
}
function unmask(html, blocks) {
  return html.replace(/__BLOCK_(\d+)__/g, (_, idx) => blocks[Number(idx)]);
}

// Sweep one match of an anchor or button label and rewrite arrows.
function rewriteArrows(html) {
  // <a ...>label</a>
  html = html.replace(/<a\b([^>]*)>([^<]+)<\/a>/g, (m, attrs, label) => {
    let newLabel = label;
    // Raw U+2192 always
    newLabel = newLabel.replace(/→/g, '&rarr;');
    // ASCII "->" only when the <a> is styled as a button-like CTA
    if (/class\s*=\s*["'][^"']*\bbtn\b/i.test(attrs)) {
      newLabel = newLabel.replace(/(\s)->(\s|$)/g, '$1&rarr;$2');
    }
    return '<a' + attrs + '>' + newLabel + '</a>';
  });
  // <button ...>label</button>
  html = html.replace(/<button\b([^>]*)>([^<]+)<\/button>/g, (m, attrs, label) => {
    let newLabel = label;
    newLabel = newLabel.replace(/→/g, '&rarr;');
    newLabel = newLabel.replace(/(\s)->(\s|$)/g, '$1&rarr;$2');
    return '<button' + attrs + '>' + newLabel + '</button>';
  });
  return html;
}

let scanned = 0, changed = 0;

function walk(dir) {
  for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, ent.name);
    if (ent.isDirectory()) { walk(p); continue; }
    if (!ent.name.endsWith('.html')) continue;
    // Skip index.html — owned by another agent in this pass.
    if (path.relative(ROOT, p).replace(/\\/g, '/') === 'index.html') continue;
    scanned++;
    const orig = fs.readFileSync(p, 'utf8');
    const { masked, blocks } = maskBlocks(orig);
    const swept = rewriteArrows(masked);
    const next = unmask(swept, blocks);
    if (next !== orig) {
      fs.writeFileSync(p, next);
      changed++;
    }
  }
}

walk(ROOT);
console.log(`scanned ${scanned} html files (skipping index.html), updated ${changed}`);
