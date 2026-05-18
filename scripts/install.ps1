# kolm bootstrap installer - Windows PowerShell 5.1+.
#
# usage:
#   irm https://kolm.ai/install.ps1 | iex
#   $env:KOLM_VERSION='v7.4.0'; irm https://kolm.ai/install.ps1 | iex
#   $env:KOLM_INSTALL_DIR='C:\tools\kolm'; irm https://kolm.ai/install.ps1 | iex
#
# what it does:
#   1. detects arch
#   2. ensures node >=20
#   3. clones the kolm repo into KOLM_INSTALL_DIR (default %USERPROFILE%\.kolm\lib\kolm)
#   4. drops a kolm.cmd shim into KOLM_BIN_DIR (default %USERPROFILE%\.local\bin)
#   5. runs `kolm doctor --quick`

[CmdletBinding()] param()

$ErrorActionPreference = 'Stop'

$KolmVersion     = if ($env:KOLM_VERSION)     { $env:KOLM_VERSION }     else { 'main' }
$KolmInstallDir  = if ($env:KOLM_INSTALL_DIR) { $env:KOLM_INSTALL_DIR } else { Join-Path $env:USERPROFILE '.kolm\lib\kolm' }
$KolmBinDir      = if ($env:KOLM_BIN_DIR)     { $env:KOLM_BIN_DIR }     else { Join-Path $env:USERPROFILE '.local\bin' }
$KolmRepoUrl     = if ($env:KOLM_REPO_URL)    { $env:KOLM_REPO_URL }    else { 'https://github.com/sneaky-hippo/kolm-stack.git' }
$KolmRequireNode = if ($env:KOLM_REQUIRE_NODE_MAJOR) { [int]$env:KOLM_REQUIRE_NODE_MAJOR } else { 20 }

function Write-Log  ([string]$msg) { Write-Host "[kolm-install] $msg" }
function Write-Warn ([string]$msg) { Write-Host "[kolm-install] warn:  $msg" -ForegroundColor Yellow }
function Throw-Err  ([string]$msg) { throw "[kolm-install] error: $msg" }

function Test-Node {
  $node = Get-Command node -ErrorAction SilentlyContinue
  if (-not $node) { Throw-Err "node not found. install Node.js >=$KolmRequireNode from https://nodejs.org and re-run." }
  $major = & node -e "process.stdout.write(String(process.versions.node.split('.')[0]))"
  if ([int]$major -lt $KolmRequireNode) {
    Throw-Err "node version $major found, need >=$KolmRequireNode. upgrade Node.js and re-run."
  }
  $ver = & node -v
  Write-Log "node $ver OK"
}

function Test-Git {
  if (-not (Get-Command git -ErrorAction SilentlyContinue)) {
    Throw-Err "git not found. install Git for Windows from https://git-scm.com and re-run."
  }
}

function Get-OrUpdateRepo {
  if (Test-Path (Join-Path $KolmInstallDir '.git')) {
    Write-Log "updating existing checkout at $KolmInstallDir"
    Push-Location $KolmInstallDir
    try {
      & git fetch --depth=1 origin $KolmVersion 2>$null
      & git checkout -q $KolmVersion
      try { & git reset --hard "origin/$KolmVersion" 2>$null } catch { & git reset --hard $KolmVersion }
    } finally { Pop-Location }
  } else {
    Write-Log "cloning $KolmRepoUrl@$KolmVersion into $KolmInstallDir"
    $parent = Split-Path -Parent $KolmInstallDir
    if (-not (Test-Path $parent)) { New-Item -ItemType Directory -Force -Path $parent | Out-Null }
    try {
      & git clone --depth=1 --branch $KolmVersion $KolmRepoUrl $KolmInstallDir 2>$null
    } catch {
      & git clone --depth=1 $KolmRepoUrl $KolmInstallDir
    }
  }
}

function Install-Shim {
  if (-not (Test-Path $KolmBinDir)) { New-Item -ItemType Directory -Force -Path $KolmBinDir | Out-Null }
  $entry = Join-Path $KolmInstallDir 'cli\kolm.js'
  if (-not (Test-Path $entry)) { Throw-Err "expected $entry after clone, not found" }
  $shim = Join-Path $KolmBinDir 'kolm.cmd'
  $body = "@echo off`r`nnode `"$entry`" %*`r`n"
  Set-Content -Path $shim -Value $body -Encoding ascii
  Write-Log "shim written to $shim"

  $psShim = Join-Path $KolmBinDir 'kolm.ps1'
  $psBody = "#!/usr/bin/env pwsh`r`n& node `"$entry`" @args`r`nexit `$LASTEXITCODE`r`n"
  Set-Content -Path $psShim -Value $psBody -Encoding utf8
  Write-Log "ps1 shim written to $psShim"
}

function Add-PathHint {
  $userPath = [Environment]::GetEnvironmentVariable('Path', 'User')
  if ($userPath -notlike "*$KolmBinDir*") {
    Write-Warn "$KolmBinDir is not on your User PATH."
    Write-Warn "to add: [Environment]::SetEnvironmentVariable('Path', `"`$([Environment]::GetEnvironmentVariable('Path','User'));$KolmBinDir`", 'User')"
    Write-Warn "open a new terminal after setting PATH to pick up the change."
  }
}

function Test-Install {
  $kolm = Join-Path $KolmBinDir 'kolm.cmd'
  try {
    $ver = (& $kolm version 2>$null | Select-Object -First 1)
    if ($ver) { Write-Log "kolm installed: $ver" } else { Write-Warn "kolm shim ran but did not report version" }
  } catch {
    Write-Warn "kolm shim test failed: $($_.Exception.Message)"
  }
  try {
    & $kolm doctor --quick 2>$null | Out-Null
    if ($LASTEXITCODE -eq 0) { Write-Log "kolm doctor: pass" } else { Write-Warn "kolm doctor reported issues - run 'kolm doctor' to inspect" }
  } catch {
    Write-Warn "kolm doctor failed to run"
  }
}

function Main {
  $arch = if ([Environment]::Is64BitOperatingSystem) { if ($env:PROCESSOR_ARCHITECTURE -eq 'ARM64') { 'arm64' } else { 'x86_64' } } else { 'x86' }
  Write-Log "platform: windows/$arch"

  Test-Node
  Test-Git
  Get-OrUpdateRepo
  Install-Shim
  Add-PathHint
  Test-Install

  Write-Host ""
  Write-Host "next steps:"
  Write-Host "  1. open a new PowerShell window (PATH refresh)"
  Write-Host "  2. kolm quickstart            # 60-second tour"
  Write-Host "  3. kolm services start all    # boot redactor + compiler + proxy locally"
  Write-Host "  4. kolm bootstrap             # finish multi-device + cloud config (optional)"
  Write-Host ""
  Write-Host "docs:    https://kolm.ai/quickstart"
  Write-Host "install: $KolmInstallDir"
  Write-Host "binary:  $(Join-Path $KolmBinDir 'kolm.cmd')"
  Write-Host ""
}

Main
