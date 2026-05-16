// phone-validator recipe
// input: { text: "<raw phone>" }
// output: { e164, country, valid, original }
//
// Strategy: light, deterministic, no deps.
//   1) record original
//   2) strip everything except digits / leading + / leading 00
//   3) infer country code (US default if 10 digits, +44 / +49 / etc explicit)
//   4) re-render E.164: "+<cc><subscriber>"
//   5) validate by digit-length range per country
function generate(input, lib) {
  const raw = (input && typeof input.text === 'string') ? input.text : '';
  const original = raw;

  // normalize: turn leading "00" or "011" into "+", keep "+" prefix, strip junk
  let s = raw.trim();
  let plus = false;
  if (s.startsWith('+')) { plus = true; s = s.slice(1); }
  else if (s.startsWith('00')) { plus = true; s = s.slice(2); }
  else if (s.startsWith('011')) { plus = true; s = s.slice(3); }

  // keep digits only
  let digits = '';
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c >= 48 && c <= 57) digits += s[i];
  }

  // country detection table (longest-prefix-first)
  // cc, iso, totalLen (digits incl cc) range [min, max]
  const TABLE = [
    { cc: '1',   iso: 'US', min: 11, max: 11 },
    { cc: '44',  iso: 'GB', min: 12, max: 13 },
    { cc: '49',  iso: 'DE', min: 11, max: 13 },
    { cc: '33',  iso: 'FR', min: 11, max: 11 },
    { cc: '34',  iso: 'ES', min: 11, max: 11 },
    { cc: '39',  iso: 'IT', min: 11, max: 13 },
    { cc: '81',  iso: 'JP', min: 11, max: 12 },
    { cc: '86',  iso: 'CN', min: 13, max: 13 },
    { cc: '91',  iso: 'IN', min: 12, max: 12 },
    { cc: '61',  iso: 'AU', min: 11, max: 11 },
    { cc: '55',  iso: 'BR', min: 12, max: 13 },
    { cc: '7',   iso: 'RU', min: 11, max: 11 },
    { cc: '52',  iso: 'MX', min: 12, max: 12 },
    { cc: '82',  iso: 'KR', min: 11, max: 12 },
    { cc: '31',  iso: 'NL', min: 11, max: 11 },
    { cc: '46',  iso: 'SE', min: 11, max: 12 },
    { cc: '41',  iso: 'CH', min: 11, max: 12 }
  ];

  let cc = null;
  let iso = null;
  let subscriber = digits;
  let inferredFromDefault = false;

  if (plus) {
    // explicit international: longest-prefix match
    for (let i = 0; i < TABLE.length; i++) {
      const row = TABLE[i];
      if (digits.startsWith(row.cc)) {
        cc = row.cc;
        iso = row.iso;
        subscriber = digits.slice(row.cc.length);
        break;
      }
    }
  } else {
    // no plus: assume US if 10-digit subscriber or 11-digit starting with 1
    if (digits.length === 10) {
      cc = '1';
      iso = 'US';
      subscriber = digits;
      inferredFromDefault = true;
    } else if (digits.length === 11 && digits.startsWith('1')) {
      cc = '1';
      iso = 'US';
      subscriber = digits.slice(1);
      inferredFromDefault = true;
    }
  }

  // build e164
  let e164 = '';
  if (cc) e164 = '+' + cc + subscriber;
  else e164 = digits ? '+' + digits : '';

  // validate
  let valid = false;
  if (cc && iso) {
    const total = cc.length + subscriber.length;
    const row = TABLE.find(function (r) { return r.cc === cc && r.iso === iso; });
    if (row && total >= row.min && total <= row.max && /^[0-9]+$/.test(subscriber)) {
      valid = true;
    }
  }

  return {
    e164: e164,
    country: iso || 'UNKNOWN',
    valid: valid,
    original: original
  };
}
