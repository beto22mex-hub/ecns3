' run_ecn_macro.vbs
' Ejecuta la macro "Main" del archivo ECN_automation.xlsm de forma silenciosa
' Uso: cscript run_ecn_macro.vbs [plant] [startDate] [endDate]

Dim xlApp, xlWorkbook, xlPath
Dim argPlant, argStartDate, argEndDate

If WScript.Arguments.Count >= 1 Then argPlant     = Trim(WScript.Arguments(0)) Else argPlant     = "5205"
If WScript.Arguments.Count >= 2 Then argStartDate = Trim(WScript.Arguments(1)) Else argStartDate = ""
If WScript.Arguments.Count >= 3 Then argEndDate   = Trim(WScript.Arguments(2)) Else argEndDate   = ""

xlPath = "C:\Personal\ECN_automation.xlsm"

On Error Resume Next

Set xlApp = CreateObject("Excel.Application")
If Err.Number <> 0 Then
    WScript.Echo "ERROR: No se pudo iniciar Excel. " & Err.Description
    WScript.Quit 1
End If

xlApp.Visible = False
xlApp.DisplayAlerts = False
xlApp.EnableEvents = False
xlApp.ScreenUpdating = False
Err.Clear

Set xlWorkbook = xlApp.Workbooks.Open(xlPath, 0, False)
If Err.Number <> 0 Then
    WScript.Echo "ERROR: No se pudo abrir " & xlPath & ". " & Err.Description
    xlApp.Quit
    Set xlApp = Nothing
    WScript.Quit 1
End If

Err.Clear

On Error Resume Next
If argPlant <> "" Then
    xlWorkbook.Names("Plant_" & argPlant).RefersToRange.Value = True
End If
Err.Clear

xlApp.Run "Main"
If Err.Number <> 0 Then
    Err.Clear
    xlApp.Run "ECN_automation.xlsm!Main"
    If Err.Number <> 0 Then
        WScript.Echo "ERROR: No se pudo ejecutar la macro Main. " & Err.Description
        xlWorkbook.Close False
        xlApp.Quit
        Set xlWorkbook = Nothing
        Set xlApp = Nothing
        WScript.Quit 1
    End If
End If

Err.Clear
xlWorkbook.Save
xlWorkbook.Close True
xlApp.Quit
Set xlWorkbook = Nothing
Set xlApp = Nothing

WScript.Echo "OK: Macro ejecutada exitosamente."
WScript.Quit 0
