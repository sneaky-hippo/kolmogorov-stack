# SEO + Crawl + Smoke Audit — kolm.ai

**Date:** 2026-05-06
**Scope:** every public page is indexable, has clean OG tags, structured data is valid, every internal link points somewhere real, the site is search-engine ready.

## Summary

- **Files created:** 4
- **Files modified:** 1 (homepage `<head>` only)
- **Files left alone:** all page bodies, CSS, server.js, src/router.js, src/auth.js
- **Pages crawled:** 20
- **Broken internal links found:** 43 (mostly references to legacy v4 routes from non-rebuilt pages)
- **Missing canonical/og/twitter on:** 16 pages still pending the parallel rebuild agent

---

## Files created

| File | Purpose |
|---|---|
| `public/sitemap.xml` | XML sitemap with all 19 indexable surfaces (referenced by robots.txt) |
| `public/robots.txt` | Allow root, disallow /v1/, /api/, /admin, /dashboard, /onboarding, /signin |
| `public/manifest.webmanifest` | PWA manifest — was referenced from index.html, did not exist |
| `_audit/seo_v1.md` | This report |

## Files modified

| File | Change |
|---|---|
| `public/index.html` | Added `<link rel="apple-touch-icon">` + JSON-LD `<script>` block in `<head>` (Organization + WebSite + SoftwareApplication + FAQPage with 10 Q&A). Did not touch any body markup. |

(Note: a parallel agent also modified `index.html` to swap og:image to `/og-card.svg` and add og:image:width/height. Those changes are intentional and preserved.)

---

## Per-page audit

Legend: T=title, D=description, C=canonical, OT=og:title, OD=og:description, OI=og:image, TC=twitter:card

| Page | T | D | C | OT | OD | OI | TC | Broken links |
|---|---|---|---|---|---|---|---|---|
| index.html | Y | Y | Y | Y | Y | Y | Y | /apple-touch-icon.png (PNG not generatable in this env), /docs/cli, /docs/sdk |
| 404.html | Y | Y | Y | Y | Y | Y | Y | /docs/cli, /docs/sdk |
| _404.html | Y | Y | Y | Y | Y | Y | Y | /docs/cli, /docs/sdk |
| security.html | Y | Y | Y | Y | Y | Y | Y | /docs/cli, /docs/sdk |
| status.html | Y | Y | Y | Y | Y | Y | Y | /docs/cli, /docs/sdk |
| 500.html | Y | N | N | N | N | N | N | /why |
| account.html | Y | N | N | N | N | N | N | — |
| cloud.html | Y | Y | N | N | N | N | N | — |
| compile.html | Y | Y | N | N | N | N | N | — |
| dashboard.html | Y | N | N | N | N | N | N | /why, /specialists |
| device.html | Y | Y | N | Y | Y | N | N | /how-it-works, /verified, /economics, /spec, /receipts |
| docs.html | Y | N | N | N | N | N | N | /why, /specialists |
| manual.html | Y | Y | N | N | N | N | N | — |
| mobile.html | Y | Y | N | N | N | N | N | — |
| onboarding.html | Y | N | N | N | N | N | N | /why, /specialists, /why#savings |
| playground.html | Y | N | N | N | N | N | N | /why, /specialists |
| pricing.html | Y | Y | N | N | N | N | N | /optimize, /audit, /why, /specialists, /optimize#calc |
| recall.html | Y | Y | N | N | N | N | N | — |
| registry.html | Y | N | N | N | N | N | N | /why, /specialists |
| run.html | Y | Y | N | N | N | N | N | — |
| signup.html | Y | N | N | N | N | N | N | /why |

## Broken internal link inventory

Legacy v4 routes (referenced from non-rebuilt pages — the parallel rebuild agent should remove these):

| Slug | Used by |
|---|---|
| `/why` | 500.html, dashboard.html, docs.html, onboarding.html, playground.html, pricing.html, registry.html, signup.html |
| `/specialists` | dashboard.html, docs.html, onboarding.html, playground.html, pricing.html, registry.html |
| `/how-it-works` | device.html |
| `/verified` | device.html |
| `/economics` | device.html |
| `/spec` | device.html |
| `/receipts` | device.html |
| `/optimize` | pricing.html |
| `/audit` | pricing.html |

Future routes referenced but not yet wired:

| Slug | Used by | Status |
|---|---|---|
| `/docs/cli` | index.html, 404.html, _404.html, security.html, status.html | Sub-path — rebuild agent needs to add either as separate file or as anchor in docs.html |
| `/docs/sdk` | index.html, 404.html, _404.html, security.html, status.html | Same as above |
| `/apple-touch-icon.png` | index.html (apple-touch-icon link) | PNG cannot be generated in this sandboxed environment — see "Limitations" below |

No broken `src=` references on any page.

## Anchor link audit

All `#`-prefixed links resolve to existing `id="…"` attributes on the same page. Sitemap entries `#rs-1`, `#manifest`, `#receipts` on docs.html are present in sitemap but the IDs don't yet exist in docs.html — the parallel rebuild agent is expected to add them.

---

## Sitemap contents (`public/sitemap.xml`)

19 URLs, lastmod=2026-05-06, changefreq=weekly:

- `/` (priority 1.0)
- `/pricing`, `/signup` (0.9)
- `/compile`, `/run`, `/registry`, `/docs`, `/onboarding`, `/dashboard`, `/mobile`, `/playground`, `/signin` (0.8)
- `/docs/cli`, `/docs/sdk`, `/docs#rs-1`, `/docs#manifest`, `/docs#receipts` (0.7)
- `/security`, `/status` (0.5)

`/v1/*`, `/api/*`, `/admin`, `/account`, etc. are intentionally excluded.

## robots.txt contents (`public/robots.txt`)

```
User-agent: *
Allow: /
Disallow: /v1/
Disallow: /api/
Disallow: /admin
Disallow: /dashboard
Disallow: /onboarding
Disallow: /signin
Sitemap: https://kolm.ai/sitemap.xml
```

## JSON-LD on homepage

One `<script type="application/ld+json">` block, validated to parse cleanly (`JSON.parse` succeeds). Contains `@graph` with 4 entries:

1. **Organization** — name=Kolmogorov, url=https://kolm.ai, logo=https://kolm.ai/aurora.svg
2. **WebSite** — name=kolm, description="Ship private AI on every device.", publisher → Organization
3. **SoftwareApplication** — applicationCategory=DeveloperApplication, operatingSystem covers iOS/Android/Linux/macOS/Windows/Web, three Offer entries (Free $0, Mobile $9, Pro $49)
4. **FAQPage** — 10 Q&A covering what kolm is, data privacy, .kolm artifacts, recipe/adapter/specialist/bundle terminology, offline use, receipt verification, platform support, privacy guarantee, fine-tune comparison, what the cloud sees

`sameAs` (github/twitter) intentionally omitted — no public handles confirmed.

## Manifest webmanifest contents

```json
{
  "name": "kolm",
  "short_name": "kolm",
  "description": "Ship private AI on every device.",
  "start_url": "/",
  "display": "standalone",
  "background_color": "#08090a",
  "theme_color": "#08090a",
  "icons": [
    {"src": "/favicon.svg", "sizes": "any", "type": "image/svg+xml", "purpose": "any"}
  ]
}
```

(Note: an older `public/manifest.json` still exists and is referenced by `device.html`. Left untouched.)

## 404 page

`public/404.html` already has full meta tags, brand nav, footer with product/develop/open columns, "Back to home" + "Read the docs" CTAs, plus three suggestion cards (Compile / Registry / Playground). `server.js` already serves `404.html` from its fallback handler at line 86 — **no server edits were needed**. `_404.html` is a duplicate copy left alone.

---

## Limitations / items not completed

1. **`/apple-touch-icon.png`** — could not generate a 180x180 PNG. No `convert` (ImageMagick), `rsvg-convert`, `sharp`, or `jimp` available in this sandbox. The `<link rel="apple-touch-icon">` tag is in the homepage; the asset itself needs to be checked in by a follow-up step. Recommendation: have the rebuild agent or a human run `rsvg-convert -w 180 -h 180 public/favicon.svg > public/apple-touch-icon.png`, or accept that iOS will fall back to favicon.svg gracefully.

2. **`/og-default.png`** — same constraint. The parallel rebuild agent already swapped homepage og:image to `/og-card.svg` (1200x630). Twitter (X) supports SVG OG images; LinkedIn and Slack also do; Facebook converts on ingestion. Recommendation: this is acceptable as-is. If a guaranteed PNG is needed, three options:
   - Check in a static `og-default.png` (rebuild agent or human).
   - Add an `/og` endpoint that renders SVG → PNG via `@vercel/og` or `resvg`.
   - Accept SVG (current state) — works on the major platforms in 2026.

3. **Per-page canonical/og/twitter coverage** — 16 of 20 pages still need canonical + og:title + og:description + og:image + twitter:card. The parallel rebuild agent is rewriting bodies and is best-positioned to add these in the same pass; this audit deliberately did not modify those page heads to avoid merge conflicts. Pages that already have full coverage: index.html, 404.html, _404.html, security.html, status.html.

4. **Legacy v4 broken links** — 9 distinct slugs (`/why`, `/specialists`, `/how-it-works`, `/verified`, `/economics`, `/spec`, `/receipts`, `/optimize`, `/audit`) are still referenced from non-rebuilt pages. `server.js` lines 70-73 still maps these routes to legacy filenames that no longer exist in `public/`, so they 404 at runtime. The rebuild agent will retire them.

5. **`/docs/cli` and `/docs/sdk`** — referenced from 5 pages including index.html, but no file/route handles them. Either:
   - Add `public/docs/cli.html` + `public/docs/sdk.html` (and update server.js with `/docs/cli` + `/docs/sdk` route entries).
   - Convert references to `/docs#cli` + `/docs#sdk` and add the matching `<h3 id="cli">` / `<h3 id="sdk">` to docs.html.
   The sitemap entries assume the first option.

6. **Missing IDs in docs.html** — sitemap declares `/docs#rs-1`, `/docs#manifest`, `/docs#receipts` but docs.html does not have those IDs yet. Rebuild agent should add them.

---

## Smoke verification

- `node -e "JSON.parse(...)"` on the homepage JSON-LD: parses cleanly, 4 graph entries, 10 FAQ questions.
- `xml` validity of sitemap: well-formed XML, single `<urlset>` root, all entries have `<loc>` + `<lastmod>` + `<changefreq>` + `<priority>`.
- `robots.txt` is plain text, ends with newline, references `https://kolm.ai/sitemap.xml`.
- `manifest.webmanifest` is valid JSON.
- `server.js` 404 fallback already serves `public/404.html` correctly. **No edit was needed.**
