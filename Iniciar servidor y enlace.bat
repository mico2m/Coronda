@echo off
setlocal EnableDelayedExpansion
rem Doble clic: prende el servidor de Coronda, abre el tunel de Cloudflare y te abre el enlace para tus amigos
rem (ademas lo copia: Ctrl+V para pegarlo). Quedan dos ventanas abiertas: servidor y tunel. Para apagar, cerralas.
cd /d "%~dp0"
title Coronda - enlace para tus amigos
echo.
echo  Coronda: servidor + enlace
echo  ==========================
echo.

where node >nul 2>nul
if errorlevel 1 goto :sin_node
where cloudflared >nul 2>nul
if errorlevel 1 goto :sin_cloudflared
where curl >nul 2>nul
if errorlevel 1 goto :sin_curl

rem ---------- 1) El servidor, en su propia ventana (si ya estaba prendido, se usa ese) ----------
curl -s -f -o nul http://localhost:8080/__coronda/estado
if not errorlevel 1 goto :servidor_ya
echo  Prendiendo el servidor...
start "Servidor de Coronda (no cerrar)" cmd /k node servidor\coronda-server.mjs
set /a intentos=0
:esperar_servidor
timeout /t 1 /nobreak >nul
curl -s -f -o nul http://localhost:8080/__coronda/estado
if not errorlevel 1 goto :servidor_ok
set /a intentos+=1
if !intentos! lss 30 goto :esperar_servidor
echo  El servidor no arranco. Mira la ventana "Servidor de Coronda".
goto :fin
:servidor_ya
echo  El servidor ya estaba prendido.
:servidor_ok
echo  Servidor prendido: http://localhost:8080

rem ---------- 2) El tunel, en su propia ventana ----------
set "LOG=%TEMP%\coronda-tunel.log"
if exist "%LOG%" del /q "%LOG%"
echo  Abriendo el tunel de Cloudflare...
start "Tunel de Coronda (no cerrar)" cmd /k cloudflared tunnel --url http://localhost:8080 --metrics 127.0.0.1:20241 --logfile "%LOG%"
set "ENLACE="
set /a intentos=0
:esperar_enlace
timeout /t 1 /nobreak >nul
rem a) se lo pregunta a cloudflared:  {"hostname":"algo.trycloudflare.com"}
for /f tokens^=2^ delims^=^"^:^{^} %%H in ('curl -s http://127.0.0.1:20241/quicktunnel 2^>nul') do set "ENLACE=https://%%H"
if defined ENLACE goto :enlace_ok
rem b) si no, lo busca en lo que escribe el tunel
if exist "%LOG%" for /f "delims=" %%L in ('findstr /r /c:"https://[a-z0-9-]*\.trycloudflare\.com" "%LOG%" 2^>nul') do set "LINEA=%%L"
if defined LINEA (
  set "RESTO=!LINEA:*https://=!"
  set "RESTO=!RESTO:"= !"
  for /f "tokens=1 delims=| " %%U in ("!RESTO!") do set "ENLACE=https://%%U"
)
if defined ENLACE goto :enlace_ok
set /a intentos+=1
if !intentos! lss 60 goto :esperar_enlace
echo  No aparecio el enlace. Mira la ventana "Tunel de Coronda".
goto :fin

:enlace_ok
rem ---------- 3) Esperar a que el enlace ande (tarda unos segundos en activarse) y abrirlo ----------
echo  Enlace: %ENLACE%   (activandose, puede tardar unos segundos...)
set /a intentos=0
:esperar_activo
curl -s -f -o nul "%ENLACE%/__coronda/estado"
if not errorlevel 1 goto :activo
set /a intentos+=1
if !intentos! geq 40 goto :activo
timeout /t 1 /nobreak >nul
goto :esperar_activo
:activo
> "servidor\enlace-actual.txt" echo %ENLACE%
<nul set /p "=%ENLACE%" | clip
start "" "%ENLACE%"
echo.
echo  =====================================================
echo   Enlace para tus amigos (ya esta copiado, Ctrl+V):
echo.
echo     %ENLACE%
echo.
echo   Vos podes entrar tambien por  http://localhost:8080
echo  =====================================================
echo.
echo  Deja abiertas las ventanas "Servidor de Coronda" y "Tunel de Coronda".
echo  Para apagar todo: cerra esas dos ventanas. Esta la podes cerrar.
echo  Cada vez que abris el tunel el enlace cambia (queda en servidor\enlace-actual.txt).
goto :fin

:sin_node
echo  No se encontro Node.js. Instalalo desde https://nodejs.org (version LTS) y volve a abrir este archivo.
goto :fin
:sin_cloudflared
echo  No esta instalado cloudflared (el tunel). Instalalo con:
echo     winget install --id Cloudflare.cloudflared
echo  y despues cerra esta ventana y volve a abrir este archivo.
goto :fin
:sin_curl
echo  Falta curl (viene con Windows 10 y 11). Usa Servidor.bat y abri el tunel a mano.
goto :fin

:fin
echo.
pause
