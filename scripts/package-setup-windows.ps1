param([string]$OutputDirectory = 'outputs/setup')
$ErrorActionPreference = 'Stop'
$Root = Split-Path $PSScriptRoot -Parent
$Output = if ([IO.Path]::IsPathRooted($OutputDirectory)) { [IO.Path]::GetFullPath($OutputDirectory) } else { [IO.Path]::GetFullPath((Join-Path (Get-Location) $OutputDirectory)) }
New-Item -ItemType Directory -Force -Path $Output | Out-Null
$Compiler = Join-Path $env:WINDIR 'Microsoft.NET/Framework64/v4.0.30319/csc.exe'
if (-not (Test-Path $Compiler)) { throw '.NET Framework 4.8 compiler is required on the Windows build machine.' }
$Core = Join-Path $Root 'installer/windows/SetupCore.cs'
$References = @('/r:System.Net.Http.dll', '/r:System.Web.Extensions.dll', '/r:System.Windows.Forms.dll', '/r:System.Drawing.dll')
$Test = Join-Path $Output 'setup-core-tests.exe'
& $Compiler /nologo /optimize+ /target:exe "/out:$Test" @References $Core (Join-Path $Root 'installer/windows/CoreTests.cs')
if ($LASTEXITCODE -ne 0) { throw 'Setup core tests did not compile.' }
& $Test
if ($LASTEXITCODE -ne 0) { throw 'Setup core tests failed.' }
Remove-Item $Test
$Exe = Join-Path $Output 'Pulse-Setup-Windows-x64.exe'
& $Compiler /nologo /optimize+ /platform:x64 /target:winexe "/out:$Exe" "/win32manifest:$Root/installer/windows/app.manifest" "/win32icon:$Root/desktop/src-tauri/icons/icon.ico" @References $Core (Join-Path $Root 'installer/windows/SetupApp.cs')
if ($LASTEXITCODE -ne 0) { throw 'Setup wizard did not compile.' }
. (Join-Path $Root 'scripts/windows-signing.ps1')
$Signing = $null
try {
    $Signing = Start-PulseWindowsSigning $Output (Join-Path $Root 'desktop/src-tauri/tauri.windows.conf.json')
    if ($Signing) {
        $Tool = Get-ChildItem "${env:ProgramFiles(x86)}/Windows Kits/10/bin/*/x64/signtool.exe" | Sort-Object FullName -Descending | Select-Object -First 1
        if (-not $Tool) { throw 'Windows SDK signtool is required for a signed wizard.' }
        & $Tool.FullName sign /sha1 $Signing.Thumbprint /fd SHA256 /tr https://timestamp.digicert.com /td SHA256 $Exe
        if ($LASTEXITCODE -ne 0) { throw 'Setup signing failed.' }
        if ((Get-AuthenticodeSignature $Exe).Status -ne 'Valid') { throw 'Setup signature verification failed.' }
    }
} finally { Stop-PulseWindowsSigning $Signing }
$Hash = (Get-FileHash $Exe -Algorithm SHA256).Hash.ToLowerInvariant()
"$Hash  Pulse-Setup-Windows-x64.exe" | Set-Content (Join-Path $Output 'Pulse-Setup-Windows-x64-SHA256SUMS.txt') -Encoding ascii
Write-Output "Built $Exe"
