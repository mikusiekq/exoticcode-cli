# Instalator EXOTICCODE dla Windows:
#   irm https://raw.githubusercontent.com/mikusiekq/exoticcode-cli/main/install.ps1 | iex
$ErrorActionPreference = 'Stop'
$url = 'https://github.com/mikusiekq/exoticcode-cli/releases/latest/download/exoticcode.tgz'

Write-Host ''
Write-Host '  EXOTICCODE - instalacja' -ForegroundColor Magenta

$node = Get-Command node -ErrorAction SilentlyContinue
if (-not $node) {
  Write-Host '  Brak Node.js. Zainstaluj Node 20 lub nowszy: https://nodejs.org' -ForegroundColor Yellow
  return
}
$major = [int]((node -v).TrimStart('v').Split('.')[0])
if ($major -lt 20) {
  Write-Host "  Masz Node $(node -v) - potrzebny jest Node 20 lub nowszy: https://nodejs.org" -ForegroundColor Yellow
  return
}

Write-Host '  Pobieram i instaluje najnowsza wersje...'
npm install -g $url --prefer-online --no-fund --no-audit --loglevel=error
if ($LASTEXITCODE -ne 0) {
  Write-Host '  Instalacja nie powiodla sie.' -ForegroundColor Red
  return
}
Write-Host ''
Write-Host '  Gotowe! Otworz nowe okno terminala i wpisz: exoticcode' -ForegroundColor Green
Write-Host ''
