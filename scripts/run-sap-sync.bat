@echo off
setlocal
:: ============================================================================
:: HONEYWELL ECN MANAGER - BATCH RUNNER FOR AUTOMATED SAP SYNC (CRON / CMD)
:: ============================================================================
:: Navega al directorio raíz del proyecto
cd /d "%~dp0\.."

echo ============================================================================
echo   HONEYWELL ECN MANAGER - TAREA PROGRAMADA AUTOMATIZADA SAP GUI
echo ============================================================================
echo Fecha y hora de inicio: %date% %time%
echo Directorio de trabajo: %cd%

:: Ejecuta el script TypeScript standalone vía tsx
call npx tsx scripts/standalone-sap-sync.ts %*

set EXITCODE=%ERRORLEVEL%
echo Fecha y hora de finalizacion: %date% %time%
echo Codigo de salida: %EXITCODE%
echo ============================================================================

exit /b %EXITCODE%
