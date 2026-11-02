<#
.SYNOPSIS
  Installs or updates KiloNote for the current user, without interrupting a running instance when possible.

.DESCRIPTION
  - First install, or a different version: closes KiloNote properly (it saves its session),
    then runs the NSIS installer silently (no administrator rights needed).
  - Same version already installed: swaps kilonote.exe in place. Windows lets a running
    executable be renamed, so an open KiloNote keeps working and the new build starts the
    next time KiloNote is opened (for example from its pinned taskbar icon).

  Used by scripts/build-windows.sh --install and scripts/build-windows.ps1 -Install.
#>
param(
  [Parameter(Mandatory)] [string]$Setup,
  [Parameter(Mandatory)] [string]$Exe,
  [Parameter(Mandatory)] [string]$Version
)

$ErrorActionPreference = "Stop"
$dir = Join-Path $env:LOCALAPPDATA "KiloNote"
$target = Join-Path $dir "kilonote.exe"
$installed = (Get-ItemProperty "HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall\KiloNote" -ErrorAction SilentlyContinue).DisplayVersion

function Close-KiloNote {
  # WM_CLOSE to every visible KiloNote window, like the × button: the session is saved.
  Add-Type @"
using System; using System.Runtime.InteropServices;
public static class KiloNoteWindows {
  delegate bool EnumProc(IntPtr h, IntPtr p);
  [DllImport("user32.dll")] static extern bool EnumWindows(EnumProc cb, IntPtr p);
  [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
  [DllImport("user32.dll")] static extern bool IsWindowVisible(IntPtr h);
  [DllImport("user32.dll")] static extern bool PostMessage(IntPtr h, uint msg, IntPtr w, IntPtr l);
  public static void Close(uint pid) {
    EnumWindows((h, p) => {
      uint owner; GetWindowThreadProcessId(h, out owner);
      if (owner == pid && IsWindowVisible(h)) PostMessage(h, 0x0010, IntPtr.Zero, IntPtr.Zero);
      return true;
    }, IntPtr.Zero);
  }
}
"@
  $procs = @(Get-Process kilonote -ErrorAction SilentlyContinue)
  foreach ($p in $procs) { [KiloNoteWindows]::Close([uint32]$p.Id) }
  foreach ($p in $procs) { if (-not $p.WaitForExit(10000)) { $p.Kill() } }
}

# Executables left behind by previous in-place updates.
Get-ChildItem $dir -Filter "kilonote.*.old" -ErrorAction SilentlyContinue | Remove-Item -ErrorAction SilentlyContinue

if (-not (Test-Path $target) -or $installed -ne $Version) {
  Close-KiloNote
  Start-Process -Wait -FilePath $Setup -ArgumentList "/S"
  "installed"
} else {
  $running = @(Get-Process kilonote -ErrorAction SilentlyContinue | Where-Object { $_.Path -eq $target })
  if ($running.Count) { Rename-Item $target ("kilonote.{0:yyyyMMdd-HHmmss}.old" -f (Get-Date)) }
  Copy-Item $Exe $target -Force
  if ($running.Count) { "updated-next-launch" } else { "updated" }
}
