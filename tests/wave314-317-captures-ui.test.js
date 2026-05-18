// Wave 314-317 — /captures inbox UI polish bundle.
//
// W314 client-side substring search filter; W315 ?namespace= deep link with
// URL replaceState round-trip; W316 promote-confirm modal; W317 CSV download
// of currently visible rows. All four ship on public/captures.html and the
// behavior assertions live in this one file so a regression that touches
// any of them blows up next to the rest.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CAPTURES_PATH = path.resolve(__dirname, '..', 'public', 'captures.html');
function read() { return fs.readFileSync(CAPTURES_PATH, 'utf8'); }

// ---- W314: client-side substring search filter ----

test('W314 #1 — captures.html exposes #search-filter + #search-count', () => {
  const html = read();
  assert.match(html, /id="search-filter"/, 'search input must exist');
  assert.match(html, /id="search-count"/, 'search counter must exist');
  assert.match(html, /type="search"/, 'must use type=search for a11y/clear button');
  assert.match(html, /aria-label="Search captures/i, 'search input needs aria-label');
});

test('W314 #2 — search filter applies to #obs-rows children and survives SSE repaint', () => {
  const html = read();
  // The handler must walk #obs-rows tr[data-id] and toggle display.
  assert.match(html, /querySelectorAll\(\s*['"]#obs-rows tr\[data-id\]/, 'must scan #obs-rows rows');
  assert.match(html, /tr\.style\.display\s*=\s*hit\s*\?\s*['"]['"]\s*:\s*['"]none['"]/, 'must toggle display=none for non-matches');
  // MutationObserver re-application keeps the filter live across load() repaints.
  assert.match(html, /MutationObserver/, 'must re-apply on row mutation so SSE-inserted rows still get filtered');
  // Debounce so typing fast doesn't thrash.
  assert.match(html, /setTimeout\(\s*applySearch/, 'must debounce input');
});

// ---- W315: ?namespace= deep link ----

test('W315 #1 — captures.html reads ?namespace= from URLSearchParams on first load', () => {
  const html = read();
  assert.match(html, /new\s+URLSearchParams\(\s*window\.location\.search/, 'must parse window.location.search');
  assert.match(html, /params\.get\(\s*['"]namespace['"]\s*\)/, 'must look up the namespace param');
  // include_discarded deep-link too.
  assert.match(html, /params\.get\(\s*['"]include_discarded['"]\s*\)/, 'must also honor include_discarded=1');
});

test('W315 #2 — namespace + include_discarded changes write back via history.replaceState', () => {
  const html = read();
  assert.match(html, /function syncUrl\(\)/, 'syncUrl helper must exist');
  assert.match(html, /history\.replaceState/, 'state must round-trip back into URL');
  // ns-filter + show-discarded handlers must call syncUrl() after mutating state.
  assert.match(html, /state\.ns\s*=\s*e\.target\.value;\s*syncUrl\(\);\s*load\(\)/, 'ns-filter change must syncUrl');
  assert.match(html, /state\.includeDiscarded\s*=\s*e\.target\.checked;\s*syncUrl\(\);\s*load\(\)/, 'show-discarded change must syncUrl');
});

test('W315 #3 — render path honors state.ns over the current select value', () => {
  const html = read();
  // The renderer must prefer state.ns (deep-link) over sel.value (post-render
  // default) so the dropdown selection survives the first load() repaint.
  assert.match(html, /var current = state\.ns \|\| sel\.value/, 'render must prefer state.ns to seed the select');
});

// ---- W316: promote-confirm modal ----

test('W316 #1 — captures.html has #promote-modal with required structure', () => {
  const html = read();
  assert.match(html, /id="promote-modal"/, 'promote modal element must exist');
  assert.match(html, /role="dialog"/, 'modal needs role=dialog');
  assert.match(html, /aria-modal="true"/, 'modal needs aria-modal=true');
  assert.match(html, /id="promote-modal-title"/, 'modal needs a titled label');
  assert.match(html, /id="promote-cancel"/, 'cancel button must exist');
  assert.match(html, /id="promote-confirm"/, 'confirm button must exist');
  assert.match(html, /id="promote-modal-summary"/, 'summary panel must exist');
});

test('W316 #2 — promote anchor click is intercepted before navigation', () => {
  const html = read();
  // Click handler on #obs-rows must find a.prom and call preventDefault.
  assert.match(html, /a\.prom/, 'must select the promote anchor');
  assert.match(html, /e\.preventDefault\(\)/, 'must preventDefault on the anchor click');
  // Escape key + outside click both close the modal.
  assert.match(html, /e\.key === ['"]Escape['"]/, 'Escape must close the modal');
});

test('W316 #3 — confirm button performs the deferred navigation', () => {
  const html = read();
  assert.match(html, /confirm\.addEventListener\(\s*['"]click['"]/, 'confirm button must have a click handler');
  assert.match(html, /window\.location\.assign\(\s*pendingHref/, 'confirm must navigate to the captured href');
});

// ---- W317: CSV download ----

test('W317 #1 — #download-csv button exists in the toolbar', () => {
  const html = read();
  assert.match(html, /id="download-csv"/, 'CSV download button must exist');
  assert.match(html, /title=["'][^"']*currently visible/i, 'title should clarify visible-rows-only scope');
});

test('W317 #2 — CSV builder emits a stable header and proper escape', () => {
  const html = read();
  assert.match(html, /id,model,namespace,prompt,response,latency_ms/, 'CSV header line must be locked-in');
  assert.match(html, /function csvEscape/, 'must have its own escaper');
  assert.match(html, /s\.replace\(\s*\/"\/g\s*,\s*['"]['"]['"]['"]\s*\)/, 'must double quotes per RFC 4180 (s.replace(/"/g, \'""\'))');
});

test('W317 #3 — CSV builder skips display:none rows so the search filter applies', () => {
  const html = read();
  // Visible-row gate: rows hidden by the W314 search filter must NOT be exported,
  // otherwise the download silently disagrees with what the user sees.
  assert.match(html, /tr\.style\.display === ['"]none['"]/, 'must respect hidden rows');
  // File name includes a YYYY-MM-DD prefix so downloads from different days don't collide.
  assert.match(html, /new Date\(\)\.toISOString\(\)\.slice\(0,10\)/, 'filename must carry today date');
  // Blob + objectURL + anchor.click + revokeObjectURL — standard pattern.
  assert.match(html, /URL\.createObjectURL/, 'must use createObjectURL');
  assert.match(html, /URL\.revokeObjectURL/, 'must revoke the objectURL after click');
});
