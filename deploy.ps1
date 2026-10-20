# Deploys the portal and stamps a new version, so open portals update themselves.
# Use:  .\deploy.ps1 "What changed"
param([string]$Message = "Update")
Set-Location $PSScriptRoot

$version = Get-Date -Format "yyyyMMdd-HHmmss"

# The version the running code was built with (read by updater.js)
Set-Content -Path "js\version.js" -Value ('export const VERSION = "' + $version + '";') -Encoding utf8

$files = Get-ChildItem -Path js, css -Recurse -File -Include *.js, *.css |
  ForEach-Object { "./" + ($_.FullName.Substring($PSScriptRoot.Length + 1) -replace '\\', '/') }
$files += "./index.html"

# version: the old update check · v: updater.js · files: everything to download ahead
@{ version = $version; v = $version; files = $files } | ConvertTo-Json | Set-Content -Path version.json -Encoding UTF8

git add -A
git commit -m $Message
git push
Write-Host "Deployed version $version" -ForegroundColor Green