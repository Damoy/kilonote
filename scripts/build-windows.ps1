<#
.SYNOPSIS
  Construit KiloNote directement sous Windows.

.DESCRIPTION
  Produit dans dist-windows\ :
    KiloNote_<version>_x64-setup.exe   installeur (sans droits administrateur)
    KiloNote.exe                       version portable

  Prérequis (une seule fois) :
    winget install OpenJS.NodeJS.LTS
    winget install Rustlang.Rustup
    winget install Microsoft.VisualStudio.2022.BuildTools --override "--wait --passive --add Microsoft.VisualStudio.Workload.VCTools --includeRecommended"

  Depuis WSL ou Linux, utilisez plutôt scripts/build-windows.sh (aucun outil à installer sous Windows).

.PARAMETER Install
  Installe ou met à jour KiloNote après la compilation.

.EXAMPLE
  powershell -ExecutionPolicy Bypass -File scripts\build-windows.ps1 -Install
#>
param([switch]$Install)

$ErrorActionPreference = "Stop"
Set-Location (Join-Path $PSScriptRoot "..")
$Root = Get-Location

function Say($msg) { Write-Host "> $msg" -ForegroundColor Magenta }
function Need($cmd, $hint) {
  if (-not (Get-Command $cmd -ErrorAction SilentlyContinue)) { throw "$cmd introuvable. $hint" }
}

Need node "Installez Node.js : winget install OpenJS.NodeJS.LTS"
Need cargo "Installez Rust : winget install Rustlang.Rustup (puis rouvrez le terminal)"
$vswhere = "${env:ProgramFiles(x86)}\Microsoft Visual Studio\Installer\vswhere.exe"
if (-not (Test-Path $vswhere) -or -not (& $vswhere -latest -products * -requires Microsoft.VisualStudio.Component.VC.Tools.x86.x64 -property installationPath)) {
  throw "Outils C++ de Visual Studio introuvables. Voir l'aide : Get-Help scripts\build-windows.ps1"
}

if (-not (Test-Path node_modules)) { Say "Installation des dépendances npm"; npm ci }

$version = (Get-Content src-tauri\tauri.conf.json -Raw | ConvertFrom-Json).version
Say "Compilation de KiloNote $version pour Windows…"
npx tauri build --bundles nsis
if ($LASTEXITCODE -ne 0) { throw "La compilation a échoué." }

$release = Join-Path $Root "src-tauri\target\release"
$setup = Get-ChildItem "$release\bundle\nsis\*-setup.exe" | Sort-Object LastWriteTime -Descending | Select-Object -First 1
$exe = @("$release\KiloNote.exe", "$release\kilonote.exe") | Where-Object { Test-Path $_ } | Select-Object -First 1

$out = Join-Path $Root "dist-windows"
Remove-Item $out -Recurse -Force -ErrorAction SilentlyContinue
New-Item -ItemType Directory $out | Out-Null
Copy-Item $setup.FullName $out
if ($exe) { Copy-Item $exe (Join-Path $out "KiloNote.exe") }
# Empreintes SHA-256 (même format que sha256sum).
Get-ChildItem $out -Filter *.exe | ForEach-Object { "{0}  {1}" -f (Get-FileHash $_.FullName -Algorithm SHA256).Hash.ToLower(), $_.Name } |
  Set-Content (Join-Path $out "SHA256SUMS.txt") -Encoding ascii
Say "Fichiers prêts dans dist-windows\ :"
Get-ChildItem $out | ForEach-Object { "    {0,8:N1} Mo  {1}" -f ($_.Length / 1MB), $_.Name }

if ($Install) {
  Say "Installation…"
  Get-Process KiloNote, kilonote -ErrorAction SilentlyContinue | ForEach-Object { $_.CloseMainWindow() | Out-Null }
  Start-Sleep -Milliseconds 800
  Start-Process -Wait -FilePath $setup.FullName -ArgumentList "/S"
  Say "KiloNote est installé. Menu Démarrer > KiloNote, puis clic droit sur l'icône de la barre des tâches > Épingler."
}
