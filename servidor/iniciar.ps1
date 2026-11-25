# Arranca el servidor de Coronda y el túnel de Cloudflare, y abre el enlace para tus amigos.
# Lo usa "Iniciar servidor y enlace.bat" (doble clic). Ver servidor/README.md.
$ErrorActionPreference = 'SilentlyContinue'
$raiz = Split-Path -Parent $PSScriptRoot
Set-Location $raiz
$Host.UI.RawUI.WindowTitle = 'Coronda - enlace para tus amigos'
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12

function Responde($url) {
  try { $r = Invoke-WebRequest "$url/__coronda/estado" -UseBasicParsing -TimeoutSec 3; return $r.StatusCode -eq 200 } catch { return $false }
}

if (-not (Get-Command node)) { Write-Host 'No se encontro Node.js. Instalalo desde https://nodejs.org (version LTS).' -ForegroundColor Red; Read-Host 'Enter para salir'; exit }
if (-not (Get-Command cloudflared)) {
  Write-Host 'No esta instalado cloudflared (el tunel).' -ForegroundColor Yellow
  Write-Host 'Instalalo con:  winget install --id Cloudflare.cloudflared   y volve a abrir este archivo.'
  Read-Host 'Enter para salir'; exit
}

# 1) El servidor (en su propia ventana). Si ya estaba prendido, se usa ese.
if (Responde 'http://localhost:8080') {
  Write-Host 'El servidor ya estaba prendido.' -ForegroundColor Green
} else {
  Write-Host 'Prendiendo el servidor...'
  Start-Process cmd -ArgumentList '/k', 'title Servidor de Coronda (no cerrar) && node servidor\coronda-server.mjs' -WorkingDirectory $raiz
  $ok = $false
  for ($i = 0; $i -lt 30 -and -not $ok; $i++) { Start-Sleep 1; $ok = Responde 'http://localhost:8080' }
  if (-not $ok) { Write-Host 'El servidor no arranco. Mira la ventana "Servidor de Coronda".' -ForegroundColor Red; Read-Host 'Enter para salir'; exit }
  Write-Host 'Servidor prendido.' -ForegroundColor Green
}

# 2) El tunel (en su propia ventana). Escribe un registro de donde se saca el enlace.
$log = Join-Path $env:TEMP 'coronda-tunel.log'
Remove-Item $log -Force
Write-Host 'Abriendo el tunel de Cloudflare...'
Start-Process cmd -ArgumentList '/k', "title Tunel de Coronda (no cerrar) && cloudflared tunnel --url http://localhost:8080 --logfile `"$log`"" -WorkingDirectory $raiz

$enlace = $null
for ($i = 0; $i -lt 60 -and -not $enlace; $i++) {
  Start-Sleep 1
  $m = Select-String -Path $log -Pattern 'https://[a-z0-9-]+\.trycloudflare\.com' | Select-Object -First 1
  if ($m) { $enlace = $m.Matches[0].Value }
}
if (-not $enlace) { Write-Host 'No aparecio el enlace. Mira la ventana "Tunel de Coronda".' -ForegroundColor Red; Read-Host 'Enter para salir'; exit }

# 3) Esperar a que el enlace ande (tarda unos segundos en activarse) y abrirlo
Write-Host "Enlace: $enlace (activandose...)"
for ($i = 0; $i -lt 40; $i++) { if (Responde $enlace) { break }; Start-Sleep 1 }
Set-Content -Path (Join-Path $raiz 'servidor\enlace-actual.txt') -Value $enlace
Set-Clipboard -Value $enlace
Start-Process $enlace

Write-Host ''
Write-Host '  =====================================================' -ForegroundColor Yellow
Write-Host '   Enlace para tus amigos (ya esta copiado, Ctrl+V):' -ForegroundColor Yellow
Write-Host ''
Write-Host "   $enlace" -ForegroundColor Cyan
Write-Host ''
Write-Host '   Vos podes entrar tambien por  http://localhost:8080' -ForegroundColor Yellow
Write-Host '  =====================================================' -ForegroundColor Yellow
Write-Host ''
Write-Host 'Dejá abiertas las ventanas "Servidor de Coronda" y "Tunel de Coronda".'
Write-Host 'Para apagar todo: cerra esas dos ventanas. Esta la podes cerrar.'
Write-Host 'Cada vez que abris el tunel el enlace cambia (queda anotado en servidor\enlace-actual.txt).'
Read-Host 'Enter para cerrar esta ventana'
