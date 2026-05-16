#!/usr/bin/env node
// scripts/cf-bootstrap.mjs — apply WAF + rate-limit + Email Routing
// hardening to the kolm.ai Cloudflare zone. Idempotent.
//
// Usage:
//   node scripts/cf-bootstrap.mjs                 # apply everything
//   node scripts/cf-bootstrap.mjs --dry           # print what would be applied
//   node scripts/cf-bootstrap.mjs --waf           # only WAF rules
//   node scripts/cf-bootstrap.mjs --rate-limit    # only rate-limit rules
//   node scripts/cf-bootstrap.mjs --email         # only Email Routing
//
// Reads CLOUDFLARE_ACCOUNT_ID + CLOUDFLARE_API_TOKEN from env or .env.

import 'dotenv/config';
import * as CF from '../src/cloudflare.js';

const args = process.argv.slice(2);
const dry = args.includes('--dry');
const only = {
  waf: args.includes('--waf'),
  ratelimit: args.includes('--rate-limit'),
  email: args.includes('--email'),
};
const all = !only.waf && !only.ratelimit && !only.email;

async function main() {
  if (!CF.cloudflareConfigured()) {
    console.error('error: CLOUDFLARE_ACCOUNT_ID + CLOUDFLARE_API_TOKEN not set');
    process.exit(2);
  }
  const domain = process.env.KOLM_DOMAIN || 'kolm.ai';
  const zone_id = await CF.discoverZoneId(domain);
  console.log(`zone: ${domain}  id: ${zone_id}`);

  if (dry) {
    console.log('\n--- WAF rules ---');
    for (const r of CF.defaultWafRules()) console.log(`  ${r.action.padEnd(18)} ${r.description}`);
    console.log('\n--- Rate-limit rules ---');
    for (const r of CF.defaultRateLimitRules()) console.log(`  ${r.ratelimit.requests_per_period}/${r.ratelimit.period}s  ${r.description}`);
    console.log('\n--- Email rules ---');
    for (const r of CF.defaultEmailRules()) console.log(`  ${r.matchers[0].value.padEnd(28)} -> ${r.actions[0].value[0]}`);
    return;
  }

  if (all || only.waf) {
    const rules = CF.defaultWafRules();
    await CF.putCustomRules(zone_id, rules);
    console.log(`[waf]         applied ${rules.length} custom rules`);
  }

  if (all || only.ratelimit) {
    const rules = CF.defaultRateLimitRules();
    await CF.putRateLimitRules(zone_id, rules);
    console.log(`[rate-limit]  applied ${rules.length} rules`);
  }

  if (all || only.email) {
    await CF.enableEmailRouting(zone_id).catch(e => console.log(`[email]       enable: ${String(e.message || e).slice(0, 120)}`));
    const rules = CF.defaultEmailRules();
    let ok = 0;
    for (const r of rules) {
      try {
        await CF.putEmailRule(zone_id, r);
        ok++;
      } catch (e) {
        console.log(`[email]       FAILED ${r.name}: ${String(e.message || e).slice(0, 120)}`);
      }
    }
    console.log(`[email]       applied ${ok}/${rules.length} forward rules`);
  }
}

main().catch(e => {
  console.error('error:', e.message);
  if (process.env.KOLM_DEBUG) console.error(e.stack);
  process.exit(1);
});
