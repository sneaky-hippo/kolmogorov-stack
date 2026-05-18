// Shared helpers for tests that spawn `server.js` (or any long-lived child
// process). Two failure modes these protect against on Windows + the Node
// test runner:
//
//  (1) `child.kill()` is fire-and-forget. On Windows the call is mapped to
//      TerminateProcess; the OS may take 50–500ms to actually reap the PID
//      and release stdio pipes. If the parent test process exits the test
//      summary and tries to close cleanly while pipes are still attached,
//      the test runner can stall for up to ~60s waiting for streams to end.
//      `killAndWait` blocks until 'exit' fires (or a 3s ceiling), destroys
//      the stdio streams, and `unref`s the child so it can't pin the loop.
//
//  (2) `fs.rmSync(dir, { recursive:true, force:true })` throws EPERM on
//      Windows if a child still holds a sqlite file inside `dir`. Even with
//      `force:true`, Node bubbles the EPERM. `rmSyncBestEffort` retries a
//      few times then gives up silently — the tmp dir will be reaped by the
//      OS / next reboot, which is the same contract as Linux behaviour.
//
// Usage:
//   import { killAndWait, rmSyncBestEffort } from './_spawn-helpers.js';
//   ...
//   const child = spawn(node, ['server.js'], { stdio: ['ignore','pipe','pipe'] });
//   t.after(() => rmSyncBestEffort(dataDir));   // registered first → fires SECOND
//   t.after(() => killAndWait(child));          // registered last  → fires FIRST
//
// after() is LIFO, so kill the child BEFORE removing its data dir.

import fs from 'node:fs';

export async function killAndWait(child, ms = 3000) {
  if (!child || child.exitCode !== null) return;
  try { child.kill('SIGTERM'); } catch {}
  await new Promise((resolve) => {
    const t = setTimeout(() => { try { child.kill('SIGKILL'); } catch {} resolve(); }, ms);
    child.once('exit', () => { clearTimeout(t); resolve(); });
  });
  try { child.stdout?.destroy(); } catch {}
  try { child.stderr?.destroy(); } catch {}
  try { child.unref(); } catch {}
}

export function rmSyncBestEffort(dir, attempts = 5, delayMs = 100) {
  for (let i = 0; i < attempts; i++) {
    try {
      fs.rmSync(dir, { recursive: true, force: true });
      return;
    } catch (e) {
      if (i === attempts - 1) return; // give up silently — tmp is OS-reaped
      const end = Date.now() + delayMs;
      while (Date.now() < end) { /* busy-wait, no Promise → no fake hang */ }
    }
  }
}
