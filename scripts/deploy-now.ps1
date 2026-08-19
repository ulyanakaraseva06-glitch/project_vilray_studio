$ErrorActionPreference = 'Stop'
Set-Location $PSScriptRoot\..

"=== git status ===" | Out-File deploy-output.txt -Encoding utf8
git status --short | Out-File deploy-output.txt -Append -Encoding utf8

"=== npm run build ===" | Out-File deploy-output.txt -Append -Encoding utf8
npm run build 2>&1 | Out-File deploy-output.txt -Append -Encoding utf8
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }

$changes = git status --porcelain
if ($changes) {
  "=== commit ===" | Out-File deploy-output.txt -Append -Encoding utf8
  git add -A
  git commit -m "Ship editor fixes: openings, room reset, drawing panel, object colors." 2>&1 | Out-File deploy-output.txt -Append -Encoding utf8
  git rev-parse HEAD | Out-File deploy-output.txt -Append -Encoding utf8
} else {
  "=== no changes to commit ===" | Out-File deploy-output.txt -Append -Encoding utf8
}

"=== push ===" | Out-File deploy-output.txt -Append -Encoding utf8
git push -u origin HEAD 2>&1 | Out-File deploy-output.txt -Append -Encoding utf8

"=== done exit $LASTEXITCODE ===" | Out-File deploy-output.txt -Append -Encoding utf8
