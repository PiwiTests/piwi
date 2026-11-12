; NSIS installer hooks of Piwi Runner's per-user .exe (`bundle > windows > nsis >
; installerHooks` in runner.conf.json), inserted into Tauri's installer template.
; Runner has no pages of its own: the hooks stop its host, the
; `piwi-runner-node.exe` sidecar, before any file is written or removed.

!include "${__FILEDIR__}\stop-sidecar.nsh"

!macro NSIS_HOOK_PREINSTALL
  !insertmacro CheckIfAppIsRunning "$INSTDIR\${MAINBINARYNAME}.exe" "${PRODUCTNAME}"
  !insertmacro PIWI_STOP_SIDECAR "$INSTDIR" "piwi-runner-node"
!macroend

!macro NSIS_HOOK_PREUNINSTALL
  !insertmacro CheckIfAppIsRunning "$INSTDIR\${MAINBINARYNAME}.exe" "${PRODUCTNAME}"
  !insertmacro PIWI_STOP_SIDECAR "$INSTDIR" "piwi-runner-node"
!macroend
