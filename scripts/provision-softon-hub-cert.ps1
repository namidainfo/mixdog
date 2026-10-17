#Requires -Version 7.3
[CmdletBinding()]
param()

$ErrorActionPreference = 'Stop'
$address = '192.168.19.118'
$base = Join-Path ([Environment]::GetFolderPath('LocalApplicationData')) 'SOFTON\session-hub\certificates'
if (-not [IO.Path]::IsPathFullyQualified($base)) { throw 'The certificate directory must be absolute.' }
[IO.Directory]::CreateDirectory($base) | Out-Null
$directory = & node --input-type=module -e "import fs from 'node:fs'; import path from 'node:path'; console.log(fs.mkdtempSync(path.join(process.argv[1], 'cert-')));" $base
if ($LASTEXITCODE -ne 0) { throw 'The unique certificate directory could not be allocated.' }
$directory = [string]$directory
$owner = [Security.Principal.WindowsIdentity]::GetCurrent().User
$system = [Security.Principal.SecurityIdentifier]::new('S-1-5-18')
$acl = Get-Acl -LiteralPath $directory
$acl.SetAccessRuleProtection($true, $false)
$acl.SetOwner($owner)
foreach ($identity in @($owner, $system)) {
    $acl.AddAccessRule([Security.AccessControl.FileSystemAccessRule]::new(
        $identity, [Security.AccessControl.FileSystemRights]::FullControl,
        [Security.AccessControl.InheritanceFlags]'ContainerInherit,ObjectInherit',
        [Security.AccessControl.PropagationFlags]::None, [Security.AccessControl.AccessControlType]::Allow
    ))
}
Set-Acl -LiteralPath $directory -AclObject $acl

$certificate = New-SelfSignedCertificate `
    -Type SSLServerAuthentication `
    -Subject "CN=$address" `
    -TextExtension @("2.5.29.17={text}IPAddress=$address&DNS=localhost&IPAddress=127.0.0.1") `
    -KeyAlgorithm RSA -KeyLength 3072 -HashAlgorithm SHA256 -KeyExportPolicy Exportable `
    -Provider 'Microsoft Software Key Storage Provider' `
    -CertStoreLocation 'Cert:\CurrentUser\My' `
    -FriendlyName "SOFTON Session Hub $address" `
    -NotAfter (Get-Date).AddYears(1)
$certificatePath = Join-Path $directory 'server.crt'
$keyPath = Join-Path $directory 'server.key'
$publicPath = Join-Path $directory 'SOFTON-session-hub.cer'
$encoding = [Text.UTF8Encoding]::new($false)
$key = [Security.Cryptography.X509Certificates.RSACertificateExtensions]::GetRSAPrivateKey($certificate)
try {
    [IO.File]::WriteAllText($certificatePath, $certificate.ExportCertificatePem(), $encoding)
    [IO.File]::WriteAllText($keyPath, $key.ExportPkcs8PrivateKeyPem(), $encoding)
} finally { $key.Dispose() }
[IO.File]::WriteAllBytes($publicPath, $certificate.Export([Security.Cryptography.X509Certificates.X509ContentType]::Cert))
Import-Certificate -FilePath $publicPath -CertStoreLocation 'Cert:\CurrentUser\Root' | Out-Null
$trusted = Get-Item -LiteralPath "Cert:\CurrentUser\Root\$($certificate.Thumbprint)"
[pscustomobject]@{
    Address = $address
    CertificatePath = $certificatePath
    KeyPath = $keyPath
    PublicCertificatePath = $publicPath
    Thumbprint = $certificate.Thumbprint
    NotAfter = $certificate.NotAfter.ToString('o')
    CurrentUserTrusted = $trusted.Thumbprint -eq $certificate.Thumbprint
    SubjectAltName = ($certificate.Extensions | Where-Object { $_.Oid.Value -eq '2.5.29.17' } | ForEach-Object { $_.Format($false) })
} | ConvertTo-Json -Depth 3
