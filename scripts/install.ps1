# CodeMap installer for Windows (PowerShell 5.1+).
#
#   irm https://raw.githubusercontent.com/zainkhan-bit/codemap/main/scripts/install.ps1 | iex
#
# Installs into %LOCALAPPDATA%\CodeMap\app (override with $env:CODEMAP_HOME) and adds a `codemap`
# command in %LOCALAPPDATA%\CodeMap\bin, which is appended to your *user* PATH (set
# $env:CODEMAP_NO_PATH = "1" to skip). Re-running updates an existing install. No administrator
# rights needed. Uninstall: delete %LOCALAPPDATA%\CodeMap\app and \bin, and remove bin from PATH.
$ErrorActionPreference = "Stop"

$Repo = if ($env:CODEMAP_REPO) { $env:CODEMAP_REPO } else { "https://github.com/zainkhan-bit/codemap.git" }
$Ref = if ($env:CODEMAP_REF) { $env:CODEMAP_REF } else { "main" }
$HomeDir = if ($env:CODEMAP_HOME) { $env:CODEMAP_HOME } else { Join-Path $env:LOCALAPPDATA "CodeMap\app" }
$BinDir = if ($env:CODEMAP_BIN_DIR) { $env:CODEMAP_BIN_DIR } else { Join-Path $env:LOCALAPPDATA "CodeMap\bin" }
$Src = Join-Path $HomeDir "src"
$Pnpm = "pnpm@10.34.9"

function Say($msg) { Write-Host "==> $msg" -ForegroundColor Cyan }
function Fail($msg) { Write-Host "error: $msg" -ForegroundColor Red; throw $msg }
function Run($exe, [string[]]$argv) {
  & $exe @argv
  if ($LASTEXITCODE -ne 0) { throw "$exe $($argv -join ' ') failed with exit code $LASTEXITCODE" }
}

if (-not (Get-Command git -ErrorAction SilentlyContinue)) { Fail "git is required (https://git-scm.com/downloads)" }
if (-not (Get-Command node -ErrorAction SilentlyContinue)) { Fail "Node.js 24 or newer is required (https://nodejs.org)" }
$major = [int](& node -p "process.versions.node.split('.')[0]")
if ($major -lt 24) { Fail "Node.js 24 or newer is required (found $(& node --version))" }

if (Test-Path (Join-Path $Src ".git")) {
  Say "Updating CodeMap in $Src"
  Run git @("-C", $Src, "fetch", "--quiet", "--depth", "1", "origin", $Ref)
  Run git @("-C", $Src, "checkout", "--quiet", "--force", "FETCH_HEAD")
} else {
  Say "Downloading CodeMap into $Src"
  New-Item -ItemType Directory -Force -Path $HomeDir | Out-Null
  Run git @("clone", "--quiet", "--depth", "1", "--branch", $Ref, $Repo, $Src)
}

Push-Location $Src
try {
  Say "Installing dependencies"
  # The prebuilt SQLite binary download is occasionally flaky; without a C++ toolchain a
  # failed download cannot fall back to compiling, so retry.
  $ok = $false
  for ($i = 1; $i -le 3 -and -not $ok; $i++) {
    & npx --yes $Pnpm install --frozen-lockfile --reporter=silent
    if ($LASTEXITCODE -eq 0) { $ok = $true } elseif ($i -lt 3) { Say "Install failed (attempt $i), retrying..."; Start-Sleep -Seconds (5 * $i) }
  }
  if (-not $ok) { Fail "dependency install failed (see output above)" }
  Say "Building"
  & npx --yes $Pnpm build | Out-Null
  if ($LASTEXITCODE -ne 0) { Fail "build failed; run 'npx $Pnpm build' in $Src to see details" }
} finally {
  Pop-Location
}

New-Item -ItemType Directory -Force -Path $BinDir | Out-Null
$cli = Join-Path $Src "apps\cli\dist\index.js"
Set-Content -Path (Join-Path $BinDir "codemap.cmd") -Encoding ascii -Value "@echo off`r`nnode `"$cli`" %*"
Set-Content -Path (Join-Path $BinDir "codemap.ps1") -Encoding ascii -Value "& node `"$cli`" @args`r`nexit `$LASTEXITCODE"

& node $cli doctor | Out-Null
if ($LASTEXITCODE -ne 0) { Fail "installed, but 'codemap doctor' reported a problem; run it to see details" }
Say "Installed CodeMap $(& node $cli --version) -> $BinDir"

if ($env:CODEMAP_NO_PATH -ne "1") {
  $userPath = [Environment]::GetEnvironmentVariable("Path", "User")
  $parts = @($userPath -split ";" | Where-Object { $_ })
  if ($parts -notcontains $BinDir) {
    [Environment]::SetEnvironmentVariable("Path", (($parts + $BinDir) -join ";"), "User")
    Say "Added $BinDir to your user PATH (open a new terminal to use it)"
  }
  if (($env:Path -split ";") -notcontains $BinDir) { $env:Path = "$env:Path;$BinDir" }
}

Write-Host ""
Write-Host "Try it:"
Write-Host "  codemap scan ."
Write-Host "  codemap dashboard"
