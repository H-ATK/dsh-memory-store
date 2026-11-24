# Bring the QQ main window back WITHOUT starting a second instance.
#
# QQ runs in the tray with a destroyed main window, so Process.MainWindowHandle is 0
# even though the client is alive. Starting QQ.exe in that state opens a login window
# instead of the running client — that is the bug this file exists to avoid.
# The reliable way back is QQ's own global hotkey (Ctrl+Alt+Z).

param(
  [switch]$Quiet
)

[Console]::OutputEncoding = [System.Text.Encoding]::UTF8

Add-Type -AssemblyName System.Windows.Forms
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class DshWindow2 {
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr hWnd, int cmd);
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern bool IsIconic(IntPtr hWnd);
}
'@

function Emit($obj) { $obj | ConvertTo-Json -Compress; exit 0 }

$processes = @(Get-Process QQ -ErrorAction SilentlyContinue)
if ($processes.Count -eq 0) {
  # Truly not running: only then may a new client be started.
  if (Test-Path 'C:\Program Files\Tencent\QQNT\QQ.exe') {
    Start-Process -FilePath 'C:\Program Files\Tencent\QQNT\QQ.exe' -ArgumentList '--force-renderer-accessibility'
    Start-Sleep -Seconds 8
    $processes = @(Get-Process QQ -ErrorAction SilentlyContinue)
  }
  if ($processes.Count -eq 0) { Emit @{ ok = $false; reason = 'not-running' } }
}

# An existing process without a window is minimised to the tray, not closed.
$withWindow = $processes | Where-Object { $_.MainWindowHandle -ne 0 } | Select-Object -First 1
if ($null -eq $withWindow) {
  # Ask QQ itself to show its window. This never touches the login state.
  [System.Windows.Forms.SendKeys]::SendWait('^%z')
  Start-Sleep -Seconds 2
  $processes = @(Get-Process QQ -ErrorAction SilentlyContinue)
  $withWindow = $processes | Where-Object { $_.MainWindowHandle -ne 0 } | Select-Object -First 1
}

if ($null -eq $withWindow) {
  Emit @{ ok = $false; reason = 'window-not-recoverable' }
}

$handle = $withWindow.MainWindowHandle
$wasVisible = [DshWindow2]::IsWindowVisible($handle)
$wasMinimised = [DshWindow2]::IsIconic($handle)

# Already on screen: do not touch it. Restoring and re-focusing every poll stole focus
# from the user, which looked like the window popping up on its own.
if ($wasVisible -and -not $wasMinimised) {
  Emit @{
    ok = $true
    pid = $withWindow.Id
    wasMinimised = $false
    visible = $true
    touched = $false
  }
}

[void][DshWindow2]::ShowWindow($handle, 4)   # SW_SHOWNOACTIVATE: show, but do not steal focus
Start-Sleep -Milliseconds 600

Emit @{
  ok = $true
  pid = $withWindow.Id
  wasMinimised = $wasMinimised
  visible = [DshWindow2]::IsWindowVisible($handle)
  touched = $true
}
