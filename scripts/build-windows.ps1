<#
.SYNOPSIS
  Builds KiloNote directly on Windows.

.DESCRIPTION
  Produces in dist-windows\:
    KiloNote_<version>_x64-setup.exe   installer (no administrator rights needed)
    KiloNote.exe                       portable version
    SHA256SUMS.txt                     SHA-256 checksums

  Prerequisites (once):
    winget install OpenJS.NodeJS.LTS
    winget install Rustlang.Rustup
    winget install Microsoft.VisualStudio.2022.BuildTools --override "--wait --passive --add Microsoft.VisualStudio.Workload.VCTools --includeRecommended"

  From WSL or Linux, use scripts/build-windows.sh instead (nothing to install on Windows).

.PARAMETER Install
  Installs or updates KiloNote after building it (see scripts/install-windows.ps1:
  an open KiloNote is not interrupted, the update applies at its next launch).

.EXAMPLE
  powershell -ExecutionPolicy Bypass -File scripts\build-windows.ps1 -Install
#>
param([switch]$Install)

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

if (-not (Test-Path node_modules)) { Say "Installing npm dependencies"; npm ci }

$version = (Get-Content src-tauri\tauri.conf.json -Raw | ConvertFrom-Json).version
Say "Building KiloNote $version for Windows…"
npx tauri build --bundles nsis
if ($LASTEXITCODE -ne 0) { throw "The build failed." }

$release = Join-Path $Root "src-tauri\target\release"
$setup = Get-ChildItem "$release\bundle\nsis\*-setup.exe" | Sort-Object LastWriteTime -Descending | Select-Object -First 1
$exe = @("$release\KiloNote.exe", "$release\kilonote.exe") | Where-Object { Test-Path $_ } | Select-Object -First 1

$out = Join-Path $Root "dist-windows"
Remove-Item $out -Recurse -Force -ErrorAction SilentlyContinue
New-Item -ItemType Directory $out | Out-Null
Copy-Item $setup.FullName $out
if ($exe) { Copy-Item $exe (Join-Path $out "KiloNote.exe") }
# SHA-256 checksums (same format as sha256sum).
Get-ChildItem $out -Filter *.exe | ForEach-Object { "{0}  {1}" -f (Get-FileHash $_.FullName -Algorithm SHA256).Hash.ToLower(), $_.Name } |
  Set-Content (Join-Path $out "SHA256SUMS.txt") -Encoding ascii
Say "Files ready in dist-windows\:"
Get-ChildItem $out | ForEach-Object { "    {0,8:N1} MB  {1}" -f ($_.Length / 1MB), $_.Name }

if ($Install) {
  Say "Updating KiloNote…"
  $result = & (Join-Path $PSScriptRoot "install-windows.ps1") -Setup $setup.FullName -Exe (Join-Path $out "KiloNote.exe") -Version $version | Select-Object -Last 1
  switch ($result) {
    "installed" { Say "KiloNote $version is installed. Start menu > KiloNote, then right-click its taskbar icon > Pin to taskbar." }
    "updated-next-launch" { Say "KiloNote is open: the update applies the next time you open it." }
    default { Say "KiloNote is up to date." }
  }
}
