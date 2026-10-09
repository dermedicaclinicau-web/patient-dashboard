# Deploys the portal and stamps a new version, so open portals show "A new version is ready".
# Use:  .\deploy.ps1 "What changed"
param([string]$Message = "Update")
Set-Location $PSScriptRoot

$version = Get-Date -Format "yyyyMMdd-HHmmss"
$files = Get-ChildItem -Path js, css -Recurse -File -Include *.js, *.css |
  ForEach-Object { "./" + ($_.FullName.Substring($PSScriptRoot.Length + 1) -replace '\\', '/') }
$files += "./index.html"

@{ version = $version; files = $files } | ConvertTo-Json | Set-Content -Path version.json -Encoding UTF8

git add -A
git commit -m $Message
git push
Write-Host "Deployed version $version" -ForegroundColor Green