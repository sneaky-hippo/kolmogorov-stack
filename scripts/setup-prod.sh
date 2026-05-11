#!/usr/bin/env bash
# One-shot setter for kolm production env vars on Railway.
#
# Fill in the values you have, comment out the ones you don't yet, and run:
#   bash scripts/setup-prod.sh
#
# This requires the railway CLI to be linked to the kolm project:
#   railway link --project kolmogorov-stack
#
# Anything left as <YOURS> is skipped — re-run after you create the OAuth
# apps / Resend API key / etc. Idempotent.

set -euo pipefail

SERVICE="kolmogorov-stack"

# Source the operator's production env file if present. This file is .gitignored
# (covered by .env.* in .gitignore) — paste the live Stripe payment-link URLs +
# secrets there once, then any future invocation of this script picks them up
# without leaving secrets in version control.
PROD_ENV_FILE="${KOLM_PROD_ENV_FILE:-scripts/.env.production}"
if [ -f "$PROD_ENV_FILE" ]; then
  set -a; . "$PROD_ENV_FILE"; set +a
  echo "loaded $PROD_ENV_FILE"
fi

set_var() {
  local name="$1"
  local value="$2"
  if [ -z "$value" ] || [ "$value" = "<YOURS>" ]; then
    echo "skip  $name (not set)"
    return
  fi
  # MSYS_NO_PATHCONV=1 prevents Git Bash for Windows from rewriting Unix paths
  # like /app/data into C:/Program Files/Git/app/data when forwarding to railway.
  MSYS_NO_PATHCONV=1 railway variable set "$name=$value" --service "$SERVICE" --skip-deploys >/dev/null
  echo "ok    $name"
}

# --- Stripe ----------------------------------------------------------------
# Payment links are env-driven so the URLs never live in version control. Set
# them in scripts/.env.production (gitignored) or export before running. The
# canonical monthly amounts ($9 / $49 / $149 / $1,499 / $2,999) are checked
# server-side via planFromAmount() — every Payment Link must charge exactly
# the canonical price for plan resolution to work.
set_var STRIPE_PAYMENT_LINK_STARTER  "${STRIPE_PAYMENT_LINK_STARTER:-}"
set_var STRIPE_PAYMENT_LINK_PRO      "${STRIPE_PAYMENT_LINK_PRO:-}"
set_var STRIPE_PAYMENT_LINK_TEAMS    "${STRIPE_PAYMENT_LINK_TEAMS:-}"
set_var STRIPE_PAYMENT_LINK_BUSINESS "${STRIPE_PAYMENT_LINK_BUSINESS:-}"
set_var STRIPE_PAYMENT_LINK_ENT      "${STRIPE_PAYMENT_LINK_ENT:-}"

# Webhook secret + secret key — both env-driven via scripts/.env.production.
# Webhook signs `checkout.session.completed` etc.; secret key powers the
# subscription-cancel-on-delete path in /v1/account/delete.
set_var STRIPE_WEBHOOK_SECRET "${STRIPE_WEBHOOK_SECRET:-}"
set_var STRIPE_SECRET_KEY     "${STRIPE_SECRET_KEY:-}"

# --- OAuth -----------------------------------------------------------------
# Google: https://console.cloud.google.com/apis/credentials
#   Authorized redirect URI: https://kolm.ai/v1/oauth/google/callback
set_var GOOGLE_OAUTH_CLIENT_ID     "${GOOGLE_OAUTH_CLIENT_ID:-}"
set_var GOOGLE_OAUTH_CLIENT_SECRET "${GOOGLE_OAUTH_CLIENT_SECRET:-}"

# GitHub: https://github.com/settings/developers -> New OAuth App
#   Homepage URL:               https://kolm.ai
#   Authorization callback URL: https://kolm.ai/v1/oauth/github/callback
set_var GITHUB_OAUTH_CLIENT_ID     "${GITHUB_OAUTH_CLIENT_ID:-}"
set_var GITHUB_OAUTH_CLIENT_SECRET "${GITHUB_OAUTH_CLIENT_SECRET:-}"

set_var OAUTH_REDIRECT_BASE "${OAUTH_REDIRECT_BASE:-https://kolm.ai}"

# --- Persistence -----------------------------------------------------------
# Required for /ready to return ready in production. KOLM_DATA_DIR must point
# at a writable path. Without a Railway volume mounted at /data this is
# ephemeral (wiped on every restart); add the volume after first launch:
#   railway volume add --mount-path /data --service kolmogorov-stack
# then change these to /data and /data/artifacts.
set_var KOLM_DATA_DIR        "/app/data"
set_var KOLM_ARTIFACT_DIR    "/app/data/artifacts"
set_var KOLM_STORE_DRIVER    "json"
set_var KOLM_ALLOW_JSON_STORE "true"

# --- Email (Resend) --------------------------------------------------------
# 1. Sign up at https://resend.com (Google login works)
# 2. Add the kolm.ai domain at https://resend.com/domains
# 3. Create an API key at https://resend.com/api-keys
# 4. Set RESEND_API_KEY in scripts/.env.production (re_... key)
set_var RESEND_API_KEY "${RESEND_API_KEY:-}"
set_var EMAIL_FROM     "${EMAIL_FROM:-kolm <hello@kolm.ai>}"
set_var EMAIL_REPLY_TO "${EMAIL_REPLY_TO:-rodneyyesep@gmail.com}"

echo ""
echo "done. Trigger a redeploy for changes to take effect:"
echo "  railway up --service $SERVICE --detach"
