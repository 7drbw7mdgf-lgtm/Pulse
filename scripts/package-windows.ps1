param([string]$OutputDirectory = "outputs/windows")
$ErrorActionPreference = "Stop"
if (-not $IsWindows) { throw "Run this script with PowerShell 7 on Windows." }
$Root = Split-Path -Parent $PSScriptRoot
$Output = [IO.Path]::GetFullPath((Join-Path (Get-Location) $OutputDirectory))
New-Item -ItemType Directory -Force -Path $Output | Out-Null
$Version = (Get-Content (Join-Path $Root "desktop/package.json") -Raw | ConvertFrom-Json).version

function Invoke-Checked([string]$Program, [string[]]$Arguments) {
    & $Program @Arguments
    if ($LASTEXITCODE -ne 0) { throw "$Program exited with code $LASTEXITCODE" }
}

. (Join-Path $PSScriptRoot 'windows-signing.ps1')
$Signing = $null
Push-Location $Root
try {
    $BaseConfig = Join-Path $Root 'desktop/src-tauri/tauri.windows.conf.json'
    $Signing = Start-PulseWindowsSigning $Output $BaseConfig
    $TauriConfig = if ($Signing) { $Signing.Configuration } else { $BaseConfig }
    if ($env:PULSE_DEFER_UPDATE_SIGNING -eq '1') {
        $Configuration = Get-Content $TauriConfig -Raw | ConvertFrom-Json -AsHashtable
        if (-not $Configuration.bundle) { $Configuration.bundle = @{} }
        $Configuration.bundle.createUpdaterArtifacts = $false
        $TauriConfig = Join-Path $Output 'tauri-deferred-update-signing.json'
        $Configuration | ConvertTo-Json -Depth 30 | Set-Content $TauriConfig -Encoding utf8NoBOM
    }
    Invoke-Checked python @("-m", "pip", "install", "-r", "scripts/requirements-windows-build.txt")
    # Keep inference dependencies out of the main backend freeze. Both runtimes
    # carry their own interpreter and work without a user Python installation.
    $RankerVenv = Join-Path $Output "ranker-build-venv"
    $SearchRuntime = Join-Path $Output "search-runtime"
    if (Test-Path $SearchRuntime) { Remove-Item $SearchRuntime -Recurse -Force }
    Invoke-Checked python @("-m", "venv", $RankerVenv)
    $RankerPython = Join-Path $RankerVenv "Scripts/python.exe"
    Invoke-Checked $RankerPython @("-m", "pip", "install", "-r", "scripts/requirements-search-runtime.txt")
    Invoke-Checked $RankerPython @("scripts/build-search-runtime.py", "--output", $SearchRuntime)
    Invoke-Checked python @("scripts/stage-desktop.py", "--search-runtime", $SearchRuntime)
    Invoke-Checked python @("scripts/freeze-windows-backend.py", "--work-dir", (Join-Path $Output "backend-build"), "--search-runtime", $SearchRuntime)
    Sign-PulseWindowsPayload $Signing (Join-Path $Root 'desktop/src-tauri/resources/backend')
    $Target = if ($env:CARGO_TARGET_DIR) { $env:CARGO_TARGET_DIR } else { Join-Path $Root "desktop/src-tauri/target" }
    $NsisDir = Join-Path $Target "x86_64-pc-windows-msvc/release/bundle/nsis"
    if (Test-Path $NsisDir) { Remove-Item (Join-Path $NsisDir "*.exe") -Force -ErrorAction SilentlyContinue }
    Push-Location (Join-Path $Root "desktop")
    try {
        Invoke-Checked npm @("ci")
        Invoke-Checked npm @("run", "tauri", "--", "build", "--ci", "--config", $TauriConfig, "--target", "x86_64-pc-windows-msvc", "--", "--locked")
    } finally { Pop-Location }
    $Installers = @(Get-ChildItem $NsisDir -Filter "*$Version*.exe")
    if ($Installers.Count -ne 1) {
        $Installers = @(Get-ChildItem $NsisDir -Filter "*.exe" | Sort-Object LastWriteTime -Descending | Select-Object -First 1)
    }
    if ($Installers.Count -ne 1) { throw "Expected one NSIS installer in $NsisDir, found $($Installers.Count)." }
    $Name = "Pulse-$Version-Windows-x64-Setup.exe"
    $Setup = Join-Path $Output $Name
    Copy-Item $Installers[0].FullName $Setup -Force
    $UpdateSignature = $Installers[0].FullName + '.sig'
    if ($env:PULSE_DEFER_UPDATE_SIGNING -ne '1') {
        if (-not (Test-Path $UpdateSignature)) { throw 'Signed updater artifact missing. Configure TAURI_SIGNING_PRIVATE_KEY or explicitly defer signing for a local release-signing step.' }
        Copy-Item $UpdateSignature ($Setup + '.sig') -Force
    }
    $Signed = $false
    if ($Signing) {
        $Signature = Get-AuthenticodeSignature $Setup
        if ($Signature.Status -ne 'Valid') { throw 'The signed setup did not pass Authenticode verification.' }
        $Signed = $true
    }
    @{ version=$Version; authenticodeSigned=$Signed } | ConvertTo-Json | Set-Content (Join-Path $Output 'signing.json') -Encoding utf8NoBOM
    $Hash = (Get-FileHash $Setup -Algorithm SHA256).Hash.ToLowerInvariant()
    "$Hash  $Name" | Set-Content (Join-Path $Output "SHA256SUMS.txt") -Encoding utf8NoBOM
    Write-Host "Built $Setup"
} finally { Stop-PulseWindowsSigning $Signing; Pop-Location }
