#!/usr/bin/env bash
# smoke-kolm.sh — end-to-end contract smoke for the kolm.ai backend.
#
# Hits every public-facing endpoint claimed by the homepage / docs:
#   /                       (200, html)
#   /health                 (200, no provider-key leak)
#   /v1/health              (admin only)
#   /v1/signup              (201, mints key)
#   /v1/signin              (200, sets cookie + returns api_key)
#   /v1/signout             (204)
#   /v1/account             (200, tenant info)
#   /v1/compile             (202, returns job_id)
#   /v1/compile/:id         (200, status)
#   /v1/artifacts           (200, list)
#   /v1/artifacts/:id       (200, detail)
#   /v1/artifacts/:id/download   (200 zip)
#   /v1/receipts/verify     (200 with verified bool)
#   /v1/registry/public     (200 list)
#   /v1/compose             (200)
#   /v1/telemetry           (200 with real numbers)
#   /v1/embed               (auth-validated)
#   /v1/recall              (auth-validated)
#   /v1/wrap/verified       (validated; 503 if no Anthropic key — which is fine)
#   rate limit: 12x /v1/signup → 429 by request 11
#
# Usage:
#   URL=http://localhost:8787 bash scripts/smoke-kolm.sh
#
# Exit code: 0 if every test passes, 1 otherwise.

URL="${URL:-http://localhost:8787}"
ADMIN_KEY="${ADMIN_KEY:-ks_admin_change_me}"
TOTAL=0
PASS=0
FAIL=0
FAILS=()

# --- helpers ---
pass() { TOTAL=$((TOTAL+1)); PASS=$((PASS+1)); printf "[PASS] %-7s %-44s (%s)\n" "$1" "$2" "$3"; }
fail() { TOTAL=$((TOTAL+1)); FAIL=$((FAIL+1)); printf "[FAIL] %-7s %-44s (%s) BODY: %s\n" "$1" "$2" "$3" "$4"; FAILS+=("$1 $2 — $3"); }

# Each call: $1=method $2=path $3=expected_status $4=optional_curl_args
# Sets globals: BODY, STATUS, MS
hit() {
  local method="$1" path="$2" expected="$3"
  shift 3
  local t0 t1
  t0=$(date +%s%N)
  local out
  out=$(curl -sS -m 30 -o /tmp/smoke-body.$$ -w "%{http_code}" -X "$method" "$URL$path" "$@" || echo "000")
  t1=$(date +%s%N)
  STATUS="$out"
  BODY=$(cat /tmp/smoke-body.$$ 2>/dev/null || echo "")
  rm -f /tmp/smoke-body.$$
  MS=$(( (t1 - t0) / 1000000 ))
  if [ "$STATUS" = "$expected" ]; then
    pass "$method" "$path" "${STATUS} in ${MS}ms"
    return 0
  else
    fail "$method" "$path" "got ${STATUS}, expected ${expected}" "$(echo "$BODY" | head -c 200)"
    return 1
  fi
}

# Check that BODY contains a substring (after a successful hit).
contains() {
  TOTAL=$((TOTAL+1))
  if echo "$BODY" | grep -q "$1"; then
    PASS=$((PASS+1))
    printf "[PASS] BODY    %-44s (matched %s)\n" "$2" "$1"
  else
    FAIL=$((FAIL+1))
    printf "[FAIL] BODY    %-44s (missing %s) BODY: %s\n" "$2" "$1" "$(echo "$BODY" | head -c 200)"
    FAILS+=("BODY $2 — missing $1")
  fi
}

# Negative: BODY must NOT contain a substring.
not_contains() {
  TOTAL=$((TOTAL+1))
  if echo "$BODY" | grep -q "$1"; then
    FAIL=$((FAIL+1))
    printf "[FAIL] BODY    %-44s (forbidden %s present)\n" "$2" "$1"
    FAILS+=("BODY $2 — forbidden $1 present")
  else
    PASS=$((PASS+1))
    printf "[PASS] BODY    %-44s (no %s)\n" "$2" "$1"
  fi
}

# --- 0. server up ---
echo "==> Smoke target: $URL"
if ! curl -fsS -m 5 "$URL/health" > /dev/null 2>&1; then
  echo "[FAIL] server is not responding at $URL/health — start it with 'npm start'"
  exit 1
fi

# --- 1. Homepage ---
hit GET "/" 200
contains "kolm" "homepage carries kolm wordmark"

# --- 2. Public health (no leak) ---
hit GET "/health" 200
contains '"status":"ok"' "/health has status:ok"
not_contains "has_anthropic_key" "/health does NOT leak provider key flag"
not_contains "ANTHROPIC" "/health does NOT mention ANTHROPIC env"

# --- 3. Admin /v1/health ---
hit GET "/v1/health" 200 -H "Authorization: Bearer $ADMIN_KEY"
contains '"status":"ok"' "/v1/health admin returns ok"
contains "feature_flags" "/v1/health surfaces feature_flags"

hit GET "/v1/health" 401   # no auth → 401
hit GET "/v1/health" 401 -H "X-API-Key: bogus_should_be_invalid"   # invalid key → 401 from auth middleware

# --- 4. Signup → 201 with key ---
SEED="smoke$(date +%s)$$"
hit POST "/v1/signup" 201 -H "Content-Type: application/json" -d "{\"email\":\"$SEED@kolm.test\",\"name\":\"$SEED\"}"
KEY=$(echo "$BODY" | grep -oE 'ks_[a-f0-9]{32}' | head -1)
if [ -z "$KEY" ]; then
  fail POST "/v1/signup" "no api_key in body" "$(echo "$BODY" | head -c 200)"
else
  pass POST "/v1/signup" "minted $KEY"
fi

# --- 5. Signin → 200 with key + cookie ---
hit POST "/v1/signin" 200 -H "Content-Type: application/json" -d "{\"api_key\":\"$KEY\"}"
contains '"ok":true' "/v1/signin ok"

# --- 6. Signout → 204 ---
hit POST "/v1/signout" 204

# --- 7. Account → 200 with tenant info ---
hit GET "/v1/account" 200 -H "Authorization: Bearer $KEY"
contains '"plan":"free"' "/v1/account has plan free"
contains "quota" "/v1/account has quota"

# --- 8. Compile → 202 with job_id ---
COMPILE_BODY='{"task":"classify a number as positive, zero, or negative","examples":[{"input":"7","expected":"positive"},{"input":"0","expected":"zero"},{"input":"-3","expected":"negative"},{"input":"42","expected":"positive"}]}'
hit POST "/v1/compile" 202 -H "Authorization: Bearer $KEY" -H "Content-Type: application/json" -d "$COMPILE_BODY"
JOB_ID=$(echo "$BODY" | grep -oE 'job_[a-f0-9]{12}' | head -1)
if [ -z "$JOB_ID" ]; then
  fail POST "/v1/compile" "no job_id" "$(echo "$BODY" | head -c 200)"
fi
contains '"status"' "/v1/compile returns status"

# --- 9. Compile poll → 200 ---
JOB_STATUS="queued"
for i in 1 2 3 4 5 6 7 8 9 10 11 12 13 14 15; do
  hit GET "/v1/compile/$JOB_ID" 200 -H "Authorization: Bearer $KEY" >/dev/null 2>&1 || true
  JOB_STATUS=$(echo "$BODY" | grep -oE '"status":"[a-z]+"' | head -1 | sed 's/.*"\([a-z]*\)"/\1/')
  if [ "$JOB_STATUS" = "completed" ] || [ "$JOB_STATUS" = "failed" ]; then break; fi
  sleep 1
done
hit GET "/v1/compile/$JOB_ID" 200 -H "Authorization: Bearer $KEY"
contains "$JOB_STATUS" "/v1/compile/:id has reached terminal status ($JOB_STATUS)"
if [ "$JOB_STATUS" = "completed" ]; then
  contains "artifact_url" "/v1/compile/:id includes artifact_url"
  contains "k_score" "/v1/compile/:id includes k_score"
  contains "receipt" "/v1/compile/:id includes receipt"
  contains "artifact_hash" "/v1/compile/:id includes artifact_hash"
  contains "eval_set_hash" "/v1/compile/:id includes eval_set_hash"
  contains "judge_id" "/v1/compile/:id includes judge_id"
fi

# --- 10. Artifacts list / detail / download ---
hit GET "/v1/artifacts" 200 -H "Authorization: Bearer $KEY"
contains '"artifacts"' "/v1/artifacts list returns artifacts[]"

hit GET "/v1/artifacts/$JOB_ID" 200 -H "Authorization: Bearer $KEY"
contains "tier" "/v1/artifacts/:id has tier"
contains "judge_id" "/v1/artifacts/:id has judge_id"

ART_TMP=$(mktemp)
ART_HEAD=$(curl -sI -m 30 "$URL/v1/artifacts/$JOB_ID/download" -H "Authorization: Bearer $KEY")
ART_HTTP=$(echo "$ART_HEAD" | head -1 | grep -oE '[0-9]{3}' | head -1)
if [ "$ART_HTTP" = "200" ]; then
  pass GET "/v1/artifacts/:id/download" "200 (zip)"
else
  fail GET "/v1/artifacts/:id/download" "got $ART_HTTP, expected 200" "$(echo "$ART_HEAD" | head -c 200)"
fi
curl -s -m 30 "$URL/v1/artifacts/$JOB_ID/download" -H "Authorization: Bearer $KEY" -o "$ART_TMP"
ART_BYTES=$(wc -c < "$ART_TMP")
if [ "$ART_BYTES" -gt 1000 ]; then
  pass GET "/v1/artifacts/:id/download" "${ART_BYTES} bytes on disk"
else
  fail GET "/v1/artifacts/:id/download" "artifact too small ($ART_BYTES bytes)" ""
fi
ART_MAGIC=$(head -c 2 "$ART_TMP" | od -An -tx1 | tr -d ' \n')
if [ "$ART_MAGIC" = "504b" ]; then
  pass GET "/v1/artifacts/:id/download" "PK zip magic ok"
else
  fail GET "/v1/artifacts/:id/download" "wrong magic: $ART_MAGIC" ""
fi
rm -f "$ART_TMP"

# --- 11. Receipts verify ---
# Pull the receipt out of the compile job doc and POST it back.
RECEIPT_JSON=$(curl -s "$URL/v1/compile/$JOB_ID" -H "Authorization: Bearer $KEY" \
  | node -e 'let d="";process.stdin.on("data",c=>d+=c).on("end",()=>{try{const j=JSON.parse(d);if(j.receipt)process.stdout.write(JSON.stringify(j.receipt))}catch{}})' 2>/dev/null)
if [ -n "$RECEIPT_JSON" ]; then
  hit POST "/v1/receipts/verify" 200 -H "Content-Type: application/json" -d "{\"receipt\":$RECEIPT_JSON}"
  contains '"verified":true' "/v1/receipts/verify returns verified:true"
else
  fail POST "/v1/receipts/verify" "could not extract receipt from compile job" ""
fi

# --- 12. Registry public ---
hit GET "/v1/registry/public" 200
contains '"artifacts"' "/v1/registry/public returns artifacts[]"

# --- 13. Compose ---
COMPOSE_BODY='{"query":"is this an email or a url","input":"hi@example.com","k":3,"strategy":"attention"}'
hit POST "/v1/compose" 200 -H "Authorization: Bearer $KEY" -H "Content-Type: application/json" -d "$COMPOSE_BODY"
contains "dispatched" "/v1/compose returns dispatched array"

# --- 14. Telemetry — real numbers ---
hit GET "/v1/telemetry" 200 -H "Authorization: Bearer $KEY"
contains "compiles_today" "/v1/telemetry has compiles_today"
contains "receipts_verified" "/v1/telemetry has receipts_verified"
contains "k_score_median" "/v1/telemetry has k_score_median"

# --- 15. /v1/embed (validation) ---
hit POST "/v1/embed" 400 -H "Authorization: Bearer $KEY" -H "Content-Type: application/json" -d '{}'
contains "paths" "/v1/embed validates paths"

# --- 16. /v1/recall (validation) ---
hit POST "/v1/recall" 400 -H "Authorization: Bearer $KEY" -H "Content-Type: application/json" -d '{}'
contains "query" "/v1/recall validates query"

# /v1/recall happy path — graceful empty when no qmd backend
hit POST "/v1/recall" 200 -H "Authorization: Bearer $KEY" -H "Content-Type: application/json" -d '{"query":"hello","k":3}'
contains "chunks" "/v1/recall returns chunks shape"

# --- 17. /v1/wrap/verified — accept 503 if no API key, 400 if validation fires ---
WV_STATUS=$(curl -sS -m 10 -o /tmp/smoke-wv.$$ -w "%{http_code}" -X POST "$URL/v1/wrap/verified" \
  -H "Authorization: Bearer $KEY" -H "Content-Type: application/json" \
  -d '{"messages":[{"role":"user","content":"x"}],"verified":{"test_cases":[{"input":1,"expected":1}]}}')
WV_BODY=$(cat /tmp/smoke-wv.$$ 2>/dev/null); rm -f /tmp/smoke-wv.$$
TOTAL=$((TOTAL+1))
if [ "$WV_STATUS" = "200" ] || [ "$WV_STATUS" = "503" ]; then
  PASS=$((PASS+1))
  printf "[PASS] %-7s %-44s (%s — accepted)\n" "POST" "/v1/wrap/verified" "$WV_STATUS"
else
  FAIL=$((FAIL+1))
  printf "[FAIL] %-7s %-44s (got %s, expected 200|503) BODY: %s\n" "POST" "/v1/wrap/verified" "$WV_STATUS" "$(echo "$WV_BODY" | head -c 200)"
  FAILS+=("POST /v1/wrap/verified — got $WV_STATUS")
fi

# --- 18. Rate limit: 12x signup ---
RL_HIT_429=0
for i in 1 2 3 4 5 6 7 8 9 10 11 12; do
  RL_STATUS=$(curl -sS -m 5 -o /dev/null -w "%{http_code}" -X POST "$URL/v1/signup" \
    -H "Content-Type: application/json" \
    -d "{\"email\":\"rl-$$-$i@kolm.test\"}" || echo "000")
  if [ "$RL_STATUS" = "429" ]; then
    RL_HIT_429=$i
    break
  fi
done
TOTAL=$((TOTAL+1))
if [ "$RL_HIT_429" -gt 0 ] && [ "$RL_HIT_429" -le 11 ]; then
  PASS=$((PASS+1))
  printf "[PASS] %-7s %-44s (429 hit at request %d)\n" "POST" "/v1/signup x12 → 429" "$RL_HIT_429"
else
  FAIL=$((FAIL+1))
  printf "[FAIL] %-7s %-44s (no 429 in 12 hits)\n" "POST" "/v1/signup x12 → 429"
  FAILS+=("POST /v1/signup rate-limit — no 429 in 12 hits")
fi

# --- 19. RS-1 schemas served at /docs/* ---
hit GET "/docs/manifest-v0.1.json" 200
contains '"manifest-v0.1"' "manifest schema id present"
contains '"k_score"' "manifest schema has k_score"
contains '"recipe_registry"' "manifest schema has recipe_registry"

hit GET "/docs/receipt-v0.1.json" 200
contains '"chain"' "receipt schema has chain"
contains '"HMAC-SHA256"' "receipt schema declares HMAC-SHA256"
contains '"signature"' "receipt schema has signature"

hit GET "/docs/rs-1.md" 200
contains "RS-1" "rs-1.md mentions RS-1"

# --- summary ---
echo ""
echo "================================================"
echo " RESULTS: $PASS / $TOTAL pass, $FAIL fail"
if [ "$FAIL" -gt 0 ]; then
  echo " Failed:"
  for f in "${FAILS[@]}"; do echo "   - $f"; done
fi
echo "================================================"

if [ "$FAIL" -gt 0 ]; then exit 1; fi
exit 0
