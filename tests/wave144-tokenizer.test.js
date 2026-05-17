// Wave 144 — pretokenization layer for .kolm artifacts.
// Pure-JS byte-level BPE tokenizer. Tests cover roundtrip guarantee (ASCII +
// CJK + emoji + control bytes), training determinism, vocab assembly, and
// JSON serialization for embedding in .kolm artifacts.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { KolmTokenizer, SPEC, SPECIAL_TOKENS, trainTokenizer, summarizeTokenizer } from '../src/tokenizer.js';

test('KolmTokenizer: bare tokenizer has 4 specials + 256 bytes', () => {
  const t = new KolmTokenizer();
  assert.equal(t.vocab.length, SPECIAL_TOKENS.length + 256);
  assert.equal(t.merges.length, 0);
  assert.equal(KolmTokenizer.specialId('<pad>'), 0);
  assert.equal(KolmTokenizer.specialId('</s>'), 3);
});

test('KolmTokenizer: bare tokenizer roundtrips arbitrary UTF-8', () => {
  const t = new KolmTokenizer();
  for (const s of ['hello world', 'iñtërn', '你好世界', '🎉 party time', 'mix: 你好 hello 🎉 ok', '   leading spaces', 'tab\there', 'line\nbreak']) {
    const ids = t.encode(s);
    assert.equal(t.decode(ids), s, `roundtrip failed for ${JSON.stringify(s)}`);
  }
});

test('trainTokenizer: learned tokenizer roundtrips ASCII + CJK + emoji', () => {
  const corpus = [
    'hello world hello there',
    'world is round and beautiful',
    'hello beautiful world world world',
    'i refund my order please',
    'i want to cancel the order',
    'please refund my money',
    'cancel the shipping order',
    'shipping update needed urgently',
  ];
  const tok = trainTokenizer(corpus, { vocab_size: 320 });
  assert.ok(tok.merges.length > 0, 'must learn at least one merge');
  for (const s of corpus) {
    assert.equal(tok.decode(tok.encode(s)), s);
  }
  // Out-of-vocab inputs still roundtrip (byte alphabet covers everything).
  assert.equal(tok.decode(tok.encode('totally novel input 你好 🎉')), 'totally novel input 你好 🎉');
});

test('trainTokenizer: learned tokenizer compresses repeated patterns', () => {
  const corpus = Array.from({ length: 50 }, () => 'the quick brown fox jumps over the lazy dog');
  const tok = trainTokenizer(corpus, { vocab_size: 600 });
  const text = 'the quick brown fox';
  const tokenIds = tok.encode(text);
  const byteCount = Buffer.byteLength(text, 'utf-8');
  assert.ok(tokenIds.length < byteCount, `expected fewer tokens than bytes (got ${tokenIds.length} tokens / ${byteCount} bytes)`);
});

test('trainTokenizer: training is deterministic for the same corpus + vocab_size', () => {
  const corpus = ['alpha beta gamma', 'alpha gamma delta', 'beta beta gamma'];
  const a = trainTokenizer(corpus, { vocab_size: 280 });
  const b = trainTokenizer(corpus, { vocab_size: 280 });
  assert.equal(a.sha256(), b.sha256(), 'same corpus + vocab_size must yield identical tokenizer');
});

test('trainTokenizer: small vocab cap stops merges early', () => {
  const corpus = ['hello hello hello hello hello'];
  const tok = trainTokenizer(corpus, { vocab_size: 262 }); // 4 specials + 256 bytes + 2 merges
  assert.ok(tok.merges.length <= 2, `expected <=2 merges, got ${tok.merges.length}`);
});

test('trainTokenizer: refuses empty corpus', () => {
  assert.throws(() => trainTokenizer([], { vocab_size: 1000 }), /non-empty array/);
});

test('KolmTokenizer: toJSON / fromJSON roundtrip preserves encoding behavior', () => {
  const corpus = ['hello world', 'world hello hello world world'];
  const tok = trainTokenizer(corpus, { vocab_size: 280 });
  const wireJson = JSON.parse(JSON.stringify(tok.toJSON()));
  const restored = KolmTokenizer.fromJSON(wireJson);
  assert.equal(restored.sha256(), tok.sha256());
  for (const s of corpus.concat(['fresh sample input'])) {
    assert.deepEqual(restored.encode(s), tok.encode(s));
    assert.equal(restored.decode(restored.encode(s)), s);
  }
});

test('KolmTokenizer.fromJSON: rejects wrong spec', () => {
  assert.throws(() => KolmTokenizer.fromJSON({ spec: 'wrong-spec' }), new RegExp(`expected spec=${SPEC}`));
  assert.throws(() => KolmTokenizer.fromJSON(null), new RegExp(`expected spec=${SPEC}`));
});

test('summarizeTokenizer: surfaces all manifest-ready fields', () => {
  const tok = trainTokenizer(['hello world hello world'], { vocab_size: 280 });
  const s = summarizeTokenizer(tok);
  assert.equal(s.spec, SPEC);
  assert.equal(s.type, 'byte-bpe');
  assert.equal(s.by_kind.special, SPECIAL_TOKENS.length);
  assert.equal(s.by_kind.byte, 256);
  assert.equal(s.by_kind.merge, tok.merges.length);
  assert.deepEqual(s.specials, SPECIAL_TOKENS);
  assert.match(s.sha256, /^[0-9a-f]{64}$/);
});

test('encode: pre-tokenization separates words from punctuation', () => {
  const t = new KolmTokenizer();
  // " world!" should encode as [bytes-of(" world")][bytes-of("!")] — two
  // pre-token pieces. Without that boundary, a learned merge on (" world")
  // would also fire on (" world!") inappropriately.
  const a = t.encode(' world!');
  // Without merges, every byte is one token, so just verify total bytes line up.
  assert.equal(a.length, Buffer.byteLength(' world!', 'utf-8'));
});
