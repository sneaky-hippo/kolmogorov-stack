// rule-dsl-v1 — constrained AST for kolm rule recipes.
//
// Wave F (compiled_rule class) needs to ship .kolm artifacts whose recipes are
// authored as a tiny structured AST rather than free-form JavaScript. The same
// AST is then emitted to:
//   - JavaScript (the artifact-runner already runs JS, so the JS path keeps
//     working without changes)
//   - C99 source (native.c) — emitted into the .kolm for Wave G to compile
//   - Rust source (native.rs) — emitted into the .kolm for Wave G to compile
//
// The DSL is intentionally tiny. It expresses lookup/normalize/format style
// rules (greeter, phone normalizer, SSN redactor, ICD-10 lookup) — the recipe
// class the user singled out as "deterministic finite-state transformations"
// (plan §3.1). Anything more complicated (model-class recipes) goes through
// the distilled_model class in Wave J/K, not through this DSL.
//
// Op set (closed):
//   lit          literal JSON value (string|number|bool|null|object|array)
//   input        raw input value (string in compiled_rule; any in JS)
//   field        object[key] - JS-only by default; compiled_rule restricts
//                to top-level field-of-input (JSON-extracted via literal scan)
//   concat       string join
//   lower|upper  ASCII case map
//   trim         strip leading/trailing ASCII whitespace
//   replace      literal substring replace (no regex syntax in Wave F)
//   contains     literal substring contains -> bool
//   keep_chars   filter to set 'digits'|'alphanum'|'letters'
//   strip_chars  remove any char in `chars` (literal set)
//   substr       arg.slice(start, start+length)
//   eq           strict equality (a === b) -> bool
//   len          string length -> number
//   lookup       table[key] with default (table values may be any JSON value)
//   if           cond ? then : else
//   object       build a JSON object literal { k: expr, ... }
//
// Non-goals for Wave F:
//   - regular expressions (Wave G adds POSIX regex.h + the regex crate)
//   - mutable state, loops, function calls
//   - per-row evaluation (every recipe consumes ONE input and emits ONE output)
//
// This module is dep-free (only `node:crypto`) so it can be loaded by the CLI,
// the build pipeline, and tests without dragging in archiver/express/etc.

import crypto from 'node:crypto';

export const DSL_SPEC = 'rule-dsl-v1';

const OPS = [
  'lit', 'input', 'field', 'concat',
  'lower', 'upper', 'trim',
  'replace', 'contains', 'keep_chars', 'strip_chars', 'substr',
  'eq', 'len', 'lookup', 'if', 'object',
];

const CHAR_SETS = ['digits', 'alphanum', 'letters'];

function dslError(msg, code = 'KOLM_E_DSL_INVALID') {
  const e = new Error(msg);
  e.code = code;
  return e;
}

export function validateDsl(dsl, opts = {}) {
  if (!dsl || typeof dsl !== 'object' || Array.isArray(dsl)) {
    throw dslError('dsl must be an object');
  }
  if (dsl.type !== DSL_SPEC) {
    throw dslError(`dsl.type must be ${JSON.stringify(DSL_SPEC)}, got ${JSON.stringify(dsl.type)}`);
  }
  if (!dsl.output) throw dslError('dsl.output expression required');
  validateExpr(dsl.output, 'output');
  if (Array.isArray(opts.targets)) {
    for (const t of opts.targets) {
      if (t === 'c' || t === 'rust' || t === 'wasm') checkCompilable(dsl.output, 'output', t);
    }
  }
  return true;
}

function validateExpr(node, path) {
  if (node === null || typeof node !== 'object' || Array.isArray(node)) {
    throw dslError(`${path}: expected expression object`);
  }
  if (typeof node.op !== 'string' || !OPS.includes(node.op)) {
    throw dslError(`${path}: unknown op ${JSON.stringify(node.op)}`);
  }
  switch (node.op) {
    case 'lit':
      if (!('value' in node)) throw dslError(`${path}: lit requires value`);
      break;
    case 'input':
      break;
    case 'field':
      if (!node.from) throw dslError(`${path}: field requires from`);
      if (typeof node.key !== 'string' || !node.key.length) throw dslError(`${path}: field.key must be non-empty string`);
      validateExpr(node.from, `${path}.from`);
      break;
    case 'concat':
      if (!Array.isArray(node.parts)) throw dslError(`${path}: concat.parts must be array`);
      node.parts.forEach((p, i) => validateExpr(p, `${path}.parts[${i}]`));
      break;
    case 'lower':
    case 'upper':
    case 'trim':
    case 'len':
      if (!node.arg) throw dslError(`${path}: ${node.op} requires arg`);
      validateExpr(node.arg, `${path}.arg`);
      break;
    case 'replace':
      if (!node.arg) throw dslError(`${path}: replace requires arg`);
      if (typeof node.find !== 'string') throw dslError(`${path}: replace.find must be string`);
      if (typeof node.replace !== 'string') throw dslError(`${path}: replace.replace must be string`);
      if (!node.find.length) throw dslError(`${path}: replace.find must be non-empty`);
      validateExpr(node.arg, `${path}.arg`);
      break;
    case 'contains':
      if (!node.arg) throw dslError(`${path}: contains requires arg`);
      if (typeof node.find !== 'string' || !node.find.length) throw dslError(`${path}: contains.find must be non-empty string`);
      validateExpr(node.arg, `${path}.arg`);
      break;
    case 'keep_chars':
      if (!node.arg) throw dslError(`${path}: keep_chars requires arg`);
      if (!CHAR_SETS.includes(node.set)) {
        throw dslError(`${path}: keep_chars.set must be one of ${CHAR_SETS.join('|')}`);
      }
      validateExpr(node.arg, `${path}.arg`);
      break;
    case 'strip_chars':
      if (!node.arg) throw dslError(`${path}: strip_chars requires arg`);
      if (typeof node.chars !== 'string' || !node.chars.length) {
        throw dslError(`${path}: strip_chars.chars must be non-empty string`);
      }
      validateExpr(node.arg, `${path}.arg`);
      break;
    case 'substr':
      if (!node.arg) throw dslError(`${path}: substr requires arg`);
      if (!Number.isInteger(node.start) || node.start < 0) throw dslError(`${path}: substr.start must be non-negative integer`);
      if (node.length !== undefined && (!Number.isInteger(node.length) || node.length < 0)) {
        throw dslError(`${path}: substr.length must be non-negative integer`);
      }
      validateExpr(node.arg, `${path}.arg`);
      break;
    case 'eq':
      if (!node.a || !node.b) throw dslError(`${path}: eq requires a and b`);
      validateExpr(node.a, `${path}.a`);
      validateExpr(node.b, `${path}.b`);
      break;
    case 'lookup':
      if (!node.key) throw dslError(`${path}: lookup requires key`);
      if (!node.cases || typeof node.cases !== 'object' || Array.isArray(node.cases)) {
        throw dslError(`${path}: lookup.cases must be object`);
      }
      if (!('default' in node)) throw dslError(`${path}: lookup.default required`);
      validateExpr(node.key, `${path}.key`);
      if (node.default && typeof node.default === 'object' && !Array.isArray(node.default) && typeof node.default.op === 'string') {
        validateExpr(node.default, `${path}.default`);
      }
      break;
    case 'if':
      if (!node.cond || !node.then || !node.else) throw dslError(`${path}: if requires cond, then, else`);
      validateExpr(node.cond, `${path}.cond`);
      validateExpr(node.then, `${path}.then`);
      validateExpr(node.else, `${path}.else`);
      break;
    case 'object':
      if (!node.fields || typeof node.fields !== 'object' || Array.isArray(node.fields)) {
        throw dslError(`${path}: object.fields required`);
      }
      for (const k of Object.keys(node.fields)) validateExpr(node.fields[k], `${path}.fields.${k}`);
      break;
  }
}

function checkCompilable(node, path, target) {
  // Wave F restriction: in compiled-rule C/Rust codegen, `field` only works
  // at the top level over the raw input (it expands to a literal JSON-key
  // scan, no recursion).
  if (node.op === 'field') {
    if (!node.from || node.from.op !== 'input') {
      throw dslError(`${path}: compiled-rule '${target}' codegen only supports field-of-input; nested field traversal is JS-only`);
    }
    return;
  }
  const kids = [];
  for (const k of ['from', 'arg', 'a', 'b', 'cond', 'then', 'else', 'key']) {
    if (node[k] && typeof node[k] === 'object' && typeof node[k].op === 'string') kids.push([node[k], `${path}.${k}`]);
  }
  if (Array.isArray(node.parts)) node.parts.forEach((p, i) => kids.push([p, `${path}.parts[${i}]`]));
  if (node.fields && typeof node.fields === 'object') {
    for (const k of Object.keys(node.fields)) kids.push([node.fields[k], `${path}.fields.${k}`]);
  }
  if (node.default && typeof node.default === 'object' && typeof node.default.op === 'string') {
    kids.push([node.default, `${path}.default`]);
  }
  for (const [k, p] of kids) checkCompilable(k, p, target);
}

// ---------------------------------------------------------------------------
// JS interpreter — used by tests and as the runtime fallback for compiled_rule
// artifacts until Wave G wires actual native execution. The emitJs codegen
// below produces a function with equivalent semantics so artifact-runner.js
// works unchanged.
// ---------------------------------------------------------------------------

export function interpretDsl(dsl, input) {
  validateDsl(dsl);
  return evalNode(dsl.output, input);
}

function toStr(v) {
  if (v == null) return '';
  if (typeof v === 'string') return v;
  if (typeof v === 'boolean' || typeof v === 'number') return String(v);
  try { return JSON.stringify(v); } catch { return ''; }
}

function evalNode(node, input) {
  switch (node.op) {
    case 'lit': return node.value;
    case 'input': return input;
    case 'field': {
      const o = evalNode(node.from, input);
      if (o == null || typeof o !== 'object') return '';
      const v = o[node.key];
      return v === undefined ? '' : v;
    }
    case 'concat':
      return node.parts.map(p => toStr(evalNode(p, input))).join('');
    case 'lower': return toStr(evalNode(node.arg, input)).toLowerCase();
    case 'upper': return toStr(evalNode(node.arg, input)).toUpperCase();
    case 'trim': return toStr(evalNode(node.arg, input)).trim();
    case 'len': return toStr(evalNode(node.arg, input)).length;
    case 'replace': {
      const s = toStr(evalNode(node.arg, input));
      return s.split(node.find).join(node.replace);
    }
    case 'contains': return toStr(evalNode(node.arg, input)).indexOf(node.find) >= 0;
    case 'keep_chars': {
      const s = toStr(evalNode(node.arg, input));
      const pred = charPredicate(node.set);
      let out = '';
      for (let i = 0; i < s.length; i++) if (pred(s.charCodeAt(i))) out += s[i];
      return out;
    }
    case 'strip_chars': {
      const s = toStr(evalNode(node.arg, input));
      const set = new Set(Array.from(node.chars));
      let out = '';
      for (let i = 0; i < s.length; i++) if (!set.has(s[i])) out += s[i];
      return out;
    }
    case 'substr': {
      const s = toStr(evalNode(node.arg, input));
      const end = node.length === undefined ? s.length : node.start + node.length;
      return s.slice(node.start, end);
    }
    case 'eq': return evalNode(node.a, input) === evalNode(node.b, input);
    case 'lookup': {
      const k = toStr(evalNode(node.key, input));
      if (Object.prototype.hasOwnProperty.call(node.cases, k)) return node.cases[k];
      if (node.default && typeof node.default === 'object' && !Array.isArray(node.default) && typeof node.default.op === 'string') {
        return evalNode(node.default, input);
      }
      return node.default;
    }
    case 'if': return evalNode(node.cond, input) ? evalNode(node.then, input) : evalNode(node.else, input);
    case 'object': {
      const o = {};
      for (const k of Object.keys(node.fields)) o[k] = evalNode(node.fields[k], input);
      return o;
    }
  }
}

function charPredicate(set) {
  if (set === 'digits') return (c) => c >= 48 && c <= 57;
  if (set === 'alphanum') return (c) => (c >= 48 && c <= 57) || (c >= 65 && c <= 90) || (c >= 97 && c <= 122);
  return (c) => (c >= 65 && c <= 90) || (c >= 97 && c <= 122); // letters
}

// ---------------------------------------------------------------------------
// JavaScript codegen. Produces a `function generate(input, lib) { ... }`
// string. The output is wrapped in an IIFE so each operand is evaluated once
// (no double-eval bugs from naive expression composition).
// ---------------------------------------------------------------------------

export function emitJs(dsl) {
  validateDsl(dsl);
  const body = jsExpr(dsl.output);
  return `function generate(input, lib) {\n  return ${body};\n}\n`;
}

function jsLit(v) { return JSON.stringify(v); }

function jsCoerceStr(expr) {
  return `(function(__v){return __v==null?"":(typeof __v==="string"?__v:String(__v));})(${expr})`;
}

function jsExpr(n) {
  switch (n.op) {
    case 'lit': return jsLit(n.value);
    case 'input': return 'input';
    case 'field':
      return `(function(__o){return (__o==null||typeof __o!=="object")?"":(__o[${jsLit(n.key)}]===undefined?"":__o[${jsLit(n.key)}]);})(${jsExpr(n.from)})`;
    case 'concat':
      return `[${n.parts.map(jsExpr).join(',')}].map(function(__v){return __v==null?"":(typeof __v==="string"?__v:String(__v));}).join("")`;
    case 'lower':
      return `(function(__s){return __s.toLowerCase();})(${jsCoerceStr(jsExpr(n.arg))})`;
    case 'upper':
      return `(function(__s){return __s.toUpperCase();})(${jsCoerceStr(jsExpr(n.arg))})`;
    case 'trim':
      return `(function(__s){return __s.replace(/^[\\s\\u00a0]+|[\\s\\u00a0]+$/g,"");})(${jsCoerceStr(jsExpr(n.arg))})`;
    case 'len':
      return `(function(__s){return __s.length;})(${jsCoerceStr(jsExpr(n.arg))})`;
    case 'replace':
      return `(function(__s){return __s.split(${jsLit(n.find)}).join(${jsLit(n.replace)});})(${jsCoerceStr(jsExpr(n.arg))})`;
    case 'contains':
      return `(function(__s){return __s.indexOf(${jsLit(n.find)})>=0;})(${jsCoerceStr(jsExpr(n.arg))})`;
    case 'keep_chars': {
      const setBranch = n.set === 'digits'
        ? '(c>=48&&c<=57)'
        : (n.set === 'alphanum'
            ? '((c>=48&&c<=57)||(c>=65&&c<=90)||(c>=97&&c<=122))'
            : '((c>=65&&c<=90)||(c>=97&&c<=122))');
      return `(function(__s){var __o="";for(var __i=0;__i<__s.length;__i++){var c=__s.charCodeAt(__i);if(${setBranch})__o+=__s[__i];}return __o;})(${jsCoerceStr(jsExpr(n.arg))})`;
    }
    case 'strip_chars':
      return `(function(__s){var __r=${jsLit(n.chars)};var __o="";for(var __i=0;__i<__s.length;__i++){if(__r.indexOf(__s[__i])<0)__o+=__s[__i];}return __o;})(${jsCoerceStr(jsExpr(n.arg))})`;
    case 'substr': {
      const len = n.length === undefined ? 'undefined' : String(n.length);
      return `(function(__s){var __e=${len}===undefined?__s.length:${n.start}+${len};return __s.slice(${n.start}, __e);})(${jsCoerceStr(jsExpr(n.arg))})`;
    }
    case 'eq': return `((${jsExpr(n.a)})===(${jsExpr(n.b)}))`;
    case 'lookup': {
      const tableLit = jsLit(n.cases);
      const defExpr = (n.default && typeof n.default === 'object' && !Array.isArray(n.default) && typeof n.default.op === 'string')
        ? jsExpr(n.default)
        : jsLit(n.default);
      return `(function(__k){var __t=${tableLit};return Object.hasOwn(__t,__k)?__t[__k]:(${defExpr});})(${jsCoerceStr(jsExpr(n.key))})`;
    }
    case 'if':
      return `((${jsExpr(n.cond)}) ? (${jsExpr(n.then)}) : (${jsExpr(n.else)}))`;
    case 'object': {
      const parts = Object.keys(n.fields).map(k => `${jsLit(k)}:(${jsExpr(n.fields[k])})`);
      return `({${parts.join(',')}})`;
    }
  }
}

// ---------------------------------------------------------------------------
// C99 codegen. Produces a self-contained `native.c` with:
//   - A small string-arena allocator (intermediate strings tracked, freed at
//     end of `kolm_run`)
//   - `kolm_run(const char* input)` returning `char*` the caller must free
// The output is a JSON-string when the recipe returns an object/array (per
// Wave F restriction: native binary path always returns a string; the JS
// path keeps its richer return type).
// Wave G adds optional native compilation (cc/clang). Wave F only emits the
// source so the artifact zip is hash-bound to a real C source even when no
// toolchain is present on the build host.
// ---------------------------------------------------------------------------

export function emitC(dsl, opts = {}) {
  validateDsl(dsl, { targets: ['c'] });
  const recipeName = opts.recipeName || 'kolm_recipe';
  const lit = (v) => cStringLiteral(JSON.stringify(v));
  const compiler = { tmpCounter: 0, helpers: new Set() };
  const exprC = cExpr(dsl.output, compiler);
  const helpers = C_HELPERS_BASE + Array.from(compiler.helpers).sort().join('\n');
  return `${C_HEADER}\n${helpers}\n\n` +
    `/* Entry point. Caller owns the returned buffer (free()). */\n` +
    `char* kolm_run(const char* input) {\n` +
    `  kolm_arena_t* a = kolm_arena_new();\n` +
    `  const char* __in = input == NULL ? "" : input;\n` +
    `  const char* __result = ${exprC};\n` +
    `  char* out = strdup(__result);\n` +
    `  kolm_arena_free(a);\n` +
    `  return out;\n` +
    `}\n\n` +
    `/* Recipe metadata. */\n` +
    `const char* kolm_recipe_name(void) { return ${cStringLiteral(recipeName)}; }\n` +
    `const char* kolm_recipe_spec(void) { return ${cStringLiteral(DSL_SPEC)}; }\n`;
}

const C_HEADER = `/*
 * native.c — emitted by kolm rule-dsl-v1 codegen.
 * Compile: cc -std=c99 -O2 native.c -o native
 * Run:     ./native '<input string>'
 *
 * Generated. Do not edit by hand. Source of truth is the recipe spec in the
 * .kolm manifest (recipes.json, dsl block).
 */

#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <ctype.h>
#include <stddef.h>

typedef struct kolm_arena_node {
  void* p;
  struct kolm_arena_node* next;
} kolm_arena_node_t;

typedef struct {
  kolm_arena_node_t* head;
} kolm_arena_t;

static kolm_arena_t* kolm_arena_new(void) {
  kolm_arena_t* a = (kolm_arena_t*)malloc(sizeof(kolm_arena_t));
  if (!a) return NULL;
  a->head = NULL;
  return a;
}

static char* kolm_arena_track(kolm_arena_t* a, char* p) {
  if (!a || !p) return p;
  kolm_arena_node_t* n = (kolm_arena_node_t*)malloc(sizeof(kolm_arena_node_t));
  if (!n) return p;
  n->p = p;
  n->next = a->head;
  a->head = n;
  return p;
}

static void kolm_arena_free(kolm_arena_t* a) {
  if (!a) return;
  kolm_arena_node_t* n = a->head;
  while (n) {
    kolm_arena_node_t* next = n->next;
    free(n->p);
    free(n);
    n = next;
  }
  free(a);
}`;

const C_HELPERS_BASE = `
static char* k_strdup_a(kolm_arena_t* a, const char* s) {
  if (!s) s = "";
  size_t n = strlen(s);
  char* p = (char*)malloc(n + 1);
  memcpy(p, s, n + 1);
  return kolm_arena_track(a, p);
}

static char* k_lower(kolm_arena_t* a, const char* s) {
  if (!s) s = "";
  size_t n = strlen(s);
  char* p = (char*)malloc(n + 1);
  for (size_t i = 0; i < n; ++i) {
    unsigned char c = (unsigned char)s[i];
    p[i] = (c >= 'A' && c <= 'Z') ? (char)(c + 32) : (char)c;
  }
  p[n] = '\\0';
  return kolm_arena_track(a, p);
}

static char* k_upper(kolm_arena_t* a, const char* s) {
  if (!s) s = "";
  size_t n = strlen(s);
  char* p = (char*)malloc(n + 1);
  for (size_t i = 0; i < n; ++i) {
    unsigned char c = (unsigned char)s[i];
    p[i] = (c >= 'a' && c <= 'z') ? (char)(c - 32) : (char)c;
  }
  p[n] = '\\0';
  return kolm_arena_track(a, p);
}

static char* k_trim(kolm_arena_t* a, const char* s) {
  if (!s) s = "";
  const char* start = s;
  while (*start && isspace((unsigned char)*start)) ++start;
  const char* end = s + strlen(s);
  while (end > start && isspace((unsigned char)*(end - 1))) --end;
  size_t n = (size_t)(end - start);
  char* p = (char*)malloc(n + 1);
  memcpy(p, start, n);
  p[n] = '\\0';
  return kolm_arena_track(a, p);
}

static size_t k_len(const char* s) { return s ? strlen(s) : 0; }

static char* k_concat(kolm_arena_t* a, size_t n, const char** parts) {
  size_t total = 0;
  for (size_t i = 0; i < n; ++i) total += parts[i] ? strlen(parts[i]) : 0;
  char* p = (char*)malloc(total + 1);
  size_t off = 0;
  for (size_t i = 0; i < n; ++i) {
    if (!parts[i]) continue;
    size_t L = strlen(parts[i]);
    memcpy(p + off, parts[i], L);
    off += L;
  }
  p[off] = '\\0';
  return kolm_arena_track(a, p);
}

static char* k_replace(kolm_arena_t* a, const char* s, const char* find, const char* repl) {
  if (!s) s = ""; if (!find || !*find) return k_strdup_a(a, s);
  if (!repl) repl = "";
  size_t fl = strlen(find), rl = strlen(repl), sl = strlen(s);
  size_t count = 0;
  for (const char* p = s; (p = strstr(p, find)); p += fl) ++count;
  size_t out_len = sl + count * (rl > fl ? rl - fl : 0) - count * (fl > rl ? fl - rl : 0);
  char* out = (char*)malloc(out_len + 1);
  char* w = out;
  const char* r = s;
  for (;;) {
    const char* hit = strstr(r, find);
    if (!hit) { strcpy(w, r); break; }
    size_t lead = (size_t)(hit - r);
    memcpy(w, r, lead); w += lead;
    memcpy(w, repl, rl); w += rl;
    r = hit + fl;
  }
  return kolm_arena_track(a, out);
}

static int k_contains(const char* s, const char* find) {
  if (!s || !find || !*find) return 0;
  return strstr(s, find) != NULL ? 1 : 0;
}

static char* k_keep_digits(kolm_arena_t* a, const char* s) {
  if (!s) s = "";
  size_t n = strlen(s);
  char* p = (char*)malloc(n + 1);
  size_t w = 0;
  for (size_t i = 0; i < n; ++i) if (s[i] >= '0' && s[i] <= '9') p[w++] = s[i];
  p[w] = '\\0';
  return kolm_arena_track(a, p);
}

static char* k_keep_alphanum(kolm_arena_t* a, const char* s) {
  if (!s) s = "";
  size_t n = strlen(s);
  char* p = (char*)malloc(n + 1);
  size_t w = 0;
  for (size_t i = 0; i < n; ++i) {
    unsigned char c = (unsigned char)s[i];
    if ((c >= '0' && c <= '9') || (c >= 'A' && c <= 'Z') || (c >= 'a' && c <= 'z')) p[w++] = s[i];
  }
  p[w] = '\\0';
  return kolm_arena_track(a, p);
}

static char* k_keep_letters(kolm_arena_t* a, const char* s) {
  if (!s) s = "";
  size_t n = strlen(s);
  char* p = (char*)malloc(n + 1);
  size_t w = 0;
  for (size_t i = 0; i < n; ++i) {
    unsigned char c = (unsigned char)s[i];
    if ((c >= 'A' && c <= 'Z') || (c >= 'a' && c <= 'z')) p[w++] = s[i];
  }
  p[w] = '\\0';
  return kolm_arena_track(a, p);
}

static char* k_strip_chars(kolm_arena_t* a, const char* s, const char* chars) {
  if (!s) s = ""; if (!chars) chars = "";
  size_t n = strlen(s);
  char* p = (char*)malloc(n + 1);
  size_t w = 0;
  for (size_t i = 0; i < n; ++i) if (!strchr(chars, s[i])) p[w++] = s[i];
  p[w] = '\\0';
  return kolm_arena_track(a, p);
}

static char* k_substr(kolm_arena_t* a, const char* s, size_t start, size_t length, int has_length) {
  if (!s) s = "";
  size_t sl = strlen(s);
  if (start > sl) start = sl;
  size_t L = has_length ? length : (sl - start);
  if (start + L > sl) L = sl - start;
  char* p = (char*)malloc(L + 1);
  memcpy(p, s + start, L);
  p[L] = '\\0';
  return kolm_arena_track(a, p);
}

static int k_eq_str(const char* a_, const char* b_) {
  if (!a_) a_ = ""; if (!b_) b_ = "";
  return strcmp(a_, b_) == 0 ? 1 : 0;
}

/* Minimal JSON-key extractor for top-level field-of-input.
 * Linear scan for "<key>": then either a quoted string value or a bareword.
 * Quotation handling: \\" inside the value is honored as not-end-of-string;
 * other escapes are passed through. Sufficient for the compiled_rule MVP.
 * Wave G refinement adds full JSON5/string-escape decoding. */
static char* k_field_of_input(kolm_arena_t* a, const char* input, const char* key) {
  if (!input || !key) return k_strdup_a(a, "");
  size_t kl = strlen(key);
  size_t in_len = strlen(input);
  const char* anchor = NULL;
  if (in_len >= kl + 3) {
    for (size_t i = 0; i + kl + 2 < in_len; ++i) {
      if (input[i] == '"' && memcmp(input + i + 1, key, kl) == 0
          && input[i + 1 + kl] == '"' && input[i + 2 + kl] == ':') {
        anchor = input + i + 3 + kl;
        break;
      }
    }
  }
  if (!anchor) return k_strdup_a(a, "");
  while (*anchor == ' ' || *anchor == '\\t') ++anchor;
  if (*anchor == '"') {
    ++anchor;
    const char* start = anchor;
    while (*anchor) {
      if (*anchor == '\\\\' && anchor[1]) { anchor += 2; continue; }
      if (*anchor == '"') break;
      ++anchor;
    }
    size_t n = (size_t)(anchor - start);
    char* out = (char*)malloc(n + 1);
    memcpy(out, start, n); out[n] = '\\0';
    return kolm_arena_track(a, out);
  }
  /* Non-string value: copy until separator. */
  const char* start = anchor;
  while (*anchor && *anchor != ',' && *anchor != '}' && *anchor != ']' && *anchor != '\\n') ++anchor;
  size_t n = (size_t)(anchor - start);
  while (n && (start[n-1] == ' ' || start[n-1] == '\\t')) --n;
  char* out = (char*)malloc(n + 1);
  memcpy(out, start, n); out[n] = '\\0';
  return kolm_arena_track(a, out);
}

`;

function cStringLiteral(s) {
  let out = '"';
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (s[i] === '\\') out += '\\\\';
    else if (s[i] === '"') out += '\\"';
    else if (s[i] === '\n') out += '\\n';
    else if (s[i] === '\r') out += '\\r';
    else if (s[i] === '\t') out += '\\t';
    else if (c < 32) out += '\\x' + c.toString(16).padStart(2, '0');
    else if (c >= 127) {
      const hex = c.toString(16);
      out += '\\u' + hex.padStart(4, '0');
    } else {
      out += s[i];
    }
  }
  out += '"';
  return out;
}

function cExpr(n, ctx) {
  switch (n.op) {
    case 'lit': {
      const j = JSON.stringify(n.value);
      return cStringLiteral(j === undefined ? '' : (typeof n.value === 'string' ? n.value : j));
    }
    case 'input': return '__in';
    case 'field':
      return `k_field_of_input(a, __in, ${cStringLiteral(n.key)})`;
    case 'concat': {
      const arrName = `__cparts_${ctx.tmpCounter++}`;
      const items = n.parts.map(p => cExpr(p, ctx));
      return `({ const char* ${arrName}[] = { ${items.join(', ')} }; k_concat(a, sizeof(${arrName})/sizeof(${arrName}[0]), ${arrName}); })`;
    }
    case 'lower': return `k_lower(a, ${cExpr(n.arg, ctx)})`;
    case 'upper': return `k_upper(a, ${cExpr(n.arg, ctx)})`;
    case 'trim':  return `k_trim(a, ${cExpr(n.arg, ctx)})`;
    case 'len': {
      // len returns size_t; we coerce to a string for downstream concat/eq.
      // For eq with a numeric literal we compare as size_t — codegen handles
      // that in the eq branch.
      return `({ char __nbuf[32]; snprintf(__nbuf, sizeof(__nbuf), \"%zu\", k_len(${cExpr(n.arg, ctx)})); k_strdup_a(a, __nbuf); })`;
    }
    case 'replace':
      return `k_replace(a, ${cExpr(n.arg, ctx)}, ${cStringLiteral(n.find)}, ${cStringLiteral(n.replace)})`;
    case 'contains':
      // Returns "true"/"false" as a string so it composes with eq/concat.
      return `(k_contains(${cExpr(n.arg, ctx)}, ${cStringLiteral(n.find)}) ? "true" : "false")`;
    case 'keep_chars':
      if (n.set === 'digits') return `k_keep_digits(a, ${cExpr(n.arg, ctx)})`;
      if (n.set === 'alphanum') return `k_keep_alphanum(a, ${cExpr(n.arg, ctx)})`;
      return `k_keep_letters(a, ${cExpr(n.arg, ctx)})`;
    case 'strip_chars':
      return `k_strip_chars(a, ${cExpr(n.arg, ctx)}, ${cStringLiteral(n.chars)})`;
    case 'substr': {
      const hasLen = n.length === undefined ? 0 : 1;
      const L = n.length === undefined ? 0 : n.length;
      return `k_substr(a, ${cExpr(n.arg, ctx)}, ${n.start}, ${L}, ${hasLen})`;
    }
    case 'eq':
      return `(k_eq_str(${cExpr(n.a, ctx)}, ${cExpr(n.b, ctx)}) ? "true" : "false")`;
    case 'lookup': {
      const tname = `__tbl_${ctx.tmpCounter++}`;
      const rows = Object.keys(n.cases).map(k => {
        const v = n.cases[k];
        const vs = (typeof v === 'string') ? v : JSON.stringify(v);
        return `  { ${cStringLiteral(k)}, ${cStringLiteral(vs)} }`;
      });
      const defExpr = (n.default && typeof n.default === 'object' && !Array.isArray(n.default) && typeof n.default.op === 'string')
        ? cExpr(n.default, ctx)
        : cStringLiteral(typeof n.default === 'string' ? n.default : JSON.stringify(n.default));
      const helperName = `__lookup_${ctx.tmpCounter++}`;
      ctx.helpers.add(
`static const struct { const char* k; const char* v; } ${tname}[] = {
${rows.join(',\n')}
};
static const size_t ${tname}_n = sizeof(${tname})/sizeof(${tname}[0]);
static const char* ${helperName}(kolm_arena_t* a, const char* key, const char* def) {
  for (size_t i = 0; i < ${tname}_n; ++i) {
    if (strcmp(${tname}[i].k, key) == 0) return ${tname}[i].v;
  }
  (void)a;
  return def;
}`);
      return `${helperName}(a, ${cExpr(n.key, ctx)}, ${defExpr})`;
    }
    case 'if':
      return `(strcmp(${cExpr(n.cond, ctx)}, "true") == 0 ? ${cExpr(n.then, ctx)} : ${cExpr(n.else, ctx)})`;
    case 'object': {
      // Serialize the object as a JSON literal where each field's expression
      // value is JSON-quoted at run time. The current MVP serializes the
      // value as a STRING field. Richer typing (numbers/bools) is a Wave-G
      // refinement.
      const arrName = `__oparts_${ctx.tmpCounter++}`;
      const parts = [];
      parts.push(cStringLiteral('{'));
      const keys = Object.keys(n.fields);
      keys.forEach((k, i) => {
        if (i > 0) parts.push(cStringLiteral(','));
        parts.push(cStringLiteral(JSON.stringify(k) + ':"'));
        parts.push(cExpr(n.fields[k], ctx));
        parts.push(cStringLiteral('"'));
      });
      parts.push(cStringLiteral('}'));
      return `({ const char* ${arrName}[] = { ${parts.join(', ')} }; k_concat(a, sizeof(${arrName})/sizeof(${arrName}[0]), ${arrName}); })`;
    }
  }
}

// ---------------------------------------------------------------------------
// Rust codegen. Produces a self-contained `native.rs` with:
//   - `pub fn run(input: &str) -> String`
//   - small helper functions equivalent to the C helpers
// Wave F emits source only. Wave G adds optional `cargo build` invocation when
// a Rust toolchain is detected.
// ---------------------------------------------------------------------------

export function emitRust(dsl, opts = {}) {
  validateDsl(dsl, { targets: ['rust'] });
  const recipeName = opts.recipeName || 'kolm_recipe';
  const ctx = { tmpCounter: 0, tables: [] };
  const body = rsExpr(dsl.output, ctx);
  const tables = ctx.tables.length ? '\n' + ctx.tables.join('\n') + '\n' : '';
  return `${RS_HEADER}\n${RS_HELPERS}\n${tables}\n` +
    `pub fn run(input: &str) -> String {\n` +
    `    let __in: &str = input;\n` +
    `    let __result: String = ${body};\n` +
    `    __result\n` +
    `}\n\n` +
    `pub fn recipe_name() -> &'static str { ${rsLit(recipeName)} }\n` +
    `pub fn recipe_spec() -> &'static str { ${rsLit(DSL_SPEC)} }\n`;
}

const RS_HEADER = `// native.rs — emitted by kolm rule-dsl-v1 codegen.
// Compile: rustc --edition 2021 -O native.rs -o native --crate-type bin
// or place in a crate's lib.rs and add a #[no_mangle] extern "C" wrapper.
// Generated. Do not edit by hand.

#![allow(unused_parens, unused_variables, dead_code, clippy::all)]`;

const RS_HELPERS = `
fn k_lower(s: &str) -> String { s.to_ascii_lowercase() }
fn k_upper(s: &str) -> String { s.to_ascii_uppercase() }
fn k_trim(s: &str) -> String { s.trim().to_string() }
fn k_len(s: &str) -> usize { s.chars().count() }

fn k_replace(s: &str, find: &str, repl: &str) -> String {
    if find.is_empty() { return s.to_string(); }
    s.replace(find, repl)
}

fn k_contains(s: &str, find: &str) -> bool {
    if find.is_empty() { return false; }
    s.contains(find)
}

fn k_keep_digits(s: &str) -> String {
    s.chars().filter(|c| c.is_ascii_digit()).collect()
}
fn k_keep_alphanum(s: &str) -> String {
    s.chars().filter(|c| c.is_ascii_alphanumeric()).collect()
}
fn k_keep_letters(s: &str) -> String {
    s.chars().filter(|c| c.is_ascii_alphabetic()).collect()
}
fn k_strip_chars(s: &str, chars: &str) -> String {
    s.chars().filter(|c| !chars.contains(*c)).collect()
}
fn k_substr(s: &str, start: usize, length: Option<usize>) -> String {
    let chars: Vec<char> = s.chars().collect();
    let sl = chars.len();
    let start = if start > sl { sl } else { start };
    let end = match length {
        Some(L) => std::cmp::min(start + L, sl),
        None => sl,
    };
    chars[start..end].iter().collect()
}

fn k_eq_str(a: &str, b: &str) -> bool { a == b }

fn k_field_of_input(input: &str, key: &str) -> String {
    let needle = format!("\\"{}\\":", key);
    let mut idx = 0usize;
    let bytes = input.as_bytes();
    let nb = needle.as_bytes();
    if input.len() < needle.len() { return String::new(); }
    let mut found: Option<usize> = None;
    while idx + nb.len() <= bytes.len() {
        if &bytes[idx..idx+nb.len()] == nb {
            found = Some(idx + nb.len());
            break;
        }
        idx += 1;
    }
    let start = match found { Some(p) => p, None => return String::new() };
    let rest = &input[start..];
    let trimmed = rest.trim_start();
    if trimmed.starts_with('"') {
        let after = &trimmed[1..];
        let mut out = String::new();
        let mut prev_bs = false;
        for c in after.chars() {
            if prev_bs { out.push(c); prev_bs = false; continue; }
            if c == '\\\\' { prev_bs = true; continue; }
            if c == '"' { break; }
            out.push(c);
        }
        return out;
    }
    let end = trimmed.find(|c: char| c == ',' || c == '}' || c == ']' || c == '\\n').unwrap_or(trimmed.len());
    trimmed[..end].trim().to_string()
}
`;

function rsLit(v) {
  return JSON.stringify(typeof v === 'string' ? v : JSON.stringify(v));
}

function rsExpr(n, ctx) {
  switch (n.op) {
    case 'lit': {
      const s = typeof n.value === 'string' ? n.value : JSON.stringify(n.value);
      return `${JSON.stringify(s)}.to_string()`;
    }
    case 'input':
      return `__in.to_string()`;
    case 'field':
      return `k_field_of_input(__in, ${JSON.stringify(n.key)})`;
    case 'concat':
      return `{ let __parts: Vec<String> = vec![${n.parts.map(p => rsExpr(p, ctx)).join(', ')}]; __parts.concat() }`;
    case 'lower':  return `k_lower(&(${rsExpr(n.arg, ctx)}))`;
    case 'upper':  return `k_upper(&(${rsExpr(n.arg, ctx)}))`;
    case 'trim':   return `k_trim(&(${rsExpr(n.arg, ctx)}))`;
    case 'len':    return `k_len(&(${rsExpr(n.arg, ctx)})).to_string()`;
    case 'replace':
      return `k_replace(&(${rsExpr(n.arg, ctx)}), ${JSON.stringify(n.find)}, ${JSON.stringify(n.replace)})`;
    case 'contains':
      return `(if k_contains(&(${rsExpr(n.arg, ctx)}), ${JSON.stringify(n.find)}) { "true".to_string() } else { "false".to_string() })`;
    case 'keep_chars':
      if (n.set === 'digits') return `k_keep_digits(&(${rsExpr(n.arg, ctx)}))`;
      if (n.set === 'alphanum') return `k_keep_alphanum(&(${rsExpr(n.arg, ctx)}))`;
      return `k_keep_letters(&(${rsExpr(n.arg, ctx)}))`;
    case 'strip_chars':
      return `k_strip_chars(&(${rsExpr(n.arg, ctx)}), ${JSON.stringify(n.chars)})`;
    case 'substr': {
      const L = n.length === undefined ? 'None' : `Some(${n.length})`;
      return `k_substr(&(${rsExpr(n.arg, ctx)}), ${n.start}, ${L})`;
    }
    case 'eq':
      return `(if k_eq_str(&(${rsExpr(n.a, ctx)}), &(${rsExpr(n.b, ctx)})) { "true".to_string() } else { "false".to_string() })`;
    case 'lookup': {
      const tname = `LOOKUP_${ctx.tmpCounter++}`;
      const rows = Object.keys(n.cases).map(k => {
        const v = n.cases[k];
        const vs = (typeof v === 'string') ? v : JSON.stringify(v);
        return `    (${JSON.stringify(k)}, ${JSON.stringify(vs)})`;
      });
      ctx.tables.push(
`static ${tname}: &[(&str, &str)] = &[
${rows.join(',\n')}
];`);
      const defExpr = (n.default && typeof n.default === 'object' && !Array.isArray(n.default) && typeof n.default.op === 'string')
        ? rsExpr(n.default, ctx)
        : `${JSON.stringify(typeof n.default === 'string' ? n.default : JSON.stringify(n.default))}.to_string()`;
      return `{ let __k = ${rsExpr(n.key, ctx)}; let mut __v: Option<String> = None; for &(k, v) in ${tname} { if k == __k { __v = Some(v.to_string()); break; } } __v.unwrap_or_else(|| ${defExpr}) }`;
    }
    case 'if':
      return `(if (${rsExpr(n.cond, ctx)}) == "true" { ${rsExpr(n.then, ctx)} } else { ${rsExpr(n.else, ctx)} })`;
    case 'object': {
      const parts = Object.keys(n.fields).map(k => {
        return `(${JSON.stringify(JSON.stringify(k) + ':\"')}.to_string()) + &(${rsExpr(n.fields[k], ctx)}) + \"\\\"\"`;
      });
      return `("{".to_string() + &([${parts.join(', ')}].join(",")) + "}")`;
    }
  }
}

// ---------------------------------------------------------------------------
// Codegen bundle helper. Used by the artifact builder to attach native.c
// and native.rs to a compiled_rule .kolm zip. Returns { c: {source,
// source_hash, bytes}, rust: {...} }.
// ---------------------------------------------------------------------------

export function emitCompiledTargets(dsl, opts = {}) {
  const c = emitC(dsl, opts);
  const rs = emitRust(dsl, opts);
  return {
    c: {
      filename: 'native.c',
      source: c,
      source_hash: crypto.createHash('sha256').update(c).digest('hex'),
      bytes: Buffer.byteLength(c, 'utf8'),
    },
    rust: {
      filename: 'native.rs',
      source: rs,
      source_hash: crypto.createHash('sha256').update(rs).digest('hex'),
      bytes: Buffer.byteLength(rs, 'utf8'),
    },
  };
}

export const DSL_OPS = OPS;
