# Send one text message through the open QQ chat.
#
# The composer is a ProseMirror contenteditable, not an Edit element, so UIA cannot
# write into it: the text goes in through the clipboard, then the real send button is
# invoked (Enter would also work, but the button is what the UI actually exposes).

param(
  [Parameter(Mandatory = $true)][string]$Text
)
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8


Add-Type -AssemblyName UIAutomationClient
Add-Type -AssemblyName UIAutomationTypes
Add-Type -AssemblyName System.Windows.Forms

Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class DshMouse {
  [DllImport("user32.dll")] public static extern bool SetCursorPos(int x, int y);
  [DllImport("user32.dll")] public static extern void mouse_event(uint flags, uint dx, uint dy, uint data, UIntPtr extra);
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr hWnd, int cmd);
  public static void Click(int x, int y) {
    SetCursorPos(x, y);
    System.Threading.Thread.Sleep(80);
    mouse_event(0x0002, 0, 0, 0, UIntPtr.Zero);
    System.Threading.Thread.Sleep(40);
    mouse_event(0x0004, 0, 0, 0, UIntPtr.Zero);
  }
}
'@

$window = Get-Process QQ -ErrorAction SilentlyContinue | Where-Object { $_.MainWindowHandle -ne 0 } | Select-Object -First 1
if (-not $window) {
  '{"ok":false,"error":"no qq window"}'
  exit 0
}

[void][DshMouse]::ShowWindow($window.MainWindowHandle, 9)   # SW_RESTORE
[void][DshMouse]::SetForegroundWindow($window.MainWindowHandle)
Start-Sleep -Milliseconds 400

$root = [System.Windows.Automation.AutomationElement]::FromHandle($window.MainWindowHandle)
$all = $root.FindAll([System.Windows.Automation.TreeScope]::Descendants, [System.Windows.Automation.Condition]::TrueCondition)

$editorRect = $null
$sendButton = $null
foreach ($element in $all) {
  $class = $element.Current.ClassName
  if ($null -eq $editorRect -and $class -like '*ExEditor-qq-msg-editor*') {
    $editorRect = $element.Current.BoundingRectangle
  }
  if ($null -eq $sendButton -and $class -like 'send-msg*') {
    $sendButton = $element
  }
}

if ($null -eq $editorRect) {
  '{"ok":false,"error":"composer not found"}'
  exit 0
}

$cx = [int]($editorRect.X + $editorRect.Width / 2)
$cy = [int]($editorRect.Y + $editorRect.Height / 2)
[DshMouse]::Click($cx, $cy)
Start-Sleep -Milliseconds 300

Set-Clipboard -Value $Text
Start-Sleep -Milliseconds 150
[System.Windows.Forms.SendKeys]::SendWait('^v')
Start-Sleep -Milliseconds 500

$sent = $false
if ($null -ne $sendButton) {
  try {
    $pattern = $sendButton.GetCurrentPattern([System.Windows.Automation.InvokePattern]::Pattern)
    $pattern.Invoke()
    $sent = $true
  } catch {
    [System.Windows.Forms.SendKeys]::SendWait('{ENTER}')
    $sent = $true
  }
} else {
  [System.Windows.Forms.SendKeys]::SendWait('{ENTER}')
  $sent = $true
}

$payload = @{ ok = $true; sent = $sent; text = $Text }
$payload | ConvertTo-Json -Compress


