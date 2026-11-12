; Hooks for Tauri's NSIS installer (tauri.conf.json > bundle > windows > nsis).
;
; Registers Palimpsest for PDFs the way Windows expects of a program that is
; offered, not imposed: it appears under "Open with" and in Settings > Default
; apps, and PDFs get an "Open with Palimpsest" command, but the default PDF app
; stays whatever it was. (Tauri's own file association would make Palimpsest
; the default, so tauri.windows.conf.json switches it off.)
;
; Per-user install: SHCTX is HKCU here. scripts/test-installer.ps1 checks all of it.

!define PALIMPSEST_PROGID "Palimpsest.PDF"
!define PALIMPSEST_EXE "$INSTDIR\${MAINBINARYNAME}.exe"
!define PALIMPSEST_OPEN "$\"${PALIMPSEST_EXE}$\" $\"%1$\""

!macro NSIS_HOOK_POSTINSTALL
  ; The program class that opens a PDF.
  WriteRegStr SHCTX "Software\Classes\${PALIMPSEST_PROGID}" "" "PDF document"
  WriteRegStr SHCTX "Software\Classes\${PALIMPSEST_PROGID}\DefaultIcon" "" "$\"${PALIMPSEST_EXE}$\",0"
  WriteRegStr SHCTX "Software\Classes\${PALIMPSEST_PROGID}\shell\open" "FriendlyAppName" "${PRODUCTNAME}"
  WriteRegStr SHCTX "Software\Classes\${PALIMPSEST_PROGID}\shell\open\command" "" "${PALIMPSEST_OPEN}"

  ; Listed under "Open with" for .pdf, without touching the default.
  WriteRegStr SHCTX "Software\Classes\.pdf\OpenWithProgids" "${PALIMPSEST_PROGID}" ""

  ; How "Open with" and "Choose another app" name the program.
  WriteRegStr SHCTX "Software\Classes\Applications\${MAINBINARYNAME}.exe" "FriendlyAppName" "${PRODUCTNAME}"
  WriteRegStr SHCTX "Software\Classes\Applications\${MAINBINARYNAME}.exe\SupportedTypes" ".pdf" ""
  WriteRegStr SHCTX "Software\Classes\Applications\${MAINBINARYNAME}.exe\shell\open\command" "" "${PALIMPSEST_OPEN}"

  ; "Open with Palimpsest" on every PDF's context menu (on Windows 11, under "Show more options").
  WriteRegStr SHCTX "Software\Classes\SystemFileAssociations\.pdf\shell\${PRODUCTNAME}" "" "Open with ${PRODUCTNAME}"
  WriteRegStr SHCTX "Software\Classes\SystemFileAssociations\.pdf\shell\${PRODUCTNAME}" "Icon" "$\"${PALIMPSEST_EXE}$\",0"
  WriteRegStr SHCTX "Software\Classes\SystemFileAssociations\.pdf\shell\${PRODUCTNAME}\command" "" "${PALIMPSEST_OPEN}"

  ; Offered in Settings > Default apps, should the user want it as the default.
  WriteRegStr SHCTX "${MANUPRODUCTKEY}\Capabilities" "ApplicationName" "${PRODUCTNAME}"
  WriteRegStr SHCTX "${MANUPRODUCTKEY}\Capabilities" "ApplicationDescription" "Open source PDF viewer and editor"
  WriteRegStr SHCTX "${MANUPRODUCTKEY}\Capabilities\FileAssociations" ".pdf" "${PALIMPSEST_PROGID}"
  WriteRegStr SHCTX "Software\RegisteredApplications" "${PRODUCTNAME}" "${MANUPRODUCTKEY}\Capabilities"

  !insertmacro UPDATEFILEASSOC
!macroend

!macro NSIS_HOOK_PREUNINSTALL
  DeleteRegValue SHCTX "Software\Classes\.pdf\OpenWithProgids" "${PALIMPSEST_PROGID}"
  DeleteRegKey /ifempty SHCTX "Software\Classes\.pdf\OpenWithProgids"
  DeleteRegKey SHCTX "Software\Classes\${PALIMPSEST_PROGID}"
  DeleteRegKey SHCTX "Software\Classes\Applications\${MAINBINARYNAME}.exe"
  DeleteRegKey SHCTX "Software\Classes\SystemFileAssociations\.pdf\shell\${PRODUCTNAME}"
  DeleteRegValue SHCTX "Software\RegisteredApplications" "${PRODUCTNAME}"
  DeleteRegKey SHCTX "${MANUPRODUCTKEY}\Capabilities"

  !insertmacro UPDATEFILEASSOC
!macroend
