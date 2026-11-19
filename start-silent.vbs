' =========================================================================
' INICIAR ECNS 100% INVISIBLE EN WINDOWS (SIN NINGUNA VENTANA CMD / CONSOLA)
' =========================================================================
Set objShell = CreateObject("WScript.Shell")
Set objFSO = CreateObject("Scripting.FileSystemObject")
strScriptPath = objFSO.GetParentFolderName(WScript.ScriptFullName)

objShell.CurrentDirectory = strScriptPath
' El valor 0 oculta totalmente cualquier ventana de consola
objShell.Run "cmd.exe /c npx pm2 start ecosystem.config.cjs --env production", 0, False
