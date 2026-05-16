// Markdown link extractor recipe.
// Pure JS (source_file). Backslashes in regex are FINE here — no JSON escaping.
function generate(input, lib) {
  const raw = (typeof input === 'string') ? input : (input && (input.text || input.markdown || input.doc)) || '';
  const text = String(raw);

  // Pass 1: collect reference definitions of the form `[ref]: url "optional title"`
  // Multiple lines supported; only the URL is kept.
  const refs = {};
  const refDefRe = /^[ \t]{0,3}\[([^\]]+)\]:[ \t]*<?([^\s>]+)>?(?:[ \t]+(?:"[^"]*"|'[^']*'|\([^)]*\)))?[ \t]*$/gm;
  let m;
  while ((m = refDefRe.exec(text)) !== null) {
    refs[m[1].trim().toLowerCase()] = m[2];
  }

  // Pass 2: strip ref-definition lines so we don't re-parse them as ref links.
  const stripped = text.replace(refDefRe, '');

  const links = [];

  // Inline links: [text](href). Bracketed text allows balanced [..] one level deep is overkill — keep simple.
  // We disallow `]` inside the bracket text and `)` inside the href to avoid runaway.
  const inlineRe = /\[([^\]]+)\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g;
  while ((m = inlineRe.exec(stripped)) !== null) {
    links.push({ text: m[1], href: m[2], type: 'inline' });
  }

  // Reference links: [text][ref] or shortcut [text][] (ref == text)
  const refLinkRe = /\[([^\]]+)\]\[([^\]]*)\]/g;
  while ((m = refLinkRe.exec(stripped)) !== null) {
    const txt = m[1];
    const key = (m[2].trim() === '' ? txt : m[2]).toLowerCase();
    if (refs[key] != null) {
      links.push({ text: txt, href: refs[key], type: 'reference' });
    }
  }

  // Autolinks: <http://...> or <mailto:...>
  const autoRe = /<((?:https?:\/\/|mailto:|ftp:\/\/)[^>\s]+)>/g;
  while ((m = autoRe.exec(stripped)) !== null) {
    links.push({ text: m[1], href: m[1], type: 'autolink' });
  }

  return { links };
}
