@echo off
rem Doble clic: arranca el Studio de Coronda y lo abre en el navegador.
rem Para cerrarlo, cerra esta ventana (o Ctrl+C).
cd /d "%~dp0"
title Coronda Studio
where node >nul 2>nul
if errorlevel 1 (
  echo No se encontro Node.js. Instalalo desde https://nodejs.org ^(version LTS^) y volve a abrir este archivo.
  pause
  exit /b
)
rem Abre el navegador 2 segundos despues, cuando el servidor ya esta andando
start "" /min cmd /c "timeout /t 2 /nobreak >nul & start "" http://localhost:5173/__studio"
node studio\server.js
echo.
echo El servidor se cerro. Si dice EADDRINUSE, ya habia otro Studio abierto.
pause
