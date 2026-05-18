#!/usr/bin/env bash
# W382 kolm-aider: route aider through the local kolm proxy.
export OPENAI_API_BASE="${KOLM_BASE_URL:-http://127.0.0.1:8787/v1}"
export OPENAI_BASE_URL="${KOLM_BASE_URL:-http://127.0.0.1:8787/v1}"
exec aider "$@"
