# W382 kolm-windsurf: route Windsurf IDE through the local kolm proxy.
# Windsurf pins its provider gateway internally; if the env var is ignored,
# run `kolm dev-agent install windsurf` instead.
$env:OPENAI_BASE_URL = if ($env:KOLM_BASE_URL) { $env:KOLM_BASE_URL } else { 'http://127.0.0.1:8787/v1' }
& windsurf @args
exit $LASTEXITCODE
