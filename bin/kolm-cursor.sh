#!/usr/bin/env bash
# W382 kolm-cursor: route Cursor IDE through the local kolm proxy.
#
# Cursor does not honor OPENAI_BASE_URL the same way pure SDKs do - the IDE
# pins its provider gateway internally. If your build of Cursor ignores the
# env var, run `kolm dev-agent install cursor` instead so the proxy URL is
# written into Cursor's User/settings.json.
export OPENAI_BASE_URL="${KOLM_BASE_URL:-http://127.0.0.1:8787/v1}"
exec cursor "$@"
