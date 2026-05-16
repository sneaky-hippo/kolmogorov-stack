// invoice line-item extractor
// input  : { text: "Widget x 3 @ $4.99 = $14.97" }
// output : { description, quantity, unit_price, total }
//
// supports several common formats:
//   "Widget x 3 @ $4.99 = $14.97"
//   "Widget xName x3 @ $4.99 each, total $14.97"
//   "5 hours billable, $120/hr, $600.00"
//   "Consulting - 4 hrs @ $150/hr"
//   "3 widgets at $4.99 each = $14.97"
//   "Item: 2 x $9.50"
function generate(input, lib) {
  const raw = (input && typeof input === 'object') ? (input.text || '') : String(input || '');
  const text = String(raw).trim();

  // helpers
  const toNum = (s) => {
    if (s == null) return null;
    const cleaned = String(s).replace(/[$,\s]/g, '');
    if (cleaned === '' || cleaned === '.') return null;
    const n = Number(cleaned);
    return Number.isFinite(n) ? n : null;
  };
  const round2 = (n) => Math.round(n * 100) / 100;
  const result = { description: '', quantity: null, unit_price: null, total: null };

  if (!text) return result;

  // ---- regex shapes ----

  // SHAPE A: "<desc> x <qty> @ $<unit> = $<total>"
  //         "<desc> x <qty> @ $<unit>"
  //         "<desc> x <qty>"
  // also tolerates 'X' or '*' as the times marker and 'each' / 'at' as @ synonyms
  const reA = /^(.+?)\s*(?:x|X|\*|times)\s*(\d+(?:\.\d+)?)(?:\s*(?:@|at)\s*\$?\s*(\d+(?:\.\d+)?))?(?:\s*(?:=|,|\s)\s*(?:total\s*)?\$?\s*(\d+(?:\.\d+)?))?\s*$/i;

  // SHAPE B: "<qty> hours billable, $<rate>/hr, $<total>"
  //         "<qty> hrs @ $<rate>/hr"
  //         "<qty> hours at $<rate>/hour"
  const reB = /^(.*?)(?:^|[\s:,-])\s*(\d+(?:\.\d+)?)\s*(?:hours?|hrs?)\b[^$\d]*\$?\s*(\d+(?:\.\d+)?)\s*(?:\/\s*(?:hr|hour|h))?(?:[^$\d]*\$?\s*(\d+(?:\.\d+)?))?\s*$/i;

  // SHAPE C: "<qty> <units> at $<unit> each [= $<total>]"
  //         "<qty> widgets at $4.99 each = $14.97"
  const reC = /^(.*?)?\s*(\d+(?:\.\d+)?)\s+([A-Za-z][A-Za-z\s-]*?)\s+(?:at|@)\s*\$?\s*(\d+(?:\.\d+)?)\s*(?:each|ea)?(?:\s*(?:=|,)\s*\$?\s*(\d+(?:\.\d+)?))?\s*$/i;

  // SHAPE D: "Item: <qty> x $<unit>"
  //         "Item: <qty> x $<unit> = $<total>"
  const reD = /^(.+?)[:\-]\s*(\d+(?:\.\d+)?)\s*(?:x|X|\*)\s*\$?\s*(\d+(?:\.\d+)?)\s*(?:(?:=|,)\s*\$?\s*(\d+(?:\.\d+)?))?\s*$/;

  let m;

  if ((m = text.match(reA))) {
    result.description = String(m[1] || '').trim();
    result.quantity = toNum(m[2]);
    result.unit_price = toNum(m[3]);
    result.total = toNum(m[4]);
  } else if ((m = text.match(reD))) {
    result.description = String(m[1] || '').trim();
    result.quantity = toNum(m[2]);
    result.unit_price = toNum(m[3]);
    result.total = toNum(m[4]);
  } else if ((m = text.match(reB))) {
    // hours-style: "5 hours billable, $120/hr, $600.00"
    const lead = String(m[1] || '').trim().replace(/[,:-]\s*$/, '').trim();
    result.description = lead || 'billable hours';
    result.quantity = toNum(m[2]);
    result.unit_price = toNum(m[3]);
    result.total = toNum(m[4]);
  } else if ((m = text.match(reC))) {
    const lead = String(m[1] || '').trim().replace(/[,:-]\s*$/, '').trim();
    const unit = String(m[3] || '').trim();
    result.description = lead ? (lead + ' ' + unit).trim() : unit;
    result.quantity = toNum(m[2]);
    result.unit_price = toNum(m[4]);
    result.total = toNum(m[5]);
  } else {
    // fall back: scan currency tokens, qty tokens
    const moneyMatches = [...text.matchAll(/\$\s*(\d+(?:\.\d+)?)/g)].map((mm) => toNum(mm[1])).filter((x) => x != null);
    const qtyMatch = text.match(/(?:^|[\s])(\d+(?:\.\d+)?)\b/);
    result.description = text;
    if (qtyMatch) result.quantity = toNum(qtyMatch[1]);
    if (moneyMatches.length === 1) {
      result.total = moneyMatches[0];
    } else if (moneyMatches.length >= 2) {
      result.unit_price = moneyMatches[0];
      result.total = moneyMatches[moneyMatches.length - 1];
    }
  }

  // infer missing values when possible
  if (result.quantity != null && result.unit_price != null && result.total == null) {
    result.total = round2(result.quantity * result.unit_price);
  }
  if (result.quantity != null && result.total != null && result.unit_price == null && result.quantity !== 0) {
    result.unit_price = round2(result.total / result.quantity);
  }

  // normalise numbers to two decimals where they look like currency
  if (typeof result.unit_price === 'number') result.unit_price = round2(result.unit_price);
  if (typeof result.total === 'number') result.total = round2(result.total);

  // cleanup description
  if (typeof result.description === 'string') {
    result.description = result.description
      .replace(/\s{2,}/g, ' ')
      .replace(/^[\s,;:-]+|[\s,;:-]+$/g, '')
      .trim();
  }

  return result;
}
