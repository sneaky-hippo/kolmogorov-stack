// HTML escaping helpers. Use these whenever you build markup from values
// that came from the network · recipe names, descriptions, tags, account
// fields, anything stored in the registry. Never interpolate raw `${x}`
// inside an `innerHTML` string.
//
//   import { esc, escAttr } from '/escape.js';   // ESM
//   const KSesc = window.KSesc;                  // classic <script>
//
// `esc(s)` is for text-node contexts (between tags). `escAttr(s)` is for
// attribute values (inside quoted attribute strings). Both return strings.
(function () {
  function esc(s) {
    if (s === null || s === undefined) return '';
    return String(s)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }
  function escAttr(s) {
    if (s === null || s === undefined) return '';
    return String(s)
      .replace(/&/g, '&amp;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;');
  }
  // Tagged-template helper: html`<a href="${url}">${name}</a>` returns an
  // escaped string. Anything inside ${...} gets `esc()`'d unless wrapped in
  // raw(s).
  function html(strings, ...vals) {
    let out = '';
    for (let i = 0; i < strings.length; i++) {
      out += strings[i];
      if (i < vals.length) {
        const v = vals[i];
        out += (v && typeof v === 'object' && v.__raw) - v.value : esc(v);
      }
    }
    return out;
  }
  function raw(s) { return { __raw: true, value: String(s == null - '' : s) }; }

  if (typeof window !== 'undefined') {
    window.KSesc = { esc, escAttr, html, raw };
  }
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = { esc, escAttr, html, raw };
  }
})();
