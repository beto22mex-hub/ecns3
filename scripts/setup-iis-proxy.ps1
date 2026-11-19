# =============================================================================
# ECN MANAGER - SCRIPT DE CONFIGURACIÓN AUTOMÁTICA DE IIS REVERSE PROXY & HTTPS
# Ejecutar como Administrador en Windows PowerShell
# =============================================================================

Write-Host "=======================================================" -ForegroundColor Cyan
Write-Host " Configurando IIS Reverse Proxy (ARR) para ECN Manager " -ForegroundColor Cyan
Write-Host "=======================================================" -ForegroundColor Cyan

$appCmd = "$env:windir\system32\inetsrv\appcmd.exe"

if (-not (Test-Path $appCmd)) {
    Write-Host "[ERROR] IIS no parece estar instalado en este equipo ($appCmd no encontrado)." -ForegroundColor Red
    Write-Host "Por favor instala IIS (Internet Information Services) desde Características de Windows." -ForegroundColor Yellow
    Exit 1
}

# 1. Habilitar Proxy en Application Request Routing (ARR) a nivel servidor
Write-Host "`n[1/4] Habilitando funcionalidad Proxy en ARR a nivel servidor..." -ForegroundColor Green
try {
    & $appCmd set config -section:system.webServer/proxy /enabled:True /commit:apphost
    & $appCmd set config -section:system.webServer/proxy /preserveHostHeader:True /commit:apphost
    & $appCmd set config -section:system.webServer/proxy /includeXForwardedFor:True /commit:apphost
    Write-Host "   -> ARR Proxy habilitado correctamente (PreserveHostHeader: True, IncludeXForwardedFor: True)." -ForegroundColor Gray
} catch {
    Write-Host "[ADVERTENCIA] No se pudo configurar la sección proxy en ARR. Verifica que 'Application Request Routing' esté instalado." -ForegroundColor Yellow
}

# 2. Registrar variables de servidor permitidas para URL Rewrite
Write-Host "`n[2/4] Registrando variables de servidor permitidas en URL Rewrite..." -ForegroundColor Green
$serverVars = @("HTTP_X_FORWARDED_PROTO", "HTTP_X_FORWARDED_HOST", "HTTP_X_FORWARDED_PORT")
foreach ($var in $serverVars) {
    try {
        & $appCmd set config -section:system.webServer/rewrite/allowedServerVariables /+"[name='$var']" /commit:apphost 2>$null
        Write-Host "   -> Variable permitida registrada: $var" -ForegroundColor Gray
    } catch {
        # Si ya existe, IIS lanza advertencia normal
    }
}

# 3. Comprobar si el backend Node.js (ECN Manager) está respondiendo en el puerto 3000
Write-Host "`n[3/4] Probando conexion con el backend Node.js en localhost:3000..." -ForegroundColor Green
try {
    $res = Invoke-RestMethod -Uri "http://127.0.0.1:3000/health" -TimeoutSec 3 -ErrorAction SilentlyContinue
    if ($res -eq "OK") {
        Write-Host "   -> ¡Backend Node.js detectado y respondiendo OK en http://127.0.0.1:3000/health!" -ForegroundColor Green
    } else {
        Write-Host "   -> Backend respondió: $res" -ForegroundColor Yellow
    }
} catch {
    Write-Host "   -> Nota: El backend Node.js no está corriendo en el puerto 3000 en este momento." -ForegroundColor Yellow
    Write-Host "      Inícialo con: npm start o pm2 start ecosystem.config.cjs" -ForegroundColor Gray
}

# 4. Resumen y siguientes pasos
Write-Host "`n=======================================================" -ForegroundColor Cyan
Write-Host " ¡CONFIGURACION DE PROXY REVERSO IIS COMPLETADA!" -ForegroundColor Cyan
Write-Host "=======================================================" -ForegroundColor Cyan
Write-Host "Puntos clave para tu sitio en IIS Manager:" -ForegroundColor White
Write-Host " 1. En IIS Manager, crea o selecciona tu Sitio Web (ej. 'ECN-Manager')." -ForegroundColor Gray
Write-Host " 2. Asegura que la 'Ruta de acceso física' apunte a la carpeta donde está 'web.config'." -ForegroundColor Gray
Write-Host " 3. En Enlaces (Bindings), agrega el enlace HTTPS en el puerto 443 con tu Certificado SSL corporativo." -ForegroundColor Gray
Write-Host " 4. Al ingresar por navegador con https://tudominio.com, IIS redirigirá HTTPS y ruteará todo el tráfico a Node.js." -ForegroundColor Gray
Write-Host ""
