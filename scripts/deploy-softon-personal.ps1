#Requires -Version 7.3
[CmdletBinding()]
param(
    [Parameter(Mandatory)][string]$Installer,
    [Parameter(Mandatory)][string]$BackupRoot,
    [switch]$UseExistingBackup
)
$ErrorActionPreference = 'Stop'
$repo = Split-Path $PSScriptRoot -Parent
$local = [Environment]::GetFolderPath('LocalApplicationData')
$install = Join-Path $local 'Programs\mixdog-personal'
$exe = Join-Path $install 'Mixdog Personal.exe'
$profile = Join-Path $local 'mixdog-dev\personal'
$receipt = Join-Path $BackupRoot 'deployment.json'
$wsl = 'C:\Windows\System32\wsl.exe'
$bridgeStopped = $false

function Save-Receipt([string]$Status, [string]$Detail = '') {
    [IO.File]::WriteAllText($receipt, ([ordered]@{
        status = $Status; detail = $Detail; at = [DateTime]::UtcNow.ToString('o')
        install = $install; backup = $BackupRoot; installer = $Installer
    } | ConvertTo-Json), [Text.UTF8Encoding]::new($false))
}
function Invoke-Bridge([string]$Operation) {
    & $wsl -d Ubuntu -u namidainfo --exec systemctl --user $Operation codex-slack-bridge.service
    if ($LASTEXITCODE -ne 0) { throw "Slack bridge $Operation failed." }
}
try {
    $backupBase = [IO.Path]::GetFullPath((Join-Path $local 'SOFTON\session-hub\backups'))
    $actualBackup = [IO.Path]::GetFullPath($BackupRoot)
    if ((Split-Path $actualBackup -Parent) -ne $backupBase -or (Split-Path $actualBackup -Leaf) -notlike 'install-*') {
        throw 'The backup must be a uniquely allocated SOFTON installation directory.'
    }
    if (-not (Get-Item -LiteralPath $exe).VersionInfo.ProductName.Equals('Mixdog Personal')) {
        throw 'The existing target is not Mixdog Personal.'
    }
    if ((Get-Item -LiteralPath $Installer).VersionInfo.ProductName -ne 'Mixdog Personal') {
        throw 'The installer does not target Mixdog Personal.'
    }
    $candidate = Join-Path (Split-Path $Installer -Parent) 'win-unpacked\resources'
    $expected = @{}
    foreach ($name in @('app.asar', 'runtime.asar')) {
        $expected[$name] = (Get-FileHash -Algorithm SHA256 -LiteralPath (Join-Path $candidate $name)).Hash
    }
    Get-Item -LiteralPath 'Cert:\CurrentUser\Root\CD03C0580C330CE76F4AC75D1CB99F21A5E14B52' | Out-Null
    if ($UseExistingBackup) {
        foreach ($name in @('app.asar', 'runtime.asar')) {
            $saved = Join-Path $BackupRoot "current-install\resources\$name"
            if ((Get-FileHash -Algorithm SHA256 -LiteralPath $saved).Hash -ne
                (Get-FileHash -Algorithm SHA256 -LiteralPath (Join-Path $install "resources\$name")).Hash) {
                throw 'The preserved backup does not match the unchanged installation.'
            }
        }
    } else {
        Save-Receipt 'backing-up'
        Copy-Item -LiteralPath $install -Destination (Join-Path $BackupRoot 'current-install') -Recurse
    }
    Save-Receipt 'backup-complete'
    $env:MIXDOG_RUNTIME_ROOT = Join-Path $profile 'runtime'
    $env:MIXDOG_HOME = Join-Path $profile 'home'
    $env:MIXDOG_DATA_DIR = Join-Path $profile 'data'
    Save-Receipt 'waiting-for-idle' 'The running response must finish before its Personal host can restart.'
    $idle = @'
import {pathToFileURL} from 'node:url';
import {setTimeout as delay} from 'node:timers/promises';
const api=await import(pathToFileURL(process.argv[1]+'/src/standalone/session-client.mjs'));
const deadline=Date.now()+15*60*1000;
let idle=false;
while(Date.now()<deadline) {
 const discovery=api.readSessionDiscovery();
 if(!discovery) {idle=true;break;}
 const health=await api.probeSessionHealth(discovery);
 if(health?.status==='ok' && health.idle===true) {idle=true;break;}
 await delay(1000);
}
if(!idle) throw new Error('Personal is still busy. The installation was not changed.');
'@
    & node --input-type=module -e $idle $repo
    if ($LASTEXITCODE -ne 0) { throw 'Personal did not become idle; restart remains deferred.' }
    Invoke-Bridge 'stop'
    $bridgeStopped = $true
    Save-Receipt 'bridge-stopped'
    $processes = @(Get-CimInstance Win32_Process -Filter "Name = 'Mixdog Personal.exe'" |
        Where-Object { $_.ExecutablePath -eq $exe })
    $ids = @($processes.ProcessId)
    foreach ($process in @($processes | Where-Object { $_.ParentProcessId -notin $ids })) {
        Stop-Process -Id $process.ProcessId -Force
    }
    $shutdown = @'
import {pathToFileURL} from 'node:url';
const api=await import(pathToFileURL(process.argv[1]+'/src/standalone/session-client.mjs'));
const discovery=api.readSessionDiscovery();
if(discovery) {
 if(!discovery.channel) throw new Error('No authenticated channel shutdown endpoint is available.');
 if(!await api.shutdownDaemon({...discovery.channel,pid:discovery.pid},{waitForExit:true,timeoutMs:15000})) {
   throw new Error('The Personal session daemon did not accept graceful shutdown.');
 }
}
'@
    & node --input-type=module -e $shutdown $repo
    if ($LASTEXITCODE -ne 0) { throw 'Personal session daemon shutdown failed.' }
    Save-Receipt 'daemon-stopped'
    $installed = Start-Process -FilePath $Installer -ArgumentList @('/S', "/D=$install") -PassThru -Wait
    if ($installed.ExitCode -ne 0) { throw "Personal installer exited with $($installed.ExitCode)." }
    foreach ($name in @('app.asar', 'runtime.asar')) {
        if ((Get-FileHash -Algorithm SHA256 -LiteralPath (Join-Path $install "resources\$name")).Hash -ne $expected[$name]) {
            throw "The installed $name does not match the built Personal artifact."
        }
    }
    Save-Receipt 'installed-and-verified'
    Start-Process -FilePath $exe | Out-Null
    $ready = @'
import {pathToFileURL} from 'node:url';
import {setTimeout as delay} from 'node:timers/promises';
const api=await import(pathToFileURL(process.argv[1]+'/src/standalone/session-client.mjs'));
const deadline=Date.now()+60000;
let ready=false;
while(Date.now()<deadline) {
 const discovery=api.readSessionDiscovery();
 if(discovery) {
   try {
     const health=await api.probeSessionHealth(discovery);
     if(health?.status==='ok') {ready=true;break;}
   }
   catch(error) { if(Date.now()+500>=deadline) throw error; }
 }
 await delay(500);
}
if(!ready) throw new Error('The updated Personal daemon did not become ready.');
console.log('Personal daemon ready');
'@
    & node --input-type=module -e $ready $repo
    if ($LASTEXITCODE -ne 0) { throw 'The updated Personal daemon is not ready.' }
    $editor = '/home/namidainfo/.hermes/node/bin/node /mnt/c/Users/admin/Documents/mixdog-personal/scripts/softon-hub-systemd-editor.mjs /mnt/c/Users/admin/Documents/mixdog-personal/deploy/systemd/95-softon-session-hub.conf'
    & $wsl -d Ubuntu -u namidainfo --exec env "SYSTEMD_EDITOR=$editor" script --quiet --return `
        --command 'systemctl --user edit --drop-in=95-softon-session-hub.conf codex-slack-bridge.service' /dev/null
    if ($LASTEXITCODE -ne 0) { throw 'SOFTON hub service configuration failed.' }
    Invoke-Bridge 'start'
    $bridgeStopped = $false
    $deadline = [DateTime]::UtcNow.AddSeconds(60)
    $httpsReady = $false
    $lastHttpsError = ''
    while ([DateTime]::UtcNow -lt $deadline) {
        try {
            $response = Invoke-WebRequest -Uri 'https://192.168.19.118:8797/api/me' -SkipHttpErrorCheck -TimeoutSec 3
            if ($response.StatusCode -ne 401) { throw "Unexpected anonymous status: $($response.StatusCode)" }
            $httpsReady = $true
            break
        } catch {
            $lastHttpsError = $_.Exception.Message
            Start-Sleep -Milliseconds 500
        }
    }
    if (-not $httpsReady) { throw "SOFTON HTTPS did not become ready: $lastHttpsError" }
    Save-Receipt 'verifying-live-assets-and-policy'
    $env:ELECTRON_RUN_AS_NODE = '1'
    & $exe (Join-Path $PSScriptRoot 'verify-softon-hub-deployment.mjs')
    $verificationExit = $LASTEXITCODE
    Remove-Item Env:ELECTRON_RUN_AS_NODE
    if ($verificationExit -ne 0) { throw 'SOFTON deployed assets, stored execution policy or actual image verification failed.' }
    $startupBefore = [DateTime]::UtcNow
    Start-ScheduledTask -TaskName 'SOFTON-SessionHub'
    $startupDeadline = [DateTime]::UtcNow.AddSeconds(150)
    $startupReady = $false
    while ([DateTime]::UtcNow -lt $startupDeadline) {
        Start-Sleep -Milliseconds 500
        $info = Get-ScheduledTaskInfo -TaskName 'SOFTON-SessionHub'
        if ($info.LastRunTime.ToUniversalTime() -ge $startupBefore.AddSeconds(-1) -and $info.LastTaskResult -eq 0) {
            $startup = Get-Content -LiteralPath (Join-Path $local 'SOFTON\session-hub\startup.json') -Raw | ConvertFrom-Json
            if ($startup.status -eq 'ready' -and [DateTime]::Parse($startup.at).ToUniversalTime() -ge $startupBefore) {
                $startupReady = $true; break
            }
        }
    }
    if (-not $startupReady) { throw 'SOFTON background startup task did not return a verified ready receipt.' }
    Save-Receipt 'completed' 'Personal app/runtime SHA256 and live UI/favicon bytes verified; member execution policy persisted and rejects an unapproved shell; existing PNG is downloadable; scheduled background launcher returned ready. Actual reboot and Slack OTP login still require user validation.'
} catch {
    $failure = $_.Exception.Message
    Save-Receipt 'failed' $failure
    # Do not hide an unsuccessful installation behind a service restart.
    # The original installation remains recoverable in current-install.
    [Console]::Error.WriteLine($failure)
    exit 1
}
