# Shell integration for Windows PowerShell and PowerShell 7, passed as
# -EncodedCommand (UTF-16LE, base64).
# OSC 7 = current directory, OSC 133 = busy/idle state
# (133;C = command started, 133;A/D = prompt visible, waiting for input)
#
# The encoded command runs after the profile, so `prompt` and
# PSConsoleHostReadLine already carry whatever the user installed there
# (oh-my-posh, starship, a custom key handler). Both are kept and called; the
# installation guard keeps a second run from chaining our own function onto
# itself, which would recurse without end.

if (-not (Test-Path Variable:Global:__flightdeckInstalled)) {
  $Global:__flightdeckInstalled = $true
  $Global:__flightdeckPrevPrompt = $null
  $Global:__flightdeckPrevReadLine = $null
  $__flightdeckCmd = Get-Command prompt -CommandType Function -ErrorAction SilentlyContinue
  if ($__flightdeckCmd) { $Global:__flightdeckPrevPrompt = $__flightdeckCmd.ScriptBlock }
  function Global:prompt {
    $p = $ExecutionContext.SessionState.Path.CurrentLocation.ProviderPath
    $e = [char]27
    $b = [char]7
    Write-Host -NoNewline ($e + ']133;D' + $b + $e + ']133;A' + $b + $e + ']7;file://localhost/' + ($p -replace '\\','/') + $b)
    if ($Global:__flightdeckPrevPrompt) { & $Global:__flightdeckPrevPrompt } else { "PS $p> " }
  }
  try {
    Import-Module PSReadLine -ErrorAction Stop
    $__flightdeckCmd = Get-Command PSConsoleHostReadLine -CommandType Function -ErrorAction SilentlyContinue
    if ($__flightdeckCmd) { $Global:__flightdeckPrevReadLine = $__flightdeckCmd.ScriptBlock }
    function Global:PSConsoleHostReadLine {
      if ($Global:__flightdeckPrevReadLine) { $l = & $Global:__flightdeckPrevReadLine }
      else { $l = [Microsoft.PowerShell.PSConsoleReadLine]::ReadLine($Host.Runspace, $ExecutionContext) }
      if ($l) {
        $b64 = [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($l))
        [Console]::Write([string][char]27 + ']7770;cmd;' + $b64 + [string][char]7)
      }
      [Console]::Write([string][char]27 + ']133;C' + [string][char]7)
      $l
    }
  } catch { }
}
