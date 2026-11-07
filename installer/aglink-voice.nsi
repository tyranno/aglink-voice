; aglink 음성 setup (NSIS 3). Built by build.ps1, which passes
;   VERSION  extension version (0.5.0)
;   STAGE    installer\stage: base\ (engine, models, whisper\cpu, the .vsix), gpu\ (whisper\cuda)
;   OUTDIR   where the .exe goes
;   GPU      defined: the NVIDIA add-on instead of the main setup
;
; Installs for this Windows user only, into %LOCALAPPDATA%\aglink-voice — the
; place the extension looks by default — so no administrator rights are asked.
; Nothing is downloaded; the extension is installed with VS Code's own `code`.

Unicode true
!include "MUI2.nsh"
!include "LogicLib.nsh"
!include "FileFunc.nsh"
!include "x64.nsh"

!define UNINST_KEY "Software\Microsoft\Windows\CurrentVersion\Uninstall\aglink-voice"

!ifdef GPU
  Name "aglink 음성 그래픽카드 가속"
  OutFile "${OUTDIR}\aglink-voice-gpu-${VERSION}.exe"
!else
  Name "aglink 음성"
  OutFile "${OUTDIR}\aglink-voice-setup-${VERSION}.exe"
!endif
InstallDir "$LOCALAPPDATA\aglink-voice"
RequestExecutionLevel user
SetCompressor /SOLID lzma
SetCompressorDictSize 64
ShowInstDetails show
ShowUninstDetails show
BrandingText "aglink-voice ${VERSION}"

!define MUI_ABORTWARNING
!ifdef GPU
  !define MUI_WELCOMEPAGE_TEXT "엔비디아 그래픽카드로 받아쓰기를 빠르게 하는 추가 파일이에요.$\r$\n$\r$\n먼저 aglink 음성이 설치돼 있어야 해요. 관리자 권한은 필요 없어요.$\r$\n$\r$\n설치하는 동안 음성 엔진이 잠깐 꺼졌다가, 다음에 음성을 켤 때 그래픽카드로 다시 시작해요."
  !define MUI_FINISHPAGE_TEXT "설치가 끝났어요.$\r$\n$\r$\nVS Code 에서 음성을 다시 켜면 그래픽카드로 받아 적어요."
!else
  !define MUI_WELCOMEPAGE_TEXT "VS Code 의 Claude Code 에 말로 묻고 답을 소리로 듣는 확장이에요.$\r$\n$\r$\n받아쓰기, 읽기 목소리 10개, 목소리 구별이 모두 이 PC 안에서 돌아요. 인터넷에서 더 받는 것은 없고, 관리자 권한도 필요 없어요.$\r$\n$\r$\nVS Code 가 먼저 설치돼 있어야 해요."
  !define MUI_FINISHPAGE_TEXT "설치가 끝났어요.$\r$\n$\r$\n1. VS Code 를 다시 시작하세요.$\r$\n2. 오른쪽 아래 '음성' 버튼 → '내 목소리 등록' 으로 15초 동안 말해 주세요.$\r$\n3. Ctrl+Alt+V 로 음성을 켜고 말로 물어보세요.$\r$\n$\r$\n엔비디아 그래픽카드가 있으면 aglink-voice-gpu 추가 파일로 받아쓰기가 빨라져요."
!endif
!insertmacro MUI_PAGE_WELCOME
!insertmacro MUI_PAGE_INSTFILES
!insertmacro MUI_PAGE_FINISH
!ifndef GPU
  !insertmacro MUI_UNPAGE_CONFIRM
  !insertmacro MUI_UNPAGE_INSTFILES
!endif
!insertmacro MUI_LANGUAGE "Korean"

; StopEngine closes the engine and its Whisper if they run from here, so their
; files can be replaced. The extension starts the engine again when needed.
; Another app's whisper-server (the aglink desktop app's) is left alone.
!macro STOP_ENGINE un
Function ${un}StopEngine
  nsExec::Exec `powershell -NoProfile -ExecutionPolicy Bypass -Command "Get-Process aglink-voice-engine,whisper-server -ErrorAction SilentlyContinue | Where-Object { $$_.Path -like '$INSTDIR\*' } | Stop-Process -Force"`
  Pop $0
  Sleep 500
FunctionEnd
!macroend
!insertmacro STOP_ENGINE ""
!ifndef GPU
  !insertmacro STOP_ENGINE "un."
!endif

; FindCode puts VS Code's command-line launcher (code.cmd) in $R0, or "".
!macro FIND_CODE un
Function ${un}FindCode
  StrCpy $R0 "$LOCALAPPDATA\Programs\Microsoft VS Code\bin\code.cmd"
  IfFileExists $R0 found
  ${If} ${RunningX64}
    ExpandEnvStrings $R0 "%ProgramW6432%\Microsoft VS Code\bin\code.cmd"
    IfFileExists $R0 found
  ${EndIf}
  StrCpy $R0 "$PROGRAMFILES\Microsoft VS Code\bin\code.cmd"
  IfFileExists $R0 found
  nsExec::ExecToStack `powershell -NoProfile -Command "[Console]::Write((Get-Command code.cmd -ErrorAction SilentlyContinue | Select-Object -First 1).Source)"`
  Pop $0
  Pop $R0
  IfFileExists $R0 found
  StrCpy $R0 ""
  found:
  ; A shell opened from VS Code passes this on, and it makes `code` start as plain Node.
  System::Call 'kernel32::SetEnvironmentVariable(t "ELECTRON_RUN_AS_NODE", p 0)'
FunctionEnd
!macroend
!ifndef GPU
  !insertmacro FIND_CODE ""
  !insertmacro FIND_CODE "un."
!endif

!ifdef GPU

Function .onInit
  ${IfNot} ${FileExists} "$INSTDIR\engine\aglink-voice-engine.exe"
    MessageBox MB_ICONEXCLAMATION "aglink 음성이 설치돼 있지 않아요.$\r$\n먼저 aglink-voice-setup 을 설치한 다음 이 추가 파일을 실행해 주세요."
    Quit
  ${EndIf}
  ${DisableX64FSRedirection}
  StrCpy $0 "no"
  ${If} ${FileExists} "$WINDIR\System32\nvcuda.dll"
    StrCpy $0 "yes"
  ${EndIf}
  ${EnableX64FSRedirection}
  ${If} $0 == "no"
    MessageBox MB_YESNO|MB_ICONQUESTION "이 PC 에서 엔비디아 그래픽카드 드라이버를 찾지 못했어요.$\r$\n설치해도 받아쓰기는 지금처럼 CPU 로 해요. 그래도 설치할까요?" IDYES gpuGo
    Quit
    gpuGo:
  ${EndIf}
FunctionEnd

Section "GPU"
  Call StopEngine
  SetOutPath "$INSTDIR\whisper\cuda"
  File /r "${STAGE}\gpu\whisper\cuda\*.*"
  ${GetSize} "$INSTDIR" "/S=0K" $0 $1 $2
  WriteRegDWORD HKCU "${UNINST_KEY}" "EstimatedSize" $0
SectionEnd

!else

Function .onInit
  Call FindCode
  ${If} $R0 == ""
    MessageBox MB_ICONEXCLAMATION "VS Code 를 찾지 못했어요.$\r$\nVS Code 를 먼저 설치한 다음 이 설치 파일을 다시 실행해 주세요."
    Quit
  ${EndIf}
FunctionEnd

Section "aglink 음성"
  Call StopEngine
  ; The engine and models of an earlier version are replaced; the GPU add-on and
  ; the user's enrolled voice (kept by VS Code, not here) stay.
  RMDir /r "$INSTDIR\engine"
  RMDir /r "$INSTDIR\models"
  RMDir /r "$INSTDIR\whisper\cpu"

  SetOutPath "$INSTDIR"
  File /r "${STAGE}\base\*.*"
  WriteUninstaller "$INSTDIR\uninstall.exe"

  DetailPrint "VS Code 에 확장을 설치하는 중..."
  Call FindCode
  nsExec::ExecToLog `cmd /c ""$R0" --install-extension "$INSTDIR\aglink-voice.vsix" --force"`
  Pop $0
  ${If} $0 != 0
    MessageBox MB_ICONEXCLAMATION "VS Code 에 확장을 설치하지 못했어요 ($0).$\r$\nVS Code 의 확장 화면에서 '...' → 'VSIX에서 설치' 로$\r$\n$INSTDIR\aglink-voice.vsix 를 골라 주세요."
  ${EndIf}

  WriteRegStr HKCU "${UNINST_KEY}" "DisplayName" "aglink 음성 (VS Code)"
  WriteRegStr HKCU "${UNINST_KEY}" "DisplayVersion" "${VERSION}"
  WriteRegStr HKCU "${UNINST_KEY}" "Publisher" "aglink"
  WriteRegStr HKCU "${UNINST_KEY}" "InstallLocation" "$INSTDIR"
  WriteRegStr HKCU "${UNINST_KEY}" "UninstallString" '"$INSTDIR\uninstall.exe"'
  WriteRegDWORD HKCU "${UNINST_KEY}" "NoModify" 1
  WriteRegDWORD HKCU "${UNINST_KEY}" "NoRepair" 1
  ${GetSize} "$INSTDIR" "/S=0K" $0 $1 $2
  WriteRegDWORD HKCU "${UNINST_KEY}" "EstimatedSize" $0
SectionEnd

Section "Uninstall"
  Call un.StopEngine
  Call un.FindCode
  ${If} $R0 != ""
    DetailPrint "VS Code 에서 확장을 지우는 중..."
    nsExec::ExecToLog `cmd /c ""$R0" --uninstall-extension aglink.aglink-voice"`
    Pop $0
  ${EndIf}
  RMDir /r "$INSTDIR"
  DeleteRegKey HKCU "${UNINST_KEY}"
SectionEnd

!endif
