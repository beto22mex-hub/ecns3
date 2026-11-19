@echo off
REM =========================================================================
REM INICIAR ECNS EN BACKGROUND CON PM2 (SIN VENTANA DE NODE)
REM =========================================================================
cd /d "%~dp0"

echo [1/3] Compilando frontend para produccion...
call npm run build

echo [2/3] Iniciando aplicacion 'ecns' en segundo plano con PM2...
call npx pm2 start ecosystem.config.cjs --env production

echo [3/3] Guardando estado de PM2...
call npx pm2 save

echo.
echo =========================================================================
echo  APLICACION ECNS INICIADA EN SEGUNDO PLANO EN PUERTO 3001
echo  Para ver el estado:       npx pm2 status
echo  Para ver los logs:        npx pm2 logs ecns
echo  Para detener la app:      npx pm2 stop ecns
echo  Para reiniciar la app:    npx pm2 restart ecns
echo =========================================================================
pause
