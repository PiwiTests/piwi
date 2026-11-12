; The Node sidecar of an app, stopped before its installer writes or removes a
; file: `!insertmacro PIWI_STOP_SIDECAR <name>` for `<name>.exe` beside the main
; binary. Included by each app's installer hooks (`installer-hooks.nsh` for the
; desktop app, `runner-installer-hooks.nsh` for Piwi Runner).
;
; The sidecar keeps the app's files open: the desktop app's server holds the
; bundled native modules loaded (sharp's libvips DLLs among them), and Piwi
; Runner's host its own script. Tauri's installer only stops the main binary,
; so a sidecar still running holds those files locked and the copy fails with
; "Error opening file for writing". That happens whenever the app stops without
; its quit cleanup: an update started by a build whose updater leaves the
; sidecar running (the desktop app's 0.37 and earlier, see src/updates.rs), a
; kill from Task Manager, or the installer's own "close the app" step.
;
; So before any file is written or removed: run the app check first (a stopped
; app cannot restart the sidecar behind us; the template's own check then finds
; nothing), then stop the sidecar running from this install folder. Matched on
; its full path, never on the name alone, which would also kill the user's own
; Node processes.

!macro PIWI_STOP_SIDECAR NAME
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
  nsExec::Exec `"$0" -NoProfile -NonInteractive -Command "Get-Process -Name ${NAME} -ErrorAction SilentlyContinue | Where-Object { $$_.Path -eq ($$env:PIWI_INSTDIR + '\${NAME}.exe') } | Stop-Process -Force -PassThru | Wait-Process -Timeout 10 -ErrorAction SilentlyContinue"`
  Pop $0 ; nsExec's exit code — best-effort, a failure leaves the install as before
  Pop $0
!macroend
