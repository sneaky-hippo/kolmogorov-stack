#!/usr/bin/env bash
# W382 kolm-codex: route OpenAI Codex CLI through the local kolm proxy.
# Override the proxy URL with KOLM_BASE_URL=https://your.proxy:8787
export OPENAI_BASE_URL="${KOLM_BASE_URL:-http://127.0.0.1:8787/v1}"
exec codex "$@"
