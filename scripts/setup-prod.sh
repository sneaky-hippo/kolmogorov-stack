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

set_var() {
  local name="$1"
  local value="$2"
  if [ -z "$value" ] || [ "$value" = "<YOURS>" ]; then
    echo "skip  $name (not set)"
    return
  fi
  railway variables --service "$SERVICE" --set "$name=$value" >/dev/null
  echo "ok    $name"
}

# --- Stripe ----------------------------------------------------------------
# Already set per the v7.0 deploy. Re-run is idempotent.
set_var STRIPE_PAYMENT_LINK_STARTER  "https://buy.stripe.com/cNiaEX53n5c0aaA5Kobo400"
set_var STRIPE_PAYMENT_LINK_PRO      "https://buy.stripe.com/00w8wPcvP1ZOeqQ1u8bo401"
set_var STRIPE_PAYMENT_LINK_TEAMS    "https://buy.stripe.com/fZubJ1eDX1ZOfuU1u8bo402"
set_var STRIPE_PAYMENT_LINK_BUSINESS "https://buy.stripe.com/14A3cvbrL8oc96wgp2bo403"
set_var STRIPE_PAYMENT_LINK_ENT      "https://buy.stripe.com/fZuaEX0N75c0dmMfkYbo404"

# Webhook secret (already set on Railway). Uncomment + set if rotating.
# set_var STRIPE_WEBHOOK_SECRET "whsec_..."

# Stripe secret key — needed for auto-cancelling subscriptions on /account/delete.
# Get it from https://dashboard.stripe.com/apikeys
set_var STRIPE_SECRET_KEY "<YOURS>"

# --- OAuth -----------------------------------------------------------------
# Google: https://console.cloud.google.com/apis/credentials
#   Authorized redirect URI: https://kolm.ai/v1/oauth/google/callback
set_var GOOGLE_OAUTH_CLIENT_ID     "<YOURS>"
set_var GOOGLE_OAUTH_CLIENT_SECRET "<YOURS>"

# GitHub: https://github.com/settings/developers -> New OAuth App
#   Homepage URL:               https://kolm.ai
#   Authorization callback URL: https://kolm.ai/v1/oauth/github/callback
set_var GITHUB_OAUTH_CLIENT_ID     "<YOURS>"
set_var GITHUB_OAUTH_CLIENT_SECRET "<YOURS>"

set_var OAUTH_REDIRECT_BASE "https://kolm.ai"

# --- Email (Resend) --------------------------------------------------------
# 1. Sign up at https://resend.com (Google login works)
# 2. Add the kolm.ai domain at https://resend.com/domains
# 3. Create an API key at https://resend.com/api-keys
# 4. Paste the re_... key here
set_var RESEND_API_KEY "<YOURS>"
set_var EMAIL_FROM     "kolm <hello@kolm.ai>"
set_var EMAIL_REPLY_TO "rodneyyesep@gmail.com"

echo ""
echo "done. Trigger a redeploy for changes to take effect:"
echo "  railway up --service $SERVICE --detach"
