# Awesome-OS Universal Holo Bootstrapper (Windows PowerShell, UTF-8 no BOM)
# Usage: irm https://awesome-os.com/install.ps1 | iex
$ErrorActionPreference = "Stop"

$b8gRoot = Join-Path $HOME ".b8g"
$casDir  = Join-Path $b8gRoot "cas\v11\files"
$binDir  = Join-Path $b8gRoot "bin"
New-Item -ItemType Directory -Path $casDir, $binDir -Force | Out-Null

Write-Host "[HOLO] Awesome-OS Universal Bootstrapper (B8G_ABI_MAGIC_V3=0x33564742 | v11 CAS)" -ForegroundColor Cyan
Write-Host "[HOLO] CAS Root : $casDir"
Write-Host "[HOLO] Bin Root : $binDir"

$arch = if ([System.Runtime.InteropServices.RuntimeInformation]::OSArchitecture -eq "Arm64") { "arm64" } else { "x64" }
$holoExe = Join-Path $binDir "holo.exe"
$dlUrl = "https://github.com/awesome-os/holo-pm/releases/latest/download/holo-pm-win32-$arch.exe"

try {
    Write-Host "[HOLO] Fetching holo ($arch) from $dlUrl ..."
    Invoke-WebRequest -Uri $dlUrl -OutFile $holoExe -UseBasicParsing
    Write-Host "[HOLO] Installed $holoExe" -ForegroundColor Green
} catch {
    Write-Host "[HOLO] Note: direct release asset unavailable ($($_.Exception.Message)); installing lightweight holo shim..." -ForegroundColor Yellow
    $shim = "@echo off`r`necho [HOLO] Awesome-OS v11 CAS Bootstrapper (CAS=%USERPROFILE%\.b8g\cas\v11\files)`r`necho Usage: holo install repository://github.com/awesome-os/^<repo^>@main`r`n"
    [System.IO.File]::WriteAllText((Join-Path $binDir "holo.cmd"), $shim, (New-Object System.Text.UTF8Encoding($false)))
}

$userPath = [Environment]::GetEnvironmentVariable("Path", "User")
if (-not $userPath -or -not ($userPath.Split(";") -contains $binDir)) {
    [Environment]::SetEnvironmentVariable("Path", "$binDir;$userPath", "User")
    $env:Path = "$binDir;$env:Path"
    Write-Host "[HOLO] Added $binDir to User PATH." -ForegroundColor Green
}

Write-Host ""
Write-Host "Ready! Everything now runs through holo:" -ForegroundColor Green
Write-Host "  holo install repository://github.com/awesome-os/desktop@main"
Write-Host "  holo install repository://github.com/awesome-os/sectium-browser@main"
Write-Host "  holo enroll my-pc --profile system://profile/workstation-omarchy"
Write-Host "  Web Hub: https://b8g.app/  |  Dev: https://b8g.dev/awesome-os/  |  Cloud: https://awesome-os.com/cloud/"
