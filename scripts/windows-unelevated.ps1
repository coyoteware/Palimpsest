# Runs a command without administrator rights (medium integrity) on a GitHub
# Actions Windows runner, where everything else runs elevated.
#
# Why: since WebView2 Runtime 150, an elevated WebView2 ignores the
# remote-debugging switch that msedgedriver passes through
# WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS, so WebDriver sessions never start
# (MicrosoftEdge/WebView2Feedback#5645, tauri-apps/wry#1782).
#
# Usage: ./scripts/windows-unelevated.ps1 npx vitest run -c vitest.e2e.config.ts
$ErrorActionPreference = "Stop"
if ($args.Count -eq 0) { throw "Usage: windows-unelevated.ps1 <command> [args...]" }

if (-not (Get-Command gsudo -ErrorAction SilentlyContinue)) {
  choco install gsudo -y --no-progress | Out-Host
  if ($LASTEXITCODE -ne 0) { throw "Could not install gsudo." }
}

# Let the non-elevated process write to the checkout (Vitest's cache, build output).
icacls "$env:GITHUB_WORKSPACE" /grant "Everyone:(OI)(CI)F" /Q | Out-Host

# The command runs from a script file in a fresh process, so carry over the
# environment the tests need and quote every argument.
$quote = { param($s) "'" + ($s -replace "'", "''") + "'" }
$lines = @("`$ErrorActionPreference = 'Stop'")
foreach ($name in "PATH", "CI", "MSEDGEDRIVER", "PALIMPSEST_APP") {
  $value = [Environment]::GetEnvironmentVariable($name)
  if ($null -ne $value) { $lines += "`$env:$name = $(& $quote $value)" }
}
$lines += "Set-Location $(& $quote $PWD.Path)"
$lines += "& " + (($args | ForEach-Object { & $quote "$_" }) -join " ")
$lines += "exit `$LASTEXITCODE"
$script = Join-Path $env:RUNNER_TEMP "unelevated-$([guid]::NewGuid()).ps1"
Set-Content -Path $script -Value $lines -Encoding utf8

gsudo --integrity Medium pwsh -NoProfile -File $script
exit $LASTEXITCODE
