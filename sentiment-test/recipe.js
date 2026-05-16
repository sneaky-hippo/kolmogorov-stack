// Sentiment classifier for product reviews.
// Reads positive_words / negative_words arrays from lib.pack.lexicon.
// Output shape: { sentiment: "positive" | "neutral" | "negative", score: -1..1 }
function generate(input, lib) {
  // accept string OR { review: "..." } OR { text: "..." }
  let review = "";
  if (typeof input === "string") {
    review = input;
  } else if (input && typeof input === "object") {
    review = input.review || input.text || input.input || "";
  }

  const lex = (lib && lib.pack && lib.pack.lexicon) || {};
  const pos = Array.isArray(lex.positive_words) ? lex.positive_words : [];
  const neg = Array.isArray(lex.negative_words) ? lex.negative_words : [];

  // normalize: lower-case, strip non-letters to spaces, split on whitespace
  const normalized = String(review).toLowerCase().replace(/[^a-z0-9' ]+/g, " ");
  const tokens = normalized.split(/\s+/).filter(function (t) { return t.length > 0; });

  const posSet = new Set(pos.map(function (w) { return String(w).toLowerCase(); }));
  const negSet = new Set(neg.map(function (w) { return String(w).toLowerCase(); }));

  let posHits = 0;
  let negHits = 0;
  for (let i = 0; i < tokens.length; i++) {
    const tok = tokens[i];
    if (posSet.has(tok)) { posHits = posHits + 1; }
    if (negSet.has(tok)) { negHits = negHits + 1; }
  }

  // raw score in [-1, 1]; zero hits -> 0 (neutral)
  let score = 0;
  const total = posHits + negHits;
  if (total > 0) {
    score = (posHits - negHits) / total;
  }
  // round to 3 decimals so output is stable
  score = Math.round(score * 1000) / 1000;

  let sentiment = "neutral";
  if (score > 0.2) {
    sentiment = "positive";
  } else if (score < -0.2) {
    sentiment = "negative";
  }

  return { sentiment: sentiment, score: score };
}
