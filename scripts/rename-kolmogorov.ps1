# W254 - bulk Kolm -> Kolm rename across entire codebase.
#
# Reads every text file, applies an ordered list of replacements (most
# specific first so prefixes don't shadow), writes back as UTF-8 without
# BOM. Skips binary types, node_modules, .git, backups/.
#
# Run with: powershell -File scripts/rename-kolm.ps1
#
# Idempotent: re-running produces zero changes.

$ErrorActionPreference = "Stop"
$ROOT = Split-Path -Parent $PSScriptRoot

$REPLACEMENTS = @(
    @{ From = '@kolm/';                  To = '@kolm/' }
    @{ From = 'kolm/swebench-reproducer'; To = 'kolm/swebench-reproducer' }
    @{ From = 'kolm-ai/kolm-bench-reproducer'; To = 'kolm-ai/kolm-bench-reproducer' }
    @{ From = 'kolm-ai/kolm-stack';   To = 'kolm-ai/kolm-stack' }
    @{ From = 'github.com/kolm-ai/kolm-stack';   To = 'github.com/kolm-ai/kolm-stack' }
    @{ From = 'github.com/kolm-ai/';        To = 'github.com/kolm-ai/' }
    @{ From = 'docs.kolm.dev';           To = 'docs.kolm.dev' }
    @{ From = 'kolm.dev';                To = 'kolm.dev' }
    @{ From = 'kolm.com';                To = 'kolm.com' }
    @{ From = 'kolm.io';                 To = 'kolm.io' }
    @{ From = 'kolm.net';                To = 'kolm.net' }
    @{ From = 'brew install kolm-ai/tap';   To = 'brew install kolm-ai/tap' }
    @{ From = 'kolm-stack';              To = 'kolm-stack' }
    @{ From = 'Kolm Stack';              To = 'Kolm Stack' }
    @{ From = 'KOLM';                    To = 'KOLM' }
    @{ From = 'Kolm';                    To = 'Kolm' }
    @{ From = 'kolm';                    To = 'kolm' }
)

$INCLUDE_EXTS = @(
    '.js','.mjs','.cjs','.ts','.tsx','.d.ts',
    '.py','.json','.yaml','.yml','.md','.html','.css','.svg',
    '.toml','.rb','.sh','.ps1','.txt','.csv','.control','.xml',
    '.rs','.proto','.gradle','.lock','.cfg','.ini','.tex'
)

$EXCLUDE_DIRS = @(
    'node_modules','.git','backups','dist','build','.next','.vercel','coverage',
    '%TEMP%','tmp','.DS_Store'
)

$utf8NoBom = New-Object System.Text.UTF8Encoding($false)
$changedFiles = 0
$totalReplacements = 0
$perFileReport = @()

$all = Get-ChildItem -Path $ROOT -Recurse -File -ErrorAction SilentlyContinue | Where-Object {
    $excluded = $false
    foreach ($d in $EXCLUDE_DIRS) {
        if ($_.FullName -match [regex]::Escape("\$d\")) { $excluded = $true; break }
    }
    if ($excluded) { return $false }
    $INCLUDE_EXTS -contains $_.Extension.ToLower()
}

Write-Output "Scanning $($all.Count) candidate files for Kolm references..."

foreach ($file in $all) {
    try {
        $orig = [System.IO.File]::ReadAllText($file.FullName, $utf8NoBom)
    } catch {
        continue
    }
    if (-not ($orig -cmatch 'olmogorov')) { continue }

    $new = $orig
    $fileChanges = 0
    foreach ($r in $REPLACEMENTS) {
        $before = $new
        $new = $new.Replace($r.From, $r.To)
        if ($new -ne $before) {
            $count = ([regex]::Matches($before, [regex]::Escape($r.From))).Count
            $fileChanges += $count
        }
    }

    if ($new -ne $orig) {
        [System.IO.File]::WriteAllText($file.FullName, $new, $utf8NoBom)
        $changedFiles++
        $totalReplacements += $fileChanges
        $perFileReport += [PSCustomObject]@{
            Path = $file.FullName.Substring($ROOT.Length + 1)
            Changes = $fileChanges
        }
    }
}

Write-Output ""
Write-Output "=========================================="
Write-Output "Files changed: $changedFiles"
Write-Output "Total replacements: $totalReplacements"
Write-Output "=========================================="
Write-Output ""

if ($perFileReport.Count -gt 0) {
    $perFileReport | Sort-Object -Property Changes -Descending | Select-Object -First 30 | Format-Table -AutoSize
}
