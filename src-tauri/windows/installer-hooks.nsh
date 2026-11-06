; KiloNote installer hooks (NSIS, Windows installer only).
;
; Registers KiloNote in Explorer's "Open with" menu for text files, per user
; (HKCU). It never takes over the default application of an extension: Windows
; itself then offers "Always use this app" when the user picks KiloNote.
; Everything is removed by the uninstaller.

!define KILONOTE_PROGID "KiloNote.Document"

!macro KILONOTE_OPEN_WITH EXT
  WriteRegStr SHCTX "Software\Classes\.${EXT}\OpenWithProgids" "${KILONOTE_PROGID}" ""
  WriteRegStr SHCTX "Software\Classes\Applications\${MAINBINARYNAME}.exe\SupportedTypes" ".${EXT}" ""
!macroend

!macro KILONOTE_REMOVE_OPEN_WITH EXT
  DeleteRegValue SHCTX "Software\Classes\.${EXT}\OpenWithProgids" "${KILONOTE_PROGID}"
!macroend

!macro NSIS_HOOK_POSTINSTALL
  WriteRegStr SHCTX "Software\Classes\${KILONOTE_PROGID}" "" "KiloNote document"
  WriteRegStr SHCTX "Software\Classes\${KILONOTE_PROGID}\DefaultIcon" "" "$INSTDIR\${MAINBINARYNAME}.exe,0"
  WriteRegStr SHCTX "Software\Classes\${KILONOTE_PROGID}\shell\open\command" "" '"$INSTDIR\${MAINBINARYNAME}.exe" "%1"'
  WriteRegStr SHCTX "Software\Classes\Applications\${MAINBINARYNAME}.exe" "FriendlyAppName" "KiloNote"
  WriteRegStr SHCTX "Software\Classes\Applications\${MAINBINARYNAME}.exe\shell\open\command" "" '"$INSTDIR\${MAINBINARYNAME}.exe" "%1"'
  !insertmacro KILONOTE_OPEN_WITH "txt"
  !insertmacro KILONOTE_OPEN_WITH "text"
  !insertmacro KILONOTE_OPEN_WITH "md"
  !insertmacro KILONOTE_OPEN_WITH "markdown"
  !insertmacro KILONOTE_OPEN_WITH "note"
  !insertmacro KILONOTE_OPEN_WITH "todo"
  !insertmacro KILONOTE_OPEN_WITH "log"
  ; Tell Explorer that file associations changed.
  System::Call 'shell32::SHChangeNotify(i 0x08000000, i 0, p 0, p 0)'
!macroend

!macro NSIS_HOOK_PREUNINSTALL
  !insertmacro KILONOTE_REMOVE_OPEN_WITH "txt"
  !insertmacro KILONOTE_REMOVE_OPEN_WITH "text"
  !insertmacro KILONOTE_REMOVE_OPEN_WITH "md"
  !insertmacro KILONOTE_REMOVE_OPEN_WITH "markdown"
  !insertmacro KILONOTE_REMOVE_OPEN_WITH "note"
  !insertmacro KILONOTE_REMOVE_OPEN_WITH "todo"
  !insertmacro KILONOTE_REMOVE_OPEN_WITH "log"
  DeleteRegKey SHCTX "Software\Classes\${KILONOTE_PROGID}"
  DeleteRegKey SHCTX "Software\Classes\Applications\${MAINBINARYNAME}.exe"
  System::Call 'shell32::SHChangeNotify(i 0x08000000, i 0, p 0, p 0)'
!macroend
