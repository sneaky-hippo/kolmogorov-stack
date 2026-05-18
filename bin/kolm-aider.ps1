# W382 kolm-aider: route aider through the local kolm proxy.
$base = if ($env:KOLM_BASE_URL) { $env:KOLM_BASE_URL } else { 'http://127.0.0.1:8787/v1' }
$env:OPENAI_API_BASE = $base
$env:OPENAI_BASE_URL = $base
& aider @args
exit $LASTEXITCODE
