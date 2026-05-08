#!/usr/bin/env bash
# Full live smoke battery for Railway deploy.
URL="${URL:-https://kolmogorov-stack-production.up.railway.app}"
PASS=0; FAIL=0; FAILED=()

check() {
  local name="$1"; shift
  if "$@" >/dev/null 2>&1; then echo "  PASS  $name"; PASS=$((PASS+1));
  else echo "  FAIL  $name"; FAIL=$((FAIL+1)); FAILED+=("$name"); fi
}

has() { local body="$1"; local needle="$2"; echo "$body" | grep -q -e "$needle"; }
hashi() { local body="$1"; local needle="$2"; echo "$body" | grep -qi -e "$needle"; }
lacks() { local body="$1"; local needle="$2"; ! echo "$body" | grep -q -e "$needle"; }
eq() { [ "$1" = "$2" ]; }

echo "=== 1. Public + auto-mint ==="
H_HEALTH=$(curl -s "$URL/health")
check "/health version=0.2.0" has "$H_HEALTH" '"version":"0.2.0"'
check "/health stats present" has "$H_HEALTH" '"stats"'

PRICING=$(curl -s "$URL/v1/pricing")
check "/pricing USD" has "$PRICING" '"currency":"USD"'

SEED="smoke$(date +%s)"
SIGNUP=$(curl -sX POST "$URL/v1/signup" -H 'Content-Type: application/json' \
  -d "{\"email\":\"$SEED@smoke.test\",\"name\":\"$SEED\"}")
KEY=$(echo "$SIGNUP" | grep -oE 'ks_[a-z0-9]+' | head -1)
check "/v1/signup mints key" test -n "$KEY"
echo "    key=$KEY"

PUB=$(curl -s "$URL/v1/public/concepts")
check "/v1/public/concepts no-auth" has "$PUB" '"concepts"'
PUB_COUNT=$(echo "$PUB" | grep -oE 'cpt_[a-z0-9]+' | sort -u | wc -l)
echo "    public concepts: $PUB_COUNT"
check "public concepts >= 25" test "$PUB_COUNT" -ge 25

PUB_ID=$(echo "$PUB" | grep -oE 'cpt_[a-z0-9]+' | head -1)
PUB_RUN=$(curl -sX POST "$URL/v1/public/run" -H 'Content-Type: application/json' \
  -d "{\"concept_id\":\"$PUB_ID\",\"input\":\"hello\"}")
check "/v1/public/run no-auth" has "$PUB_RUN" '"output"\|"version_id"'

echo ""
echo "=== 2. Auth, rate-limit, quota, compression ==="
NA=$(curl -s -o /dev/null -w "%{http_code}" "$URL/v1/concepts")
check "no key 401" test "$NA" = "401"
BK=$(curl -s -o /dev/null -w "%{http_code}" -H "X-API-Key: ks_nope" "$URL/v1/concepts")
check "bad key 401" test "$BK" = "401"

RL=$(curl -sI "$URL/v1/concepts" -H "X-API-Key: $KEY")
check "X-RateLimit-Limit" hashi "$RL" "X-RateLimit-Limit"
check "X-RateLimit-Remaining" hashi "$RL" "X-RateLimit-Remaining"
check "X-RateLimit-Burst" hashi "$RL" "X-RateLimit-Burst"
check "X-Quota-Limit" hashi "$RL" "X-Quota-Limit"
check "X-Quota-Used" hashi "$RL" "X-Quota-Used"
check "X-Quota-Remaining" hashi "$RL" "X-Quota-Remaining"

COMP=$(curl -s -D - -o /dev/null -H "X-API-Key: $KEY" -H "Accept-Encoding: gzip" "$URL/v1/concepts")
check "gzip on JSON GET" hashi "$COMP" "Content-Encoding: gzip"

ST=$(curl -sI "$URL/styles.css")
check "static cache-control" hashi "$ST" "Cache-Control"

echo ""
echo "=== 3. Synthesis (single) ==="
SYN=$(curl -sX POST "$URL/v1/synthesize" -H "X-API-Key: $KEY" -H 'Content-Type: application/json' \
  -d '{"name":"smoke-bool","positives":[{"input":"YES","expected":true},{"input":"YEAH","expected":true},{"input":"no","expected":false},{"input":"never","expected":false}],"output_spec":{"type":"boolean"}}')
check "synthesize accepted" has "$SYN" '"accepted":true'
NEW_CID=$(echo "$SYN" | grep -oE 'cpt_[a-z0-9]+' | head -1)
NEW_VID=$(echo "$SYN" | grep -oE 'ver_[a-z0-9]+' | head -1)
echo "    synthesised: $NEW_CID"

VER=$(curl -sX POST "$URL/v1/verify" -H "X-API-Key: $KEY" -H 'Content-Type: application/json' \
  -d '{"source":"function classify(s){ return /^\\d+$/.test(String(s)); }","positives":[{"input":"123","expected":true},{"input":"abc","expected":false}]}')
check "/v1/verify returns pass_rate" has "$VER" '"pass_rate'

echo ""
echo "=== 4. Synthesis (batch — NEW) ==="
BATCH=$(curl -sX POST "$URL/v1/synthesize/batch" -H "X-API-Key: $KEY" -H 'Content-Type: application/json' \
  -d '{"items":[
    {"name":"smoke-batch-a","positives":[{"input":"big","expected":true},{"input":"large","expected":true},{"input":"tiny","expected":false},{"input":"small","expected":false}],"output_spec":{"type":"boolean"}},
    {"name":"smoke-batch-b","positives":[{"input":"hello","expected":true},{"input":"hi","expected":true},{"input":"goodbye","expected":false},{"input":"farewell","expected":false}],"output_spec":{"type":"boolean"}}
  ]}')
check "batch results array" has "$BATCH" '"results"'
check "batch total=2" has "$BATCH" '"total":2'
check "batch has accepted count" has "$BATCH" '"accepted"'

OVER=$(curl -sX POST "$URL/v1/synthesize/batch" -H "X-API-Key: $KEY" -H 'Content-Type: application/json' \
  -d '{"items":[1,2,3,4,5,6,7,8,9,10,11,12,13,14,15,16,17,18,19,20,21,22,23,24,25,26]}')
check "batch >25 rejected" has "$OVER" 'max 25 items'

EMPTY=$(curl -sX POST "$URL/v1/synthesize/batch" -H "X-API-Key: $KEY" -H 'Content-Type: application/json' -d '{"items":[]}')
check "batch empty rejected" has "$EMPTY" 'items\[\] required'

echo ""
echo "=== 5. Registry ==="
LIST=$(curl -s "$URL/v1/concepts" -H "X-API-Key: $KEY")
check "/v1/concepts list" has "$LIST" '"concepts"'
GET=$(curl -s "$URL/v1/concepts/$NEW_CID" -H "X-API-Key: $KEY")
check "GET concept by id" has "$GET" "\"id\":\"$NEW_CID\""
LIN=$(curl -s "$URL/v1/concepts/$NEW_CID/lineage" -H "X-API-Key: $KEY")
check "GET lineage" has "$LIN" '"versions"\|"head_version"'
SR=$(curl -sX POST "$URL/v1/search" -H "X-API-Key: $KEY" -H 'Content-Type: application/json' -d '{"query":"detect spam emails","k":3}')
check "/v1/search matches" has "$SR" '"matches"'

echo ""
echo "=== 6. Runtime ==="
RUN=$(curl -sX POST "$URL/v1/run" -H "X-API-Key: $KEY" -H 'Content-Type: application/json' \
  -d "{\"concept_id\":\"$NEW_CID\",\"input\":\"YES\"}")
check "/v1/run output" has "$RUN" '"output"'
RUN2=$(curl -sX POST "$URL/v1/run" -H "X-API-Key: $KEY" -H 'Content-Type: application/json' \
  -d "{\"concept_id\":\"$NEW_CID\",\"input\":\"YES\"}")
check "second run cache hit" has "$RUN2" '"cache":"L1'
COMP_ATT=$(curl -sX POST "$URL/v1/compose" -H "X-API-Key: $KEY" -H 'Content-Type: application/json' \
  -d '{"query":"is this an email or url","input":"hi@example.com","k":3,"strategy":"attention"}')
check "compose dispatched" has "$COMP_ATT" '"dispatched"'

echo ""
echo "=== 7. NEW: Concept stats ==="
curl -sX POST "$URL/v1/run" -H "X-API-Key: $KEY" -H 'Content-Type: application/json' \
  -d "{\"concept_id\":\"$NEW_CID\",\"input\":\"NO\"}" >/dev/null
STATS=$(curl -s "$URL/v1/concepts/$NEW_CID/stats" -H "X-API-Key: $KEY")
echo "    stats: $STATS"
check "stats invocations field" has "$STATS" '"invocations"'
check "stats latency_us p50" has "$STATS" '"p50"'
check "stats cache_hit_rate" has "$STATS" '"cache_hit_rate"'
BS=$(curl -s -o /dev/null -w "%{http_code}" "$URL/v1/concepts/cpt_nope/stats" -H "X-API-Key: $KEY")
check "stats unknown 404" test "$BS" = "404"

echo ""
echo "=== 8. Account, telemetry, library ==="
ACC=$(curl -s "$URL/v1/account" -H "X-API-Key: $KEY")
check "/v1/account plan" has "$ACC" '"plan":"free"'
TEL=$(curl -s "$URL/v1/telemetry" -H "X-API-Key: $KEY")
check "/v1/telemetry total_invocations" has "$TEL" '"total_invocations"'
LIBR=$(curl -s "$URL/v1/library" -H "X-API-Key: $KEY")
check "/v1/library version" has "$LIBR" '"version"'

echo ""
echo "=== 9. Pages ==="
# v5 (kolm) surfaces — Sprint 1 retired /why, /specialists, /spec, /receipts,
# /how-it-works, /verified, /economics, /device into public/_archive/.
for p in "" dashboard playground docs registry signup pricing status; do
  C=$(curl -s -o /dev/null -w "%{http_code}" "$URL/$p")
  check "GET /$p → 200" test "$C" = "200"
done
NF=$(curl -s -o /dev/null -w "%{http_code}" "$URL/no-such-page")
check "404 fallback" test "$NF" = "404"

echo ""
echo "=== 10. NEW: Recipe aliases ==="
RA=$(curl -s "$URL/v1/recipes" -H "X-API-Key: $KEY")
check "/v1/recipes aliases /v1/concepts" has "$RA" '"recipes"'
RA1=$(curl -s "$URL/v1/recipes/$NEW_CID" -H "X-API-Key: $KEY")
check "GET /v1/recipes/:id" has "$RA1" "\"id\":\"$NEW_CID\""
RA2=$(curl -s "$URL/v1/recipes/$NEW_CID/stats" -H "X-API-Key: $KEY")
check "GET /v1/recipes/:id/stats" has "$RA2" '"invocations"'

echo ""
echo "=== 11. NEW: Auto-labeling (Day 30-60) ==="
LBL=$(curl -sX POST "$URL/v1/recipes/$NEW_CID/label-corpus" -H "X-API-Key: $KEY" -H 'Content-Type: application/json' \
  -d '{"corpus":{"type":"inline","rows":[{"input":"YES"},{"input":"no"},{"input":"YEP"}]}}')
check "label-corpus inline" has "$LBL" '"rows_labeled":3'
check "label-corpus job_id" has "$LBL" '"job_id"'
HFQ=$(curl -sX POST "$URL/v1/recipes/$NEW_CID/label-corpus" -H "X-API-Key: $KEY" -H 'Content-Type: application/json' \
  -d '{"corpus":{"type":"huggingface","name":"glue/sst2"},"max_rows":100}')
check "label-corpus HF queues" has "$HFQ" '"status":"queued"'
JID=$(echo "$HFQ" | sed -nE 's/.*"job_id":"([^"]+)".*/\1/p' | head -1)
JR=$(curl -s "$URL/v1/jobs/$JID" -H "X-API-Key: $KEY")
check "GET /v1/jobs/:id" has "$JR" "\"id\":\"$JID\""

echo ""
echo "=== 12. NEW: Specialists (Day 60-120) ==="
WL=$(curl -sX POST "$URL/v1/specialists/waitlist" -H 'Content-Type: application/json' \
  -d "{\"email\":\"smoke-$(date +%s)@test.io\",\"task\":\"detect spam in user signups\"}")
check "waitlist no-auth POST" has "$WL" '"position"'
TR=$(curl -sX POST "$URL/v1/specialists/train" -H "X-API-Key: $KEY" -H 'Content-Type: application/json' \
  -d "{\"name\":\"smoke-spec\",\"recipe_id\":\"$NEW_CID\",\"base_model\":\"Qwen3-1.5B\"}")
check "specialists/train queues 202" has "$TR" '"specialist_id"'
SID=$(echo "$TR" | grep -oE 'spc_[a-z0-9]+' | head -1)
SL=$(curl -s "$URL/v1/specialists" -H "X-API-Key: $KEY")
check "GET /v1/specialists" has "$SL" '"specialists"'
SDET=$(curl -s "$URL/v1/specialists/$SID" -H "X-API-Key: $KEY")
check "GET /v1/specialists/:id" has "$SDET" "\"id\":\"$SID\""
WTH=$(curl -s -o /dev/null -w "%{http_code}" "$URL/v1/specialists/$SID/weights" -H "X-API-Key: $KEY")
check "weights 503 until trained" test "$WTH" = "503"
SR=$(curl -sX POST "$URL/v1/specialists/$SID/run" -H "X-API-Key: $KEY" -H 'Content-Type: application/json' \
  -d '{"input":"YES"}')
check "specialists/run falls back to recipe" has "$SR" '"output"'

echo ""
echo "=== 13. NEW: Public submissions + featured (Day 120-180) ==="
SUB=$(curl -sX POST "$URL/v1/public/submit" -H "X-API-Key: $KEY" -H 'Content-Type: application/json' \
  -d "{\"recipe_id\":\"$NEW_CID\",\"blurb\":\"smoke recipe\",\"contact\":\"x@y.io\"}")
check "public/submit accepts" has "$SUB" '"submission_id"'
NOAUTH=$(curl -s -o /dev/null -w "%{http_code}" -X POST "$URL/v1/public/submit" -H 'Content-Type: application/json' -d '{"recipe_id":"x"}')
check "public/submit no-auth → 401" test "$NOAUTH" = "401"
FEAT=$(curl -s "$URL/v1/public/featured")
check "public/featured no-auth" has "$FEAT" '"featured"'

echo ""
echo "=== 14. NEW: Admin triage ==="
ADMIN_KEY="${ADMIN_KEY:-ks_admin_change_me}"
ADMIN_PROBE=$(curl -s -o /dev/null -w "%{http_code}" "$URL/v1/admin/waitlist" -H "X-API-Key: $ADMIN_KEY")
if [ "$ADMIN_PROBE" = "401" ]; then
  echo "  SKIP  admin/waitlist (ADMIN_KEY env not set or differs from server's; pass ADMIN_KEY=… to test)"
  echo "  SKIP  admin/submissions"
else
  AWL=$(curl -s "$URL/v1/admin/waitlist" -H "X-API-Key: $ADMIN_KEY")
  check "admin/waitlist" has "$AWL" '"waitlist"'
  ASUB=$(curl -s "$URL/v1/admin/submissions" -H "X-API-Key: $ADMIN_KEY")
  check "admin/submissions" has "$ASUB" '"submissions"'
fi
DENY=$(curl -s -o /dev/null -w "%{http_code}" "$URL/v1/admin/waitlist" -H "X-API-Key: $KEY")
check "admin/waitlist non-admin → 403" test "$DENY" = "403"

echo ""
echo "=== 15. NEW: Phase F bridges (compounding Memory ↔ Recipes ↔ Specialists) ==="
# Observe 4 calls with the same instructional template
for inp_resp in 'WIN free iPhone|true' 'CLICK FOR PRIZES|true' 'see you tomorrow|false' 'lunch?|false'; do
  inp="${inp_resp%|*}"; resp="${inp_resp#*|}"
  curl -s -o /dev/null -X POST "$URL/v1/bridges/observe" -H "X-API-Key: $KEY" -H 'Content-Type: application/json' \
    -d "{\"model\":\"claude-sonnet-4-6\",\"prompt\":\"Is this spam? $inp\",\"response\":$resp,\"latency_ms\":620,\"cost_usd\":0.001}"
done
SUGS=$(curl -s "$URL/v1/bridges/suggestions" -H "X-API-Key: $KEY")
check "bridges/suggestions returns" has "$SUGS" '"suggestions"'
check "bridges suggestion total >= 1" has "$SUGS" '"total":[1-9]'

THASH=$(echo "$SUGS" | sed -nE 's/.*"template_hash":"([^"]+)".*/\1/p' | head -1)
if [ -n "$THASH" ]; then
  AS=$(curl -sX POST "$URL/v1/bridges/auto-synthesize" -H "X-API-Key: $KEY" -H 'Content-Type: application/json' \
    -d "{\"template_hash\":\"$THASH\",\"name\":\"smoke-bridge-$$\"}")
  check "bridges/auto-synthesize returns" has "$AS" '"strategy"\|"accepted"'
fi

CAND=$(curl -s "$URL/v1/bridges/specialist-candidates" -H "X-API-Key: $KEY")
check "bridges/specialist-candidates" has "$CAND" '"candidates"'

LIN=$(curl -s "$URL/v1/recipes/$NEW_CID/lineage" -H "X-API-Key: $KEY")
check "recipes/:id/lineage returns" has "$LIN" '"lineage"'
check "recipes/:id/lineage has invocations" has "$LIN" '"invocations"'

REC=$(curl -sX POST "$URL/v1/memory/recall" -H "X-API-Key: $KEY" -H 'Content-Type: application/json' \
  -d '{"query":"detect spam","input":"WIN free Bitcoin","k":2}')
check "memory/recall returns results" has "$REC" '"results"'

echo ""
echo "=== 17. Anonymous CLI auth (autonomous bootstrap) ==="
ANON_BOOT=$(curl -sX POST "$URL/v1/anon/bootstrap" -H 'Content-Type: application/json' -d '{"hostname":"smoke","user_agent":"smoke-test/1.0"}')
check "anon/bootstrap returns kao_ token" has "$ANON_BOOT" '"anon_token":"kao_'
check "anon/bootstrap has 30d expiry" has "$ANON_BOOT" '"expires_at"'
check "anon/bootstrap nudges to claim" has "$ANON_BOOT" 'kolm claim'
ANON_TOK=$(echo "$ANON_BOOT" | grep -oE 'kao_[a-f0-9]+' | head -1)

ANON_LIST=$(curl -s "$URL/v1/concepts" -H "X-API-Key: $ANON_TOK")
check "anon token authed against /v1/concepts" has "$ANON_LIST" '"concepts"'

ANON_CLAIM=$(curl -sX POST "$URL/v1/anon/claim" -H 'Content-Type: application/json' \
  -d "{\"anon_token\":\"$ANON_TOK\",\"email\":\"smoke-claim-$(date +%s)@smoke.test\",\"name\":\"smoke\"}")
check "anon/claim upgrades to ks_ key" has "$ANON_CLAIM" '"api_key":"ks_'
check "anon/claim mode is upgraded" has "$ANON_CLAIM" '"mode":"upgraded"'
NEW_KS=$(echo "$ANON_CLAIM" | grep -oE 'ks_[a-f0-9]+' | head -1)

# After claim: old anon token → 401, new ks_ token → 200
OLD_STATUS=$(curl -s -o /dev/null -w "%{http_code}" "$URL/v1/concepts" -H "X-API-Key: $ANON_TOK")
check "claimed anon token rejected (401)" test "$OLD_STATUS" = "401"
NEW_STATUS=$(curl -s -o /dev/null -w "%{http_code}" "$URL/v1/concepts" -H "X-API-Key: $NEW_KS")
check "post-claim ks_ token works (200)" test "$NEW_STATUS" = "200"

# Bad claim attempts
BAD_CLAIM=$(curl -s -o /dev/null -w "%{http_code}" -X POST "$URL/v1/anon/claim" -H 'Content-Type: application/json' \
  -d '{"anon_token":"kao_does_not_exist","email":"x@y.com"}')
check "claim with bogus token → 400" test "$BAD_CLAIM" = "400"

echo ""
echo "=== 16. Phase G polish (HTML + branded errors) ==="
AC=$(curl -s -o /dev/null -w "%{http_code}" "$URL/account")
check "/account 200" test "$AC" = "200"
NF=$(curl -s -o /dev/null -w "%{http_code}" "$URL/this-route-does-not-exist-recipe")
check "unknown route 404" test "$NF" = "404"
NF_BODY=$(curl -s "$URL/this-route-does-not-exist-recipe")
check "404 page is branded" has "$NF_BODY" '404'

echo ""
echo "=== 18. RS-1 spec + cryptographic receipts ==="
SPEC=$(curl -s "$URL/v1/spec")
check "/v1/spec public no-auth" has "$SPEC" '"spec":"rs-1"'
check "/v1/spec has conformance" has "$SPEC" 'conformance'
check "/v1/spec has license MIT" has "$SPEC" '"license":"MIT"'

# Issue receipt via /v1/public/run (no-auth path)
RECEIPT_RUN=$(curl -sX POST "$URL/v1/public/run" -H 'Content-Type: application/json' \
  -d "{\"concept_id\":\"$PUB_ID\",\"input\":\"smoke check\"}")
check "/v1/public/run issues receipt" has "$RECEIPT_RUN" '"receipt"'
check "receipt has source_hash" has "$RECEIPT_RUN" '"source_hash"'
check "receipt has hmac" has "$RECEIPT_RUN" '"hmac"'

# Extract receipt via node — sed is too fragile with nested JSON
RECEIPT_JSON=$(echo "$RECEIPT_RUN" | node -e 'let d="";process.stdin.on("data",c=>d+=c).on("end",()=>{process.stdout.write(JSON.stringify(JSON.parse(d).receipt))})' 2>/dev/null)
VERIFY=$(curl -sX POST "$URL/v1/receipts/verify" -H 'Content-Type: application/json' \
  -d "{\"receipt\":$RECEIPT_JSON}")
check "/v1/receipts/verify valid" has "$VERIFY" '"valid":true'

echo ""
echo "=== 20. On-device PWA + browser SDK ==="
SDK_HEADERS=$(curl -sI "$URL/sdk.js")
check "/sdk.js 200" hashi "$SDK_HEADERS" "HTTP/[12].[12] 200\|HTTP/2 200"
check "/sdk.js JS Content-Type" hashi "$SDK_HEADERS" "Content-Type:.*\(javascript\|js\)"
SDK_BODY=$(curl -s "$URL/sdk.js")
check "/sdk.js exports recipe" has "$SDK_BODY" 'export const recipe'
check "/sdk.js has Recipe class" has "$SDK_BODY" 'class Recipe'
check "/sdk.js has wrap method" has "$SDK_BODY" 'wrap(client'
MAN=$(curl -s "$URL/manifest.json")
check "/manifest.json valid" has "$MAN" '"start_url"'
SW=$(curl -s "$URL/sw.js")
check "/sw.js install handler" has "$SW" "addEventListener('install'"
check "/sw.js precache list" has "$SW" "PRECACHE"
REG_EXPORT=$(curl -s "$URL/v1/registry/export")
REG_RECIPES=$(echo "$REG_EXPORT" | grep -oE '"name"' | wc -l)
check "/v1/registry/export returns recipes" test "$REG_RECIPES" -gt 0
check "/v1/registry/export has spec rs-1" has "$REG_EXPORT" '"spec":"rs-1"'

echo ""
echo "=== 21. Sprint 0 — security gate (S1-S10) ==="
# S1: escape.js shipped + present on the high-risk pages
ESC=$(curl -s -o /dev/null -w "%{http_code}" "$URL/escape.js")
check "S1 /escape.js 200" test "$ESC" = "200"
ESC_BODY=$(curl -s "$URL/escape.js")
check "S1 escape exports KSesc" has "$ESC_BODY" 'window.KSesc'
REG_HTML=$(curl -s "$URL/registry")
check "S1 registry imports escape" has "$REG_HTML" '/escape.js'
ACCT_HTML=$(curl -s "$URL/account")
check "S1 account imports escape" has "$ACCT_HTML" '/escape.js'

# S2: recipe-worker shipped, sdk.js no longer compiles on main thread
WK=$(curl -s -o /dev/null -w "%{http_code}" "$URL/recipe-worker.js")
check "S2 /recipe-worker.js 200" test "$WK" = "200"
WK_BODY=$(curl -s "$URL/recipe-worker.js")
check "S2 worker locks down fetch" has "$WK_BODY" "kill = "
SDK_NEW=$(curl -s "$URL/sdk.js")
check "S2 sdk.js spawns worker" has "$SDK_NEW" 'recipe-worker'
check "S2 sdk.js advertises sandbox runtime" has "$SDK_NEW" 'browser-sdk-sandbox'

# S3+S4: helmet ahead of static — CSP + HSTS + X-Frame-Options on /styles.css
ST_HEADERS=$(curl -sI "$URL/styles.css")
check "S3 CSP on static" hashi "$ST_HEADERS" "Content-Security-Policy"
check "S4 HSTS on static" hashi "$ST_HEADERS" "Strict-Transport-Security"
check "S4 X-Frame-Options on static" hashi "$ST_HEADERS" "X-Frame-Options"

# S5: signup rate-limit headers
SU_HEADERS=$(curl -sI -X POST "$URL/v1/signup")
check "S5 signup RateLimit headers" hashi "$SU_HEADERS" "RateLimit-"

# S6: versioned sdk + manifest
SVM=$(curl -s "$URL/sdk-versions.json")
check "S6 /sdk-versions.json present" has "$SVM" '"current"'
check "S6 manifest carries SRI" has "$SVM" 'sha384-'
SHA_URL=$(echo "$SVM" | grep -oE '/sdk-[a-f0-9]+\.js' | head -1)
if [ -n "$SHA_URL" ]; then
  SVR=$(curl -s -o /dev/null -w "%{http_code}" "$URL$SHA_URL")
  check "S6 versioned sdk.js fetches" test "$SVR" = "200"
fi

# S7: cookie session endpoints
SL_400=$(curl -s -o /dev/null -w "%{http_code}" -X POST "$URL/v1/session/login" -H "Content-Type: application/json" -d '{}')
check "S7 session/login 400 w/o key" test "$SL_400" = "400"
SL_401=$(curl -s -o /dev/null -w "%{http_code}" -X POST "$URL/v1/session/login" -H "Content-Type: application/json" -d '{"api_key":"ks_nope"}')
check "S7 session/login 401 bad key" test "$SL_401" = "401"
SL_OUT=$(curl -s -o /dev/null -w "%{http_code}" -X POST "$URL/v1/session/logout")
check "S7 session/logout 200" test "$SL_OUT" = "200"

# S8: /health no longer leaks has_anthropic_key (info-disclosure)
H=$(curl -s "$URL/health")
if echo "$H" | grep -q 'has_anthropic_key'; then echo "  FAIL  S8 /health leaks has_anthropic_key"; FAIL=$((FAIL+1)); FAILED+=("S8 /health leaks has_anthropic_key"); else echo "  PASS  S8 /health no provider leak"; PASS=$((PASS+1)); fi
H1=$(curl -s -o /dev/null -w "%{http_code}" "$URL/v1/health")
check "S8 /v1/health requires auth" test "$H1" = "401"

# S9: wrap() honestly framed (no longer claims passthrough auto-routing)
SDK_WRAP=$(curl -s "$URL/sdk.js")
check "S9 wrap() telemetry-honest" has "$SDK_WRAP" "__wrap__"
check "S9 wrap() advertises Sprint 1 routing" has "$SDK_WRAP" "/v1/wrap/verified"

# S10: registry/export rate-limit headers
RX=$(curl -sI "$URL/v1/registry/export")
check "S10 registry/export RateLimit" hashi "$RX" "RateLimit-Limit"

echo ""
echo "=== 22. Sprint 1 — Recall (engine 4) ==="
# Auth gates first
RC_NA=$(curl -s -o /dev/null -w "%{http_code}" -X POST "$URL/v1/recall" -H 'Content-Type: application/json' -d '{"query":"x"}')
check "recall 401 w/o key" test "$RC_NA" = "401"
EM_NA=$(curl -s -o /dev/null -w "%{http_code}" -X POST "$URL/v1/embed" -H 'Content-Type: application/json' -d '{"paths":[]}')
check "embed 401 w/o key" test "$EM_NA" = "401"

# Status — auth required, returns shape
RS=$(curl -s "$URL/v1/recall/status" -H "X-API-Key: $KEY")
check "recall/status returns shape" has "$RS" '"available"\|"backend"\|"ok"'

# Hybrid query with auth — chunks may be empty if qmd backend absent (graceful degradation)
RC_OK=$(curl -sX POST "$URL/v1/recall" -H "X-API-Key: $KEY" -H 'Content-Type: application/json' \
  -d '{"namespace":"smoke","query":"hello world","k":3}')
check "recall returns chunks shape" has "$RC_OK" '"chunks"'
check "recall returns namespace" has "$RC_OK" '"namespace"'

# Validation
RC_BADK=$(curl -sX POST "$URL/v1/recall" -H "X-API-Key: $KEY" -H 'Content-Type: application/json' \
  -d '{"query":"x","k":999}')
check "recall rejects k>100" has "$RC_BADK" 'k must be'
RC_NOQ=$(curl -sX POST "$URL/v1/recall" -H "X-API-Key: $KEY" -H 'Content-Type: application/json' -d '{}')
check "recall rejects no query" has "$RC_NOQ" 'query'

# Embed validates inputs
EM_NOPATHS=$(curl -sX POST "$URL/v1/embed" -H "X-API-Key: $KEY" -H 'Content-Type: application/json' -d '{}')
check "embed rejects no paths" has "$EM_NOPATHS" 'paths'

# Recall surface page
RP=$(curl -s -o /dev/null -w "%{http_code}" "$URL/recall")
check "/recall page 200" test "$RP" = "200"
RP_BODY=$(curl -s "$URL/recall")
check "/recall page mentions multimodal" hashi "$RP_BODY" "multimodal"
check "/recall page has codebox" has "$RP_BODY" 'kolm recall'

echo ""
echo "=== 23. Sprint 1 — Compile orchestrator + .kolm + K-score ==="
# Auth gates
CO_NA=$(curl -s -o /dev/null -w "%{http_code}" -X POST "$URL/v1/compile" -H 'Content-Type: application/json' -d '{}')
check "compile 401 w/o key" test "$CO_NA" = "401"
CO_NOTASK=$(curl -sX POST "$URL/v1/compile" -H "X-API-Key: $KEY" -H 'Content-Type: application/json' -d '{}')
check "compile 400 w/o task" has "$CO_NOTASK" 'task'

# Real compile — sign classifier (the homepage demo)
CO=$(curl -sX POST "$URL/v1/compile" -H "X-API-Key: $KEY" -H 'Content-Type: application/json' \
  -d '{"task":"classify a number as positive, zero, or negative","examples":[{"input":"7","expected":"positive"},{"input":"0","expected":"zero"},{"input":"-3","expected":"negative"},{"input":"42","expected":"positive"},{"input":"-1.5","expected":"negative"}]}')
check "compile returns job_id" has "$CO" '"job_id"'
# job_id is 12 hex chars (crypto.randomBytes(6).toString('hex')) — anchor on the value, not the key text "job_id"
JOBID=$(echo "$CO" | sed -nE 's/.*"job_id":"(job_[a-f0-9]{12})".*/\1/p' | head -1)
check "compile job_id parsed" test -n "$JOBID"

# Poll for completion (compile runs in <2s typically; allow 30s headroom)
JOB_STATUS="queued"
for i in 1 2 3 4 5 6 7 8 9 10 11 12 13 14 15; do
  JOB_DOC=$(curl -s "$URL/v1/compile/$JOBID" -H "X-API-Key: $KEY")
  JOB_STATUS=$(echo "$JOB_DOC" | sed -nE 's/.*"status":"([a-z]+)".*/\1/p' | head -1)
  if [ "$JOB_STATUS" = "completed" ] || [ "$JOB_STATUS" = "failed" ]; then break; fi
  sleep 2
done
check "compile job reaches completed" test "$JOB_STATUS" = "completed"

# K-score visible in completed job doc
check "completed job has k_score" has "$JOB_DOC" '"k_score"'
check "k_score has composite" has "$JOB_DOC" '"composite"'
check "k_score has accuracy" has "$JOB_DOC" '"accuracy"'
check "k_score has size_bytes" has "$JOB_DOC" '"size_bytes"'
check "k_score has p50_latency_us" has "$JOB_DOC" '"p50_latency_us"'
check "k_score has spec=k-score-1" has "$JOB_DOC" '"spec":"k-score-1"'

# Composite > 0 only if synthesis accepted (sign classifier should accept)
KCOMP=$(echo "$JOB_DOC" | node -e 'let d="";process.stdin.on("data",c=>d+=c).on("end",()=>{try{const j=JSON.parse(d);process.stdout.write(String(j.k_score?.composite||0))}catch{process.stdout.write("0")}})' 2>/dev/null)
echo "    K-score composite: $KCOMP"

# Artifact downloadable (chunked stream — Content-Length omitted)
ART_HEAD=$(curl -sI "$URL/v1/compile/$JOBID/.kolm" -H "X-API-Key: $KEY")
check "/.kolm artifact 200" hashi "$ART_HEAD" "HTTP/[12].[12] 200\|HTTP/2 200"
check "/.kolm Content-Type zip" hashi "$ART_HEAD" "Content-Type:.*zip"

# Download the artifact and verify it's a real zip (PK signature + non-trivial size)
ART_TMP=$(mktemp)
curl -s "$URL/v1/compile/$JOBID/.kolm" -H "X-API-Key: $KEY" -o "$ART_TMP"
ART_BYTES=$(wc -c < "$ART_TMP")
echo "    artifact bytes on disk: $ART_BYTES"
check "artifact bytes > 1000" test "$ART_BYTES" -gt 1000
ART_MAGIC=$(head -c 2 "$ART_TMP" | xxd -p -c 2)
check "artifact has zip magic (PK)" test "$ART_MAGIC" = "504b"
rm -f "$ART_TMP"

# Compile listing
CL=$(curl -s "$URL/v1/compile" -H "X-API-Key: $KEY")
check "compile job list" has "$CL" '"jobs"'
check "compile job list has our job" has "$CL" "$JOBID"

# Compile surface page
CP=$(curl -s -o /dev/null -w "%{http_code}" "$URL/compile")
check "/compile page 200" test "$CP" = "200"
CP_BODY=$(curl -s "$URL/compile")
check "/compile page hero" hashi "$CP_BODY" 'compile\|.kolm'
check "/compile page has stages" hashi "$CP_BODY" 'stage\|distill\|recipe'

echo ""
echo "=== 24. Sprint 1 — kolm v5 site (compiler cache positioning) ==="
# Five new surface pages
for p in compile run recall cloud; do
  C=$(curl -s -o /dev/null -w "%{http_code}" "$URL/$p")
  check "GET /$p 200" test "$C" = "200"
done

# Homepage carries the locked positioning
HOME=$(curl -s "$URL/")
check "homepage has 'AI compiler' positioning" hashi "$HOME" "AI compiler"
check "homepage names .kolm artifact" has "$HOME" '.kolm'
check "homepage links to /compile" has "$HOME" 'href="/compile"'
check "homepage links to /run" has "$HOME" 'href="/run"'
check "homepage links to /recall" has "$HOME" 'href="/recall"'
check "homepage references K-score" hashi "$HOME" "k-score\|K-score"
check "homepage mentions MCP" hashi "$HOME" "mcp"

# /serve carries the kolm serve --mcp claim (moved off /run in v5)
SERVE_BODY=$(curl -s "$URL/serve")
check "/serve advertises kolm serve --mcp" has "$SERVE_BODY" 'kolm serve --mcp'
RUN_BODY=$(curl -s "$URL/run")
check "/run shows .kolm contents" has "$RUN_BODY" 'manifest.json'

# /cloud has the wrap pattern
CLOUD_BODY=$(curl -s "$URL/cloud")
check "/cloud shows kolm.wrap" has "$CLOUD_BODY" 'kolm.wrap'
check "/cloud has pricing tiers" has "$CLOUD_BODY" 'Pro'

# Header consistency — every page links back to Home + carries the kolm wordmark
for p in compile run recall cloud serve anatomy k-score; do
  PB=$(curl -s "$URL/$p")
  check "/$p header has Home link" has "$PB" 'href="/"'
  check "/$p has kolm wordmark" hashi "$PB" 'class="brand"\|class="sub"'
done

# v5.4 launch-prep surface — six new pages, /cookbook routing, sitemap freshness, footer cookbook column
echo ""
echo "[v5.4] launch-prep surface"

D=$(curl -s -o /dev/null -w "%{http_code}" "$URL/cookbook");            check "/cookbook is 200" eq "$D" 200
E=$(curl -s -o /dev/null -w "%{http_code}" "$URL/legal");               check "/legal is 200" eq "$E" 200
F=$(curl -s -o /dev/null -w "%{http_code}" "$URL/edge");                check "/edge is 200" eq "$F" 200

# /cookbook/<slug> aliases — same files served via cookbook namespace
for v in healthcare finance legal edge; do
  CC=$(curl -s -o /dev/null -w "%{http_code}" "$URL/cookbook/$v")
  check "/cookbook/$v alias is 200" eq "$CC" 200
done

# Pricing has Teams tier
PRICE=$(curl -s "$URL/pricing")
check "/pricing has Teams tier"      has "$PRICE" "Teams"
check "/pricing has \$149 price"     has "$PRICE" "149"

# Sitemap has new pages dated 2026-05-08
SITEMAP=$(curl -s "$URL/sitemap.xml")
check "sitemap has /cookbook"     has "$SITEMAP" "/cookbook"
check "sitemap has /legal"        has "$SITEMAP" "/legal"
check "sitemap has /edge"         has "$SITEMAP" "/edge"
check "sitemap dated 2026-05-08"  has "$SITEMAP" "2026-05-08"

# Homepage footer has 5 columns including new cookbook column
HOME=$(curl -s "$URL/")
check "homepage footer cookbook col" has "$HOME" "all recipes"

# Changelog has v5.4 entry
CHANGELOG=$(curl -s "$URL/changelog")
check "/changelog v5.4 entry" has "$CHANGELOG" "v5.4"

echo ""
echo "=== 27. v5.7 — comparators, why-now, threat model, RSS, packages ==="
for p in vs-ollama vs-rag vs-fine-tune why-now threat-model trust integrations press; do
  C=$(curl -s -o /dev/null -w "%{http_code}" "$URL/$p")
  check "GET /$p → 200" test "$C" = "200"
done

# RSS feed live + has all 5 articles
RSS=$(curl -s "$URL/articles/rss.xml")
check "RSS channel"                    has "$RSS" '<title>Kolmogorov - Articles</title>'
check "RSS ai-compiler"                has "$RSS" '/articles/ai-compiler'
check "RSS k-sample-verified-inference" has "$RSS" '/articles/k-sample-verified-inference'
check "RSS hipaa-on-device"            has "$RSS" '/articles/hipaa-on-device'
check "RSS kolm-file-format"           has "$RSS" '/articles/kolm-file-format'
check "RSS speculative-decoding-recipes" has "$RSS" '/articles/speculative-decoding-recipes'

# Comparator pages have the right shape (table + verdict)
VSO=$(curl -s "$URL/vs-ollama")
check "/vs-ollama compare table"       has "$VSO" 'kolm'
VSR=$(curl -s "$URL/vs-rag")
check "/vs-rag compare table"          has "$VSR" 'kolm'
VSF=$(curl -s "$URL/vs-fine-tune")
check "/vs-fine-tune compare table"    has "$VSF" 'kolm'

# v7.0 Workstream G new comparators
for p in vs-mem0 vs-hindsight vs-openai-fine-tune vs-together; do
  C=$(curl -s -o /dev/null -w "%{http_code}" "$URL/$p")
  check "GET /$p -> 200" test "$C" = "200"
done
VSM0=$(curl -s "$URL/vs-mem0")
check "/vs-mem0 honest concession"     has "$VSM0" 'Honest concession'
check "/vs-mem0 verdict"               has "$VSM0" 'Verdict'
VSHS=$(curl -s "$URL/vs-hindsight")
check "/vs-hindsight TEMPR mention"    has "$VSHS" 'TEMPR'
check "/vs-hindsight LongMemEval"      has "$VSHS" 'LongMemEval'
VSOFT=$(curl -s "$URL/vs-openai-fine-tune")
check "/vs-openai-fine-tune file own"  has "$VSOFT" 'You own the file'
VSTG=$(curl -s "$URL/vs-together")
check "/vs-together \\$0 marginal"      has "$VSTG" '0 marginal'

# why-now + threat-model copy
WHY=$(curl -s "$URL/why-now")
check "/why-now three forces"          has "$WHY" 'three'
TM=$(curl -s "$URL/threat-model")
check "/threat-model HMAC"             has "$TM" 'HMAC'

# Pricing has overage + graduates copy
PRC=$(curl -s "$URL/pricing")
check "/pricing overage line"          has "$PRC" 'Overage'
check "/pricing graduates section"     has "$PRC" 'graduates'

# Sitemap has new URLs
SM2=$(curl -s "$URL/sitemap.xml")
check "sitemap has /vs-ollama"         has "$SM2" '/vs-ollama'
check "sitemap has /vs-rag"            has "$SM2" '/vs-rag'
check "sitemap has /vs-fine-tune"      has "$SM2" '/vs-fine-tune'
check "sitemap has /why-now"           has "$SM2" '/why-now'
check "sitemap has /threat-model"      has "$SM2" '/threat-model'
check "sitemap has /trust"             has "$SM2" '/trust'
check "sitemap has /integrations"      has "$SM2" '/integrations'
check "sitemap has /press"             has "$SM2" '/press'
check "sitemap has rss.xml"            has "$SM2" 'articles/rss.xml'
check "sitemap has /vs-mem0"           has "$SM2" '/vs-mem0'
check "sitemap has /vs-hindsight"      has "$SM2" '/vs-hindsight'
check "sitemap has /vs-openai-fine-tune" has "$SM2" '/vs-openai-fine-tune'
check "sitemap has /vs-together"       has "$SM2" '/vs-together'

# Articles index advertises RSS
AI=$(curl -s "$URL/articles")
check "/articles advertises RSS"       has "$AI" 'application/rss+xml'

# Homepage anti-incumbent + GitHub star + ICP doors
H2=$(curl -s "$URL/")
check "homepage anti-incumbent"        has "$H2" 'Stop renting'
check "homepage GitHub star button"    has "$H2" 'gh-star-count'
check "homepage triple-pillar"         has "$H2" 'sovereignty\|verifiability\|portability'
check "homepage registry counter"      has "$H2" 'registry/public/count'
check "homepage compiler-positioning"  has "$H2" 'kolm compiles a task into a working AI you own'
check "homepage roi link"              has "$H2" '/roi'

echo ""
echo "=== 28. v5.8 — ROI calculator ==="
C=$(curl -s -o /dev/null -w "%{http_code}" "$URL/roi")
check "GET /roi → 200" test "$C" = "200"

ROI=$(curl -s "$URL/roi")
check "/roi calculator inputs"         has "$ROI" 'i-calls'
check "/roi calculator results"        has "$ROI" 'r-cloud-tot'
check "/roi presets"                   has "$ROI" 'data-preset'
check "/roi teacher math"              has "$ROI" 'teacher'

# Sitemap has roi
SM3=$(curl -s "$URL/sitemap.xml")
check "sitemap has /roi"               has "$SM3" '/roi'

echo ""
echo "=== 29. v6.5 — depth pages + self-serve enterprise ==="
for p in api how-it-works; do
  C=$(curl -s -o /dev/null -w "%{http_code}" "$URL/$p")
  check "GET /$p -> 200" test "$C" = "200"
done

API_REF=$(curl -s "$URL/api")
check "/api lists /v1/compile"         has "$API_REF" '/v1/compile'
check "/api lists /v1/account/change-plan" has "$API_REF" '/v1/account/change-plan'
check "/api lists error codes"         has "$API_REF" '402\|429'
check "/api SDK install lines"         has "$API_REF" '@kolmogorov/kolm'

HOW=$(curl -s "$URL/how-it-works")
check "/how-it-works 8 stages"         has "$HOW" 'gather\|spec\|synthesize\|k-sample'
check "/how-it-works verifier types"   has "$HOW" 'schema\|regex\|classifier'
check "/how-it-works manifest"         has "$HOW" 'manifest'

# Self-serve enterprise — no mailto in cloud, fa, integrations
CLOUD=$(curl -s "$URL/cloud")
check "/cloud Enterprise self-serve"   has "$CLOUD" '/signup?plan=enterprise'
FAQ=$(curl -s "$URL/faq")
check "/faq Enterprise self-serve"     has "$FAQ" 'self-serve'

# Plans endpoint surfaces all 5 tiers
PLANS=$(curl -s "$URL/v1/plans")
check "/v1/plans free"                 has "$PLANS" '"id":"free"'
check "/v1/plans starter"              has "$PLANS" '"id":"starter"'
check "/v1/plans pro"                  has "$PLANS" '"id":"pro"'
check "/v1/plans teams"                has "$PLANS" '"id":"teams"'
check "/v1/plans enterprise"           has "$PLANS" '"id":"enterprise"'

# Homepage three-box explainer
check "homepage three-box 01 inputs"   has "$H2" 'three-box\|inputs'
check "homepage three-box 02 compile"  has "$H2" 'kolm compiles'

echo ""
echo "=== 30. v7.0 day-1 — brand anchor + rent-vs-buy + /brand ==="
B30_HOME=$(curl -s "$URL/")
check "homepage H1 lock 'compiled to your task'" has "$B30_HOME" 'compiled to your task'
check "homepage brand-anchor 'Built by Kolmogorov'" has "$B30_HOME" 'Built by .b.Kolmogorov'
check "homepage rent-vs-buy thesis line"           has "$B30_HOME" 'local LoRA you keep forever'
check "GET /brand -> 200"                          curl -fsS "$URL/brand"
B30_BRAND=$(curl -s "$URL/brand")
check "/brand 'kolm is the binary'"                hashi "$B30_BRAND" 'kolm.*is the binary\|the binary'
check "/brand mentions Andrey Kolmogorov"          hashi "$B30_BRAND" 'andrey kolmogorov\|1965'
check "/brand mentions RS-1 spec"                  has "$B30_BRAND" 'RS-1'
B30_MAN=$(curl -s "$URL/manifesto")
check "/manifesto has brand-anchor paragraph"      hashi "$B30_MAN" 'andrey kolmogorov\|smallest specialist program'
B30_CSS=$(curl -s "$URL/brand-refresh.css")
check "brand-refresh.css has footer brand-tag"     has "$B30_CSS" 'kolm is the binary'
check "sitemap lists /brand"                       has "$(curl -s "$URL/sitemap.xml")" 'https://kolm.ai/brand'

echo ""
echo "=== 31. v7.0 day-2 — REM-era claims stripped, kolm-native framing ==="
B31_AGENT=$(curl -s "$URL/use-cases/agentic-coding")
check "agentic-coding has compiled-specialist H1"  has "$B31_AGENT" 'compiled coding specialist'
check "agentic-coding mentions tools/call"         has "$B31_AGENT" 'tools/call'
check "agentic-coding mentions tools/list"         has "$B31_AGENT" 'tools/list'
check "agentic-coding mentions MCP"                has "$B31_AGENT" 'MCP'
check "agentic-coding mentions K-score"            has "$B31_AGENT" 'K-score'
check "agentic-coding pinned to fixture latency"   has "$B31_AGENT" 'p50.*274'
check "agentic-coding NO bare +15.33pp claim"      lacks "$B31_AGENT" '\+15\.33'
check "agentic-coding NO 'memory layer' claim"     lacks "$B31_AGENT" 'memory layer your'
check "agentic-coding links to methodology"        has "$B31_AGENT" '/articles/how-we-benchmark'
B31_UC=$(curl -s "$URL/use-cases")
check "use-cases hub NO bare SWE-bench claim"      lacks "$B31_UC" '\+15\.33'
check "GET /articles/how-we-benchmark -> 200"      bash -c "[ \"\$(curl -s -o /dev/null -w '%{http_code}' '$URL/articles/how-we-benchmark')\" = '200' ]"
B31_HWB=$(curl -s "$URL/articles/how-we-benchmark")
check "how-we-benchmark cites +10.67pp"            has "$B31_HWB" '10\.67'
check "how-we-benchmark cites n=150"               has "$B31_HWB" 'n=150'
check "how-we-benchmark cites swebench 4.1.0"      has "$B31_HWB" 'swebench 4\.1\.0'
check "how-we-benchmark cites seed=42"             has "$B31_HWB" 'seed.*42'
check "how-we-benchmark has reproducer command"    has "$B31_HWB" 'kolm.*bench.*reproduce.*swebench-lite-n150'
check "how-we-benchmark has diagnosis section"     has "$B31_HWB" 'disagrees with ours'
check "how-we-benchmark has not-claimed section"   has "$B31_HWB" 'do not claim'
B31_SITEMAP=$(curl -s "$URL/sitemap.xml")
check "sitemap HAS how-we-benchmark"               has "$B31_SITEMAP" 'how-we-benchmark'
B31_ARTICLES=$(curl -s "$URL/articles")
check "articles index HAS how-we-benchmark"        has "$B31_ARTICLES" 'how-we-benchmark'
B31_BENCH=$(curl -s "$URL/benchmarks")
check "benchmarks page kolm-benchmark-1 intact"    has "$B31_BENCH" 'kolm-benchmark-1'
check "benchmarks page disowns SWE-bench leaderboard" has "$B31_BENCH" 'does not appear on the SWE-bench'
check "/benchmarks links to methodology"           has "$B31_BENCH" '/articles/how-we-benchmark'

echo ""
echo "=== 32. v7.0 — /build-your-own + spec-driven authoring + 4 fixtures ==="
B32_BYO=$(curl -s "$URL/build-your-own")
check "/build-your-own resolves 200"               bash -c "[ \"\$(curl -s -o /dev/null -w '%{http_code}' '$URL/build-your-own')\" = '200' ]"
check "/build-your-own H1 yours-local-signed"      has "$B32_BYO" 'Yours, local, signed'
check "/build-your-own kolm new --from"            has "$B32_BYO" 'kolm new'
check "/build-your-own kolm compile --spec"        has "$B32_BYO" 'kolm compile --spec'
check "/build-your-own template: redactor"         has "$B32_BYO" '--from redactor'
check "/build-your-own template: extractor"        has "$B32_BYO" '--from extractor'
check "/build-your-own template: classifier"       has "$B32_BYO" '--from classifier'
check "/build-your-own template: blank"            has "$B32_BYO" '--from blank'
check "/build-your-own AI-friendly section"        has "$B32_BYO" 'AI-friendly authoring'
check "/build-your-own honest sensitive caveat"    has "$B32_BYO" 'is not SOC 2 / HIPAA-attested\|compliance attestation'
check "/build-your-own rent-vs-buy section"        has "$B32_BYO" 'buy instead of rent\|capture frontier API\|distill the cluster'
check "/build-your-own links AUTHORING.md"         has "$B32_BYO" 'docs/AUTHORING.md'
check "/build-your-own links cookbook"             has "$B32_BYO" 'href="/cookbook"'
check "sitemap lists /build-your-own"              has "$(curl -s "$URL/sitemap.xml")" 'https://kolm.ai/build-your-own'
B32_HOME=$(curl -s "$URL/")
check "homepage CTA links /build-your-own"         has "$B32_HOME" 'href="/build-your-own"'
B32_QS=$(curl -s "$URL/quickstart")
check "quickstart CTA links /build-your-own"       has "$B32_QS" 'href="/build-your-own"'
B32_COOK=$(curl -s "$URL/cookbook")
check "cookbook CTA links /build-your-own"         has "$B32_COOK" 'href="/build-your-own"'
B32_DOCS=$(curl -s "$URL/docs")
check "docs CTA links /build-your-own"             has "$B32_DOCS" 'href="/build-your-own"'
check "benchmarks page lists 4 fixtures"           has "$B31_BENCH" 'redactor.kolm'
check "benchmarks page lists extractor"            has "$B31_BENCH" 'extractor.kolm'
check "benchmarks page lists classifier"           has "$B31_BENCH" 'classifier.kolm'

echo ""
echo "=== 33. v7.0 — Stripe billing gate ==="
# Paid signup: tenant must be provisioned on FREE quota with pending_plan set,
# never on the paid quota directly. This is the "no-paid-without-paying" gate.
B33_SIG=$(curl -sX POST "$URL/v1/signup" -H 'Content-Type: application/json' \
  -d "{\"email\":\"stripegate$(date +%s)@smoke.test\",\"plan\":\"pro\"}")
check "paid signup quota = free (10000)"          has "$B33_SIG" '"quota":10000'
check "paid signup pending_plan = pro"            has "$B33_SIG" '"pending_plan":"pro"'
check "paid signup billing_required = true"       has "$B33_SIG" '"billing_required":true'
check "paid signup plan = free at provision"      has "$B33_SIG" '"plan":"free"'
B33_KEY=$(echo "$B33_SIG" | grep -oE 'ks_[a-z0-9]+' | head -1)

# change-plan to free (downgrade) flips immediately.
B33_DOWN=$(curl -sX POST "$URL/v1/account/change-plan" -H "Content-Type: application/json" \
  -H "X-API-Key: $B33_KEY" -d '{"plan":"free"}')
check "change-plan to free returns ok=true"       has "$B33_DOWN" '"ok":true'
check "change-plan to free returns plan=free"     has "$B33_DOWN" '"plan":"free"'
check "change-plan to free no billing"            has "$B33_DOWN" '"billing_required":false'

# change-plan to a paid tier that has no Stripe link returns 503 (this is the
# expected state on a fresh deploy where STRIPE_PAYMENT_LINK_* are unset).
# In CI we accept either 503 (no link) or 200 with billing_url (link configured).
B33_UP=$(curl -sX POST "$URL/v1/account/change-plan" -H "Content-Type: application/json" \
  -H "X-API-Key: $B33_KEY" -d '{"plan":"pro"}')
check "change-plan to pro never auto-flips"       lacks "$B33_UP" '"plan":"pro"'

# Webhook endpoint exists (returns 503 if secret unset, 400 if signed wrong).
B33_WH=$(curl -s -o /dev/null -w '%{http_code}' -X POST "$URL/v1/stripe/webhook" \
  -H 'Content-Type: application/json' -d '{"id":"evt_smoke","type":"test"}')
check "webhook reachable (503 or 400)"            bash -c "[ '$B33_WH' = '503' ] || [ '$B33_WH' = '400' ]"

echo ""
echo "================================================"
echo " RESULTS: $PASS pass, $FAIL fail"
if [ $FAIL -gt 0 ]; then
  echo " Failed:"
  for f in "${FAILED[@]}"; do echo "   - $f"; done
fi
echo "================================================"
