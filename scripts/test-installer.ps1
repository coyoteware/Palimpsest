# Tests the Windows installer end to end on a CI runner: a silent per-user
# install, the PDF registration it adds (src-tauri/windows/installer-hooks.nsh)
# and that it leaves the default PDF app alone, opening a PDF through the
# "Open with Palimpsest" command as Explorer's context menu does, then a
# silent uninstall that removes the registration again.
#
# Usage: ./scripts/test-installer.ps1 -Installer path\to\Palimpsest_x.y.z_x64-setup.exe
param([Parameter(Mandatory)][string]$Installer)
$ErrorActionPreference = "Stop"

$classes = "HKCU:\Software\Classes"
$installDir = Join-Path $env:LOCALAPPDATA "Palimpsest"
$exe = Join-Path $installDir "palimpsest.exe"
$progId = "Palimpsest.PDF"
$open = "`"$exe`" `"%1`""

function Check([bool]$ok, [string]$what) {
  if (-not $ok) { throw "Installer check failed: $what" }
  Write-Host "ok - $what"
}

# A registry value as a string, or $null if the key or value is missing.
function RegValue([string]$key, [string]$name) {
  $item = Get-ItemProperty -LiteralPath $key -ErrorAction SilentlyContinue
  if ($null -eq $item) { return $null }
  $property = $item.PSObject.Properties[$name]
  if ($null -eq $property) { return $null }
  return [string]$property.Value
}

# A PDF to open, and no Palimpsest running (single-instance would take over the launch).
$pdf = Join-Path $env:RUNNER_TEMP "installer-test.pdf"
node scripts/sample-pdf.mjs $pdf
if ($LASTEXITCODE -ne 0) { throw "Could not write the sample PDF." }
Get-Process palimpsest -ErrorAction SilentlyContinue | Stop-Process -Force
$defaultBefore = RegValue "$classes\.pdf" "(default)"

Write-Host "Installing $Installer"
$process = Start-Process -FilePath $Installer -ArgumentList "/S" -Wait -PassThru
Check ($process.ExitCode -eq 0) "the installer exits with 0 (got $($process.ExitCode))"
Check (Test-Path $exe) "palimpsest.exe is installed in $installDir"

Check ((RegValue "$classes\$progId\shell\open\command" "(default)") -eq $open) "$progId opens PDFs with $open"
Check ($null -ne (RegValue "$classes\.pdf\OpenWithProgids" $progId)) "PDFs list $progId under Open with"
Check ((RegValue "$classes\Applications\palimpsest.exe" "FriendlyAppName") -eq "Palimpsest") "Open with calls the program Palimpsest"
Check ((RegValue "$classes\SystemFileAssociations\.pdf\shell\Palimpsest" "(default)") -eq "Open with Palimpsest") "PDFs have an 'Open with Palimpsest' command"
Check ((RegValue "$classes\SystemFileAssociations\.pdf\shell\Palimpsest\command" "(default)") -eq $open) "the command runs $open"
Check ((RegValue "HKCU:\Software\Coyoteware\Palimpsest\Capabilities\FileAssociations" ".pdf") -eq $progId) "Palimpsest declares it can open PDFs"
Check ($null -ne (RegValue "HKCU:\Software\RegisteredApplications" "Palimpsest")) "Settings > Default apps offers Palimpsest"
Check ((RegValue "$classes\.pdf" "(default)") -eq $defaultBefore) "the default PDF app is unchanged ('$defaultBefore')"

# Run the "Open with Palimpsest" verb on the PDF, as the context menu does, and
# wait for the window to show the file (the title follows the open document).
Start-Process -FilePath $pdf -Verb Palimpsest
$name = Split-Path $pdf -Leaf
$deadline = (Get-Date).AddSeconds(60)
do {
  Start-Sleep -Seconds 1
  $window = Get-Process palimpsest -ErrorAction SilentlyContinue |
    Where-Object { $_.MainWindowTitle -like "$name*Palimpsest" } |
    Select-Object -First 1
} until ($window -or (Get-Date) -gt $deadline)
Check ($null -ne $window) "'Open with Palimpsest' opens $name (window '$($window.MainWindowTitle)')"
Get-Process palimpsest -ErrorAction SilentlyContinue | Stop-Process -Force
Start-Sleep -Seconds 2

# Uninstall in place: with _?= the uninstaller runs from the install folder, so this can wait for it.
$process = Start-Process -FilePath (Join-Path $installDir "uninstall.exe") -ArgumentList "/S", "_?=$installDir" -Wait -PassThru
Check ($process.ExitCode -eq 0) "the uninstaller exits with 0 (got $($process.ExitCode))"
Check (-not (Test-Path $exe)) "palimpsest.exe is removed"
Check ($null -eq (RegValue "$classes\.pdf\OpenWithProgids" $progId)) "Open with no longer lists $progId"
Check (-not (Test-Path -LiteralPath "$classes\$progId")) "$progId is removed"
Check (-not (Test-Path -LiteralPath "$classes\Applications\palimpsest.exe")) "the Open with entry is removed"
Check (-not (Test-Path -LiteralPath "$classes\SystemFileAssociations\.pdf\shell\Palimpsest")) "the 'Open with Palimpsest' command is removed"
Check ($null -eq (RegValue "HKCU:\Software\RegisteredApplications" "Palimpsest")) "Settings > Default apps no longer offers Palimpsest"
Check ((RegValue "$classes\.pdf" "(default)") -eq $defaultBefore) "the default PDF app is still unchanged"
