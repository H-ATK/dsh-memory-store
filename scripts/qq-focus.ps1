# Open the conversation with one contact: nickname first, QQ number second.
#
# Layer 1: click the matching item in the recent-contact list (cheap, no search UI).
# Layer 2: type the QQ number into the search box and click the person result
#          (whose name starts with "(<qq-number>)"); groups only "contain" it.

param(
  [string]$Nickname = '',
  [string]$Uin = ''
)

[Console]::OutputEncoding = [System.Text.Encoding]::UTF8

Add-Type -AssemblyName UIAutomationClient
Add-Type -AssemblyName UIAutomationTypes
Add-Type -AssemblyName System.Windows.Forms

Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class DshFocus {
  [DllImport("user32.dll")] public static extern bool SetCursorPos(int x, int y);
  [DllImport("user32.dll")] public static extern void mouse_event(uint f, uint dx, uint dy, uint d, UIntPtr e);
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h);
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr h, int c);
  public static void Click(int x, int y) {
    SetCursorPos(x, y); System.Threading.Thread.Sleep(90);
    mouse_event(0x0002, 0, 0, 0, UIntPtr.Zero); System.Threading.Thread.Sleep(50);
    mouse_event(0x0004, 0, 0, 0, UIntPtr.Zero);
  }
}
'@

function Emit($obj) { $obj | ConvertTo-Json -Compress; exit 0 }

$window = Get-Process QQ -ErrorAction SilentlyContinue | Where-Object { $_.MainWindowHandle -ne 0 } | Select-Object -First 1
if (-not $window) { Emit @{ ok = $false; reason = 'not-running' } }
[void][DshFocus]::ShowWindow($window.MainWindowHandle, 9)
[void][DshFocus]::SetForegroundWindow($window.MainWindowHandle)
Start-Sleep -Milliseconds 300

$root = [System.Windows.Automation.AutomationElement]::FromHandle($window.MainWindowHandle)
# A search panel may still be open from a previous pass; Esc returns to the normal UI.
[System.Windows.Forms.SendKeys]::SendWait('{ESC}')
Start-Sleep -Milliseconds 300
$all = $root.FindAll([System.Windows.Automation.TreeScope]::Descendants, [System.Windows.Automation.Condition]::TrueCondition)

function ClickElement($element) {
  $rect = $element.Current.BoundingRectangle
  if ($rect.Width -le 0 -or $rect.Height -le 0) { return $false }
  [DshFocus]::Click([int]($rect.X + $rect.Width / 2), [int]($rect.Y + $rect.Height / 2))
  return $true
}

# ---- Layer 1: nickname in the recent-contact list -------------------------
if ($Nickname -ne '') {
  foreach ($element in $all) {
    $class = $element.Current.ClassName
    if ($class -notlike 'recent-contact-item*') { continue }
    $name = $element.Current.Name
    if ($name -eq '') {
      $inner = $element.FindAll([System.Windows.Automation.TreeScope]::Descendants, [System.Windows.Automation.Condition]::TrueCondition)
      foreach ($node in $inner) {
        if ($node.Current.ControlType.ProgrammaticName -eq 'ControlType.Text' -and $node.Current.Name -ne '') { $name = $node.Current.Name; break }
      }
    }
    if ($name -like "*$Nickname*") {
      if (ClickElement $element) {
        Start-Sleep -Milliseconds 700
        Emit @{ ok = $true; mode = 'nickname'; contact = $name }
      }
    }
  }
}

# ---- Layer 2: search the QQ number ---------------------------------------
if ($Uin -ne '') {
  $search = $null
  foreach ($element in $all) {
    # Take the first Edit: once a query is typed its Name becomes the query, not 搜索.
    if ($element.Current.ControlType.ProgrammaticName -eq 'ControlType.Edit') { $search = $element; break }
  }
  if ($null -eq $search) { Emit @{ ok = $false; reason = 'no-search-box' } }
  if (-not (ClickElement $search)) { Emit @{ ok = $false; reason = 'search-box-unclickable' } }
  Start-Sleep -Milliseconds 220
  [System.Windows.Forms.SendKeys]::SendWait('^a')
  Start-Sleep -Milliseconds 120
  [System.Windows.Forms.SendKeys]::SendWait($Uin)
  Start-Sleep -Milliseconds 1400

  $after = $root.FindAll([System.Windows.Automation.TreeScope]::Descendants, [System.Windows.Automation.Condition]::TrueCondition)
  foreach ($element in $after) {
    $class = $element.Current.ClassName
    # QQ renders the person row either as search-result-item or as its parent
    # search-result-list; match both and require the number in parentheses.
    if ($class -notlike '*search-result*') { continue }
    $name = $element.Current.Name
    if ($name -notmatch [regex]::Escape("($Uin)")) { continue }
    if (ClickElement $element) {
      Start-Sleep -Milliseconds 700
      Emit @{ ok = $true; mode = 'search'; contact = $name }
    }
  }
}

Emit @{ ok = $false; reason = 'contact-not-found' }
