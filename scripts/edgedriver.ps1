# Downloads the msedgedriver that matches the installed WebView2 runtime and
# sets MSEDGEDRIVER for later GitHub Actions steps. A driver whose version
# differs from the runtime's hangs instead of failing, so match it exactly.
$ErrorActionPreference = "Stop"

$root = Join-Path ${env:ProgramFiles(x86)} "Microsoft\EdgeWebView\Application"
$version = Get-ChildItem $root -Directory -ErrorAction SilentlyContinue |
  Where-Object { $_.Name -match '^\d+(\.\d+){3}$' } |
  Sort-Object { [version]$_.Name } -Descending |
  Select-Object -First 1 -ExpandProperty Name
if (-not $version) {
  foreach ($key in @(
      'HKLM:\SOFTWARE\WOW6432Node\Microsoft\EdgeUpdate\Clients\{F3017226-FE2A-4295-8BDF-00C3A9A7E4C5}',
      'HKLM:\SOFTWARE\Microsoft\EdgeUpdate\Clients\{F3017226-FE2A-4295-8BDF-00C3A9A7E4C5}')) {
    $version = (Get-ItemProperty $key -ErrorAction SilentlyContinue).pv
    if ($version) { break }
  }
}
if (-not $version) { throw "No WebView2 runtime found (looked in $root and the EdgeUpdate registry keys)." }
Write-Host "WebView2 runtime $version"

$dir = Join-Path $env:RUNNER_TEMP "edgedriver"
$zip = "$dir.zip"
Invoke-WebRequest "https://msedgedriver.microsoft.com/$version/edgedriver_win64.zip" -OutFile $zip
Expand-Archive $zip -DestinationPath $dir -Force
$driver = Join-Path $dir "msedgedriver.exe"
& $driver --version
"MSEDGEDRIVER=$driver" | Out-File -Append -Encoding utf8 $env:GITHUB_ENV
