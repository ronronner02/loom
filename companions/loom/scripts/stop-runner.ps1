param([Parameter(Mandatory = $true)][string]$ConfigPath)
$ErrorActionPreference = 'Stop'
$ConfigPath = (Resolve-Path -LiteralPath $ConfigPath).Path
$config = Get-Content -LiteralPath $ConfigPath -Raw | ConvertFrom-Json
$lock = Join-Path $config.stateDir 'runner.lock'
if (-not (Test-Path -LiteralPath $lock)) { Write-Output 'No runner lock is present.'; return }
$runnerPid = [int](Get-Content -LiteralPath $lock -Raw)
$process = Get-CimInstance Win32_Process -Filter "ProcessId=$runnerPid"
if (-not $process) { Write-Output 'The recorded runner process has already stopped.'; return }
$entry = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..\dist\runner.js'))
if ($process.ExecutablePath -ine $config.command -or
    $process.CommandLine -notmatch [regex]::Escape($entry) -or
    $process.CommandLine -notmatch [regex]::Escape($ConfigPath)) {
    throw 'The recorded PID no longer matches this runner. No process was stopped.'
}
& taskkill.exe /PID $runnerPid /T /F
if ($LASTEXITCODE -ne 0) { throw 'The runner process-tree stop did not complete.' }
Write-Output 'The runner and its local child processes were stopped. Interrupted work is not replayed on restart.'
