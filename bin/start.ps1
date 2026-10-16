$ErrorActionPreference = "Stop"
$app = Split-Path -Parent $PSScriptRoot
$script = Join-Path $app "bin\start-server.js"
$logFile = Join-Path $app "server.log"
$pids = @()
$existing = 0
try { $existing = (Get-NetTCPConnection -LocalPort 3000 -State Listen | Select-Object -First 1 -ExpandProperty OwningProcess) } catch {}
if ($existing) {
  Get-Process -Id $existing -ErrorAction SilentlyContinue | Stop-Process -Force -ErrorAction SilentlyContinue
  Start-Sleep -Seconds 1
}
Remove-Item -Path $logFile -Force -ErrorAction SilentlyContinue
$proc = Start-Process -FilePath "node" -ArgumentList $script -WorkingDirectory $app -NoNewWindow -PassThru
Start-Sleep -Seconds 6
if ($proc.HasExited) {
  Write-Error "server exited early with code $($proc.ExitCode)"
  if (Test-Path $logFile) { Get-Content $logFile }
  exit 1
}
Write-Output "PID=$($proc.Id)"
if (Test-Path $logFile) { Get-Content $logFile }
else { Write-Output "no log yet" }
