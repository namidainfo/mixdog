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
}
if ($Plan) { $description | ConvertTo-Json; return }
$action = New-ScheduledTaskAction -Execute $hostExe -Argument $arguments -WorkingDirectory $PSScriptRoot
$trigger = New-ScheduledTaskTrigger -AtLogOn -User $identity
$principal = New-ScheduledTaskPrincipal -UserId $identity -LogonType Interactive -RunLevel Limited
$settings = New-ScheduledTaskSettingsSet -Hidden -StartWhenAvailable -AllowStartIfOnBatteries `
    -DontStopIfGoingOnBatteries -MultipleInstances IgnoreNew -ExecutionTimeLimit (New-TimeSpan -Minutes 3)
Register-ScheduledTask -TaskName $name -Action $action -Trigger $trigger -Principal $principal `
    -Settings $settings -Description 'SOFTON 세션 공유실: 로그인 후 창 없는 백그라운드 시작' | Out-Null
$actual = Get-ScheduledTask -TaskName $name
if ($actual.Actions.Execute -ne $hostExe -or $actual.Actions.Arguments -ne $arguments `
    -or $actual.Principal.LogonType -ne 'Interactive' -or -not $actual.Settings.Hidden) {
    throw 'The saved SOFTON startup task does not match the approved plan.'
}
$description | ConvertTo-Json
