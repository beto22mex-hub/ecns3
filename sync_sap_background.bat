@echo off
setlocal

rem Usage: sync_sap_background.bat YYYY-MM-DD YYYY-MM-DD PLANT
if /I not "%~1"=="--worker" (
    if "%~3"=="" (
        echo Usage: %~nx0 YYYY-MM-DD YYYY-MM-DD PLANT
        exit /B 2
    )

    rem Launch a hidden worker so neither CMD nor curl is shown to the user.
    powershell.exe -NoProfile -NonInteractive -WindowStyle Hidden -Command "Start-Process -FilePath '%ComSpec%' -ArgumentList '/D /C call \"%~f0\" --worker \"%~1\" \"%~2\" \"%~3\"' -WindowStyle Hidden"
    echo SAP synchronization started in background for plant %~3.
    exit /B 0
)

shift
set "START_DATE=%~1"
set "END_DATE=%~2"
set "PLANT=%~3"
set "START_DATE=%START_DATE:.=-%"
set "END_DATE=%END_DATE:.=-%"
set "API_URL=%ECN_API_URL%"
if not defined API_URL set "API_URL=http://localhost:8080/api/sap/execute-sync"
set "LOG_DIR=%~dp0logs"
set "LOG_FILE=%LOG_DIR%\sap_sync_%PLANT%_%START_DATE%_%END_DATE%.log"

if not exist "%LOG_DIR%" mkdir "%LOG_DIR%" >nul 2>&1

>>"%LOG_FILE%" echo [%date% %time%] Starting SAP synchronization. Plant=%PLANT% StartDate=%START_DATE% EndDate=%END_DATE%

set "RESPONSE_FILE=%TEMP%\ecn_sap_sync_%RANDOM%.json"
curl.exe --silent --show-error --fail-with-body --connect-timeout 15 --max-time 3600 ^
    -H "Content-Type: application/json" ^
    --data-raw "{\"startDate\":\"%START_DATE%\",\"endDate\":\"%END_DATE%\",\"initialDate\":\"%START_DATE%\",\"finalDate\":\"%END_DATE%\",\"plant\":\"%PLANT%\",\"plants\":[\"%PLANT%\"]}" ^
    "%API_URL%" >"%RESPONSE_FILE%" 2>>"%LOG_FILE%"
set "EXIT_CODE=%ERRORLEVEL%"
if exist "%RESPONSE_FILE%" (
    type "%RESPONSE_FILE%" >>"%LOG_FILE%"
    findstr /C:"\"success\":true" "%RESPONSE_FILE%" >nul 2>&1
    if errorlevel 1 set "EXIT_CODE=1"
    if "%EXIT_CODE%"=="0" (
        >>"%LOG_FILE%" echo [%date% %time%] Updating SAP descriptions for created and updated ECNs.
        powershell.exe -NoProfile -NonInteractive -WindowStyle Hidden -ExecutionPolicy Bypass -Command "$r=Get-Content -Raw -LiteralPath '%RESPONSE_FILE%' | ConvertFrom-Json; $ids=@($r.newEcns)+@($r.updatedEcns); $failed=$false; foreach($id in $ids){ try { $b=ConvertTo-Json @{ ecnId=$id } -Compress; $descriptionUrl='%API_URL%'.Replace('/api/sap/execute-sync','/api/sap/update-missing-descriptions'); $d=Invoke-RestMethod -Uri $descriptionUrl -Method Post -ContentType 'application/json' -Body $b -TimeoutSec 120; ($id + ': ' + $d.message) | Add-Content -LiteralPath '%LOG_FILE%' } catch { ($id + ': ERROR ' + $_.Exception.Message) | Add-Content -LiteralPath '%LOG_FILE%'; $failed=$true } }; if($failed){ exit 1 }"
        if errorlevel 1 set "EXIT_CODE=1"
    )
    del /Q "%RESPONSE_FILE%" >nul 2>&1
)

>>"%LOG_FILE%" echo [%date% %time%] Closing generated SAP Excel workbooks.
powershell.exe -NoProfile -NonInteractive -WindowStyle Hidden -ExecutionPolicy Bypass -Command "$excel=$null; try { $excel=[Runtime.InteropServices.Marshal]::GetActiveObject('Excel.Application'); foreach($wb in @($excel.Workbooks)){ try { if(([string]$wb.Name) -like 'ECN_*.XLSX'){ $wb.Close($false) } } catch {} }; if($excel){ [Runtime.InteropServices.Marshal]::ReleaseComObject($excel) | Out-Null } } catch {}; foreach($p in @(Get-Process -Name EXCEL -ErrorAction SilentlyContinue)){ try { if($p.MainWindowTitle -like 'ECN_*.XLSX*' -or $p.MainWindowTitle -like 'ECN_* - Excel*'){ Stop-Process -Id $p.Id -Force -ErrorAction SilentlyContinue } } catch {} }" >>"%LOG_FILE%" 2>&1

if "%EXIT_CODE%"=="0" (
    >>"%LOG_FILE%" echo [%date% %time%] SAP synchronization completed successfully.
) else (
    >>"%LOG_FILE%" echo [%date% %time%] SAP synchronization failed with exit code %EXIT_CODE%.
)

exit /B %EXIT_CODE%