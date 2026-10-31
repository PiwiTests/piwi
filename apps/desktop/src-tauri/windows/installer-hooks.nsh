; NSIS installer hooks for the per-user .exe (`bundle > windows > nsis >
; installerHooks` in tauri.conf.json), inserted into Tauri's installer template.
;
; The template includes this file before it declares its pages, so the
; Modern UI defines below reach the pages it declares next, and the functions
; here are what those defines name. The NSIS_HOOK_* macros at the end run
; inside the install and uninstall sections.

; The app's data folder: Tauri's app_data_dir() for the `identifier` in
; tauri.conf.json. The port range and default match `valid_port` and
; `DEFAULT_PORT` in src/lib.rs.
!define PIWI_APP_DATA "$APPDATA\io.piwitests.dashboard"
!define PIWI_DEFAULT_PORT 3000
!define PIWI_MIN_PORT 1024
!define PIWI_MAX_PORT 65535

; ---------------------------------------------------------------------------
; Look and words of the pages.

!define MUI_ABORTWARNING
!define MUI_HEADERIMAGE_RIGHT
!define MUI_CUSTOMFUNCTION_GUIINIT PiwiReadSavedPort

; Taken by the welcome page, the first page the template declares.
!define MUI_WELCOMEPAGE_TITLE "Welcome to Piwi Dashboard"
!define MUI_WELCOMEPAGE_TEXT "Setup will install Piwi Dashboard for your account. It needs no administrator rights.$\r$\n$\r$\nThe dashboard runs on this computer and keeps your Playwright results here. It listens on 127.0.0.1 only, so nothing is exposed to your network.$\r$\n$\r$\nChange the port below only if another program already uses it. You can change it later on the app's Setup page."
!define MUI_PAGE_CUSTOMFUNCTION_SHOW PiwiWelcomeShow
!define MUI_PAGE_CUSTOMFUNCTION_LEAVE PiwiWelcomeLeave

; Taken by the finish page.
!define MUI_FINISHPAGE_TITLE "Piwi Dashboard is installed"
!define MUI_FINISHPAGE_TEXT "Open it to connect your first Playwright project: its Setup page walks you through it."
!define MUI_FINISHPAGE_LINK "Read the desktop app guide"
!define MUI_FINISHPAGE_LINK_LOCATION "https://piwitests.dev/features/desktop"
!define MUI_FINISHPAGE_LINK_COLOR 7C3AED

; ---------------------------------------------------------------------------
; The port the bundled server listens on.
;
; The welcome page shows the port the app is set to (`serverPort` in its
; settings.json), or the default. When the user picks another one, the install
; writes it to installer.json in the app's data folder; the app moves it into
; settings.json on its next start (`adopt_installer_choices` in src/lib.rs).
; Silent and passive installs, the updater's included, skip the welcome page
; and leave the setting alone.

Var PiwiSavedPort
Var PiwiPort
Var PiwiPortField

; Before the window shows: the port in the app's settings, when there is a valid one.
Function PiwiReadSavedPort
  Push $0
  Push $1
  StrCpy $PiwiSavedPort ${PIWI_DEFAULT_PORT}
  System::Call 'kernel32::SetEnvironmentVariable(t "PIWI_SETTINGS", t "${PIWI_APP_DATA}\settings.json")'
  nsExec::ExecToStack `"$SYSDIR\WindowsPowerShell\v1.0\powershell.exe" -NoProfile -NonInteractive -Command "$$p = (Get-Content -Raw -Encoding UTF8 -LiteralPath $$env:PIWI_SETTINGS -ErrorAction Stop | ConvertFrom-Json).serverPort; if ($$p -is [int] -or $$p -is [long]) { $$p }"`
  Pop $0 ; exit code
  Pop $1 ; output: the port and a line break, or nothing
  ${If} $0 == 0
    IntOp $1 $1 + 0
    ${If} $1 >= ${PIWI_MIN_PORT}
    ${AndIf} $1 <= ${PIWI_MAX_PORT}
      StrCpy $PiwiSavedPort $1
    ${EndIf}
  ${EndIf}
  StrCpy $PiwiPort $PiwiSavedPort
  Pop $1
  Pop $0
FunctionEnd

; Adds the port field under the welcome text. MUI sizes that text to fill the
; page (to 175u of 193u), so the label, found by its text, is cut to 88u and
; the field placed under it; when the label is not found, the field goes to the
; bottom of the page instead.
Function PiwiWelcomeShow
  Push $0
  Push $1
  Push $2
  Push $3
  Push $4
  StrCpy $1 0
  ${Do}
    FindWindow $1 "#32770" "" $HWNDPARENT $1
    ${IfThen} $1 = 0 ${|} ${Break} ${|}
    FindWindow $2 "Static" "${MUI_WELCOMEPAGE_TEXT}" $1
    ${IfThen} $2 <> 0 ${|} ${Break} ${|}
  ${Loop}
  ${If} $1 <> 0
    System::Call "*(i 0, i 0, i 195, i 88) p .r3"
    System::Call "user32::MapDialogRect(p r1, p r3)"
    System::Call "*$3(i, i, i .r0, i .r4)"
    System::Free $3
    System::Call "user32::SetWindowPos(p r2, p 0, i 0, i 0, i r0, i r4, i 0x16)"
    StrCpy $0 140
  ${Else}
    StrCpy $0 177
  ${EndIf}
  IntOp $1 $0 + 3
  ${NSD_CreateLabel} 120u $1u 62u 10u "Dashboard port:"
  Pop $1
  SetCtlColors $1 "000000" "FFFFFF"
  ${NSD_CreateNumber} 184u $0u 36u 13u "$PiwiPort"
  Pop $PiwiPortField
  ${NSD_Edit_SetTextLimit} $PiwiPortField 5
  Pop $4
  Pop $3
  Pop $2
  Pop $1
  Pop $0
FunctionEnd

; Keeps the page until the field holds a valid port. IntOp reads a leading 0 as
; octal, and no valid port starts with one, so such an entry is refused.
Function PiwiWelcomeLeave
  Push $0
  Push $1
  Push $2
  ${NSD_GetText} $PiwiPortField $0
  IntOp $1 $0 + 0
  StrCpy $2 $0 1
  ${If} $2 == ""
  ${OrIf} $2 == "0"
  ${OrIf} $1 < ${PIWI_MIN_PORT}
  ${OrIf} $1 > ${PIWI_MAX_PORT}
    MessageBox MB_ICONEXCLAMATION|MB_OK "Choose a port between ${PIWI_MIN_PORT} and ${PIWI_MAX_PORT}."
    ${NSD_SetFocus} $PiwiPortField
    Pop $2
    Pop $1
    Pop $0
    Abort
  ${EndIf}
  StrCpy $PiwiPort $1
  Pop $2
  Pop $1
  Pop $0
FunctionEnd

!macro PIWI_SAVE_PORT
  ${If} $PiwiPort != ""
  ${AndIf} $PiwiPort != $PiwiSavedPort
    Push $0
    CreateDirectory "${PIWI_APP_DATA}"
    ClearErrors
    FileOpen $0 "${PIWI_APP_DATA}\installer.json" w
    ${IfNot} ${Errors}
      FileWrite $0 '{ "serverPort": $PiwiPort }$\r$\n'
      FileClose $0
      DetailPrint "Piwi Dashboard will listen on port $PiwiPort."
    ${EndIf}
    Pop $0
  ${EndIf}
!macroend

; ---------------------------------------------------------------------------
; The server sidecar.
;
; The app runs its server as a Node sidecar (`node.exe` beside the main binary)
; that keeps the bundled native modules loaded — sharp's libvips DLLs among them.
; Tauri's installer only stops the main binary, so a sidecar still running holds
; those files locked and the copy fails with "Error opening file for writing".
; That happens whenever the app stops without its quit cleanup: an update
; started by a build whose updater leaves the sidecar running (0.37 and earlier,
; see src/updates.rs), a kill from Task Manager, or the installer's own "close
; the app" step.
;
; So before any file is written or removed: run that app check first (a stopped
; app cannot restart the sidecar behind us; the template's own check then finds
; nothing), then stop the node.exe running from this install folder. Matched on
; its full path, never on the name alone, which would also kill the user's own
; Node processes.

!macro PIWI_STOP_SIDECAR
  Push $0
  ; The 64-bit PowerShell where there is one: the installer is a 32-bit process,
  ; and a 32-bit PowerShell cannot read the path of the 64-bit sidecar.
  StrCpy $0 "$SYSDIR\WindowsPowerShell\v1.0\powershell.exe"
  ${If} ${FileExists} "$WINDIR\Sysnative\WindowsPowerShell\v1.0\powershell.exe"
    StrCpy $0 "$WINDIR\Sysnative\WindowsPowerShell\v1.0\powershell.exe"
  ${EndIf}
  ; The folder travels in the environment rather than inside the command, so no
  ; install path (spaces, apostrophes, brackets) can break the quoting.
  System::Call 'kernel32::SetEnvironmentVariable(t "PIWI_INSTDIR", t "$INSTDIR")'
  nsExec::Exec `"$0" -NoProfile -NonInteractive -Command "Get-Process -Name node -ErrorAction SilentlyContinue | Where-Object { $$_.Path -eq ($$env:PIWI_INSTDIR + '\node.exe') } | Stop-Process -Force -PassThru | Wait-Process -Timeout 10 -ErrorAction SilentlyContinue"`
  Pop $0 ; nsExec's exit code — best-effort, a failure leaves the install as before
  Pop $0
!macroend

; ---------------------------------------------------------------------------
; Hooks.

!macro NSIS_HOOK_PREINSTALL
  !insertmacro CheckIfAppIsRunning "${MAINBINARYNAME}.exe" "${PRODUCTNAME}"
  !insertmacro PIWI_STOP_SIDECAR
!macroend

!macro NSIS_HOOK_POSTINSTALL
  !insertmacro PIWI_SAVE_PORT
!macroend

!macro NSIS_HOOK_PREUNINSTALL
  !insertmacro CheckIfAppIsRunning "${MAINBINARYNAME}.exe" "${PRODUCTNAME}"
  !insertmacro PIWI_STOP_SIDECAR
!macroend
