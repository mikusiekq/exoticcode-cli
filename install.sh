#!/usr/bin/env bash
# Instalator EXOTICCODE dla macOS / Linux:
#   curl -fsSL https://raw.githubusercontent.com/mikusiekq/exoticcode-cli/main/install.sh | bash
set -euo pipefail
URL="https://github.com/mikusiekq/exoticcode-cli/releases/latest/download/exoticcode.tgz"

printf '\n  \033[35mEXOTICCODE\033[0m - instalacja\n'

if ! command -v node >/dev/null 2>&1; then
  echo "  Brak Node.js. Zainstaluj Node 20 lub nowszy: https://nodejs.org"
  exit 1
fi
MAJOR="$(node -p 'process.versions.node.split(".")[0]')"
if [ "$MAJOR" -lt 20 ]; then
  echo "  Masz Node $(node -v) - potrzebny jest Node 20 lub nowszy: https://nodejs.org"
  exit 1
fi

echo "  Pobieram i instaluję najnowszą wersję..."
if ! npm install -g "$URL" --prefer-online --no-fund --no-audit --loglevel=error; then
  echo "  Instalacja nie powiodła się. Jeśli to błąd uprawnień, spróbuj: sudo npm install -g $URL"
  exit 1
fi
printf '\n  \033[32mGotowe!\033[0m Wpisz: exoticcode\n\n'
