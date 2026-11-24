# Double-click the newest text-less received bubble, which makes QQ download and play
# the voice clip. Only then does the file appear in the Ptt cache.

[Console]::OutputEncoding = [System.Text.Encoding]::UTF8

Add-Type -AssemblyName UIAutomationClient
Add-Type -AssemblyName UIAutomationTypes
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class DshMouse {
  [DllImport("user32.dll")] public static extern bool SetCursorPos(int x, int y);
  [DllImport("user32.dll")] public static extern void mouse_event(uint flag, uint dx, uint dy, uint data, UIntPtr extra);
  public const uint DOWN = 0x0002;
  public const uint UP = 0x0004;
}
'@

$desktop = [System.Windows.Automation.AutomationElement]::RootElement
$all = $desktop.FindAll(
  [System.Windows.Automation.TreeScope]::Descendants,
  [System.Windows.Automation.Condition]::TrueCondition
)

$messages = @()
foreach ($element in $all) {
  if ($element.Current.ClassName -ne 'message') { continue }
  $messages += $element
}

$target = $null
for ($index = $messages.Count - 1; $index -ge 0; $index--) {
  $message = $messages[$index]
  $kids = $message.FindAll(
    [System.Windows.Automation.TreeScope]::Descendants,
    [System.Windows.Automation.Condition]::TrueCondition
  )
  $self = $false
  $text = ''
  $bubble = $null
  foreach ($kid in $kids) {
    $class = $kid.Current.ClassName
    if ($class -like '*container--self*') { $self = $true }
    if ($class -like '*msg-content-container*') { $bubble = $kid }
    if ($kid.Current.ControlType.ProgrammaticName -eq 'ControlType.Text') {
      $text += $kid.Current.Name
    }
  }
  if ($self) { continue }
  if ($text.Trim() -ne '') { continue }
  if ($bubble -eq $null) { continue }
  $target = $bubble
  break
}

if ($target -eq $null) {
  @{ ok = $false; reason = 'no voice bubble' } | ConvertTo-Json -Compress
  exit 0
}

$rect = $target.Current.BoundingRectangle
$x = [int]($rect.X + $rect.Width / 2)
$y = [int]($rect.Y + $rect.Height / 2)
if ($x -le 0 -or $y -le 0) {
  @{ ok = $false; reason = 'bubble off screen' } | ConvertTo-Json -Compress
  exit 0
}

[void][DshMouse]::SetCursorPos($x, $y)
Start-Sleep -Milliseconds 80
[DshMouse]::mouse_event([DshMouse]::DOWN, 0, 0, 0, [UIntPtr]::Zero)
[DshMouse]::mouse_event([DshMouse]::UP, 0, 0, 0, [UIntPtr]::Zero)
Start-Sleep -Milliseconds 90
[DshMouse]::mouse_event([DshMouse]::DOWN, 0, 0, 0, [UIntPtr]::Zero)
[DshMouse]::mouse_event([DshMouse]::UP, 0, 0, 0, [UIntPtr]::Zero)

@{ ok = $true; x = $x; y = $y } | ConvertTo-Json -Compress
