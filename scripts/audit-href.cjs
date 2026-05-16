const fs = require("fs");
const path = require("path");

function walk(d, out = [], filterExt = null) {
  for (const e of fs.readdirSync(d, { withFileTypes: true })) {
    const f = path.join(d, e.name);
    if (e.isDirectory()) walk(f, out, filterExt);
    else if (!filterExt || e.name.endsWith(filterExt)) out.push(f);
  }
  return out;
}

const v = JSON.parse(fs.readFileSync("vercel.json", "utf8"));
const valid = new Set();
for (const r of v.rewrites || []) {
  const src = r.source;
  if (src.includes("(.*)")) continue;
  valid.add(src);
}
for (const f of walk("public", [], null)) {
  const rel = f.replace(/\\/g, "/").replace(/^public/, "");
  valid.add(rel);
  if (rel.endsWith(".html")) valid.add(rel.replace(/\.html$/, ""));
  if (rel.endsWith("/index.html")) valid.add(rel.replace(/\/index\.html$/, "") || "/");
}

const re = /<a[^>]+href="(\/[^"#?]+)"/gi;
let bad = 0;
let ok = 0;
const broken = new Map();
for (const f of walk("public", [], ".html")) {
  if (f.includes("_archive")) continue;
  const s = fs.readFileSync(f, "utf8");
  let m;
  while ((m = re.exec(s)) !== null) {
    const url = m[1];
    const u = url.length > 1 && url.endsWith("/") ? url.slice(0, -1) : url;
    if (valid.has(u) || valid.has(url)) { ok++; continue; }
    // wildcard rewrites — match both /path/(.*) and /path/:param[*] (Vercel path params)
    let wc = false;
    for (const r of v.rewrites || []) {
      const w = r.source.match(/^(\/[^()]+)\/\(\.\*\)$/);
      if (w && url.startsWith(w[1] + "/")) { wc = true; break; }
      if (r.source.includes("/:")) {
        const prefix = r.source.split("/:")[0];
        if (prefix && url.startsWith(prefix + "/")) { wc = true; break; }
      }
    }
    if (wc) { ok++; continue; }
    // /v1/ are API routes
    if (url.startsWith("/v1/") || url === "/v1" || url === "/health") { ok++; continue; }
    bad++;
    if (!broken.has(url)) broken.set(url, []);
    broken.get(url).push(f);
  }
}
console.log("ok:", ok, "broken:", bad);
const FALSE_POSITIVES = new Set([
  "/registry/' + escText(c.id) + '",  // dynamic JS template
]);
let realBroken = 0;
for (const [u, files] of [...broken.entries()].sort((a, b) => b[1].length - a[1].length)) {
  if (FALSE_POSITIVES.has(u)) continue;
  realBroken += files.length;
  console.log(files.length, u);
  for (const f of files.slice(0, 3)) console.log("   ", f);
}
const strict = process.argv.includes("--strict");
if (strict && realBroken > 0) {
  console.error(`\nERROR: ${realBroken} broken internal href(s) — fail.`);
  process.exit(1);
}
process.exit(0);
