Option Explicit
If WScript.Arguments.Count <> 4 Then WScript.Quit 64
Dim shell, command, result
Set shell = CreateObject("WScript.Shell")
command = Quote(WScript.Arguments(0)) & " " & Quote(WScript.Arguments(1)) _
    & " --origin " & Quote(WScript.Arguments(2)) _
    & " --tls-cert " & Quote(WScript.Arguments(3))
result = shell.Run(command, 0, True)
WScript.Quit result

Function Quote(value)
    Quote = Chr(34) & Replace(value, Chr(34), Chr(34) & Chr(34)) & Chr(34)
End Function
