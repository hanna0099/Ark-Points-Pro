Option Explicit
Dim WshShell, nodePath, userProfile, helperDir, arkDir
Set WshShell = CreateObject("WScript.Shell")
nodePath = "C:\Program Files\nodejs\node.exe"
userProfile = WshShell.ExpandEnvironmentStrings("%USERPROFILE%")
helperDir = userProfile & "\Desktop\premiere-helper"
arkDir = userProfile & "\Desktop\ark-points-pro"

Function IsPortListening(portNum)
  On Error Resume Next
  Dim http
  Set http = CreateObject("Msxml2.ServerXMLHTTP.6.0")
  If Err.Number <> 0 Then
    Err.Clear
    Set http = CreateObject("Msxml2.ServerXMLHTTP")
  End If
  http.SetTimeouts 300, 300, 300, 300
  http.Open "GET", "http://127.0.0.1:" & portNum & "/", False
  http.Send
  IsPortListening = (Err.Number = 0 And http.Status >= 100 And http.Status <= 599)
  On Error GoTo 0
End Function

Dim started
started = False

If Not IsPortListening(3737) Then
  WshShell.CurrentDirectory = helperDir
  WshShell.Run """" & nodePath & """ server.js", 0, False
  started = True
End If

WScript.Sleep 500

If Not IsPortListening(3838) Then
  WshShell.CurrentDirectory = arkDir
  WshShell.Run """" & nodePath & """ server.js", 0, False
  started = True
End If

If started Then WScript.Sleep 4000
WshShell.Run "http://localhost:3838", 1, False
