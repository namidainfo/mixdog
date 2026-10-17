Option Explicit
If WScript.Arguments.Count <> 4 Then WScript.Quit 64
Dim shell, command, result
Set shell = CreateObject("WScript.Shell")
command = Quote(WScript.Arguments(0)) & " -NoLogo -NoProfile -NonInteractive -File " _
    & Quote(WScript.Arguments(1)) & " -Installer " & Quote(WScript.Arguments(2)) _
    & " -BackupRoot " & Quote(WScript.Arguments(3))
result = shell.Run(command, 0, True)
WScript.Quit result

Function Quote(value)
    Quote = Chr(34) & Replace(value, Chr(34), Chr(34) & Chr(34)) & Chr(34)
End Function
