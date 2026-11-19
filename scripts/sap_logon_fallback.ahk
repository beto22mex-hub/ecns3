#NoTrayIcon
SetTitleMatchMode, 2
DetectHiddenWindows, On

; Activar ventana SAP Logon por título si existe
IfWinExist, SAP Logon
{
    WinActivate
    WinWaitActive, SAP Logon, , 3
    Sleep, 300
} else IfWinExist, SapLogon
{
    WinActivate
    WinWaitActive, SapLogon, , 3
    Sleep, 300
}

; Intentar seleccionar la conexión desde el control de lista y abrirla
; Reemplazar __TARGET_NAME__ desde PowerShell
$target := "__TARGET_NAME__"
; Primero intentamos operar sobre el control SysListView321 (común en SAP Logon)
ControlFocus, SysListView321, SAP Logon
Sleep, 150
; Enviar Home para asegurar posición inicial
ControlSend, SysListView321, {Home}, SAP Logon
Sleep, 150
; Intentar enviar el texto del sistema y presionar Enter
ControlSend, SysListView321, %$target%{Enter}, SAP Logon
Sleep, 300
; Algunos clientes requieren un segundo Enter para confirmar
ControlSend, SysListView321, {Enter}, SAP Logon
Sleep, 1000

; Si ControlSend no funciona, intentar enviar teclas globales como fallback
IfWinNotActive, SAP Logon
{
    ; no activa correctamente, intentar activar de nuevo
    WinActivate, SAP Logon
    Sleep, 300
}
Send, {TAB 4}
Sleep, 200
Send, %$target%
Sleep, 200
Send, {Enter}
Sleep, 300
Send, {Enter}
Sleep, 2000

ExitApp
