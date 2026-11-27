@echo off
rem Doble clic: abre Coronda en esta PC para gestionar el servidor. Si el servidor no esta prendido, lo prende.
rem Entra con tu cuenta ADMIN (la que esta en servidor\config.json > "admins") y abri el menu con Esc > Gestion del servidor.
rem Para apagar el servidor: cerra la ventana "Servidor de Coronda (no cerrar)".
cd /d "%~dp0"
title Coronda - Gestion del servidor
where node >nul 2>nul
if errorlevel 1 (
  echo No se encontro Node.js. Instalalo desde https://nodejs.org ^(version LTS^) y volve a abrir este archivo.
  pause
  exit /b
)
curl -s -f -o nul http://localhost:8080/__coronda/estado
if errorlevel 1 (
  echo Prendiendo el servidor del juego...
  start "Servidor de Coronda (no cerrar)" cmd /k node servidor\coronda-server.mjs
  timeout /t 3 /nobreak >nul
)
start "" http://localhost:8080
echo.
echo Listo. Entra con tu cuenta admin y abri el menu con Esc ^> Gestion del servidor.
echo Si tu servidor usa otro puerto (servidor\config.json), cambialo en este archivo.
timeout /t 8 >nul
