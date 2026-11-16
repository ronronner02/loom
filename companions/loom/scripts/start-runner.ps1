param([Parameter(Mandatory = $true)][string]$ConfigPath)
$ErrorActionPreference = 'Stop'
$ConfigPath = (Resolve-Path -LiteralPath $ConfigPath).Path
$config = Get-Content -LiteralPath $ConfigPath -Raw | ConvertFrom-Json
$entry = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..\dist\runner.js'))
$lock = Join-Path $config.stateDir 'runner.lock'
if (Test-Path -LiteralPath $lock) {
    $runnerPid = [int](Get-Content -LiteralPath $lock -Raw)
    if (Get-Process -Id $runnerPid -ErrorAction SilentlyContinue) {
        throw 'A process still owns the runner lock. Inspect it before starting another runner.'
    }
}
New-Item -ItemType Directory -Path $config.stateDir -Force | Out-Null
$process = Start-Process -FilePath $config.command -ArgumentList @(('"{0}"' -f $entry), ('"{0}"' -f $ConfigPath)) `
    -WorkingDirectory (Split-Path -Parent $entry) -WindowStyle Hidden -PassThru `
    -RedirectStandardOutput (Join-Path $config.stateDir 'stdout.log') `
    -RedirectStandardError (Join-Path $config.stateDir 'stderr.log')
Start-Sleep -Seconds 2
$process.Refresh()
if ($process.HasExited) { throw 'The runner exited. Check its private stderr.log for diagnostics.' }
Write-Output ('Runner process started: {0}. Check the dashboard for its connection state.' -f $process.Id)
