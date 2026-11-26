; Extra steps for the Windows NSIS installer (electron-builder `nsis.include`).
;
; Client mode is the same Maestro.exe started with `--maestro-client` (src/main/client/). Every
; install and every update writes a "<product> Client" shortcut to the Start Menu and the Desktop,
; so a machine that drives a remote Maestro host gets it just by installing or updating. The
; shortcut carries the client's AppUserModelID (`<appId>.client`, CLIENT_APP_USER_MODEL_ID in
; src/main/client/client-config.ts) so its taskbar button stays apart from the local app's.

!macro maestroClientShortcut LINK
  CreateShortCut "${LINK}" "$INSTDIR\${APP_EXECUTABLE_FILENAME}" "--maestro-client" "$INSTDIR\${APP_EXECUTABLE_FILENAME}" 0 "" "" "${PRODUCT_NAME} Client: drive Maestro on another computer"
  ClearErrors
  WinShell::SetLnkAUMI "${LINK}" "${APP_ID}.client"
!macroend

!macro customInstall
  !insertmacro maestroClientShortcut "$SMPROGRAMS\${PRODUCT_NAME} Client.lnk"
  !insertmacro maestroClientShortcut "$DESKTOP\${PRODUCT_NAME} Client.lnk"
!macroend

!macro customUnInstall
  ; An update runs the old uninstaller first; keep the shortcuts then, remove them on a real uninstall.
  ${ifNot} ${isUpdated}
    Delete "$SMPROGRAMS\${PRODUCT_NAME} Client.lnk"
    Delete "$DESKTOP\${PRODUCT_NAME} Client.lnk"
  ${endIf}
!macroend
