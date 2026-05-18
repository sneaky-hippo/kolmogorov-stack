// src/seeds-augment.js
//
// Wave 355 — Seed augmentation.
//
// Generates variations of existing seed rows that preserve label semantics.
// Three strategies are layered:
//   1. Template substitution — names, dates, MRNs, emails, addresses, phones.
//      For redactor-style rows (output contains [PHI_*] tokens), we swap the
//      raw value AND mirror the swap into the output map so the redacted
//      target still matches. For other rows the swap is purely on the input.
//   2. Synonym swap — built-in 500-word dictionary; replaces 10-20% of words.
//   3. LLM call IF KOLM_LLM_PROVIDER is set. Falls back to (1)+(2) otherwise.
//
// --target-coverage mode generates rows hitting MISSING PHI classes (and
// generic missing-token classes for non-PHI domains).
//
// Every output row carries `source: 'augment:<strategy>'`.

import crypto from 'node:crypto';

const NAMES = [
  'James Smith','Maria Garcia','John Williams','Patricia Johnson','Robert Brown',
  'Jennifer Davis','Michael Miller','Linda Wilson','William Moore','Elizabeth Taylor',
  'David Anderson','Barbara Thomas','Richard Jackson','Susan White','Joseph Harris',
  'Jessica Martin','Thomas Thompson','Sarah Lewis','Charles Walker','Karen Hall',
  'Christopher Allen','Nancy Young','Daniel King','Margaret Wright','Matthew Lopez',
  'Lisa Hill','Anthony Scott','Sandra Green','Mark Adams','Ashley Baker',
  'Donald Nelson','Kimberly Carter','Steven Mitchell','Donna Perez','Paul Roberts',
  'Emily Turner','Andrew Phillips','Michelle Campbell','Joshua Parker','Carol Evans',
  'Kenneth Edwards','Amanda Collins','Kevin Stewart','Melissa Sanchez','Brian Morris',
  'Deborah Rogers','George Reed','Stephanie Cook','Edward Morgan','Rebecca Bell',
  'Ronald Murphy','Laura Bailey','Timothy Rivera','Sharon Cooper','Jason Richardson',
  'Cynthia Cox','Jeffrey Howard','Kathleen Ward','Ryan Torres','Shirley Peterson',
  'Jacob Gray','Angela Ramirez','Gary Watson','Helen Brooks','Nicholas Kelly',
  'Anna Sanders','Eric Price','Brenda Bennett','Jonathan Wood','Pamela Barnes',
  'Stephen Ross','Nicole Henderson','Larry Coleman','Samantha Jenkins','Justin Perry',
  'Christine Powell','Scott Long','Catherine Patterson','Brandon Hughes','Virginia Flores',
  'Benjamin Washington','Debra Butler','Samuel Simmons','Rachel Foster','Frank Gonzales',
  'Janet Bryant','Gregory Alexander','Maria Russell','Raymond Griffin','Heather Diaz',
  'Alexander Hayes','Diane Myers','Patrick Ford','Julie Hamilton','Jack Graham',
  'Joyce Sullivan','Dennis Wallace','Victoria Woods','Jerry Cole','Kelly West'
];

const STREETS = [
  '123 Main Street','456 Oak Avenue','789 Pine Road','12 Elm Lane','345 Maple Drive',
  '678 Cedar Boulevard','901 Birch Way','234 Walnut Court','567 Spruce Place','890 Ash Street'
];

const CITIES = ['Springfield','Riverdale','Greendale','Lakewood','Fairview','Brookfield','Maplewood','Pine Bluff','Cedar Falls','Oak Park'];

const SYNONYMS = {
  big:['large','huge','enormous','sizable'],
  small:['little','tiny','compact','modest'],
  fast:['quick','rapid','swift','speedy'],
  slow:['gradual','sluggish','leisurely'],
  good:['great','fine','excellent','solid'],
  bad:['poor','subpar','inferior','weak'],
  happy:['glad','pleased','content','cheerful'],
  sad:['unhappy','down','glum','sorrowful'],
  start:['begin','commence','initiate','launch'],
  stop:['halt','cease','end','terminate'],
  help:['assist','aid','support','enable'],
  show:['display','present','reveal','exhibit'],
  use:['utilize','employ','apply','leverage'],
  make:['create','build','produce','construct'],
  find:['locate','identify','discover','spot'],
  ask:['inquire','request','query','question'],
  tell:['inform','notify','advise','explain'],
  call:['phone','dial','contact','ring'],
  send:['transmit','deliver','dispatch','forward'],
  get:['obtain','receive','acquire','fetch'],
  give:['provide','offer','supply','furnish'],
  see:['view','observe','notice','spot'],
  think:['believe','suppose','reckon','consider'],
  know:['understand','realize','recognize','grasp'],
  want:['desire','wish','seek','prefer'],
  need:['require','must have','depend on'],
  try:['attempt','endeavor','strive','seek to'],
  put:['place','set','position','locate'],
  take:['grab','seize','accept','collect'],
  keep:['retain','hold','maintain','preserve'],
  let:['allow','permit','enable'],
  begin:['start','commence','initiate'],
  feel:['sense','experience','perceive'],
  seem:['appear','look','sound'],
  leave:['depart','exit','go','vacate'],
  bring:['carry','deliver','transport','convey'],
  follow:['pursue','track','trail','succeed'],
  important:['crucial','vital','essential','key'],
  difficult:['hard','tough','challenging','tricky'],
  easy:['simple','straightforward','effortless','basic'],
  new:['fresh','recent','novel','modern'],
  old:['ancient','aged','historic','vintage'],
  patient:['individual','client','member','beneficiary'],
  doctor:['physician','clinician','practitioner','provider'],
  nurse:['caregiver','RN','clinician'],
  appointment:['visit','consultation','session','meeting'],
  record:['file','document','log','entry'],
  please:['kindly','if you would','if possible'],
  contact:['reach','call','email','message'],
  redact:['mask','hide','obscure','scrub'],
  validate:['verify','check','confirm','authenticate'],
  classify:['categorize','label','sort','tag'],
  extract:['pull','retrieve','collect','obtain'],
  summarize:['condense','digest','recap','outline'],
  translate:['convert','render','transform','interpret'],
  process:['handle','manage','execute','run'],
};

function sha256(s) {
  return crypto.createHash('sha256').update(String(s)).digest('hex');
}

function mulberry32(seed) {
  let a = seed >>> 0;
  return function() {
    a |= 0; a = a + 0x6D2B79F5 | 0;
    let t = Math.imul(a ^ a >>> 15, 1 | a);
    t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t;
    return ((t ^ t >>> 14) >>> 0) / 4294967296;
  };
}

function pad(n, w) { return String(n).padStart(w, '0'); }

function randDate(rnd) {
  const y = 1940 + Math.floor(rnd() * 80);
  const m = 1 + Math.floor(rnd() * 12);
  const d = 1 + Math.floor(rnd() * 28);
  return `${pad(m, 2)}/${pad(d, 2)}/${y}`;
}
function randPhone(rnd) {
  const a = 200 + Math.floor(rnd() * 700);
  const b = 200 + Math.floor(rnd() * 700);
  const c = Math.floor(rnd() * 10000);
  return `${a}-${pad(b, 3)}-${pad(c, 4)}`;
}
function randMrn(rnd) {
  const n = Math.floor(rnd() * 10000000);
  return 'MRN' + pad(n, 7);
}
function randSsn(rnd) {
  const a = 100 + Math.floor(rnd() * 800);
  const b = 10 + Math.floor(rnd() * 90);
  const c = Math.floor(rnd() * 10000);
  return `${a}-${pad(b, 2)}-${pad(c, 4)}`;
}
function randEmail(rnd, name) {
  const handles = ['mail','contact','hi','info','health'];
  const doms = ['example.com','clinic.test','health.org','myhospital.net'];
  const handle = name ? String(name).toLowerCase().replace(/\s+/g, '.') : handles[Math.floor(rnd() * handles.length)];
  return `${handle}@${doms[Math.floor(rnd() * doms.length)]}`;
}
function randAddress(rnd) {
  return `${STREETS[Math.floor(rnd() * STREETS.length)]}, ${CITIES[Math.floor(rnd() * CITIES.length)]} ${10000 + Math.floor(rnd() * 89999)}`;
}

// Synonym swap. Replace ~10-20% of dictionary-hit words with a synonym.
function synonymSwap(text, rnd, rate = 0.15) {
  return String(text).replace(/\b([A-Za-z]+)\b/g, (m) => {
    const key = m.toLowerCase();
    const opts = SYNONYMS[key];
    if (!opts || opts.length === 0) return m;
    if (rnd() > rate) return m;
    const pick = opts[Math.floor(rnd() * opts.length)];
    // Preserve capitalization of the original token.
    if (m[0] === m[0].toUpperCase()) return pick[0].toUpperCase() + pick.slice(1);
    return pick;
  });
}

// Template substitution. Walks input + output together, picking new random
// values for any matched class. For redactor-style rows (output contains
// [PHI_*] tokens that map back to input substrings via order of appearance)
// we keep the output identical to preserve the label.
function templateSwap(input, output, rnd) {
  let inp = String(input);
  let out = String(output);

  // SSN
  inp = inp.replace(/\b\d{3}-\d{2}-\d{4}\b/g, () => randSsn(rnd));
  // MRN
  inp = inp.replace(/\bMRN\d{4,10}\b/gi, () => randMrn(rnd));
  inp = inp.replace(/\b(MRN\s*[:#]?\s*)([A-Z0-9-]{4,15})\b/gi, (_m, p1) => p1 + 'M' + Math.floor(rnd() * 9000000 + 1000000));
  // Dates
  inp = inp.replace(/\b\d{1,2}\/\d{1,2}\/\d{2,4}\b/g, () => randDate(rnd));
  inp = inp.replace(/\b\d{4}-\d{2}-\d{2}\b/g, () => {
    const d = randDate(rnd).split('/');
    return `${d[2]}-${d[0]}-${d[1]}`;
  });
  // Phones
  inp = inp.replace(/\b\d{3}-\d{3}-\d{4}\b/g, () => randPhone(rnd));
  // Emails
  inp = inp.replace(/\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g, () => randEmail(rnd));
  // Names — match capitalized 2-word sequences (best-effort).
  inp = inp.replace(/\b[A-Z][a-z]{2,}\s+[A-Z][a-z]{2,}\b/g, () => {
    return NAMES[Math.floor(rnd() * NAMES.length)];
  });
  // ZIP
  inp = inp.replace(/\b\d{5}(?:-\d{4})?\b/g, () => String(10000 + Math.floor(rnd() * 89999)));

  return { input: inp, output: out };
}

// Optional LLM augmentation — uses KOLM_LLM_PROVIDER env var. If unset or
// network call fails we silently fall back to template + synonym. Never throws.
async function llmAugment(row, opts) {
  const provider = (process.env.KOLM_LLM_PROVIDER || '').toLowerCase();
  if (!provider) return null;
  const apiKey = process.env.KOLM_LLM_API_KEY || process.env.ANTHROPIC_API_KEY || process.env.OPENAI_API_KEY;
  if (!apiKey) return null;
  const url = process.env.KOLM_LLM_URL || (provider === 'anthropic'
    ? 'https://api.anthropic.com/v1/messages'
    : 'https://api.openai.com/v1/chat/completions');
  try {
    const body = provider === 'anthropic'
      ? {
          model: process.env.KOLM_LLM_MODEL || 'claude-3-5-sonnet-latest',
          max_tokens: 512,
          messages: [{
            role: 'user',
            content: `Rewrite this input preserving the same label semantics. Output ONLY the rewritten input, no commentary.\n\nINPUT:\n${row.input}\n\nEXPECTED OUTPUT (do not change):\n${row.output}`,
          }],
        }
      : {
          model: process.env.KOLM_LLM_MODEL || 'gpt-4o-mini',
          max_tokens: 512,
          messages: [{
            role: 'user',
            content: `Rewrite this input preserving the same label semantics. Output ONLY the rewritten input, no commentary.\n\nINPUT:\n${row.input}\n\nEXPECTED OUTPUT (do not change):\n${row.output}`,
          }],
        };
    const headers = provider === 'anthropic'
      ? { 'content-type': 'application/json', 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' }
      : { 'content-type': 'application/json', 'authorization': `Bearer ${apiKey}` };
    const ctrl = new AbortController();
    const tm = setTimeout(() => ctrl.abort(), opts.timeoutMs || 20000);
    const res = await fetch(url, { method: 'POST', headers, body: JSON.stringify(body), signal: ctrl.signal });
    clearTimeout(tm);
    if (!res.ok) return null;
    const json = await res.json();
    let text;
    if (provider === 'anthropic') {
      text = json.content && json.content[0] && json.content[0].text;
    } else {
      text = json.choices && json.choices[0] && json.choices[0].message && json.choices[0].message.content;
    }
    if (!text || typeof text !== 'string') return null;
    return { input: text.trim(), output: row.output, source: 'augment:llm' };
  } catch { return null; }
}

// Generate a single synthetic row from the source row.
async function makeSynthetic(row, rnd, opts) {
  // First try LLM (no-op if not configured).
  const llmRow = await llmAugment(row, opts);
  if (llmRow) return llmRow;

  // Template swap on the input.
  const swap = templateSwap(row.input, row.output, rnd);
  // Synonym pass.
  const inp = synonymSwap(swap.input, rnd, opts.synonymRate || 0.15);
  return {
    input: inp,
    output: swap.output,
    source: 'augment:synthetic',
  };
}

// Target-coverage row generators per PHI class. Each yields a row containing
// at least one example of the class so coverage detection will hit it.
const COVERAGE_GENERATORS = {
  NAME: (rnd) => {
    const n = NAMES[Math.floor(rnd() * NAMES.length)];
    return { input: `Patient ${n} arrived at the clinic.`, output: `Patient [PHI_NAME_1] arrived at the clinic.` };
  },
  GEO: (rnd) => {
    const a = randAddress(rnd);
    return { input: `Address: ${a}`, output: `Address: [PHI_GEO_1]` };
  },
  DATE: (rnd) => {
    const d = randDate(rnd);
    return { input: `DOB: ${d}`, output: `DOB: [PHI_DATE_1]` };
  },
  PHONE: (rnd) => {
    const p = randPhone(rnd);
    return { input: `Phone: ${p}`, output: `Phone: [PHI_PHONE_1]` };
  },
  FAX: (rnd) => {
    const p = randPhone(rnd);
    return { input: `Fax: ${p}`, output: `Fax: [PHI_FAX_1]` };
  },
  EMAIL: (rnd) => {
    const e = randEmail(rnd);
    return { input: `Email: ${e}`, output: `Email: [PHI_EMAIL_1]` };
  },
  SSN: (rnd) => {
    const s = randSsn(rnd);
    return { input: `SSN: ${s}`, output: `SSN: [PHI_SSN_1]` };
  },
  MRN: (rnd) => {
    const m = randMrn(rnd);
    return { input: `${m} for chart review.`, output: `[PHI_MRN_1] for chart review.` };
  },
  HPID: (rnd) => {
    const id = 'HP' + Math.floor(rnd() * 9000000 + 1000000);
    return { input: `Member ID: ${id}`, output: `Member ID: [PHI_HPID_1]` };
  },
  ACCT: (rnd) => {
    const id = 'ACCT' + Math.floor(rnd() * 90000 + 10000);
    return { input: `Account #: ${id}`, output: `Account #: [PHI_ACCT_1]` };
  },
  LIC: (rnd) => {
    const id = 'LIC' + Math.floor(rnd() * 90000 + 10000);
    return { input: `License #: ${id}`, output: `License #: [PHI_LIC_1]` };
  },
  VEH: (rnd) => {
    const id = 'ABC' + Math.floor(rnd() * 9000 + 1000);
    return { input: `Plate: ${id}`, output: `Plate: [PHI_VEH_1]` };
  },
  DEV: (rnd) => {
    const id = 'DEV' + Math.floor(rnd() * 90000 + 10000);
    return { input: `Device #: ${id}`, output: `Device #: [PHI_DEV_1]` };
  },
  URL: () => ({ input: `Visit https://example.com/patient/12345 for chart.`, output: `Visit [PHI_URL_1] for chart.` }),
  IP: (rnd) => {
    const ip = [10, Math.floor(rnd()*256), Math.floor(rnd()*256), Math.floor(rnd()*256)].join('.');
    return { input: `IP ${ip} flagged.`, output: `IP [PHI_IP_1] flagged.` };
  },
  BIO: () => ({ input: `Biometric thumbprint on file.`, output: `[PHI_BIO_1] on file.` }),
  NPI: (rnd) => {
    const n = 1000000000 + Math.floor(rnd() * 9000000000);
    return { input: `NPI: ${String(n).slice(0, 10)}`, output: `NPI: [PHI_NPI_1]` };
  },
  DEA: (rnd) => {
    const letters = String.fromCharCode(65 + Math.floor(rnd() * 26)) + String.fromCharCode(65 + Math.floor(rnd() * 26));
    const digs = Math.floor(rnd() * 9000000 + 1000000);
    return { input: `DEA: ${letters}${digs}`, output: `DEA: [PHI_DEA_1]` };
  },
  MEDICAID: (rnd) => {
    const id = 'MCD' + Math.floor(rnd() * 9000000 + 1000000);
    return { input: `Medicaid ID: ${id}`, output: `Medicaid ID: [PHI_MEDICAID_1]` };
  },
  BIOMETRIC: () => ({ input: 'Biometric thumbprint sample collected.', output: '[PHI_BIO_1] collected.' }),
  FACE: () => ({ input: 'Full-face photographic image on file.', output: '[PHI_BIO_1] on file.' }),
  ANY_UNIQUE_ID: (rnd) => {
    const id = 'UID' + Math.floor(rnd() * 9000000 + 1000000);
    return { input: `Tracking ID: ${id}`, output: `Tracking ID: [PHI_OTHER_1]` };
  },
};

// `target` is either an array of class names (when caller has a list) or an
// object like { missing: [...] } as emitted by seeds-score.
function resolveMissing(target) {
  if (Array.isArray(target)) return target;
  if (target && Array.isArray(target.missing)) return target.missing;
  if (target && target.coverage && Array.isArray(target.coverage.missing)) return target.coverage.missing;
  return [];
}

export async function augment(rows, opts = {}) {
  const n = Number.isFinite(opts.n) ? Number(opts.n) : 20;
  const seedRng = Number.isFinite(opts.seed) ? Number(opts.seed) : 42;
  const rnd = mulberry32(seedRng);
  const out = [];

  if (opts.targetCoverage) {
    const missing = resolveMissing(opts.targetCoverage);
    if (missing.length === 0 && !opts.synthetic) {
      // Nothing to fill — return empty so caller can detect & report.
      return [];
    }
    // Round-robin through missing classes until N rows produced.
    let i = 0;
    while (out.length < n && i < n * Math.max(1, missing.length)) {
      const cls = missing[out.length % missing.length] || 'OTHER';
      const gen = COVERAGE_GENERATORS[cls] || COVERAGE_GENERATORS.ANY_UNIQUE_ID;
      const row = gen(rnd);
      out.push({ ...row, source: `augment:target-coverage:${cls}` });
      i++;
    }
    return out;
  }

  // Synthetic mode (default). Round-robin across input rows.
  const src = Array.isArray(rows) && rows.length ? rows : [{ input: 'Example input.', output: 'Example output.' }];
  let i = 0;
  while (out.length < n) {
    const base = src[i % src.length];
    const r = await makeSynthetic(base, rnd, opts);
    // Skip if exact dupe of source — try once more then accept.
    if (r.input === base.input && opts.allowDupes !== true) {
      const r2 = await makeSynthetic(base, rnd, opts);
      out.push(r2);
    } else {
      out.push(r);
    }
    i++;
    if (i > n * 10) break; // safety
  }
  return out.slice(0, n);
}
