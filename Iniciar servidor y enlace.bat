@echo off
rem Doble clic: prende el servidor de Coronda, abre el tunel de Cloudflare y te abre el enlace para tus amigos
rem (ademas lo copia: Ctrl+V para pegarlo). El trabajo lo hace servidor\iniciar.mjs. Para apagar, cerra las ventanas.
cd /d "%~dp0"
title Coronda - enlace para tus amigos
chcp 65001 >nul
where node >nul 2>nul
if errorlevel 1 goto sin_node
node servidor\iniciar.mjs
goto fin
:sin_node
echo No se encontro Node.js. Instalalo desde https://nodejs.org (version LTS) y volve a abrir este archivo.
:fin
echo.
pause
