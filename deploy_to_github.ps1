$pat='' # Set your GitHub Personal Access Token here (or use environment variable)
$headers=@{'Authorization'="token $pat";'User-Agent'='Antigravity'}
# Create repository
$repoBody=@{name='hinataw-cloudflare';description='Hinataw.exe - Anime streaming platform with full API support. Deploy to Cloudflare Workers for complete functionality.';private=$false} | ConvertTo-Json
$repo=Invoke-RestMethod -Headers $headers -Uri 'https://api.github.com/user/repos' -Method Post -Body $repoBody
$owner=$repo.owner.login
Write-Host "Created repo: https://github.com/$owner/hinataw-cloudflare"
# Zip project folder
$projectPath='C:\Users\Dell\.gemini\antigravity\scratch\9Anime-main'
$zipPath="$env:TEMP\hinataw-exe.zip"
if(Test-Path $zipPath){Remove-Item $zipPath -Force}
Compress-Archive -Path "$projectPath\*" -DestinationPath $zipPath -Force
Write-Host "Created zip at $zipPath"
# Create release
$releaseBody=@{tag_name='v0.1.0';name='Initial release';body='Initial upload of the Hinataw.exe project.';draft=$false;prerelease=$false} | ConvertTo-Json
$release=Invoke-RestMethod -Headers $headers -Uri "https://api.github.com/repos/$owner/hinataw-exe/releases" -Method Post -Body $releaseBody
$uploadUrl=$release.upload_url -replace '\{.*\}'
# Upload asset
Invoke-RestMethod -Headers $headers -Uri "$uploadUrl?name=hinataw-exe.zip" -Method Put -InFile $zipPath -ContentType 'application/zip'
Write-Host "Uploaded release asset"
Write-Host ""
Write-Host "=== DEPLOYMENT INSTRUCTIONS ==="
Write-Host "1. Go to: https://github.com/$owner/hinataw-cloudflare"
Write-Host "2. For Cloudflare Workers deployment:"
Write-Host "   - Install wrangler: npm install -g wrangler"
Write-Host "   - Login: wrangler login"
Write-Host "   - Deploy: cd freebuff && wrangler publish"
Write-Host "3. Or use the Freebuff Sites dashboard to deploy."
Write-Host "4. See DEPLOYMENT.md for detailed instructions."
