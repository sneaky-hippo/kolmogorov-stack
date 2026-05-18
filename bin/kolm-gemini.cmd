@echo off
:: W382 kolm-gemini: route Google Gemini CLI through the local kolm proxy.
if "%KOLM_BASE_URL%"=="" (set GEMINI_BASE_URL=http://127.0.0.1:8787) else (set GEMINI_BASE_URL=%KOLM_BASE_URL%)
if "%KOLM_BASE_URL%"=="" (set GOOGLE_AI_STUDIO_API_BASE=http://127.0.0.1:8787) else (set GOOGLE_AI_STUDIO_API_BASE=%KOLM_BASE_URL%)
gemini %*
