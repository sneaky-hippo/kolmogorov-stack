#!/usr/bin/env bash
# Walks every <loc> in public/sitemap.xml against $URL with curl -sI.
# Exits non-zero if any URL returns non-200. No deps beyond curl + sed.
#
# Usage:
#   URL=https://kolm.ai bash scripts/check-sitemap.sh
#   URL=http://localhost:8787 bash scripts/check-sitemap.sh

set -u
URL="${URL:-https://kolm.ai}"
SITEMAP="public/sitemap.xml"
PASS=0
FAIL=0
FAILS=""

if [ ! -f "$SITEMAP" ]; then
  echo "sitemap not found: $SITEMAP"
  exit 2
fi

echo "check-sitemap against $URL"
echo "----------------------------------------"

while IFS= read -r line; do
  loc=$(printf '%s' "$line" | sed -n 's/.*<loc>\(.*\)<\/loc>.*/\1/p')
  [ -z "$loc" ] && continue
  path=$(printf '%s' "$loc" | sed -E 's#^https?://[^/]+##')
  [ -z "$path" ] && path="/"
  full="${URL}${path}"
  code=$(curl -s -o /dev/null -w '%{http_code}' -L --max-time 8 "$full" 2>/dev/null || echo "000")
  if [ "$code" = "200" ]; then
    PASS=$((PASS + 1))
  else
    FAIL=$((FAIL + 1))
    FAILS="${FAILS}\n  $code  $path"
  fi
done < "$SITEMAP"

echo "passed: $PASS   failed: $FAIL"
if [ "$FAIL" -gt 0 ]; then
  printf 'failures:%b\n' "$FAILS"
  exit 1
fi
exit 0
