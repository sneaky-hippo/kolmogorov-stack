@echo off
:: W382 kolm-claude: route Anthropic Claude Code CLI through the local kolm proxy.
if "%KOLM_BASE_URL%"=="" (set ANTHROPIC_BASE_URL=http://127.0.0.1:8787) else (set ANTHROPIC_BASE_URL=%KOLM_BASE_URL%)
claude %*
