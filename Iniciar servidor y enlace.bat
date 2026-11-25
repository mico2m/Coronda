@echo off
rem Doble clic: prende el servidor de Coronda, abre el tunel de Cloudflare y te abre el enlace para tus amigos
rem (ademas lo copia: Ctrl+V para pegarlo). Quedan dos ventanas abiertas: servidor y tunel. Para apagar, cerralas.
cd /d "%~dp0"
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0servidor\iniciar.ps1"
