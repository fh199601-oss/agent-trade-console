Option Explicit
Dim fs, shell, root, python, args, i
Set fs = CreateObject("Scripting.FileSystemObject")
Set shell = CreateObject("WScript.Shell")
root = fs.GetParentFolderName(WScript.ScriptFullName)
python = root & "\portable\python\pythonw.exe"
If Not fs.FileExists(python) Then
  MsgBox "Please download and extract the Windows portable release ZIP. This source archive does not contain a runtime.", 48, "AGENT"
  WScript.Quit 1
End If
shell.CurrentDirectory = root
shell.Run Chr(34) & python & Chr(34) & " " & Chr(34) & root & "\desktop.py" & Chr(34), 0, False
