!macro customUnInstall
  ${ifNot} ${isUpdated}
    nsExec::ExecToLog '"$INSTDIR\resources\cli-runtime\bun.exe" "$INSTDIR\resources\cli-runtime\scripts\uninstall-cli.ts"'
    Pop $0
    FileOpen $1 "$TEMP\cadet-uninstall-trace.log" a
    FileWrite $1 "nsexec=$0$\r$\n"
    FileClose $1
    ${if} $0 != 0
      MessageBox MB_ICONSTOP|MB_OK "Cadet could not remove its command launcher. Close active cadet commands, then retry uninstalling."
      Abort
    ${endIf}
  ${endIf}
!macroend
