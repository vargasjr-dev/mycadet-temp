!macro customUnInstall
  ${ifNot} ${isUpdated}
    nsExec::ExecToLog '"$INSTDIR\resources\cli-runtime\cli-uninstaller.exe"'
    Pop $0
    ${if} $0 != 0
      MessageBox MB_ICONSTOP|MB_OK "Cadet could not remove its command launcher. Close active cadet commands, then retry uninstalling."
      Abort
    ${endIf}
  ${endIf}
!macroend
