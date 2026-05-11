#!/usr/bin/env bash
# Sensitive-data readiness probe. Walks the surface a first paying user with
# sensitive data would hit: tenant isolation, auth boundaries, receipt
# integrity, security headers, error-leak hygiene, rate-limit exposure.
#
# Usage:
#   URL=https://kolm.ai bash scripts/sensitive-data-readiness.sh
#
# This is heavier than e2e-flow.sh: e2e proves the happy path works for one
# tenant; this proves two tenants don't see each other's data and that the
# unauthed perimeter actually says 401.

set -u
URL="${URL:-https://kolm.ai}"
STAMP=$(date +%s)
PASS=0; FAIL=0

c_pass(){ printf '\033[32mPASS\033[0m'; }
c_fail(){ printf '\033[31mFAIL\033[0m'; }
c_info(){ printf '\033[2m%s\033[0m' "$1"; }
step(){
  local name="$1" cond="$2" detail="${3:-}"
  if [ "$cond" = "1" ]; then PASS=$((PASS+1)); printf '  '; c_pass; printf ' %s ' "$name"; c_info "$detail"; printf '\n'
  else FAIL=$((FAIL+1)); printf '  '; c_fail; printf ' %s ' "$name"; c_info "$detail"; printf '\n'; fi
}

echo "sensitive-data-readiness against $URL"
echo "----------------------------------------"

# ---- Signup two distinct tenants ----
EMAIL_A="sdr-a+${STAMP}@example.com"
EMAIL_B="sdr-b+${STAMP}@example.com"
SA=$(curl -s -X POST "$URL/v1/signup" -H 'content-type: application/json' -d "{\"email\":\"$EMAIL_A\",\"plan\":\"free\"}")
SB=$(curl -s -X POST "$URL/v1/signup" -H 'content-type: application/json' -d "{\"email\":\"$EMAIL_B\",\"plan\":\"free\"}")
KA=$(printf '%s' "$SA" | sed -n 's/.*"api_key"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p')
KB=$(printf '%s' "$SB" | sed -n 's/.*"api_key"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p')
# tenant id lives at tenant.id (nested) in signup response
TA=$(printf '%s' "$SA" | sed -n 's/.*"tenant"[[:space:]]*:[[:space:]]*{[[:space:]]*"id"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p')
TB=$(printf '%s' "$SB" | sed -n 's/.*"tenant"[[:space:]]*:[[:space:]]*{[[:space:]]*"id"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p')
[ -n "$KA" ] && [ -n "$KB" ] && step "0a. signup two tenants" 1 "A=$TA B=$TB" || step "0a. signup two tenants" 0 "A=$SA B=$SB"
[ "$KA" != "$KB" ] && step "0b. keys differ" 1 "" || step "0b. keys differ" 0 "same key minted"
[ "$TA" != "$TB" ] && step "0c. tenant ids differ" 1 "" || step "0c. tenant ids differ" 0 "same tenant"

# ---- Tenant A creates a recipe with sensitive-looking payload ----
SYNTH_A=$(curl -s -X POST "$URL/v1/synthesize" -H "authorization: Bearer $KA" \
  -H 'content-type: application/json' \
  -d '{"name":"sdr-secret","positives":[{"input":"SSN 123-45-6789","expected":"REDACTED"},{"input":"PHI: pt John","expected":"REDACTED"}]}')
RID=$(printf '%s' "$SYNTH_A" | sed -n 's/.*"concept_id"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p')
[ -n "$RID" ] && step "1. tenant A synthesized concept" 1 "id=$RID" || step "1. tenant A synthesized concept" 0 "$SYNTH_A"

# ---- ISOLATION: Tenant B tries to RUN tenant A's concept ----
RUN_B=$(curl -s -X POST "$URL/v1/run" -H "authorization: Bearer $KB" \
  -H 'content-type: application/json' \
  -d "{\"concept_id\":\"$RID\",\"input\":\"SSN 999-99-9999\"}")
RB_CODE=$(curl -s -o /dev/null -w '%{http_code}' -X POST "$URL/v1/run" -H "authorization: Bearer $KB" \
  -H 'content-type: application/json' \
  -d "{\"concept_id\":\"$RID\",\"input\":\"SSN 999-99-9999\"}")
# Expect 404 / 403 / 400 — anything but 200 with concept output
HAS_OUTPUT_B=$(printf '%s' "$RUN_B" | grep -c '"output"' || true)
if [ "$RB_CODE" != "200" ] && [ "$HAS_OUTPUT_B" -eq 0 ]; then
  step "2. tenant B CANNOT run tenant A concept" 1 "http=$RB_CODE"
else
  step "2. tenant B CANNOT run tenant A concept" 0 "LEAK http=$RB_CODE body=$RUN_B"
fi

# ---- ISOLATION: Tenant B does not see tenant A in observations inbox ----
OBS_B=$(curl -s "$URL/v1/bridges/observations?limit=50" -H "authorization: Bearer $KB")
LEAK_OBS=$(printf '%s' "$OBS_B" | grep -c "$TA" || true)
[ "$LEAK_OBS" -eq 0 ] && step "3. observations inbox does not leak tenant A id" 1 "" || step "3. observations inbox does not leak tenant A id" 0 "tenant A id seen"

# ---- AUTH BOUNDARY: every protected endpoint must 401 unauthed ----
probe_unauth(){
  local path="$1" method="${2:-GET}"
  local body="${3:-}"
  local code
  if [ "$method" = "GET" ]; then
    code=$(curl -s -o /dev/null -w '%{http_code}' "$URL$path")
  else
    code=$(curl -s -o /dev/null -w '%{http_code}' -X "$method" "$URL$path" \
      -H 'content-type: application/json' -d "$body")
  fi
  echo "$code"
}
for p in /v1/account /v1/bridges/observations; do
  c=$(probe_unauth "$p")
  [ "$c" = "401" ] && step "4. $p unauthed -> 401" 1 "" || step "4. $p unauthed -> 401" 0 "got=$c"
done
for p in /v1/synthesize /v1/run; do
  c=$(probe_unauth "$p" POST '{}')
  [ "$c" = "401" ] && step "4. $p unauthed -> 401" 1 "" || step "4. $p unauthed -> 401" 0 "got=$c"
done

# ---- AUTH BOUNDARY: bogus key returns 401 ----
BOG=$(curl -s -o /dev/null -w '%{http_code}' "$URL/v1/account" -H 'authorization: Bearer ks_deadbeefdeadbeefdeadbeefdeadbeef')
[ "$BOG" = "401" ] && step "5. bogus key -> 401" 1 "" || step "5. bogus key -> 401" 0 "got=$BOG"

# ---- HMAC RECEIPT: /v1/run emits signed rs-1 receipt ----
RUN_A=$(curl -s -X POST "$URL/v1/run" -H "authorization: Bearer $KA" -H 'content-type: application/json' \
  -d "{\"concept_id\":\"$RID\",\"input\":\"SSN 123-45-6789\"}")
HAS_RECEIPT=$(printf '%s' "$RUN_A" | grep -c '"receipt"' || true)
HAS_HMAC=$(printf '%s' "$RUN_A" | grep -c '"hmac"' || true)
HMAC_LEN=$(printf '%s' "$RUN_A" | sed -n 's/.*"hmac"[[:space:]]*:[[:space:]]*"\([0-9a-f]\{64\}\)".*/\1/p' | wc -c | tr -d ' ')
HAS_RS1=$(printf '%s' "$RUN_A" | grep -c '"spec":"rs-1"' || true)
[ "$HAS_RECEIPT" -gt 0 ] && step "6a. /v1/run emits receipt" 1 "" || step "6a. /v1/run emits receipt" 0 "no receipt"
[ "$HAS_HMAC" -gt 0 ] && step "6b. receipt has hmac field" 1 "" || step "6b. receipt has hmac field" 0 "no hmac"
[ "$HMAC_LEN" -ge 64 ] && step "6c. hmac is 64-char hex (sha256)" 1 "" || step "6c. hmac is 64-char hex (sha256)" 0 "len=$HMAC_LEN"
[ "$HAS_RS1" -gt 0 ] && step "6d. receipt spec=rs-1" 1 "" || step "6d. receipt spec=rs-1" 0 ""

# ---- SECURITY HEADERS on apex ----
HDR=$(curl -sI "$URL/")
hashdr(){ printf '%s' "$HDR" | grep -ic "^$1" || echo 0; }
S_STS=$(hashdr 'strict-transport-security')
S_XCT=$(hashdr 'x-content-type-options')
S_REF=$(hashdr 'referrer-policy')
S_XFO=$(hashdr 'x-frame-options\|content-security-policy.*frame-ancestors')
[ "$S_STS" -gt 0 ] && step "7a. HSTS header present" 1 "" || step "7a. HSTS header present" 0 ""
[ "$S_XCT" -gt 0 ] && step "7b. X-Content-Type-Options present" 1 "" || step "7b. X-Content-Type-Options present" 0 ""
[ "$S_REF" -gt 0 ] && step "7c. Referrer-Policy present" 1 "" || step "7c. Referrer-Policy present" 0 ""
[ "$S_XFO" -gt 0 ] && step "7d. clickjacking protection present" 1 "" || step "7d. clickjacking protection present" 0 ""

# ---- TLS only: bare HTTP redirects to HTTPS ----
HTTP_HOST=$(printf '%s' "$URL" | sed -e 's|^https://||' -e 's|^http://||' -e 's|/.*||')
HTTP_CODE=$(curl -s -o /dev/null -w '%{http_code}' "http://$HTTP_HOST/" || echo 000)
case "$HTTP_CODE" in
  301|302|307|308) step "8. bare http redirects to https" 1 "http=$HTTP_CODE" ;;
  000) step "8. bare http redirects to https" 1 "http blocked entirely" ;;
  *) step "8. bare http redirects to https" 0 "got=$HTTP_CODE (should redirect)" ;;
esac

# ---- Error responses don't leak server internals ----
SQL=$(curl -s "$URL/v1/account?id=%27%20OR%201%3D1--" -H "authorization: Bearer $KA")
LEAK_STACK=$(printf '%s' "$SQL" | grep -ic 'sqlite\|postgres\|stack\|errno\|node_modules' || true)
[ "$LEAK_STACK" -eq 0 ] && step "9. error does not leak stack/db internals" 1 "" || step "9. error does not leak stack/db internals" 0 "leak: $SQL"

# ---- audit-log path responds (currently 503 stub OK; 200 is better) ----
AUD=$(curl -s -o /dev/null -w '%{http_code}' "$URL/v1/audit/log" -H "authorization: Bearer $KA")
case "$AUD" in
  200) step "10. audit log live" 1 "http=200" ;;
  503) step "10. audit log stub returns 503" 1 "http=503 (sensitive-data customers want 200)" ;;
  *) step "10. audit log path responds" 0 "got=$AUD" ;;
esac

echo "----------------------------------------"
echo "passed: $PASS   failed: $FAIL"
[ "$FAIL" -eq 0 ] && exit 0 || exit 1
