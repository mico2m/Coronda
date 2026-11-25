@echo off
rem Doble clic: abre el Coronda Studio. Si el servidor del juego no esta prendido, lo prende tambien
rem (asi la vista previa de index.html entra al mundo real). Para cerrar: cerra las ventanas.
cd /d "%~dp0"
title Coronda Studio
where node >nul 2>nul
if errorlevel 1 (
  echo No se encontro Node.js. Instalalo desde https://nodejs.org ^(version LTS^) y volve a abrir este archivo.
  pause
  exit /b
)
powershell -NoProfile -Command "try { Invoke-WebRequest http://localhost:8080/__coronda/estado -UseBasicParsing -TimeoutSec 2 | Out-Null; exit 0 } catch { exit 1 }"
if errorlevel 1 (
  echo Prendiendo tambien el servidor del juego...
  start "Servidor de Coronda (no cerrar)" cmd /k node servidor\coronda-server.mjs
)
rem Abre el navegador 2 segundos despues, cuando el Studio ya esta andando
start "" /min cmd /c "timeout /t 2 /nobreak >nul & start "" http://localhost:5173/__studio"
node studio\server.js
echo.
echo El Studio se cerro. Si dice EADDRINUSE, ya habia otro Studio abierto.
pause
