!macro customUnInstall
  ${ifNot} ${isUpdated}
    nsExec::ExecToLog '"$INSTDIR\resources\cli-runtime\bun.exe" "$INSTDIR\resources\cli-runtime\scripts\uninstall-cli.ts"'
    Pop $0
    FileOpen $1 "$TEMP\cadet-uninstall-trace.log" a
    FileWrite $1 "nsexec=$0$\r$\n"
    FileClose $1
    DetailPrint "cadet command cleanup exit: $0"
    # Never Abort here: a failed launcher cleanup must not orphan the whole
    # uninstall — NSIS's own $INSTDIR deletion still runs below.
  ${endIf}
!macroend
