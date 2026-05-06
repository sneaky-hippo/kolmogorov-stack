#!/usr/bin/env bash
# Full live smoke battery for Railway deploy.
URL="${URL:-https://kolmogorov-stack-production.up.railway.app}"
PASS=0; FAIL=0; FAILED=()

check() {
  local name="$1"; shift
  if "$@" >/dev/null 2>&1; then echo "  PASS  $name"; PASS=$((PASS+1));
  else echo "  FAIL  $name"; FAIL=$((FAIL+1)); FAILED+=("$name"); fi
}

has() { local body="$1"; local needle="$2"; echo "$body" | grep -q "$needle"; }
hashi() { local body="$1"; local needle="$2"; echo "$body" | grep -qi "$needle"; }

echo "=== 1. Public + auto-mint ==="
H_HEALTH=$(curl -s "$URL/health")
check "/health version=0.2.0" has "$H_HEALTH" '"version":"0.2.0"'
check "/health stats present" has "$H_HEALTH" '"stats"'

PRICING=$(curl -s "$URL/pricing")
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
for p in "" dashboard playground docs registry signup why pricing status specialists; do
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
check "anon/bootstrap nudges to claim" has "$ANON_BOOT" 'recipe claim'
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
ON=$(curl -s -o /dev/null -w "%{http_code}" "$URL/onboarding")
check "/onboarding 200" test "$ON" = "200"
AC=$(curl -s -o /dev/null -w "%{http_code}" "$URL/account")
check "/account 200" test "$AC" = "200"
SP=$(curl -s -o /dev/null -w "%{http_code}" "$URL/specialists")
check "/specialists 200" test "$SP" = "200"
WHY=$(curl -s "$URL/why")
check "/why has ROI calculator" has "$WHY" 'roi-calls'
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

# Tamper test: flip the first hex char of the hmac
TAMPERED=$(echo "$RECEIPT_JSON" | node -e 'let d="";process.stdin.on("data",c=>d+=c).on("end",()=>{const r=JSON.parse(d);r.hmac="0"+r.hmac.slice(1);process.stdout.write(JSON.stringify(r))})' 2>/dev/null)
VERIFY_BAD=$(curl -sX POST "$URL/v1/receipts/verify" -H 'Content-Type: application/json' \
  -d "{\"receipt\":$TAMPERED}")
check "tampered receipt rejected" has "$VERIFY_BAD" '"valid":false'

# New surface pages
SPEC_HTML=$(curl -s -o /dev/null -w "%{http_code}" "$URL/spec")
check "/spec page 200" test "$SPEC_HTML" = "200"
RCPTS_HTML=$(curl -s -o /dev/null -w "%{http_code}" "$URL/receipts")
check "/receipts page 200" test "$RCPTS_HTML" = "200"

echo ""
echo "=== 19. Verified Inference + infra-thesis pages ==="
HIW=$(curl -s -o /dev/null -w "%{http_code}" "$URL/how-it-works")
check "/how-it-works page 200" test "$HIW" = "200"
VER=$(curl -s -o /dev/null -w "%{http_code}" "$URL/verified")
check "/verified page 200" test "$VER" = "200"
ECO=$(curl -s -o /dev/null -w "%{http_code}" "$URL/economics")
check "/economics page 200" test "$ECO" = "200"
HIW_BODY=$(curl -s "$URL/how-it-works")
check "/how-it-works has wrap pattern" has "$HIW_BODY" 'recipe.wrap'
VER_BODY=$(curl -s "$URL/verified")
check "/verified has the math formula" has "$VER_BODY" 'Generator-Verifier'
check "/verified has live demo button" has "$VER_BODY" 'btn-run'
ECO_BODY=$(curl -s "$URL/economics")
check "/economics has hardware unlock" has "$ECO_BODY" 'ESP32'
check "/economics references CDN analogue" has "$ECO_BODY" 'CDN'
HOME_BODY=$(curl -s "$URL/")
check "home has hardware-unlock thesis" has "$HOME_BODY" 'every device that has ever existed'
check "home links to /verified" has "$HOME_BODY" 'href="/verified"'
check "home links to /economics" has "$HOME_BODY" 'href="/economics"'

# /v1/verified-inference contract
VI_NO_TC=$(curl -sX POST "$URL/v1/verified-inference" -H 'Content-Type: application/json' -d '{}')
check "/v1/verified-inference rejects empty body" has "$VI_NO_TC" 'test_cases array required'
VI_K_CAP=$(curl -sX POST "$URL/v1/verified-inference" -H 'Content-Type: application/json' \
  -d '{"prompt":"x","test_cases":[{"input":1,"expected":1}],"k":99}')
check "/v1/verified-inference caps k at 64" has "$VI_K_CAP" 'k capped at 64'
VI_NO_KEY=$(curl -sX POST "$URL/v1/verified-inference" -H 'Content-Type: application/json' \
  -d '{"prompt":"x","test_cases":[{"input":1,"expected":1}],"k":2}')
# Either 503 (no key locally) or 200 with verified=true/false (key present): both are acceptable contracts
VI_OK=0
echo "$VI_NO_KEY" | grep -q 'requires ANTHROPIC_API_KEY' && VI_OK=1
echo "$VI_NO_KEY" | grep -q '"verified"' && VI_OK=1
check "/v1/verified-inference responds correctly given key state" test "$VI_OK" = "1"

echo ""
echo "================================================"
echo " RESULTS: $PASS pass, $FAIL fail"
if [ $FAIL -gt 0 ]; then
  echo " Failed:"
  for f in "${FAILED[@]}"; do echo "   - $f"; done
fi
echo "================================================"
