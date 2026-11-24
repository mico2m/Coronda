' Coronda Juego: doble clic para abrirlo como programa (sin terminal ni pestanas).
' Arranca el servidor escondido y abre una ventana propia; al cerrarla se apaga el servidor.
Set sh = CreateObject("WScript.Shell")
Set fso = CreateObject("Scripting.FileSystemObject")
dir = fso.GetParentFolderName(WScript.ScriptFullName)
sh.CurrentDirectory = dir
If sh.Run("cmd /c where node", 0, True) <> 0 Then
  MsgBox "No encuentro Node.js. Instalalo desde https://nodejs.org y volve a probar.", 48, "Coronda"
  WScript.Quit 1
End If
sh.Run "node """ & dir & "\studio\launch.js"" juego", 0, False
