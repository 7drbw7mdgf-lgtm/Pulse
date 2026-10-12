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

Push-Location $Root
try {
    Invoke-Checked python @("-m", "pip", "install", "-r", "scripts/requirements-windows-build.txt")
    Invoke-Checked python @("scripts/stage-desktop.py")
    Invoke-Checked python @("scripts/freeze-windows-backend.py", "--work-dir", (Join-Path $Output "backend-build"))
    $Target = if ($env:CARGO_TARGET_DIR) { $env:CARGO_TARGET_DIR } else { Join-Path $Root "desktop/src-tauri/target" }
    $NsisDir = Join-Path $Target "x86_64-pc-windows-msvc/release/bundle/nsis"
    if (Test-Path $NsisDir) { Remove-Item (Join-Path $NsisDir "*.exe") -Force -ErrorAction SilentlyContinue }
    Push-Location (Join-Path $Root "desktop")
    try {
        Invoke-Checked npm @("ci")
        Invoke-Checked npm @("run", "tauri", "--", "build", "--ci", "--config", "src-tauri/tauri.windows.conf.json", "--target", "x86_64-pc-windows-msvc", "--", "--locked")
    } finally { Pop-Location }
    $Installers = @(Get-ChildItem $NsisDir -Filter "*$Version*.exe")
    if ($Installers.Count -ne 1) {
        $Installers = @(Get-ChildItem $NsisDir -Filter "*.exe" | Sort-Object LastWriteTime -Descending | Select-Object -First 1)
    }
    if ($Installers.Count -ne 1) { throw "Expected one NSIS installer in $NsisDir, found $($Installers.Count)." }
    $Name = "Pulse-$Version-Windows-x64-Setup.exe"
    $Setup = Join-Path $Output $Name
    Copy-Item $Installers[0].FullName $Setup -Force
    $Hash = (Get-FileHash $Setup -Algorithm SHA256).Hash.ToLowerInvariant()
    "$Hash  $Name" | Set-Content (Join-Path $Output "SHA256SUMS.txt") -Encoding utf8NoBOM
    Write-Host "Built $Setup"
} finally { Pop-Location }
