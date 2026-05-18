// In-process SSE fan-out for live capture tail.
//
// W213: powers /v1/capture/stream (browser) and `kolm tail captures` (CLI).
// recordCapture() in router.js calls publishCapture(obs) right after the
// insert succeeds; every subscriber whose tenant matches receives the row
// as a single SSE `data:` event.
//
// Scope rules:
//   - Subscribers are scoped to req.tenant. Cross-tenant fan-out is impossible
//     because we key the subscriber map on tenant.
//   - When the subscriber's namespace filter is set ('default', 'engineering',
//     '*' = all), rows whose corpus_namespace does not match are suppressed.
//   - Keep-alive `:ping` every 25s prevents intermediate proxies from
//     timing out the connection.
//
// This is intentionally in-process (a single lambda or a single
// long-running server). Cross-instance fan-out belongs to a downstream
// pubsub once we have one — for now the canonical replay path is to
// listCaptures() on reconnect; SSE only carries the live delta.

const subscribers = new Map(); // tenant -> Set<{namespace, write, end, id}>
let nextSubId = 1;

export function subscribe(tenant, namespace, sink) {
  if (!tenant) throw new Error('subscribe: tenant required');
  const ns = namespace || '*';
  const id = nextSubId++;
  const entry = { id, namespace: ns, sink };
  if (!subscribers.has(tenant)) subscribers.set(tenant, new Set());
  subscribers.get(tenant).add(entry);
  return () => {
    const set = subscribers.get(tenant);
    if (!set) return;
    set.delete(entry);
    if (set.size === 0) subscribers.delete(tenant);
  };
}

export function publishCapture(obs) {
  if (!obs || !obs.tenant) return 0;
  const set = subscribers.get(obs.tenant);
  if (!set || set.size === 0) return 0;
  const rowNs = obs.corpus_namespace || 'default';
  let delivered = 0;
  for (const sub of set) {
    if (sub.namespace !== '*' && sub.namespace !== rowNs) continue;
    try {
      sub.sink(obs);
      delivered++;
    } catch {
      // Subscriber sink threw — most likely the underlying socket closed
      // between the publish and the write. Drop the subscriber so we
      // don't keep retrying on every future capture.
      set.delete(sub);
    }
  }
  return delivered;
}

export function subscriberCount(tenant) {
  if (tenant) return (subscribers.get(tenant) || new Set()).size;
  let n = 0;
  for (const set of subscribers.values()) n += set.size;
  return n;
}

// Used by tests so the subscriber map doesn't leak between cases.
export function _resetSubscribers() {
  subscribers.clear();
  nextSubId = 1;
}
