# Quiet deploy: pushes changes WITHOUT the "New version" bar for other staff.
# Usage:  .\quiet-deploy.ps1 "description"
param([Parameter(Mandatory = $true)][string]$Message)

$ErrorActionPreference = "Stop"
Set-Location "C:\Users\Bethany\patient-dashboard"

# The file the update check watches. Change this if yours is named differently.
$versionFile = "version.json"

# Keep the version file exactly as it is on the live site
if (Test-Path $versionFile) { git checkout -- $versionFile 2>$null }

git add -A
git reset -q -- $versionFile 2>$null   # never include it in this commit

$changes = git diff --cached --name-only
if (-not $changes) { Write-Host "Nothing to deploy." -ForegroundColor Yellow; exit 0 }

Write-Host "Deploying quietly:" -ForegroundColor Cyan
$changes | ForEach-Object { Write-Host "  $_" }

git commit -q -m "$Message (quiet)"
git push -q

Write-Host ""
Write-Host "Pushed. Wait about a minute for GitHub Pages, then press Ctrl+Shift+R in your browser." -ForegroundColor Green
Write-Host "Other staff get these changes the next time they refresh or log in. No bar was shown." -ForegroundColor Green