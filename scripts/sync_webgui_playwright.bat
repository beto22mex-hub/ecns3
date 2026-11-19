@echo off
setlocal enabledelayedexpansion

title Honeywell ECN Manager - Sincronizacion SAP WebGUI Playwright

echo =========================================================================
echo   HONEYWELL ECN MANAGER - AUTOMATIZADOR PLAYWRIGHT SAP WEBGUI
echo =========================================================================
echo Fecha y Hora: %date% %time%
echo Directorio:   %~dp0
echo =========================================================================
echo.

:: 1. Verificar si Node.js esta instalado
where node >nul 2>&1
if %errorlevel% neq 0 (
    echo [ERROR CRITICO] Node.js no esta instalado en este equipo.
    echo.
    echo Para ejecutar este script desatendido:
    echo  1. Descargue e instale Node.js (version LTS recomendada):
    echo     https://nodejs.org
    echo  2. O en PowerShell como Administrador ejecute:
    echo     winget install OpenJS.NodeJS.LTS
    echo.
    echo Presione cualquier tecla para salir...
    pause >nul
    exit /b 1
)

:: 2. Ir al directorio donde se encuentra este archivo .bat
cd /d "%~dp0"

:: 3. Verificar si existe node_modules con playwright
if not exist "node_modules\playwright" (
    echo [1/3] Configurando Playwright para Microsoft Edge por primera vez...
    echo Esto solo tomara un momento...
    call npm install playwright --no-audit --no-fund --loglevel=error
    if %errorlevel% neq 0 (
        echo [AVISO] Intentando instalar Playwright localmente...
        call npx -y playwright --version >nul 2>&1
    )
)

:: 4. Solicitar o configurar parametros (con valores por defecto)
set "PLANT_PARAM=%~1"
if "%PLANT_PARAM%"=="" (
    set "PLANT_PARAM=5205"
)

set "START_DATE_PARAM=%~2"
set "END_DATE_PARAM=%~3"

echo [2/3] Parametros para SAP WebGUI:
echo       - Planta:      %PLANT_PARAM%
if not "%START_DATE_PARAM%"=="" echo       - Fecha Inicio: %START_DATE_PARAM%
if not "%END_DATE_PARAM%"==""   echo       - Fecha Fin:    %END_DATE_PARAM%
echo.

:: 5. Ejecutar script de automatizacion
echo [3/3] Iniciando navegador Microsoft Edge corporativo con Playwright...
echo       Se abrira Edge e iniciara sesion mediante Honeywell SSO...
echo.

node "%~dp0sync_webgui_playwright.js" "%PLANT_PARAM%" "%START_DATE_PARAM%" "%END_DATE_PARAM%"

set "SCRIPT_EXIT=%errorlevel%"
echo.
echo =========================================================================
if "%SCRIPT_EXIT%"=="0" (
    echo  [OK] Sincronizacion WebGUI finalizada.
    if exist "%~dp0downloads" (
        echo  Los reportes descargados se guardaron en:
        echo  %~dp0downloads
        echo.
        set /p OPEN_FOLDER="Desea abrir la carpeta de descargas ahora? (S/N): "
        if /i "!OPEN_FOLDER!"=="S" explorer.exe "%~dp0downloads"
    )
) else (
    echo  [AVISO] El proceso termino con codigo: %SCRIPT_EXIT%
)
echo =========================================================================
echo Presione cualquier tecla para cerrar esta ventana...
pause >nul
exit /b %SCRIPT_EXIT%
