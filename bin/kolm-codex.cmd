@echo off
:: W382 kolm-codex: route OpenAI Codex CLI through the local kolm proxy.
if "%KOLM_BASE_URL%"=="" (set OPENAI_BASE_URL=http://127.0.0.1:8787/v1) else (set OPENAI_BASE_URL=%KOLM_BASE_URL%)
codex %*
