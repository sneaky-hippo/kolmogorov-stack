// Inject HowTo JSON-LD into cookbook recipe pages that lack it.
// Reads <title>, <meta og:title>, <meta description>, and the canonical
// URL from each page so the schema matches the page's own facts.
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..', 'public', 'cookbook');

function pick(s, re) {
  const m = s.match(re);
  return m ? m[1].trim() : '';
}

function escJson(s) {
  return s.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
}

let touched = 0, already = 0, skipped = 0;
for (const f of fs.readdirSync(ROOT)) {
  if (!f.endsWith('.html')) continue;
  if (f === 'index.html') { skipped++; continue; }
  const full = path.join(ROOT, f);
  let s = fs.readFileSync(full, 'utf8');
  if (s.includes('application/ld+json')) { already++; continue; }
  if (!s.includes('<link rel="canonical"')) { skipped++; continue; }

  const title = pick(s, /<meta property="og:title" content="([^"]+)"/) || pick(s, /<title>([^<]+)<\/title>/).replace(/\s*·\s*kolm cookbook\s*$/i, '');
  const desc = pick(s, /<meta property="og:description" content="([^"]+)"/) || pick(s, /<meta name="description" content="([^"]+)"/);
  const canon = pick(s, /<link rel="canonical" href="([^"]+)"/);

  if (!title || !canon) { skipped++; continue; }

  const ld = {
    '@context': 'https://schema.org',
    '@type': 'HowTo',
    name: title,
    description: desc,
    url: canon,
    totalTime: 'PT5M',
    tool: [{ '@type': 'HowToTool', name: 'kolm CLI' }],
    step: [
      { '@type': 'HowToStep', name: 'Install', text: 'npm i -g github:sneaky-hippo/kolmogorov-stack' },
      { '@type': 'HowToStep', name: 'Compile', text: 'kolm compile ' + path.basename(f, '.html') + '.toml' },
      { '@type': 'HowToStep', name: 'Run', text: 'kolm run ' + path.basename(f, '.html') + '.kolm' },
    ],
  };
  const tag = '<script type="application/ld+json">' + JSON.stringify(ld) + '</script>';
  // Inject just before </head>
  if (!s.includes('</head>')) { skipped++; continue; }
  s = s.replace('</head>', tag + '\n</head>');
  fs.writeFileSync(full, s);
  touched++;
}
console.log(`cookbook JSON-LD: ${touched} touched, ${already} already had it, ${skipped} skipped.`);
