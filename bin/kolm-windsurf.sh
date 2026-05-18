#!/usr/bin/env bash
# W382 kolm-windsurf: route Windsurf IDE through the local kolm proxy.
# Windsurf pins its provider gateway internally; if the env var is ignored,
# run `kolm dev-agent install windsurf` instead.
export OPENAI_BASE_URL="${KOLM_BASE_URL:-http://127.0.0.1:8787/v1}"
exec windsurf "$@"
