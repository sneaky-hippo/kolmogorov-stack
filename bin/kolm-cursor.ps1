# W382 kolm-cursor: route Cursor IDE through the local kolm proxy.
# Cursor pins its provider gateway internally; if the env var is ignored,
# run `kolm dev-agent install cursor` instead.
$env:OPENAI_BASE_URL = if ($env:KOLM_BASE_URL) { $env:KOLM_BASE_URL } else { 'http://127.0.0.1:8787/v1' }
& cursor @args
exit $LASTEXITCODE
