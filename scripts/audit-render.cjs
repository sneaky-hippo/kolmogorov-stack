// Audit live pages for unrendered template artifacts in body text.
// Strip <script> and <style> blocks first to avoid false positives on
// CSS closing braces and JS template literals inside source code.

const https = require('https');

const ROUTES = [
  '/', '/pricing', '/benchmarks', '/build-your-own', '/compile', '/run',
  '/recall', '/cloud', '/docs', '/signup', '/anatomy', '/k-score',
  '/quickstart', '/faq', '/manifesto', '/healthcare', '/finance', '/defense',
  '/how-it-works', '/trust', '/press', '/whitepaper', '/customers', '/brand',
  '/security', '/serve', '/device', '/api', '/playground', '/registry',
  '/account', '/dashboard', '/changelog', '/cookbook', '/edge', '/integrations',
  '/legal', '/manifesto', '/threat-model', '/why-now',
  '/vs-ollama', '/vs-rag', '/vs-fine-tune', '/vs-predibase', '/vs-openpipe',
  '/vs-langsmith', '/articles', '/use-cases',
];

const HOST = process.argv[2] || 'kolm.ai';

function fetchUrl(host, path) {
  return new Promise((resolve, reject) => {
    https.get(`https://${host}${path}`, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, body: Buffer.concat(chunks).toString('utf8') }));
    }).on('error', reject);
  });
}

function stripScriptsAndStyles(html) {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<!--[\s\S]*?-->/g, '');
}

const ARTIFACT_PATTERNS = [
  { name: 'mustache', re: /\{\{[a-zA-Z_][\w.]*\}\}/g },
  { name: 'template-literal-as-text', re: /\$\{[a-zA-Z_][\w.]*\}/g },
  { name: 'literal-undefined-text', re: />\s*undefined\s*</g },
  { name: 'literal-NaN-text', re: />\s*NaN\s*</g },
  { name: 'literal-null-text', re: />\s*null\s*</g },
  { name: 'literal-Object-Object', re: /\[object Object\]/g },
];

(async () => {
  let totalBad = 0;
  for (const p of ROUTES) {
    try {
      const r = await fetchUrl(HOST, p);
      if (r.status !== 200) {
        console.log(`${p} HTTP ${r.status}`);
        continue;
      }
      const stripped = stripScriptsAndStyles(r.body);
      const issues = [];
      for (const { name, re } of ARTIFACT_PATTERNS) {
        re.lastIndex = 0;
        const m = stripped.match(re);
        if (m) issues.push(`${name}=${m.length}(${m[0]})`);
      }
      if (issues.length) {
        console.log(`${p}  ${issues.join('  ')}`);
        totalBad += issues.length;
      }
    } catch (e) {
      console.log(`${p} ERROR ${e.message}`);
    }
  }
  console.log(`\ntotal route-issues: ${totalBad}`);
  process.exit(totalBad ? 1 : 0);
})();
