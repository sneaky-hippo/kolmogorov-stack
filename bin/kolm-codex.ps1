# W382 kolm-codex: route OpenAI Codex CLI through the local kolm proxy.
$env:OPENAI_BASE_URL = if ($env:KOLM_BASE_URL) { $env:KOLM_BASE_URL } else { 'http://127.0.0.1:8787/v1' }
& codex @args
exit $LASTEXITCODE
