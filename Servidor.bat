@echo off
rem Doble clic: arranca el SERVIDOR de Coronda en esta PC (el mundo multijugador).
rem Para apagarlo: cerra esta ventana o Ctrl+C (guarda todo antes de salir).
cd /d "%~dp0"
title Servidor de Coronda
where node >nul 2>nul
if errorlevel 1 (
  echo No se encontro Node.js. Instalalo desde https://nodejs.org ^(version LTS^) y volve a abrir este archivo.
  pause
  exit /b
)
node servidor\coronda-server.mjs
echo.
echo El servidor se cerro. Si dice EADDRINUSE, ya habia otro servidor abierto en el mismo puerto.
pause
