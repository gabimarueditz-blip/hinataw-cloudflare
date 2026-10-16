param([string]$page,[string]$log)
$home = "${PSScriptRoot}"
$cwd = if ($page) { Join-Path $home $page } else { $home }
$logFile = if ($log) { Join-Path $home $log } else { Join-Path $cwd "server.log" }
$cached = @{}
$pids = @()
Get-ChildItem -Path $home -Recurse -Include "server.log" -ErrorAction SilentlyContinue | ForEach-Object {
  $line = $_.FullName
  if ($cached.ContainsKey($line)) { return }
  $cached[$line] = $true
  try { $id = (Get-NetTCPConnection -LocalPort 3000 -State Listen | Select-Object -First 1 -ExpandProperty OwningProcess) } catch { return }
  if (-not $id) { return }
  Get-Process -Id $id -ErrorAction SilentlyContinue | ForEach-Object {
    $pids += $_.Id
    $_ | Stop-Process -Force -ErrorAction SilentlyContinue
  }
}
Start-Sleep -Seconds 2
$env:TERM_CWD = $cwd
$proc = Start-Process -FilePath "node" -ArgumentList "bin\start-server.js" -WorkingDirectory $cwd -NoNewWindow -PassThru -RedirectStandardOutput $null -RedirectStandardError $null
Start-Sleep -Seconds 6
if ($proc.HasExited) {
  Write-Error "server exited early with code $($proc.ExitCode)"
  exit 1
}
Write-Output "PID=$($proc.Id)"
Get-Content $logFile -Tail 6
