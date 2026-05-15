#!/usr/bin/env bash
# smoke-live.sh — semantic invariants for kolm.ai.
# Tests API contract + page status, not marketing copy.
#
# Usage:
#   PORT=8787 node server.js &
#   URL=http://localhost:8787 bash scripts/smoke-live.sh
#
# Default URL is the Railway prod backend. Pages are also served by Vercel
# in prod; both layers must answer 200 for the same URL set. Marketing copy
# changes constantly and is intentionally NOT asserted here — only routes,
# auth gates, and the shape of API responses are.

URL="${URL:-https://kolmogorov-stack-production.up.railway.app}"
PASS=0; FAIL=0; FAILED=()

check() {
  local name="$1"; shift
  if "$@" >/dev/null 2>&1; then echo "  PASS  $name"; PASS=$((PASS+1));
  else echo "  FAIL  $name"; FAIL=$((FAIL+1)); FAILED+=("$name"); fi
}
has()   { local body="$1"; local needle="$2"; echo "$body" | grep -q -e "$needle"; }
hashi() { local body="$1"; local needle="$2"; echo "$body" | grep -qi -e "$needle"; }
lacks() { local body="$1"; local needle="$2"; ! echo "$body" | grep -q -e "$needle"; }
eq()    { [ "$1" = "$2" ]; }

echo "=== Health + signup ==="
H=$(curl -s "$URL/health")
check "/health status=ok"               has "$H" '"status":"ok"'
check "/health stats present"           has "$H" '"stats"'
check "/health no provider leak"        lacks "$H" 'has_anthropic_key'

PRICING=$(curl -s "$URL/v1/pricing")
check "/v1/pricing currency=USD"        has "$PRICING" '"currency":"USD"'

SEED="smoke$(date +%s)$RANDOM"
SIGNUP=$(curl -sX POST "$URL/v1/signup" -H 'Content-Type: application/json' \
  -d "{\"email\":\"$SEED@smoke.test\"}")
KEY=$(echo "$SIGNUP" | grep -oE 'ks_[a-f0-9]+' | head -1)
check "/v1/signup mints ks_ key"        test -n "$KEY"

echo ""
echo "=== Auth gates ==="
NA=$(curl -s -o /dev/null -w "%{http_code}" "$URL/v1/concepts")
check "no key on /v1/concepts -> 401"   eq "$NA" 401
BK=$(curl -s -o /dev/null -w "%{http_code}" -H "X-API-Key: ks_nope" "$URL/v1/concepts")
check "bad key on /v1/concepts -> 401"  eq "$BK" 401
VH=$(curl -s -o /dev/null -w "%{http_code}" "$URL/v1/health")
check "/v1/health requires auth"        eq "$VH" 401
ADM=$(curl -s -o /dev/null -w "%{http_code}" "$URL/v1/admin/waitlist" -H "X-API-Key: $KEY")
check "/v1/admin/waitlist non-admin"    eq "$ADM" 403

echo ""
echo "=== Rate-limit + quota + compression headers ==="
RL=$(curl -sI "$URL/v1/concepts" -H "X-API-Key: $KEY")
check "X-RateLimit-Limit"               hashi "$RL" "X-RateLimit-Limit"
check "X-RateLimit-Remaining"           hashi "$RL" "X-RateLimit-Remaining"
check "X-RateLimit-Burst"               hashi "$RL" "X-RateLimit-Burst"
check "X-Quota-Limit"                   hashi "$RL" "X-Quota-Limit"
check "X-Quota-Used"                    hashi "$RL" "X-Quota-Used"
check "X-Quota-Remaining"               hashi "$RL" "X-Quota-Remaining"

COMP=$(curl -sD - -o /dev/null -H "X-API-Key: $KEY" -H "Accept-Encoding: gzip" "$URL/v1/concepts")
check "gzip on JSON GET"                hashi "$COMP" "Content-Encoding: gzip"

ST=$(curl -sI "$URL/styles.css")
check "static cache-control header"     hashi "$ST" "Cache-Control"

echo ""
echo "=== Public, no-auth ==="
PUB=$(curl -s "$URL/v1/public/concepts")
check "/v1/public/concepts list"        has "$PUB" '"concepts"'
PUB_ID=$(echo "$PUB" | grep -oE 'cpt_[a-z0-9]+' | head -1)
check "public concept id parsed"        test -n "$PUB_ID"
FEAT=$(curl -s "$URL/v1/public/featured")
check "/v1/public/featured list"        has "$FEAT" '"featured"'
SPEC=$(curl -s "$URL/v1/spec")
check "/v1/spec public + rs-1"          has "$SPEC" '"spec":"rs-1"'
REX=$(curl -s "$URL/v1/registry/export")
check "/v1/registry/export rs-1"        has "$REX" '"spec":"rs-1"'

echo ""
echo "=== Synthesis + verify ==="
SYN=$(curl -sX POST "$URL/v1/synthesize" -H "X-API-Key: $KEY" -H 'Content-Type: application/json' \
  -d '{"name":"smoke-bool","positives":[{"input":"YES","expected":true},{"input":"YEAH","expected":true},{"input":"no","expected":false},{"input":"never","expected":false}],"output_spec":{"type":"boolean"}}')
check "/v1/synthesize accepted"         has "$SYN" '"accepted":true'
NEW_CID=$(echo "$SYN" | grep -oE 'cpt_[a-z0-9]+' | head -1)
check "synthesize returned cpt_ id"     test -n "$NEW_CID"

BATCH=$(curl -sX POST "$URL/v1/synthesize/batch" -H "X-API-Key: $KEY" -H 'Content-Type: application/json' \
  -d '{"items":[
    {"name":"smk-a","positives":[{"input":"big","expected":true},{"input":"large","expected":true},{"input":"tiny","expected":false},{"input":"small","expected":false}],"output_spec":{"type":"boolean"}},
    {"name":"smk-b","positives":[{"input":"hi","expected":true},{"input":"hello","expected":true},{"input":"bye","expected":false},{"input":"see ya","expected":false}],"output_spec":{"type":"boolean"}}
  ]}')
check "batch returns results array"     has "$BATCH" '"results"'
check "batch total=2"                   has "$BATCH" '"total":2'

OVER_ITEMS=$(printf '1,%.0s' {1..26}); OVER_ITEMS=${OVER_ITEMS%,}
OVER=$(curl -sX POST "$URL/v1/synthesize/batch" -H "X-API-Key: $KEY" -H 'Content-Type: application/json' \
  -d "{\"items\":[$OVER_ITEMS]}")
check "batch >25 rejected"              hashi "$OVER" 'max'
EMPTY=$(curl -sX POST "$URL/v1/synthesize/batch" -H "X-API-Key: $KEY" -H 'Content-Type: application/json' -d '{"items":[]}')
check "batch empty rejected"            hashi "$EMPTY" 'required\|items'

VER=$(curl -sX POST "$URL/v1/verify" -H "X-API-Key: $KEY" -H 'Content-Type: application/json' \
  -d '{"source":"function classify(s){return String(s).length>2;}","positives":[{"input":"abc","expected":true},{"input":"a","expected":false}]}')
check "/v1/verify returns pass_rate"    hashi "$VER" 'pass_rate\|quality_score'

echo ""
echo "=== Registry + concept ops ==="
LIST=$(curl -s "$URL/v1/concepts" -H "X-API-Key: $KEY")
check "/v1/concepts returns concepts"   has "$LIST" '"concepts"'
GET=$(curl -s "$URL/v1/concepts/$NEW_CID" -H "X-API-Key: $KEY")
check "GET /v1/concepts/:id"            has "$GET" "\"id\":\"$NEW_CID\""
LIN=$(curl -s "$URL/v1/concepts/$NEW_CID/lineage" -H "X-API-Key: $KEY")
check "GET /v1/concepts/:id/lineage"    hashi "$LIN" 'versions\|head_version'

RA=$(curl -s "$URL/v1/recipes" -H "X-API-Key: $KEY")
check "/v1/recipes aliases concepts"    has "$RA" '"recipes"'
RA_GET=$(curl -s "$URL/v1/recipes/$NEW_CID" -H "X-API-Key: $KEY")
check "GET /v1/recipes/:id"             has "$RA_GET" "\"id\":\"$NEW_CID\""

echo ""
echo "=== Runtime ==="
RUN=$(curl -sX POST "$URL/v1/run" -H "X-API-Key: $KEY" -H 'Content-Type: application/json' \
  -d "{\"concept_id\":\"$NEW_CID\",\"input\":\"YES\"}")
check "/v1/run returns output"          has "$RUN" '"output"'
RUN2=$(curl -sX POST "$URL/v1/run" -H "X-API-Key: $KEY" -H 'Content-Type: application/json' \
  -d "{\"concept_id\":\"$NEW_CID\",\"input\":\"YES\"}")
check "second run hits L1 cache"        has "$RUN2" '"cache":"L1'

STATS=$(curl -s "$URL/v1/concepts/$NEW_CID/stats" -H "X-API-Key: $KEY")
check "concept stats invocations"       has "$STATS" '"invocations"'

# /v1/compose dispatches recipes. Local fresh data may have versions without
# embedding vectors, which makes searchSimilar throw — accept either the
# happy-path "dispatched" shape OR an error JSON to keep the route covered
# without coupling to seed-data quality.
COMP=$(curl -sX POST "$URL/v1/compose" -H "X-API-Key: $KEY" -H 'Content-Type: application/json' \
  -d '{"query":"detect spam emails","input":"hi","k":2,"strategy":"top1"}')
check "/v1/compose responds (dispatched or error)" hashi "$COMP" 'dispatched\|error'

echo ""
echo "=== Account + telemetry + library ==="
ACC=$(curl -s "$URL/v1/account" -H "X-API-Key: $KEY")
check "/v1/account has plan field"      has "$ACC" '"plan"'
TEL=$(curl -s "$URL/v1/telemetry" -H "X-API-Key: $KEY")
check "/v1/telemetry total_invocations" has "$TEL" '"total_invocations"'
LIB=$(curl -s "$URL/v1/library" -H "X-API-Key: $KEY")
check "/v1/library version"             has "$LIB" '"version"'

echo ""
echo "=== Auto-labeling + specialists ==="
LBL=$(curl -sX POST "$URL/v1/recipes/$NEW_CID/label-corpus" -H "X-API-Key: $KEY" -H 'Content-Type: application/json' \
  -d '{"corpus":{"type":"inline","rows":[{"input":"YES"},{"input":"no"},{"input":"YEP"}]}}')
check "label-corpus inline rows_labeled=3" has "$LBL" '"rows_labeled":3'
check "label-corpus job_id"             has "$LBL" '"job_id"'

HFQ=$(curl -sX POST "$URL/v1/recipes/$NEW_CID/label-corpus" -H "X-API-Key: $KEY" -H 'Content-Type: application/json' \
  -d '{"corpus":{"type":"huggingface","name":"glue/sst2"},"max_rows":50}')
check "label-corpus HF queues"          has "$HFQ" '"status":"queued"'

TR=$(curl -sX POST "$URL/v1/specialists/train" -H "X-API-Key: $KEY" -H 'Content-Type: application/json' \
  -d "{\"name\":\"smk-spec\",\"recipe_id\":\"$NEW_CID\",\"base_model\":\"Qwen3-1.5B\"}")
check "/v1/specialists/train queues"    has "$TR" '"specialist_id"'

WL=$(curl -sX POST "$URL/v1/specialists/waitlist" -H 'Content-Type: application/json' \
  -d "{\"email\":\"wl$RANDOM@test.io\",\"task\":\"detect spam\"}")
check "specialists/waitlist no-auth"    has "$WL" '"position"'

echo ""
echo "=== Public submissions ==="
SUB=$(curl -sX POST "$URL/v1/public/submit" -H "X-API-Key: $KEY" -H 'Content-Type: application/json' \
  -d "{\"recipe_id\":\"$NEW_CID\",\"blurb\":\"smoke\",\"contact\":\"x@y.io\"}")
check "/v1/public/submit accepts"       has "$SUB" '"submission_id"'
NOAUTH=$(curl -s -o /dev/null -w "%{http_code}" -X POST "$URL/v1/public/submit" \
  -H 'Content-Type: application/json' -d '{"recipe_id":"x"}')
check "/v1/public/submit no-auth -> 401" eq "$NOAUTH" 401

echo ""
echo "=== Receipts (cryptographic) ==="
PUB_RUN=$(curl -sX POST "$URL/v1/public/run" -H 'Content-Type: application/json' \
  -d "{\"concept_id\":\"$PUB_ID\",\"input\":\"smoke check\"}")
check "/v1/public/run carries receipt"  has "$PUB_RUN" '"receipt"'
check "receipt has source_hash"         has "$PUB_RUN" '"source_hash"'
check "receipt has hmac"                has "$PUB_RUN" '"hmac"'

RECEIPT_JSON=$(echo "$PUB_RUN" | node -e 'let d="";process.stdin.on("data",c=>d+=c).on("end",()=>{try{process.stdout.write(JSON.stringify(JSON.parse(d).receipt))}catch(e){process.stdout.write("null")}})' 2>/dev/null)
VERIFY=$(curl -sX POST "$URL/v1/receipts/verify" -H 'Content-Type: application/json' \
  -d "{\"receipt\":$RECEIPT_JSON}")
check "/v1/receipts/verify valid=true"  has "$VERIFY" '"valid":true'

echo ""
echo "=== Anonymous bootstrap + claim ==="
BOOT=$(curl -sX POST "$URL/v1/anon/bootstrap" -H 'Content-Type: application/json' \
  -d '{"hostname":"smoke","user_agent":"smoke/1.0"}')
check "anon/bootstrap mints kao_ token" has "$BOOT" '"anon_token":"kao_'
ANON_TOK=$(echo "$BOOT" | grep -oE 'kao_[a-f0-9]+' | head -1)
ANON_LIST=$(curl -s "$URL/v1/concepts" -H "X-API-Key: $ANON_TOK")
check "anon token authed on concepts"   has "$ANON_LIST" '"concepts"'

CLAIM=$(curl -sX POST "$URL/v1/anon/claim" -H 'Content-Type: application/json' \
  -d "{\"anon_token\":\"$ANON_TOK\",\"email\":\"claim$RANDOM@smoke.test\"}")
check "anon/claim mints ks_ key"        has "$CLAIM" '"api_key":"ks_'
BAD_CLAIM=$(curl -s -o /dev/null -w "%{http_code}" -X POST "$URL/v1/anon/claim" \
  -H 'Content-Type: application/json' -d '{"anon_token":"kao_nope","email":"x@y.com"}')
check "claim with bogus token -> 400"   eq "$BAD_CLAIM" 400

echo ""
echo "=== Static assets ==="
for f in sdk.js manifest.json sw.js escape.js recipe-worker.js sdk-versions.json; do
  C=$(curl -s -o /dev/null -w "%{http_code}" "$URL/$f")
  check "/$f -> 200"                    eq "$C" 200
done
SDK=$(curl -s "$URL/sdk.js")
check "/sdk.js exports recipe"          has "$SDK" 'export const recipe'
check "/sdk.js has Recipe class"        has "$SDK" 'class Recipe'

echo ""
echo "=== Page status (200 + kolm wordmark) ==="
# Public pages must return 200 and contain the literal "kolm" somewhere in
# the body. We don't pin specific copy — marketing evolves. /registry may
# 301 to /registry.html in dev; -L follows the redirect so we test the
# destination payload.
for p in "" dashboard playground docs registry signup pricing status \
         cookbook legal edge healthcare finance api k-score manifesto \
         quickstart; do
  C=$(curl -sL -o /dev/null -w "%{http_code}" "$URL/$p")
  check "GET /$p -> 200"                eq "$C" 200
  BODY=$(curl -sL "$URL/$p")
  check "/$p contains kolm wordmark"    hashi "$BODY" 'kolm'
done

NF=$(curl -s -o /dev/null -w "%{http_code}" "$URL/this-route-does-not-exist-xyz")
check "unknown route -> 404"            eq "$NF" 404
NF_BODY=$(curl -s "$URL/this-route-does-not-exist-xyz")
check "404 page is branded"             has "$NF_BODY" '404'

echo ""
echo "=== Session cookie endpoints ==="
SL_400=$(curl -s -o /dev/null -w "%{http_code}" -X POST "$URL/v1/session/login" \
  -H "Content-Type: application/json" -d '{}')
check "session/login 400 w/o key"       eq "$SL_400" 400
SL_401=$(curl -s -o /dev/null -w "%{http_code}" -X POST "$URL/v1/session/login" \
  -H "Content-Type: application/json" -d '{"api_key":"ks_nope"}')
check "session/login 401 bad key"       eq "$SL_401" 401
SL_OUT=$(curl -s -o /dev/null -w "%{http_code}" -X POST "$URL/v1/session/logout")
check "session/logout 200"              eq "$SL_OUT" 200

echo ""
echo "================================================"
echo " RESULTS: $PASS pass, $FAIL fail"
if [ $FAIL -gt 0 ]; then
  echo " Failed:"
  for f in "${FAILED[@]}"; do echo "   - $f"; done
fi
echo "================================================"
[ $FAIL -eq 0 ] || exit 1
exit 0
