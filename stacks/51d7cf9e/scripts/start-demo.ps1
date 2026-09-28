param(
    [ValidateSet('demo', 'lan', 'flaky-wifi')]
    [string]$Profile = 'demo',
    [switch]$Build
)

$stackRoot = Split-Path -Parent $PSScriptRoot
$mockProject = Join-Path $stackRoot 'sap-mock\SapMock.csproj'
$legacyProject = Join-Path $stackRoot 'legacy-windows\EimRf.csproj'
$rdpProject = Join-Path $stackRoot 'rdp-sim\RdpSim.csproj'
$legacyExe = Join-Path $stackRoot 'legacy-windows\bin\Release\net48\EimRf.exe'
$rdpDll = Join-Path $stackRoot 'rdp-sim\bin\Release\net48\RdpSim.dll'
$timings = Join-Path $stackRoot 'legacy-windows\bin\Release\net48\timings.csv'

Get-Process -Name EimRf, SapMock -ErrorAction SilentlyContinue | Stop-Process -Force
Get-CimInstance Win32_Process -Filter "Name = 'dotnet.exe'" -ErrorAction SilentlyContinue |
    Where-Object { $_.CommandLine -like "*sap-mock*" } |
    ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }

$env:EIMRF_PROFILE = $Profile
$mockLog = Join-Path $stackRoot 'sap-mock.log'
$mockErrorLog = Join-Path $stackRoot 'sap-mock-error.log'
Start-Process -FilePath 'dotnet' -ArgumentList @(
    'run', '-c', 'Release', '--project', $mockProject, '--', '--urls', 'http://0.0.0.0:8400'
) -WorkingDirectory $stackRoot -NoNewWindow -PassThru `
    -RedirectStandardOutput $mockLog -RedirectStandardError $mockErrorLog | Out-Null

$ready = $false
for ($attempt = 0; $attempt -lt 90; $attempt++) {
    try {
        $health = Invoke-RestMethod -Uri 'http://localhost:8400/health' -TimeoutSec 2
        if ($health.status -eq 'UP') { $ready = $true; break }
    } catch { }
    Start-Sleep -Seconds 1
}
if (-not $ready) { throw "sap-mock did not become healthy; inspect $mockLog and $mockErrorLog" }

if ($Build -or -not (Test-Path $legacyExe) -or -not (Test-Path $rdpDll)) {
    dotnet build -c Release $legacyProject
    if ($LASTEXITCODE -ne 0) { throw 'EimRf build failed.' }
    dotnet build -c Release $rdpProject
    if ($LASTEXITCODE -ne 0) { throw 'RdpSim build failed.' }
}

Start-Process -FilePath $legacyExe -ArgumentList '/rdpsim' -WorkingDirectory (Split-Path -Parent $legacyExe)
Write-Output 'sap-mock: http://localhost:8400'
Write-Output 'rdp-sim: TCP 3390'
Write-Output "profile: $Profile"
Write-Output "timings.csv: $timings"
