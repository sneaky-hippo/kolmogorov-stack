#!/usr/bin/env node
// Deterministic generator for the Predibase-style 1000-row customer-support
// intent corpus. Reproducible: same seed -> same rows. No randomness pulled
// from the OS so the corpus is bit-identical across machines.
//
// Output: seeds.jsonl with one row per line, shape
//   { "input": "<utterance>", "output": { "intent": "<label>" }, "tags": [...] }
//
// The output is a structured {intent: label} object — not a bare string —
// because that's what the rule-class recipe in spec.json produces. The
// corpus and the recipe must agree on the output schema for the
// head-to-head bench comparator to work.
//
// Why a deterministic generator and not a checked-in fixed file: the file IS
// the same on every run (rng is seeded), so the moral equivalent of a fixed
// fixture, but it ships with the recipe that produced it. A reviewer can
// inspect this script in 60 seconds; a 1000-row .jsonl review is no fun.
//
// The 10 labels are real customer-support intents typical of a SaaS payments
// product. They're the same labels the kolm rule-class recipe in spec.json
// classifies against.

import fs from 'node:fs';
import path from 'node:path';
import url from 'node:url';
import crypto from 'node:crypto';

const __filename = url.fileURLToPath(import.meta.url);
const __dirname  = path.dirname(__filename);

const LABELS = [
  'refund', 'cancel', 'billing', 'shipping', 'password_reset',
  'account_lock', 'complaint', 'feedback', 'escalate', 'other',
];

// Per-label phrase templates. Tokens in {{ ... }} get filled with one of the
// listed values. The router (rule-class recipe in spec.json) matches on
// keywords like "refund", "cancel", "subscription" -- the templates use
// those keywords too so a literal keyword match has a real shot. (That's
// the whole demo: "did the cheap rule preserve the LLM's accuracy on this
// task?")
const TEMPLATES = {
  refund: [
    'I would like a refund for order #{{order}}',
    'Please refund my last purchase',
    'refund my $${{amount}} charge on {{date}}',
    'can I get my money back on order {{order}}?',
    'need a refund the item arrived broken',
    'requesting a refund -- the size was wrong',
    'process a refund please, charge was duplicate',
    'I want my money back for invoice {{order}}',
    'refund my recent purchase, never received it',
    'pls refund order #{{order}} -- product was defective',
  ],
  cancel: [
    'how do I cancel my subscription?',
    'cancel my plan effective today',
    'I need to cancel my account please',
    'please cancel the auto-renew on plan #{{order}}',
    'turn off my subscription, stop billing me',
    'stop my plan I no longer need it',
    'I want to cancel before the next billing cycle',
    'cancel subscription -- moving to a competitor',
    'help me cancel and avoid the next charge',
    'cancel renewal for order {{order}}',
  ],
  billing: [
    'why was I charged $${{amount}} on {{date}}?',
    'I see a duplicate charge for $${{amount}}',
    'my invoice shows the wrong amount',
    'when will my card be charged next?',
    'update my payment method please',
    'change billing address for invoice {{order}}',
    'add a new credit card to my account',
    'my last invoice is missing the line items',
    'split the charge into two separate invoices',
    'send me a receipt for the {{date}} payment',
  ],
  shipping: [
    'where is my order #{{order}}?',
    'tracking number for shipment {{order}} please',
    'my package was supposed to arrive on {{date}}',
    'shipment delayed, no updates in days',
    'change delivery address for order {{order}}',
    'when will order {{order}} be delivered?',
    'package shows delivered but I did not receive it',
    'expedite shipping on my last order',
    'add signature confirmation to delivery',
    'reroute order {{order}} to a different address',
  ],
  password_reset: [
    'I forgot my password',
    'cannot log in, need to reset my password',
    'send me a password reset link',
    'how do I change my password?',
    'reset password for account {{email}}',
    'lost access -- need password recovery',
    'two-factor not working, locked out',
    'help resetting my password please',
    'password expired, need a new one',
    'my password isn\'t accepted',
  ],
  account_lock: [
    'my account is locked',
    'I am locked out of my account',
    'too many login attempts, account suspended',
    'unlock my account for {{email}}',
    'account temporarily disabled, please help',
    'why is my account on hold?',
    'security lock on my account, need to verify',
    'cannot access account after password change',
    'account flagged, requesting review',
    'restore my account access',
  ],
  complaint: [
    'this is the worst service I have ever used',
    'your product broke after one day, terrible',
    'support agent was rude and unhelpful',
    'I am very dissatisfied with my purchase',
    'this is unacceptable -- want to speak to a manager',
    'I have been waiting for {{days}} days with no response',
    'absolutely awful experience, leaving a review',
    'your team has been ignoring my emails',
    'I demand a resolution to this ongoing issue',
    'this complaint has not been addressed in {{days}} days',
  ],
  feedback: [
    'great service, just wanted to say thanks',
    'love the new feature, keep it up',
    'feedback: the dashboard is much faster now',
    'small suggestion -- add dark mode please',
    'thank you, the team was very helpful',
    'enjoyed the experience, would recommend',
    'one feature request: bulk export to CSV',
    'really appreciate the quick turnaround',
    'positive feedback for agent #{{order}}',
    'you guys are doing great, keep going',
  ],
  escalate: [
    'I need to speak with a supervisor immediately',
    'escalate this to your manager please',
    'this case needs management attention',
    'requesting urgent escalation on ticket {{order}}',
    'escalate -- I have called {{days}} times',
    'I want this case escalated now',
    'connect me with someone senior please',
    'tier 2 support please, this is beyond tier 1',
    'escalation required, refund denied incorrectly',
    'please pass this to a senior representative',
  ],
  other: [
    'do you have any openings on your team?',
    'when is your office open?',
    'what is the phone number for sales?',
    'general question about your product',
    'is there a partner program?',
    'asking for a friend -- do you ship internationally?',
    'does your service work in {{country}}?',
    'unrelated question about something else',
    'just browsing, no specific issue',
    'random question about the company',
  ],
};

// Fillers used to populate {{ ... }} tokens.
const FILL = {
  order: ['1001', '7392', '88301', '20245', '5510', '64782', '3399', '11237', '90456', '7821'],
  amount: ['9.99', '14.50', '29.00', '49.99', '99.00', '199.99', '299.00', '4.50', '12.95', '79.99'],
  date: ['2025-01-15', '2025-02-03', '2025-03-21', '2025-04-08', '2025-05-12', '2024-12-30', '2025-06-04', '2025-07-19', '2025-08-25', '2025-09-11'],
  email: ['alice@example.com', 'bob@example.com', 'carla@example.com', 'dan@example.com', 'evan@example.com'],
  days: ['3', '5', '7', '10', '14', '21'],
  country: ['Canada', 'the UK', 'Germany', 'Japan', 'Australia'],
};

// Mulberry32 — tiny deterministic PRNG; seed in, [0,1) out. Bit-identical
// across platforms because all math is uint32 bitops.
function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a = (a + 0x6D2B79F5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function pick(rng, arr) { return arr[Math.floor(rng() * arr.length)]; }

function fill(rng, template) {
  return template.replace(/\{\{(\w+)\}\}/g, (_, key) => {
    const opts = FILL[key];
    return opts ? pick(rng, opts) : '?';
  });
}

function generate({ rowsPerLabel = 100, seed = 17 } = {}) {
  const rng = mulberry32(seed);
  const rows = [];
  // Even number of rows per label so the comparison is unbiased.
  for (const label of LABELS) {
    const templates = TEMPLATES[label];
    for (let i = 0; i < rowsPerLabel; i++) {
      const t = templates[i % templates.length];
      rows.push({ input: fill(rng, t), output: { intent: label }, tags: ['customer-support', label] });
    }
  }
  // Stable shuffle (Fisher-Yates with the same rng) so train/holdout doesn't
  // collapse to label-blocks. Deterministic because rng is seeded.
  for (let i = rows.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    const tmp = rows[i]; rows[i] = rows[j]; rows[j] = tmp;
  }
  return rows;
}

function writeJsonl(p, rows) {
  fs.writeFileSync(p, rows.map(r => JSON.stringify(r)).join('\n') + '\n');
}

if (import.meta.url === url.pathToFileURL(process.argv[1]).href) {
  const rows = generate({ rowsPerLabel: 100, seed: 17 });
  const out = path.join(__dirname, 'seeds.jsonl');
  writeJsonl(out, rows);
  const corpusHash = crypto.createHash('sha256')
    .update(fs.readFileSync(out)).digest('hex');
  console.error(`[generate] wrote ${rows.length} rows to ${out}`);
  console.error(`[generate] sha256: ${corpusHash}`);
}

export { generate, LABELS, TEMPLATES, FILL, mulberry32 };
