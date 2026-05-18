// W223 — regenerate public/cdn/kolm-assets/tui-demo.cast so the JSON strings
// have properly-escaped ESC bytes (the strict-JSON form: ESC encoded as 
// in the on-disk file, the byte itself when JSON.parse loads it). Without
// this strict encoding, Node's JSON.parse refuses the file with "Bad control
// character in string literal" because raw 0x1B in a JSON string is illegal
// (json.org grammar). Browsers' JSON.parse is the same.
//
// Source-of-truth — run this script when the demo storyboard changes.
import fs from 'node:fs';
import path from 'node:path';

const ESC = String.fromCharCode(0x1b);
const OUT = path.resolve(import.meta.dirname, '..', 'public/cdn/kolm-assets/tui-demo.cast');

const header = {
  version: 2,
  width: 72,
  height: 20,
  timestamp: 1747526400,
  title: 'kolm tui · W222 alt-screen multi-pane demo',
  env: { SHELL: '/bin/bash', TERM: 'xterm-256color' },
};

function frame(t, payload) {
  return JSON.stringify([t, 'o', payload]);
}

const clear = ESC + '[2J' + ESC + '[H';
const altEnter = ESC + '[?1049h' + ESC + '[?25l';
const altExit = ESC + '[?25h' + ESC + '[?1049l';

const initialPane = clear +
  '┌ captures ●─────────────────────────────┬ detail ─────────────────────────────┐\r\n' +
  '│   (no captures yet)            │  (nothing selected)           │\r\n' +
  '│   waiting for stream...        │                               │\r\n' +
  '│                                │  press 1 for captures,        │\r\n' +
  '│                                │  2 for artifacts,             │\r\n' +
  '│                                │  / to filter, Enter to open.  │\r\n' +
  '│                                │                               │\r\n' +
  '│                                │                               │\r\n' +
  '│                                │                               │\r\n' +
  '│                                │                               │\r\n' +
  '│                                │                               │\r\n' +
  '│                                │                               │\r\n' +
  '│                                │                               │\r\n' +
  '│                                │                               │\r\n' +
  '│                                │                               │\r\n' +
  '│                                │                               │\r\n' +
  '└────────────────────────────────┴──────────────────────────────┘\r\n' +
  ' ks_abc1… · https://kolm.ai · j/k move · 1/2 src · ? help · q quit [normal]';

const capturesFirstSel = clear +
  '┌ captures ●─────────────────────────────┬ detail ─────────────────────────────┐\r\n' +
  '│ ▸● 14:22:11 prod  gpt-4o   su… │  capture                      │\r\n' +
  '│  ● 14:22:09 prod  claude   ge… │  id:        cap_8af3…         │\r\n' +
  '│  ● 14:22:07 stage gpt-4o   ge… │  namespace: prod              │\r\n' +
  '│  ● 14:22:01 prod  gpt-4o   pa… │  model:     gpt-4o            │\r\n' +
  '│  ● 14:21:55 prod  claude   cl… │  status:    200               │\r\n' +
  '│                                │  latency:   312 us            │\r\n' +
  '│                                │  durable:   yes               │\r\n' +
  '│                                │                               │\r\n' +
  '│                                │  prompt:                      │\r\n' +
  '│                                │    summarize the customer …   │\r\n' +
  '│                                │                               │\r\n' +
  '│                                │  response:                    │\r\n' +
  '│                                │    The customer reports 3 …   │\r\n' +
  '│                                │                               │\r\n' +
  '│                                │                               │\r\n' +
  '└────────────────────────────────┴──────────────────────────────┘\r\n' +
  ' ks_abc1… · https://kolm.ai · j/k move · 1/2 src · ? help · q quit [normal]';

const capturesSecondSel = clear +
  '┌ captures ●─────────────────────────────┬ detail ─────────────────────────────┐\r\n' +
  '│  ● 14:22:11 prod  gpt-4o   su… │  capture                      │\r\n' +
  '│ ▸● 14:22:09 prod  claude   ge… │  id:        cap_b1f2…         │\r\n' +
  '│  ● 14:22:07 stage gpt-4o   ge… │  namespace: prod              │\r\n' +
  '│  ● 14:22:01 prod  gpt-4o   pa… │  model:     claude-sonnet-4-6 │\r\n' +
  '│  ● 14:21:55 prod  claude   cl… │  status:    200               │\r\n' +
  '│                                │  latency:   441 us            │\r\n' +
  '│                                │  durable:   yes               │\r\n' +
  '│                                │                               │\r\n' +
  '│                                │  prompt:                      │\r\n' +
  '│                                │    generate a denial appeal…  │\r\n' +
  '│                                │                               │\r\n' +
  '│                                │  response:                    │\r\n' +
  '│                                │    Dear Member, your appeal…  │\r\n' +
  '│                                │                               │\r\n' +
  '│                                │                               │\r\n' +
  '└────────────────────────────────┴──────────────────────────────┘\r\n' +
  ' ks_abc1… · https://kolm.ai · j/k move · 1/2 src · ? help · q quit [normal]';

const distillQueued = capturesSecondSel.replace('[normal]', '[:d]  distill job: queued (j_2af1)');

const artifactsView = clear +
  '┌ artifacts ●────────────────────────────┬ detail ─────────────────────────────┐\r\n' +
  '│ ▸ phi-redactor.kolm (9.5 KB)   │  artifact                     │\r\n' +
  '│   denial-appeal-v3.kolm (12 KB)│  path:       …/phi-redactor…  │\r\n' +
  '│   prior-auth-v2.kolm   (11 KB) │  size:       9.5 KB           │\r\n' +
  '│   edi-837-coder.kolm   (18 KB) │  magic:      0x504b           │\r\n' +
  '│                                │  version_id: phi-redactor-v7  │\r\n' +
  '│                                │  base:       phi-3-mini-int4  │\r\n' +
  '│                                │  k_score:    0.982            │\r\n' +
  '│                                │  signer:     ks_abc1…         │\r\n' +
  '│                                │  receipt:    a8f3b29c1d…      │\r\n' +
  '│                                │                               │\r\n' +
  '│                                │  press v to re-verify the     │\r\n' +
  '│                                │  receipt chain.               │\r\n' +
  '│                                │                               │\r\n' +
  '│                                │                               │\r\n' +
  '│                                │                               │\r\n' +
  '└────────────────────────────────┴──────────────────────────────┘\r\n' +
  ' ks_abc1… · https://kolm.ai · j/k move · 1/2 src · ? help · q quit [normal]';

const verifyOk = artifactsView.replace('[normal]', '[:v]  verified ✓');

const lines = [JSON.stringify(header)];
lines.push(frame(0.0, '$ kolm tui\r\n'));
lines.push(frame(0.4, altEnter + initialPane));
lines.push(frame(1.4, capturesFirstSel));
lines.push(frame(2.6, capturesSecondSel));
lines.push(frame(3.8, distillQueued));
lines.push(frame(5.0, artifactsView));
lines.push(frame(6.4, verifyOk));
lines.push(frame(8.0, altExit));
lines.push(frame(8.1, 'bye.\r\n$ '));

fs.writeFileSync(OUT, lines.join('\n') + '\n', 'utf8');
console.log('wrote', lines.length, 'lines to', OUT);
