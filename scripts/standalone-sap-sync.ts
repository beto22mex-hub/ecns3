import 'dotenv/config';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { exec } from 'child_process';
import { v4 as uuidv4 } from 'uuid';
import * as XLSX from 'xlsx';
import * as db from '../db.js';

const { sql } = db;

// --- Mapping Aliases Dictionary (identical to Frontend default auto-mapping) ---
const MAPPABLE_FIELDS: Record<string, { label: string; aliases: string[] }> = {
    ecn: {
        label: 'ECN',
        aliases: ['ecro', 'ecn', 'ecn/cc', 'ecnro', 'ecn code', 'code', 'ecn no', 'ecn #', 'change no.', 'aennr', 'change number']
    },
    assembly: {
        label: 'Assembly',
        aliases: ['assembly', 'ensamble', 'assembly name', 'material', 'matnr', 'parent', 'top assembly', 'parte padre']
    },
    assemblyDescription: {
        label: 'Assembly Description',
        aliases: ['assembly description', 'descripción ensamble', 'descripcion ensamble', 'maktx', 'assembly desc', 'material description']
    },
    assemblyRevision: {
        label: 'Assembly Revision',
        aliases: ['assembly rev', 'assembly revision', 'revisión ensamble', 'rev ensamble', 'rev', 'revision', 'rev.', 'aevn']
    },
    oldComponent: {
        label: 'Old Component',
        aliases: ['old component', 'component', 'viejo componente', 'componente viejo', 'material viejo', 'material old', 'idnrk', 'old comp', 'old material']
    },
    newComponent: {
        label: 'New Component',
        aliases: ['new component', 'start material', 'nuevo componente', 'componente nuevo', 'material nuevo', 'material new', 'bmatn', 'new comp', 'new material']
    },
    newComponentRevision: {
        label: 'New Component Revision',
        aliases: ['new component rev', 'new component revision', 'revisión componente nuevo', 'rev componente nuevo', 'new rev', 'rev new']
    },
    newComponentDescription: {
        label: 'New Component Description',
        aliases: ['new component description', 'descripción componente nuevo', 'new comp desc', 'desc material nuevo']
    },
    oldSubassembly: {
        label: 'Old Subassembly',
        aliases: ['old subassembly', 'subensamble viejo', 'subensamble anterior', 'old sub']
    },
    newSubassembly: {
        label: 'New Subassembly',
        aliases: ['new subassembly', 'subensamble nuevo', 'new sub']
    },
    newSubassemblyRevision: {
        label: 'New Subassembly Revision',
        aliases: ['new subassembly rev', 'revisión subensamble nuevo']
    },
    newSubassemblyDescription: {
        label: 'New Subassembly Description',
        aliases: ['new subassembly desc', 'descripción subensamble nuevo']
    },
    startDate: {
        label: 'Start Date',
        aliases: ['start date', 'date start', 'fecha inicio', 'datuv', 'valid from', 'effective date', 'fecha vigencia']
    },
    stopDate: {
        label: 'Stop Date',
        aliases: ['stop date', 'date stop', 'fecha fin', 'datub', 'valid to']
    },
    demand: {
        label: 'Demand',
        aliases: ['demand', 'qty', 'quantity', 'demanda', 'cantidad', 'menge', 'req qty']
    },
    onHandInventory: {
        label: 'On Hand Inventory',
        aliases: ['on hand', 'on hand inventory', 'on-hand', 'stock', 'inventario', 'en mano', 'onhand', 'stock disponible', 'labst']
    },
    openPoQty: {
        label: 'Open PO Qty',
        aliases: ['open po qty', 'open po', 'po qty', 'ordenes abiertas', 'po abierta', 'open orders']
    },
    createdBy: {
        label: 'Created By',
        aliases: ['created by', 'createdby', 'creado por', 'initiator', 'iniciador', 'ernam', 'autor', 'author']
    },
    createdOn: {
        label: 'Created On',
        aliases: ['created on', 'created date', 'date created', 'fecha creación', 'fecha creacion', 'erdat']
    },
    description: {
        label: 'Description',
        aliases: ['description', 'description sap', 'ecn description', 'text comment', 'notes', 'comentarios', 'aetxt', 'change text', 'desc']
    },
    sku: {
        label: 'SKU',
        aliases: ['top sku', 'sku', 'product sku', 'modelo', 'fg', 'finished good']
    },
    family: {
        label: 'Family',
        aliases: ['family', 'familia', 'product family', 'linea', 'línea']
    },
    site: {
        label: 'Site',
        aliases: ['site', 'plant', 'planta', 'werks', 'sitio', 'ubicacion']
    }
};

// --- Helper Functions ---

function getCScriptCommand(vbsPath: string): string {
    const is64Bit = process.arch === 'x64' || !!process.env.PROCESSOR_ARCHITEW6432;
    const cscriptSysNative = 'C:\\Windows\\SysNative\\cscript.exe';
    const cscriptSystem32 = 'C:\\Windows\\System32\\cscript.exe';

    let cscriptBin = 'cscript.exe';
    if (is64Bit && fs.existsSync(cscriptSysNative)) {
        cscriptBin = cscriptSysNative;
    } else if (fs.existsSync(cscriptSystem32)) {
        cscriptBin = cscriptSystem32;
    }

    return `"${cscriptBin}" //NoLogo //T:600 "${vbsPath}"`;
}

function formatSapDate(dateInput: any): string {
    if (!dateInput) return '';
    const str = String(dateInput).trim();
    if (!str) return '';

    if (/^\d{2}\.\d{2}\.\d{4}$/.test(str)) {
        return str;
    }

    const dotMatch = str.match(/^(\d{1,2})\.(\d{1,2})\.(\d{4})$/);
    if (dotMatch) {
        return `${dotMatch[1].padStart(2, '0')}.${dotMatch[2].padStart(2, '0')}.${dotMatch[3]}`;
    }

    const ymdMatch = str.match(/^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})/);
    if (ymdMatch) {
        const year = ymdMatch[1];
        const month = ymdMatch[2].padStart(2, '0');
        const day = ymdMatch[3].padStart(2, '0');
        return `${day}.${month}.${year}`;
    }

    const dmyMatch = str.match(/^(\d{1,2})[-/](\d{1,2})[-/](\d{4})/);
    if (dmyMatch) {
        const day = dmyMatch[1].padStart(2, '0');
        const month = dmyMatch[2].padStart(2, '0');
        const year = dmyMatch[3];
        return `${day}.${month}.${year}`;
    }

    const parsedDate = new Date(str);
    if (!isNaN(parsedDate.getTime())) {
        const day = String(parsedDate.getUTCDate()).padStart(2, '0');
        const month = String(parsedDate.getUTCMonth() + 1).padStart(2, '0');
        const year = String(parsedDate.getUTCFullYear());
        return `${day}.${month}.${year}`;
    }

    return str;
}

function parseDateIso(dateInput: any): string | null {
    if (!dateInput) return null;

    if (dateInput instanceof Date && !isNaN(dateInput.getTime())) {
        const year = dateInput.getFullYear();
        const month = dateInput.getMonth();
        const day = dateInput.getDate();
        const utcDate = new Date(Date.UTC(year, month, day));
        return utcDate.toISOString().split('T')[0];
    }

    if (typeof dateInput === 'number' && dateInput > 1) {
        const excelEpoch = new Date(Date.UTC(1899, 11, 30));
        const date = new Date(excelEpoch.getTime() + dateInput * 24 * 60 * 60 * 1000);
        if (!isNaN(date.getTime())) {
            return date.toISOString().split('T')[0];
        }
    }

    if (typeof dateInput === 'string') {
        const trimmedDate = dateInput.trim().split(' ')[0];
        let parts = trimmedDate.match(/^(\d{4})-(\d{1,2})-(\d{1,2})$/);
        if (parts) {
            const year = parseInt(parts[1], 10);
            const month = parseInt(parts[2], 10) - 1;
            const day = parseInt(parts[3], 10);
            if (year > 1900 && month >= 0 && month <= 11 && day >= 1 && day <= 31) {
                const utcDate = new Date(Date.UTC(year, month, day));
                return utcDate.toISOString().split('T')[0];
            }
        }

        parts = trimmedDate.match(/^(\d{1,2})[./-](\d{1,2})[./-](\d{4})$/);
        if (parts) {
            const day = parseInt(parts[1], 10);
            const month = parseInt(parts[2], 10) - 1;
            const year = parseInt(parts[3], 10);
            if (year > 1900 && month >= 0 && month <= 11 && day >= 1 && day <= 31) {
                const utcDate = new Date(Date.UTC(year, month, day));
                return utcDate.toISOString().split('T')[0];
            }
        }
    }

    return null;
}

function cleanEcn(value: any): string {
    if (value === null || value === undefined) return '';
    return String(value).trim().replace(/\s+/g, '');
}

function parseNumericValue(value: any): number {
    if (value === null || value === undefined || value === '') return 0;
    const normalized = String(value).replace(/[^0-9,.-]/g, '').replace(',', '.');
    const parsed = Number(normalized);
    return Number.isFinite(parsed) ? parsed : 0;
}

function readExcelWorkbook(filePath: string, options: any = {}): any {
    if (typeof (XLSX as any).readFile === 'function') {
        return (XLSX as any).readFile(filePath, options);
    }
    if ((XLSX as any).default && typeof (XLSX as any).default.readFile === 'function') {
        return (XLSX as any).default.readFile(filePath, options);
    }
    const fileBuffer = fs.readFileSync(filePath);
    const readFn = (XLSX as any).read || ((XLSX as any).default && (XLSX as any).default.read);
    if (typeof readFn === 'function') {
        return readFn(fileBuffer, { type: 'buffer', ...options });
    }
    throw new Error('No se encontró el método de lectura en el módulo XLSX');
}

function parseSheetToJson(sheet: any, options: any = { defval: '', raw: false }): any[] {
    const utils = (XLSX as any).utils || ((XLSX as any).default && (XLSX as any).default.utils);
    if (utils && typeof utils.sheet_to_json === 'function') {
        return utils.sheet_to_json(sheet, options);
    }
    return [];
}

/**
 * Ensures SAP session is active, launching saplogon.exe if needed and opening shortcut "Inicio"
 */
async function ensureSapSessionActive(connectionName: string = 'Inicio'): Promise<void> {
    if (process.platform !== 'win32') return;

    const tempScriptPath = path.join(os.tmpdir(), `sap_ensure_conn_${Date.now()}.vbs`);
    const vbsContent = `'=============================================================================
' ENSURE SAP SESSION ACTIVE SCRIPT (CSCRIPT)
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
    WScript.Sleep 4000
    Set SapGuiAuto = GetObject("SAPGUI")
End If

If Err.Number <> 0 Or SapGuiAuto Is Nothing Then
    WScript.Echo "RESULT_ERR:No se detecto proceso activo de SAP GUI ni se pudo iniciar saplogon.exe."
    WScript.Quit 0
End If

Set appObj = SapGuiAuto.GetScriptingEngine
If Err.Number <> 0 Or appObj Is Nothing Then
    WScript.Echo "RESULT_ERR:El scripting de SAP GUI esta deshabilitado en tu SAP Logon o servidor (RZ11)."
    WScript.Quit 0
End If

If appObj.Children.Count = 0 Then
    Dim connNames, cn, opened
    connNames = Array("${connectionName}", "Inicio", "Ingreso Predeterminado", "BRP - ERP Production", "BRP -ERP Production", "BRP-ERP Production", "BRP - Production", "ERP Production", "BRP", "BRP [ERP Production]", "BRP [ECC Production]", "BRP [PRD]", "BRP [ECC]", "BRP Produccion", "BRP PRD", "BRP Production", "BRP_FWD")
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
            wshShell.SendKeys "${connectionName}"
            WScript.Sleep 200
            wshShell.SendKeys "{ENTER}"
            WScript.Sleep 200
            wshShell.SendKeys "{TAB}"
            WScript.Sleep 150
            wshShell.SendKeys "{ENTER}"
            WScript.Sleep 250
            wshShell.SendKeys "${connectionName}"
            WScript.Sleep 150
            wshShell.SendKeys "{ENTER}"
        End If
    End If
End If

Dim waitConn, hasConn, popTitles, pt
hasConn = False
popTitles = Array("Information", "Información", "System Messages", "Mensajes del sistema", "Copyright", "License", "Licencia", "SAP GUI Security", "Seguridad de SAP GUI", "SAP GUI for Windows", "Logon Information", "Información de logon", "Warning", "Advertencia", "Notice", "Aviso", "Attention", "Atención")

For waitConn = 1 To 60
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
                wshShell.SendKeys "${connectionName}"
                WScript.Sleep 150
                wshShell.SendKeys "{ENTER}"
                Exit For
            End If
        Next
    End If
    WScript.Sleep 500
Next

If Not hasConn Or appObj.Children.Count = 0 Then
    WScript.Echo "RESULT_ERR:No hay conexiones abiertas en SAP Logon tras esperar. Abre tu shortcut '" & "${connectionName}" & "'."
    WScript.Quit 0
End If

WScript.Echo "RESULT_OK:SAP_CONNECTED"
`;

    try {
        fs.writeFileSync(tempScriptPath, vbsContent, 'utf-8');
        const cmd = getCScriptCommand(tempScriptPath);

        await new Promise<void>((resolve, reject) => {
            exec(cmd, { timeout: 45000 }, (error, stdout) => {
                try { fs.unlinkSync(tempScriptPath); } catch (_) {}
                if (stdout && stdout.includes('RESULT_ERR:')) {
                    const msg = stdout.split('RESULT_ERR:')[1].split(/\r?\n/)[0].trim();
                    reject(new Error(msg));
                    return;
                }
                resolve();
            });
        });
    } catch (e: any) {
        try { fs.unlinkSync(tempScriptPath); } catch (_) {}
        throw e;
    }
}

/**
 * Generates ZPP_CC07 extraction VBScript
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
' STANDALONE REAL ZPP_CC07 SCRIPT (CSCRIPT)
'=============================================================================
On Error Resume Next

Dim SapGuiAuto, appObj, connObj, sessionObj, wshShell
Set wshShell = CreateObject("WScript.Shell")
Set SapGuiAuto = GetObject("SAPGUI")

If Err.Number <> 0 Or SapGuiAuto Is Nothing Then
    wshShell.Run "saplogon.exe", 1, False
    WScript.Sleep 3500
    Set SapGuiAuto = GetObject("SAPGUI")
End If

If Err.Number <> 0 Or SapGuiAuto Is Nothing Then
    WScript.Echo "RESULT_ERR:No se detecto proceso activo de SAP GUI."
    WScript.Quit 0
End If

Set appObj = SapGuiAuto.GetScriptingEngine
If Err.Number <> 0 Or appObj Is Nothing Then
    WScript.Echo "RESULT_ERR:El scripting de SAP GUI esta deshabilitado en tu SAP Logon o servidor (RZ11)."
    WScript.Quit 0
End If

Dim waitConn, hasConn, popTitles, pt
hasConn = False
popTitles = Array("Information", "Información", "System Messages", "Mensajes del sistema", "Copyright", "License", "Licencia", "SAP GUI Security", "Seguridad de SAP GUI", "SAP GUI for Windows", "Logon Information", "Información de logon", "Warning", "Advertencia", "Notice", "Aviso", "Attention", "Atención")

For waitConn = 1 To 30
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
                If sessionObj.Busy = False Then
                    hasConn = True
                    Exit For
                End If
            End If
        End If
    End If
    WScript.Sleep 500
Next

If Not hasConn Or appObj.Children.Count = 0 Then
    WScript.Echo "RESULT_ERR:No hay conexiones abiertas en SAP Logon."
    WScript.Quit 0
End If

Set connObj = appObj.Children(0)
Set sessionObj = connObj.Children(0)

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
plantCodes = Array(${plants.map(p => `"${p}"`).join(', ')})

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

WScript.Echo "RESULT_OK:FINISHED_PLANTS"
`;
}

/**
 * Batch enrichment for ECN descriptions from SAP GUI (CC03 / IQS3)
 */
async function enrichDescriptionsFromSap(ecnList: string[]): Promise<Map<string, string>> {
    const descriptionMap = new Map<string, string>();
    if (process.platform !== 'win32' || ecnList.length === 0) return descriptionMap;

    const uniqueEcns = Array.from(new Set(ecnList.map(cleanEcn).filter(Boolean))).slice(0, 80);
    if (uniqueEcns.length === 0) return descriptionMap;

    const tempScriptPath = path.join(os.tmpdir(), `sap_desc_batch_${Date.now()}.vbs`);
    const vbsContent = `'=============================================================================
' SAP GUI CC03 / IQS3 BATCH DESCRIPTION RETRIEVAL (CSCRIPT)
'=============================================================================
On Error Resume Next

Dim SapGuiAuto, appObj, connObj, sessionObj, wshShell
Set wshShell = CreateObject("WScript.Shell")
Set SapGuiAuto = GetObject("SAPGUI")

If Err.Number <> 0 Or SapGuiAuto Is Nothing Then
    WScript.Echo "RESULT_ERR:SAP GUI no disponible."
    WScript.Quit 0
End If

Set appObj = SapGuiAuto.GetScriptingEngine
If Err.Number <> 0 Or appObj Is Nothing Then
    WScript.Echo "RESULT_ERR:Scripting no disponible."
    WScript.Quit 0
End If

If appObj.Children.Count = 0 Then
    WScript.Echo "RESULT_ERR:No hay conexiones abiertas."
    WScript.Quit 0
End If

Set connObj = appObj.Children(0)
Set sessionObj = connObj.Children(0)

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

    ' 1. Intentar CC03 (Change Master)
    sessionObj.findById("wnd[0]/tbar[0]/okcd").Text = "CC03"
    sessionObj.findById("wnd[0]").SendVKey 0
    sessionObj.findById("wnd[0]/usr/ctxtRC29A-AENNR").Text = currentEcn
    sessionObj.findById("wnd[0]").SendVKey 0

    If sessionObj.findById("wnd[0]/sbar").Text = "" Then
        descVal = sessionObj.findById("wnd[0]/usr/subCOMMON:SAPMC29C:0040/txtRC29A-AETXT").Text
    End If

    ' 2. Si no encontró en CC03, intentar IQS3 (ECR / Notification)
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

WScript.Echo "RESULT_OK:FINISHED"
`;

    try {
        fs.writeFileSync(tempScriptPath, vbsContent, 'utf-8');
        const cmd = getCScriptCommand(tempScriptPath);

        await new Promise<void>((resolve) => {
            exec(cmd, { timeout: Math.max(30000, uniqueEcns.length * 6000) }, (error, stdout) => {
                try { fs.unlinkSync(tempScriptPath); } catch (_) {}
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
        try { fs.unlinkSync(tempScriptPath); } catch (_) {}
    }

    return descriptionMap;
}

// --- Main Standalone Execution Routine ---

async function runStandaloneSapSync() {
    const startTime = Date.now();
    console.log('================================================================');
    console.log('   HONEYWELL ECN MANAGER - AUTOMATED SERVER SAP SYNC (CMD/CRON)');
    console.log('================================================================');
    console.log(`[${new Date().toISOString()}] Iniciando proceso de sincronización automática...`);

    // Parse Command Line Arguments (e.g. --plant=5205 --startDate=2026-08-21 --endDate=2026-09-30)
    const args = process.argv.slice(2);
    const parsedArgs: Record<string, string> = {};
    for (const arg of args) {
        if (arg.startsWith('--')) {
            const [k, ...v] = arg.slice(2).split('=');
            parsedArgs[k] = v.join('=') || 'true';
        }
    }

    // Default dates: startDate = today minus 1 year (365 days), endDate = today plus 90 days
    const now = new Date();
    const defaultStartDateObj = new Date(now.getTime() - 365 * 24 * 60 * 60 * 1000);
    const defaultEndDateObj = new Date(now.getTime() + 90 * 24 * 60 * 60 * 1000);

    const plant = (parsedArgs.plant || parsedArgs.p || process.env.SAP_SYNC_PLANT || '5205').trim();
    const startDate = parsedArgs.startDate || parsedArgs.start || parsedArgs.s || defaultStartDateObj.toISOString().split('T')[0];
    const endDate = parsedArgs.endDate || parsedArgs.end || parsedArgs.e || defaultEndDateObj.toISOString().split('T')[0];
    const connectionName = parsedArgs.connection || process.env.SAP_CONNECTION_NAME || 'Inicio';

    console.log(`[Config] Planta: ${plant} | Rango Fechas: ${startDate} al ${endDate} | Conexión: ${connectionName}`);

    // Check Windows Environment
    if (process.platform !== 'win32') {
        console.warn('[Aviso] Entorno no es Windows. Esta tarea requiere Windows y SAP GUI OLE Automation para interactuar con SAP.');
    }

    // Initialize Database Connection
    console.log('[DB] Conectando a la base de datos SQL Server...');
    await db.init();
    console.log('[DB] Conexión a la base de datos inicializada.');

    // Step 1: Ensure SAP GUI is active and connected
    console.log(`[SAP GUI] Verificando conexión activa a SAP (Acceso directo: '${connectionName}')...`);
    try {
        await ensureSapSessionActive(connectionName);
        console.log('[SAP GUI] Conexión verificada y sesión activa lista.');
    } catch (connErr: any) {
        console.warn(`[SAP GUI] Advertencia al conectar: ${connErr.message}. Continuando intento de extracción...`);
    }

    // Step 2: Run ZPP_CC07 Extraction
    const formattedInitialDate = formatSapDate(startDate);
    const formattedFinalDate = formatSapDate(endDate);
    const exportRoot = path.join(os.tmpdir(), `sap_zpp_cmd_${Date.now()}`);
    fs.mkdirSync(exportRoot, { recursive: true });

    const todayFormatted = new Date().toISOString().slice(2, 10).replace(/-/g, '');
    const tempScriptPath = path.join(os.tmpdir(), `sap_gui_zpp_cmd_${Date.now()}.vbs`);

    const macroCode = generateZppVbsCode({
        plants: [plant],
        formattedInitialDate,
        formattedFinalDate,
        exportRoot,
        todayFormatted
    });

    console.log(`[SAP ZPP_CC07] Ejecutando transacción ZPP_CC07 para planta ${plant} (${formattedInitialDate} -> ${formattedFinalDate})...`);
    let exportFiles: string[] = [];

    try {
        fs.writeFileSync(tempScriptPath, macroCode, 'utf-8');
        const cmd = getCScriptCommand(tempScriptPath);

        await new Promise<void>((resolve, reject) => {
            exec(cmd, { timeout: 300000 }, (error, stdout, stderr) => {
                try { fs.unlinkSync(tempScriptPath); } catch (_) {}
                if (stdout) console.log('[SAP CSCRIPT]', stdout.trim());
                if (stderr) console.warn('[SAP CSCRIPT STDERR]', stderr.trim());

                if (stdout && stdout.includes('RESULT_ERR:')) {
                    const errMsg = stdout.split('RESULT_ERR:')[1].split(/\r?\n/)[0].trim();
                    reject(new Error(errMsg));
                    return;
                }
                resolve();
            });
        });

        if (fs.existsSync(exportRoot)) {
            exportFiles = fs.readdirSync(exportRoot).filter(f => /^ECN_.*\.XLSX$/i.test(f));
        }
    } catch (extractErr: any) {
        console.error('[SAP ZPP_CC07 Error]', extractErr.message);
        try { fs.rmSync(exportRoot, { recursive: true, force: true }); } catch (_) {}
    }

    console.log(`[SAP ZPP_CC07] Archivos exportados encontrados: ${exportFiles.length}`);

    // Step 3: Parse Excel sheets and apply Default Column Auto-Mapping
    const rawRows: Record<string, any>[] = [];
    let detectedHeaders: string[] = [];

    for (const fileName of exportFiles) {
        const filePath = path.join(exportRoot, fileName);
        try {
            const workbook = readExcelWorkbook(filePath);
            for (const sheetName of workbook.SheetNames) {
                const sheet = workbook.Sheets[sheetName];
                const rawSheetData = parseSheetToJson(sheet, { header: 1, defval: null }) as any[][];

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

                    rawHeaders.forEach(h => {
                        if (!h) return;
                        if (headerCounts[h]) {
                            headerCounts[h]++;
                            sheetHeaders.push(`${h}_${headerCounts[h]}`);
                        } else {
                            headerCounts[h] = 1;
                            sheetHeaders.push(h);
                        }
                    });

                    if (detectedHeaders.length === 0) {
                        detectedHeaders = sheetHeaders;
                    }

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
                            rawRows.push(rowObj);
                        }
                    });
                }
            }
        } catch (readErr: any) {
            console.error(`[Excel Error] Error leyendo ${fileName}:`, readErr.message);
        }
    }

    try { fs.rmSync(exportRoot, { recursive: true, force: true }); } catch (_) {}

    // Auto-detect mappings using MAPPABLE_FIELDS dictionary
    const autoMappings: Record<string, string> = {};
    for (const key in MAPPABLE_FIELDS) {
        const field = MAPPABLE_FIELDS[key];
        const allAliases = [field.label.toLowerCase(), ...(field.aliases || [])];
        const foundHeader = detectedHeaders.find(h => {
            const originalHeader = h.replace(/_\d+$/, '').toLowerCase().trim();
            return allAliases.includes(originalHeader);
        });
        if (foundHeader) {
            autoMappings[key] = foundHeader;
        }
    }

    console.log('[Mapeo Automático]', autoMappings);
    console.log(`[Procesamiento] Filas crudas extraídas: ${rawRows.length}`);

    // Step 4: Group rows into ECN objects and Component Changes
    const ecnsMap = new Map<string, any>();

    for (const row of rawRows) {
        const ecnVal = autoMappings.ecn ? cleanEcn(row[autoMappings.ecn]) : '';
        if (!ecnVal) continue;

        const assemblyVal = autoMappings.assembly ? String(row[autoMappings.assembly] || '').trim() : '';
        const assemblyDesc = autoMappings.assemblyDescription ? String(row[autoMappings.assemblyDescription] || '').trim() : '';
        const assemblyRev = autoMappings.assemblyRevision ? String(row[autoMappings.assemblyRevision] || '').trim() : '';
        const oldComp = autoMappings.oldComponent ? String(row[autoMappings.oldComponent] || '').trim() : '';
        const newComp = autoMappings.newComponent ? String(row[autoMappings.newComponent] || '').trim() : '';
        const newCompRev = autoMappings.newComponentRevision ? String(row[autoMappings.newComponentRevision] || '').trim() : '';
        const newCompDesc = autoMappings.newComponentDescription ? String(row[autoMappings.newComponentDescription] || '').trim() : '';
        const oldSub = autoMappings.oldSubassembly ? String(row[autoMappings.oldSubassembly] || '').trim() : '';
        const newSub = autoMappings.newSubassembly ? String(row[autoMappings.newSubassembly] || '').trim() : '';
        const newSubRev = autoMappings.newSubassemblyRevision ? String(row[autoMappings.newSubassemblyRevision] || '').trim() : '';
        const newSubDesc = autoMappings.newSubassemblyDescription ? String(row[autoMappings.newSubassemblyDescription] || '').trim() : '';
        const startDateVal = autoMappings.startDate ? parseDateIso(row[autoMappings.startDate]) : null;
        const createdByVal = autoMappings.createdBy ? String(row[autoMappings.createdBy] || '').trim() : '';
        const createdOnVal = autoMappings.createdOn ? parseDateIso(row[autoMappings.createdOn]) : null;
        const descVal = autoMappings.description ? String(row[autoMappings.description] || '').trim() : '';
        const skuVal = autoMappings.sku ? String(row[autoMappings.sku] || '').trim() : '';
        const familyVal = autoMappings.family ? String(row[autoMappings.family] || '').trim() : 'VESDA';
        const siteVal = autoMappings.site ? String(row[autoMappings.site] || '').trim() : plant;
        const demandVal = autoMappings.demand ? parseNumericValue(row[autoMappings.demand]) : 0;
        const onHandVal = autoMappings.onHandInventory ? parseNumericValue(row[autoMappings.onHandInventory]) : 0;
        const openPoVal = autoMappings.openPoQty ? parseNumericValue(row[autoMappings.openPoQty]) : 0;

        if (!ecnsMap.has(ecnVal)) {
            ecnsMap.set(ecnVal, {
                id: ecnVal,
                initiator: createdByVal || 'SAP CMD Automation',
                description: descVal || `ECN ${ecnVal} extraído desde SAP ZPP_CC07`,
                status: 'Pendiente',
                creationDate: createdOnVal || new Date().toISOString().split('T')[0],
                implementationDate: startDateVal || null,
                changes: [],
                notes: []
            });
        }

        const ecnObj = ecnsMap.get(ecnVal);
        if (createdByVal && (!ecnObj.initiator || ecnObj.initiator === 'SAP CMD Automation')) {
            ecnObj.initiator = createdByVal;
        }
        if (descVal && (!ecnObj.description || ecnObj.description.startsWith('ECN '))) {
            ecnObj.description = descVal;
        }

        if (assemblyVal || oldComp || newComp) {
            ecnObj.changes.push({
                assembly: assemblyVal,
                assemblyRevision: assemblyRev,
                assemblyDescription: assemblyDesc || descVal,
                oldComponent: oldComp,
                newComponent: newComp,
                newComponentRevision: newCompRev,
                newComponentDescription: newCompDesc,
                oldSubassembly: oldSub,
                newSubassembly: newSub,
                newSubassemblyRevision: newSubRev,
                newSubassemblyDescription: newSubDesc,
                sku: skuVal,
                family: familyVal || 'VESDA',
                demand: demandVal,
                onHandInventory: onHandVal,
                openPoQty: openPoVal,
                startDate: startDateVal || new Date().toISOString().split('T')[0],
                site: siteVal || plant
            });
        }
    }

    const ecnListToProcess = Array.from(ecnsMap.values());
    console.log(`[Agrupación] Total de ECNs estructurados: ${ecnListToProcess.length}`);

    // Step 5: Optional Batch Description Enrichment via CC03/IQS3
    const missingDescEcns = ecnListToProcess
        .filter(e => !e.description || e.description.startsWith('ECN ') || e.description.startsWith('ZPP_CC07'))
        .map(e => e.id);

    if (missingDescEcns.length > 0 && process.platform === 'win32') {
        console.log(`[Descripciones] Consultando SAP GUI (CC03/IQS3) para ${missingDescEcns.length} ECNs...`);
        const descMap = await enrichDescriptionsFromSap(missingDescEcns);
        for (const ecnObj of ecnListToProcess) {
            if (descMap.has(ecnObj.id)) {
                ecnObj.description = descMap.get(ecnObj.id)!;
            }
        }
    }

    // Step 6: Upsert into Database with Transaction
    console.log('[DB] Ejecutando sincronización y actualización masiva en base de datos...');
    const transaction = new sql.Transaction(db.pool);
    await transaction.begin();

    let newCount = 0;
    let updatedCount = 0;
    const newEcnsList: string[] = [];
    const updatedEcnsList: string[] = [];

    try {
        for (const ecn of ecnListToProcess) {
            const initiator = ecn.initiator || 'SAP CMD Automation';

            // Ensure initiator exists in users table
            const userCheck = await transaction.request()
                .input('uid', sql.NVarChar, initiator)
                .query("SELECT id FROM users WHERE id = @uid");

            if (userCheck.recordset.length === 0) {
                await transaction.request()
                    .input('uid', sql.NVarChar, initiator)
                    .input('name', sql.NVarChar, initiator)
                    .query("INSERT INTO users (id, name) VALUES (@uid, @name)");
            }

            const reqEcn = transaction.request();
            reqEcn.input('id', sql.NVarChar, ecn.id);
            const existCheck = await reqEcn.query("SELECT id FROM ecns WHERE id = @id");
            const isUpdate = existCheck.recordset.length > 0;

            reqEcn.input('init', sql.NVarChar, initiator);
            reqEcn.input('desc', sql.NVarChar, ecn.description || `ECN ${ecn.id}`);
            reqEcn.input('stat', sql.NVarChar, ecn.status || 'Pendiente');
            reqEcn.input('cdat', sql.Date, ecn.creationDate ? new Date(ecn.creationDate) : new Date());
            reqEcn.input('idat', sql.Date, ecn.implementationDate ? new Date(ecn.implementationDate) : null);

            if (isUpdate) {
                await reqEcn.query("UPDATE ecns SET initiator=@init, description=@desc, status=@stat, implementation_date=@idat WHERE id=@id");
                updatedCount++;
                updatedEcnsList.push(ecn.id);
            } else {
                await reqEcn.query("INSERT INTO ecns (id, initiator, description, status, creation_date, implementation_date) VALUES (@id, @init, @desc, @stat, @cdat, @idat)");
                newCount++;
                newEcnsList.push(ecn.id);
            }

            // Insert / Update component changes
            for (const change of ecn.changes) {
                const cReq = transaction.request();
                cReq.input('ecn_id', sql.NVarChar, ecn.id);
                cReq.input('assembly', sql.NVarChar, change.assembly || '');
                cReq.input('old_comp', sql.NVarChar, change.oldComponent || '');
                cReq.input('new_comp', sql.NVarChar, change.newComponent || '');
                cReq.input('site', sql.NVarChar, change.site || plant);

                const existComp = await cReq.query(`
                    SELECT id FROM component_changes 
                    WHERE ecn_id = @ecn_id AND assembly = @assembly AND old_component = @old_comp AND new_component = @new_comp AND site = @site
                `);

                const uReq = transaction.request();
                uReq.input('ecn_id', sql.NVarChar, ecn.id);
                uReq.input('assembly', sql.NVarChar, change.assembly || '');
                uReq.input('assembly_rev', sql.NVarChar, change.assemblyRevision || '');
                uReq.input('assembly_desc', sql.NVarChar, change.assemblyDescription || ecn.description || '');
                uReq.input('old_comp', sql.NVarChar, change.oldComponent || '');
                uReq.input('new_comp', sql.NVarChar, change.newComponent || '');
                uReq.input('new_comp_rev', sql.NVarChar, change.newComponentRevision || '');
                uReq.input('new_comp_desc', sql.NVarChar, change.newComponentDescription || '');
                uReq.input('old_sub', sql.NVarChar, change.oldSubassembly || '');
                uReq.input('new_sub', sql.NVarChar, change.newSubassembly || '');
                uReq.input('new_sub_rev', sql.NVarChar, change.newSubassemblyRevision || '');
                uReq.input('new_sub_desc', sql.NVarChar, change.newSubassemblyDescription || '');
                uReq.input('sku', sql.NVarChar, change.sku || '');
                uReq.input('family', sql.NVarChar, change.family || 'VESDA');
                uReq.input('demand', sql.Decimal(18, 2), change.demand || 0);
                uReq.input('on_hand', sql.Decimal(18, 2), change.onHandInventory || 0);
                uReq.input('open_po', sql.Decimal(18, 2), change.openPoQty || 0);
                uReq.input('sdate', sql.Date, change.startDate ? new Date(change.startDate) : new Date());
                uReq.input('site', sql.NVarChar, change.site || plant);

                if (existComp.recordset.length > 0) {
                    uReq.input('comp_id', sql.UniqueIdentifier, existComp.recordset[0].id);
                    await uReq.query(`
                        UPDATE component_changes SET
                            assembly_revision = @assembly_rev,
                            assembly_description = @assembly_desc,
                            new_component_revision = @new_comp_rev,
                            new_component_description = @new_comp_desc,
                            old_subassembly = @old_sub,
                            new_subassembly = @new_sub,
                            new_subassembly_revision = @new_sub_rev,
                            new_subassembly_description = @new_sub_desc,
                            sku = @sku,
                            family = @family,
                            demand = @demand,
                            on_hand_inventory = @on_hand,
                            open_po_qty = @open_po,
                            start_date = @sdate
                        WHERE id = @comp_id
                    `);
                } else {
                    await uReq.query(`
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

        const durationMs = Date.now() - startTime;
        const fileNameFormatted = `SAP_ZPP_CC07_Planta_${plant}_${startDate}_a_${endDate}`;

        const newEcnsStr = newEcnsList.length > 0 ? newEcnsList.join(', ') : 'Ninguno';
        const updatedEcnsStr = updatedEcnsList.length > 0 ? updatedEcnsList.join(', ') : 'Ninguno';

        // Exact Audit Log details required:
        // "Importación SAP (Optimizada): SAP_ZPP_CC07_Planta_5205_2026-08-21_a_2026-09-30 Por cmd . 0 nuevos, 5 actualizados (3141ms). ECN NUEVOS XXX-XXX ECS ACTUALIZADOS XXXX-XXX )"
        const auditActionText = `Importación SAP (Optimizada): ${fileNameFormatted} Por cmd . ${newCount} nuevos, ${updatedCount} actualizados (${durationMs}ms). ECN NUEVOS ${newEcnsStr} ECS ACTUALIZADOS ${updatedEcnsStr} )`;

        // 1. Insert into import_logs
        await transaction.request()
            .input('ts', sql.DateTimeOffset, new Date())
            .input('file', sql.NVarChar, `${fileNameFormatted} (cmd)`)
            .input('total', sql.Int, ecnListToProcess.length)
            .input('new_ecns', sql.NVarChar, `${newCount} nuevos`)
            .input('upd_ecns', sql.NVarChar, `${updatedCount} actualizados`)
            .input('details', sql.NVarChar, auditActionText)
            .query("INSERT INTO import_logs (timestamp, file_name, total_records, new_ecns, updated_ecns, details) VALUES (@ts, @file, @total, @new_ecns, @upd_ecns, @details)");

        // 2. Insert into audit_log
        await transaction.request()
            .input('aid', sql.UniqueIdentifier, uuidv4())
            .input('uts', sql.DateTimeOffset, new Date())
            .input('uuser', sql.NVarChar, 'Sistema (CMD Task)')
            .input('utype', sql.NVarChar, 'Importación')
            .input('utarget', sql.NVarChar, fileNameFormatted)
            .input('uact', sql.NVarChar, auditActionText)
            .query("INSERT INTO audit_log (id, timestamp, [user], type, target, action) VALUES (@aid, @uts, @uuser, @utype, @utarget, @uact)");

        await transaction.commit();

        console.log('================================================================');
        console.log('                 SINCRONIZACIÓN SAP EXITOSA                     ');
        console.log('================================================================');
        console.log(`[Resultado] Nuevos: ${newCount} | Actualizados: ${updatedCount} | Tiempo: ${durationMs}ms`);
        console.log(`[Auditoría] ${auditActionText}`);
        console.log('================================================================');
        process.exit(0);

    } catch (dbErr: any) {
        if (transaction) await transaction.rollback();
        console.error('[Error Crítico de BD]', dbErr);
        process.exit(1);
    }
}

// Run the script
runStandaloneSapSync().catch(err => {
    console.error('[Fatal Error]', err);
    process.exit(1);
});
