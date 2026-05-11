#!/usr/bin/env bash
# E2E flow probe for kolm.ai. Walks signup -> compile -> upgrade -> downgrade ->
# capture/observations -> audit-log. Pure curl, no browser. Each step echoes
# pass/fail.
#
# Usage:
#   URL=https://kolm.ai bash scripts/e2e-flow.sh
#   URL=http://localhost:8787 bash scripts/e2e-flow.sh
#
# Reads URL from env. Default https://kolm.ai. Mirrors smoke-live.sh pattern.

set -u
URL="${URL:-https://kolm.ai}"
STAMP=$(date +%s)
PASS=0
FAIL=0

c_pass() { printf '\033[32mPASS\033[0m'; }
c_fail() { printf '\033[31mFAIL\033[0m'; }
c_info() { printf '\033[2m%s\033[0m' "$1"; }

step() {
  local name="$1"
  local cond="$2"
  local detail="${3:-}"
  if [ "$cond" = "1" ]; then
    PASS=$((PASS + 1))
    printf '  '; c_pass; printf ' %s ' "$name"; c_info "$detail"; printf '\n'
  else
    FAIL=$((FAIL + 1))
    printf '  '; c_fail; printf ' %s ' "$name"; c_info "$detail"; printf '\n'
  fi
}

echo "e2e-flow against $URL"
echo "----------------------------------------"

# Step 1: signup mints key.
EMAIL="e2e+${STAMP}@example.com"
SIGNUP=$(curl -s -X POST "$URL/v1/signup" \
  -H 'content-type: application/json' \
  -d "{\"email\":\"$EMAIL\",\"plan\":\"free\"}")
KEY=$(printf '%s' "$SIGNUP" | sed -n 's/.*"api_key"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p')
TENANT=$(printf '%s' "$SIGNUP" | sed -n 's/.*"tenant_id"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p')
[ -n "$KEY" ] && step "1. signup mints key" 1 "tenant=$TENANT" || step "1. signup mints key" 0 "$SIGNUP"

# Step 2: account returns plan + quota.
ACCT=$(curl -s "$URL/v1/account" -H "authorization: Bearer $KEY")
PLAN=$(printf '%s' "$ACCT" | sed -n 's/.*"plan"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p')
[ "$PLAN" = "free" ] && step "2. account.plan=free" 1 "" || step "2. account.plan=free" 0 "got=$PLAN"

# Step 3: synthesize a concept.
SYNTH=$(curl -s -X POST "$URL/v1/synthesize" -H "authorization: Bearer $KEY" \
  -H 'content-type: application/json' \
  -d '{"name":"e2e-recipe","positives":[{"input":"hello","expected":"hi"},{"input":"yo","expected":"hi"}]}')
RECIPE_ID=$(printf '%s' "$SYNTH" | sed -n 's/.*"concept_id"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p')
[ -n "$RECIPE_ID" ] && step "3. recipe synthesized" 1 "id=$RECIPE_ID" || step "3. recipe synthesized" 0 "$SYNTH"

# Step 4: run the concept.
RUN_OUT=$(curl -s -X POST "$URL/v1/run" -H "authorization: Bearer $KEY" \
  -H 'content-type: application/json' \
  -d "{\"concept_id\":\"$RECIPE_ID\",\"input\":\"hello\"}")
HAS_OUTPUT=$(printf '%s' "$RUN_OUT" | grep -c '"output"\|"result"\|"response"' || true)
[ "$HAS_OUTPUT" -gt 0 ] && step "4. recipe.run returns output" 1 "" || step "4. recipe.run returns output" 0 "$RUN_OUT"

# Step 5: capture proxy. We have no real upstream key, so 502 (forwardOpenAI
# fails on bad key) is the expected mounted-but-no-upstream signal. 400
# (missing messages) also proves the route exists. 404 means missing.
CAP_CODE=$(curl -s -o /dev/null -w '%{http_code}' -X POST "$URL/v1/capture/openai" \
  -H "authorization: Bearer $KEY" \
  -H 'content-type: application/json' \
  -d '{"model":"gpt-4o","messages":[{"role":"user","content":"e2e probe"}]}')
[ "$CAP_CODE" -ne 404 ] && step "5. capture proxy reachable" 1 "http=$CAP_CODE" || step "5. capture proxy reachable" 0 "http=$CAP_CODE (route missing)"

# Step 6: observations list endpoint exists.
OBS=$(curl -s "$URL/v1/bridges/observations?limit=5" -H "authorization: Bearer $KEY")
HAS_OBS=$(printf '%s' "$OBS" | grep -c '"observations"\|"total"' || true)
[ "$HAS_OBS" -gt 0 ] && step "6. observations inbox returns shape" 1 "" || step "6. observations inbox returns shape" 0 "$OBS"

# Step 7: change-plan up (free -> pro) returns billing_url with client_reference_id=tenant.
UP=$(curl -s -X POST "$URL/v1/account/change-plan" -H "authorization: Bearer $KEY" \
  -H 'content-type: application/json' -d '{"plan":"pro"}')
BILLING_URL=$(printf '%s' "$UP" | sed -n 's/.*"billing_url"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p')
HAS_REF=$(printf '%s' "$BILLING_URL" | grep -c "client_reference_id=$TENANT" || true)
HAS_NULL=$(printf '%s' "$UP" | grep -c '"billing_required":true\|"error":"billing' || true)
if [ "$HAS_REF" -gt 0 ]; then
  step "7. change-plan up returns billing_url" 1 "client_reference_id bound"
elif [ "$HAS_NULL" -gt 0 ]; then
  step "7. change-plan up returns billing_url" 1 "billing not configured (acceptable)"
else
  step "7. change-plan up returns billing_url" 0 "$UP"
fi

# Step 8: change-plan down (pro -> free) succeeds.
DN=$(curl -s -X POST "$URL/v1/account/change-plan" -H "authorization: Bearer $KEY" \
  -H 'content-type: application/json' -d '{"plan":"free"}')
DN_OK=$(printf '%s' "$DN" | grep -c '"plan":"free"\|"ok":true' || true)
[ "$DN_OK" -gt 0 ] && step "8. change-plan down succeeds" 1 "" || step "8. change-plan down succeeds" 0 "$DN"

# Step 9: audit-log returns the documented 503 stub for tenants not opted in.
AUD_CODE=$(curl -s -o /dev/null -w '%{http_code}' "$URL/v1/audit/log" -H "authorization: Bearer $KEY")
AUD_BODY=$(curl -s "$URL/v1/audit/log" -H "authorization: Bearer $KEY")
HAS_BETA=$(printf '%s' "$AUD_BODY" | grep -c 'audit_log_beta\|"entries":\[\]' || true)
if [ "$AUD_CODE" = "503" ] && [ "$HAS_BETA" -gt 0 ]; then
  step "9. audit-log stub returns 503" 1 ""
else
  step "9. audit-log stub returns 503" 0 "code=$AUD_CODE body=$AUD_BODY"
fi

echo "----------------------------------------"
echo "passed: $PASS   failed: $FAIL"
[ "$FAIL" -eq 0 ] && exit 0 || exit 1
