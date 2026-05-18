@echo off
:: W382 kolm-aider: route aider through the local kolm proxy.
if "%KOLM_BASE_URL%"=="" (set OPENAI_API_BASE=http://127.0.0.1:8787/v1) else (set OPENAI_API_BASE=%KOLM_BASE_URL%)
if "%KOLM_BASE_URL%"=="" (set OPENAI_BASE_URL=http://127.0.0.1:8787/v1) else (set OPENAI_BASE_URL=%KOLM_BASE_URL%)
aider %*
