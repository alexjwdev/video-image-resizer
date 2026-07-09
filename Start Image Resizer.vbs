' Silent launcher — runs launch.ps1 with no console window flash.
' Double-click this file to start Image Resizer.
Dim sh, dir
Set sh  = CreateObject("WScript.Shell")
dir = Left(WScript.ScriptFullName, InStrRev(WScript.ScriptFullName, "\"))
sh.Run "powershell.exe -ExecutionPolicy Bypass -NoProfile -WindowStyle Hidden -File """ & dir & "launch.ps1""", 0, False
