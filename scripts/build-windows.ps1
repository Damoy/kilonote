<#
.SYNOPSIS
  Builds KiloNote directly on Windows.

.DESCRIPTION
  Produces in dist-windows\ (copied to %USERPROFILE%\dev-builds\kilonote\ too):
    KiloNote_<version>_x64-setup.exe   installer (no administrator rights needed)
    KiloNote.exe                       portable version
    SHA256SUMS.txt                     SHA-256 checksums

  Prerequisites (once):
    winget install OpenJS.NodeJS.LTS
    winget install Rustlang.Rustup
    winget install Microsoft.VisualStudio.2022.BuildTools --override "--wait --passive --add Microsoft.VisualStudio.Workload.VCTools --includeRecommended"

  From WSL or Linux, use scripts/build-windows.sh instead (nothing to install on Windows).

.PARAMETER Portable
  Builds only KiloNote.exe (the portable version), without the installer: nothing
  else is downloaded or run during the build (no installer tooling).

.PARAMETER Install
  Updates the installed KiloNote after building it, with plain file copies: an open
  KiloNote keeps running and the new build starts the next time it is opened.
  Nothing is launched; a first install is done by running the installer yourself.

.EXAMPLE
  .\scripts\build-windows.ps1 -Install
#>
param([switch]$Install, [switch]$Portable)

$ErrorActionPreference = "Stop"
Set-Location (Join-Path $PSScriptRoot "..")
$Root = Get-Location

function Say($msg) { Write-Host "> $msg" -ForegroundColor Magenta }
function Need($cmd, $hint) {
  if (-not (Get-Command $cmd -ErrorAction SilentlyContinue)) { throw "$cmd not found. $hint" }
}

Need node "Install Node.js: winget install OpenJS.NodeJS.LTS"
Need cargo "Install Rust: winget install Rustlang.Rustup (then reopen the terminal)"
$vswhere = "${env:ProgramFiles(x86)}\Microsoft Visual Studio\Installer\vswhere.exe"
if (-not (Test-Path $vswhere) -or -not (& $vswhere -latest -products * -requires Microsoft.VisualStudio.Component.VC.Tools.x86.x64 -property installationPath)) {
  throw "Visual Studio C++ build tools not found. See: Get-Help scripts\build-windows.ps1"
}

# --ignore-scripts: no package runs code while it is installed (none needs to).
if (-not (Test-Path node_modules)) { Say "Installing npm dependencies"; npm ci --ignore-scripts }

$version = (Get-Content src-tauri\tauri.conf.json -Raw | ConvertFrom-Json).version
Say "Building KiloNote $version for Windows…"
if ($Portable) { npx tauri build --no-bundle } else { npx tauri build --bundles nsis }
if ($LASTEXITCODE -ne 0) { throw "The build failed." }

$release = Join-Path $Root "src-tauri\target\release"
$setup = if ($Portable) { $null } else { Get-ChildItem "$release\bundle\nsis\*-setup.exe" | Sort-Object LastWriteTime -Descending | Select-Object -First 1 }
$exe = @("$release\KiloNote.exe", "$release\kilonote.exe") | Where-Object { Test-Path $_ } | Select-Object -First 1

$out = Join-Path $Root "dist-windows"
Remove-Item $out -Recurse -Force -ErrorAction SilentlyContinue
New-Item -ItemType Directory $out | Out-Null
if ($setup) { Copy-Item $setup.FullName $out }
if ($exe) { Copy-Item $exe (Join-Path $out "KiloNote.exe") }
# SHA-256 checksums (same format as sha256sum).
Get-ChildItem $out -Filter *.exe | ForEach-Object { "{0}  {1}" -f (Get-FileHash $_.FullName -Algorithm SHA256).Hash.ToLower(), $_.Name } |
  Set-Content (Join-Path $out "SHA256SUMS.txt") -Encoding ascii
Say "Files ready in dist-windows\:"
Get-ChildItem $out | ForEach-Object { "    {0,8:N1} MB  {1}" -f ($_.Length / 1MB), $_.Name }

$builds = Join-Path $env:USERPROFILE "dev-builds\kilonote"
New-Item -ItemType Directory $builds -Force | Out-Null
Copy-Item (Join-Path $out "*") $builds -Force
Say "Copied to $builds"

if ($Install) {
  $appDir = Join-Path $env:LOCALAPPDATA "KiloNote"
  $target = Join-Path $appDir "kilonote.exe"
  if (-not (Test-Path $target)) {
    Say "KiloNote is not installed yet: run the installer yourself, or use the portable KiloNote.exe in $builds"
    return
  }
  # Executables left by previous updates (one still in use stays until next time).
  Get-ChildItem $appDir -Filter "kilonote.*.old" | Remove-Item -ErrorAction SilentlyContinue
  # A running exe can be renamed, not overwritten: rename, then copy.
  Rename-Item $target ("kilonote.{0:yyyyMMdd-HHmmss}.old" -f (Get-Date))
  Copy-Item (Join-Path $out "KiloNote.exe") $target
  Say "KiloNote is updated: the new build starts the next time you open it."
}
