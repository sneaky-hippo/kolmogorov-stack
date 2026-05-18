# W382 kolm-gemini: route Google Gemini CLI through the local kolm proxy.
$base = if ($env:KOLM_BASE_URL) { $env:KOLM_BASE_URL } else { 'http://127.0.0.1:8787' }
$env:GEMINI_BASE_URL = $base
$env:GOOGLE_AI_STUDIO_API_BASE = $base
& gemini @args
exit $LASTEXITCODE
