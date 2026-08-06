# Shell integration for Windows PowerShell and PowerShell 7, passed as
# -EncodedCommand (UTF-16LE, base64).
# OSC 7 = current directory, OSC 133 = busy/idle state
# (133;C = command started, 133;A/D = prompt visible, waiting for input)

function Global:prompt {
  $p = $ExecutionContext.SessionState.Path.CurrentLocation.ProviderPath
  $e = [char]27
  $b = [char]7
  Write-Host -NoNewline ($e + ']133;D' + $b + $e + ']133;A' + $b + $e + ']7;file://localhost/' + ($p -replace '\\','/') + $b)
  "PS $p> "
}
try {
  Import-Module PSReadLine -ErrorAction Stop
  function Global:PSConsoleHostReadLine {
    $l = [Microsoft.PowerShell.PSConsoleReadLine]::ReadLine($Host.Runspace, $ExecutionContext)
    if ($l) {
      $b64 = [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($l))
      [Console]::Write([string][char]27 + ']7770;cmd;' + $b64 + [string][char]7)
    }
    [Console]::Write([string][char]27 + ']133;C' + [string][char]7)
    $l
  }
} catch { }
