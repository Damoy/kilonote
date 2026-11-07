; KiloNote installer hooks (NSIS, Windows installer only).
;
; The installer writes no file association: to open text files with KiloNote,
; use Explorer's "Open with" > "Choose another app" (Windows records the
; choice itself). Older versions registered KiloNote in "Open with" for a few
; text extensions: the uninstaller still removes those entries, per user (HKCU).

!define KILONOTE_PROGID "KiloNote.Document"

!macro KILONOTE_REMOVE_OPEN_WITH EXT
  DeleteRegValue SHCTX "Software\Classes\.${EXT}\OpenWithProgids" "${KILONOTE_PROGID}"
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
!macroend
