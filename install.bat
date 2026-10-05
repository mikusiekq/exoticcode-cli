@echo off
cd /d "%~dp0"
where node >nul 2>nul || (echo Brak Node.js - zainstaluj z https://nodejs.org ^(wersja 20+^) & pause & exit /b 1)
echo Instaluje EXOTICCODE globalnie...
call npm install -g .
if errorlevel 1 (echo Instalacja nie powiodla sie. & pause & exit /b 1)
echo.
echo Gotowe! Otworz nowe okno cmd i wpisz: exoticcode
pause
