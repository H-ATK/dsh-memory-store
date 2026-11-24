# Hide the QQ window again after a read, so a tray check does not leave a window open.

[Console]::OutputEncoding = [System.Text.Encoding]::UTF8

Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class DshHideWin {
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr hWnd, int cmd);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr hWnd);
}
'@

$window = Get-Process QQ -ErrorAction SilentlyContinue | Where-Object { $_.MainWindowHandle -ne 0 } | Select-Object -First 1
if (-not $window) {
  @{ ok = $true; hidden = $false; reason = 'no-window' } | ConvertTo-Json -Compress
  exit 0
}

$handle = $window.MainWindowHandle
[void][DshHideWin]::ShowWindow($handle, 0)   # SW_HIDE
Start-Sleep -Milliseconds 150
@{ ok = $true; hidden = -not [DshHideWin]::IsWindowVisible($handle) } | ConvertTo-Json -Compress
