# Read the open QQ chat through UI Automation.
# Prints JSON: { ok, count, messages: [{ time, who, text }] } oldest first.
#
# Element conditions built with PropertyCondition proved unreliable in PowerShell 5.1,
# so everything is filtered by ClassName after one full Descendants walk.

param(
  [int]$Limit = 20
)

# JSON with Chinese characters must reach Node as UTF-8, not the console code page.
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8

Add-Type -AssemblyName UIAutomationClient
Add-Type -AssemblyName UIAutomationTypes

$window = Get-Process QQ -ErrorAction SilentlyContinue | Where-Object { $_.MainWindowHandle -ne 0 } | Select-Object -First 1
if (-not $window) {
  '{"ok":false,"error":"no qq window"}'
  exit 0
}

$root = [System.Windows.Automation.AutomationElement]::FromHandle($window.MainWindowHandle)
$all = $root.FindAll([System.Windows.Automation.TreeScope]::Descendants, [System.Windows.Automation.Condition]::TrueCondition)

$messages = @()
$contact = ''
foreach ($element in $all) {
  if ($element.Current.ClassName -like 'chat-header__contact-name*') {
    $contact = $element.Current.Name
    continue
  }
  if ($element.Current.ClassName -ne 'message') { continue }
  $inner = $element.FindAll([System.Windows.Automation.TreeScope]::Descendants, [System.Windows.Automation.Condition]::TrueCondition)

  $time = ''
  $who = 'other'
  $parts = @()
  $inBubble = $false
  $bubbleWidth = 0
  foreach ($node in $inner) {
    $class = $node.Current.ClassName
    if ($class -like 'message__timestamp*') {
      $time = $node.Current.Name
      if ($time -eq '') {
        $stamps = $node.FindAll([System.Windows.Automation.TreeScope]::Descendants, [System.Windows.Automation.Condition]::TrueCondition)
        foreach ($stamp in $stamps) {
          if ($stamp.Current.ControlType.ProgrammaticName -eq 'ControlType.Text' -and $stamp.Current.Name -ne '') {
            $time = $stamp.Current.Name
            break
          }
        }
      }
      continue
    }
    if ($class -like 'msg-content-container*') {
      $inBubble = $true
      $bubbleWidth = [int]$node.Current.BoundingRectangle.Width
      if ($class -like '*container--self*') { $who = 'self' }
      continue
    }
    if ($inBubble -and $node.Current.ControlType.ProgrammaticName -eq 'ControlType.Text') {
      $parts += $node.Current.Name
    }
  }
  $text = ($parts -join '').Trim()
  # Empty bubbles are ambiguous: voice and images both render as a bare box. Mark a
  # wide one as media and let the bridge work out which cache file it came from.
  if ($text -eq '' -and $bubbleWidth -ge 60) { $text = '[附件]' }
  if ($text -eq '' -and $bubbleWidth -lt 60) { $text = '[空消息]' }
  if ($text -eq '' -and $time -eq '') { continue }
  $messages += [pscustomobject]@{ time = $time; who = $who; text = $text }
}

$count = $messages.Count
$tail = if ($count -gt $Limit) { $messages[($count - $Limit)..($count - 1)] } else { $messages }
$payload = @{ ok = $true; count = $count; contact = ($contact -replace '\s+', ' ').Trim(); messages = @($tail) }
$payload | ConvertTo-Json -Depth 5 -Compress

