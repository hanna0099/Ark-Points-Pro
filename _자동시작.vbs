Option Explicit
Dim WshShell, nodePath, userProfile, helperDir, arkDir
Set WshShell = CreateObject("WScript.Shell")
nodePath = "C:\Program Files\nodejs\node.exe"
userProfile = WshShell.ExpandEnvironmentStrings("%USERPROFILE%")
helperDir = userProfile & "\Desktop\premiere-helper"
arkDir = userProfile & "\Desktop\ark-points-pro"

Function IsPortListening(portNum)
  Dim exec, output, arr, ln, i, marker, found
  Set exec = WshShell.Exec("netstat -an -p TCP")
  output = exec.StdOut.ReadAll()
  arr = Split(output, vbCrLf)
  marker = ":" & portNum & " "
  found = False
  For i = 0 To UBound(arr)
    ln = arr(i)
    If InStr(ln, marker) > 0 Then
      If InStr(ln, "LISTENING") > 0 Then
        found = True
      End If
    End If
  Next
  IsPortListening = found
End Function

If Not IsPortListening(3737) Then
  WshShell.CurrentDirectory = helperDir
  WshShell.Run """" & nodePath & """ server.js", 0, False
End If

WScript.Sleep 500

If Not IsPortListening(3838) Then
  WshShell.CurrentDirectory = arkDir
  WshShell.Run """" & nodePath & """ server.js", 0, False
End If
