#!/usr/bin/env bash
# Run examples/clicks.sql against the Analytics Engine SQL API.
# Requires CLOUDFLARE_ACCOUNT_ID and CLOUDFLARE_API_TOKEN (Account Analytics: Read).
set -euo pipefail
: "${CLOUDFLARE_ACCOUNT_ID:?set CLOUDFLARE_ACCOUNT_ID}"
: "${CLOUDFLARE_API_TOKEN:?set CLOUDFLARE_API_TOKEN}"
curl -fsS "https://api.cloudflare.com/client/v4/accounts/${CLOUDFLARE_ACCOUNT_ID}/analytics_engine/sql" \
  --header "Authorization: Bearer ${CLOUDFLARE_API_TOKEN}" \
  --data-binary @"$(dirname "$0")/clicks.sql"
