#Requires -Version 7.3
[CmdletBinding()]
param(
    [Parameter(Mandatory)][string]$TlsCert,
    [string]$Origin = 'https://192.168.19.118:8797',
    [switch]$Plan
)
$ErrorActionPreference = 'Stop'
$local = [Environment]::GetFolderPath('LocalApplicationData')
$identity = [Security.Principal.WindowsIdentity]::GetCurrent().Name
$exe = Join-Path $local 'Programs\mixdog-personal\Mixdog Personal.exe'
if ((Get-Item -LiteralPath $exe).VersionInfo.ProductName -ne 'Mixdog Personal') {
    throw 'The startup target is not Mixdog Personal.'
}
if (-not [IO.Path]::IsPathFullyQualified($TlsCert)) { throw 'An absolute public TLS certificate path is required.' }
$certificate = (Get-Item -LiteralPath $TlsCert).FullName
$node = 'C:\Program Files\nodejs\node.exe'
$launcher = Join-Path $PSScriptRoot 'softon-hub-autostart.vbs'
$entry = Join-Path $PSScriptRoot 'softon-hub-autostart.mjs'
$hostExe = Join-Path ([Environment]::GetFolderPath('System')) 'wscript.exe'
$arguments = '//B //NoLogo "{0}" "{1}" "{2}" "{3}" "{4}"' -f $launcher, $node, $entry, $Origin, $certificate
$name = 'SOFTON-SessionHub'
$description = [ordered]@{
    task = $name; user = $identity; trigger = 'AtLogOn'; executable = $hostExe
    arguments = $arguments; hidden = $true; logonType = 'Interactive'; runLevel = 'Limited'
    healthCheckMinutes = 5; retryCount = 3; retryMinutes = 1
    statusFile = Join-Path $local 'SOFTON\session-hub\startup.json'
    logFile = Join-Path $local 'SOFTON\session-hub\startup.jsonl'
}
if ($Plan) { $description | ConvertTo-Json; return }
$action = New-ScheduledTaskAction -Execute $hostExe -Argument $arguments -WorkingDirectory $PSScriptRoot
$trigger = New-ScheduledTaskTrigger -AtLogOn -User $identity
$healthCheck = New-ScheduledTaskTrigger -Once -At (Get-Date).AddMinutes(5) `
    -RepetitionInterval (New-TimeSpan -Minutes 5)
$principal = New-ScheduledTaskPrincipal -UserId $identity -LogonType Interactive -RunLevel Limited
$settings = New-ScheduledTaskSettingsSet -Hidden -StartWhenAvailable -AllowStartIfOnBatteries `
    -DontStopIfGoingOnBatteries -MultipleInstances IgnoreNew -ExecutionTimeLimit (New-TimeSpan -Minutes 3) `
    -RestartCount 3 -RestartInterval (New-TimeSpan -Minutes 1)
Register-ScheduledTask -TaskName $name -Action $action -Trigger @($trigger, $healthCheck) -Principal $principal `
    -Settings $settings -Description 'SOFTON 세션 공유실: 로그인 후 창 없는 시작, 실패 재시도 및 5분 주기 상태 점검' -Force | Out-Null
$actual = Get-ScheduledTask -TaskName $name
if ($actual.Actions.Execute -ne $hostExe -or $actual.Actions.Arguments -ne $arguments `
    -or $actual.Principal.LogonType -ne 'Interactive' -or -not $actual.Settings.Hidden `
    -or $actual.Settings.RestartCount -ne 3 -or $actual.Settings.RestartInterval -ne 'PT1M' `
    -or $actual.Triggers.Count -ne 2 `
    -or @($actual.Triggers | Where-Object { $_.Repetition.Interval -eq 'PT5M' }).Count -ne 1) {
    throw 'The saved SOFTON startup task does not match the approved plan.'
}
$description | ConvertTo-Json
