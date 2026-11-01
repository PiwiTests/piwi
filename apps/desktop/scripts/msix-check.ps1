# Install an MSIX package of the desktop app, start it, and report what Windows did with its writes.
#
# Run on a disposable Windows machine (a CI runner), as an administrator: it trusts the package's certificate,
# deletes the app's data folder and the discovery file before it starts, and uninstalls the package at the end.
#
# The report says, for this package:
#   - whether the app started its server (the discovery file, then GET /api/health);
#   - where the app's data folder and the server's database landed: the real %APPDATA%, or the package's private
#     copy (LocalCache);
#   - whether the app execution alias exists and bridges an MCP initialize (piwi-desktop.exe mcp-stdio);
#   - with -Update, whether a Node sidecar of the old version outlives an update installed over the running app.
#
# Usage: msix-check.ps1 -Package <signed.msix> -Certificate <publisher.cer> -Label <name>
#                       [-Update <signed newer.msix>] [-Summary <file to append a Markdown row to>]
param(
  [Parameter(Mandatory)] [string] $Package,
  [Parameter(Mandatory)] [string] $Certificate,
  [Parameter(Mandatory)] [string] $Label,
  [string] $Update,
  [string] $Summary
)

$ErrorActionPreference = 'Stop'
$identifier = 'io.piwitests.dashboard'
$appData = Join-Path $env:APPDATA $identifier
$discovery = Join-Path $env:USERPROFILE '.piwi\desktop.json'
$facts = [ordered]@{ variant = $Label }

function Stop-App([string] $installLocation) {
  Get-Process | Where-Object { $_.Path -and $installLocation -and $_.Path.StartsWith($installLocation) } |
    Stop-Process -Force -ErrorAction SilentlyContinue
}

function Wait-Server {
  for ($i = 0; $i -lt 120; $i++) {
    if (Test-Path -LiteralPath $discovery) {
      try {
        $url = (Get-Content -Raw -LiteralPath $discovery | ConvertFrom-Json).url
        Invoke-WebRequest -UseBasicParsing -TimeoutSec 5 "$url/api/health" | Out-Null
        return $url
      } catch { }
    }
    Start-Sleep -Seconds 1
  }
  return $null
}

# Where a path the app wrote landed: its real place, the package's private copy, both or neither.
function Get-Location-Of([string] $real, [string] $packageCopy) {
  $found = @()
  if (Test-Path -LiteralPath $real) { $found += 'real %APPDATA%' }
  if (Test-Path -LiteralPath $packageCopy) { $found += 'private LocalCache' }
  if ($found.Count -eq 0) { return 'nowhere' }
  return $found -join ' + '
}

function Invoke-Bridge([string] $alias) {
  $start = New-Object System.Diagnostics.ProcessStartInfo
  $start.FileName = $alias
  $start.Arguments = 'mcp-stdio'
  $start.UseShellExecute = $false
  $start.RedirectStandardInput = $true
  $start.RedirectStandardOutput = $true
  $process = [System.Diagnostics.Process]::Start($start)
  $process.StandardInput.WriteLine(
    '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"msix-check","version":"1"}}}')
  $read = $process.StandardOutput.ReadLineAsync()
  $answered = $read.Wait(20000)
  $process.StandardInput.Close()
  if (-not $process.WaitForExit(5000)) { $process.Kill() }
  if ($answered -and $read.Result -match '"result"') { return 'answers' }
  if ($answered) { return "answers with: $($read.Result)" }
  return 'no answer'
}

Import-Certificate -FilePath $Certificate -CertStoreLocation Cert:\LocalMachine\TrustedPeople | Out-Null
Remove-Item -Recurse -Force -ErrorAction SilentlyContinue $appData, $discovery

try {
  Add-AppxPackage -Path $Package
  $installed = Get-AppxPackage | Where-Object { $_.InstallLocation -and (Test-Path (Join-Path $_.InstallLocation 'resources\app-server')) } |
    Select-Object -First 1
  $facts.install = 'installed'
} catch {
  $facts.install = "refused: $($_.Exception.Message.Split("`n")[0])"
}

if ($installed) {
  $family = $installed.PackageFamilyName
  $packageCopy = Join-Path $env:LOCALAPPDATA "Packages\$family\LocalCache\Roaming\$identifier"
  Start-Process "shell:AppsFolder\$family!App"
  $url = Wait-Server
  $facts.server = if ($url) { 'answers /api/health' } else { 'did not start' }
  $facts.dataFolder = Get-Location-Of $appData $packageCopy
  $facts.database = Get-Location-Of "$appData\.data\piwi.db" "$packageCopy\.data\piwi.db"
  $alias = Join-Path $env:LOCALAPPDATA 'Microsoft\WindowsApps\piwi-desktop.exe'
  $facts.alias = if (Test-Path -LiteralPath $alias) { 'present' } else { 'absent' }
  $facts.bridge = if ($url -and $facts.alias -eq 'present') { Invoke-Bridge $alias } else { 'not tried' }

  if ($Update -and $url) {
    $sidecars = Get-Process node -ErrorAction SilentlyContinue |
      Where-Object { $_.Path -and $_.Path.StartsWith($installed.InstallLocation) }
    try {
      Add-AppxPackage -Path $Update -ForceApplicationShutdown
      Start-Sleep -Seconds 10
      $left = $sidecars | Where-Object { -not $_.HasExited }
      $facts.update = if ($left) { "installed; $($left.Count) old sidecar(s) still running" } else { 'installed; old sidecar gone' }
    } catch {
      $facts.update = "refused: $($_.Exception.Message.Split("`n")[0])"
    }
    $installed = Get-AppxPackage -Name $installed.Name
  }

  Get-ChildItem -LiteralPath "$appData\logs", "$packageCopy\logs" -Filter *.log -ErrorAction SilentlyContinue |
    ForEach-Object { Write-Host "--- $($_.FullName)"; Get-Content -Tail 40 -LiteralPath $_.FullName }
  Stop-App $installed.InstallLocation
  Get-Process node -ErrorAction SilentlyContinue | Where-Object { $_.Path -like '*\WindowsApps\*' } |
    Stop-Process -Force -ErrorAction SilentlyContinue
  Remove-AppxPackage -Package $installed.PackageFullName
}

$facts | ConvertTo-Json | Write-Host
if ($Summary) {
  if (-not (Test-Path -LiteralPath $Summary) -or -not (Select-String -Quiet -LiteralPath $Summary -Pattern '^\| variant')) {
    Add-Content -LiteralPath $Summary ("| " + (@('variant', 'install', 'server', 'dataFolder', 'database', 'alias', 'bridge', 'update') -join ' | ') + ' |')
    Add-Content -LiteralPath $Summary '| --- | --- | --- | --- | --- | --- | --- | --- |'
  }
  $row = @('variant', 'install', 'server', 'dataFolder', 'database', 'alias', 'bridge', 'update') | ForEach-Object { $facts[$_] }
  Add-Content -LiteralPath $Summary ('| ' + ($row -join ' | ') + ' |')
}
