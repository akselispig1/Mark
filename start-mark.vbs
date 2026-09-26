' Starts Mark silently (no console window) and opens the orb. Double-click it when you want him.
' He does NOT start by himself at login.
Set fso = CreateObject("Scripting.FileSystemObject")
dir = fso.GetParentFolderName(WScript.ScriptFullName)
Set sh = CreateObject("WScript.Shell")
sh.CurrentDirectory = dir
sh.Run "node """ & dir & "\launch.js""", 0, False
