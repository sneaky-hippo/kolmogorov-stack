#!/usr/bin/env bash
# W382 kolm-gemini: route Google Gemini CLI through the local kolm proxy.
export GEMINI_BASE_URL="${KOLM_BASE_URL:-http://127.0.0.1:8787}"
export GOOGLE_AI_STUDIO_API_BASE="${KOLM_BASE_URL:-http://127.0.0.1:8787}"
exec gemini "$@"
