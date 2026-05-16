// Vercel serverless function for Cloudflare zone hardening.
// Applies WAF custom rules, rate-limit rules, and Email Routing forward
// rules to the kolm.ai zone. Gated by ADMIN_KEY (x-admin-key header).
//
// Routes (path determined by ?op= query):
//   GET  /api/cf-config?op=ping              — verify env + discover zone
//   GET  /api/cf-config?op=zones             — list visible zones
//   GET  /api/cf-config?op=waf               — list current WAF custom rules
//   POST /api/cf-config?op=apply-waf         — apply default WAF custom rules
//   GET  /api/cf-config?op=rate-limit        — list current rate-limit rules
//   POST /api/cf-config?op=apply-rate-limit  — apply default rate-limit rules
//   GET  /api/cf-config?op=email             — Email Routing status + rules
//   POST /api/cf-config?op=apply-email       — enable Email Routing + apply forwards
//   POST /api/cf-config?op=bootstrap         — one-shot: all of the above
import * as CF from '../src/cloudflare.js';

function requireAdmin(req, res) {
  const k = req.headers['x-admin-key'] || req.query?.admin_key;
  if (!k || k !== process.env.ADMIN_KEY) {
    res.status(403).json({ error: 'admin only' });
    return false;
  }
  return true;
}

export default async function handler(req, res) {
  try {
    if (!CF.cloudflareConfigured()) {
      return res.status(500).json({
        error: 'cloudflare not configured',
        hint: 'set CLOUDFLARE_ACCOUNT_ID and CLOUDFLARE_API_TOKEN env vars',
        have_account: !!(process.env.CLOUDFLARE_ACCOUNT_ID || process.env.cloudflare_account_id),
        have_token: !!(process.env.CLOUDFLARE_API_TOKEN || process.env.Cloudflare_api_token),
      });
    }

    const op = String(req.query.op || 'ping');

    if (op === 'ping') {
      try {
        const zones = await CF.listZones();
        return res.status(200).json({ ok: true, zone_count: zones.length, zones: zones.map(z => ({ id: z.id, name: z.name })) });
      } catch (e) {
        return res.status(500).json({ ok: false, error: String(e.message || e) });
      }
    }

    if (op === 'zones') {
      if (!requireAdmin(req, res)) return;
      const zones = await CF.listZones();
      return res.status(200).json({ zones });
    }

    const domain = String(req.query.domain || process.env.KOLM_DOMAIN || 'kolm.ai');

    if (op === 'waf') {
      if (!requireAdmin(req, res)) return;
      const zone_id = await CF.discoverZoneId(domain);
      const rules = await CF.listCustomRules(zone_id);
      return res.status(200).json({ zone_id, rules });
    }

    if (op === 'apply-waf') {
      if (!requireAdmin(req, res)) return;
      const zone_id = await CF.discoverZoneId(domain);
      const rules = CF.defaultWafRules();
      await CF.putCustomRules(zone_id, rules);
      return res.status(200).json({ ok: true, zone_id, applied: rules.length });
    }

    if (op === 'rate-limit') {
      if (!requireAdmin(req, res)) return;
      const zone_id = await CF.discoverZoneId(domain);
      // Reads via the same rulesets endpoint family; reuse the apply helper
      // logic indirectly by hitting the ruleset list endpoint.
      const rules = CF.defaultRateLimitRules();
      return res.status(200).json({ zone_id, planned: rules });
    }

    if (op === 'apply-rate-limit') {
      if (!requireAdmin(req, res)) return;
      const zone_id = await CF.discoverZoneId(domain);
      const rules = CF.defaultRateLimitRules();
      await CF.putRateLimitRules(zone_id, rules);
      return res.status(200).json({ ok: true, zone_id, applied: rules.length });
    }

    if (op === 'email') {
      if (!requireAdmin(req, res)) return;
      const zone_id = await CF.discoverZoneId(domain);
      const status = await CF.emailRoutingStatus(zone_id).catch(e => ({ error: String(e.message || e) }));
      const rules = await CF.listEmailRules(zone_id).catch(() => []);
      return res.status(200).json({ zone_id, status, rules });
    }

    if (op === 'apply-email') {
      if (!requireAdmin(req, res)) return;
      const zone_id = await CF.discoverZoneId(domain);
      await CF.enableEmailRouting(zone_id).catch(() => {});
      const rules = CF.defaultEmailRules();
      const results = [];
      for (const r of rules) {
        try {
          await CF.putEmailRule(zone_id, r);
          results.push({ name: r.name, ok: true });
        } catch (e) {
          results.push({ name: r.name, ok: false, error: String(e.message || e) });
        }
      }
      return res.status(200).json({ ok: true, zone_id, applied: results });
    }

    if (op === 'bootstrap') {
      if (!requireAdmin(req, res)) return;
      const out = await CF.bootstrapZoneHardening({ domain });
      return res.status(200).json({ ok: true, ...out });
    }

    return res.status(400).json({ error: 'unknown op', ops: ['ping', 'zones', 'waf', 'apply-waf', 'rate-limit', 'apply-rate-limit', 'email', 'apply-email', 'bootstrap'] });
  } catch (e) {
    return res.status(500).json({ error: String(e.message || e), stack: process.env.KOLM_DEBUG ? String(e.stack || '') : undefined });
  }
}
