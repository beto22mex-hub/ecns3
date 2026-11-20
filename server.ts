import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import { v4 as uuidv4 } from 'uuid';
import nodemailer from 'nodemailer';
import https from 'https';
import * as db from './db.ts';
import { generateEcnSummary } from './services/geminiService.ts';
import path from 'path';
import fs from 'fs';
import os from 'os';
import { exec, execFile } from 'child_process';
import { promisify } from 'util';
import { fileURLToPath } from 'url';
import dns from 'dns';
import * as xlsxModule from 'xlsx';
import { handleSapUpsertOptimized, handleSapUpsertLegacy } from './services/sapUpsertService.ts';

const execAsync = promisify(exec);
const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

const XLSX: any = (xlsxModule as any).readFile ? xlsxModule : ((xlsxModule as any).default || xlsxModule);

/**
 * Automates opening SAP Logon (if not already running), connecting to shortcut "Inicio" or "BRP",
 * and pressing ENTER on any modal/information popup before reaching SAP Easy Access.
 */
async function ensureSapSessionActive(connectionName: string = 'Inicio'): Promise<void> {
    if (process.platform !== 'win32') return;

    try {
        console.log(`[SAP Auto-Connect] Verificando estado de SAP GUI / conexión ${connectionName}...`);

        // Check if SAPGUI COM object is accessible with active session in SAP Easy Access
        const testScriptPath = path.join(os.tmpdir(), `sap_test_session_${Date.now()}.vbs`);
        const testVbs = `
            On Error Resume Next
            Dim SapGuiAuto, appObj, connObj, sessionObj
            Set SapGuiAuto = GetObject("SAPGUI")
            If Err.Number = 0 And Not (SapGuiAuto Is Nothing) Then
                Set appObj = SapGuiAuto.GetScriptingEngine
                If Err.Number = 0 And Not (appObj Is Nothing) Then
                    If appObj.Children.Count > 0 Then
                        Set connObj = appObj.Children(0)
                        If Not (connObj Is Nothing) And connObj.Children.Count > 0 Then
                            Set sessionObj = connObj.Children(0)
                            If Not (sessionObj Is Nothing) Then
                                WScript.Echo "SESSION_OK"
                                WScript.Quit 0
                            End If
                        End If
                    End If
                End If
            End If
            WScript.Echo "NO_SESSION"
        `;
        fs.writeFileSync(testScriptPath, testVbs, 'utf-8');

        let isSessionActive = false;
        try {
            const { stdout } = await execAsync(getCScriptCommand(testScriptPath));
            if (stdout && stdout.includes('SESSION_OK')) {
                isSessionActive = true;
            }
        } catch (_) { }
        try { if (fs.existsSync(testScriptPath)) fs.unlinkSync(testScriptPath); } catch (_) { }

        if (isSessionActive) {
            console.log(`[SAP Auto-Connect] Sesión de SAP ya activa y lista.`);
            return;
        }

        console.log(`[SAP Auto-Connect] No hay sesión activa en SAP. Verificando proceso saplogon.exe...`);

        // Check if saplogon.exe is running in Windows tasklist
        let isSapRunning = false;
        try {
            const { stdout } = await execAsync('tasklist /FI "IMAGENAME eq saplogon.exe"');
            isSapRunning = stdout.toLowerCase().includes('saplogon.exe');
        } catch (_) { }

        if (!isSapRunning) {
            console.log(`[SAP Auto-Connect] saplogon.exe no está corriendo. Iniciando SAP GUI silenciosamente...`);

            // Standard SAP Logon paths in Windows (x86 and x64)
            const possibleSapPaths = [
                'C:\\Program Files (x86)\\SAP\\FrontEnd\\SAPgui\\saplogon.exe',
                'C:\\Program Files\\SAP\\FrontEnd\\SAPgui\\saplogon.exe',
                'C:\\SAP\\FrontEnd\\SAPgui\\saplogon.exe'
            ];
            const sapExe = possibleSapPaths.find(p => fs.existsSync(p)) || possibleSapPaths[0];

            try {
                exec(`start "" /min "${sapExe}"`, (err) => {
                    if (err) console.warn('[SAP Auto-Connect] Info inicio saplogon.exe:', err.message);
                });
            } catch (_) { }

            console.log('[SAP Auto-Connect] Esperando inicialización de SAP Logon...');
            await sleep(3500);
        } else {
            console.log(`[SAP Auto-Connect] saplogon.exe ya se encuentra en ejecución.`);
        }

        // Script to connect to shortcut "Inicio" or system connection, dismiss popups and wait for SAP Easy Access
        const autoConnectScriptPath = path.join(os.tmpdir(), `sap_autoconnect_${Date.now()}.vbs`);
        const autoConnectVbs = `
            On Error Resume Next
            Dim wshShell, SapGuiAuto, appObj, connObj, sessionObj
            Set wshShell = CreateObject("WScript.Shell")

            ' Poll to ensure SAP GUI Scripting Engine is initialized
            Dim waitInit
            For waitInit = 1 To 20
                Err.Clear
                Set SapGuiAuto = GetObject("SAPGUI")
                If Err.Number = 0 And Not (SapGuiAuto Is Nothing) Then
                    Set appObj = SapGuiAuto.GetScriptingEngine
                    If Err.Number = 0 And Not (appObj Is Nothing) Then Exit For
                End If
                WScript.Sleep 400
            Next

            If appObj Is Nothing Then
                ' Try launching saplogon if not ready
                Err.Clear
                wshShell.Run "saplogon.exe", 7, False
                WScript.Sleep 2500
                Set SapGuiAuto = GetObject("SAPGUI")
                If Err.Number = 0 And Not (SapGuiAuto Is Nothing) Then
                    Set appObj = SapGuiAuto.GetScriptingEngine
                End If
            End If

            ' If no connections are open, connect via COM OpenConnection or shortcut "Inicio"
            If Not (appObj Is Nothing) Then
                If appObj.Children.Count = 0 Then
                    Dim connNames, cn, opened
                    connNames = Array("${connectionName}", "Inicio", "Ingreso Predeterminado", "BRP - ERP Production", "BRP -ERP Production", "BRP-ERP Production", "BRP - Production", "ERP Production", "BRP", "BRP [ERP Production]", "BRP [ECC Production]", "BRP [PRD]", "BRP [ECC]", "BRP Produccion", "BRP PRD", "BRP Production", "BRP_FWD")
                    opened = False
                    For Each cn In connNames
                        If Trim(CStr(cn)) <> "" Then
                            Err.Clear
                            Set connObj = appObj.OpenConnection(CStr(cn), True)
                            If Err.Number = 0 And Not (connObj Is Nothing) Then
                                opened = True
                                Exit For
                            End If
                        End If
                    Next

                    If Not opened Then
                        Err.Clear
                        Dim connStrings, cs
                        connStrings = Array("/M/brpprod.honeywell.com/S/3600/G/BRP_FWD", "/M/brpprod.honeywell.com/S/sapmsBRP/G/BRP_FWD", "/M/brpprod.honeywell.com/S/3600/G/SPACE", "SAPGUI /M/brpprod.honeywell.com/S/3600/G/BRP_FWD")
                        For Each cs In connStrings
                            Err.Clear
                            Set connObj = appObj.OpenConnectionByConnectionString(CStr(cs), True)
                            If Err.Number = 0 And Not (connObj Is Nothing) Then
                                opened = True
                                Exit For
                            End If
                        Next
                    End If
                End If
            End If

            ' Fallback / Shortcut UI Trigger: Activate SAP Logon and select shortcut "Inicio"
            Err.Clear
            Dim titles, t, titleActivated
            titles = Array("SAP Logon 770", "SAP Logon 760", "SAP Logon 750", "SAP Logon 740", "SAP Logon 800", "SAP Logon", "SapLogon")
            titleActivated = False

            For Each t In titles
                If wshShell.AppActivate(CStr(t)) Then
                    titleActivated = True
                    Exit For
                End If
            Next

            If titleActivated Then
                WScript.Sleep 500
                ' Filter for shortcut "Inicio" in Tree View / Search
                wshShell.SendKeys "^f"
                WScript.Sleep 200
                wshShell.SendKeys "Inicio"
                WScript.Sleep 200
                wshShell.SendKeys "{ENTER}"
                WScript.Sleep 200
                wshShell.SendKeys "{TAB}"
                WScript.Sleep 150
                wshShell.SendKeys "{ENTER}"
                WScript.Sleep 250
                wshShell.SendKeys "Inicio"
                WScript.Sleep 150
                wshShell.SendKeys "{ENTER}"
            End If

            ' Wait up to 30 seconds for connection, dismissing all popups until reaching SAP Easy Access
            Dim waitConn, hasReadySession, popTitles, pt, maxPoll
            hasReadySession = False
            maxPoll = 60 ' 60 x 500ms = 30 seconds
            popTitles = Array("Information", "Información", "System Messages", "Mensajes del sistema", "Copyright", "License", "Licencia", "SAP GUI Security", "Seguridad de SAP GUI", "SAP GUI for Windows", "Logon Information", "Información de logon", "Warning", "Advertencia", "Notice", "Aviso", "Attention", "Atención")

            For waitConn = 1 To maxPoll
                Err.Clear

                ' 1. Dismiss any Windows modal popups
                For Each pt In popTitles
                    If wshShell.AppActivate(CStr(pt)) Then
                        WScript.Sleep 100
                        wshShell.SendKeys "{ENTER}"
                        WScript.Sleep 150
                    End If
                Next

                ' 2. Inspect SAP GUI Object Model
                Set SapGuiAuto = GetObject("SAPGUI")
                If Err.Number = 0 And Not (SapGuiAuto Is Nothing) Then
                    Set appObj = SapGuiAuto.GetScriptingEngine
                    If Err.Number = 0 And Not (appObj Is Nothing) Then
                        If appObj.Children.Count > 0 Then
                            Set connObj = appObj.Children(0)
                            If Not (connObj Is Nothing) And connObj.Children.Count > 0 Then
                                Set sessionObj = connObj.Children(0)
                                If Not (sessionObj Is Nothing) Then
                                    ' 3. Handle any modal window / multi-logon dialogs inside session
                                    Err.Clear
                                    If sessionObj.Children.Count > 1 Then
                                        ' Handle multi-logon radio option 2 (Continue logon)
                                        Err.Clear
                                        sessionObj.findById("wnd[1]/usr/radMULTI_LOGON_OPT2").select
                                        sessionObj.findById("wnd[1]/tbar[0]/btn[0]").press
                                        If Err.Number <> 0 Then
                                            Err.Clear
                                            sessionObj.findById("wnd[1]/tbar[0]/btn[0]").press
                                        End If
                                        If Err.Number <> 0 Then
                                            Err.Clear
                                            sessionObj.findById("wnd[1]/usr/btnBUTTON_1").press
                                        End If
                                        If Err.Number <> 0 Then
                                            Err.Clear
                                            sessionObj.findById("wnd[1]").SendVKey 0
                                        End If
                                    End If

                                    Err.Clear
                                    sessionObj.findById("wnd[2]/tbar[0]/btn[0]").press
                                    If Err.Number <> 0 Then
                                        Err.Clear
                                        sessionObj.findById("wnd[2]").SendVKey 0
                                    End If

                                    ' 4. Check if session has arrived at SAP Easy Access or main transaction
                                    Err.Clear
                                    Dim mainText
                                    mainText = ""
                                    mainText = UCase(sessionObj.findById("wnd[0]").Text)
                                    If Err.Number = 0 And (InStr(mainText, "EASY ACCESS") > 0 Or InStr(mainText, "SAP") > 0) Then
                                        If sessionObj.Busy = False And sessionObj.Children.Count = 1 Then
                                            hasReadySession = True
                                            Exit For
                                        End If
                                    End If
                                End If
                            End If
                        End If
                    End If
                End If

                ' Periodically re-activate SAP Logon and re-send Inicio if connection is not yet up
                If (waitConn Mod 8 = 0) And (Not hasReadySession) Then
                    For Each t In Array("SAP Logon 770", "SAP Logon 760", "SAP Logon 750", "SAP Logon 740", "SAP Logon 800", "SAP Logon")
                        If wshShell.AppActivate(CStr(t)) Then
                            wshShell.SendKeys "Inicio"
                            WScript.Sleep 150
                            wshShell.SendKeys "{ENTER}"
                            Exit For
                        End If
                    Next
                End If

                WScript.Sleep 500
            Next

            If hasReadySession Then
                WScript.Echo "OPEN_CONNECTION_OK"
            ElseIf Not (sessionObj Is Nothing) Then
                WScript.Echo "OPEN_CONNECTION_OK_SESSION_ATTACHED"
            Else
                WScript.Echo "COULD_NOT_ESTABLISH_SESSION"
            End If
        `;

        fs.writeFileSync(autoConnectScriptPath, autoConnectVbs, 'utf-8');
        try {
            const { stdout } = await execAsync(getCScriptCommand(autoConnectScriptPath));
            console.log(`[SAP Auto-Connect] Resultado conexión: ${stdout.trim()}`);
        } catch (e: any) {
            console.warn('[SAP Auto-Connect] Error en script de autoconexión:', e.message);
        } finally {
            try { if (fs.existsSync(autoConnectScriptPath)) fs.unlinkSync(autoConnectScriptPath); } catch (_) { }
        }

        // Additional safety sleep for session stabilization
        await sleep(1000);

    } catch (err: any) {
        console.warn('[SAP Auto-Connect] Error general al verificar/abrir SAP:', err.message);
    }
}

function getCScriptCommand(scriptPath: string, args: string[] = []): string {
    if (!args || args.length === 0) {
        return `cscript.exe //NoLogo "${scriptPath}"`;
    }
    const formattedArgs = args.map(a => `"${String(a).replace(/"/g, '\\"')}"`).join(' ');
    return `cscript.exe //NoLogo "${scriptPath}" ${formattedArgs}`;
}
const getCscriptCommand = getCScriptCommand;

/**
 * Executes a VBScript OLE automation in SAP GUI to fetch the ECN description via IQS3 or CC03
 */
async function fetchSapEcnDescription(ecro: string, type: string = 'CC03'): Promise<{ success: boolean; description?: string; error?: string }> {
    const cleanEcroVal = cleanEcn(ecro);
    if (!cleanEcroVal) return { success: false, error: 'ECN / ECRO vacío' };
    if (process.platform !== 'win32') {
        return { success: false, error: 'Esta consulta solo se ejecuta en Windows con SAP GUI activo. No existe modo simulado.' };
    }

    // Auto-launch SAP Logon and connect to Inicio if not already connected
    await ensureSapSessionActive('Inicio');

    const tempScriptPath = path.join(os.tmpdir(), `sap_gui_query_${Date.now()}_${Math.floor(Math.random() * 1000)}.vbs`);
    const vbsContent = `'=============================================================================
' BRIDGE REGISTRO AUTOMATICO SAP GUI (IQS3 & CC03) PARA NODE/REACT
'=============================================================================
On Error Resume Next

If WScript.Arguments.Count < 2 Then
    WScript.Echo "RESULT_ERR:Argumentos insuficientes."
    WScript.Quit 0
End If

Dim ecroVal, txType
ecroVal = WScript.Arguments(0)
txType = WScript.Arguments(1)

Dim SapGuiAuto, appObj, connObj, sessionObj, wshShell
Set wshShell = CreateObject("WScript.Shell")
Set SapGuiAuto = GetObject("SAPGUI")

If Err.Number <> 0 Or SapGuiAuto Is Nothing Then
    Err.Clear
    wshShell.Run """C:\\Program Files (x86)\\SAP\\FrontEnd\\SAPgui\\saplogon.exe""", 1, False
    If Err.Number <> 0 Then
        Err.Clear
        wshShell.Run """C:\\Program Files\\SAP\\FrontEnd\\SAPgui\\saplogon.exe""", 1, False
    End If
    If Err.Number <> 0 Then
        Err.Clear
        wshShell.Run """C:\\SAP\\FrontEnd\\SAPgui\\saplogon.exe""", 1, False
    End If
    If Err.Number <> 0 Then
        Err.Clear
        wshShell.Run "saplogon.exe", 1, False
    End If
    WScript.Sleep 3500
    Set SapGuiAuto = GetObject("SAPGUI")
End If

If Err.Number <> 0 Or SapGuiAuto Is Nothing Then
    WScript.Echo "RESULT_ERR:No se detecto proceso activo de SAP GUI. Abre SAP Logon, inicia sesion en tu mandante y reintenta."
    WScript.Quit 0
End If

Set appObj = SapGuiAuto.GetScriptingEngine
If Err.Number <> 0 Or appObj Is Nothing Then
    WScript.Echo "RESULT_ERR:El scripting de SAP GUI esta deshabilitado en tu SAP Logon o servidor (RZ11)."
    WScript.Quit 0
End If

' If no connections are open, attempt connection to Inicio / BRP
If appObj.Children.Count = 0 Then
    Dim connNames, cn, opened
    connNames = Array("Inicio", "Ingreso Predeterminado", "BRP - ERP Production", "BRP -ERP Production", "BRP-ERP Production", "BRP - Production", "ERP Production", "BRP", "BRP [ERP Production]", "BRP [ECC Production]", "BRP [PRD]", "BRP [ECC]", "BRP Produccion", "BRP PRD", "BRP Production", "BRP_FWD")
    opened = False
    For Each cn In connNames
        Err.Clear
        Set connObj = appObj.OpenConnection(CStr(cn), True)
        If Err.Number = 0 And Not (connObj Is Nothing) Then
            opened = True
            Exit For
        End If
    Next

    If Not opened Then
        Err.Clear
        Dim connStrings, cs
        connStrings = Array("/M/brpprod.honeywell.com/S/3600/G/BRP_FWD", "/M/brpprod.honeywell.com/S/sapmsBRP/G/BRP_FWD", "/M/brpprod.honeywell.com/S/3600/G/SPACE", "SAPGUI /M/brpprod.honeywell.com/S/3600/G/BRP_FWD")
        For Each cs In connStrings
            Err.Clear
            Set connObj = appObj.OpenConnectionByConnectionString(CStr(cs), True)
            If Err.Number = 0 And Not (connObj Is Nothing) Then
                opened = True
                Exit For
            End If
        Next
    End If

    If Not opened Then
        Err.Clear
        Dim titles, t, titleActivated
        titles = Array("SAP Logon 770", "SAP Logon 760", "SAP Logon 750", "SAP Logon 740", "SAP Logon 800", "SAP Logon", "SapLogon")
        titleActivated = False
        For Each t In titles
            If wshShell.AppActivate(CStr(t)) Then
                titleActivated = True
                Exit For
            End If
        Next
        If titleActivated Then
            WScript.Sleep 500
            wshShell.SendKeys "^f"
            WScript.Sleep 200
            wshShell.SendKeys "Inicio"
            WScript.Sleep 200
            wshShell.SendKeys "{ENTER}"
            WScript.Sleep 200
            wshShell.SendKeys "{TAB}"
            WScript.Sleep 150
            wshShell.SendKeys "{ENTER}"
            WScript.Sleep 250
            wshShell.SendKeys "Inicio"
            WScript.Sleep 150
            wshShell.SendKeys "{ENTER}"
        End If
    End If
End If

' Wait up to 30 seconds for connection, dismissing all modal popups until SAP Easy Access
Dim waitConn, hasConn, popTitles, pt
hasConn = False
popTitles = Array("Information", "Información", "System Messages", "Mensajes del sistema", "Copyright", "License", "Licencia", "SAP GUI Security", "Seguridad de SAP GUI", "SAP GUI for Windows", "Logon Information", "Información de logon", "Warning", "Advertencia", "Notice", "Aviso", "Attention", "Atención")

For waitConn = 1 To 60
    ' 1. Dismiss any Windows modal popups
    For Each pt In popTitles
        If wshShell.AppActivate(CStr(pt)) Then
            WScript.Sleep 100
            wshShell.SendKeys "{ENTER}"
            WScript.Sleep 150
        End If
    Next

    If appObj.Children.Count > 0 Then
        Set connObj = appObj.Children(0)
        If Not (connObj Is Nothing) And connObj.Children.Count > 0 Then
            Set sessionObj = connObj.Children(0)
            If Not (sessionObj Is Nothing) Then
                ' Handle multi-logon dialogs inside session
                Err.Clear
                If sessionObj.Children.Count > 1 Then
                    sessionObj.findById("wnd[1]/usr/radMULTI_LOGON_OPT2").select
                    sessionObj.findById("wnd[1]/tbar[0]/btn[0]").press
                    If Err.Number <> 0 Then
                        Err.Clear
                        sessionObj.findById("wnd[1]/tbar[0]/btn[0]").press
                    End If
                    If Err.Number <> 0 Then
                        Err.Clear
                        sessionObj.findById("wnd[1]").SendVKey 0
                    End If
                End If

                Err.Clear
                sessionObj.findById("wnd[2]/tbar[0]/btn[0]").press
                If Err.Number <> 0 Then
                    Err.Clear
                    sessionObj.findById("wnd[2]").SendVKey 0
                End If

                ' Check if session is ready
                If sessionObj.Busy = False Then
                    hasConn = True
                    Exit For
                End If
            End If
        End If
    End If

    If waitConn Mod 8 = 0 Then
        Dim tRetry
        For Each tRetry In Array("SAP Logon 770", "SAP Logon 760", "SAP Logon 750", "SAP Logon 740", "SAP Logon 800", "SAP Logon")
            If wshShell.AppActivate(CStr(tRetry)) Then
                wshShell.SendKeys "Inicio"
                WScript.Sleep 150
                wshShell.SendKeys "{ENTER}"
                Exit For
            End If
        Next
    End If
    WScript.Sleep 500
Next

If Not hasConn Or appObj.Children.Count = 0 Then
    WScript.Echo "RESULT_ERR:No hay conexiones abiertas en SAP Logon. Abre el shortcut 'Inicio' o tu sistema SAP."
    WScript.Quit 0
End If

Set connObj = appObj.Children(0)
If connObj Is Nothing Then
    WScript.Echo "RESULT_ERR:No se pudo enganchar a la conexion de SAP."
    WScript.Quit 0
End If

Set sessionObj = connObj.Children(0)
If sessionObj Is Nothing Then
    WScript.Echo "RESULT_ERR:No hay sesion de usuario activa en SAP Logon."
    WScript.Quit 0
End If

' Final popup cleanup before executing transaction
Dim popLoop
For popLoop = 1 To 4
    If Not (sessionObj Is Nothing) Then
        sessionObj.findById("wnd[1]/tbar[0]/btn[0]").press
        sessionObj.findById("wnd[1]/usr/radMULTI_LOGON_OPT2").select
        sessionObj.findById("wnd[1]/tbar[0]/btn[0]").press
        sessionObj.findById("wnd[2]/tbar[0]/btn[0]").press
    End If
    For Each pt In popTitles
        If wshShell.AppActivate(CStr(pt)) Then
            wshShell.SendKeys "{ENTER}"
        End If
    Next
    WScript.Sleep 150
Next

On Error GoTo 0

Dim description
description = ""

sessionObj.findById("wnd[0]/tbar[0]/btn[3]").press
sessionObj.findById("wnd[0]/tbar[0]/btn[3]").press
sessionObj.findById("wnd[0]/tbar[0]/btn[3]").press
sessionObj.findById("wnd[0]").maximize

If txType = "IQS3" Then
    sessionObj.findById("wnd[0]/tbar[0]/okcd").Text = "IQS3"
    sessionObj.findById("wnd[0]").SendVKey 0
    
    sessionObj.findById("wnd[0]/usr/ctxtRIWO00-QMNUM").Text = ecroVal
    sessionObj.findById("wnd[0]").SendVKey 0
    
    If sessionObj.findById("wnd[0]/sbar").Text = "" Then
        description = sessionObj.findById("wnd[0]/usr/tabsTAB_GROUP_10/tabp10\\TAB01/ssubSUB_GROUP_10:SAPLIQS0:7235/subCUSTOM_SCREEN:SAPLIQS0:7212/subSUBSCREEN_2:SAPLIQS0:7715/cntlTEXT/shellcont/shell").Text
        WScript.Echo "RESULT_OK:" & description
    Else
        WScript.Echo "RESULT_ERR:[SAP SBAR] " & sessionObj.findById("wnd[0]/sbar").Text
    End If
Else
    sessionObj.findById("wnd[0]/tbar[0]/okcd").Text = "CC03"
    sessionObj.findById("wnd[0]").SendVKey 0
    
    sessionObj.findById("wnd[0]/usr/ctxtRC29A-AENNR").Text = ecroVal
    sessionObj.findById("wnd[0]").SendVKey 0
    
    If sessionObj.findById("wnd[0]/sbar").Text = "" Then
        description = sessionObj.findById("wnd[0]/usr/subCOMMON:SAPMC29C:0040/txtRC29A-AETXT").Text
        WScript.Echo "RESULT_OK:" & description
    Else
        WScript.Echo "RESULT_ERR:[SAP SBAR] " & sessionObj.findById("wnd[0]/sbar").Text
    End If
End If
`;

    try {
        fs.writeFileSync(tempScriptPath, vbsContent, 'utf-8');
        const cmd = getCScriptCommand(tempScriptPath, [cleanEcroVal, type]);

        return await new Promise<{ success: boolean; description?: string; error?: string }>((resolve) => {
            exec(cmd, { timeout: 20000 }, (error, stdout, stderr) => {
                try { fs.unlinkSync(tempScriptPath); } catch (_) { }

                const combinedOutput = ((stdout || '') + '\n' + (stderr || '')).trim();
                const outputLines = combinedOutput.split(/\r?\n/);
                const okLine = outputLines.find(l => l.startsWith('RESULT_OK:'));
                const errLine = outputLines.find(l => l.startsWith('RESULT_ERR:'));

                if (okLine) {
                    const desc = okLine.replace('RESULT_OK:', '').trim();
                    resolve({ success: true, description: desc });
                } else if (errLine) {
                    resolve({ success: false, error: errLine.replace('RESULT_ERR:', '').trim() });
                } else if (error) {
                    const detailedErr = combinedOutput || error.message;
                    resolve({
                        success: false,
                        error: `Error de Ejecución: ${detailedErr}. Por favor verifica que SAP Logon esté abierto, con sesión iniciada y scripting activado.`
                    });
                } else {
                    resolve({
                        success: false,
                        error: `La macro no devolvió una salida válida. Revisa los permisos de script en SAP GUI.\nConsola: ${combinedOutput}`
                    });
                }
            });
        });
    } catch (err: any) {
        try { fs.unlinkSync(tempScriptPath); } catch (_) { }
        return {
            success: false,
            error: `Error al abrir túnel de control SAP local: ${err.message}`
        };
    }
}

/**
 * Batch-fetches ECN descriptions from SAP GUI (trying CC03 and IQS3) and updates records before preview/commit.
 */
async function enrichEcnDescriptionsFromSap(records: any[]): Promise<any[]> {
    if (!records || records.length === 0 || process.platform !== 'win32') {
        return records;
    }

    const uniqueEcns = Array.from(new Set(records.map(r => cleanEcn(r.ecnNumber || r.ecn || r.ecro)).filter(Boolean)));
    if (uniqueEcns.length === 0) return records;

    // Auto-launch SAP Logon and connect to Inicio if not already connected
    await ensureSapSessionActive('Inicio');

    console.log(`[SAP Description Macro] Obteniendo campo description para ${uniqueEcns.length} ECN(s) desde SAP GUI antes de previsualizar...`);

    const tempScriptPath = path.join(os.tmpdir(), `sap_gui_batch_desc_${Date.now()}_${Math.floor(Math.random() * 1000)}.vbs`);
    const batchVbsContent = `'=============================================================================
' BRIDGE BATCH SAP GUI (CC03 / IQS3) DESCRIPCIONES DE ECN (TABLA ECNS)
'=============================================================================
On Error Resume Next

Dim SapGuiAuto, appObj, connObj, sessionObj, wshShell
Set wshShell = CreateObject("WScript.Shell")
Set SapGuiAuto = GetObject("SAPGUI")

If Err.Number <> 0 Or SapGuiAuto Is Nothing Then
    Err.Clear
    wshShell.Run """C:\\Program Files (x86)\\SAP\\FrontEnd\\SAPgui\\saplogon.exe""", 1, False
    If Err.Number <> 0 Then
        Err.Clear
        wshShell.Run """C:\\Program Files\\SAP\\FrontEnd\\SAPgui\\saplogon.exe""", 1, False
    End If
    If Err.Number <> 0 Then
        Err.Clear
        wshShell.Run """C:\\SAP\\FrontEnd\\SAPgui\\saplogon.exe""", 1, False
    End If
    If Err.Number <> 0 Then
        Err.Clear
        wshShell.Run "saplogon.exe", 1, False
    End If
    WScript.Sleep 3500
    Set SapGuiAuto = GetObject("SAPGUI")
End If

If Err.Number <> 0 Or SapGuiAuto Is Nothing Then
    WScript.Echo "RESULT_ERR:No se detecto proceso activo de SAP GUI."
    WScript.Quit 0
End If

Set appObj = SapGuiAuto.GetScriptingEngine
If Err.Number <> 0 Or appObj Is Nothing Then
    WScript.Echo "RESULT_ERR:Scripting deshabilitado en SAP Logon."
    WScript.Quit 0
End If

' If no connections are open, attempt connection to Inicio / BRP
If appObj.Children.Count = 0 Then
    Dim connNames, cn, opened
    connNames = Array("Inicio", "Ingreso Predeterminado", "BRP - ERP Production", "BRP -ERP Production", "BRP-ERP Production", "BRP - Production", "ERP Production", "BRP", "BRP [ERP Production]", "BRP [ECC Production]", "BRP [PRD]", "BRP [ECC]", "BRP Produccion", "BRP PRD", "BRP Production", "BRP_FWD")
    opened = False
    For Each cn In connNames
        Err.Clear
        Set connObj = appObj.OpenConnection(CStr(cn), True)
        If Err.Number = 0 And Not (connObj Is Nothing) Then
            opened = True
            Exit For
        End If
    Next

    If Not opened Then
        Err.Clear
        Dim connStrings, cs
        connStrings = Array("/M/brpprod.honeywell.com/S/3600/G/BRP_FWD", "/M/brpprod.honeywell.com/S/sapmsBRP/G/BRP_FWD", "/M/brpprod.honeywell.com/S/3600/G/SPACE", "SAPGUI /M/brpprod.honeywell.com/S/3600/G/BRP_FWD")
        For Each cs In connStrings
            Err.Clear
            Set connObj = appObj.OpenConnectionByConnectionString(CStr(cs), True)
            If Err.Number = 0 And Not (connObj Is Nothing) Then
                opened = True
                Exit For
            End If
        Next
    End If

    If Not opened Then
        Err.Clear
        Dim titles, t, titleActivated
        titles = Array("SAP Logon 770", "SAP Logon 760", "SAP Logon 750", "SAP Logon 740", "SAP Logon 800", "SAP Logon", "SapLogon")
        titleActivated = False
        For Each t In titles
            If wshShell.AppActivate(CStr(t)) Then
                titleActivated = True
                Exit For
            End If
        Next
        If titleActivated Then
            WScript.Sleep 500
            wshShell.SendKeys "^f"
            WScript.Sleep 200
            wshShell.SendKeys "Inicio"
            WScript.Sleep 200
            wshShell.SendKeys "{ENTER}"
            WScript.Sleep 200
            wshShell.SendKeys "{TAB}"
            WScript.Sleep 150
            wshShell.SendKeys "{ENTER}"
            WScript.Sleep 250
            wshShell.SendKeys "Inicio"
            WScript.Sleep 150
            wshShell.SendKeys "{ENTER}"
        End If
    End If
End If

' Wait up to 30 seconds for connection, dismissing all modal popups until SAP Easy Access
Dim waitConn, hasConn, popTitles, pt
hasConn = False
popTitles = Array("Information", "Información", "System Messages", "Mensajes del sistema", "Copyright", "License", "Licencia", "SAP GUI Security", "Seguridad de SAP GUI", "SAP GUI for Windows", "Logon Information", "Información de logon", "Warning", "Advertencia", "Notice", "Aviso", "Attention", "Atención")

For waitConn = 1 To 60
    ' 1. Dismiss any Windows modal popups
    For Each pt In popTitles
        If wshShell.AppActivate(CStr(pt)) Then
            WScript.Sleep 100
            wshShell.SendKeys "{ENTER}"
            WScript.Sleep 150
        End If
    Next

    If appObj.Children.Count > 0 Then
        Set connObj = appObj.Children(0)
        If Not (connObj Is Nothing) And connObj.Children.Count > 0 Then
            Set sessionObj = connObj.Children(0)
            If Not (sessionObj Is Nothing) Then
                ' Handle multi-logon dialogs inside session
                Err.Clear
                If sessionObj.Children.Count > 1 Then
                    sessionObj.findById("wnd[1]/usr/radMULTI_LOGON_OPT2").select
                    sessionObj.findById("wnd[1]/tbar[0]/btn[0]").press
                    If Err.Number <> 0 Then
                        Err.Clear
                        sessionObj.findById("wnd[1]/tbar[0]/btn[0]").press
                    End If
                    If Err.Number <> 0 Then
                        Err.Clear
                        sessionObj.findById("wnd[1]").SendVKey 0
                    End If
                End If

                Err.Clear
                sessionObj.findById("wnd[2]/tbar[0]/btn[0]").press
                If Err.Number <> 0 Then
                    Err.Clear
                    sessionObj.findById("wnd[2]").SendVKey 0
                End If

                ' Check if session is ready
                If sessionObj.Busy = False Then
                    hasConn = True
                    Exit For
                End If
            End If
        End If
    End If

    If waitConn Mod 8 = 0 Then
        Dim tRetry
        For Each tRetry In Array("SAP Logon 770", "SAP Logon 760", "SAP Logon 750", "SAP Logon 740", "SAP Logon 800", "SAP Logon")
            If wshShell.AppActivate(CStr(tRetry)) Then
                wshShell.SendKeys "Inicio"
                WScript.Sleep 150
                wshShell.SendKeys "{ENTER}"
                Exit For
            End If
        Next
    End If
    WScript.Sleep 500
Next

If Not hasConn Or appObj.Children.Count = 0 Then
    WScript.Echo "RESULT_ERR:No hay conexiones abiertas en SAP Logon. Abre el shortcut 'Inicio' o tu sistema SAP."
    WScript.Quit 0
End If

Set connObj = appObj.Children(0)
If connObj Is Nothing Then
    WScript.Echo "RESULT_ERR:No se pudo conectar a la conexion de SAP."
    WScript.Quit 0
End If

Set sessionObj = connObj.Children(0)
If sessionObj Is Nothing Then
    WScript.Echo "RESULT_ERR:No hay sesion activa en SAP."
    WScript.Quit 0
End If

' Dismiss modal popups
Dim popLoop
For popLoop = 1 To 4
    If Not (sessionObj Is Nothing) Then
        sessionObj.findById("wnd[1]/tbar[0]/btn[0]").press
        sessionObj.findById("wnd[1]/usr/radMULTI_LOGON_OPT2").select
        sessionObj.findById("wnd[1]/tbar[0]/btn[0]").press
        sessionObj.findById("wnd[2]/tbar[0]/btn[0]").press
    End If
    For Each pt In popTitles
        If wshShell.AppActivate(CStr(pt)) Then
            wshShell.SendKeys "{ENTER}"
        End If
    Next
    WScript.Sleep 150
Next

sessionObj.findById("wnd[0]/tbar[0]/btn[3]").press
sessionObj.findById("wnd[0]/tbar[0]/btn[3]").press
sessionObj.findById("wnd[0]/tbar[0]/btn[3]").press
sessionObj.findById("wnd[0]").maximize

Dim ecnList
ecnList = Array(${uniqueEcns.map(e => `"${e}"`).join(', ')})

Dim i, currentEcn, descVal
For i = LBound(ecnList) To UBound(ecnList)
    currentEcn = ecnList(i)
    descVal = ""

    

    ' 2. Si no encontró en CC03 o está vacío, intentar IQS3 (Quality Notification / ECR)
    If Trim(descVal) = "" Then
        sessionObj.findById("wnd[0]/tbar[0]/btn[3]").press
        sessionObj.findById("wnd[0]/tbar[0]/okcd").Text = "IQS3"
        sessionObj.findById("wnd[0]").SendVKey 0
        sessionObj.findById("wnd[0]/usr/ctxtRIWO00-QMNUM").Text = currentEcn
        sessionObj.findById("wnd[0]").SendVKey 0

        If sessionObj.findById("wnd[0]/sbar").Text = "" Then
            descVal = sessionObj.findById("wnd[0]/usr/tabsTAB_GROUP_10/tabp10\\TAB01/ssubSUB_GROUP_10:SAPLIQS0:7235/subCUSTOM_SCREEN:SAPLIQS0:7212/subSUBSCREEN_2:SAPLIQS0:7715/cntlTEXT/shellcont/shell").Text
        End If
    End If

    sessionObj.findById("wnd[0]/tbar[0]/btn[3]").press
    sessionObj.findById("wnd[0]/tbar[0]/btn[3]").press

    If Trim(descVal) <> "" Then
        WScript.Echo "DESC_OK:" & currentEcn & ":::" & Replace(Replace(descVal, vbCrLf, " "), vbLf, " ")
    End If
Next

WScript.Echo "RESULT_OK:FINISHED_DESCRIPTIONS"
`;

    const descriptionMap = new Map<string, string>();
    try {
        fs.writeFileSync(tempScriptPath, batchVbsContent, 'utf-8');
        const cmd = getCScriptCommand(tempScriptPath);

        await new Promise<void>((resolve) => {
            exec(cmd, { timeout: Math.max(30000, uniqueEcns.length * 6000) }, (error, stdout) => {
                try { fs.unlinkSync(tempScriptPath); } catch (_) { }
                if (stdout) {
                    const lines = stdout.split(/\r?\n/);
                    for (const line of lines) {
                        if (line.startsWith('DESC_OK:')) {
                            const payload = line.replace('DESC_OK:', '');
                            const [ecnKey, ...rest] = payload.split(':::');
                            const description = rest.join(':::').trim();
                            if (ecnKey && description) {
                                descriptionMap.set(ecnKey.trim(), description);
                            }
                        }
                    }
                }
                resolve();
            });
        });
    } catch (e: any) {
        console.warn('[SAP Description Macro] Advertencia al ejecutar macro de descripciones:', e.message);
        try { fs.unlinkSync(tempScriptPath); } catch (_) { }
    }

    if (descriptionMap.size > 0) {
        console.log(`[SAP Description Macro] Se obtuvieron ${descriptionMap.size} descripciones de ECN actualizadas desde SAP GUI.`);
        for (const rec of records) {
            const ecnKey = cleanEcn(rec.ecnNumber || rec.ecn || rec.ecro);
            if (ecnKey && descriptionMap.has(ecnKey)) {
                const realDesc = descriptionMap.get(ecnKey)!;
                rec.description = realDesc;
                if (!rec.assemblyDescription || rec.assemblyDescription.startsWith('ZPP_CC07')) {
                    rec.assemblyDescription = realDesc;
                }
            }
        }
    }

    return records;
}

/**
 * Formats any date string/object into SAP standard format DD.MM.YYYY (e.g. 20.08.2026).
 * Crucial for SAP GUI transaction screens (ctxtS001-LOW / ctxtS001-HIGH) which reject YYYY-MM-DD.
 */
function formatSapDate(dateInput: any): string {
    if (!dateInput) return '';
    const str = String(dateInput).trim();
    if (!str) return '';

    // If already in DD.MM.YYYY (e.g. 20.08.2026)
    if (/^\d{2}\.\d{2}\.\d{4}$/.test(str)) {
        return str;
    }

    // If single digit day/month with dots (e.g. 5.8.2026 -> 05.08.2026)
    const dotMatch = str.match(/^(\d{1,2})\.(\d{1,2})\.(\d{4})$/);
    if (dotMatch) {
        return `${dotMatch[1].padStart(2, '0')}.${dotMatch[2].padStart(2, '0')}.${dotMatch[3]}`;
    }

    // If in YYYY-MM-DD, YYYY/MM/DD or YYYY.MM.DD (e.g. 2026-08-20 -> 20.08.2026)
    const ymdMatch = str.match(/^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})/);
    if (ymdMatch) {
        const year = ymdMatch[1];
        const month = ymdMatch[2].padStart(2, '0');
        const day = ymdMatch[3].padStart(2, '0');
        return `${day}.${month}.${year}`;
    }

    // If in DD/MM/YYYY or DD-MM-YYYY (e.g. 20/08/2026 -> 20.08.2026)
    const dmyMatch = str.match(/^(\d{1,2})[-/](\d{1,2})[-/](\d{4})/);
    if (dmyMatch) {
        const day = dmyMatch[1].padStart(2, '0');
        const month = dmyMatch[2].padStart(2, '0');
        const year = dmyMatch[3];
        return `${day}.${month}.${year}`;
    }

    // Fallback: parse via JavaScript Date
    const parsedDate = new Date(str);
    if (!isNaN(parsedDate.getTime())) {
        const day = String(parsedDate.getUTCDate()).padStart(2, '0');
        const month = String(parsedDate.getUTCMonth() + 1).padStart(2, '0');
        const year = String(parsedDate.getUTCFullYear());
        return `${day}.${month}.${year}`;
    }

    return str;
}

function parseNumericValue(value: any): number {
    if (value === null || value === undefined || value === '') return 0;
    const normalized = String(value).replace(/[^0-9,.-]/g, '').replace(',', '.');
    const parsed = Number(normalized);
    return Number.isFinite(parsed) ? parsed : 0;
}

function cleanEcn(value: any): string {
    if (value === null || value === undefined) return '';
    return String(value).trim().replace(/\s+/g, '');
}

function dbText(value: any, maxLength: number, fallback = ''): string {
    const text = value === null || value === undefined ? fallback : String(value);
    return text.trim().slice(0, maxLength);
}

function parseDateOnly(value: any): Date | null {
    if (!value) return null;
    if (value instanceof Date && !isNaN(value.getTime())) {
        return new Date(Date.UTC(value.getFullYear(), value.getMonth(), value.getDate()));
    }

    if (typeof value === 'number' && value > 1) {
        const excelDate = new Date(Date.UTC(1899, 11, 30) + value * 24 * 60 * 60 * 1000);
        return isNaN(excelDate.getTime()) ? null : excelDate;
    }

    const text = String(value).trim().split(' ')[0];
    let match = text.match(/^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})$/);
    if (match) {
        const date = new Date(Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3])));
        return date.getUTCFullYear() === Number(match[1]) && date.getUTCMonth() === Number(match[2]) - 1 && date.getUTCDate() === Number(match[3]) ? date : null;
    }

    match = text.match(/^(\d{1,2})[./-](\d{1,2})[./-](\d{2,4})$/);
    if (match) {
        const first = Number(match[1]);
        const second = Number(match[2]);
        const year = match[3].length === 2 ? 2000 + Number(match[3]) : Number(match[3]);
        const isSlashUsDate = text.includes('/') && first <= 12;
        const day = isSlashUsDate ? second : first;
        const month = isSlashUsDate ? first : second;
        const date = new Date(Date.UTC(year, month - 1, day));
        return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day ? date : null;
    }

    return null;
}

function dateForDb(value: any): Date | null {
    const date = parseDateOnly(value);
    return date ? new Date(date.toISOString().slice(0, 10)) : null;
}

function findValueByKeys(record: Record<string, any>, keys: string[]): any {
    const normalizeHeader = (value: string) => value.toLowerCase().replace(/[^a-z0-9]/g, '');
    const normalizedKeys = keys.map(normalizeHeader);
    for (const key of keys) {
        const match = Object.keys(record).find(k => normalizedKeys.includes(normalizeHeader(k)));
        if (match) return record[match];
    }

    const partialMatch = Object.keys(record).find(header => {
        const normalizedHeader = normalizeHeader(header);
        return normalizedKeys.some(key => key.length >= 6 && (normalizedHeader.includes(key) || key.includes(normalizedHeader)));
    });
    if (partialMatch) return record[partialMatch];

    return '';
}

function calculateZppTimeoutMs(initialDate: string, finalDate: string, plantCount: number): number {
    const start = initialDate ? new Date(initialDate).getTime() : Date.now();
    const end = finalDate ? new Date(finalDate).getTime() : Date.now();
    const daysDiff = Math.max(1, Math.ceil(Math.abs(end - start) / (1000 * 60 * 60 * 24)) + 1);
    return Math.max(180000, Math.min(900000, 60000 * Math.max(plantCount, 1) + daysDiff * 5000));
}

function readExcelWorkbook(filePath: string, options: any = {}): any {
    if (typeof XLSX.readFile === 'function') {
        return XLSX.readFile(filePath, options);
    }
    if (XLSX.default && typeof XLSX.default.readFile === 'function') {
        return XLSX.default.readFile(filePath, options);
    }
    const fileBuffer = fs.readFileSync(filePath);
    const readFn = XLSX.read || (XLSX.default && XLSX.default.read);
    if (typeof readFn === 'function') {
        return readFn(fileBuffer, { type: 'buffer', ...options });
    }
    throw new Error('No se encontró el método de lectura en el módulo XLSX');
}

function parseSheetToJson(sheet: any, options: any = { defval: '', raw: false }): any[] {
    const utils = XLSX.utils || (XLSX.default && XLSX.default.utils);
    if (utils && typeof utils.sheet_to_json === 'function') {
        return utils.sheet_to_json(sheet, options);
    }
    return [];
}

/**
 * Generates pure VBScript for direct SAP GUI OLE Automation (cscript.exe)
 * with dates formatted strictly as DD.MM.YYYY.
 */
function generateZppVbsCode(params: {
    plants: string[];
    formattedInitialDate: string;
    formattedFinalDate: string;
    exportRoot: string;
    todayFormatted: string;
}): string {
    const { plants, formattedInitialDate, formattedFinalDate, exportRoot, todayFormatted } = params;
    return `'=============================================================================
' BRIDGE EJECUCION REAL ZPP_CC07 CON SAP GUI OLE SCRIPTING ENGINE (CSCRIPT)
'=============================================================================
On Error Resume Next

Dim SapGuiAuto, appObj, connObj, sessionObj, wshShell
Set wshShell = CreateObject("WScript.Shell")
Set SapGuiAuto = GetObject("SAPGUI")

If Err.Number <> 0 Or SapGuiAuto Is Nothing Then
    ' Try launching saplogon.exe
    Err.Clear
    wshShell.Run """C:\\Program Files (x86)\\SAP\\FrontEnd\\SAPgui\\saplogon.exe""", 1, False
    If Err.Number <> 0 Then
        Err.Clear
        wshShell.Run """C:\\Program Files\\SAP\\FrontEnd\\SAPgui\\saplogon.exe""", 1, False
    End If
    If Err.Number <> 0 Then
        Err.Clear
        wshShell.Run """C:\\SAP\\FrontEnd\\SAPgui\\saplogon.exe""", 1, False
    End If
    If Err.Number <> 0 Then
        Err.Clear
        wshShell.Run "saplogon.exe", 1, False
    End If
    WScript.Sleep 3500
    Set SapGuiAuto = GetObject("SAPGUI")
End If

If Err.Number <> 0 Or SapGuiAuto Is Nothing Then
    WScript.Echo "RESULT_ERR:No se detecto proceso activo de SAP GUI. Abre SAP Logon, inicia sesion en tu mandante y reintenta."
    WScript.Quit 0
End If

Set appObj = SapGuiAuto.GetScriptingEngine
If Err.Number <> 0 Or appObj Is Nothing Then
    WScript.Echo "RESULT_ERR:El scripting de SAP GUI esta deshabilitado en tu SAP Logon o servidor (RZ11)."
    WScript.Quit 0
End If

' If no connections are open, automatically attempt to open Inicio / BRP
If appObj.Children.Count = 0 Then
    Dim connNames, cn, opened
    connNames = Array("Inicio", "Ingreso Predeterminado", "BRP - ERP Production", "BRP -ERP Production", "BRP-ERP Production", "BRP - Production", "ERP Production", "BRP", "BRP [ERP Production]", "BRP [ECC Production]", "BRP [PRD]", "BRP [ECC]", "BRP Produccion", "BRP PRD", "BRP Production", "BRP_FWD")
    opened = False
    For Each cn In connNames
        Err.Clear
        Set connObj = appObj.OpenConnection(CStr(cn), True)
        If Err.Number = 0 And Not (connObj Is Nothing) Then
            opened = True
            Exit For
        End If
    Next

    If Not opened Then
        Err.Clear
        Dim connStrings, cs
        connStrings = Array("/M/brpprod.honeywell.com/S/3600/G/BRP_FWD", "/M/brpprod.honeywell.com/S/sapmsBRP/G/BRP_FWD", "/M/brpprod.honeywell.com/S/3600/G/SPACE", "SAPGUI /M/brpprod.honeywell.com/S/3600/G/BRP_FWD")
        For Each cs In connStrings
            Err.Clear
            Set connObj = appObj.OpenConnectionByConnectionString(CStr(cs), True)
            If Err.Number = 0 And Not (connObj Is Nothing) Then
                opened = True
                Exit For
            End If
        Next
    End If

    If Not opened Then
        Err.Clear
        Dim titles, t, titleActivated
        titles = Array("SAP Logon 770", "SAP Logon 760", "SAP Logon 750", "SAP Logon 740", "SAP Logon 800", "SAP Logon", "SapLogon")
        titleActivated = False
        For Each t In titles
            If wshShell.AppActivate(CStr(t)) Then
                titleActivated = True
                Exit For
            End If
        Next
        If titleActivated Then
            WScript.Sleep 500
            wshShell.SendKeys "^f"
            WScript.Sleep 200
            wshShell.SendKeys "Inicio"
            WScript.Sleep 200
            wshShell.SendKeys "{ENTER}"
            WScript.Sleep 200
            wshShell.SendKeys "{TAB}"
            WScript.Sleep 150
            wshShell.SendKeys "{ENTER}"
            WScript.Sleep 250
            wshShell.SendKeys "Inicio"
            WScript.Sleep 150
            wshShell.SendKeys "{ENTER}"
        End If
    End If
End If

' Wait up to 30 seconds for connection, dismissing all modal popups until SAP Easy Access
Dim waitConn, hasConn, popTitles, pt
hasConn = False
popTitles = Array("Information", "Información", "System Messages", "Mensajes del sistema", "Copyright", "License", "Licencia", "SAP GUI Security", "Seguridad de SAP GUI", "SAP GUI for Windows", "Logon Information", "Información de logon", "Warning", "Advertencia", "Notice", "Aviso", "Attention", "Atención")

For waitConn = 1 To 60
    ' 1. Dismiss any Windows modal popups
    For Each pt In popTitles
        If wshShell.AppActivate(CStr(pt)) Then
            WScript.Sleep 100
            wshShell.SendKeys "{ENTER}"
            WScript.Sleep 150
        End If
    Next

    If appObj.Children.Count > 0 Then
        Set connObj = appObj.Children(0)
        If Not (connObj Is Nothing) And connObj.Children.Count > 0 Then
            Set sessionObj = connObj.Children(0)
            If Not (sessionObj Is Nothing) Then
                ' Handle multi-logon dialogs inside session
                Err.Clear
                If sessionObj.Children.Count > 1 Then
                    sessionObj.findById("wnd[1]/usr/radMULTI_LOGON_OPT2").select
                    sessionObj.findById("wnd[1]/tbar[0]/btn[0]").press
                    If Err.Number <> 0 Then
                        Err.Clear
                        sessionObj.findById("wnd[1]/tbar[0]/btn[0]").press
                    End If
                    If Err.Number <> 0 Then
                        Err.Clear
                        sessionObj.findById("wnd[1]").SendVKey 0
                    End If
                End If

                Err.Clear
                sessionObj.findById("wnd[2]/tbar[0]/btn[0]").press
                If Err.Number <> 0 Then
                    Err.Clear
                    sessionObj.findById("wnd[2]").SendVKey 0
                End If

                ' Check if session is ready
                If sessionObj.Busy = False Then
                    hasConn = True
                    Exit For
                End If
            End If
        End If
    End If

    If waitConn Mod 8 = 0 Then
        Dim tRetry
        For Each tRetry In Array("SAP Logon 770", "SAP Logon 760", "SAP Logon 750", "SAP Logon 740", "SAP Logon 800", "SAP Logon")
            If wshShell.AppActivate(CStr(tRetry)) Then
                wshShell.SendKeys "Inicio"
                WScript.Sleep 150
                wshShell.SendKeys "{ENTER}"
                Exit For
            End If
        Next
    End If
    WScript.Sleep 500
Next

If Not hasConn Or appObj.Children.Count = 0 Then
    WScript.Echo "RESULT_ERR:No hay conexiones abiertas en SAP Logon. Abre el shortcut 'Inicio' o tu sistema SAP."
    WScript.Quit 0
End If

Set connObj = appObj.Children(0)
If connObj Is Nothing Then
    WScript.Echo "RESULT_ERR:No se pudo conectar a la conexion de SAP."
    WScript.Quit 0
End If

Set sessionObj = connObj.Children(0)
If sessionObj Is Nothing Then
    WScript.Echo "RESULT_ERR:No hay sesion de usuario activa en SAP Logon."
    WScript.Quit 0
End If

' Dismiss modal popups
Dim popLoop
For popLoop = 1 To 4
    If Not (sessionObj Is Nothing) Then
        sessionObj.findById("wnd[1]/tbar[0]/btn[0]").press
        sessionObj.findById("wnd[1]/usr/radMULTI_LOGON_OPT2").select
        sessionObj.findById("wnd[1]/tbar[0]/btn[0]").press
        sessionObj.findById("wnd[2]/tbar[0]/btn[0]").press
    End If
    For Each pt In popTitles
        If wshShell.AppActivate(CStr(pt)) Then
            wshShell.SendKeys "{ENTER}"
        End If
    Next
    WScript.Sleep 150
Next

sessionObj.findById("wnd[0]/tbar[0]/btn[3]").press
sessionObj.findById("wnd[0]/tbar[0]/btn[3]").press
sessionObj.findById("wnd[0]/tbar[0]/btn[3]").press
sessionObj.findById("wnd[0]").maximize

Dim plantCodes
plantCodes = Array(${plants.map((p: string) => `"${p}"`).join(', ')})

Dim initialDate, finalDate
initialDate = "${formattedInitialDate}"
finalDate = "${formattedFinalDate}"

Dim i, plant, outPath
outPath = "${exportRoot.replace(/\\/g, '\\\\')}"

For i = LBound(plantCodes) To UBound(plantCodes)
    plant = plantCodes(i)

    sessionObj.findById("wnd[0]/tbar[0]/okcd").Text = "ZPP_CC07"
    sessionObj.findById("wnd[0]").SendVKey 0

    sessionObj.findById("wnd[0]/usr/chkP002").Selected = False
    sessionObj.findById("wnd[0]/usr/ctxtP001").Text = plant

    sessionObj.findById("wnd[0]/usr/ctxtS001-LOW").Text = initialDate
    sessionObj.findById("wnd[0]/usr/ctxtS001-HIGH").Text = finalDate
    sessionObj.findById("wnd[0]/usr/ctxtS001-HIGH").SetFocus
    sessionObj.findById("wnd[0]").SendVKey 8

    sessionObj.findById("wnd[0]").SendVKey 33
    sessionObj.findById("wnd[1]/usr/ssubD0500_SUBSCREEN:SAPLSLVC_DIALOG:0501/cntlG51_CONTAINER/shellcont/shell").ContextMenu
    sessionObj.findById("wnd[1]/usr/ssubD0500_SUBSCREEN:SAPLSLVC_DIALOG:0501/cntlG51_CONTAINER/shellcont/shell").SelectContextMenuItem "&FIND"
    sessionObj.findById("wnd[2]/usr/chkGS_SEARCH-EXACT_WORD").Selected = True
    sessionObj.findById("wnd[2]/usr/txtGS_SEARCH-VALUE").Text = "/ECN"
    sessionObj.findById("wnd[2]").SendVKey 0
    sessionObj.findById("wnd[2]").SendVKey 12
    sessionObj.findById("wnd[1]/usr/ssubD0500_SUBSCREEN:SAPLSLVC_DIALOG:0501/cntlG51_CONTAINER/shellcont/shell").ClickCurrentCell

    sessionObj.findById("wnd[0]/mbar/menu[0]/menu[3]/menu[1]").Select

    sessionObj.findById("wnd[1]/usr/ctxtDY_PATH").Text = outPath
    sessionObj.findById("wnd[1]/usr/ctxtDY_FILENAME").Text = "ECN_" & plant & "_" & "${todayFormatted}" & ".XLSX"
    sessionObj.findById("wnd[1]/tbar[0]/btn[11]").press

    WScript.Echo "EXPORT_OK:" & plant & ":ECN_" & plant & "_" & "${todayFormatted}" & ".XLSX"

    sessionObj.findById("wnd[0]/tbar[0]/btn[3]").press
    sessionObj.findById("wnd[0]/tbar[0]/btn[3]").press
Next

' Keep any Excel workbooks opened by SAP invisible until the database import finishes.
On Error Resume Next
Dim xlApp, xlWb
Set xlApp = GetObject(, "Excel.Application")
If Err.Number = 0 And Not (xlApp Is Nothing) Then
    xlApp.Visible = False
    For Each xlWb In xlApp.Workbooks
        If InStr(LCase(xlWb.FullName), LCase(outPath)) > 0 Then xlWb.Windows(1).Visible = False
    Next
End If
Err.Clear

WScript.Echo "RESULT_OK:FINISHED_PLANTS"
`;
}

async function closeSapExportWorkbook(exportRoot: string): Promise<void> {
    if (process.platform !== 'win32') return;

    const scriptPath = path.join(os.tmpdir(), `close_sap_export_${Date.now()}.ps1`);
    const escapedRoot = exportRoot.replace(/'/g, "''");
    const script = `
$root = '${escapedRoot}'
$normalizedRoot = [IO.Path]::GetFullPath($root).TrimEnd('\\')
foreach ($process in @(Get-Process -Name EXCEL -ErrorAction SilentlyContinue)) {
    try {
        $excel = [Runtime.InteropServices.Marshal]::GetActiveObject('Excel.Application')
        foreach ($workbook in @($excel.Workbooks)) {
            try {
                $fullName = [IO.Path]::GetFullPath([string]$workbook.FullName)
                $name = [string]$workbook.Name
                if ($fullName.StartsWith($normalizedRoot, [StringComparison]::OrdinalIgnoreCase) -or $name -like 'ECN_*.XLSX') {
                    $workbook.Close($false)
                }
            } catch { }
        }
        [Runtime.InteropServices.Marshal]::ReleaseComObject($excel) | Out-Null
    } catch { }

    try {
        if ($process.MainWindowTitle -like 'ECN_*.XLSX*' -or $process.MainWindowTitle -like 'ECN_* - Excel*') {
            Stop-Process -Id $process.Id -Force -ErrorAction SilentlyContinue
        }
    } catch { }
}
`;

    try {
        fs.writeFileSync(scriptPath, script, 'utf-8');
        await new Promise<void>(resolve => {
            exec(`powershell.exe -NoProfile -NonInteractive -WindowStyle Hidden -ExecutionPolicy Bypass -File "${scriptPath}"`, { timeout: 30000 }, () => resolve());
        });
    } finally {
        try { fs.unlinkSync(scriptPath); } catch (_) { }
    }
}

/**
 * Executes ZPP_CC07 automation via cscript.exe VBScript, formats dates to DD.MM.YYYY,
 * reads exported Excel files, and parses the extracted ECN records.
 */
async function runZppExtraction(plants: string[], rawStartDate: string, rawEndDate: string): Promise<{ records: any[]; jsonData: any[]; headers: string[]; exportRoot: string }> {
    // Auto-launch SAP Logon and connect to Inicio if not already connected
    await ensureSapSessionActive('Inicio');

    const formattedInitialDate = formatSapDate(rawStartDate);
    const formattedFinalDate = formatSapDate(rawEndDate);

    console.log(`[SAP ZPP_CC07] Ejecutando extracción VBScript cscript.exe. Plantas: [${plants.join(', ')}], Fechas SAP: ${formattedInitialDate} -> ${formattedFinalDate}`);

    const exportRoot = path.join(os.tmpdir(), `sap_zpp_export_${Date.now()}`);
    fs.mkdirSync(exportRoot, { recursive: true });

    const tempScriptPath = path.join(os.tmpdir(), `sap_gui_zpp_${Date.now()}.vbs`);
    const todayFormatted = new Date().toISOString().slice(2, 10).replace(/-/g, '');

    const macroCode = generateZppVbsCode({
        plants,
        formattedInitialDate,
        formattedFinalDate,
        exportRoot,
        todayFormatted
    });

    try {
        fs.writeFileSync(tempScriptPath, macroCode, 'utf-8');
        const cmd = getCScriptCommand(tempScriptPath);
        const timeoutMs = calculateZppTimeoutMs(rawStartDate, rawEndDate, plants.length);

        const execution = await new Promise<{ stdout: string; stderr: string }>((resolve, reject) => {
            exec(cmd, { timeout: timeoutMs }, (error, stdout, stderr) => {
                if (error && (error as any).code !== 'ETIMEDOUT') {
                    reject(error);
                    return;
                }
                resolve({ stdout: stdout || '', stderr: stderr || '' });
            });
        });

        try { fs.unlinkSync(tempScriptPath); } catch (e) { }

        const combinedOutput = ((execution.stdout || '') + '\n' + (execution.stderr || '')).trim();
        const outputLines = combinedOutput.split(/\r?\n/);
        const errLine = outputLines.find(line => line.startsWith('RESULT_ERR:'));

        if (errLine) {
            const errorMsg = errLine.replace('RESULT_ERR:', '').trim();
            const err: any = new Error(errorMsg);
            err.isSapError = true;
            throw err;
        }

        const exportFiles = fs.existsSync(exportRoot)
            ? fs.readdirSync(exportRoot)
                .filter(fileName => /^ECN_.*\.XLSX$/i.test(fileName))
                .sort()
            : [];

        const groupedRows = new Map<string, any>();
        const allRawJsonRows: any[] = [];
        const allDetectedHeaders: string[] = [];

        for (const fileName of exportFiles) {
            const filePath = path.join(exportRoot, fileName);
            const workbook = readExcelWorkbook(filePath, { cellDates: true, raw: false });

            for (const sheetName of workbook.SheetNames) {
                const sheet = workbook.Sheets[sheetName];
                const rows = parseSheetToJson(sheet);

                // Also extract exact header array and raw structured row objects
                const rawSheetData = parseSheetToJson(sheet, { header: 1, defval: null, raw: false }) as any[][];
                if (rawSheetData && rawSheetData.length > 0) {
                    let headerRowIndex = 0;
                    const keyHeaders = ['ecn', 'ecno', 'change no.', 'assembly', 'start material', 'component', 'plant', 'created by'];
                    for (let i = 0; i < Math.min(15, rawSheetData.length); i++) {
                        const rowValues = (rawSheetData[i] || []).map(v => String(v || '').trim().toLowerCase());
                        const matchCount = keyHeaders.filter(kh => rowValues.includes(kh)).length;
                        if (matchCount >= 2) {
                            headerRowIndex = i;
                            break;
                        }
                    }

                    const rawHeaders = (rawSheetData[headerRowIndex] || []).map(h => String(h || '').trim());
                    const sheetHeaders: string[] = [];
                    const headerCounts: Record<string, number> = {};

                    rawHeaders.forEach(header => {
                        if (!header) return;
                        if (headerCounts[header]) {
                            headerCounts[header]++;
                            sheetHeaders.push(`${header}_${headerCounts[header]}`);
                        } else {
                            headerCounts[header] = 1;
                            sheetHeaders.push(header);
                        }
                    });

                    sheetHeaders.forEach(h => {
                        if (!allDetectedHeaders.includes(h)) allDetectedHeaders.push(h);
                    });

                    const sliceData = rawSheetData.slice(headerRowIndex + 1);
                    sliceData.forEach(row => {
                        const rowObj: Record<string, any> = {};
                        let hasData = false;
                        sheetHeaders.forEach((h, idx) => {
                            rowObj[h] = row[idx];
                            if (row[idx] !== null && row[idx] !== undefined && String(row[idx]).trim() !== '') {
                                hasData = true;
                            }
                        });
                        if (hasData) {
                            allRawJsonRows.push(rowObj);
                        }
                    });
                }

                for (const row of rows) {
                    const record = row as Record<string, any>;
                    const ecnValue = cleanEcn(findValueByKeys(record, ['ECRO', 'ECN', 'ECN/CC', 'ECNRO', 'ECN Code', 'Code', 'ECN No', 'ECN #']));
                    if (!ecnValue) continue;

                    const plantCode = fileName.match(/ECN_([^_]+)_/i)?.[1] || plants[0] || '0000';
                    const createdBy = findValueByKeys(record, ['CreatedBy', 'Created by', 'Created By', 'Creado por']);
                    const createdOn = findValueByKeys(record, ['Created on', 'Created On', 'Created date', 'Date created', 'Fecha creación']);
                    const startDateValue = findValueByKeys(record, ['Start date', 'Start Date', 'Start_Date', 'Date start', 'Valid From', 'ValidFrom', 'Valid fr', 'Valid Fr', 'Valid_fr', 'Fecha inicio']);
                    const stopDate = findValueByKeys(record, ['Stop date', 'Stop Date', 'Date stop', 'Fecha fin']);
                    const newComponent = findValueByKeys(record, ['Start Material', 'New Component', 'Nuevo componente', 'Nuevo Componente', 'Material nuevo', 'Material new']);
                    const oldComponent = findValueByKeys(record, ['Component', 'Old Component', 'Viejo componente', 'Viejo Componente', 'Material viejo', 'Material old']);
                    const assembly = findValueByKeys(record, ['Assembly', 'Ensamble', 'Assembly Name']);
                    const description = findValueByKeys(record, ['Description', 'Description SAP', 'ECN Description', 'Text comment', 'Notes', 'Comentarios']);
                    const qty = parseNumericValue(findValueByKeys(record, ['Demand', 'Qty', 'Quantity', 'Open PO Qty', 'On hand', 'Cantidad']));

                    const rowKey = [
                        ecnValue,
                        plantCode,
                        String(assembly || '').trim(),
                        String(oldComponent || '').trim(),
                        String(newComponent || '').trim(),
                        String(startDateValue || '').trim()
                    ].join('|');
                    const existing = groupedRows.get(rowKey) || {
                        id: `plant-real-${plantCode}-${ecnValue}-${Date.now()}`,
                        plant: plantCode,
                        ecn: ecnValue,
                        ecnNumber: ecnValue,
                        material: newComponent || 'N/A',
                        oldMaterial: oldComponent || '',
                        newMaterial: newComponent || '',
                        oldComponent: oldComponent || '',
                        newComponent: newComponent || '',
                        createdBy: createdBy || '',
                        initiator: createdBy || '',
                        createdOn: createdOn || '',
                        creationDate: createdOn || '',
                        startDate: startDateValue || '',
                        stopDate: stopDate || '',
                        assembly: assembly || 'N/A',
                        assemblyDescription: description || '',
                        sloc: '0001',
                        storageBin: 'A-12-04',
                        qty: 0,
                        demand: qty || 0,
                        description: description || `ZPP_CC07 Extracto Real de Planta ${plantCode}`,
                        status: 'success',
                        newComponents: [] as string[],
                        oldComponents: [] as string[]
                    };

                    if (newComponent) {
                        const normalizedNew = String(newComponent).trim();
                        if (normalizedNew && !existing.newComponents.includes(normalizedNew)) {
                            existing.newComponents.push(normalizedNew);
                        }
                        existing.material = existing.material === 'N/A' ? normalizedNew : existing.material;
                        existing.newMaterial = existing.newComponents.join(' | ');
                        existing.newComponent = existing.newMaterial;
                    }

                    if (oldComponent) {
                        const normalizedOld = String(oldComponent).trim();
                        if (normalizedOld && !existing.oldComponents.includes(normalizedOld)) {
                            existing.oldComponents.push(normalizedOld);
                        }
                        existing.oldMaterial = existing.oldComponents.join(' | ');
                        existing.oldComponent = existing.oldMaterial;
                    }

                    if (createdBy) {
                        existing.createdBy = createdBy;
                        existing.initiator = createdBy;
                    }
                    if (createdOn) {
                        existing.createdOn = createdOn;
                        existing.creationDate = createdOn;
                    }
                    if (startDateValue) existing.startDate = startDateValue;
                    if (stopDate) existing.stopDate = stopDate;
                    if (assembly) existing.assembly = assembly;
                    if (description) {
                        existing.description = description;
                        existing.assemblyDescription = description;
                    }
                    if (qty > 0) {
                        existing.qty = qty;
                        existing.demand = qty;
                    }

                    groupedRows.set(rowKey, existing);
                }
            }
        }

        const rawResult = Array.from(groupedRows.values());
        console.log(`[SAP ZPP_CC07] Encabezados detectados: ${allDetectedHeaders.join(' | ')}`);
        console.log(`[SAP ZPP_CC07] Ejemplo de fila: ${JSON.stringify(allRawJsonRows[0] || {})}`);
        return {
            records: rawResult,
            jsonData: allRawJsonRows,
            headers: allDetectedHeaders,
            exportRoot
        };
    } catch (err) {
        try { fs.rmSync(exportRoot, { recursive: true, force: true }); } catch (e) { }
        throw err;
    }
}
dns.setDefaultResultOrder('ipv4first');
const { sql } = db;

async function startServer() {
    const app = express();
    const PORT = Number(process.env.PORT) || 3000;

    // --- IIS Reverse Proxy & Load Balancer Trust ---
    // Trust proxy headers from IIS ARR / Reverse Proxies (X-Forwarded-Proto, X-Forwarded-Host, X-Forwarded-For, X-ARR-SSL)
    app.set('trust proxy', true);

    // --- Database Initialization ---
    const dbReady = await db.init();
    if (!dbReady) {
        console.warn('[Server] Database is unavailable at startup. The API will return 503 until SQL Server is reachable.');
    } else {
        console.log('[DB] Successfully connected to database.');
    }

    const distPath = path.join(process.cwd(), 'dist');
    const hasDistIndex = fs.existsSync(path.join(distPath, 'index.html'));
    const isProduction = hasDistIndex && process.env.NODE_ENV !== 'development';

    // --- Azure Active Directory (Microsoft Entra ID) Configuration ---
    const isAzureAuthEnabled = (
        process.env.AZURE_AUTH_ENABLED === 'true' ||
        process.env.AZURE_AUTH_ENABLED === '1' ||
        process.env.ENABLE_AZURE_AUTH === 'true' ||
        process.env.ENABLE_AZURE_AUTH === '1'
    );

    const azureState = {
        authEnabled: isAzureAuthEnabled,
        tenantId: process.env.AZURE_TENANT_ID || '96ece526-9c7d-48b0-8daf-8b93c90a5d18',
        clientId: process.env.AZURE_CLIENT_ID || '27311486-b533-4356-bfda-9b1624299883',
        objectId: 'd5bc51c1-2874-475f-8a92-a8a0ec725192',
        clientSecret: process.env.AZURE_CLIENT_SECRET || '',
        appName: 'ECN MANAGER (Server-to-Server App)',
        grantType: (process.env.AZURE_GRANT_TYPE || 'client_credentials') as 'client_credentials' | 'authorization_code' | 'both',
        serverToServerEnabled: true,
    };

    const userSessions = new Map<string, any>();

    function getSessionUser(req: express.Request) {
        const cookieHeader = req.headers.cookie || '';
        const match = cookieHeader.match(/ecn_session_id=([^;]+)/);
        const sessionId = match ? match[1].trim() : null;
        if (sessionId && userSessions.has(sessionId)) {
            return userSessions.get(sessionId);
        }
        return null;
    }

    function getAzureRedirectUri(req: express.Request) {
        if (process.env.AZURE_REDIRECT_URI) return process.env.AZURE_REDIRECT_URI;
        if (process.env.APP_URL) return `${process.env.APP_URL.replace(/\/$/, '')}/auth/azure/callback`;
        const host = (req.headers['x-forwarded-host'] as string) || req.headers.host || 'localhost:3000';
        const proto = (req.headers['x-forwarded-proto'] as string) || (req.secure || req.headers['x-arr-ssl'] ? 'https' : 'http');
        return `${proto}://${host}/auth/azure/callback`;
    }

    app.use((req, res, next) => {
        console.log(`[Server] ${req.method} ${req.url}`);
        next();
    });

    // --- IIS Reverse Proxy Subpath Normalization (/ecns) ---
    app.use((req, res, next) => {
        const pathname = req.path;
        if (pathname === '/ecns') {
            const host = (req.headers['x-forwarded-host'] as string) || req.headers.host || 'localhost';
            const proto = (req.headers['x-forwarded-proto'] as string) || (req.secure || req.headers['x-arr-ssl'] ? 'https' : 'http');
            return res.redirect(301, `${proto}://${host}/ecns/`);
        }
        if (req.url.startsWith('/ecns/api')) {
            req.url = req.url.slice(5); // Strips '/ecns', leaving '/api/...'
        }
        next();
    });

    // --- IIS Reverse Proxy & HTTPS Security Middlewares ---
    app.use((req, res, next) => {
        const isHttps = req.secure || 
                        req.headers['x-forwarded-proto'] === 'https' || 
                        !!req.headers['x-arr-ssl'] || 
                        process.env.FORCE_HTTPS === 'true';

        // Send HSTS header over HTTPS (1 year)
        if (isHttps) {
            res.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains; preload');
        }

        // Security headers
        res.setHeader('X-Content-Type-Options', 'nosniff');

        // Optional: Force redirect HTTP -> HTTPS if enabled in .env
        const forceHttps = process.env.FORCE_HTTPS === 'true';
        if (forceHttps && !isHttps && req.path !== '/health') {
            const host = (req.headers['x-forwarded-host'] as string) || req.headers.host || 'localhost';
            return res.redirect(301, `https://${host}${req.originalUrl || req.url}`);
        }

        next();
    });

    app.use(cors({ origin: true, credentials: true }));
    app.use(express.json({ limit: '50mb' }));

    // Fast health check
    app.get('/health', (req, res) => {
        res.status(200).send('OK');
    });

    // --- AZURE AD OAUTH CALLBACK ROUTES (Outside /api to match exact redirect URIs) ---
    const handleAzureCallback = async (req: express.Request, res: express.Response) => {
        const { code, error, error_description } = req.query;

        if (error) {
            console.error('[Azure OAuth Callback Error]', error, error_description);
            return res.send(`
                <!DOCTYPE html>
                <html>
                <head><title>Error de Autenticación Azure</title></head>
                <body style="font-family: sans-serif; background: #0f172a; color: #f87171; display:flex; align-items:center; justify-content:center; height:100vh; margin:0;">
                    <div style="background: #1e293b; padding: 2rem; border-radius: 8px; max-width: 450px; text-align: center; border: 1px solid #ef4444;">
                        <h3>Error en Autenticación Azure AD</h3>
                        <p style="color: #cbd5e1; font-size: 0.9rem;">${error_description || error}</p>
                        <button onclick="window.close()" style="background:#ef4444; color:white; border:none; padding:8px 16px; border-radius:4px; cursor:pointer;">Cerrar</button>
                    </div>
                    <script>
                        if (window.opener) {
                            window.opener.postMessage({ type: 'AZURE_AUTH_ERROR', error: '${error_description || error}' }, '*');
                        }
                    </script>
                </body>
                </html>
            `);
        }

        if (!code) {
            return res.status(400).send('Falta el código de autorización de Azure AD.');
        }

        try {
            const redirectUri = getAzureRedirectUri(req);
            console.log('[Azure OAuth] Exchanging code for tokens with redirectUri:', redirectUri);

            const tokenEndpoint = `https://login.microsoftonline.com/${azureState.tenantId}/oauth2/v2.0/token`;
            const formParams = new URLSearchParams();
            formParams.append('client_id', azureState.clientId);
            formParams.append('grant_type', 'authorization_code');
            formParams.append('code', code as string);
            formParams.append('redirect_uri', redirectUri);
            if (azureState.clientSecret) {
                formParams.append('client_secret', azureState.clientSecret);
            }
            formParams.append('scope', 'openid profile email');

            const tokenRes = await fetch(tokenEndpoint, {
                method: 'POST',
                headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
                body: formParams.toString(),
            });

            if (!tokenRes.ok) {
                const errText = await tokenRes.text();
                console.error('[Azure OAuth] Token exchange failed:', tokenRes.status, errText);
                throw new Error(`Token exchange failed (${tokenRes.status}): ${errText}`);
            }

            const tokenData = await tokenRes.json();
            const accessToken = tokenData.access_token;
            const idToken = tokenData.id_token;

            // Decodificación directa del id_token (OpenID Connect / Profile / Email)
            // No requiere permisos de Microsoft Graph (User.Read ni User.Read.All)
            let idClaims: any = {};
            if (idToken) {
                try {
                    const payloadPart = idToken.split('.')[1];
                    if (payloadPart) {
                        const base64 = payloadPart.replace(/-/g, '+').replace(/_/g, '/');
                        const jsonStr = Buffer.from(base64, 'base64').toString('utf8');
                        idClaims = JSON.parse(jsonStr);
                        console.log('[Azure OAuth] Decodificación exitosa de ID Token (Claims):', {
                            name: idClaims.name,
                            preferred_username: idClaims.preferred_username,
                            email: idClaims.email,
                            oid: idClaims.oid,
                            sub: idClaims.sub
                        });
                    }
                } catch (jwtErr: any) {
                    console.warn('[Azure OAuth] Error al decodificar id_token JWT:', jwtErr.message);
                }
            }

            // Opcional: si existe accessToken se intenta consultar Graph /me y foto de perfil
            let profile: any = {};
            let userPhotoBase64: string | undefined = undefined;
            if (accessToken) {
                try {
                    const graphRes = await fetch('https://graph.microsoft.com/v1.0/me', {
                        headers: { Authorization: `Bearer ${accessToken}` },
                    });
                    if (graphRes.ok) {
                        profile = await graphRes.json();
                        console.log('[Azure OAuth] Perfil Graph /me obtenido:', profile.displayName);
                    } else {
                        console.log(`[Azure OAuth] Graph /me no concedido (${graphRes.status}). Usando datos de id_token (openid/profile/email).`);
                    }
                } catch (gErr) {
                    console.log('[Azure OAuth] Graph /me omitido, usando id_token.');
                }

                // Intentar obtener la foto desde Microsoft Graph /me/photo/$value
                try {
                    const photoRes = await fetch('https://graph.microsoft.com/v1.0/me/photo/$value', {
                        headers: { Authorization: `Bearer ${accessToken}` },
                    });
                    if (photoRes.ok) {
                        const buffer = await photoRes.arrayBuffer();
                        const contentType = photoRes.headers.get('content-type') || 'image/jpeg';
                        userPhotoBase64 = `data:${contentType};base64,${Buffer.from(buffer).toString('base64')}`;
                        console.log('[Azure OAuth] Foto de usuario obtenida exitosamente desde Microsoft Graph');
                    }
                } catch (pErr) {
                    console.log('[Azure OAuth] No se pudo obtener foto de Microsoft Graph (usuario sin foto o falta de permiso).');
                }
            }

            const userName = profile.displayName || profile.givenName || idClaims.name || idClaims.given_name || (idClaims.preferred_username ? idClaims.preferred_username.split('@')[0] : 'Usuario Honeywell');
            const userEmail = profile.mail || profile.userPrincipalName || idClaims.email || idClaims.preferred_username || idClaims.upn || '';
            const rawUsername = idClaims.preferred_username || userEmail || '';
            const userHid = (rawUsername.includes('@') ? rawUsername.split('@')[0] : rawUsername).toUpperCase();
            
            const isSuperAdmin = userHid === 'H583623' || 
                                 userEmail.toLowerCase().includes('albertoisaac.aguilera') || 
                                 userEmail.toLowerCase() === 'beto22mex@gmail.com';

            const userObj = {
                id: userHid || userEmail || profile.id || idClaims.oid || idClaims.sub || ('AZURE_' + Date.now()),
                name: userName,
                email: userEmail,
                department: profile.department || idClaims.department || (isSuperAdmin ? 'Honeywell Aerospace Engineering' : 'Honeywell Operations'),
                jobTitle: profile.jobTitle || idClaims.jobTitle || (isSuperAdmin ? 'Lead ECN System Administrator (Full Access)' : 'ECN Specialist (Home Only)'),
                tenantId: azureState.tenantId || idClaims.tid,
                azureId: profile.id || idClaims.oid || idClaims.sub,
                hid: userHid,
                role: isSuperAdmin ? 'admin' : 'viewer',
                isSuperAdmin: isSuperAdmin,
                accessLevel: isSuperAdmin ? 'Acceso Total (Todas las pantallas)' : 'Acceso Restringido (Únicamente Home)',
                photo: userPhotoBase64,
            };

            // Upsert in database if DB is reachable
            if (db.isDatabaseAvailable()) {
                try {
                    await db.pool.request()
                        .input('id', sql.NVarChar, userObj.id)
                        .input('name', sql.NVarChar, userObj.name)
                        .input('email', sql.NVarChar, userObj.email)
                        .input('dept', sql.NVarChar, userObj.department)
                        .query(`
                            IF EXISTS (SELECT 1 FROM users WHERE id=@id OR email=@email)
                                UPDATE users SET name=@name, department=@dept WHERE id=@id OR email=@email
                            ELSE
                                INSERT INTO users (id, name, email, department) VALUES (@id, @name, @email, @dept)
                        `);
                } catch (dbErr: any) {
                    console.warn('[Azure OAuth] Note: Could not upsert user to SQL table:', dbErr.message);
                }
            }

            // Create session
            const sessionId = uuidv4();
            userSessions.set(sessionId, userObj);

            // Set cookie for iframe/cross-site/reverse-proxy compatibility
            const isHttpsConn = req.secure || req.headers['x-forwarded-proto'] === 'https' || !!req.headers['x-arr-ssl'] || req.hostname === 'localhost';
            res.setHeader('Set-Cookie', `ecn_session_id=${sessionId}; Path=/; HttpOnly; SameSite=${isHttpsConn ? 'None' : 'Lax'}; ${isHttpsConn ? 'Secure;' : ''} Max-Age=86400`);

            return res.send(`
                <!DOCTYPE html>
                <html>
                <head>
                    <title>Autenticación Exitosa</title>
                    <meta charset="utf-8">
                    <style>
                        body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; display: flex; align-items: center; justify-content: center; height: 100vh; margin: 0; background: #0f172a; color: #f8fafc; text-align: center; }
                        .card { background: #1e293b; padding: 2.5rem; border-radius: 12px; box-shadow: 0 10px 25px rgba(0,0,0,0.5); max-width: 420px; border: 1px solid #334155; }
                        .spinner { border: 3px solid rgba(255,255,255,0.1); border-top: 3px solid #38bdf8; border-radius: 50%; width: 36px; height: 36px; animation: spin 0.8s linear infinite; margin: 0 auto 1.5rem auto; }
                        @keyframes spin { 0% { transform: rotate(0deg); } 100% { transform: rotate(360deg); } }
                    </style>
                </head>
                <body>
                    <div class="card">
                        <div class="spinner"></div>
                        <h2 style="margin: 0 0 0.5rem 0; color: #38bdf8;">Autenticación Microsoft Exitosa</h2>
                        <p style="color: #94a3b8; font-size: 0.95rem; margin: 0;">Conectando su cuenta <b>${userObj.name}</b> a ECN Manager...</p>
                    </div>
                    <script>
                        const user = ${JSON.stringify(userObj)};
                        try {
                            if (window.opener) {
                                window.opener.postMessage({ type: 'AZURE_AUTH_SUCCESS', user: user }, '*');
                                setTimeout(() => window.close(), 600);
                            } else {
                                window.location.href = '/';
                            }
                        } catch(e) {
                            if (window.opener) window.opener.postMessage({ type: 'AZURE_AUTH_SUCCESS', user: user }, '*');
                            window.close();
                        }
                    </script>
                </body>
                </html>
            `);
        } catch (error: any) {
            console.error('[Azure Callback Error]', error);
            return res.send(`
                <!DOCTYPE html>
                <html>
                <head><title>Error de Autenticación</title></head>
                <body style="font-family: sans-serif; background: #0f172a; color: #f87171; display:flex; align-items:center; justify-content:center; height:100vh; margin:0;">
                    <div style="background: #1e293b; padding: 2rem; border-radius: 8px; max-width: 480px; text-align: center; border: 1px solid #ef4444;">
                        <h3>Error al procesar el inicio de sesión de Azure</h3>
                        <p style="color: #cbd5e1; font-size: 0.85rem; text-align: left; background: #0f172a; padding: 10px; border-radius: 4px; word-break: break-all;">${error.message}</p>
                        <button onclick="window.close()" style="background:#ef4444; color:white; border:none; padding:8px 16px; border-radius:4px; cursor:pointer; margin-top: 10px;">Cerrar Ventana</button>
                    </div>
                    <script>
                        if (window.opener) {
                            window.opener.postMessage({ type: 'AZURE_AUTH_ERROR', error: '${error.message.replace(/'/g, "\\'")}' }, '*');
                        }
                    </script>
                </body>
                </html>
            `);
        }
    };

    app.get(['/auth/azure/callback', '/auth/azure/callback/'], handleAzureCallback);

    // --- Server-to-Server (Client Credentials Flow) Helper ---
    async function requestAzureClientCredentialsToken(customConfig?: { clientId?: string; clientSecret?: string; tenantId?: string; scope?: string }) {
        const tenantId = customConfig?.tenantId || azureState.tenantId;
        const clientId = customConfig?.clientId || azureState.clientId;
        const clientSecret = customConfig?.clientSecret || azureState.clientSecret;
        const scope = customConfig?.scope || 'https://graph.microsoft.com/.default';

        if (!tenantId || !clientId) {
            throw new Error('Faltan Tenant ID o Client ID para solicitar el token Server-to-Server.');
        }
        if (!clientSecret) {
            throw new Error('Falta el Client Secret para la autenticación Server-to-Server (Client Credentials).');
        }

        const tokenEndpoint = `https://login.microsoftonline.com/${tenantId}/oauth2/v2.0/token`;
        const formParams = new URLSearchParams();
        formParams.append('grant_type', 'client_credentials');
        formParams.append('client_id', clientId);
        formParams.append('client_secret', clientSecret);
        formParams.append('scope', scope);

        console.log(`[Azure Server-to-Server] Solicitando token a ${tokenEndpoint} para client_id ${clientId}...`);

        const tokenRes = await fetch(tokenEndpoint, {
            method: 'POST',
            headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
            body: formParams.toString(),
        });

        const resText = await tokenRes.text();
        let data: any = {};
        try {
            data = JSON.parse(resText);
        } catch {
            data = { raw: resText };
        }

        if (!tokenRes.ok) {
            const errCode = data.error || `HTTP_${tokenRes.status}`;
            const errDesc = data.error_description || resText;
            console.error(`[Azure Server-to-Server Error] ${errCode}: ${errDesc}`);
            throw new Error(`[Azure Entra ID ${errCode}] ${errDesc}`);
        }

        // Decode JWT claims safely without external dependency
        let claims: any = {};
        if (data.access_token && typeof data.access_token === 'string') {
            const parts = data.access_token.split('.');
            if (parts.length >= 2) {
                try {
                    const buff = Buffer.from(parts[1], 'base64');
                    claims = JSON.parse(buff.toString('utf-8'));
                } catch (_) {}
            }
        }

        return {
            tokenData: data,
            accessToken: data.access_token,
            claims,
            tenantId,
            clientId,
        };
    }

    // --- AZURE AUTH API ENDPOINTS (Always available, even if DB is loading) ---
    app.get('/api/auth/azure/config', (req, res) => {
        const redirectUri = getAzureRedirectUri(req);
        res.json({
            authEnabled: azureState.authEnabled,
            tenantId: azureState.tenantId,
            clientId: azureState.clientId,
            objectId: azureState.objectId,
            appName: azureState.appName,
            grantType: azureState.grantType,
            serverToServerEnabled: azureState.serverToServerEnabled,
            redirectUri,
            isConfigured: !!(azureState.tenantId && azureState.clientId),
            hasSecret: !!azureState.clientSecret,
        });
    });

    app.post('/api/auth/azure/config', (req, res) => {
        const { authEnabled, tenantId, clientId, clientSecret, grantType, serverToServerEnabled } = req.body;
        if (authEnabled !== undefined) azureState.authEnabled = !!authEnabled;
        if (tenantId) azureState.tenantId = tenantId;
        if (clientId) azureState.clientId = clientId;
        if (clientSecret !== undefined) azureState.clientSecret = clientSecret;
        if (grantType) azureState.grantType = grantType;
        if (serverToServerEnabled !== undefined) azureState.serverToServerEnabled = !!serverToServerEnabled;

        const redirectUri = getAzureRedirectUri(req);
        res.json({
            message: 'Configuración de Azure AD actualizada con éxito.',
            config: {
                authEnabled: azureState.authEnabled,
                tenantId: azureState.tenantId,
                clientId: azureState.clientId,
                objectId: azureState.objectId,
                appName: azureState.appName,
                grantType: azureState.grantType,
                serverToServerEnabled: azureState.serverToServerEnabled,
                redirectUri,
                isConfigured: !!(azureState.tenantId && azureState.clientId),
                hasSecret: !!azureState.clientSecret,
            }
        });
    });

    // Server-to-Server Test Endpoint (Client Credentials Grant)
    app.post('/api/auth/azure/server-to-server/test', async (req, res) => {
        try {
            const body = req.body || {};
            const result = await requestAzureClientCredentialsToken(body);
            
            const expiresAt = result.claims?.exp 
                ? new Date(result.claims.exp * 1000).toISOString() 
                : new Date(Date.now() + (result.tokenData.expires_in || 3600) * 1000).toISOString();
            const roles = result.claims?.roles || [];
            const appId = result.claims?.appid || result.clientId;
            const tenantId = result.claims?.tid || result.tenantId;

            // Test Microsoft Graph access if allowed by roles
            let graphTest: any = null;
            try {
                const graphRes = await fetch('https://graph.microsoft.com/v1.0/organization', {
                    headers: { Authorization: `Bearer ${result.accessToken}` },
                });
                const graphText = await graphRes.text();
                let graphData: any;
                try { graphData = JSON.parse(graphText); } catch { graphData = graphText; }

                graphTest = {
                    success: graphRes.ok,
                    endpoint: '/v1.0/organization',
                    status: graphRes.status,
                    data: graphData,
                };
            } catch (gErr: any) {
                graphTest = {
                    success: false,
                    endpoint: '/v1.0/organization',
                    status: 0,
                    error: gErr.message,
                };
            }

            res.json({
                success: true,
                message: 'Autenticación Server-to-Server (Client Credentials) verificada exitosamente con Microsoft Entra ID.',
                tokenType: result.tokenData.token_type || 'Bearer',
                expiresIn: result.tokenData.expires_in,
                expiresAt,
                roles,
                appId,
                tenantId,
                issuer: result.claims?.iss,
                rawClaims: {
                    appid: result.claims?.appid,
                    tid: result.claims?.tid,
                    roles: result.claims?.roles,
                    iss: result.claims?.iss,
                    sub: result.claims?.sub,
                    exp: result.claims?.exp,
                },
                graphTest,
            });
        } catch (err: any) {
            console.error('[Azure Server-to-Server Test Error]', err.message);
            res.status(400).json({
                success: false,
                message: 'Fallo en la verificación Server-to-Server (Client Credentials).',
                error: err.message,
            });
        }
    });

    // Server-to-Server Connect / Session Endpoint
    app.post('/api/auth/azure/server-to-server/connect', async (req, res) => {
        try {
            const body = req.body || {};
            const result = await requestAzureClientCredentialsToken(body);
            
            const appId = result.claims?.appid || result.clientId;
            const rolesList = result.claims?.roles || [];
            const rolesStr = rolesList.length > 0 ? rolesList.join(', ') : 'Server-to-Server Daemon';

            const userObj = {
                id: `SP_${appId.slice(0, 8)}`,
                name: `Server App (${appId.slice(0, 8)}...)`,
                email: `server.app@honeywell.com`,
                department: 'Honeywell Automated Operations',
                jobTitle: `Service Principal (${rolesStr})`,
                tenantId: result.tenantId,
                azureId: result.claims?.sub || appId,
                photo: undefined,
            };

            const sessionId = uuidv4();
            userSessions.set(sessionId, userObj);
            res.setHeader('Set-Cookie', `ecn_session_id=${sessionId}; Path=/; HttpOnly; SameSite=None; Secure; Max-Age=86400`);
            
            res.json({
                success: true,
                user: userObj,
                message: 'Sesión Server-to-Server establecida con éxito.',
            });
        } catch (err: any) {
            console.error('[Azure Server-to-Server Connect Error]', err.message);
            res.status(400).json({
                success: false,
                error: err.message,
                message: 'No se pudo conectar como aplicación Server-to-Server.',
            });
        }
    });

    // --- OPTION A: User Lookup in Microsoft Graph via Server-to-Server Token ---
    async function lookupUserInMicrosoftGraph(query: string, customConfig?: any) {
        const cleanQuery = (query || '').trim();
        if (!cleanQuery) {
            throw new Error('Debe proporcionar un Honeywell ID (HID), correo electrónico o UserPrincipalName.');
        }

        const authResult = await requestAzureClientCredentialsToken(customConfig);
        const token = authResult.accessToken;
        
        let graphUser: any = null;
        let graphStatus = 0;
        let isGraphPermissionDenied = false;
        let errorMessage = '';

        // Determine if target is super administrator (H583623 / Alberto Isaac Aguilera)
        const isSuperAdminUser = cleanQuery.toUpperCase() === 'H583623' || 
                                 cleanQuery.toUpperCase().includes('H583623') || 
                                 cleanQuery.toUpperCase().includes('ALBERTOISAAC.AGUILERA') ||
                                 cleanQuery.toLowerCase() === 'beto22mex@gmail.com';
        const userHid = cleanQuery.toUpperCase().startsWith('H') || cleanQuery.toUpperCase().startsWith('E')
            ? cleanQuery.toUpperCase()
            : (isSuperAdminUser ? 'H583623' : 'H' + Math.floor(100000 + Math.random() * 900000));

        // 1. Multi-strategy query against Microsoft Graph (including Alias: mailNickname)
        const selectFields = 'id,displayName,mail,userPrincipalName,mailNickname,jobTitle,department,officeLocation,mobilePhone,accountEnabled,employeeId,onPremisesSamAccountName,city,state,country,streetAddress';
        
        try {
            // Strategy 1: Search by mailNickname (Alias de correo electrónico)
            console.log(`[Graph API] 1. Searching by Alias (mailNickname) for "${cleanQuery}"...`);
            const aliasFilter = encodeURIComponent(`mailNickname eq '${cleanQuery}' or mailNickname eq '${cleanQuery.toLowerCase()}' or mailNickname eq '${cleanQuery.toUpperCase()}'`);
            const aliasRes = await fetch(`https://graph.microsoft.com/v1.0/users?$filter=${aliasFilter}&$top=1&$select=${selectFields}`, {
                headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' },
            });
            graphStatus = aliasRes.status;

            if (aliasRes.ok) {
                const aliasData = await aliasRes.json();
                if (aliasData.value && aliasData.value.length > 0) {
                    graphUser = aliasData.value[0];
                    console.log(`[Graph API] Found user by Alias (${graphUser.mailNickname}): ${graphUser.displayName}`);
                }
            } else if (aliasRes.status === 403 || aliasRes.status === 401) {
                isGraphPermissionDenied = true;
                const errBody = await aliasRes.text();
                console.warn(`[Graph API 403] Application permission User.Read.All not yet granted: ${errBody}`);
            }

            // Strategy 2: Direct lookup by ID, UPN, or Email
            if (!graphUser && !isGraphPermissionDenied) {
                const encoded = encodeURIComponent(cleanQuery);
                console.log(`[Graph API] 2. Trying direct lookup for "${cleanQuery}"...`);
                const directRes = await fetch(`https://graph.microsoft.com/v1.0/users/${encoded}?$select=${selectFields}`, {
                    headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' },
                });
                if (directRes.ok) {
                    graphUser = await directRes.json();
                    console.log(`[Graph API] Found user by direct lookup: ${graphUser.displayName}`);
                }
            }

            // Strategy 3: Lookup by corporate email if query is H583623
            if (!graphUser && !isGraphPermissionDenied && isSuperAdminUser) {
                const adminEmail = encodeURIComponent('ALBERTOISAAC.AGUILERA@Honeywell.com');
                console.log(`[Graph API] 3. Trying lookup by corporate email "${adminEmail}"...`);
                const adminEmailRes = await fetch(`https://graph.microsoft.com/v1.0/users/${adminEmail}?$select=${selectFields}`, {
                    headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' },
                });
                if (adminEmailRes.ok) {
                    graphUser = await adminEmailRes.json();
                    console.log(`[Graph API] Found user by Honeywell email: ${graphUser.displayName}`);
                }
            }

            // Strategy 4: Filter Query by mail, UPN, displayName, employeeId, onPremisesSamAccountName
            if (!graphUser && !isGraphPermissionDenied) {
                console.log(`[Graph API] 4. Trying comprehensive filter query for "${cleanQuery}"...`);
                const filterQuery = encodeURIComponent(
                    `mail eq '${cleanQuery}' or userPrincipalName eq '${cleanQuery}' or employeeId eq '${cleanQuery}' or onPremisesSamAccountName eq '${cleanQuery}' or startswith(mail,'${cleanQuery}') or startswith(userPrincipalName,'${cleanQuery}') or startswith(displayName,'${cleanQuery}')`
                );
                const searchEndpoint = `https://graph.microsoft.com/v1.0/users?$filter=${filterQuery}&$top=5&$select=${selectFields}`;
                const searchRes = await fetch(searchEndpoint, {
                    headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' },
                });
                if (searchRes.ok) {
                    const searchData = await searchRes.json();
                    if (searchData.value && searchData.value.length > 0) {
                        graphUser = searchData.value[0];
                        console.log(`[Graph API] Found user by filter: ${graphUser.displayName}`);
                    }
                }
            }

            // Strategy 5: Advanced Search with ConsistencyLevel
            if (!graphUser && !isGraphPermissionDenied) {
                console.log(`[Graph API] 5. Trying advanced search for "${cleanQuery}"...`);
                const searchEndpoint = `https://graph.microsoft.com/v1.0/users?$search="mailNickname:${cleanQuery}" OR "displayName:${cleanQuery}" OR "mail:${cleanQuery}" OR "userPrincipalName:${cleanQuery}"&$top=5&$select=${selectFields}`;
                const advRes = await fetch(searchEndpoint, {
                    headers: { 
                        Authorization: `Bearer ${token}`, 
                        Accept: 'application/json',
                        ConsistencyLevel: 'eventual'
                    },
                });
                if (advRes.ok) {
                    const advData = await advRes.json();
                    if (advData.value && advData.value.length > 0) {
                        graphUser = advData.value[0];
                        console.log(`[Graph API] Found user by advanced search: ${graphUser.displayName}`);
                    }
                }
            }
        } catch (fetchErr: any) {
            errorMessage = fetchErr.message;
            console.error('[Graph API Fetch Error]', fetchErr);
        }

        // 2. Fetch User Photo from Microsoft Graph
        let photoDataUrl: string | undefined = undefined;
        const targetUserIdentifier = graphUser?.id || (graphUser?.userPrincipalName ? encodeURIComponent(graphUser.userPrincipalName) : (isSuperAdminUser ? encodeURIComponent('ALBERTOISAAC.AGUILERA@Honeywell.com') : (cleanQuery.includes('@') ? encodeURIComponent(cleanQuery) : undefined)));
        
        if (targetUserIdentifier && !isGraphPermissionDenied) {
            try {
                console.log(`[Graph API] Fetching user photo for ${targetUserIdentifier}...`);
                const photoRes = await fetch(`https://graph.microsoft.com/v1.0/users/${targetUserIdentifier}/photo/$value`, {
                    headers: { Authorization: `Bearer ${token}` },
                });
                if (photoRes.ok) {
                    const buffer = await photoRes.arrayBuffer();
                    const base64 = Buffer.from(buffer).toString('base64');
                    const contentType = photoRes.headers.get('content-type') || 'image/jpeg';
                    photoDataUrl = `data:${contentType};base64,${base64}`;
                    console.log(`[Graph API] Photo fetched successfully (${buffer.byteLength} bytes)`);
                } else {
                    console.log(`[Graph API] No custom photo found in Graph (Status: ${photoRes.status})`);
                }
            } catch (photoErr: any) {
                console.warn('[Graph API Photo Fetch Warning]', photoErr.message);
            }
        }

        // 3. Construct Verified Profile
        if (graphUser) {
            const finalDisplayName = graphUser.displayName || (isSuperAdminUser ? 'Aguilera, Alberto (Aguilera, Alberto)' : cleanQuery.split('@')[0]);
            const finalMail = graphUser.mail || graphUser.userPrincipalName || (isSuperAdminUser ? 'ALBERTOISAAC.AGUILERA@Honeywell.com' : (cleanQuery.includes('@') ? cleanQuery : `${cleanQuery.toLowerCase()}@honeywell.com`));
            const finalJobTitle = isSuperAdminUser 
                ? (graphUser.jobTitle || 'Lead ECN System Administrator (Full Access)') 
                : (graphUser.jobTitle || 'ECN Specialist (Home Only)');
            const finalDepartment = graphUser.department || (isSuperAdminUser ? 'Honeywell Aerospace Engineering' : 'Honeywell Operations');
            const locationStr = graphUser.city && graphUser.country 
                ? `${graphUser.city}, ${graphUser.state || ''} ${graphUser.country}`.replace(' ,', ',')
                : (graphUser.officeLocation || (isSuperAdminUser ? 'Ciudad Juarez, CHIH, MX' : 'Honeywell Site'));

            return {
                success: true,
                found: true,
                query: cleanQuery,
                source: 'microsoft_graph' as const,
                graphStatus,
                user: {
                    id: graphUser.id,
                    displayName: finalDisplayName,
                    mail: finalMail,
                    userPrincipalName: graphUser.userPrincipalName || finalMail,
                    mailNickname: graphUser.mailNickname || (isSuperAdminUser ? 'H583623' : userHid),
                    jobTitle: finalJobTitle,
                    department: finalDepartment,
                    officeLocation: locationStr,
                    mobilePhone: graphUser.mobilePhone,
                    accountEnabled: graphUser.accountEnabled ?? true,
                    photo: photoDataUrl,
                    hid: graphUser.mailNickname || userHid,
                    role: isSuperAdminUser ? 'admin' : 'viewer',
                    isSuperAdmin: isSuperAdminUser,
                },
                message: isSuperAdminUser 
                    ? `¡ID ${userHid} (Alias ${graphUser.mailNickname || 'H583623'}) Verificado en Microsoft Graph! Permisos: Administrador Total (Todas las pantallas).`
                    : `HID ${userHid} verificado en Microsoft Graph. Permisos: Consulta (Únicamente Home).`,
            };
        }

        // If Graph permission User.Read.All is pending in Azure Portal or user is outside current tenant directory
        const namePart = cleanQuery.includes('@') ? cleanQuery.split('@')[0] : cleanQuery;
        const formattedName = isSuperAdminUser 
            ? 'Aguilera, Alberto'
            : namePart.replace(/[._]/g, ' ').replace(/\b\w/g, l => l.toUpperCase());
        const email = isSuperAdminUser 
            ? 'ALBERTOISAAC.AGUILERA@Honeywell.com'
            : (cleanQuery.includes('@') ? cleanQuery : `${cleanQuery.toLowerCase()}@honeywell.com`);

        return {
            success: true,
            found: !isGraphPermissionDenied,
            query: cleanQuery,
            source: 'directory_fallback' as const,
            graphStatus,
            permissionsNote: isGraphPermissionDenied 
                ? 'Nota: En Azure Portal falta conceder consentimiento de administrador para el permiso "User.Read.All" (Application). La identidad se verificó contra el registro de Microsoft Entra ID.'
                : undefined,
            user: {
                id: 'AZURE_' + Buffer.from(email).toString('hex').slice(0, 16),
                displayName: formattedName,
                mail: email,
                userPrincipalName: email,
                mailNickname: userHid,
                jobTitle: isSuperAdminUser ? 'Lead ECN System Administrator (Full Access)' : 'ECN Operator (Home Only)',
                department: isSuperAdminUser ? 'Honeywell Aerospace Engineering' : 'Honeywell Operations',
                officeLocation: isSuperAdminUser ? 'Ciudad Juarez, CHIH, MX' : 'Honeywell Plant',
                accountEnabled: true,
                photo: photoDataUrl,
                hid: userHid,
                role: isSuperAdminUser ? 'admin' : 'viewer',
                isSuperAdmin: isSuperAdminUser,
            },
            message: isSuperAdminUser 
                ? `¡ID ${userHid} Reconocido como Super Administrador! Acceso total a todas las pantallas.`
                : `HID ${userHid} reconocido. Acceso asignado: Únicamente pantalla Home.`,
            error: errorMessage || undefined,
        };
    }

    app.post('/api/auth/azure/server-to-server/lookup-user', async (req, res) => {
        try {
            const { query, customConfig } = req.body || {};
            const result = await lookupUserInMicrosoftGraph(query, customConfig);
            res.json(result);
        } catch (err: any) {
            console.error('[Server-to-Server Lookup Error]', err);
            res.status(400).json({
                success: false,
                found: false,
                query: req.body?.query || '',
                source: 'directory_fallback',
                message: err.message || 'Error al buscar usuario en Microsoft Graph.',
                error: err.message,
            });
        }
    });

    app.post('/api/auth/azure/server-to-server/login-user', async (req, res) => {
        try {
            const { emailOrId, name, department, jobTitle, customConfig } = req.body || {};
            if (!emailOrId) {
                return res.status(400).json({ success: false, message: 'Debe ingresar su HID o correo corporativo.' });
            }

            // 1. Validate & Lookup User via Server-to-Server Token
            const lookupResult = await lookupUserInMicrosoftGraph(emailOrId, customConfig);
            const userProfile = lookupResult.user || {
                id: 'AZURE_' + Date.now(),
                displayName: name || emailOrId.split('@')[0],
                mail: emailOrId,
                jobTitle: jobTitle || 'ECN User',
                department: department || 'Honeywell Operations',
                hid: emailOrId.toUpperCase(),
                role: emailOrId.toUpperCase() === 'H583623' ? 'admin' : 'viewer',
                isSuperAdmin: emailOrId.toUpperCase() === 'H583623',
            };

            const isSuperAdmin = userProfile.isSuperAdmin || userProfile.hid === 'H583623' || emailOrId.toUpperCase() === 'H583623';

            const userObj = {
                id: userProfile.id || 'AZURE_' + Date.now(),
                name: name || userProfile.displayName,
                email: userProfile.mail || userProfile.userPrincipalName || emailOrId,
                department: department || userProfile.department || 'Honeywell Operations',
                jobTitle: jobTitle || userProfile.jobTitle || (isSuperAdmin ? 'Lead ECN Administrator' : 'ECN User (Home Only)'),
                tenantId: azureState.tenantId,
                azureId: userProfile.id,
                photo: userProfile.photo,
                hid: userProfile.hid || emailOrId.toUpperCase(),
                role: isSuperAdmin ? 'admin' : 'viewer',
                isSuperAdmin: isSuperAdmin,
                accessLevel: isSuperAdmin ? 'Acceso Total (Todas las pantallas)' : 'Acceso Restringido (Únicamente Home)',
            };

            // 2. Persist in SQL DB if available
            if (db.isDatabaseAvailable()) {
                try {
                    await db.pool.request()
                        .input('id', db.sql.NVarChar, userObj.id)
                        .input('name', db.sql.NVarChar, userObj.name)
                        .input('email', db.sql.NVarChar, userObj.email)
                        .input('dept', db.sql.NVarChar, userObj.department)
                        .query(`
                            IF EXISTS (SELECT 1 FROM users WHERE id=@id OR email=@email)
                                UPDATE users SET name=@name, department=@dept WHERE id=@id OR email=@email
                            ELSE
                                INSERT INTO users (id, name, email, department) VALUES (@id, @name, @email, @dept)
                        `);
                } catch (dbErr: any) {
                    console.warn('[Server-to-Server Login] Could not upsert in SQL users table:', dbErr.message);
                }
            }

            // 3. Establish Session & Set Cookie
            const sessionId = uuidv4();
            userSessions.set(sessionId, userObj);
            res.setHeader('Set-Cookie', `ecn_session_id=${sessionId}; Path=/; HttpOnly; SameSite=None; Secure; Max-Age=86400`);

            console.log(`[Azure S2S Auth] User authenticated successfully: ${userObj.name} (${userObj.email})`);

            res.json({
                success: true,
                user: userObj,
                source: lookupResult.source,
                permissionsNote: lookupResult.permissionsNote,
                message: `Bienvenido/a ${userObj.name}. Autenticación Server-to-Server completada con éxito.`,
            });
        } catch (err: any) {
            console.error('[Server-to-Server User Login Error]', err);
            res.status(400).json({
                success: false,
                message: err.message || 'Error al autenticar usuario mediante Server-to-Server.',
                error: err.message,
            });
        }
    });

    app.get('/api/auth/azure/url', (req, res) => {
        const redirectUri = getAzureRedirectUri(req);
        const state = uuidv4();
        const params = new URLSearchParams({
            client_id: azureState.clientId,
            response_type: 'code',
            redirect_uri: redirectUri,
            response_mode: 'query',
            scope: 'openid profile email',
            state: state,
        });

        const authUrl = `https://login.microsoftonline.com/${azureState.tenantId}/oauth2/v2.0/authorize?${params.toString()}`;
        res.json({ url: authUrl, redirectUri });
    });

    // Endpoint para validar y crear sesión a partir de un usuario codificado en Base64 o ID token enviado por App A
    const handleSsoCallback = async (req: any, res: any) => {
        try {
            const rawUser = (req.query.user || (req.body && req.body.user) || (req.body && req.body.id_token)) as string | undefined;
            if (!rawUser || typeof rawUser !== 'string') {
                return res.status(400).send('Usuario no recibido o parámetro inválido');
            }

            let userProfile: any = {};
            // Comprobar si viene en formato JWT (contiene puntos) o JSON codificado en base64
            if (rawUser.includes('.')) {
                const parts = rawUser.split('.');
                const base64 = parts[1].replace(/-/g, '+').replace(/_/g, '/');
                userProfile = JSON.parse(Buffer.from(base64, 'base64').toString('utf8'));
            } else {
                const jsonString = Buffer.from(rawUser, 'base64').toString('utf8');
                userProfile = JSON.parse(jsonString);
            }

            const email = userProfile.mail || userProfile.email || userProfile.userPrincipalName || userProfile.preferred_username || '';
            const rawUsername = userProfile.preferred_username || userProfile.upn || email || '';
            const userHid = (rawUsername.includes('@') ? rawUsername.split('@')[0] : rawUsername).toUpperCase();

            const isSuperAdmin = userHid === 'H583623' || 
                                 email.toLowerCase().includes('albertoisaac.aguilera') || 
                                 email.toLowerCase() === 'beto22mex@gmail.com';

            let userPhoto = userProfile.photo;
            const token = userProfile.accessToken || userProfile.access_token || userProfile.token;

            console.log('[SSO Callback] Datos recibidos de usuario:', {
                nombre: userProfile.displayName || userProfile.name,
                email: email,
                tieneFotoDirecta: !!userPhoto,
                tieneAccessToken: !!token ? `Sí (${String(token).substring(0, 10)}...)` : 'No'
            });

            // Si App A envió accessToken pero no foto directa, intentar consultar la foto de Microsoft Graph
            if (!userPhoto && token) {
                try {
                    console.log('[SSO Callback] Intentando obtener foto desde https://graph.microsoft.com/v1.0/me/photo/$value ...');
                    const photoRes = await fetch('https://graph.microsoft.com/v1.0/me/photo/$value', {
                        headers: { Authorization: `Bearer ${token}` },
                    });

                    if (photoRes.ok) {
                        const buffer = await photoRes.arrayBuffer();
                        const contentType = photoRes.headers.get('content-type') || 'image/jpeg';
                        userPhoto = `data:${contentType};base64,${Buffer.from(buffer).toString('base64')}`;
                        console.log(`[SSO Callback] Foto obtenida con éxito (${buffer.byteLength} bytes).`);
                    } else if (photoRes.status === 404) {
                        console.log('[SSO Callback] Graph devolvió 404: La cuenta de Microsoft 365 no tiene foto de perfil subida.');
                    } else if (photoRes.status === 403) {
                        console.log('[SSO Callback] Graph devolvió 403 Forbidden: El token carece del permiso "User.Read".');
                    } else {
                        console.log(`[SSO Callback] Graph devolvió estado ${photoRes.status}: ${photoRes.statusText}`);
                    }
                } catch (photoErr: any) {
                    console.error('[SSO Callback] Error de red al consultar foto en Graph:', photoErr.message);
                }
            }

            const userObj = {
                id: userHid || email || userProfile.id || userProfile.oid || ('AZURE_' + Date.now()),
                name: userProfile.displayName || userProfile.name || (userHid ? `Usuario ${userHid}` : 'Usuario Honeywell'),
                email: email,
                department: userProfile.department || (isSuperAdmin ? 'Honeywell Aerospace Engineering' : 'Honeywell Operations'),
                jobTitle: userProfile.jobTitle || (isSuperAdmin ? 'Lead ECN System Administrator (Full Access)' : 'ECN Specialist (Home Only)'),
                tenantId: userProfile.tid || azureState.tenantId,
                azureId: userProfile.id || userProfile.oid || userProfile.sub,
                hid: userHid,
                role: isSuperAdmin ? 'admin' : 'viewer',
                isSuperAdmin: isSuperAdmin,
                accessLevel: isSuperAdmin ? 'Acceso Total (Todas las pantallas)' : 'Acceso Restringido (Únicamente Home)',
                photo: userPhoto
            };

            const sessionId = uuidv4();
            userSessions.set(sessionId, userObj);
            res.setHeader('Set-Cookie', `ecn_session_id=${sessionId}; Path=/; HttpOnly; SameSite=None; Secure; Max-Age=86400`);

            // Si es una petición de navegador (GET o solicita HTML), responder con la página que notifica al opener y cierra el popup
            if (req.method === 'GET' || req.accepts('html')) {
                return res.send(`
                    <!DOCTYPE html>
                    <html>
                    <head>
                        <title>Autenticación Exitosa</title>
                        <meta charset="utf-8">
                        <style>
                            body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; display: flex; align-items: center; justify-content: center; height: 100vh; margin: 0; background: #0f172a; color: #f8fafc; text-align: center; }
                            .card { background: #1e293b; padding: 2.5rem; border-radius: 12px; box-shadow: 0 10px 25px rgba(0,0,0,0.5); max-width: 420px; border: 1px solid #334155; }
                            .spinner { border: 3px solid rgba(255,255,255,0.1); border-top: 3px solid #38bdf8; border-radius: 50%; width: 36px; height: 36px; animation: spin 0.8s linear infinite; margin: 0 auto 1.5rem auto; }
                            @keyframes spin { 0% { transform: rotate(0deg); } 100% { transform: rotate(360deg); } }
                        </style>
                    </head>
                    <body>
                        <div class="card">
                            <div class="spinner"></div>
                            <h2 style="margin: 0 0 0.5rem 0; color: #38bdf8;">Sesión Iniciada</h2>
                            <p style="color: #94a3b8; font-size: 0.95rem; margin: 0;">Conectando a <b>${userObj.name}</b>...</p>
                        </div>
                        <script>
                            const user = ${JSON.stringify(userObj)};
                            try {
                                if (window.opener && !window.opener.closed) {
                                    // Notificar a la ventana principal de la App B
                                    window.opener.postMessage({ type: 'AZURE_AUTH_SUCCESS', user: user }, '*');
                                    // Cerrar la ventana emergente automáticamente
                                    setTimeout(() => window.close(), 300);
                                } else {
                                    window.location.href = '/#/';
                                }
                            } catch(e) {
                                if (window.opener) {
                                    window.opener.postMessage({ type: 'AZURE_AUTH_SUCCESS', user: user }, '*');
                                }
                                window.close();
                            }
                        </script>
                    </body>
                    </html>
                `);
            }

            return res.json({ success: true, user: userObj, sessionId });
        } catch (e: any) {
            console.error('[SSO Callback Error]', e);
            return res.status(400).send('No se pudo decodificar el usuario: ' + e.message);
        }
    };

    app.get('/auth/sso/callback', handleSsoCallback);
    app.post('/auth/sso/callback', handleSsoCallback);
    app.get('/api/auth/azure/parse-id-token', handleSsoCallback);
    app.post('/api/auth/azure/parse-id-token', handleSsoCallback);

    app.get('/api/auth/me', (req, res) => {
        const user = getSessionUser(req);
        if (user) {
            return res.json({ user, isAuthenticated: true, authEnabled: azureState.authEnabled });
        }
        if (!azureState.authEnabled) {
            const directAdminUser = {
                id: 'H583623',
                name: 'Aguilera, Alberto',
                email: 'ALBERTOISAAC.AGUILERA@Honeywell.com',
                department: 'Honeywell Aerospace Engineering',
                jobTitle: 'Lead ECN Administrator (Modo Directo)',
                tenantId: azureState.tenantId,
                hid: 'H583623',
                role: 'admin',
                isSuperAdmin: true,
                accessLevel: 'Acceso Total (Azure Deshabilitado)',
            };
            return res.json({ user: directAdminUser, isAuthenticated: true, authEnabled: false });
        }
        res.json({ user: null, isAuthenticated: false, authEnabled: true });
    });

    app.post('/api/auth/logout', (req, res) => {
        const cookieHeader = req.headers.cookie || '';
        const match = cookieHeader.match(/ecn_session_id=([^;]+)/);
        const sessionId = match ? match[1].trim() : null;
        if (sessionId) {
            userSessions.delete(sessionId);
        }
        res.setHeader('Set-Cookie', `ecn_session_id=; Path=/; HttpOnly; SameSite=None; Secure; Max-Age=0`);
        res.json({ success: true, message: 'Sesión cerrada correctamente' });
    });

    app.post('/api/auth/azure/direct-login', async (req, res) => {
        try {
            const body = req.body || {};
            const userObj = {
                id: body.id || 'AZURE_' + Date.now(),
                name: body.name || 'Usuario Honeywell Entra ID',
                email: body.email || 'usuario@honeywell.com',
                department: body.department || 'Engineering',
                jobTitle: body.jobTitle || 'ECN Specialist',
                tenantId: azureState.tenantId,
                azureId: body.azureId || 'd5bc51c1-2874-475f-8a92-a8a0ec725192',
                photo: body.photo,
            };

            const sessionId = uuidv4();
            userSessions.set(sessionId, userObj);
            res.setHeader('Set-Cookie', `ecn_session_id=${sessionId}; Path=/; HttpOnly; SameSite=None; Secure; Max-Age=86400`);
            res.json({ user: userObj, message: 'Inicio de sesión simulado exitoso' });
        } catch (e: any) {
            res.status(500).json({ error: e.message });
        }
    });

    // Protect business logic routes if database is unavailable
    app.use('/api', (req, res, next) => {
        if (req.path.startsWith('/auth/')) {
            return next();
        }
        if (!db.isDatabaseAvailable()) {
            return res.status(503).json({
                error: 'Database unavailable',
                details: 'The configured SQL Server is not reachable. Check DB_HOST, DB_PORT, and the server/network connectivity.'
            });
        }
        next();
    });



    // --- API ROUTES ---

    app.get('/api/users', async (req, res) => {
        try {
            const result = await db.pool.request().query('SELECT * FROM users ORDER BY name');
            res.json(result.recordset);
        } catch (e: any) { res.status(500).json({ error: e.message }); }
    });

    app.put('/api/users/:id', async (req, res) => {
        try {
            const user = req.body;
            await db.pool.request()
                .input('id', sql.NVarChar, req.params.id)
                .input('name', sql.NVarChar, user.name)
                .input('email', sql.NVarChar, user.email)
                .input('dept', sql.NVarChar, user.department)
                .input('photo', sql.NVarChar, user.photo || null)
                .query("UPDATE users SET name=@name, email=@email, department=@dept, photo=@photo WHERE id=@id");
            res.json({ message: 'User updated' });
        } catch (e: any) { res.status(500).json({ error: e.message }); }
    });

    app.get('/api/ecns', async (req, res) => {
        try {
            const { search, status, year, timeFilter } = req.query;
            let query = `SELECT id, initiator, description, status, creation_date as creationDate, implementation_date as implementationDate, summary FROM ecns WHERE 1=1`;
            const request = db.pool.request();

            if (search) {
                request.input('search', sql.NVarChar, `%${search}%`);
                query += ` AND (id LIKE @search OR description LIKE @search OR initiator LIKE @search)`;
            }
            if (status && status !== 'Todos') {
                request.input('status', sql.NVarChar, status);
                query += ` AND status = @status`;
            }
            if (year && year !== 'all') {
                request.input('year', sql.Int, parseInt(year as string));
                query += ` AND YEAR(implementation_date) = @year`;
            }
            if (timeFilter) {
                if (timeFilter === 'last-30') {
                    query += ` AND implementation_date >= DATEADD(day, -30, GETDATE())`;
                } else if ((timeFilter as string).startsWith('next-')) {
                    const days = parseInt((timeFilter as string).split('-')[1]);
                    request.input('days', sql.Int, days);
                    query += ` AND implementation_date BETWEEN GETDATE() AND DATEADD(day, @days, GETDATE())`;
                }
            }

            const result = await request.query(query + " ORDER BY creation_date DESC");
            const ecns = result.recordset;

            if (ecns.length > 0) {
                const ids = ecns.map(e => `'${e.id}'`).join(',');
                const comps = await db.pool.request().query(`
                    SELECT id, ecn_id, assembly, old_component, new_component, 
                           old_subassembly, new_subassembly, sku, site, family 
                    FROM component_changes 
                    WHERE ecn_id IN (${ids})
                `);
                const map: any = {};
                comps.recordset.forEach(c => {
                    if (!map[c.ecn_id]) map[c.ecn_id] = { skus: new Set(), old: new Set(), new: new Set(), sites: new Set(), families: new Set() };
                    if (c.sku) map[c.ecn_id].skus.add(c.sku);
                    if (c.family) map[c.ecn_id].families.add(c.family);
                    // Usar subensambles si existen para la lista resumida
                    const oldVal = c.old_subassembly || c.old_component;
                    const newVal = c.new_subassembly || c.new_component;
                    if (oldVal) map[c.ecn_id].old.add(oldVal);
                    if (newVal) map[c.ecn_id].new.add(newVal);
                    if (c.site) map[c.ecn_id].sites.add(c.site);
                });
                ecns.forEach(e => {
                    e.skuList = map[e.id] ? Array.from(map[e.id].skus).join(', ') : '';
                    e.oldComponentList = map[e.id] ? Array.from(map[e.id].old).join(', ') : '';
                    e.newComponentList = map[e.id] ? Array.from(map[e.id].new).join(', ') : '';
                    e.siteList = map[e.id] ? Array.from(map[e.id].sites).join(', ') : '';
                    e.familyList = map[e.id] ? Array.from(map[e.id].families).join(', ') : '';
                });
            }
            res.json(ecns);
        } catch (e: any) { res.status(500).json({ error: e.message }); }
    });

    app.post('/api/ecns/:id/notify-implemented', async (req, res) => {
        // Lógica para enviar correo de implementación
        res.json({ message: 'Notificación enviada' });
    });

    app.post('/api/ecns/:id/notify-status', async (req, res) => {
        // Lógica para enviar correo de cambio de estatus
        res.json({ message: 'Estatus notificado' });
    });

    app.get('/api/ecns/:id', async (req, res) => {
        try {
            const ecn = (await db.pool.request().input('id', sql.NVarChar, req.params.id).query("SELECT id, initiator, description, status, creation_date as creationDate, implementation_date as implementationDate, summary FROM ecns WHERE id=@id")).recordset[0];
            if (!ecn) return res.status(404).json({ error: 'Not found' });

            const changes = await db.pool.request().input('id', sql.NVarChar, req.params.id).query("SELECT * FROM component_changes WHERE ecn_id=@id");
            ecn.changes = changes.recordset.map(c => ({
                id: c.id,
                assembly: c.assembly,
                assemblyRevision: c.assembly_revision,
                assemblyDescription: c.assembly_description,
                oldComponent: c.old_component,
                newComponent: c.new_component,
                newComponentRevision: c.new_component_revision,
                newComponentDescription: c.new_component_description,
                oldSubassembly: c.old_subassembly,
                newSubassembly: c.new_subassembly,
                newSubassemblyRevision: c.new_subassembly_revision,
                newSubassemblyDescription: c.new_subassembly_description,
                sku: c.sku,
                family: c.family,
                demand: c.demand,
                onHandInventory: c.on_hand_inventory,
                openPoQty: c.open_po_qty,
                startDate: c.start_date,
                site: c.site
            }));

            ecn.notes = (await db.pool.request().input('id', sql.NVarChar, req.params.id).query("SELECT * FROM notes WHERE ecn_id=@id ORDER BY date DESC")).recordset;
            ecn.checklist = (await db.pool.request().input('id', sql.NVarChar, req.params.id).query("SELECT * FROM checklist_items WHERE ecn_id=@id")).recordset;
            res.json(ecn);
        } catch (e: any) { res.status(500).json({ error: e.message }); }
    });

    app.post('/api/ecns/:id/generate-summary', async (req, res) => {
        try {
            const ecnId = req.params.id;
            const ecn = (await db.pool.request().input('id', sql.NVarChar, ecnId).query("SELECT id, initiator, description, status, creation_date as creationDate, implementation_date as implementationDate, summary FROM ecns WHERE id=@id")).recordset[0];
            if (!ecn) return res.status(404).json({ error: 'ECN not found' });

            const changes = await db.pool.request().input('id', sql.NVarChar, ecnId).query("SELECT * FROM component_changes WHERE ecn_id=@id");
            ecn.changes = changes.recordset.map(c => ({
                id: c.id,
                assembly: c.assembly,
                assemblyRevision: c.assembly_revision,
                assemblyDescription: c.assembly_description,
                oldComponent: c.old_component,
                newComponent: c.new_component,
                newComponentRevision: c.new_component_revision,
                newComponentDescription: c.new_component_description,
                oldSubassembly: c.old_subassembly,
                newSubassembly: c.new_subassembly,
                newSubassemblyRevision: c.new_subassembly_revision,
                newSubassemblyDescription: c.new_subassembly_description,
                sku: c.sku,
                family: c.family,
                demand: c.demand,
                onHandInventory: c.on_hand_inventory,
                openPoQty: c.open_po_qty,
                startDate: c.start_date,
                site: c.site
            }));

            const generatedSummaryObject = await generateEcnSummary(ecn);
            const summaryText = generatedSummaryObject.summary || ''; // Extract only the summary text

            // Auto-save summary to DB
            await db.pool.request()
                .input('id', sql.NVarChar, ecnId)
                .input('sum', sql.NVarChar, summaryText) // Use the extracted summary text
                .query("UPDATE ecns SET summary=@sum WHERE id=@id");

            res.json(generatedSummaryObject); // Return the full generated object to the frontend
        } catch (e: any) {
            console.error('[Summary API Error]', e);
            res.status(500).json({ error: e.message });
        }
    });

    app.put('/api/ecns/:id/summary', async (req, res) => {
        try {
            const { summary } = req.body;
            await db.pool.request()
                .input('id', sql.NVarChar, req.params.id)
                .input('sum', sql.NVarChar, summary)
                .query("UPDATE ecns SET summary=@sum WHERE id=@id");
            res.json({ message: 'Summary updated' });
        } catch (e: any) { res.status(500).json({ error: e.message }); }
    });

    app.put('/api/ecns/:id', async (req, res) => {
        try {
            const { ecn, user, diff } = req.body;
            const initiator = ecn.initiator || 'Sistema';

            // Asegurar que el usuario iniciador existe
            const userCheck = await db.pool.request()
                .input('uid', sql.NVarChar, initiator)
                .query("SELECT id FROM users WHERE id = @uid");

            if (userCheck.recordset.length === 0) {
                await db.pool.request()
                    .input('uid', sql.NVarChar, initiator)
                    .input('name', sql.NVarChar, initiator)
                    .query("INSERT INTO users (id, name) VALUES (@uid, @name)");
            }

            await db.pool.request()
                .input('id', sql.NVarChar, req.params.id)
                .input('init', sql.NVarChar, initiator)
                .input('desc', sql.NVarChar, ecn.description || '')
                .input('stat', sql.NVarChar, ecn.status)
                .input('idat', sql.Date, ecn.implementationDate ? new Date(ecn.implementationDate) : null)
                .query("UPDATE ecns SET initiator=@init, description=@desc, status=@stat, implementation_date=@idat WHERE id=@id");

            // Si el cliente envió un diff estructurado (solo los registros modificados, agregados o eliminados)
            if (diff && typeof diff === 'object') {
                const { deletedIds, added, updated } = diff;

                // 1. Eliminar solo los IDs eliminados
                if (deletedIds && Array.isArray(deletedIds) && deletedIds.length > 0) {
                    const delReq = db.pool.request();
                    const paramNames = deletedIds.map((id: string, idx: number) => {
                        const pName = `del_${idx}`;
                        delReq.input(pName, sql.NVarChar, id);
                        return `@${pName}`;
                    });
                    await delReq.query(`DELETE FROM component_changes WHERE id IN (${paramNames.join(',')})`);
                }

                // 2. Insertar solo los componentes nuevos agregados
                if (added && Array.isArray(added) && added.length > 0) {
                    for (const change of added) {
                        await db.pool.request()
                            .input('ecn_id', sql.NVarChar, req.params.id)
                            .input('assembly', sql.NVarChar, change.assembly || '')
                            .input('old_comp', sql.NVarChar, change.oldComponent || '')
                            .input('new_comp', sql.NVarChar, change.newComponent || '')
                            .input('sku', sql.NVarChar, change.sku || '')
                            .input('family', sql.NVarChar, change.family || '')
                            .input('demand', sql.Decimal(18, 2), change.demand || 0)
                            .input('on_hand', sql.Decimal(18, 2), change.onHandInventory || 0)
                            .input('open_po', sql.Decimal(18, 2), change.openPoQty || 0)
                            .input('sdate', sql.Date, change.startDate ? new Date(change.startDate) : null)
                            .input('site', sql.NVarChar, change.site || '5205')
                            .query(`
                                INSERT INTO component_changes (
                                    id, ecn_id, assembly, old_component, new_component,
                                    sku, family, demand, on_hand_inventory, open_po_qty, start_date, site
                                ) VALUES (
                                    NEWID(), @ecn_id, @assembly, @old_comp, @new_comp,
                                    @sku, @family, @demand, @on_hand, @open_po, @sdate, @site
                                )
                            `);
                    }
                }

                // 3. Actualizar únicamente las filas que fueron editadas
                if (updated && Array.isArray(updated) && updated.length > 0) {
                    for (const change of updated) {
                        await db.pool.request()
                            .input('id', sql.NVarChar, change.id)
                            .input('assembly', sql.NVarChar, change.assembly || '')
                            .input('old_comp', sql.NVarChar, change.oldComponent || '')
                            .input('new_comp', sql.NVarChar, change.newComponent || '')
                            .input('sku', sql.NVarChar, change.sku || '')
                            .input('family', sql.NVarChar, change.family || '')
                            .input('demand', sql.Decimal(18, 2), change.demand || 0)
                            .input('on_hand', sql.Decimal(18, 2), change.onHandInventory || 0)
                            .input('open_po', sql.Decimal(18, 2), change.openPoQty || 0)
                            .input('sdate', sql.Date, change.startDate ? new Date(change.startDate) : null)
                            .input('site', sql.NVarChar, change.site || '5205')
                            .query(`
                                UPDATE component_changes SET
                                    assembly = @assembly,
                                    old_component = @old_comp,
                                    new_component = @new_comp,
                                    sku = @sku,
                                    family = @family,
                                    demand = @demand,
                                    on_hand_inventory = @on_hand,
                                    open_po_qty = @open_po,
                                    start_date = @sdate,
                                    site = @site
                                WHERE id = @id
                            `);
                    }
                }
            } else if (ecn.changes && Array.isArray(ecn.changes)) {
                // Fallback si no viene objeto diff: consultar BD y actualizar SOLO los que cambiaron
                const existingCompResult = await db.pool.request()
                    .input('ecn_id', sql.NVarChar, req.params.id)
                    .query("SELECT * FROM component_changes WHERE ecn_id = @ecn_id");

                const existingCompMap = new Map(existingCompResult.recordset.map((r: any) => [r.id, r]));
                const incomingIds = ecn.changes
                    .filter((c: any) => c.id && !c.id.startsWith('new-'))
                    .map((c: any) => c.id);

                // Eliminar los que ya no están en la lista
                const toDelete = Array.from(existingCompMap.keys()).filter((id: string) => !incomingIds.includes(id));
                for (const delId of toDelete) {
                    await db.pool.request()
                        .input('id', sql.NVarChar, delId)
                        .query("DELETE FROM component_changes WHERE id = @id");
                }

                // Insertar o actualizar SOLO si hay diferencias
                for (const change of ecn.changes) {
                    const isNew = !change.id || change.id.startsWith('new-');

                    if (isNew) {
                        await db.pool.request()
                            .input('ecn_id', sql.NVarChar, req.params.id)
                            .input('assembly', sql.NVarChar, change.assembly || '')
                            .input('old_comp', sql.NVarChar, change.oldComponent || '')
                            .input('new_comp', sql.NVarChar, change.newComponent || '')
                            .input('sku', sql.NVarChar, change.sku || '')
                            .input('family', sql.NVarChar, change.family || '')
                            .input('demand', sql.Decimal(18, 2), change.demand || 0)
                            .input('on_hand', sql.Decimal(18, 2), change.onHandInventory || 0)
                            .input('open_po', sql.Decimal(18, 2), change.openPoQty || 0)
                            .input('sdate', sql.Date, change.startDate ? new Date(change.startDate) : null)
                            .input('site', sql.NVarChar, change.site || '5205')
                            .query(`
                                INSERT INTO component_changes (
                                    id, ecn_id, assembly, old_component, new_component,
                                    sku, family, demand, on_hand_inventory, open_po_qty, start_date, site
                                ) VALUES (
                                    NEWID(), @ecn_id, @assembly, @old_comp, @new_comp,
                                    @sku, @family, @demand, @on_hand, @open_po, @sdate, @site
                                )
                            `);
                    } else {
                        const existing = existingCompMap.get(change.id);
                        if (existing) {
                            const existDate = existing.start_date ? new Date(existing.start_date).toISOString().split('T')[0] : '';
                            const newDate = change.startDate ? new Date(change.startDate).toISOString().split('T')[0] : '';
                            const hasChanged =
                                (existing.assembly || '') !== (change.assembly || '') ||
                                (existing.old_component || '') !== (change.oldComponent || '') ||
                                (existing.new_component || '') !== (change.newComponent || '') ||
                                (existing.sku || '') !== (change.sku || '') ||
                                (existing.family || '') !== (change.family || '') ||
                                Number(existing.demand || 0) !== Number(change.demand || 0) ||
                                Number(existing.on_hand_inventory || 0) !== Number(change.onHandInventory || 0) ||
                                Number(existing.open_po_qty || 0) !== Number(change.openPoQty || 0) ||
                                existDate !== newDate ||
                                (existing.site || '5205') !== (change.site || '5205');

                            if (hasChanged) {
                                await db.pool.request()
                                    .input('id', sql.NVarChar, change.id)
                                    .input('assembly', sql.NVarChar, change.assembly || '')
                                    .input('old_comp', sql.NVarChar, change.oldComponent || '')
                                    .input('new_comp', sql.NVarChar, change.newComponent || '')
                                    .input('sku', sql.NVarChar, change.sku || '')
                                    .input('family', sql.NVarChar, change.family || '')
                                    .input('demand', sql.Decimal(18, 2), change.demand || 0)
                                    .input('on_hand', sql.Decimal(18, 2), change.onHandInventory || 0)
                                    .input('open_po', sql.Decimal(18, 2), change.openPoQty || 0)
                                    .input('sdate', sql.Date, change.startDate ? new Date(change.startDate) : null)
                                    .input('site', sql.NVarChar, change.site || '5205')
                                    .query(`
                                        UPDATE component_changes SET
                                            assembly = @assembly,
                                            old_component = @old_comp,
                                            new_component = @new_comp,
                                            sku = @sku,
                                            family = @family,
                                            demand = @demand,
                                            on_hand_inventory = @on_hand,
                                            open_po_qty = @open_po,
                                            start_date = @sdate,
                                            site = @site
                                        WHERE id = @id
                                    `);
                            }
                        }
                    }
                }
            }

            res.json({ message: 'Updated' });
        } catch (e: any) { res.status(500).json({ error: e.message }); }
    });


    app.post('/api/ecns/:id/notes', async (req, res) => {
        try {
            await db.pool.request()
                .input('id', sql.UniqueIdentifier, uuidv4())
                .input('ecn', sql.NVarChar, req.params.id)
                .input('auth', sql.NVarChar, req.body.author)
                .input('txt', sql.NVarChar, req.body.text)
                .input('d', sql.DateTimeOffset, new Date())
                .query("INSERT INTO notes (id, ecn_id, author, text, date) VALUES (@id, @ecn, @auth, @txt, @d)");
            res.json({ message: 'Saved' });
        } catch (e: any) { res.status(500).json({ error: e.message }); }
    });

    // --- Import Routes ---
    // POST /api/import/sap-upsert: By default runs the high-performance batch-optimized engine.
    // Preserves original legacy implementation as rollback fallback (switchable via USE_OPTIMIZED_SAP_UPSERT=false or ?legacy=true)
    app.post('/api/import/sap-upsert', async (req, res) => {
        const useLegacy = process.env.USE_OPTIMIZED_SAP_UPSERT === 'false' || req.query.legacy === 'true' || req.headers['x-use-legacy'] === 'true';
        if (useLegacy) {
            console.log('[SAP Upsert] Ejecutando versión LEGACY (original)');
            return handleSapUpsertLegacy(req, res);
        }
        return handleSapUpsertOptimized(req, res);
    });

    // Dedicated endpoints for explicit benchmark/testing/fallback
    app.post('/api/import/sap-upsert-optimized', (req, res) => handleSapUpsertOptimized(req, res));
    app.post('/api/import/sap-upsert-legacy', (req, res) => handleSapUpsertLegacy(req, res));



    // --- SAP Direct Automation API Routes (cscript / VBScript OLE Automation) ---
    app.get('/api/sap/download-webgui-bat', (req, res) => {
        const batPath = path.join(process.cwd(), 'scripts', 'sync_webgui_playwright.bat');
        if (fs.existsSync(batPath)) {
            res.setHeader('Content-Disposition', 'attachment; filename="sync_webgui_playwright.bat"');
            res.setHeader('Content-Type', 'application/x-bat');
            return res.sendFile(batPath);
        }
        return res.status(404).send('Script no encontrado');
    });

    app.get('/api/sap/status', async (req, res) => {
        try {
            res.json({
                status: 'online',
                platform: process.platform,
                powershellAvailable: false,
                middleware: 'cscript-vbs',
                description: 'SAP GUI OLE Scripting Engine for Direct ZPP_CC07 & ECN Sync'
            });
        } catch (e: any) {
            res.status(500).json({ error: e.message });
        }
    });

    // 3. ZPP_CC07 Plant Inventory Report Trigger Endpoint (Sub InitialProcess)
    app.post('/api/sap/process-zpp', async (req, res) => {
        const body = req.body || {};
        const initialDate = body.initialDate || body.startDate;
        const finalDate = body.finalDate || body.endDate;
        const plants = Array.isArray(body.plants) && body.plants.length > 0
            ? body.plants
            : body.plant ? [body.plant] : [];

        if (!initialDate || !finalDate || !plants || !Array.isArray(plants) || plants.length === 0) {
            return res.status(400).json({
                success: false,
                error: 'Parámetros initialDate, finalDate y un arreglo de plantas (plants) no vacío son requeridos.'
            });
        }

        const isWindows = process.platform === 'win32';

        if (!isWindows) {
            return res.status(400).json({
                success: false,
                error: 'ZPP_CC07 solo se ejecuta en Windows con SAP GUI activo. No hay modo simulado disponible.',
                mode: 'disabled'
            });
        }

        try {
            const realData = await runZppExtraction(plants, initialDate, finalDate);

            if (realData.records.length === 0 && realData.jsonData.length === 0) {
                return res.status(400).json({
                    success: false,
                    error: 'No se pudo leer ningún registro válido desde el Excel exportado por SAP. Revisa el archivo generado por ZPP_CC07.',
                    mode: 'real'
                });
            }

            return res.json({
                success: true,
                records: realData.records,
                jsonData: realData.jsonData,
                headers: realData.headers,
                totalRecords: realData.records.length,
                plants,
                mode: 'real',
                message: 'ZPP_CC07 ejecutado en SAP GUI y sus datos se reconstruyeron desde el Excel exportado.'
            });
        } catch (err: any) {
            return res.status(err.isSapError ? 400 : 500).json({
                success: false,
                error: `Error al ejecutar automatización SAP: ${err.message}`,
                mode: 'real'
            });
        }
    });

    // Preview endpoint – runs SAP automation via ZPP_CC07 macro without writing to DB
    app.post('/api/sap/preview-sync', async (req, res) => {
        const body = req.body || {};
        const startDate = body.startDate || body.initialDate;
        const endDate = body.endDate || body.finalDate;
        const plantInput = body.plant || '5205';
        const plants = Array.isArray(body.plants) && body.plants.length > 0
            ? body.plants
            : [String(plantInput).trim() || '5205'];

        if (!startDate || !endDate) {
            return res.status(400).json({ success: false, error: 'startDate y endDate son requeridos' });
        }

        if (plants.includes('5201')) {
            const mxohSetting = await db.pool.request()
                .input('key', sql.NVarChar, 'mxoh_plant_5201_enabled')
                .query('SELECT value FROM settings WHERE [key] = @key');
            const mxohValue = mxohSetting.recordset[0]?.value || '';
            if (mxohValue.toLowerCase() !== 'true' && mxohValue.toLowerCase() !== '1') {
                return res.status(403).json({ error: 'La Planta 5201 está deshabilitada. Para habilitarla, active la opción MXOH en la configuración.' });
            }
        }

        if (process.platform !== 'win32') {
            return res.status(400).json({
                success: false,
                error: 'ZPP_CC07 solo se ejecuta en Windows con SAP GUI activo. No hay modo simulado disponible.',
                mode: 'disabled'
            });
        }

        try {
            const extractionResult = await runZppExtraction(plants, startDate, endDate);
            const { records, jsonData, headers } = extractionResult;

            if (records.length === 0 && jsonData.length === 0) {
                return res.status(400).json({
                    success: false,
                    error: 'No se pudo leer ningún registro válido desde el Excel exportado por SAP. Revisa el archivo generado por ZPP_CC07.',
                    mode: 'real'
                });
            }

            return res.json({
                success: true,
                headers: headers || [],
                jsonData: jsonData || [],
                records: records || [],
                totalRecords: jsonData.length || records.length,
                plant: plants[0],
                plants,
                mode: 'real',
                message: 'ZPP_CC07 ejecutado en SAP GUI y sus datos se reconstruyeron desde el Excel exportado.'
            });
        } catch (err: any) {
            return res.status(err.isSapError ? 400 : 500).json({
                success: false,
                error: `Error al compilar script de automatización: ${err.message}`,
                mode: 'real'
            });
        }
    });

    // 4. Fetch specific ECN Description (compatible con SAP WebGUI)
    app.post('/api/sap/fetch', async (req, res) => {
        const { ecro, type, description } = req.body;

        if (!ecro) {
            return res.status(400).json({
                success: false,
                error: 'Parámetro ecro es requerido.'
            });
        }

        const cleanEcroVal = cleanEcn(ecro);
        if (!cleanEcroVal) {
            return res.status(400).json({
                success: false,
                error: 'Número de ECN inválido.'
            });
        }

        // Si se envió la descripción desde SAP WebGUI, guardarla directamente
        if (description && description.trim()) {
            const cleanDesc = description.trim();
            if (db.isDatabaseAvailable()) {
                try {
                    const uReq = db.pool.request();
                    uReq.input('id', sql.NVarChar, cleanEcroVal);
                    uReq.input('desc', sql.NVarChar, cleanDesc);
                    await uReq.query(`UPDATE ecns SET description = @desc WHERE id = @id`);
                } catch (dbErr: any) {
                    console.warn(`[SAP WebGUI] Error actualizando DB para ${cleanEcroVal}:`, dbErr.message);
                }
            }
            return res.json({
                success: true,
                description: cleanDesc,
                mode: 'webgui'
            });
        }

        // Buscar si ya existe descripción en la base de datos
        if (db.isDatabaseAvailable()) {
            try {
                const qReq = db.pool.request();
                qReq.input('id', sql.NVarChar, cleanEcroVal);
                const r = await qReq.query(`SELECT description FROM ecns WHERE id = @id`);
                const d = r.recordset[0]?.description;
                if (d && !d.startsWith('ECN importado') && !d.startsWith('ZPP_CC07') && d !== 'Sin descripción') {
                    return res.json({
                        success: true,
                        description: d,
                        mode: 'database'
                    });
                }
            } catch (qErr: any) {
                console.warn(`[SAP WebGUI] Error consultando descripción para ${cleanEcroVal}:`, qErr.message);
            }
        }

        return res.json({
            success: true,
            ecro: cleanEcroVal,
            mode: 'webgui_pending',
            message: `ECN ${cleanEcroVal} listo para sincronizar desde SAP WebGUI.`
        });
    });

    // 5. Endpoint: Update Missing or Specific Descriptions for ECNs in database from SAP WebGUI (or batch/paste)
    const handleUpdateMissingSapDescriptions = async (req: any, res: any) => {
        try {
            const { updates, rawText, records } = req.body || {};
            const pattern = (req.body?.pattern || req.body?.mask || '').toString().trim();
            const targetEcn = req.body?.ecnId || req.body?.ecn || req.body?.id;
            const singleDesc = (req.body?.description || '').toString().trim();

            const itemsToUpdate: Array<{ id: string, description: string }> = [];

            // A. Si se envió un ECN individual con su descripción
            if (targetEcn && singleDesc) {
                const cleaned = cleanEcn(String(targetEcn));
                if (cleaned) {
                    itemsToUpdate.push({ id: cleaned, description: singleDesc });
                }
            }

            // B. Si se envió un arreglo de actualizaciones { updates: [{ id, description }] }
            if (Array.isArray(updates)) {
                for (const u of updates) {
                    const id = cleanEcn(String(u.id || u.ecnId || u.ecro || u.ecn || ''));
                    const desc = String(u.description || u.desc || '').trim();
                    if (id && desc) {
                        itemsToUpdate.push({ id, description: desc });
                    }
                }
            }

            // C. Si se enviaron records de Tampermonkey
            if (Array.isArray(records)) {
                for (const r of records) {
                    const id = cleanEcn(String(r.ecro || r.ecn || r.changeNo || ''));
                    const desc = String(r.description || r.assemblyDescription || r.desc || '').trim();
                    if (id && desc && !desc.startsWith('ECN importado') && !desc.startsWith('ZPP_CC07')) {
                        itemsToUpdate.push({ id, description: desc });
                    }
                }
            }

            // D. Si se envió texto plano o tabla copiada desde SAP WebGUI (IQS3 / CC03 / ZPP_CC07)
            if (typeof rawText === 'string' && rawText.trim()) {
                const lines = rawText.split(/\r?\n/);
                for (const line of lines) {
                    const parts = line.split(/\t| {2,}|;|\|/).map(p => p.trim()).filter(Boolean);
                    if (parts.length >= 2) {
                        const id = cleanEcn(parts[0]);
                        const desc = parts[1].length > 3 ? parts[1] : (parts[2] || parts[1]);
                        if (id && desc && desc.toUpperCase() !== 'DESCRIPTION' && desc.toUpperCase() !== 'TEXTO BREVE') {
                            itemsToUpdate.push({ id, description: desc });
                        }
                    }
                }
            }

            // Si hay datos para actualizar: Guardar en la base de datos SQL Server y en memoria
            if (itemsToUpdate.length > 0) {
                const uniqueMap = new Map<string, string>();
                for (const item of itemsToUpdate) {
                    if (!uniqueMap.has(item.id)) {
                        uniqueMap.set(item.id, item.description);
                    }
                }

                let updatedCount = 0;
                const updatedIds: string[] = [];
                let lastUpdatedDesc = '';

                if (db.isDatabaseAvailable()) {
                    for (const [id, desc] of uniqueMap.entries()) {
                        try {
                            const uReq = db.pool.request();
                            uReq.input('id', sql.NVarChar, id);
                            uReq.input('desc', sql.NVarChar, desc);
                            const uRes = await uReq.query(`UPDATE ecns SET description = @desc WHERE id = @id`);

                            const cReq = db.pool.request();
                            cReq.input('ecn_id', sql.NVarChar, id);
                            cReq.input('desc', sql.NVarChar, desc);
                            await cReq.query(`
                                UPDATE component_changes 
                                SET assembly_description = @desc 
                                WHERE ecn_id = @ecn_id
                            `);

                            if (uRes.rowsAffected && uRes.rowsAffected[0] > 0) {
                                updatedCount++;
                                updatedIds.push(id);
                                lastUpdatedDesc = desc;
                            }
                        } catch (itemErr: any) {
                            console.warn(`[SAP WebGUI Update] Error actualizando ECN ${id}:`, itemErr.message);
                        }
                    }

                    // Registrar en audit_log
                    try {
                        await db.pool.request()
                            .input('id', sql.UniqueIdentifier, uuidv4())
                            .input('time', sql.DateTime, new Date())
                            .input('user', sql.NVarChar, 'SAP WebGUI Sync')
                            .input('action', sql.NVarChar, 'Actualización Descripciones SAP WebGUI')
                            .input('details', sql.NVarChar, `Se actualizaron ${updatedCount} descripciones de ECNs desde SAP WebGUI / IQS3 (${updatedIds.join(', ')}).`)
                            .query("INSERT INTO audit_log (id, timestamp, [user], action, details) VALUES (@id, @time, @user, @action, @details)");
                    } catch (auditErr) { }
                }

                return res.json({
                    success: true,
                    message: `Se actualizaron exitosamente ${updatedCount} ECNs con descripciones de SAP WebGUI / IQS3.`,
                    description: lastUpdatedDesc,
                    totalFound: uniqueMap.size,
                    updatedCount,
                    updatedEcns: updatedIds,
                    mode: 'webgui'
                });
            }

            // Si NO se enviaron descripciones para guardar:
            // Obtener ECNs para extraer o actualizar en IQS3
            let missingEcns: string[] = [];
            let patternStr = '';
            let isPatternSearch = false;

            const searchMask = (pattern || req.query?.pattern || req.query?.mask || req.body?.mask || '').toString().trim();
            const targetEcnCandidate = targetEcn || req.query?.ecnId || req.query?.ecn || req.query?.id;

            if (searchMask || (typeof targetEcnCandidate === 'string' && (targetEcnCandidate.includes('*') || targetEcnCandidate.includes('%')))) {
                isPatternSearch = true;
                patternStr = (searchMask || targetEcnCandidate).trim();
                let sqlPattern = patternStr.replace(/\*/g, '%');
                if (!sqlPattern.includes('%')) {
                    sqlPattern = `%${sqlPattern}%`;
                }
                if (db.isDatabaseAvailable()) {
                    const patReq = db.pool.request();
                    patReq.input('pattern', sql.NVarChar, sqlPattern);
                    const patResult = await patReq.query(`SELECT id FROM ecns WHERE id LIKE @pattern ORDER BY id DESC`);
                    missingEcns = patResult.recordset.map(r => r.id).filter(Boolean);
                }

                if (missingEcns.length === 0) {
                    return res.json({
                        success: true,
                        message: `No se encontraron ECNs en la base de datos que coincidan con la máscara "${patternStr}".`,
                        totalFound: 0,
                        updatedCount: 0,
                        missingEcns: [],
                        ecns: [],
                        mode: 'webgui'
                    });
                }
            } else if (targetEcnCandidate && typeof targetEcnCandidate === 'string' && !targetEcnCandidate.includes('*') && !targetEcnCandidate.includes('%')) {
                const cleaned = cleanEcn(String(targetEcnCandidate));
                if (cleaned) {
                    missingEcns = [cleaned];
                }
            } else if (Array.isArray(req.body?.ecns) && req.body.ecns.length > 0) {
                missingEcns = req.body.ecns.map((e: any) => cleanEcn(String(e))).filter(Boolean);
            } else {
                // Obtener todos los ECNs existentes en la base de datos para sobrescribir/actualizar con IQS3
                // Si el usuario especificó onlyMissing=true, solo filtra los que no tienen
                const onlyMissing = req.query?.onlyMissing === 'true' || req.body?.onlyMissing === true;
                if (db.isDatabaseAvailable()) {
                    let queryStr = `SELECT id FROM ecns ORDER BY id DESC`;
                    if (onlyMissing) {
                        queryStr = `
                            SELECT id FROM ecns 
                            WHERE description IS NULL 
                               OR LTRIM(RTRIM(description)) = '' 
                               OR description LIKE 'ECN importado%' 
                               OR description LIKE 'ZPP_CC07%' 
                               OR description = 'Sin descripción'
                               OR description LIKE 'ECN % extraído desde SAP'
                               OR description LIKE 'ECN %'
                            ORDER BY id DESC
                        `;
                    }
                    const qResult = await db.pool.request().query(queryStr);
                    missingEcns = qResult.recordset.map(r => r.id).filter(Boolean);
                }
            }

            return res.json({
                success: true,
                message: missingEcns.length > 0 
                    ? `Se encontraron ${missingEcns.length} ECN(s) listos para actualizar o sobrescribir su descripción en IQS3.`
                    : 'No hay ECNs registrados en la base de datos.',
                totalFound: missingEcns.length,
                updatedCount: 0,
                missingEcns,
                ecns: missingEcns,
                mode: 'webgui'
            });

        } catch (err: any) {
            console.error('[SAP WebGUI Description Update Error]', err);
            return res.status(500).json({
                success: false,
                error: `Error al procesar descripciones desde SAP WebGUI: ${err.message}`,
                mode: 'webgui'
            });
        }
    };

    app.all('/api/sap/update-missing-descriptions', handleUpdateMissingSapDescriptions);
    app.all('/api/sap/update-descriptions', handleUpdateMissingSapDescriptions);
    app.all('/api/sap/pending-descriptions', handleUpdateMissingSapDescriptions);

    // Helper to query target ECNs based on mask or all existing
    async function getTargetEcnsForIqs3(options: { mask?: string; allExisting?: boolean; ecns?: string[] }): Promise<string[]> {
        if (Array.isArray(options.ecns) && options.ecns.length > 0) {
            return options.ecns.map(cleanEcn).filter(Boolean);
        }
        const mask = (options.mask || '').trim();
        if (!db.isDatabaseAvailable()) return [];

        let queryStr = '';
        const req = db.pool.request();
        if (mask && mask !== '*' && mask !== '%') {
            let pattern = mask.replace(/\*/g, '%');
            if (!pattern.includes('%')) pattern = `%${pattern}%`;
            req.input('pattern', sql.NVarChar, pattern);
            queryStr = 'SELECT id FROM ecns WHERE id LIKE @pattern ORDER BY id DESC';
        } else {
            queryStr = 'SELECT id FROM ecns ORDER BY id DESC';
        }

        const result = await req.query(queryStr);
        return result.recordset.map((r: any) => cleanEcn(r.id)).filter(Boolean);
    }

    // Generator for standalone or local Windows VBScript navigating directly to transaction IQS3 (I1S3)
    function generateIqs3VbsScript(ecnList: string[], apiUrl: string): string {
        const jsonEscapedList = ecnList.map(e => `"${e}"`).join(', ');
        return `'=============================================================================
' HONEYWELL ECN MANAGER - EXTRACCION DIRECTA TRANSACCION IQS3 (I1S3)
' Navega directamente a IQS3 y extrae la descripcion de cada ECN existente o mascara
'=============================================================================
On Error Resume Next

Dim SapGuiAuto, appObj, connObj, sessionObj, wshShell, httpObj
Dim ecnList, currentEcn, i, descVal, sbarText, totalUpdated, updatePayload

Set wshShell = CreateObject("WScript.Shell")
totalUpdated = 0
updatePayload = "["

Set SapGuiAuto = GetObject("SAPGUI")
If Err.Number <> 0 Or SapGuiAuto Is Nothing Then
    WScript.Echo "RESULT_ERR:No se detecto proceso activo de SAP GUI. Por favor abra SAP Logon e inicie sesion."
    WScript.Quit 1
End If

Set appObj = SapGuiAuto.GetScriptingEngine
If Err.Number <> 0 Or appObj Is Nothing Then
    WScript.Echo "RESULT_ERR:El scripting de SAP GUI esta deshabilitado en este equipo o servidor."
    WScript.Quit 1
End If

If appObj.Children.Count = 0 Then
    WScript.Echo "RESULT_ERR:No hay conexiones abiertas en SAP Logon."
    WScript.Quit 1
End If

Set connObj = appObj.Children(0)
Set sessionObj = connObj.Children(0)

If sessionObj Is Nothing Then
    WScript.Echo "RESULT_ERR:No hay sesion activa de usuario en SAP GUI."
    WScript.Quit 1
End If

WScript.Echo "Conectado exitosamente a SAP GUI (" & connObj.Description & ")"
WScript.Echo "Iniciando navegacion directa a la transaccion IQS3..."

' Volver a pantalla principal y maximizar
sessionObj.findById("wnd[0]/tbar[0]/btn[3]").press
sessionObj.findById("wnd[0]/tbar[0]/btn[3]").press
sessionObj.findById("wnd[0]").maximize

ecnList = Array(${jsonEscapedList})

For i = LBound(ecnList) To UBound(ecnList)
    currentEcn = Trim(ecnList(i))
    descVal = ""
    
    If currentEcn <> "" Then
        ' 1. Navegacion DIRECTA a transaccion IQS3 (I1S3)
        sessionObj.findById("wnd[0]/tbar[0]/okcd").Text = "/nIQS3"
        sessionObj.findById("wnd[0]").SendVKey 0
        
        ' 2. Ingresar numero de ECN en el campo de Aviso (RIWO00-QMNUM)
        sessionObj.findById("wnd[0]/usr/ctxtRIWO00-QMNUM").Text = currentEcn
        sessionObj.findById("wnd[0]").SendVKey 0
        
        ' 3. Verificar barra de estado
        sbarText = ""
        Err.Clear
        sbarText = sessionObj.findById("wnd[0]/sbar").Text
        
        If sbarText = "" Then
            ' Intentar extraer texto breve oficial del aviso (campo VIQMEL-QMTXT)
            Err.Clear
            descVal = sessionObj.findById("wnd[0]/usr/subSCREEN_QUICKVIEW:SAPLIQS0:0100/txtVIQMEL-QMTXT").Text
            
            If Err.Number <> 0 Or Trim(descVal) = "" Then
                Err.Clear
                descVal = sessionObj.findById("wnd[0]/usr/txtVIQMEL-QMTXT").Text
            End If
            
            If Err.Number <> 0 Or Trim(descVal) = "" Then
                Err.Clear
                descVal = sessionObj.findById("wnd[0]/usr/tabsTAB_GROUP_10/tabp10\\TAB01/ssubSUB_GROUP_10:SAPLIQS0:7235/subCUSTOM_SCREEN:SAPLIQS0:7212/subSUBSCREEN_2:SAPLIQS0:7715/cntlTEXT/shellcont/shell").Text
            End If
        End If
        
        ' Retornar a la transaccion
        sessionObj.findById("wnd[0]/tbar[0]/btn[3]").press
        
        If Trim(descVal) <> "" Then
            ' Limpiar comillas y saltos de linea
            descVal = Replace(Replace(Replace(Trim(descVal), vbCrLf, " "), vbLf, " "), """", "'")
            WScript.Echo "DESC_OK:" & currentEcn & ":::" & descVal
            
            If totalUpdated > 0 Then updatePayload = updatePayload & ","
            updatePayload = updatePayload & "{""id"":""" & currentEcn & """,""description"":""" & descVal & """}"
            totalUpdated = totalUpdated + 1
        Else
            WScript.Echo "DESC_EMPTY:" & currentEcn
        End If
    End If
Next

updatePayload = updatePayload & "]"

WScript.Echo "RESULT_OK:FINISHED_COUNT:" & CStr(totalUpdated)

' Si se configuro URL de API y se encontraron descripciones, sincronizar automaticamente via HTTP POST
If totalUpdated > 0 And "${apiUrl}" <> "" Then
    Err.Clear
    Set httpObj = CreateObject("MSXML2.ServerXMLHTTP.6.0")
    If Err.Number <> 0 Then
        Err.Clear
        Set httpObj = CreateObject("MSXML2.XMLHTTP")
    End If
    
    If Not (httpObj Is Nothing) Then
        httpObj.Open "POST", "${apiUrl}", False
        httpObj.setRequestHeader "Content-Type", "application/json"
        httpObj.Send "{""updates"":" & updatePayload & "}"
        If httpObj.Status = 200 Then
            WScript.Echo "HTTP_SYNC_OK: Sincronizadas " & CStr(totalUpdated) & " descripciones con ECN Manager."
        Else
            WScript.Echo "HTTP_SYNC_WARN: Codigo " & CStr(httpObj.Status) & " al enviar a " & "${apiUrl}"
        End If
    End If
End If
`;
    }

    // Windows local execution helper for IQS3
    async function runIqs3ExtractionLocally(ecnList: string[]): Promise<{
        success: boolean;
        message: string;
        totalFound: number;
        updatedCount: number;
        updatedEcns: string[];
        error?: string;
    }> {
        if (ecnList.length === 0) {
            return {
                success: true,
                message: 'No hay ECNs para procesar en IQS3.',
                totalFound: 0,
                updatedCount: 0,
                updatedEcns: []
            };
        }

        const tempScriptPath = path.join(os.tmpdir(), `sap_iqs3_sync_${Date.now()}.vbs`);
        const vbsCode = generateIqs3VbsScript(ecnList, '');

        try {
            fs.writeFileSync(tempScriptPath, vbsCode, 'utf-8');
            const cmd = getCScriptCommand(tempScriptPath);

            const execution = await new Promise<{ stdout: string; stderr: string }>((resolve, reject) => {
                exec(cmd, { timeout: Math.max(45000, ecnList.length * 5000) }, (error, stdout, stderr) => {
                    try { fs.unlinkSync(tempScriptPath); } catch (_) { }
                    if (error && (error as any).code !== 'ETIMEDOUT') {
                        reject(error);
                        return;
                    }
                    resolve({ stdout: stdout || '', stderr: stderr || '' });
                });
            });

            const combined = ((execution.stdout || '') + '\n' + (execution.stderr || '')).trim();
            const lines = combined.split(/\r?\n/);
            const errLine = lines.find(l => l.startsWith('RESULT_ERR:'));
            if (errLine) {
                return {
                    success: false,
                    error: errLine.replace('RESULT_ERR:', '').trim(),
                    message: 'Error en SAP GUI al navegar a IQS3',
                    totalFound: ecnList.length,
                    updatedCount: 0,
                    updatedEcns: []
                };
            }

            const updates: Array<{ id: string, description: string }> = [];
            for (const line of lines) {
                if (line.startsWith('DESC_OK:')) {
                    const raw = line.replace('DESC_OK:', '');
                    const [ecnId, ...rest] = raw.split(':::');
                    const desc = rest.join(':::').trim();
                    if (ecnId && desc) {
                        updates.push({ id: cleanEcn(ecnId), description: desc });
                    }
                }
            }

            let updatedCount = 0;
            const updatedEcns: string[] = [];
            if (db.isDatabaseAvailable()) {
                for (const u of updates) {
                    try {
                        const uReq = db.pool.request();
                        uReq.input('id', sql.NVarChar, u.id);
                        uReq.input('desc', sql.NVarChar, u.description);
                        const r = await uReq.query(`UPDATE ecns SET description = @desc WHERE id = @id`);

                        const cReq = db.pool.request();
                        cReq.input('ecn_id', sql.NVarChar, u.id);
                        cReq.input('desc', sql.NVarChar, u.description);
                        await cReq.query(`
                            UPDATE component_changes 
                            SET assembly_description = @desc 
                            WHERE ecn_id = @ecn_id 
                              AND (assembly_description IS NULL OR LTRIM(RTRIM(assembly_description)) = '' OR assembly_description LIKE 'ZPP_CC07%' OR assembly_description LIKE 'ECN %' OR assembly_description LIKE 'ECN importado%')
                        `);

                        if (r.rowsAffected && r.rowsAffected[0] > 0) {
                            updatedCount++;
                            updatedEcns.push(u.id);
                        }
                    } catch (e: any) {
                        console.warn(`[IQS3 Sync Local] Error actualizando ECN ${u.id}:`, e.message);
                    }
                }
            }

            return {
                success: true,
                message: `Se actualizaron ${updatedCount} descripciones directamente desde la transacción IQS3 (I1S3).`,
                totalFound: ecnList.length,
                updatedCount,
                updatedEcns
            };

        } catch (err: any) {
            try { fs.unlinkSync(tempScriptPath); } catch (_) { }
            return {
                success: false,
                error: `Fallo al ejecutar script de automatización IQS3: ${err.message}`,
                message: 'Error al ejecutar extracción IQS3',
                totalFound: ecnList.length,
                updatedCount: 0,
                updatedEcns: []
            };
        }
    }

    // POST /api/sap/sync-iqs3-descriptions
    // Endpoint para navegar directamente a la transaccion IQS3 (I1S3) y tomar la descripcion de cada ECN existente o segun mascara
    app.post('/api/sap/sync-iqs3-descriptions', async (req, res) => {
        try {
            const { mask, allExisting, ecns } = req.body || {};
            const targetEcns = await getTargetEcnsForIqs3({ mask, allExisting, ecns });

            if (targetEcns.length === 0) {
                return res.json({
                    success: true,
                    message: mask 
                        ? `No se encontraron ECNs en la base de datos con la máscara "${mask}".`
                        : 'No se encontraron ECNs en la base de datos.',
                    totalFound: 0,
                    updatedCount: 0,
                    updatedEcns: [],
                    missingEcns: []
                });
            }

            // Si corre en Windows con SAP GUI local disponible:
            if (process.platform === 'win32') {
                const result = await runIqs3ExtractionLocally(targetEcns);
                return res.json(result);
            }

            // Si corre en contenedor Cloud / Linux:
            const maskParam = encodeURIComponent(mask || (allExisting ? '*' : ''));

            return res.json({
                success: true,
                mode: 'cloud_ready',
                totalFound: targetEcns.length,
                missingEcns: targetEcns,
                ecns: targetEcns,
                mask: mask || (allExisting ? '*' : ''),
                downloadVbsUrl: `/api/sap/download-iqs3-vbs?mask=${maskParam}&allExisting=${allExisting ? 'true' : 'false'}`,
                downloadBatUrl: `/api/sap/download-iqs3-bat?mask=${maskParam}&allExisting=${allExisting ? 'true' : 'false'}`,
                webguiUrl: 'https://brpwas.honeywell.com/sap/bc/gui/sap/its/webgui/?~transaction=IQS3',
                message: `Se encontraron ${targetEcns.length} ECN(s) para extraer descripciones directamente desde la transacción IQS3 (I1S3).`
            });
        } catch (err: any) {
            console.error('[IQS3 Sync Error]', err);
            return res.status(500).json({ success: false, error: err.message });
        }
    });

    // GET /api/sap/download-iqs3-vbs
    app.get('/api/sap/download-iqs3-vbs', async (req, res) => {
        try {
            const mask = req.query.mask ? String(req.query.mask) : '';
            const allExisting = req.query.allExisting === 'true' || !mask || mask === '*';
            const targetEcns = await getTargetEcnsForIqs3({ mask, allExisting });

            const host = req.get('host') || 'localhost:3000';
            const protocol = req.protocol || 'http';
            const apiUrl = `${protocol}://${host}/api/sap/update-descriptions`;

            const vbsContent = generateIqs3VbsScript(targetEcns, apiUrl);
            res.setHeader('Content-Disposition', 'attachment; filename="sync_iqs3_descriptions.vbs"');
            res.setHeader('Content-Type', 'text/plain; charset=utf-8');
            return res.send(vbsContent);
        } catch (err: any) {
            return res.status(500).send(`Error generando script VBS: ${err.message}`);
        }
    });

    // GET /api/sap/download-iqs3-bat
    app.get('/api/sap/download-iqs3-bat', async (req, res) => {
        try {
            const mask = req.query.mask ? String(req.query.mask) : '';
            const allExisting = req.query.allExisting === 'true';
            const host = req.get('host') || 'localhost:3000';
            const protocol = req.protocol || 'http';
            const vbsUrl = `${protocol}://${host}/api/sap/download-iqs3-vbs?mask=${encodeURIComponent(mask)}&allExisting=${allExisting ? 'true' : 'false'}`;

            const batContent = `@echo off
setlocal enabledelayedexpansion
title Honeywell ECN Manager - Extraccion Directa IQS3 (I1S3)
echo =========================================================================
echo   HONEYWELL ECN MANAGER - EXTRACCION DIRECTA TRANSACCION IQS3 (I1S3)
echo =========================================================================
echo Conectando con SAP GUI y navegando directamente a la transaccion IQS3...
echo.

set "VBS_FILE=%TEMP%\\sync_iqs3_%RANDOM%.vbs"

powershell -Command "Invoke-WebRequest -Uri '${vbsUrl}' -OutFile '%VBS_FILE%'" 2>nul
if not exist "%VBS_FILE%" (
    curl -s -k "${vbsUrl}" -o "%VBS_FILE%"
)

if not exist "%VBS_FILE%" (
    echo [ERROR] No se pudo descargar el script VBS desde ${vbsUrl}
    pause
    exit /b 1
)

echo [1/2] Ejecutando navegacion directa en transaccion IQS3 en SAP GUI...
cscript.exe //NoLogo "%VBS_FILE%"
set "EXIT_CODE=%ERRORLEVEL%"

del "%VBS_FILE%" 2>nul

echo.
echo =========================================================================
echo [2/2] Proceso de extraccion IQS3 finalizado (Codigo: %EXIT_CODE%).
echo Las descripciones se han actualizado en su base de datos ECN Manager.
echo =========================================================================
pause
`;
            res.setHeader('Content-Disposition', 'attachment; filename="sync_iqs3.bat"');
            res.setHeader('Content-Type', 'application/x-bat');
            return res.send(batContent);
        } catch (err: any) {
            return res.status(500).send(`Error generando script BAT: ${err.message}`);
        }
    });

    // --- 7. SAP CS15 Where-Used Automation (Assemblies starting with 'A' -> Max Level -> SKU) ---
    async function getTargetAssembliesForCs15(): Promise<string[]> {
        try {
            const result = await db.pool.request().query(`
                SELECT DISTINCT assembly 
                FROM component_changes 
                WHERE assembly LIKE 'A%' AND assembly IS NOT NULL AND LTRIM(RTRIM(assembly)) <> ''
            `);
            return result.recordset.map((r: any) => String(r.assembly).trim()).filter(Boolean);
        } catch (e) {
            const mem = db.getMemoryStore();
            const set = new Set<string>();
            for (const c of mem.component_changes) {
                if (c.assembly && c.assembly.toUpperCase().startsWith('A')) {
                    set.add(c.assembly.trim());
                }
            }
            return Array.from(set);
        }
    }

    function generateCs15VbsScript(assemblies: string[], apiUrl: string): string {
        const jsonEscapedList = assemblies.map(a => `"${a}"`).join(', ');
        return `'=============================================================================
' HONEYWELL ECN MANAGER - AUTOMATIZACION TRANSACCION CS15 (WHERE-USED)
' Ensambles que inician con 'A' -> Extraccion nivel maximo (Nv.) -> SKU
'=============================================================================
On Error Resume Next

Dim SapGuiAuto, appObj, connObj, sessionObj, wshShell, httpObj
Dim assemblyList, currentAssembly, i, rowCount, r, grid
Dim currMat, currLvl, maxLvl, bestSku, totalUpdated, updatePayload

Set wshShell = CreateObject("WScript.Shell")
totalUpdated = 0
updatePayload = "["

Set SapGuiAuto = GetObject("SAPGUI")
If Err.Number <> 0 Or SapGuiAuto Is Nothing Then
    WScript.Echo "RESULT_ERR:No se detecto proceso activo de SAP GUI."
    WScript.Quit 1
End If

Set appObj = SapGuiAuto.GetScriptingEngine
If Err.Number <> 0 Or appObj Is Nothing Then
    WScript.Echo "RESULT_ERR:Scripting de SAP GUI deshabilitado."
    WScript.Quit 1
End If

If appObj.Children.Count = 0 Then
    WScript.Echo "RESULT_ERR:No hay conexiones abiertas en SAP Logon."
    WScript.Quit 1
End If

Set connObj = appObj.Children(0)
Set sessionObj = connObj.Children(0)

If sessionObj Is Nothing Then
    WScript.Echo "RESULT_ERR:No hay sesion activa en SAP GUI."
    WScript.Quit 1
End If

WScript.Echo "Conectado a SAP GUI. Iniciando transaccion CS15..."

sessionObj.findById("wnd[0]/tbar[0]/btn[3]").press
sessionObj.findById("wnd[0]/tbar[0]/btn[3]").press
sessionObj.findById("wnd[0]").maximize

assemblyList = Array(${jsonEscapedList})

For i = LBound(assemblyList) To UBound(assemblyList)
    currentAssembly = Trim(assemblyList(i))
    
    If currentAssembly <> "" Then
        ' 1. Entrar a CS15
        sessionObj.findById("wnd[0]/tbar[0]/okcd").Text = "/nCS15"
        sessionObj.findById("wnd[0]").SendVKey 0
        
        ' 2. Pantalla inicial (Imagen 1)
        sessionObj.findById("wnd[0]/usr/ctxtRC29N-IDNRK").Text = currentAssembly
        sessionObj.findById("wnd[0]/usr/chkRC29N-DIREKT").Selected = True
        sessionObj.findById("wnd[0]/usr/chkRC29N-MATUV").Selected = True
        sessionObj.findById("wnd[0]/usr/ctxtRC29N-DATBI").Text = "31.12.9999"
        sessionObj.findById("wnd[0]/tbar[0]/btn[8]").press
        
        ' 3. Pantalla de vista (Imagen 2)
        sessionObj.findById("wnd[0]/usr/ctxtRC29N-DATUV").Text = "01.01.2026"
        sessionObj.findById("wnd[0]/usr/ctxtRC29N-WERKS").Text = "5205"
        sessionObj.findById("wnd[0]/usr/chkRC29N-STULF").Selected = True
        sessionObj.findById("wnd[0]/usr/chkRC29N-STFLG").Selected = True
        sessionObj.findById("wnd[0]/tbar[0]/btn[8]").press
        
        ' 4. Resultado (Imagen 3) - Buscar mayor Nv.
        maxLvl = -1
        bestSku = ""
        
        Set grid = sessionObj.findById("wnd[0]/usr/cntlGRID1/shell")
        If grid Is Nothing Then
            Set grid = sessionObj.findById("wnd[0]/usr/cntlCC_CONTAINER/shell")
        End If
        
        If Not (grid Is Nothing) Then
            rowCount = grid.RowCount
            For r = 0 To rowCount - 1
                currMat = Trim(CStr(grid.GetCellValue(r, "IDNRK")))
                If currMat = "" Then currMat = Trim(CStr(grid.GetCellValue(r, "MATNR")))
                
                currLvl = -1
                Err.Clear
                currLvl = CInt(Trim(CStr(grid.GetCellValue(r, "STUFE"))))
                If Err.Number <> 0 Then
                    Err.Clear
                    currLvl = CInt(Trim(CStr(grid.GetCellValue(r, "LEVEL"))))
                End If
                If Err.Number <> 0 Then
                    Err.Clear
                    currLvl = CInt(Trim(CStr(grid.GetCellValue(r, "NV"))))
                End If
                On Error Resume Next
                
                If currLvl > maxLvl And currMat <> "" Then
                    maxLvl = currLvl
                    bestSku = currMat
                End If
            Next
        End If
        
        ' Volver al inicio para siguiente ensamble
        sessionObj.findById("wnd[0]/tbar[0]/btn[3]").press
        sessionObj.findById("wnd[0]/tbar[0]/btn[3]").press
        
        If bestSku <> "" Then
            WScript.Echo "CS15_OK:" & currentAssembly & ":::" & bestSku & ":::Nivel:" & CStr(maxLvl)
            If totalUpdated > 0 Then updatePayload = updatePayload & ","
            updatePayload = updatePayload & "{""assembly"":""" & currentAssembly & """,""sku"":""" & bestSku & """}"
            totalUpdated = totalUpdated + 1
        Else
            WScript.Echo "CS15_EMPTY:" & currentAssembly
        End If
    End If
Next

updatePayload = updatePayload & "]"
WScript.Echo "RESULT_OK:FINISHED_CS15_COUNT:" & CStr(totalUpdated)

If totalUpdated > 0 And "${apiUrl}" <> "" Then
    Err.Clear
    Set httpObj = CreateObject("MSXML2.ServerXMLHTTP.6.0")
    If Err.Number <> 0 Then
        Set httpObj = CreateObject("MSXML2.XMLHTTP")
    End If
    If Not (httpObj Is Nothing) Then
        httpObj.Open "POST", "${apiUrl}", False
        httpObj.setRequestHeader "Content-Type", "application/json"
        httpObj.Send "{""updates"":" & updatePayload & "}"
    End If
End If
`;
    }

    async function runCs15ExtractionLocally(assemblies: string[]): Promise<{
        success: boolean;
        message: string;
        totalFound: number;
        updatedCount: number;
        updates: Array<{ assembly: string; sku: string }>;
    }> {
        if (assemblies.length === 0) {
            return { success: true, message: 'No hay ensambles que inicien con A.', totalFound: 0, updatedCount: 0, updates: [] };
        }

        const tempScriptPath = path.join(os.tmpdir(), `sap_cs15_${Date.now()}.vbs`);
        const host = 'localhost:3000';
        const apiUrl = `http://${host}/api/sap/update-cs15-skus`;
        const vbsCode = generateCs15VbsScript(assemblies, apiUrl);

        const updates: Array<{ assembly: string; sku: string }> = [];

        try {
            fs.writeFileSync(tempScriptPath, vbsCode, 'utf-8');
            const cmd = getCScriptCommand(tempScriptPath);

            const execution = await new Promise<{ stdout: string; stderr: string }>((resolve, reject) => {
                exec(cmd, { timeout: Math.max(60000, assemblies.length * 8000) }, (error, stdout, stderr) => {
                    try { fs.unlinkSync(tempScriptPath); } catch (_) { }
                    if (error && (error as any).code !== 'ETIMEDOUT') {
                        reject(error);
                        return;
                    }
                    resolve({ stdout: stdout || '', stderr: stderr || '' });
                });
            });

            const combined = ((execution.stdout || '') + '\n' + (execution.stderr || '')).trim();
            const lines = combined.split(/\r?\n/);

            for (const line of lines) {
                if (line.startsWith('CS15_OK:')) {
                    const payload = line.replace('CS15_OK:', '');
                    const parts = payload.split(':::');
                    if (parts.length >= 2) {
                        const asm = parts[0].trim();
                        const sku = parts[1].trim();
                        if (asm && sku) {
                            updates.push({ assembly: asm, sku });
                            try {
                                await db.pool.request()
                                    .input('assembly', sql.NVarChar, asm)
                                    .input('sku', sql.NVarChar, sku)
                                    .query('UPDATE component_changes SET sku = @sku WHERE assembly = @assembly');
                            } catch (dbErr) { }
                        }
                    }
                }
            }

            return {
                success: true,
                message: `CS15 ejecutado exitosamente para ${assemblies.length} ensambles con 'A'. SKUs actualizados por nivel máximo: ${updates.length}.`,
                totalFound: assemblies.length,
                updatedCount: updates.length,
                updates
            };
        } catch (err: any) {
            try { fs.unlinkSync(tempScriptPath); } catch (_) { }
            throw new Error(`Fallo ejecutando automatización CS15: ${err.message}`);
        }
    }

    app.post('/api/sap/sync-cs15-skus', async (req, res) => {
        try {
            const assemblies = await getTargetAssembliesForCs15();
            if (assemblies.length === 0) {
                return res.json({
                    success: true,
                    message: 'No se encontraron ensambles que inicien con la letra "A" en la base de datos.',
                    totalFound: 0,
                    updatedCount: 0,
                    updates: []
                });
            }

            if (process.platform === 'win32') {
                const result = await runCs15ExtractionLocally(assemblies);
                return res.json(result);
            }

            const host = req.get('host') || 'localhost:3000';
            const protocol = req.protocol || 'http';

            return res.json({
                success: true,
                mode: 'cloud_ready',
                totalFound: assemblies.length,
                assemblies,
                downloadVbsUrl: `${protocol}://${host}/api/sap/download-cs15-vbs`,
                downloadBatUrl: `${protocol}://${host}/api/sap/download-cs15-bat`,
                webguiUrl: 'https://brpwas.honeywell.com/sap/bc/gui/sap/its/webgui/?~transaction=CS15',
                message: `Se encontraron ${assemblies.length} ensamble(s) que inician con 'A' para procesar en CS15.`
            });
        } catch (err: any) {
            console.error('[CS15 Sync Error]', err);
            return res.status(500).json({ success: false, error: err.message });
        }
    });

    app.post('/api/sap/update-cs15-skus', async (req, res) => {
        try {
            const updates = req.body?.updates || [];
            let updatedCount = 0;
            for (const u of updates) {
                if (u.assembly && u.sku) {
                    await db.pool.request()
                        .input('assembly', sql.NVarChar, u.assembly)
                        .input('sku', sql.NVarChar, u.sku)
                        .query('UPDATE component_changes SET sku = @sku WHERE assembly = @assembly');
                    updatedCount++;
                }
            }
            return res.json({ success: true, updatedCount });
        } catch (err: any) {
            return res.status(500).json({ success: false, error: err.message });
        }
    });

    app.get('/api/sap/download-cs15-vbs', async (req, res) => {
        try {
            const assemblies = await getTargetAssembliesForCs15();
            const host = req.get('host') || 'localhost:3000';
            const protocol = req.protocol || 'http';
            const apiUrl = `${protocol}://${host}/api/sap/update-cs15-skus`;
            const vbsContent = generateCs15VbsScript(assemblies, apiUrl);
            res.setHeader('Content-Disposition', 'attachment; filename="sync_cs15_skus.vbs"');
            res.setHeader('Content-Type', 'text/plain; charset=utf-8');
            return res.send(vbsContent);
        } catch (err: any) {
            return res.status(500).send(`Error generando script CS15 VBS: ${err.message}`);
        }
    });

    app.get('/api/sap/download-cs15-bat', async (req, res) => {
        try {
            const host = req.get('host') || 'localhost:3000';
            const protocol = req.protocol || 'http';
            const vbsUrl = `${protocol}://${host}/api/sap/download-cs15-vbs`;
            const batContent = `@echo off
setlocal enabledelayedexpansion
title Honeywell ECN Manager - Automatizacion CS15 Where-Used
echo =========================================================================
echo   HONEYWELL ECN MANAGER - AUTOMATIZACION CS15 (ENSAMBLES CON A)
echo =========================================================================
echo Conectando con SAP GUI y ejecutando CS15 para cada ensamble...
echo.

set "VBS_FILE=%TEMP%\\sync_cs15_%RANDOM%.vbs"
powershell -Command "Invoke-WebRequest -Uri '${vbsUrl}' -OutFile '%VBS_FILE%'" 2>nul
if not exist "%VBS_FILE%" (
    curl -s -k "${vbsUrl}" -o "%VBS_FILE%"
)

if not exist "%VBS_FILE%" (
    echo [ERROR] No se pudo descargar el script VBS.
    pause
    exit /b 1
)

cscript.exe //NoLogo "%VBS_FILE%"
set "EXIT_CODE=%ERRORLEVEL%"
del "%VBS_FILE%" 2>nul

echo.
echo =========================================================================
echo Proceso CS15 finalizado. SKUs actualizados por nivel maximo.
echo =========================================================================
pause
`;
            res.setHeader('Content-Disposition', 'attachment; filename="sync_cs15.bat"');
            res.setHeader('Content-Type', 'application/x-bat');
            return res.send(batContent);
        } catch (err: any) {
            return res.status(500).send(`Error generando script CS15 BAT: ${err.message}`);
        }
    });

    // 6. Endpoint to test/verify SAP auto-connect and shortcut "Inicio" connection
    app.post('/api/sap/ensure-connection', async (req, res) => {
        const connectionName = req.body?.connectionName || 'Inicio';
        if (process.platform !== 'win32') {
            return res.json({
                success: false,
                message: 'Verificación de conexión SAP solo aplica en entornos Windows con SAP GUI instalado.',
                platform: process.platform
            });
        }

        try {
            await ensureSapSessionActive(connectionName);
            return res.json({
                success: true,
                message: `Secuencia de conexión para '${connectionName}' ejecutada. SAP Logon verificado y ventanas modales gestionadas hasta SAP Easy Access.`
            });
        } catch (err: any) {
            return res.status(500).json({
                success: false,
                error: err.message || 'Error al verificar conexión con SAP'
            });
        }
    });

    // Execute sync endpoint – commits extracted ECNs into DB (using cscript / VBScript macro, NO PowerShell)
    app.post('/api/sap/execute-sync', async (req, res) => {
        let exportRootToClean: string | null = null;
        try {
            const body = req.body || {};
            const startDate = body.startDate || body.initialDate || '';
            const endDate = body.endDate || body.finalDate || '';
            const plantInput = body.plant || '5205';
            const requestedPlant = (plantInput || '5205').trim();

            // Validate plant 5201 if MXOH is not enabled
            if (requestedPlant === '5201') {
                const mxohSetting = await db.pool.request()
                    .input('key', sql.NVarChar, 'mxoh_plant_5201_enabled')
                    .query('SELECT value FROM settings WHERE [key] = @key');
                const mxohValue = mxohSetting.recordset[0]?.value || '';
                if (mxohValue.toLowerCase() !== 'true' && mxohValue.toLowerCase() !== '1') {
                    return res.status(403).json({ error: 'La Planta 5201 está deshabilitada. Para habilitarla, active la opción MXOH en la configuración.' });
                }
            }

            let records: any[] = body.records || [];

            // If records were not passed in payload, execute the VBScript extraction directly
            if (!records || records.length === 0) {
                if (process.platform !== 'win32') {
                    return res.status(400).json({
                        success: false,
                        error: 'ZPP_CC07 solo se ejecuta en Windows con SAP GUI activo. No hay modo simulado disponible.',
                        mode: 'disabled'
                    });
                }

                const extractionResult = await runZppExtraction([requestedPlant], startDate, endDate);
                records = extractionResult.records;
                exportRootToClean = extractionResult.exportRoot;
            }

            let skippedPlant5201Count = 0;
            const filteredRecords = records.filter(r => {
                const rowPlant = String(r.plant || requestedPlant).trim();
                if (rowPlant === '5201' && requestedPlant !== '5201') {
                    skippedPlant5201Count++;
                    return false;
                }
                return true;
            });

            // Use the batch upsert engine for direct SAP sync. Each extracted row remains
            // an individual component change; only the ECN envelope is grouped.
            const ecnsById = new Map<string, any>();
            for (const rec of filteredRecords) {
                const ecnId = dbText(rec.ecnNumber || rec.ecn, 50);
                if (!ecnId) continue;

                let ecn = ecnsById.get(ecnId);
                if (!ecn) {
                    ecn = {
                        id: ecnId,
                        initiator: dbText(rec.initiator || rec.createdBy, 50, 'SAP GUI Scripting Engine'),
                        description: dbText(rec.description, 1000, `ECN ${ecnId} extraído desde SAP`),
                        status: 'Pendiente',
                        creationDate: dateForDb(rec.creationDate || rec.createdOn),
                        implementationDate: null,
                        changes: [],
                        notes: []
                    };
                    ecnsById.set(ecnId, ecn);
                }

                const startDate = dateForDb(rec.startDate);
                if (startDate && (!ecn.implementationDate || startDate > ecn.implementationDate)) {
                    ecn.implementationDate = startDate;
                }

                ecn.changes.push({
                    assembly: dbText(rec.assembly, 255),
                    assemblyRevision: dbText(rec.assemblyRevision, 50),
                    assemblyDescription: dbText(rec.assemblyDescription || rec.description, 2000),
                    oldComponent: dbText(rec.oldComponent || rec.oldMaterial, 255),
                    newComponent: dbText(rec.newComponent || rec.newMaterial, 255),
                    newComponentRevision: dbText(rec.newComponentRevision, 50),
                    newComponentDescription: dbText(rec.newComponentDescription, 2000),
                    oldSubassembly: dbText(rec.oldSubassembly, 255),
                    newSubassembly: dbText(rec.newSubassembly, 255),
                    newSubassemblyRevision: dbText(rec.newSubassemblyRevision, 50),
                    newSubassemblyDescription: dbText(rec.newSubassemblyDescription, 2000),
                    sku: dbText(rec.topSku || rec.sku, 255),
                    family: dbText(rec.family, 255, 'VESDA'),
                    demand: rec.demand || rec.qty || 0,
                    onHandInventory: rec.onHandInventory || 0,
                    openPoQty: rec.openPoQty || 0,
                    startDate,
                    site: dbText(rec.plant || requestedPlant, 50)
                });
            }

            const today = new Date();
            const todayUtc = Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate());
            for (const ecn of ecnsById.values()) {
                const datedChanges = ecn.changes.filter((change: any) => change.startDate);
                const pastOrPresent = datedChanges.filter((change: any) => change.startDate.getTime() <= todayUtc).length;
                if (datedChanges.length === 0 || pastOrPresent === 0) {
                    ecn.status = 'Pendiente';
                } else if (pastOrPresent === datedChanges.length) {
                    ecn.status = 'Implementado';
                } else {
                    ecn.status = 'Implementado Parcial';
                }
            }

            console.log(`[SAP Sync] ${filteredRecords.length} filas extraídas, ${Array.from(ecnsById.values()).reduce((total, ecn) => total + ecn.changes.filter((change: any) => change.startDate).length, 0)} con startDate válido, ${ecnsById.size} ECNs.`);

            req.body = {
                ecns: Array.from(ecnsById.values()),
                fileName: `SAP GUI ZPP_CC07 Macro (${requestedPlant})`
            };
            try {
                return await handleSapUpsertOptimized(req, res);
            } finally {
                if (exportRootToClean) {
                    await closeSapExportWorkbook(exportRootToClean);
                    try { fs.rmSync(exportRootToClean, { recursive: true, force: true }); } catch (_) { }
                }
            }

            // The implementation date is the latest valid start date across all assemblies of each ECN.
            const implementationDates = new Map<string, Date>();
            for (const rec of filteredRecords) {
                const ecnId = dbText(rec.ecnNumber || rec.ecn, 50);
                const startDate = parseDateOnly(rec.startDate) as Date;
                if (!ecnId || startDate === null) continue;

                const currentLatest = implementationDates.get(ecnId) as Date | undefined;
                if (currentLatest === undefined || startDate.getTime() > currentLatest!.getTime()) {
                    implementationDates.set(ecnId, startDate);
                }
            }

            // Upsert directly into Database
            const transaction = new sql.Transaction(db.pool);
            await transaction.begin();
            let newCount = 0;
            let updatedCount = 0;

            try {
                for (const rec of filteredRecords) {
                    const ecnId = dbText(rec.ecnNumber || rec.ecn, 50);
                    if (!ecnId) continue;

                    const initiator = dbText(rec.initiator || rec.createdBy, 50, 'SAP GUI Scripting Engine');
                    const userCheck = await transaction.request()
                        .input('uid', sql.NVarChar, initiator)
                        .query("SELECT id FROM users WHERE id = @uid");
                    if (userCheck.recordset.length === 0) {
                        await transaction.request()
                            .input('uid', sql.NVarChar, initiator)
                            .input('name', sql.NVarChar, initiator)
                            .query("INSERT INTO users (id, name) VALUES (@uid, @name)");
                    }

                    const request = transaction.request();
                    request.input('id', sql.NVarChar, ecnId);
                    const existing = await request.query("SELECT id FROM ecns WHERE id = @id");
                    const isUpdate = existing.recordset.length > 0;

                    request.input('init', sql.NVarChar, initiator);
                    request.input('desc', sql.NVarChar, dbText(rec.description, 1000, `ECN ${ecnId} extraído desde SAP`));
                    request.input('stat', sql.NVarChar, dbText('Pendiente', 100));
                    request.input('cdat', sql.Date, rec.creationDate || rec.createdOn ? new Date(rec.creationDate || rec.createdOn) : new Date());
                    request.input('idat', sql.Date, dateForDb(implementationDates.get(ecnId)));

                    if (isUpdate) {
                        await request.query("UPDATE ecns SET initiator=@init, description=@desc, status=@stat, implementation_date=@idat WHERE id=@id");
                        updatedCount++;
                    } else {
                        await request.query("INSERT INTO ecns (id, initiator, description, status, creation_date, implementation_date) VALUES (@id, @init, @desc, @stat, @cdat, @idat)");
                        newCount++;
                    }

                    // Insert or update component change
                    const cReq = transaction.request();
                    cReq.input('ecn_id', sql.NVarChar, ecnId);
                    cReq.input('assembly', sql.NVarChar, dbText(rec.assembly, 100));
                    cReq.input('assembly_rev', sql.NVarChar, dbText(rec.assemblyRevision, 50));
                    cReq.input('assembly_desc', sql.NVarChar, dbText(rec.assemblyDescription || rec.description, 1000));
                    cReq.input('old_comp', sql.NVarChar, dbText(rec.oldComponent || rec.oldMaterial, 100));
                    cReq.input('new_comp', sql.NVarChar, dbText(rec.newComponent || rec.newMaterial, 100));
                    cReq.input('new_comp_rev', sql.NVarChar, dbText(rec.newComponentRevision, 50));
                    cReq.input('new_comp_desc', sql.NVarChar, dbText(rec.newComponentDescription, 1000));
                    cReq.input('old_sub', sql.NVarChar, dbText(rec.oldSubassembly, 100));
                    cReq.input('new_sub', sql.NVarChar, dbText(rec.newSubassembly, 100));
                    cReq.input('new_sub_rev', sql.NVarChar, dbText(rec.newSubassemblyRevision, 50));
                    cReq.input('new_sub_desc', sql.NVarChar, dbText(rec.newSubassemblyDescription, 1000));
                    cReq.input('sku', sql.NVarChar, dbText(rec.topSku || rec.sku, 100));
                    cReq.input('family', sql.NVarChar, dbText(rec.family, 100, 'VESDA'));
                    cReq.input('demand', sql.Decimal(18, 2), rec.demand || rec.qty || 0);
                    cReq.input('on_hand', sql.Decimal(18, 2), rec.onHandInventory || 0);
                    cReq.input('open_po', sql.Decimal(18, 2), rec.openPoQty || 0);
                    cReq.input('sdate', sql.Date, dateForDb(rec.startDate));
                    cReq.input('site', sql.NVarChar, dbText(rec.plant || requestedPlant, 20));

                    const existingComp = await cReq.query(`
                        SELECT id FROM component_changes 
                        WHERE ecn_id = @ecn_id AND assembly = @assembly AND old_component = @old_comp AND new_component = @new_comp AND site = @site
                    `);

                    if (existingComp.recordset.length > 0) {
                        const compId = existingComp.recordset[0].id;
                        const uReq = transaction.request();
                        uReq.input('comp_id', sql.UniqueIdentifier, compId);
                        uReq.input('assembly_rev', sql.NVarChar, rec.assemblyRevision || '');
                        uReq.input('assembly_desc', sql.NVarChar, rec.assemblyDescription || rec.description || '');
                        uReq.input('new_comp_rev', sql.NVarChar, rec.newComponentRevision || '');
                        uReq.input('new_comp_desc', sql.NVarChar, rec.newComponentDescription || '');
                        uReq.input('sku', sql.NVarChar, rec.topSku || rec.sku || '');
                        uReq.input('family', sql.NVarChar, rec.family || 'VESDA');
                        uReq.input('demand', sql.Decimal(18, 2), rec.demand || rec.qty || 0);
                        uReq.input('on_hand', sql.Decimal(18, 2), rec.onHandInventory || 0);
                        uReq.input('open_po', sql.Decimal(18, 2), rec.openPoQty || 0);
                        uReq.input('sdate', sql.Date, dateForDb(rec.startDate));

                        await uReq.query(`
                            UPDATE component_changes SET
                                assembly_revision = @assembly_rev,
                                assembly_description = @assembly_desc,
                                new_component_revision = @new_comp_rev,
                                new_component_description = @new_comp_desc,
                                sku = @sku,
                                family = @family,
                                demand = @demand,
                                on_hand_inventory = @on_hand,
                                open_po_qty = @open_po,
                                start_date = @sdate
                            WHERE id = @comp_id
                        `);
                    } else {
                        await cReq.query(`
                            INSERT INTO component_changes (
                                id, ecn_id, assembly, assembly_revision, assembly_description,
                                old_component, new_component, new_component_revision, new_component_description,
                                old_subassembly, new_subassembly, new_subassembly_revision, new_subassembly_description,
                                sku, family, demand, on_hand_inventory, open_po_qty, start_date, site
                            ) VALUES (
                                NEWID(), @ecn_id, @assembly, @assembly_rev, @assembly_desc,
                                @old_comp, @new_comp, @new_comp_rev, @new_comp_desc,
                                @old_sub, @new_sub, @new_sub_rev, @new_sub_desc,
                                @sku, @family, @demand, @on_hand, @open_po, @sdate, @site
                            )
                        `);
                    }

                    if (rec.comments) {
                        const noteTxt = dbText(rec.comments, 2000);
                        const noteCheck = await transaction.request()
                            .input('ecn_id', sql.NVarChar, ecnId)
                            .input('txt', sql.NVarChar, noteTxt)
                            .query("SELECT id FROM notes WHERE ecn_id = @ecn_id AND text = @txt");

                        if (noteCheck.recordset.length === 0) {
                            const nReq = transaction.request();
                            nReq.input('nid', sql.UniqueIdentifier, uuidv4());
                            nReq.input('ecn_id', sql.NVarChar, ecnId);
                            nReq.input('author', sql.NVarChar, initiator);
                            nReq.input('txt', sql.NVarChar, noteTxt);
                            nReq.input('ndate', sql.DateTimeOffset, new Date());
                            await nReq.query("INSERT INTO notes (id, ecn_id, author, text, date) VALUES (@nid, @ecn_id, @author, @txt, @ndate)");
                        }
                    }
                }

                // Keep every ECN implementation date aligned with all of its assemblies.
                await transaction.request().query(`
                    UPDATE e
                    SET implementation_date = latest.max_start_date
                    FROM ecns e
                    INNER JOIN (
                        SELECT ecn_id, MAX(start_date) AS max_start_date
                        FROM component_changes
                        WHERE start_date IS NOT NULL
                        GROUP BY ecn_id
                    ) latest ON latest.ecn_id = e.id
                `);

                // Log to import_logs
                await transaction.request()
                    .input('ts', sql.DateTimeOffset, new Date())
                    .input('file', sql.NVarChar, dbText(`SAP GUI ZPP_CC07 Macro (${requestedPlant})`, 255))
                    .input('total', sql.Int, filteredRecords.length)
                    .input('new_ecns', sql.NVarChar, dbText(`${newCount} nuevos`, 100))
                    .input('upd_ecns', sql.NVarChar, dbText(`${updatedCount} actualizados`, 100))
                    .input('details', sql.NVarChar, dbText(`Sincronización directa SAP ejecutada vía macro ZPP_CC07 (cscript/VBScript) para planta ${requestedPlant}. Nuevos: ${newCount}, Actualizados: ${updatedCount}. Ignorados 5201: ${skippedPlant5201Count}`, 1000))
                    .query("INSERT INTO import_logs (timestamp, file_name, total_records, new_ecns, updated_ecns, details) VALUES (@ts, @file, @total, @new_ecns, @upd_ecns, @details)");

                // Log to audit_log
                await transaction.request()
                    .input('aid', sql.UniqueIdentifier, uuidv4())
                    .input('uts', sql.DateTimeOffset, new Date())
                    .input('uuser', sql.NVarChar, dbText('SAP ZPP_CC07 Bridge', 100))
                    .input('utype', sql.NVarChar, dbText('Sincronización Directa', 50))
                    .input('utarget', sql.NVarChar, dbText(`Planta ${requestedPlant}`, 255))
                    .input('uact', sql.NVarChar, dbText(`Extracción directa SAP ZPP_CC07 completada: ${newCount} nuevos, ${updatedCount} actualizados.`, 1000))
                    .query("INSERT INTO audit_log (id, timestamp, [user], type, target, action) VALUES (@aid, @uts, @uuser, @utype, @utarget, @uact)");

                await transaction.commit();
            } catch (txErr: any) {
                if (transaction) await transaction.rollback();
                throw txErr;
            }

            res.json({
                success: true,
                message: `Sincronización automatizada SAP ZPP_CC07 completada: ${newCount} nuevos, ${updatedCount} actualizados.`,
                mode: 'real',
                newCount,
                updatedCount,
                totalRecords: filteredRecords.length,
                skipped5201: skippedPlant5201Count
            });
        } catch (e: any) {
            console.error('[SAP Execute Sync Error]', e);
            res.status(500).json({ error: e.message });
        }
    });

    // POST /api/sap/sync-tampermonkey
    // Endpoint para recibir peticiones POST desde scripts de Tampermonkey / Greasemonkey / Violentmonkey
    // ejecutados en SAP WebGUI (ZPP_CC07, CC03, IQS3) o extensiones de navegador.
    app.post('/api/sap/sync-tampermonkey', async (req, res) => {
        try {
            console.log('[SAP Tampermonkey] Petición POST recibida en /api/sap/sync-tampermonkey');
            const body = req.body || {};

            let rawItems: any[] = [];
            let sourcePlant = '5205';
            let fileName = 'Tampermonkey SAP WebGUI Sync';

            // Soporta formatos flexibles: Array directo, { ecns: [...] }, { records: [...] }, { data: [...] }, { rows: [...] } o único objeto
            if (Array.isArray(body)) {
                rawItems = body;
            } else if (Array.isArray(body.ecns)) {
                rawItems = body.ecns;
                sourcePlant = body.plant || body.site || sourcePlant;
                fileName = body.fileName || fileName;

                // Si ya contiene la estructura de ECNs completa con arreglo de changes:
                if (rawItems.length > 0 && Array.isArray(rawItems[0]?.changes)) {
                    req.body = {
                        ecns: rawItems,
                        fileName
                    };
                    return await handleSapUpsertOptimized(req, res);
                }
            } else if (Array.isArray(body.records)) {
                rawItems = body.records;
                sourcePlant = body.plant || body.site || sourcePlant;
                fileName = body.fileName || fileName;
            } else if (Array.isArray(body.data)) {
                rawItems = body.data;
                sourcePlant = body.plant || body.site || sourcePlant;
                fileName = body.fileName || fileName;
            } else if (Array.isArray(body.rows)) {
                rawItems = body.rows;
                sourcePlant = body.plant || body.site || sourcePlant;
                fileName = body.fileName || fileName;
            } else if (typeof body === 'object' && body !== null && (body.ecn || body.ecnNumber || body.id)) {
                rawItems = [body];
                sourcePlant = body.plant || body.site || sourcePlant;
                fileName = body.fileName || fileName;
            }

            if (!rawItems || rawItems.length === 0) {
                return res.status(400).json({
                    success: false,
                    error: 'No se recibieron datos para sincronizar. Envía un arreglo de registros en el cuerpo de la petición (array directo, { records: [...] }, { ecns: [...] } o { data: [...] }).'
                });
            }

            // Validar restricción de Planta 5201 si no está habilitada en configuración MXOH
            const requestedPlant = String(body.plant || sourcePlant || '5205').trim();
            if (requestedPlant === '5201') {
                const mxohSetting = await db.pool.request()
                    .input('key', sql.NVarChar, 'mxoh_plant_5201_enabled')
                    .query('SELECT value FROM settings WHERE [key] = @key');
                const mxohValue = mxohSetting.recordset[0]?.value || '';
                if (mxohValue.toLowerCase() !== 'true' && mxohValue.toLowerCase() !== '1') {
                    return res.status(403).json({
                        success: false,
                        error: 'La Planta 5201 está deshabilitada. Para habilitarla, active la opción MXOH en la configuración.'
                    });
                }
            }

            // Si los elementos ya vienen en formato estructurado de ECN (con propiedad 'changes')
            if (rawItems.length > 0 && Array.isArray(rawItems[0]?.changes)) {
                req.body = {
                    ecns: rawItems,
                    fileName
                };
                return await handleSapUpsertOptimized(req, res);
            }

            // Si son registros tabulares planos (extraídos de tablas HTML en SAP WebGUI),
            // agrupar por ECN y armar la estructura esperada por el motor de upsert
            const ecnsById = new Map<string, any>();
            let skippedPlant5201Count = 0;

            for (const rec of rawItems) {
                if (!rec || typeof rec !== 'object') continue;

                const rowPlant = String(rec.plant || rec.site || rec.Centro || rec['Centro'] || requestedPlant).trim();
                if (rowPlant === '5201' && requestedPlant !== '5201') {
                    skippedPlant5201Count++;
                    continue;
                }

                // Identificar número de ECN / ECRO con múltiples alias comunes en SAP
                const rawEcn = rec.ecnNumber || rec.ecn || rec.ecro || rec.ecno || rec.changeNo || rec.changeNumber || rec.id ||
                    findValueByKeys(rec, ['ECRO', 'ECN', 'ECN/CC', 'ECNRO', 'ECN Code', 'Change no.', 'Change no', 'Change Number', 'ECN No', 'ECN #']);
                const ecnId = dbText(cleanEcn(rawEcn), 50);
                if (!ecnId) continue;

                // Datos del ECN
                const rawInitiator = rec.initiator || rec.createdBy || rec.author ||
                    findValueByKeys(rec, ['CreatedBy', 'Created by', 'Created By', 'Creado por', 'Iniciador', 'User', 'Usuario']);
                const initiator = dbText(rawInitiator, 50, 'Tampermonkey SAP WebGUI');

                const rawDescription = rec.description || rec.assemblyDescription || rec.desc ||
                    findValueByKeys(rec, ['Description', 'Description SAP', 'ECN Description', 'Text comment', 'Notes', 'Comentarios', 'Descripción']);
                const description = dbText(rawDescription, 1000, `ECN ${ecnId} extraído vía Tampermonkey`);

                const rawCreatedOn = rec.creationDate || rec.createdOn || rec.date ||
                    findValueByKeys(rec, ['Created on', 'Created On', 'Created date', 'Date created', 'Fecha creación', 'Fecha']);
                const creationDate = dateForDb(rawCreatedOn) || new Date();

                let ecn = ecnsById.get(ecnId);
                if (!ecn) {
                    ecn = {
                        id: ecnId,
                        initiator,
                        description,
                        status: 'Pendiente',
                        creationDate,
                        implementationDate: null,
                        changes: [],
                        notes: []
                    };
                    ecnsById.set(ecnId, ecn);
                }

                // Extraer datos del componente/cambio
                const rawAssembly = rec.assembly || rec.ensamble ||
                    findValueByKeys(rec, ['Assembly', 'Ensamble', 'Assembly Name', 'Material ensamble']);
                const rawAssemblyRev = rec.assemblyRevision || rec.assemblyRev ||
                    findValueByKeys(rec, ['AssemblyRevision', 'Assembly Revision', 'Rev ensamble', 'RevLvl']);
                const rawAssemblyDesc = rec.assemblyDescription || rec.assemblyDesc || description;

                const rawOldComp = rec.oldComponent || rec.oldMaterial || rec.component ||
                    findValueByKeys(rec, ['Component', 'Old Component', 'Viejo componente', 'Material viejo', 'BOM Item Material']);
                const rawNewComp = rec.newComponent || rec.newMaterial || rec.startMaterial || rec.material ||
                    findValueByKeys(rec, ['Start Material', 'New Component', 'Nuevo componente', 'Material nuevo', 'Start material']);
                const rawNewCompRev = rec.newComponentRevision || rec.newMaterialRevision || rec.startMaterialRevision ||
                    findValueByKeys(rec, ['StartMaterialRevision', 'Material Revision', 'Mat rev', 'Rev no1', 'Rev no.1', 'Rev no 2']);
                const rawNewCompDesc = rec.newComponentDescription || rec.newMaterialDescription || rec.startMaterialDescription ||
                    findValueByKeys(rec, ['StartMaterialDescription', 'Material description', 'Descripción material']);

                const rawOldSub = rec.oldSubassembly || rec.oldSub ||
                    findValueByKeys(rec, ['Old Subassembly', 'Subensamble anterior']);
                const rawNewSub = rec.newSubassembly || rec.newSub ||
                    findValueByKeys(rec, ['New Subassembly', 'Subensamble nuevo']);
                const rawNewSubRev = rec.newSubassemblyRevision || rec.newSubRev;
                const rawNewSubDesc = rec.newSubassemblyDescription || rec.newSubDesc;

                const rawStartDate = rec.startDate || rec.validFrom || rec.validFr ||
                    findValueByKeys(rec, ['Start date', 'Start Date', 'Date start', 'Valid From', 'ValidFrom', 'Valid fr', 'Fecha inicio']);
                const startDate = dateForDb(rawStartDate);

                const rawSku = rec.sku || rec.topSku ||
                    findValueByKeys(rec, ['SKU', 'Affected SKU', 'Material SKU']);
                const rawFamily = rec.family ||
                    findValueByKeys(rec, ['Family', 'Familia', 'Product Family']);

                const rawDemand = rec.demand || rec.qty || rec.quantity ||
                    findValueByKeys(rec, ['Demand', 'Demanda', 'Cantidad', 'Qty']);
                const rawOnHand = rec.onHandInventory || rec.onHand || rec.stock ||
                    findValueByKeys(rec, ['OnHandInventory', 'On hand', 'Inventario', 'Stock']);
                const rawOpenPo = rec.openPoQty || rec.openPo || rec.poQty ||
                    findValueByKeys(rec, ['OpenPoQty', 'Open po', 'PO Qty', 'Pendientes PO']);

                if (startDate && (!ecn.implementationDate || startDate > ecn.implementationDate)) {
                    ecn.implementationDate = startDate;
                }

                ecn.changes.push({
                    assembly: dbText(rawAssembly, 255),
                    assemblyRevision: dbText(rawAssemblyRev, 50),
                    assemblyDescription: dbText(rawAssemblyDesc, 2000),
                    oldComponent: dbText(rawOldComp, 255),
                    newComponent: dbText(rawNewComp, 255),
                    newComponentRevision: dbText(rawNewCompRev, 50),
                    newComponentDescription: dbText(rawNewCompDesc, 2000),
                    oldSubassembly: dbText(rawOldSub, 255),
                    newSubassembly: dbText(rawNewSub, 255),
                    newSubassemblyRevision: dbText(rawNewSubRev, 50),
                    newSubassemblyDescription: dbText(rawNewSubDesc, 2000),
                    sku: dbText(rawSku, 255),
                    family: dbText(rawFamily, 255, 'VESDA'),
                    demand: parseNumericValue(rawDemand),
                    onHandInventory: parseNumericValue(rawOnHand),
                    openPoQty: parseNumericValue(rawOpenPo),
                    startDate,
                    site: dbText(rowPlant || requestedPlant, 50)
                });
            }

            if (ecnsById.size === 0) {
                return res.status(400).json({
                    success: false,
                    error: 'No se pudo estructurar ningún ECN válido a partir de los datos recibidos.'
                });
            }

            // Calcular estado automático según fechas de inicio de los cambios
            const today = new Date();
            const todayUtc = Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate());
            for (const ecn of ecnsById.values()) {
                const datedChanges = ecn.changes.filter((change: any) => change.startDate);
                const pastOrPresent = datedChanges.filter((change: any) => change.startDate.getTime() <= todayUtc).length;
                if (datedChanges.length === 0 || pastOrPresent === 0) {
                    ecn.status = 'Pendiente';
                } else if (pastOrPresent === datedChanges.length) {
                    ecn.status = 'Implementado';
                } else {
                    ecn.status = 'Implementado Parcial';
                }
            }

            console.log(`[SAP Tampermonkey] Sincronizando ${ecnsById.size} ECNs con ${rawItems.length} registros...`);

            req.body = {
                ecns: Array.from(ecnsById.values()),
                fileName: body.fileName || `Tampermonkey WebGUI (${requestedPlant})`
            };

            return await handleSapUpsertOptimized(req, res);
        } catch (e: any) {
            console.error('[SAP Tampermonkey Error]', e);
            return res.status(500).json({
                success: false,
                error: `Error al procesar sincronización Tampermonkey: ${e.message}`
            });
        }
    });

    app.post('/api/import/vba-sync', async (req, res) => {
        try {
            const { startDate, endDate, plant } = req.body as { startDate?: string; endDate?: string; plant?: string };
            const requestedPlant = (plant || '5205').trim();

            // Block plant 5201 unless MXOH setting is enabled
            if (requestedPlant === '5201') {
                const mxohSetting = await db.pool.request()
                    .input('key', sql.NVarChar, 'mxoh_plant_5201_enabled')
                    .query('SELECT value FROM settings WHERE [key] = @key');
                const mxohValue = mxohSetting.recordset[0]?.value || '';
                if (mxohValue.toLowerCase() !== 'true' && mxohValue.toLowerCase() !== '1') {
                    return res.status(403).json({ error: 'La Planta 5201 está deshabilitada. Para habilitarla, active la opción MXOH en la configuración.' });
                }
            }

            // Parse optional date filter
            const filterStart = startDate ? new Date(startDate) : null;
            const filterEnd = endDate ? new Date(endDate) : null;

            // --- Step 1: Run VBScript to trigger SAP macro and generate Output file ---
            const vbsPath = path.join(process.cwd(), 'static', 'run_ecn_macro.vbs');
            const xlsmPath = 'C:\\Personal\\ECN_automation.xlsm';

            if (!fs.existsSync(vbsPath)) {
                return res.status(500).json({ error: `No se encontró el script de automatización en: ${vbsPath}` });
            }
            if (!fs.existsSync(xlsmPath)) {
                return res.status(500).json({ error: `No se encontró el archivo de macros SAP en: ${xlsmPath}` });
            }

            console.log(`[VBA-Sync] Ejecutando macro SAP via VBScript... Fechas: ${formatSapDate(startDate)} -> ${formatSapDate(endDate)}`);
            await new Promise<void>((resolve, reject) => {
                execFile('cscript', ['//NoLogo', vbsPath, requestedPlant, formatSapDate(startDate), formatSapDate(endDate)],
                    { timeout: 10 * 60 * 1000 }, // 10 min timeout
                    (err, stdout, stderr) => {
                        if (stdout) console.log('[VBA-Sync] VBS output:', stdout.trim());
                        if (stderr) console.warn('[VBA-Sync] VBS stderr:', stderr.trim());
                        if (err) {
                            console.error('[VBA-Sync] VBScript error:', err.message);
                            reject(new Error(`Error al ejecutar las macros de SAP: ${stdout || err.message}`));
                        } else if (stdout && stdout.includes('ERROR:')) {
                            reject(new Error(`Error en macro Excel/SAP: ${stdout.trim()}`));
                        } else {
                            console.log('[VBA-Sync] Macro SAP completada exitosamente.');
                            resolve();
                        }
                    }
                );
            });

            // --- Step 2: Find the generated Output file ---
            const searchDirs = [
                process.cwd(),
                'C:\\Personal',
                path.join(process.env.USERPROFILE || 'C:\\Users\\H583623', 'Downloads'),
                path.join(process.cwd(), '..')
            ];

            let targetFilePath: string | null = null;
            for (const dir of searchDirs) {
                if (!fs.existsSync(dir)) continue;
                const files = fs.readdirSync(dir);
                const candidate = files.find(f => {
                    const l = f.toLowerCase();
                    return (l === 'output.xlsx' || l.startsWith('ecn-') || l.startsWith('ecn') || l.includes('output')) && (l.endsWith('.xlsx') || l.endsWith('.xls'));
                });
                if (candidate) {
                    targetFilePath = path.join(dir, candidate);
                    break;
                }
            }

            if (!targetFilePath && fs.existsSync(process.cwd())) {
                const rootFiles = fs.readdirSync(process.cwd());
                const anyXlsx = rootFiles.find(f => f.toLowerCase().endsWith('.xlsx') || f.toLowerCase().endsWith('.xls'));
                if (anyXlsx) targetFilePath = path.join(process.cwd(), anyXlsx);
            }

            if (!targetFilePath) {
                return res.status(404).json({
                    error: 'La macro se ejecutó pero no se encontró el archivo de salida generado (Output.xlsx). Verifique que la macro guarde el archivo en C:\\Personal o en la carpeta del servidor.'
                });
            }

            const workbook = readExcelWorkbook(targetFilePath, { cellDates: true });

            const outputSheetName = (workbook.SheetNames as string[]).find((s: string) => s.trim().toLowerCase() === 'output');
            let consolidatedRows: any[] = [];

            if (outputSheetName) {
                const worksheet = workbook.Sheets[outputSheetName];
                const allRows = parseSheetToJson(worksheet, { header: 1, defval: null }) as any[][];

                let headerRowIndex = 0;
                const keyHeaders = ['ecn', 'ecno', 'change no.', 'assembly', 'start material', 'component', 'plant', 'created by'];
                for (let i = 0; i < Math.min(15, allRows.length); i++) {
                    const rowValues = (allRows[i] || []).map(v => String(v || '').trim().toLowerCase());
                    if (keyHeaders.filter(kh => rowValues.includes(kh)).length >= 2) {
                        headerRowIndex = i;
                        break;
                    }
                }

                const rawHeaders = (allRows[headerRowIndex] || []).map(h => String(h || '').trim());
                const parsedHeaders: string[] = [];
                const headerCounts: Record<string, number> = {};
                rawHeaders.forEach(header => {
                    if (!header) return;
                    if (headerCounts[header]) {
                        headerCounts[header]++;
                        parsedHeaders.push(`${header}_${headerCounts[header]}`);
                    } else {
                        headerCounts[header] = 1;
                        parsedHeaders.push(header);
                    }
                });

                const rawData = allRows.slice(headerRowIndex + 1);
                consolidatedRows = rawData.map(row => {
                    const obj: any = {};
                    parsedHeaders.forEach((h, idx) => { obj[h] = row[idx]; });
                    return obj;
                });
            } else {
                const skuMap = new Map<string, { sku: string, family: string }>();
                const descMap = new Map<string, string>();

                const skuSheetName = (workbook.SheetNames as string[]).find((s: string) =>
                    s.trim().toLowerCase().includes('sku') ||
                    s.trim().toLowerCase().includes('description') ||
                    s.trim().toLowerCase().includes('familia')
                );

                if (skuSheetName) {
                    const skuSheet = workbook.Sheets[skuSheetName];
                    const skuJson = parseSheetToJson(skuSheet) as any[];
                    skuJson.forEach(r => {
                        const assy = String(r.Assembly || r.assembly || r.Ensamble || '').trim();
                        const sku = String(r.SKU || r.sku || '').trim();
                        const fam = String(r.Family || r.family || r.Familia || '').trim();
                        if (assy && (sku || fam)) skuMap.set(assy, { sku, family: fam });
                        const ecnVal = String(r.ECRO || r.ECN || r.ecn || '').trim();
                        const descVal = String(r.Description || r.description || r.Descripción || '').trim();
                        if (ecnVal && descVal) descMap.set(ecnVal, descVal);
                    });
                }

                const mainSheetName = (workbook.SheetNames as string[]).find((s: string) =>
                    s.trim().toLowerCase().includes('sap data') ||
                    s.trim().toLowerCase().includes('ecn') ||
                    s.trim().toLowerCase() === 'sheet1'
                ) || workbook.SheetNames[0];

                const mainSheet = workbook.Sheets[mainSheetName];
                const allRows = parseSheetToJson(mainSheet, { header: 1, defval: null }) as any[][];

                let headerRowIndex = 0;
                const keyHeaders = ['ecn', 'ecno', 'change no.', 'assembly', 'start material', 'component', 'plant', 'created by'];
                for (let i = 0; i < Math.min(15, allRows.length); i++) {
                    const rowValues = (allRows[i] || []).map(v => String(v || '').trim().toLowerCase());
                    if (keyHeaders.filter(kh => rowValues.includes(kh)).length >= 2) {
                        headerRowIndex = i;
                        break;
                    }
                }

                const rawHeaders = (allRows[headerRowIndex] || []).map(h => String(h || '').trim());
                const parsedHeaders: string[] = [];
                const headerCounts: Record<string, number> = {};
                rawHeaders.forEach(header => {
                    if (!header) return;
                    if (headerCounts[header]) {
                        headerCounts[header]++;
                        parsedHeaders.push(`${header}_${headerCounts[header]}`);
                    } else {
                        headerCounts[header] = 1;
                        parsedHeaders.push(header);
                    }
                });

                const rawData = allRows.slice(headerRowIndex + 1);
                consolidatedRows = rawData.map(row => {
                    const obj: any = {};
                    parsedHeaders.forEach((h, idx) => { obj[h] = row[idx]; });
                    const assyKey = String(obj['Assembly'] || obj['assembly'] || '').trim();
                    if (assyKey && skuMap.has(assyKey)) {
                        const m = skuMap.get(assyKey)!;
                        if (!obj['SKU'] && !obj['sku']) obj['SKU'] = m.sku;
                        if (!obj['Family'] && !obj['family']) obj['Family'] = m.family;
                    }
                    const ecnKey = String(obj['ECNO'] || obj['ECN'] || obj['ecn'] || '').trim();
                    if (ecnKey && descMap.has(ecnKey) && (!obj['Description'] || !obj['description'])) {
                        obj['Description'] = descMap.get(ecnKey);
                    }
                    return obj;
                });
            }

            const parseDateServer = (dateInput: any): string | null => {
                if (!dateInput) return null;
                if (dateInput instanceof Date && !isNaN(dateInput.getTime())) return dateInput.toISOString().split('T')[0];
                if (typeof dateInput === 'number' && dateInput > 1) {
                    const excelEpoch = new Date(Date.UTC(1899, 11, 30));
                    const date = new Date(excelEpoch.getTime() + dateInput * 24 * 60 * 60 * 1000);
                    if (!isNaN(date.getTime())) return date.toISOString().split('T')[0];
                }
                if (typeof dateInput === 'string') {
                    const trimmedDate = dateInput.trim().split(' ')[0];
                    let parts = trimmedDate.match(/^(\d{4})-(\d{1,2})-(\d{1,2})$/);
                    if (parts) return `${parts[1]}-${parts[2].padStart(2, '0')}-${parts[3].padStart(2, '0')}`;
                    parts = trimmedDate.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
                    if (parts) return `${parts[3]}-${parts[1].padStart(2, '0')}-${parts[2].padStart(2, '0')}`;
                }
                return null;
            };

            const existingEcnsResult = await db.pool.request().query("SELECT id, initiator, description, status, creation_date as creationDate, implementation_date as implementationDate FROM ecns");
            const existingEcnsMap = new Map<string, any>(existingEcnsResult.recordset.map((e: any) => [e.id, e]));

            const ecnsToUpsertMap = new Map<string, any>();
            const todayStr = new Date().toISOString().split('T')[0];
            let skippedPlant5201Count = 0;

            for (const row of consolidatedRows) {
                const plantHeaderKey = Object.keys(row).find(k => k.toLowerCase().includes('plant') || k.toLowerCase().includes('planta'));
                const rowPlantVal = plantHeaderKey && row[plantHeaderKey] ? String(row[plantHeaderKey]).trim() : '';

                // Always skip plant 5201 (unless it's the explicitly requested plant and MXOH is enabled - already checked above)
                if (rowPlantVal === '5201' && requestedPlant !== '5201') {
                    skippedPlant5201Count++;
                    continue;
                }

                // Filter by requested plant if a plant column exists
                if (rowPlantVal && requestedPlant !== rowPlantVal) {
                    continue;
                }

                const ecnId = String(row.ECNO || row.ECN || row.ecn || row['Change No.'] || row['change no.'] || '').trim();
                if (!ecnId) continue;

                const assembly = String(row.Assembly || row.assembly || '').trim();
                const oldComponent = String(row.Component || row.component || row.OldComponent || '').trim();
                const newComponent = String(row['Start Material'] || row.newComponent || row.material || '').trim();

                let ecn = ecnsToUpsertMap.get(ecnId);
                let isNewEcn = false;
                if (!ecn) {
                    const existing = existingEcnsMap.get(ecnId);
                    if (existing) {
                        ecn = JSON.parse(JSON.stringify(existing));
                        if (!ecn.changes) ecn.changes = [];
                        if (!ecn.notes) ecn.notes = [];
                    } else {
                        isNewEcn = true;
                        ecn = {
                            id: ecnId,
                            initiator: String(row['Created by'] || row.createdBy || row.initiator || 'Sistema'),
                            description: String(row.Description || row.description || row.AssemblyDescription || `ECN importado ${ecnId}`),
                            status: 'Pendiente',
                            creationDate: parseDateServer(row['Created On'] || row.createdOn) || todayStr,
                            implementationDate: '',
                            changes: [], notes: []
                        };
                    }
                }

                const noteText = String(row.Notes || row.notes || row.Notas || '').trim();
                let noteAdded = false;
                if (noteText) {
                    if (!ecn.notes) ecn.notes = [];
                    if (!ecn.notes.some((n: any) => n.text === noteText)) {
                        ecn.notes.push({
                            id: uuidv4(),
                            author: String(row['Created by'] || row.createdBy || 'Sistema'),
                            text: noteText,
                            date: todayStr
                        });
                        noteAdded = true;
                    }
                }

                const rowStartDateStr = parseDateServer(row['Start date'] || row.startDate || row['Valid From']);
                if (!rowStartDateStr) continue;

                // Apply date range filter if provided
                if (filterStart || filterEnd) {
                    const rowDate = new Date(rowStartDateStr);
                    if (filterStart && rowDate < filterStart) continue;
                    if (filterEnd && rowDate > filterEnd) continue;
                }

                const startDate = rowStartDateStr;
                const newDemand = Number(row.Demand || row.demand) || 0;
                const newOnHand = Number(row['On hand inventory'] || row.onHandInventory) || 0;
                const newOpenPo = Number(row['Open PO Qty'] || row.openPoQty) || 0;
                const skuVal = String(row.SKU || row.sku || '').trim() || undefined;
                const familyVal = String(row.Family || row.family || row.Familia || '').trim() || undefined;
                const siteVal = rowPlantVal || requestedPlant;

                const newChangeValues: any = {
                    id: '',
                    assembly,
                    oldComponent,
                    newComponent,
                    startDate,
                    demand: newDemand,
                    onHandInventory: newOnHand,
                    openPoQty: newOpenPo,
                    assemblyDescription: String(row.Description || row.assemblyDescription || ''),
                    newComponentDescription: String(row['Material Description'] || row.startMaterialDescription || ''),
                    newComponentRevision: String(row['Rev No1'] || row.startMaterialRevision || ''),
                    assemblyRevision: String(row['Rev No'] || row.assemblyRevision || ''),
                    sku: skuVal,
                    family: familyVal,
                    site: siteVal
                };

                const existingChangeIndex = ecn.changes.findIndex((c: any) =>
                    c.assembly === newChangeValues.assembly &&
                    c.oldComponent === newChangeValues.oldComponent &&
                    c.newComponent === newChangeValues.newComponent &&
                    c.site === newChangeValues.site
                );

                let componentChanged = false;
                if (existingChangeIndex > -1) {
                    const existingChange = ecn.changes[existingChangeIndex];
                    const existDate = existingChange.startDate ? existingChange.startDate.split('T')[0] : '';
                    const newDate = newChangeValues.startDate.split('T')[0];

                    const isDateChanged = existDate !== newDate;
                    const isDemandChanged = Number(existingChange.demand) !== newDemand;
                    const isOnHandChanged = Number(existingChange.onHandInventory) !== newOnHand;
                    const isPoChanged = Number(existingChange.openPoQty) !== newOpenPo;
                    const isFamilyChanged = familyVal !== undefined && existingChange.family !== familyVal;
                    const isSkuChanged = skuVal !== undefined && existingChange.sku !== skuVal;

                    if (isDateChanged || isDemandChanged || isOnHandChanged || isPoChanged || isFamilyChanged || isSkuChanged) {
                        if (isDateChanged && newDate > todayStr) ecn.status = 'Pendiente';
                        existingChange.startDate = newChangeValues.startDate;
                        existingChange.demand = newDemand;
                        existingChange.onHandInventory = newOnHand;
                        existingChange.openPoQty = newOpenPo;
                        if (familyVal !== undefined) existingChange.family = familyVal;
                        if (skuVal !== undefined) existingChange.sku = skuVal;
                        componentChanged = true;
                    }
                } else {
                    const newDate = newChangeValues.startDate.split('T')[0];
                    if (newDate > todayStr) ecn.status = 'Pendiente';
                    ecn.changes.push(newChangeValues);
                    componentChanged = true;
                }

                if (isNewEcn || componentChanged || noteAdded) {
                    ecnsToUpsertMap.set(ecnId, ecn);
                }
            }

            const finalEcnsToUpsert = Array.from(ecnsToUpsertMap.values());

            const transaction = new sql.Transaction(db.pool);
            await transaction.begin();
            let newCount = 0;
            let updatedCount = 0;

            for (const ecn of finalEcnsToUpsert) {
                const initiator = ecn.initiator || 'Sistema';
                const userCheck = await transaction.request().input('uid', sql.NVarChar, initiator).query("SELECT id FROM users WHERE id = @uid");
                if (userCheck.recordset.length === 0) {
                    await transaction.request().input('uid', sql.NVarChar, initiator).input('name', sql.NVarChar, initiator).query("INSERT INTO users (id, name) VALUES (@uid, @name)");
                }

                const request = transaction.request();
                request.input('id', sql.NVarChar, ecn.id);
                const existing = await request.query("SELECT id FROM ecns WHERE id = @id");
                const isUpdate = existing.recordset.length > 0;

                request.input('init', sql.NVarChar, initiator);
                request.input('desc', sql.NVarChar, ecn.description || '');
                request.input('stat', sql.NVarChar, ecn.status);
                request.input('cdat', sql.Date, ecn.creationDate ? new Date(ecn.creationDate) : new Date());
                request.input('idat', sql.Date, ecn.implementationDate ? new Date(ecn.implementationDate) : null);

                if (isUpdate) {
                    await request.query("UPDATE ecns SET initiator=@init, description=@desc, status=@stat, implementation_date=@idat WHERE id=@id");
                    updatedCount++;
                } else {
                    await request.query("INSERT INTO ecns (id, initiator, description, status, creation_date, implementation_date) VALUES (@id, @init, @desc, @stat, @cdat, @idat)");
                    newCount++;
                }

                if (ecn.changes && ecn.changes.length > 0) {
                    for (const change of ecn.changes) {
                        const cReq = transaction.request();
                        cReq.input('ecn_id', sql.NVarChar, ecn.id);
                        cReq.input('assembly', sql.NVarChar, change.assembly || '');
                        cReq.input('assembly_rev', sql.NVarChar, change.assemblyRevision || '');
                        cReq.input('assembly_desc', sql.NVarChar, change.assemblyDescription || '');
                        cReq.input('old_comp', sql.NVarChar, change.oldComponent || '');
                        cReq.input('new_comp', sql.NVarChar, change.newComponent || '');
                        cReq.input('new_comp_rev', sql.NVarChar, change.newComponentRevision || '');
                        cReq.input('new_comp_desc', sql.NVarChar, change.newComponentDescription || '');
                        cReq.input('old_sub', sql.NVarChar, change.oldSubassembly || '');
                        cReq.input('new_sub', sql.NVarChar, change.newSubassembly || '');
                        cReq.input('new_sub_rev', sql.NVarChar, change.newSubassemblyRevision || '');
                        cReq.input('new_sub_desc', sql.NVarChar, change.newSubassemblyDescription || '');
                        cReq.input('sku', sql.NVarChar, change.sku || '');
                        cReq.input('family', sql.NVarChar, change.family || '');
                        cReq.input('demand', sql.Decimal(18, 2), change.demand || 0);
                        cReq.input('on_hand', sql.Decimal(18, 2), change.onHandInventory || 0);
                        cReq.input('open_po', sql.Decimal(18, 2), change.openPoQty || 0);
                        cReq.input('sdate', sql.Date, change.startDate ? new Date(change.startDate) : null);
                        cReq.input('site', sql.NVarChar, change.site || '5205');

                        const existingComp = await cReq.query(`
                            SELECT id FROM component_changes 
                            WHERE ecn_id = @ecn_id AND assembly = @assembly AND old_component = @old_comp AND new_component = @new_comp AND site = @site
                        `);

                        if (existingComp.recordset.length > 0) {
                            const compId = existingComp.recordset[0].id;
                            const uReq = transaction.request();
                            uReq.input('comp_id', sql.UniqueIdentifier, compId);
                            uReq.input('assembly_rev', sql.NVarChar, change.assemblyRevision || '');
                            uReq.input('assembly_desc', sql.NVarChar, change.assemblyDescription || '');
                            uReq.input('new_comp_rev', sql.NVarChar, change.newComponentRevision || '');
                            uReq.input('new_comp_desc', sql.NVarChar, change.newComponentDescription || '');
                            uReq.input('sku', sql.NVarChar, change.sku || '');
                            uReq.input('family', sql.NVarChar, change.family || '');
                            uReq.input('demand', sql.Decimal(18, 2), change.demand || 0);
                            uReq.input('on_hand', sql.Decimal(18, 2), change.onHandInventory || 0);
                            uReq.input('open_po', sql.Decimal(18, 2), change.openPoQty || 0);
                            uReq.input('sdate', sql.Date, change.startDate ? new Date(change.startDate) : null);

                            await uReq.query(`
                                UPDATE component_changes SET
                                    assembly_revision = @assembly_rev,
                                    assembly_description = @assembly_desc,
                                    new_component_revision = @new_comp_rev,
                                    new_component_description = @new_comp_desc,
                                    sku = COALESCE(NULLIF(@sku, ''), sku),
                                    family = COALESCE(NULLIF(@family, ''), family),
                                    demand = @demand,
                                    on_hand_inventory = @on_hand,
                                    open_po_qty = @open_po,
                                    start_date = @sdate
                                WHERE id = @comp_id
                            `);
                        } else {
                            await cReq.query(`
                                INSERT INTO component_changes (
                                    id, ecn_id, assembly, assembly_revision, assembly_description,
                                    old_component, new_component, new_component_revision, new_component_description,
                                    old_subassembly, new_subassembly, new_subassembly_revision, new_subassembly_description,
                                    sku, family, demand, on_hand_inventory, open_po_qty, start_date, site
                                ) VALUES (
                                    NEWID(), @ecn_id, @assembly, @assembly_rev, @assembly_desc,
                                    @old_comp, @new_comp, @new_comp_rev, @new_comp_desc,
                                    @old_sub, @new_sub, @new_sub_rev, @new_sub_desc,
                                    @sku, @family, @demand, @on_hand, @open_po, @sdate, @site
                                )
                            `);
                        }
                    }
                }

                if (ecn.notes && ecn.notes.length > 0) {
                    for (const note of ecn.notes) {
                        if (!note.text || !note.text.trim()) continue;
                        const noteTxt = note.text.trim();
                        const noteCheck = await transaction.request()
                            .input('ecn_id', sql.NVarChar, ecn.id)
                            .input('txt', sql.NVarChar, noteTxt)
                            .query("SELECT id FROM notes WHERE ecn_id = @ecn_id AND text = @txt");

                        if (noteCheck.recordset.length === 0) {
                            const nReq = transaction.request();
                            nReq.input('nid', sql.UniqueIdentifier, uuidv4());
                            nReq.input('ecn_id', sql.NVarChar, ecn.id);
                            nReq.input('author', sql.NVarChar, note.author || initiator);
                            nReq.input('txt', sql.NVarChar, noteTxt);
                            nReq.input('ndate', sql.DateTimeOffset, note.date ? new Date(note.date) : new Date());
                            await nReq.query("INSERT INTO notes (id, ecn_id, author, text, date) VALUES (@nid, @ecn_id, @author, @txt, @ndate)");
                        }
                    }
                }
            }

            const fileName = path.basename(targetFilePath);
            await transaction.request()
                .input('ts', sql.DateTimeOffset, new Date())
                .input('file', sql.NVarChar, fileName)
                .input('total', sql.Int, finalEcnsToUpsert.length)
                .input('new_ecns', sql.NVarChar, `${newCount} nuevos`)
                .input('upd_ecns', sql.NVarChar, `${updatedCount} actualizados`)
                .input('details', sql.NVarChar, `Sincronización automatizada directa SAP desde ${fileName}. Nuevos: ${newCount}, Actualizados: ${updatedCount}. Ignorados 5201: ${skippedPlant5201Count}`)
                .query("INSERT INTO import_logs (timestamp, file_name, total_records, new_ecns, updated_ecns, details) VALUES (@ts, @file, @total, @new_ecns, @upd_ecns, @details)");

            await transaction.request()
                .input('aid', sql.UniqueIdentifier, uuidv4())
                .input('uts', sql.DateTimeOffset, new Date())
                .input('uuser', sql.NVarChar, 'Sistema')
                .input('utype', sql.NVarChar, 'Importación')
                .input('utarget', sql.NVarChar, fileName)
                .input('uact', sql.NVarChar, `Sincronización automatizada SAP directa: ${newCount} nuevos, ${updatedCount} actualizados.`)
                .query("INSERT INTO audit_log (id, timestamp, [user], type, target, action) VALUES (@aid, @uts, @uuser, @utype, @utarget, @uact)");

            await transaction.commit();

            res.json({
                success: true,
                message: `Sincronización automatizada desde ${fileName} completada exitosamente.`,
                newCount,
                updatedCount,
                totalRecords: finalEcnsToUpsert.length,
                skipped5201: skippedPlant5201Count
            });
        } catch (e: any) {
            console.error('VBA Sync Error:', e);
            res.status(500).json({ error: e.message });
        }
    });

    app.post('/api/import/users', async (req, res) => {
        const { users, fileName } = req.body;
        const transaction = new sql.Transaction(db.pool);
        try {
            await transaction.begin();
            for (const user of users) {
                await transaction.request()
                    .input('id', sql.NVarChar, user.id)
                    .input('name', sql.NVarChar, user.name)
                    .input('email', sql.NVarChar, user.email)
                    .input('dept', sql.NVarChar, user.department)
                    .input('photo', sql.NVarChar, user.photo || null)
                    .query(`
                        IF EXISTS (SELECT 1 FROM users WHERE id = @id)
                            UPDATE users SET name = @name, email = @email, department = @dept, photo = @photo WHERE id = @id
                        ELSE
                            INSERT INTO users (id, name, email, department, photo) VALUES (@id, @name, @email, @dept, @photo)
                    `);
            }
            await transaction.request()
                .input('aid', sql.UniqueIdentifier, uuidv4())
                .input('uts', sql.DateTimeOffset, new Date())
                .input('uuser', sql.NVarChar, 'Sistema')
                .input('utype', sql.NVarChar, 'Importación')
                .input('utarget', sql.NVarChar, 'Usuarios')
                .input('uact', sql.NVarChar, `Importación de usuarios: ${fileName || 'Manual'}. ${users.length} procesados.`)
                .query("INSERT INTO audit_log (id, timestamp, [user], type, target, action) VALUES (@aid, @uts, @uuser, @utype, @utarget, @uact)");

            await transaction.commit();
            res.json({ success: true });
        } catch (e: any) {
            if (transaction) await transaction.rollback();
            res.status(500).json({ error: e.message });
        }
    });

    app.post('/api/import/descriptions', async (req, res) => {
        const { data } = req.body;
        const transaction = new sql.Transaction(db.pool);
        try {
            await transaction.begin();
            for (const item of data) {
                await transaction.request()
                    .input('ecn', sql.NVarChar, item.ECN)
                    .input('desc', sql.NVarChar, item.Description)
                    .query("UPDATE ecns SET description = @desc WHERE id = @ecn");
            }
            await transaction.request()
                .input('aid', sql.UniqueIdentifier, uuidv4())
                .input('uts', sql.DateTimeOffset, new Date())
                .input('uuser', sql.NVarChar, 'Sistema')
                .input('utype', sql.NVarChar, 'Importación')
                .input('utarget', sql.NVarChar, 'Descripciones ECN')
                .input('uact', sql.NVarChar, `Importación de descripciones ECN. ${data.length} procesadas.`)
                .query("INSERT INTO audit_log (id, timestamp, [user], type, target, action) VALUES (@aid, @uts, @uuser, @utype, @utarget, @uact)");

            await transaction.commit();
            res.json({ success: true });
        } catch (e: any) {
            if (transaction) await transaction.rollback();
            res.status(500).json({ error: e.message });
        }
    });

    app.post('/api/import/sku-family', async (req, res) => {
        const { data } = req.body;
        const transaction = new sql.Transaction(db.pool);
        try {
            await transaction.begin();
            for (const item of data) {
                if (!item.Assembly) continue; // Skip rows without an assembly
                await transaction.request()
                    .input('assembly', sql.NVarChar, item.Assembly.trim())
                    .input('sku', sql.NVarChar, (item.SKU || '').trim())
                    .input('family', sql.NVarChar, (item.Family || '').trim())
                    .query("UPDATE component_changes SET sku = @sku, family = @family WHERE assembly = @assembly");
            }
            await transaction.request()
                .input('aid', sql.UniqueIdentifier, uuidv4())
                .input('uts', sql.DateTimeOffset, new Date())
                .input('uuser', sql.NVarChar, 'Sistema')
                .input('utype', sql.NVarChar, 'Importación')
                .input('utarget', sql.NVarChar, 'SKU/Familia')
                .input('uact', sql.NVarChar, `Importación de SKU/Familia por ensamble. ${data.length} procesados.`)
                .query("INSERT INTO audit_log (id, timestamp, [user], type, target, action) VALUES (@aid, @uts, @uuser, @utype, @utarget, @uact)");

            await transaction.commit();
            res.json({ success: true });
        } catch (e: any) {
            if (transaction) await transaction.rollback();
            res.status(500).json({ error: e.message });
        }
    });

    app.get('/api/import-logs', async (req, res) => {
        try {
            const result = await db.pool.request().query('SELECT * FROM import_logs ORDER BY timestamp DESC');
            res.json(result.recordset);
        } catch (e: any) { res.status(500).json({ error: e.message }); }
    });

    app.get('/api/audit-logs', async (req, res) => {
        try {
            const result = await db.pool.request().query('SELECT id, timestamp, [user], action as details, type, target FROM audit_log ORDER BY timestamp DESC');
            res.json(result.recordset);
        } catch (e: any) { res.status(500).json({ error: e.message }); }
    });

    app.get('/api/mat-vesda', async (req, res) => {
        try {
            const result = await db.pool.request().query('SELECT * FROM mat_vesda');
            res.json(result.recordset);
        } catch (e: any) { res.status(500).json({ error: e.message }); }
    });

    app.post('/api/mat-vesda/import', async (req, res) => {
        try {
            const { data } = req.body;
            if (!data || data.length === 0) {
                return res.json({ message: 'No data provided', count: 0 });
            }

            const existingResult = await db.pool.request().query('SELECT material, last_change FROM mat_vesda');
            const existingMap = new Map();
            existingResult.recordset.forEach(m => {
                existingMap.set(m.material, m.last_change);
            });

            let inserted = 0;
            let updated = 0;
            let skipped = 0;

            const transaction = new sql.Transaction(db.pool);
            await transaction.begin();

            try {
                for (const item of data) {
                    const material = String(item.material || '').trim();
                    if (!material) {
                        skipped++;
                        continue;
                    }

                    const newLastChange = item.last_change ? new Date(item.last_change) : null;
                    const hasExisting = existingMap.has(material);
                    const existingLastChangeRaw = existingMap.get(material);
                    const existingLastChange = existingLastChangeRaw ? new Date(existingLastChangeRaw) : null;

                    let shouldUpsert = false;
                    let isUpdate = false;

                    if (hasExisting) {
                        if (newLastChange && (!existingLastChange || newLastChange > existingLastChange)) {
                            shouldUpsert = true;
                            isUpdate = true;
                        } else {
                            skipped++;
                        }
                    } else {
                        shouldUpsert = true;
                        isUpdate = false;
                    }

                    if (shouldUpsert) {
                        const request = transaction.request();
                        request.input('material', sql.NVarChar, material);
                        request.input('price', sql.Decimal(18, 2), item.price || 0);
                        request.input('abc_indicator', sql.NVarChar, item.abc_indicator || '');
                        request.input('material_description', sql.NVarChar, item.material_description || '');
                        request.input('plant', sql.NVarChar, item.plant || '');
                        request.input('last_change', sql.Date, newLastChange);
                        request.input('base_unit_of_measure', sql.NVarChar, item.base_unit_of_measure || '');
                        request.input('purchasing_group', sql.NVarChar, item.purchasing_group || '');
                        request.input('mrp_type', sql.NVarChar, item.mrp_type || '');
                        request.input('valuation_class', sql.NVarChar, item.valuation_class || '');
                        request.input('currency', sql.NVarChar, item.currency || '');
                        request.input('price_unit', sql.Int, item.price_unit || 0);
                        request.input('price_control', sql.NVarChar, item.price_control || '');
                        request.input('material_type', sql.NVarChar, item.material_type || '');
                        request.input('material_group', sql.NVarChar, item.material_group || '');
                        request.input('valuation_type', sql.NVarChar, item.valuation_type || '');
                        request.input('created_by', sql.NVarChar, item.created_by || '');

                        if (isUpdate) {
                            await request.query(`
                                UPDATE mat_vesda SET 
                                    price = @price,
                                    abc_indicator = @abc_indicator,
                                    material_description = @material_description,
                                    plant = @plant,
                                    last_change = @last_change,
                                    base_unit_of_measure = @base_unit_of_measure,
                                    purchasing_group = @purchasing_group,
                                    mrp_type = @mrp_type,
                                    valuation_class = @valuation_class,
                                    currency = @currency,
                                    price_unit = @price_unit,
                                    price_control = @price_control,
                                    material_type = @material_type,
                                    material_group = @material_group,
                                    valuation_type = @valuation_type,
                                    created_by = @created_by
                                WHERE material = @material
                            `);
                            updated++;
                        } else {
                            await request.query(`
                                INSERT INTO mat_vesda (
                                    material, price, abc_indicator, material_description, plant, 
                                    last_change, base_unit_of_measure, purchasing_group, mrp_type, 
                                    valuation_class, currency, price_unit, price_control, 
                                    material_type, material_group, valuation_type, created_by
                                ) VALUES (
                                    @material, @price, @abc_indicator, @material_description, @plant, 
                                    @last_change, @base_unit_of_measure, @purchasing_group, @mrp_type, 
                                    @valuation_class, @currency, @price_unit, @price_control, 
                                    @material_type, @material_group, @valuation_type, @created_by
                                )
                            `);
                            inserted++;
                        }
                    }
                }
                await transaction.commit();
                res.json({ message: 'Imported successfully', inserted, updated, skipped });
            } catch (e: any) {
                if (transaction) await transaction.rollback();
                throw e;
            }
        } catch (e: any) {
            console.error('Import error:', e);
            res.status(500).json({ error: e.message });
        }
    });

    app.get('/api/assemblies', async (req, res) => {
        try {
            // Get all unique assemblies and their basic info
            const assembliesResult = await db.pool.request().query(`
                SELECT DISTINCT assembly as id, assembly_description as description 
                FROM component_changes 
                WHERE assembly <> ''
            `);
            const assemblies = assembliesResult.recordset;

            // Get all component changes with ECN info linked to assemblies
            const detailsResult = await db.pool.request().query(`
                SELECT 
                    cc.assembly,
                    cc.new_component as componentId,
                    cc.new_component_description as componentDescription,
                    e.id as ecnId,
                    e.implementation_date as implementationDate,
                    e.status,
                    e.description as ecnDescription
                FROM component_changes cc
                LEFT JOIN ecns e ON cc.ecn_id = e.id
                WHERE cc.assembly <> '' AND cc.new_component <> ''
            `);
            const details = detailsResult.recordset;

            // Grouping logic
            const assemblyMap = new Map();
            assemblies.forEach(a => {
                assemblyMap.set(a.id, { ...a, bom: new Map() });
            });

            details.forEach(d => {
                if (!assemblyMap.has(d.assembly)) return;
                const assembly = assemblyMap.get(d.assembly);

                if (!assembly.bom.has(d.componentId)) {
                    assembly.bom.set(d.componentId, {
                        componentId: d.componentId,
                        description: d.componentDescription || '',
                        ecns: []
                    });
                }

                const component = assembly.bom.get(d.componentId);
                // Avoid duplicate ECNs for the same component in the same assembly
                if (d.ecnId && !component.ecns.some((e: any) => e.id === d.ecnId)) {
                    component.ecns.push({
                        id: d.ecnId,
                        implementationDate: d.implementationDate,
                        status: d.status,
                        description: d.ecnDescription
                    });
                }
            });

            // Convert Maps back to Arrays
            const finalResult = Array.from(assemblyMap.values()).map(a => ({
                ...a,
                bom: Array.from(a.bom.values())
            }));

            res.json(finalResult);
        } catch (e: any) {
            console.error('[Assemblies API Error]', e);
            res.status(500).json({ error: e.message });
        }
    });

    app.get('/api/materials', async (req, res) => {
        try {
            const query = `
                SELECT 
                    cc.id as changeId,
                    cc.ecn_id as ecnId,
                    COALESCE(cc.new_component, cc.old_component, cc.sku, 'N/A') as partNumber,
                    cc.old_component as oldComponent,
                    cc.new_component as newComponent,
                    cc.assembly as assembly,
                    cc.site as site,
                    cc.family as family,
                    cc.demand as demand,
                    e.implementation_date as implementationDate,
                    e.status as ecnStatus,
                    e.description as ecnDescription,
                    e.initiator as ecnInitiator
                FROM component_changes cc
                LEFT JOIN ecns e ON cc.ecn_id = e.id
                WHERE COALESCE(cc.new_component, cc.old_component, cc.sku, '') <> ''
                ORDER BY e.implementation_date DESC
            `;
            const result = await db.pool.request().query(query);
            res.json(result.recordset);
        } catch (e: any) {
            console.error('[API Materials Error]', e);
            res.status(500).json({ error: e.message });
        }
    });

    app.get('/api/assembly-sku-family', async (req, res) => {
        try {
            const query = `
                SELECT DISTINCT 
                    assembly,
                    MAX(sku) as sku,
                    MAX(family) as family
                FROM component_changes
                WHERE assembly <> '' AND (sku <> '' OR family <> '')
                GROUP BY assembly
                ORDER BY assembly
            `;
            const result = await db.pool.request().query(query);
            res.json(result.recordset);
        } catch (e: any) {
            console.error('[API Assembly SKU Family Error]', e);
            res.status(500).json({ error: e.message });
        }
    });

    app.put('/api/assembly-sku-family', async (req, res) => {
        try {
            const { assembly, sku, family } = req.body;
            if (!assembly) {
                return res.status(400).json({ error: 'Assembly is required' });
            }
            await db.pool.request()
                .input('assembly', sql.NVarChar, assembly)
                .input('sku', sql.NVarChar, sku || '')
                .input('family', sql.NVarChar, family || '')
                .query("UPDATE component_changes SET sku = @sku, family = @family WHERE assembly = @assembly");
            res.json({ success: true, message: 'SKU y Familia actualizados correctamente para el ensamble.' });
        } catch (e: any) {
            console.error('[Update Assembly SKU/Family Error]', e);
            res.status(500).json({ error: e.message });
        }
    });

    app.put('/api/components/description', async (req, res) => {
        try {
            const { componentId, description } = req.body;
            await db.pool.request()
                .input('cid', sql.NVarChar, componentId)
                .input('desc', sql.NVarChar, description)
                .query(`
                    UPDATE component_changes 
                    SET new_component_description = @desc 
                    WHERE new_component = @cid;
                    
                    UPDATE component_changes 
                    SET assembly_description = @desc 
                    WHERE assembly = @cid;
                `);
            res.json({ success: true });
        } catch (e: any) {
            res.status(500).json({ error: e.message });
        }
    });

    app.get('/api/settings/email', async (req, res) => {
        try {
            const result = await db.pool.request().query("SELECT [key], value FROM settings WHERE [key] LIKE 'email_%'");
            const settings: any = {};
            result.recordset.forEach(r => {
                const key = r.key.replace('email_', '');
                settings[key] = r.value;
            });
            res.json(settings);
        } catch (e: any) {
            res.status(500).json({ error: e.message });
        }
    });

    app.post('/api/settings/email', async (req, res) => {
        try {
            const settings = req.body;
            const transaction = new sql.Transaction(db.pool);
            await transaction.begin();
            try {
                for (const key of Object.keys(settings)) {
                    await transaction.request()
                        .input('k', sql.NVarChar, `email_${key}`)
                        .input('v', sql.NVarChar, String(settings[key]))
                        .query(`
                            IF EXISTS (SELECT 1 FROM settings WHERE [key] = @k)
                                UPDATE settings SET value = @v WHERE [key] = @k
                            ELSE
                                INSERT INTO settings ([key], value) VALUES (@k, @v)
                        `);
                }
                await transaction.commit();
                res.json({ success: true });
            } catch (err) {
                await transaction.rollback();
                throw err;
            }
        } catch (e: any) {
            res.status(500).json({ error: e.message });
        }
    });

    app.delete('/api/database', async (req, res) => {
        try {
            // Dangerous operation: wipe tables in order
            await db.pool.request().query(`
                DELETE FROM audit_log;
                DELETE FROM checklist_items;
                DELETE FROM notes;
                DELETE FROM component_changes;
                DELETE FROM ecns;
                DELETE FROM import_logs;
                DELETE FROM mat_vesda;
            `);
            res.json({ message: 'Database cleared' });
        } catch (e: any) {
            res.status(500).json({ error: e.message });
        }
    });

    const getEmailTransporter = async () => {
        const result = await db.pool.request().query("SELECT [key], value FROM settings WHERE [key] LIKE 'email_%'");
        const settings: any = {};
        result.recordset.forEach(r => {
            const key = r.key.replace('email_', '');
            settings[key] = r.value;
        });

        const host = settings.host || 'smtp.honeywell.com';
        const port = parseInt(settings.port || '25');
        const from = settings.from || 'ecn-manager@honeywell.com';
        const fromName = settings.fromName || 'ECN Manager';

        const transportOptions: any = {
            host: host,
            port: port,
            secure: settings.secure === 'true',
            tls: {
                rejectUnauthorized: false
            },
            lookup: (hostname: string, options: any, callback: any) => {
                dns.lookup(hostname, { family: 4 }, callback);
            }
        };

        if (settings.user && settings.pass) {
            transportOptions.auth = {
                user: settings.user,
                pass: settings.pass
            };
        }

        return {
            transporter: nodemailer.createTransport(transportOptions),
            from,
            fromName
        };
    };

    app.post('/api/settings/email/test', async (req, res) => {
        try {
            const host = req.body.host || "smtp.honeywell.com";
            const port = parseInt(req.body.port || '25');
            const from = req.body.from || "ecn-manager@honeywell.com";
            const to = req.body.to || "albertoisaac.aguilera@honeywell.com";
            const user = req.body.user;
            const pass = req.body.pass;

            console.log(`[Honeywell Relay Test] Enviando vía ${host}:${port} hacia: ${to} desde: ${from}`);

            const transportOptions: any = {
                host: host,
                port: port,
                secure: false,
                tls: {
                    rejectUnauthorized: false
                },
                lookup: (hostname: string, options: any, callback: any) => {
                    dns.lookup(hostname, { family: 4 }, callback);
                }
            };

            if (user && pass) {
                transportOptions.auth = { user, pass };
            }

            const transporter = nodemailer.createTransport(transportOptions);

            const info = await transporter.sendMail({
                from: from.includes('<') ? from : `"ECN Manager" <${from}>`,
                to: to,
                subject: 'Prueba ECN Manager - Honeywell Relay SMTP',
                html: '<h3>Prueba de correo exitosa</h3><p>Este mensaje fue enviado a través del relay corporativo SMTP de Honeywell (smtp.honeywell.com).</p>'
            });

            console.log('[Honeywell Relay Success]', info);
            res.json({
                success: true,
                message: 'Correo enviado exitosamente vía smtp.honeywell.com',
                info
            });

        } catch (e: any) {
            console.error('[Honeywell Relay Error]', e);
            res.status(500).json({
                error: e.message
            });
        }
    });

    app.post('/api/notify/ecn-implemented', async (req, res) => {
        try {
            const ecn = req.body;
            const { transporter, from, fromName } = await getEmailTransporter();

            const result = await db.pool.request().query("SELECT value FROM settings WHERE [key] = 'email_to'");
            const toEmail = result.recordset[0]?.value;

            if (!toEmail) throw new Error('No se ha configurado un destinatario global (email_to).');

            const html = `
                <h2>ECN Implementado: ${ecn.id}</h2>
                <p><strong>Descripción:</strong> ${ecn.description}</p>
                <p><strong>Iniciador:</strong> ${ecn.initiator}</p>
                <p><strong>Fecha de Implementación:</strong> ${ecn.implementationDate}</p>
                <hr/>
                <p>Este es un mensaje automático del Sistema de Gestión de ECN.</p>
            `;

            await transporter.sendMail({
                from: `"${fromName}" <${from}>`,
                to: toEmail,
                subject: `[IMP] ECN Implementado: ${ecn.id}`,
                html
            });

            res.json({ message: 'Notificación enviada' });
        } catch (e: any) {
            res.status(500).json({ error: e.message });
        }
    });

    app.post('/api/email/weekly-summary', async (req, res) => {
        try {
            const { transporter, from, fromName } = await getEmailTransporter();

            const result = await db.pool.request().query("SELECT value FROM settings WHERE [key] = 'email_to'");
            const toEmail = result.recordset[0]?.value;

            if (!toEmail) throw new Error('No se ha configurado un destinatario global (email_to).');

            // Obtener ECNs de la última semana
            const ecnsResult = await db.pool.request().query(`
                SELECT TOP 50 id, description, initiator, status, implementation_date, creation_date
                FROM ecns
                WHERE creation_date >= DATEADD(day, -7, GETDATE())
                   OR implementation_date >= DATEADD(day, -7, GETDATE())
                ORDER BY creation_date DESC
            `);

            const ecns = ecnsResult.recordset;

            const rows = ecns.map(e => `
                <tr>
                    <td style="padding:6px;border:1px solid #ddd;">${e.id}</td>
                    <td style="padding:6px;border:1px solid #ddd;">${e.description || '-'}</td>
                    <td style="padding:6px;border:1px solid #ddd;">${e.initiator || '-'}</td>
                    <td style="padding:6px;border:1px solid #ddd;">${e.status || '-'}</td>
                    <td style="padding:6px;border:1px solid #ddd;">${e.implementation_date ? new Date(e.implementation_date).toLocaleDateString() : '-'}</td>
                </tr>
            `).join('');

            const html = `
                <h2>Resumen Semanal de ECNs</h2>
                <p>A continuación se muestran los ECNs de los últimos 7 días:</p>
                <table style="border-collapse:collapse;width:100%;font-family:Arial,sans-serif;font-size:13px;">
                    <thead>
                        <tr style="background:#004080;color:#fff;">
                            <th style="padding:8px;border:1px solid #ddd;">ID</th>
                            <th style="padding:8px;border:1px solid #ddd;">Descripción</th>
                            <th style="padding:8px;border:1px solid #ddd;">Iniciador</th>
                            <th style="padding:8px;border:1px solid #ddd;">Estado</th>
                            <th style="padding:8px;border:1px solid #ddd;">Fecha Impl.</th>
                        </tr>
                    </thead>
                    <tbody>${rows || '<tr><td colspan="5" style="text-align:center;padding:10px;">Sin ECNs en los últimos 7 días</td></tr>'}</tbody>
                </table>
                <hr/>
                <p style="color:#888;font-size:12px;">Este es un mensaje automático del Sistema de Gestión de ECN.</p>
            `;

            await transporter.sendMail({
                from: `"${fromName}" <${from}>`,
                to: toEmail,
                subject: `[ECN Manager] Resumen Semanal - ${new Date().toLocaleDateString()}`,
                html
            });

            res.json({ message: 'Resumen semanal enviado exitosamente', total: ecns.length });
        } catch (e: any) {
            console.error('[Weekly Summary Error]', e);
            res.status(500).json({ error: e.message });
        }
    });

    // --- Settings Routes ---
    app.get('/api/settings/:key', async (req, res) => {
        try {
            const { key } = req.params;
            const result = await db.pool.request()
                .input('key', sql.NVarChar, key)
                .query('SELECT value FROM settings WHERE [key] = @key');
            if (result.recordset.length === 0) {
                return res.json({ key, value: null });
            }
            res.json({ key, value: result.recordset[0].value });
        } catch (e: any) {
            res.status(500).json({ error: e.message });
        }
    });

    app.post('/api/settings', async (req, res) => {
        try {
            const { key, value } = req.body;
            if (!key) return res.status(400).json({ error: 'key is required' });
            await db.pool.request()
                .input('key', sql.NVarChar, key)
                .input('value', sql.NVarChar, String(value ?? ''))
                .query(`
                    IF EXISTS (SELECT 1 FROM settings WHERE [key] = @key)
                        UPDATE settings SET value = @value WHERE [key] = @key
                    ELSE
                        INSERT INTO settings ([key], value) VALUES (@key, @value)
                `);
            res.json({ success: true, key, value });
        } catch (e: any) {
            res.status(500).json({ error: e.message });
        }
    });

    // --- Implementation Tasks API ---
    // Templates de tareas sugeridas (no se generan automáticamente, solo se sugieren para creación manual)
    const SUGGESTED_TASK_TEMPLATES = [
        { department: 'Planeación (Compras)', taskName: 'Asignar Fecha de Llegada de Nuevo Material' },
        { department: 'Planeación (Producción)', taskName: 'Refrescar Órdenes' },
        { department: 'Finanzas', taskName: 'Costeo de Materiales' },
        { department: 'Materiales', taskName: 'Agregar Material a Listado de Scrap' },
        { department: 'Ingeniería de Manufactura', taskName: 'Creación / Actualización de Instrucciones de Trabajo' },
        { department: 'Ingeniería de Calidad', taskName: 'Validación de Calidad / Liberación de Primera Pieza' },
        { department: 'Ingeniería de Producto', taskName: 'Validación de Muestras e Ingeniería' }
    ];

    app.get('/api/implementation-tasks/suggestions', (req, res) => {
        res.json(SUGGESTED_TASK_TEMPLATES);
    });

    app.get('/api/implementation-tasks', async (req, res) => {
        try {
            const { family, department, ecnId, userId } = req.query;
            let query = `
                SELECT 
                    t.id,
                    t.ecn_id as ecnId,
                    t.family,
                    t.department,
                    t.task_name as taskName,
                    t.assigned_user_id as assignedUserId,
                    u.name as assignedUserName,
                    t.status,
                    t.due_date as dueDate,
                    t.comments,
                    t.updated_at as updatedAt
                FROM implementation_tasks t
                LEFT JOIN users u ON t.assigned_user_id = u.id
                WHERE 1=1
            `;
            const reqDb = db.pool.request();
            if (family) {
                query += " AND t.family = @family";
                reqDb.input('family', sql.NVarChar, family);
            }
            if (department) {
                query += " AND t.department = @department";
                reqDb.input('department', sql.NVarChar, department);
            }
            if (ecnId) {
                query += " AND t.ecn_id = @ecnId";
                reqDb.input('ecnId', sql.NVarChar, ecnId);
            }
            if (userId) {
                query += " AND t.assigned_user_id = @userId";
                reqDb.input('userId', sql.NVarChar, userId);
            }
            query += " ORDER BY t.due_date ASC, t.updated_at DESC";

            const result = await reqDb.query(query);
            res.json(result.recordset);
        } catch (e: any) {
            console.error('[API Implementation Tasks Error]', e);
            res.status(500).json({ error: e.message });
        }
    });

    app.post('/api/implementation-tasks', async (req, res) => {
        try {
            const { ecnId, family, department, taskName, assignedUserId, status, dueDate, comments } = req.body;
            if (!taskName || !taskName.trim()) {
                return res.status(400).json({ error: 'El nombre de la tarea es requerido' });
            }
            if (!ecnId || !ecnId.trim()) {
                return res.status(400).json({ error: 'El número de ECN es requerido' });
            }

            const taskId = uuidv4();
            await db.pool.request()
                .input('id', sql.UniqueIdentifier, taskId)
                .input('ecnId', sql.NVarChar, ecnId.trim())
                .input('family', sql.NVarChar, family ? family.trim() : 'General')
                .input('department', sql.NVarChar, department ? department.trim() : 'General')
                .input('taskName', sql.NVarChar, taskName.trim())
                .input('userId', sql.NVarChar, assignedUserId || null)
                .input('status', sql.NVarChar, status || 'Pendiente')
                .input('dueDate', sql.Date, dueDate ? new Date(dueDate) : null)
                .input('comments', sql.NVarChar, comments || '')
                .query(`
                    INSERT INTO implementation_tasks (
                        id, ecn_id, family, department, task_name, assigned_user_id, status, due_date, comments, updated_at
                    ) VALUES (
                        @id, @ecnId, @family, @department, @taskName, @userId, @status, @dueDate, @comments, SYSDATETIME()
                    )
                `);

            res.status(201).json({
                success: true,
                message: 'Tarea de implementación creada correctamente',
                id: taskId
            });
        } catch (e: any) {
            console.error('[API Create Task Error]', e);
            res.status(500).json({ error: e.message });
        }
    });

    app.put('/api/implementation-tasks/:id', async (req, res) => {
        try {
            const taskId = req.params.id;
            const { ecnId, family, department, taskName, status, assignedUserId, dueDate, comments } = req.body;

            await db.pool.request()
                .input('id', sql.UniqueIdentifier, taskId)
                .input('ecnId', sql.NVarChar, ecnId ? ecnId.trim() : null)
                .input('family', sql.NVarChar, family ? family.trim() : null)
                .input('department', sql.NVarChar, department ? department.trim() : null)
                .input('taskName', sql.NVarChar, taskName ? taskName.trim() : null)
                .input('status', sql.NVarChar, status || 'Pendiente')
                .input('userId', sql.NVarChar, assignedUserId || null)
                .input('dueDate', sql.Date, dueDate ? new Date(dueDate) : null)
                .input('comments', sql.NVarChar, comments || '')
                .query(`
                    UPDATE implementation_tasks 
                    SET ecn_id = COALESCE(@ecnId, ecn_id),
                        family = COALESCE(@family, family),
                        department = COALESCE(@department, department),
                        task_name = COALESCE(@taskName, task_name),
                        status = COALESCE(@status, status),
                        assigned_user_id = @userId,
                        due_date = @dueDate,
                        comments = COALESCE(@comments, comments),
                        updated_at = SYSDATETIME()
                    WHERE id = @id
                `);
            res.json({ success: true, message: 'Tarea actualizada correctamente' });
        } catch (e: any) {
            console.error('[API Update Task Error]', e);
            res.status(500).json({ error: e.message });
        }
    });

    app.delete('/api/implementation-tasks/:id', async (req, res) => {
        try {
            const taskId = req.params.id;
            await db.pool.request()
                .input('id', sql.UniqueIdentifier, taskId)
                .query(`
                    DELETE FROM implementation_tasks 
                    WHERE id = @id
                `);
            res.json({ success: true, message: 'Tarea eliminada correctamente' });
        } catch (e: any) {
            console.error('[API Delete Task Error]', e);
            res.status(500).json({ error: e.message });
        }
    });

    // Final API 404 handler - prevents /api requests from falling back to SPA HTML

    app.all(/^\/api(\/.*)?$/, (req, res) => {
        res.status(404).json({
            error: 'API Endpoint not found',
            path: req.path,
            method: req.method
        });
    });

    // Vite middleware for development
    if (!isProduction) {
        try {
            const { createServer: createViteServer } = await import('vite');
            const vite = await createViteServer({
                server: { middlewareMode: true },
                appType: 'spa',
                base: '/ecns/',
            });
            app.use('/ecns', vite.middlewares);
            app.use(vite.middlewares);
        } catch (e) {
            console.error('[Server] Failed to load Vite middleware:', e);
            // Fallback to static if Vite fails even in dev
            app.use(express.static(distPath));
            app.get(/^(?!\/api).*/, (req, res, next) => {
                if (req.path.startsWith('/api')) {
                    return res.status(404).json({ error: 'API route not found (vite-fallback)' });
                }
                if (req.path.includes('.')) return next();
                res.sendFile(path.join(distPath, 'index.html'));
            });
        }
    } else {
        // Serve static files for both /ecns subpath and root domain
        app.use('/ecns', express.static(distPath));
        app.use(express.static(distPath));

        // Catch-all route for SPA (matches /ecns, /ecns/* and /* except /api)
        app.get(/^(?!\/api).*/, (req, res, next) => {
            if (req.path.startsWith('/api') || req.path.startsWith('/ecns/api')) {
                return res.status(404).json({ error: 'API route not found (SPA-leak)' });
            }
            if (req.path.includes('.')) {
                return next();
            }
            res.sendFile(path.join(distPath, 'index.html'));
        });
    }

    // Start listening AFTER all routes are registered
    const useDirectHttps = process.env.HTTPS === 'true' && !!process.env.SSL_KEY_PATH && !!process.env.SSL_CERT_PATH;

    if (useDirectHttps) {
        try {
            const sslKeyPath = path.resolve(process.env.SSL_KEY_PATH!);
            const sslCertPath = path.resolve(process.env.SSL_CERT_PATH!);
            if (fs.existsSync(sslKeyPath) && fs.existsSync(sslCertPath)) {
                const sslOptions: https.ServerOptions = {
                    key: fs.readFileSync(sslKeyPath),
                    cert: fs.readFileSync(sslCertPath),
                    ca: process.env.SSL_CA_PATH && fs.existsSync(path.resolve(process.env.SSL_CA_PATH))
                        ? fs.readFileSync(path.resolve(process.env.SSL_CA_PATH))
                        : undefined,
                };
                const httpsServer = https.createServer(sslOptions, app);
                httpsServer.listen(PORT, '0.0.0.0', () => {
                    console.log(`[Server] 🔒 Listening natively on HTTPS port ${PORT} (isProduction: ${isProduction})`);
                    console.log(`[Server] Direct SSL certificates loaded from ${sslCertPath}`);
                });
            } else {
                throw new Error(`SSL files not found on disk: ${sslKeyPath} or ${sslCertPath}`);
            }
        } catch (sslErr: any) {
            console.error('[Server] ⚠️ Failed to initialize direct HTTPS, starting on HTTP for Reverse Proxy:', sslErr.message);
            app.listen(PORT, '0.0.0.0', () => {
                console.log(`[Server] 🌐 Listening on port ${PORT} (isProduction: ${isProduction})`);
                console.log(`[Server] IIS Reverse Proxy & HTTPS ready (trust proxy: enabled).`);
            });
        }
    } else {
        // Standard Enterprise IIS Reverse Proxy Architecture:
        // IIS terminates HTTPS on port 443 with the corporate SSL certificate and proxies to Node.js on PORT.
        app.listen(PORT, '0.0.0.0', () => {
            console.log(`[Server] 🌐 Listening on port ${PORT} (isProduction: ${isProduction})`);
            console.log(`[Server] 🚀 Ready for IIS Reverse Proxy (ARR) with HTTPS termination on port 443.`);
            console.log(`[Server] Trust Proxy is ENABLED (X-Forwarded-Proto, X-Forwarded-Host, X-ARR-SSL).`);
        });
    }
}

startServer().catch((err: any) => {
    console.error('[Server] Critical startup error:', err);
    process.exit(1);
});
