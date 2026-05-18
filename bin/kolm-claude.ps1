# W382 kolm-claude: route Anthropic Claude Code CLI through the local kolm proxy.
$env:ANTHROPIC_BASE_URL = if ($env:KOLM_BASE_URL) { $env:KOLM_BASE_URL } else { 'http://127.0.0.1:8787' }
& claude @args
exit $LASTEXITCODE
