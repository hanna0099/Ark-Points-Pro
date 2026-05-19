Option Explicit
Dim WshShell, nodePath, userProfile, helperDir, arkDir
Set WshShell = CreateObject("WScript.Shell")
nodePath = "C:\Program Files\nodejs\node.exe"
userProfile = WshShell.ExpandEnvironmentStrings("%USERPROFILE%")
helperDir = userProfile & "\Desktop\premiere-helper"
arkDir = userProfile & "\Desktop\ark-points-pro"

' XMLHTTP로 포트 체크 - cmd 창 안 뜸 (100% 무음)
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
  ' 응답 받았으면(상태코드 무엇이든) 서버 살아있는 것
  IsPortListening = (Err.Number = 0 And http.Status >= 100 And http.Status <= 599)
  On Error GoTo 0
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
