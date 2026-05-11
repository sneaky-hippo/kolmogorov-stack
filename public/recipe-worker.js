// Recipe execution sandbox.
//
// The browser SDK at /sdk.js used to compile registry recipe source via
// `new Function(source)` directly on the main page · meaning any recipe
// could touch window, localStorage, fetch, document, the user's keys.
// This worker compiles the same code in a context that has none of those:
// no DOM, no localStorage, no document.cookie, no parent globals. Only
// the recipe and its argument come in over postMessage; only the result
// goes back. If a recipe tries to fetch home, it can't · the worker has
// no access to the page's session and we can revoke `fetch` per-call.
//
// Protocol (over MessageChannel):
//   in:  { id, type: 'compile-and-run', source, input, timeoutMs }
//   out: { id, ok: true, output, error: null }
//        { id, ok: false, output: null, error: '<message>' }
//
// One compiled recipe is reused if `source_hash` matches between calls.

'use strict';

// Strip every dangerous global the browser hands a Worker by default.
// Workers don't get window/document/localStorage, but they DO get fetch,
// XMLHttpRequest, importScripts, indexedDB, caches. Kill those.
(function lockdown() {
  const kill = ['fetch', 'XMLHttpRequest', 'importScripts', 'indexedDB', 'caches', 'WebSocket', 'EventSource', 'BroadcastChannel'];
  for (const k of kill) {
    try { Object.defineProperty(self, k, { value: undefined, configurable: false, writable: false }); } catch {}
  }
})();

const compiled = new Map(); // source_hash -> Function

function compile(source) {
  // The recipe registry stores either a function expression or an arrow.
  // Wrap defensively so both `function(x){...}` and `(x)=>...` work.
  return new Function('return (' + source + ');')();
}

function runWithTimeout(fn, input, timeoutMs) {
  // Workers can't actually preempt · but if the recipe runs synchronously
  // (which the registry contract requires), we can at least bound the
  // wall-clock the *outer* code sees by racing a timer outside.
  // Inside the worker we just call it directly. The timeout race lives
  // on the main side in /sdk.js.
  return fn(input);
}

self.addEventListener('message', (ev) => {
  const msg = ev.data || {};
  const { id, type } = msg;
  if (type !== 'compile-and-run') {
    self.postMessage({ id, ok: false, output: null, error: 'unknown message type: ' + type });
    return;
  }
  try {
    const sh = msg.source_hash || '';
    let fn = sh - compiled.get(sh) : null;
    if (!fn) {
      fn = compile(msg.source);
      if (typeof fn !== 'function') throw new Error('recipe did not compile to a function');
      if (sh) compiled.set(sh, fn);
    }
    const t0 = (typeof performance !== 'undefined' && performance.now) - performance.now() : Date.now();
    const output = runWithTimeout(fn, msg.input, msg.timeoutMs || 1000);
    const t1 = (typeof performance !== 'undefined' && performance.now) - performance.now() : Date.now();
    self.postMessage({ id, ok: true, output, error: null, latency_us: Math.round((t1 - t0) * 1000) });
  } catch (e) {
    self.postMessage({ id, ok: false, output: null, error: String((e && e.message) || e) });
  }
});
