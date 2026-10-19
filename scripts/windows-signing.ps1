# Optional Authenticode setup. Secrets are read from the environment, never arguments or logs.
function Start-PulseWindowsSigning([string]$WorkDirectory, [string]$BaseConfiguration) {
    $Thumbprint = $env:PULSE_WINDOWS_CERT_THUMBPRINT
    $Pfx = $env:PULSE_WINDOWS_CERT_BASE64
    if (-not $Thumbprint -and -not $Pfx) { return $null }
    $Folder = Join-Path $WorkDirectory ('.signing-' + [Guid]::NewGuid().ToString('N'))
    New-Item -ItemType Directory -Path $Folder | Out-Null
    $Owner = [Security.Principal.WindowsIdentity]::GetCurrent().User
    $Acl = [Security.AccessControl.DirectorySecurity]::new()
    $Acl.SetOwner($Owner)
    $Acl.SetAccessRuleProtection($true, $false)
    $Rule = [Security.AccessControl.FileSystemAccessRule]::new($Owner, [Security.AccessControl.FileSystemRights]::FullControl,
        [Security.AccessControl.InheritanceFlags]'ContainerInherit,ObjectInherit', [Security.AccessControl.PropagationFlags]::None,
        [Security.AccessControl.AccessControlType]::Allow)
    $Acl.AddAccessRule($Rule)
    Set-Acl -Path $Folder -AclObject $Acl
    $Imported = $false
    try {
        if ($Pfx) {
            $PfxPath = Join-Path $Folder 'certificate.pfx'
            [IO.File]::WriteAllBytes($PfxPath, [Convert]::FromBase64String($Pfx))
            $Password = ConvertTo-SecureString ([string]$env:PULSE_WINDOWS_CERT_PASSWORD) -AsPlainText -Force
            $Data = Get-PfxData -FilePath $PfxPath -Password $Password
            $Thumbprint = ($Data.EndEntityCertificates | Select-Object -First 1).Thumbprint
            if (-not $Thumbprint) { throw 'The PFX did not contain a signing certificate.' }
            $Existing = Get-Item "Cert:\CurrentUser\My\$Thumbprint" -ErrorAction SilentlyContinue
            if ($Existing -and -not $Existing.HasPrivateKey) { throw 'Install the private key for the existing signing certificate first.' }
            if (-not $Existing) {
                Import-PfxCertificate -FilePath $PfxPath -Password $Password -CertStoreLocation Cert:\CurrentUser\My | Out-Null
                $Imported = $true
            }
            Remove-Item $PfxPath -Force
        }
        $Certificate = Get-Item "Cert:\CurrentUser\My\$Thumbprint" -ErrorAction Stop
        if (-not $Certificate.HasPrivateKey -or $Certificate.NotAfter -lt (Get-Date)) { throw 'The signing certificate is expired or has no private key.' }
        $Configuration = Get-Content $BaseConfiguration -Raw | ConvertFrom-Json -AsHashtable
        if (-not $Configuration.bundle) { $Configuration.bundle = @{} }
        if (-not $Configuration.bundle.windows) { $Configuration.bundle.windows = @{} }
        $Configuration.bundle.windows.certificateThumbprint = $Thumbprint
        $Configuration.bundle.windows.digestAlgorithm = 'sha256'
        $Configuration.bundle.windows.timestampUrl = 'https://timestamp.digicert.com'
        $Configuration.bundle.windows.tsp = $true
        $ConfigurationPath = Join-Path $Folder 'tauri-signing.json'
        $Configuration | ConvertTo-Json -Depth 30 | Set-Content $ConfigurationPath -Encoding utf8NoBOM
        return @{ Thumbprint=$Thumbprint; Imported=$Imported; Folder=$Folder; Configuration=$ConfigurationPath }
    } catch {
        if ($Imported) { Remove-Item "Cert:\CurrentUser\My\$Thumbprint" -DeleteKey -Force -ErrorAction SilentlyContinue }
        Remove-Item $Folder -Recurse -Force -ErrorAction SilentlyContinue
        throw
    }
}
function Sign-PulseWindowsPayload([hashtable]$Signing, [string]$Backend) {
    if (-not $Signing) { return }
    $Tool = Get-ChildItem "${env:ProgramFiles(x86)}/Windows Kits/10/bin/*/x64/signtool.exe" -ErrorAction SilentlyContinue | Sort-Object FullName -Descending | Select-Object -First 1
    if (-not $Tool) { throw 'Windows SDK signtool.exe is required for signed builds.' }
    $Files = @((Join-Path $Backend 'pulse_backend.exe')) + @(Get-ChildItem $Backend -Recurse -Filter pulse-reranker.exe | ForEach-Object FullName)
    foreach ($File in $Files) {
        & $Tool.FullName sign /sha1 $Signing.Thumbprint /fd SHA256 /tr https://timestamp.digicert.com /td SHA256 $File
        if ($LASTEXITCODE -ne 0) { throw 'Signing a bundled executable failed.' }
    }
}
function Stop-PulseWindowsSigning([hashtable]$Signing) {
    if (-not $Signing) { return }
    if ($Signing.Imported) { Remove-Item "Cert:\CurrentUser\My\$($Signing.Thumbprint)" -DeleteKey -Force -ErrorAction SilentlyContinue }
    Remove-Item $Signing.Folder -Recurse -Force -ErrorAction SilentlyContinue
}
