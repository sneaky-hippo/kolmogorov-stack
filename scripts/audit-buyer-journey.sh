#!/usr/bin/env bash
# audit-buyer-journey.sh
# Walk a buyer's full path through kolm.ai. 30 spot-probes. Fail loudly on any drift.
# Usage: URL=https://kolm.ai bash scripts/audit-buyer-journey.sh
# Exit 0 = all 30 probes pass. Exit 1 = at least one failure.

set -u
URL="${URL:-https://kolm.ai}"
PASS=0
FAIL=0
FAILS=()

probe() {
  # probe <label> <path> <expected-status> [grep-pattern]
  local label="$1"
  local path="$2"
  local expected="$3"
  local pattern="${4:-}"

  local code
  code=$(curl -s -o /tmp/kolm-probe-body -w "%{http_code}" "${URL}${path}" 2>/dev/null || echo "000")

  if [ "$code" != "$expected" ]; then
    FAIL=$((FAIL+1))
    FAILS+=("[$label] $path -> $code (expected $expected)")
    return
  fi

  if [ -n "$pattern" ]; then
    if ! grep -qE "$pattern" /tmp/kolm-probe-body 2>/dev/null; then
      FAIL=$((FAIL+1))
      FAILS+=("[$label] $path -> $code but missing /$pattern/")
      return
    fi
  fi

  PASS=$((PASS+1))
}

echo "==> audit-buyer-journey.sh   URL=$URL"
echo

# Stage 1 . landing + first impression (5 probes)
probe "landing"            "/"                              200 "kolm"
probe "hero-quant"         "/"                              200 "7\.42|hero-quant"
probe "pricing-cta"        "/"                              200 "See pricing|href=\"/pricing\""
probe "frontier-strip"     "/"                              200 "Forty-two frontier|frontier-strip"
probe "favicon"            "/favicon.svg"                   200

# Stage 2 . pricing + commercial story (5 probes)
probe "pricing"            "/pricing"                       200 "Developer.*Starter|Pro.*Teams"
probe "pricing-addons"     "/pricing"                       200 "Compile passes|Hosted inference|Artifact storage"
probe "roi"                "/roi"                           200
probe "compare-index"      "/compare"                       200
probe "compare-openpipe"   "/compare/kolm-vs-openpipe"      200 "OpenPipe|truth-table|matrix|axis"

# Stage 3 . docs + proof (6 probes)
probe "docs"               "/docs"                          200
probe "spec"               "/spec"                          200
probe "spec-rs1"           "/spec/rs-1"                     200 "RS-1|manifest|HMAC"
probe "k-score"            "/k-score"                       200
probe "research"           "/research"                      200 "Forty-two|forty-two"
probe "leaderboard"        "/leaderboard"                   200

# Stage 4 . tutorials + golden paths (4 probes)
probe "tutorials"          "/tutorials"                     200 "Golden Path|PHI redactor"
probe "tut-phi"            "/tutorials/phi-redactor"        200 "phi-redactor\.kolm|K-score"
probe "tut-openai"         "/tutorials/openai-drop-in"      200 "chat\.completions|base_url"
probe "tut-ci"             "/tutorials/ci-verify"           200 "kolm-verify|github-actions|min_k"

# Stage 5 . trust + procurement (5 probes)
probe "security"           "/security"                      200
probe "soc2"               "/soc2"                          200 "SOC 2|Type 1|audit window"
probe "sbom"               "/sbom"                          200 "CycloneDX|bill of materials"
probe "bounty"             "/bounty"                        200 "10,000|verifier bypass"
probe "baa"                "/baa"                           200 "BAA|DPA|DocuSign"

# Stage 6 . signup -> first artifact (5 probes)
probe "signup"             "/signup"                        200
probe "quickstart"         "/quickstart"                    200 "npm install|kolm compile"
probe "dashboard"          "/dashboard"                     200
probe "showcase"           "/showcase"                      200
probe "showcase-receipt"   "/docs/showcase/receipt.json"    200 "k_score|cid|receipt"

echo
echo "==> $PASS pass, $FAIL fail"
if [ "$FAIL" -gt 0 ]; then
  echo
  echo "Failures:"
  for f in "${FAILS[@]}"; do
    echo "  - $f"
  done
  exit 1
fi
exit 0
