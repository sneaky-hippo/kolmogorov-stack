#!/usr/bin/env bash
# e2e-hub.sh — verify the /v1/hub publish→list→pull round-trip and tenant isolation.
# Use: URL=https://kolm.ai bash scripts/e2e-hub.sh
set -u

URL="${URL:-http://127.0.0.1:3000}"
PASS=0
FAIL=0
ok()   { echo -e "  \033[32mPASS\033[0m $1 \033[2m$2\033[0m"; PASS=$((PASS+1)); }
nok()  { echo -e "  \033[31mFAIL\033[0m $1 \033[2m$2\033[0m"; FAIL=$((FAIL+1)); }

echo "e2e-hub against $URL"
echo "----------------------------------------"

# 0. signup two tenants
TS=$(date +%s)
RAW_A=$(curl -s -X POST "$URL/v1/signup" -H 'Content-Type: application/json' -d "{\"email\":\"e2e-hub-a-$TS@example.invalid\"}")
RAW_B=$(curl -s -X POST "$URL/v1/signup" -H 'Content-Type: application/json' -d "{\"email\":\"e2e-hub-b-$TS@example.invalid\"}")
KEY_A=$(echo "$RAW_A" | grep -oE '"api_key":"[^"]+"' | head -1 | cut -d'"' -f4)
KEY_B=$(echo "$RAW_B" | grep -oE '"api_key":"[^"]+"' | head -1 | cut -d'"' -f4)
TEN_A=$(echo "$RAW_A" | grep -oE '"id":"tenant_[^"]+"' | head -1 | cut -d'"' -f4)
TEN_B=$(echo "$RAW_B" | grep -oE '"id":"tenant_[^"]+"' | head -1 | cut -d'"' -f4)
[ -n "$KEY_A" ] && [ -n "$KEY_B" ] && ok "0a. signup two tenants" "A=$TEN_A B=$TEN_B" || nok "0a. signup two tenants" "raw=$RAW_A"

# 1. publish public artifact from tenant A
NAME_PUB="e2e-pub-$(date +%s)-$RANDOM"
BODY_PUB='{"name":"'$NAME_PUB'","visibility":"public","artifact_b64":"SGVsbG8gd29ybGQ=","metadata":{"base":"llama-3.1-8b","task":"redactor","k_score":0.94,"gate":0.85,"license":"MIT","tags":["e2e"]}}'
PUB_RES=$(curl -s -X POST "$URL/v1/hub/publish" -H "X-API-Key: $KEY_A" -H 'Content-Type: application/json' -d "$BODY_PUB")
PUB_HANDLE=$(echo "$PUB_RES" | grep -oE '"handle":"[^"]+"' | cut -d'"' -f4)
PUB_SHA=$(echo "$PUB_RES" | grep -oE '"sha256":"[^"]+"' | cut -d'"' -f4)
PUB_REF=${PUB_HANDLE%@*}  # owner/name without @sha256 suffix
[ -n "$PUB_HANDLE" ] && ok "1. tenant A publishes public artifact" "handle=$PUB_HANDLE sha=${PUB_SHA:0:12}…" || nok "1. tenant A publishes public artifact" "res=$PUB_RES"

# 2. publish private artifact from tenant A
NAME_PRV="e2e-prv-$(date +%s)-$RANDOM"
BODY_PRV='{"name":"'$NAME_PRV'","visibility":"private","artifact_b64":"U2VjcmV0IGhlYWx0aGNhcmU=","metadata":{"base":"llama-3.1-8b","task":"classifier","k_score":0.91,"gate":0.85,"license":"proprietary"}}'
PRV_RES=$(curl -s -X POST "$URL/v1/hub/publish" -H "X-API-Key: $KEY_A" -H 'Content-Type: application/json' -d "$BODY_PRV")
PRV_HANDLE=$(echo "$PRV_RES" | grep -oE '"handle":"[^"]+"' | cut -d'"' -f4)
PRV_REF=${PRV_HANDLE%@*}
[ -n "$PRV_HANDLE" ] && ok "2. tenant A publishes private artifact" "handle=$PRV_HANDLE" || nok "2. tenant A publishes private artifact" "res=$PRV_RES"

# 3. anon list (public only)
LIST=$(curl -s "$URL/v1/hub?limit=200")
echo "$LIST" | grep -q "$NAME_PUB" && ok "3a. anon list contains public artifact" "" || nok "3a. anon list contains public artifact" "list missing pub"
echo "$LIST" | grep -q "$NAME_PRV" && nok "3b. anon list MUST NOT leak private" "leaked!" || ok "3b. anon list omits private" ""

# 4. anon GET public metadata
META_PUB=$(curl -s -o /dev/null -w "%{http_code}" "$URL/v1/hub/$PUB_REF")
[ "$META_PUB" = "200" ] && ok "4a. anon reads public metadata" "http=$META_PUB" || nok "4a. anon reads public metadata" "http=$META_PUB"

# 4b. anon GET private metadata -> 404 (no existence leak)
META_PRV=$(curl -s -o /dev/null -w "%{http_code}" "$URL/v1/hub/$PRV_REF")
[ "$META_PRV" = "404" ] && ok "4b. anon gets 404 on private (no leak)" "http=$META_PRV" || nok "4b. anon gets 404 on private (no leak)" "http=$META_PRV"

# 5. anon download public + SHA header matches
DL_HDR=$(curl -s -D - "$URL/v1/hub/$PUB_REF/download" -o /tmp/e2e-hub-pub.bin)
DL_SHA=$(echo "$DL_HDR" | grep -i '^x-kolm-sha256:' | tr -d '\r\n' | awk '{print $2}')
[ "$DL_SHA" = "$PUB_SHA" ] && ok "5a. anon download X-Kolm-Sha256 matches publish sha" "${DL_SHA:0:12}…" || nok "5a. anon download X-Kolm-Sha256 matches publish sha" "got=$DL_SHA want=$PUB_SHA"

# 5b. anon download private -> 404
PRV_DL=$(curl -s -o /dev/null -w "%{http_code}" "$URL/v1/hub/$PRV_REF/download")
[ "$PRV_DL" = "404" ] && ok "5b. anon download on private -> 404" "http=$PRV_DL" || nok "5b. anon download on private -> 404" "http=$PRV_DL"

# 6. tenant B cannot read tenant A's private (cross-tenant isolation)
META_PRV_B=$(curl -s -o /dev/null -w "%{http_code}" -H "X-API-Key: $KEY_B" "$URL/v1/hub/$PRV_REF")
[ "$META_PRV_B" = "404" ] && ok "6a. tenant B gets 404 on tenant A's private" "http=$META_PRV_B" || nok "6a. tenant B gets 404 on tenant A's private" "http=$META_PRV_B"

DL_PRV_B=$(curl -s -o /dev/null -w "%{http_code}" -H "X-API-Key: $KEY_B" "$URL/v1/hub/$PRV_REF/download")
[ "$DL_PRV_B" = "404" ] && ok "6b. tenant B download tenant A's private -> 404" "http=$DL_PRV_B" || nok "6b. tenant B download tenant A's private -> 404" "http=$DL_PRV_B"

# 7. tenant A reads own private
META_A_OWN=$(curl -s -o /dev/null -w "%{http_code}" -H "X-API-Key: $KEY_A" "$URL/v1/hub/$PRV_REF")
[ "$META_A_OWN" = "200" ] && ok "7. tenant A reads OWN private (authed)" "http=$META_A_OWN" || nok "7. tenant A reads OWN private (authed)" "http=$META_A_OWN"

# 8. idempotent publish — same name + same SHA = update, not conflict
IDEMP=$(curl -s -X POST "$URL/v1/hub/publish" -H "X-API-Key: $KEY_A" -H 'Content-Type: application/json' -d "$BODY_PUB")
IDEMP_HANDLE=$(echo "$IDEMP" | grep -oE '"handle":"[^"]+"' | cut -d'"' -f4)
[ "$IDEMP_HANDLE" = "$PUB_HANDLE" ] && ok "8. idempotent publish on same sha returns same handle" "$IDEMP_HANDLE" || nok "8. idempotent publish on same sha returns same handle" "got=$IDEMP_HANDLE want=$PUB_HANDLE"

# 9. conflict — same name, different SHA -> 409
BODY_CONFLICT='{"name":"'$NAME_PUB'","visibility":"public","artifact_b64":"RGlmZmVyZW50IGJsb2IgY29udGVudA=="}'
CONFLICT=$(curl -s -o /dev/null -w "%{http_code}" -X POST "$URL/v1/hub/publish" -H "X-API-Key: $KEY_A" -H 'Content-Type: application/json' -d "$BODY_CONFLICT")
[ "$CONFLICT" = "409" ] && ok "9. conflict on same name + different sha -> 409" "http=$CONFLICT" || nok "9. conflict on same name + different sha -> 409" "http=$CONFLICT"

# 10. unauthed publish -> 401
UNAUTHED=$(curl -s -o /dev/null -w "%{http_code}" -X POST "$URL/v1/hub/publish" -H 'Content-Type: application/json' -d "$BODY_PUB")
[ "$UNAUTHED" = "401" ] && ok "10. unauthed publish -> 401" "http=$UNAUTHED" || nok "10. unauthed publish -> 401" "http=$UNAUTHED"

echo "----------------------------------------"
echo "passed: $PASS   failed: $FAIL"
exit $FAIL
