; Interactive uninstaller frontend. Silent removals keep electron-builder's
; normal unattended flow; the native page loop stays alive but off-screen.

!define MUI_CUSTOMFUNCTION_UNGUIINIT un.TrackStudioUninstallGuiInit

Var TrackStudioUninstallSessionFile
Var TrackStudioUninstallLastHeartbeat
Var TrackStudioUninstallStaleTicks
Var TrackStudioUninstallProgressWindow

Function un.TrackStudioUninstallGuiInit
  IfSilent track_studio_uninstall_gui_done
  Call un.TrackStudioUninstallParkNativeWindow
track_studio_uninstall_gui_done:
FunctionEnd

Function un.TrackStudioUninstallParkNativeWindow
  System::Call 'user32::GetWindowLongW(p $HWNDPARENT, i -20)i.r0'
  IntOp $0 $0 & -262145
  IntOp $0 $0 | 128
  System::Call 'user32::SetWindowLongW(p $HWNDPARENT, i -20, i r0)'
  System::Call 'user32::SetWindowPos(p $HWNDPARENT, p 0, i -32000, i -32000, i 0, i 0, i 21)'
  ShowWindow $HWNDPARENT 8
FunctionEnd

Function un.TrackStudioUninstallRestoreNativeWindow
  System::Call 'user32::GetWindowLongW(p $HWNDPARENT, i -20)i.r0'
  IntOp $0 $0 & -129
  IntOp $0 $0 | 262144
  System::Call 'user32::SetWindowLongW(p $HWNDPARENT, i -20, i r0)'
  System::Call 'user32::SetWindowPos(p $HWNDPARENT, p 0, i 120, i 120, i 0, i 0, i 21)'
  ShowWindow $HWNDPARENT 5
  BringToFront
FunctionEnd

Function un.TrackStudioUninstallBootstrapCreate
  IfSilent track_studio_uninstall_bootstrap_skip

  StrCpy $TrackStudioUninstallLastHeartbeat ""
  StrCpy $TrackStudioUninstallStaleTicks 0
  InitPluginsDir
  StrCpy $TrackStudioUninstallSessionFile "$PLUGINSDIR\track-studio-uninstaller.ini"
  Delete "$TrackStudioUninstallSessionFile"
  WriteINIStr "$TrackStudioUninstallSessionFile" "engine" "state" "ready"

  ClearErrors
  SetOutPath "$PLUGINSDIR"
  IfErrors track_studio_uninstall_bootstrap_error
  ClearErrors
  File /oname=TrackStudioInstallerUi.exe "${TRACK_STUDIO_INSTALLER_UI}"
  IfErrors track_studio_uninstall_bootstrap_error
  nsDialogs::Create 1018
  Pop $0
  StrCmp $0 "error" track_studio_uninstall_bootstrap_error

  ClearErrors
  Exec '"$PLUGINSDIR\TrackStudioInstallerUi.exe" --session-file "$TrackStudioUninstallSessionFile" --install-dir "$INSTDIR" --version "${VERSION}" --mode uninstall --engine-window "$HWNDPARENT"'
  IfErrors track_studio_uninstall_bootstrap_error

  ${NSD_CreateTimer} un.TrackStudioUninstallPollBootstrap 180
  nsDialogs::Show
  Return

track_studio_uninstall_bootstrap_error:
  Call un.TrackStudioUninstallRestoreNativeWindow
  MessageBox MB_OK|MB_ICONSTOP|MB_TOPMOST "Track Studio 卸载界面无法启动。$\nThe Track Studio uninstaller could not start."
  SetErrorLevel 2
  Quit
track_studio_uninstall_bootstrap_skip:
FunctionEnd

Function un.TrackStudioUninstallPollBootstrap
  Call un.TrackStudioUninstallWatchFrontend
FunctionEnd

Function un.TrackStudioUninstallBootstrapLeave
  ReadINIStr $0 "$TrackStudioUninstallSessionFile" "frontend" "command"
  StrCmp $0 "cancel" track_studio_uninstall_cancel
  StrCmp $0 "uninstall" track_studio_uninstall_start
  Abort
track_studio_uninstall_start:
  WriteINIStr "$TrackStudioUninstallSessionFile" "frontend" "command" ""
  WriteINIStr "$TrackStudioUninstallSessionFile" "engine" "state" "uninstalling"
  ${NSD_KillTimer} un.TrackStudioUninstallPollBootstrap
  Return
track_studio_uninstall_cancel:
  ${NSD_KillTimer} un.TrackStudioUninstallPollBootstrap
  SetErrorLevel 1223
  Quit
FunctionEnd

Function un.TrackStudioUninstallProgressShow
  Call un.TrackStudioUninstallParkNativeWindow
  WriteINIStr "$TrackStudioUninstallSessionFile" "engine" "state" "uninstalling"
  ${NSD_CreateTimer} un.TrackStudioUninstallPollProgress 180
FunctionEnd

Function un.TrackStudioUninstallPollProgress
  GetDlgItem $TrackStudioUninstallProgressWindow $HWNDPARENT 1004
  StrCmp $TrackStudioUninstallProgressWindow 0 track_studio_uninstall_progress_done
  System::Call 'user32::SendMessageW(p rTrackStudioUninstallProgressWindow, i 0x0408, i 0, i 0)i.r0'
  IntCmp $0 0 track_studio_uninstall_progress_done
  WriteINIStr "$TrackStudioUninstallSessionFile" "engine" "progress" "$0"
track_studio_uninstall_progress_done:
FunctionEnd

Function un.TrackStudioUninstallFinishShow
  Call un.TrackStudioUninstallParkNativeWindow
  ${NSD_KillTimer} un.TrackStudioUninstallPollProgress
  WriteINIStr "$TrackStudioUninstallSessionFile" "engine" "progress" "100"
  WriteINIStr "$TrackStudioUninstallSessionFile" "engine" "state" "success"
  ${NSD_CreateTimer} un.TrackStudioUninstallPollFinish 180
FunctionEnd

Function un.TrackStudioUninstallPollFinish
  Call un.TrackStudioUninstallWatchFrontend
FunctionEnd

Function un.TrackStudioUninstallFinishLeave
  ${NSD_KillTimer} un.TrackStudioUninstallPollFinish
FunctionEnd

Function un.TrackStudioUninstallWatchFrontend
  ReadINIStr $1 "$TrackStudioUninstallSessionFile" "frontend" "heartbeat"
  StrCmp $1 "" track_studio_uninstall_frontend_stale
  StrCmp $1 $TrackStudioUninstallLastHeartbeat track_studio_uninstall_frontend_stale
  StrCpy $TrackStudioUninstallLastHeartbeat $1
  StrCpy $TrackStudioUninstallStaleTicks 0
  Return

track_studio_uninstall_frontend_stale:
  IntOp $TrackStudioUninstallStaleTicks $TrackStudioUninstallStaleTicks + 1
  IntCmp $TrackStudioUninstallStaleTicks 60 track_studio_uninstall_frontend_timeout track_studio_uninstall_frontend_done track_studio_uninstall_frontend_timeout
track_studio_uninstall_frontend_timeout:
  Call un.TrackStudioUninstallRestoreNativeWindow
  MessageBox MB_OK|MB_ICONSTOP|MB_TOPMOST "Track Studio 卸载界面已停止响应。$\nThe Track Studio uninstaller stopped responding."
  SetErrorLevel 2
  Quit
track_studio_uninstall_frontend_done:
FunctionEnd

Function un.onUninstFailed
  IfSilent track_studio_uninstall_failed_done
  WriteINIStr "$TrackStudioUninstallSessionFile" "engine" "state" "failed"
  WriteINIStr "$TrackStudioUninstallSessionFile" "engine" "message" "卸载未能完成。请关闭窗口后重试。 / Uninstallation could not finish. Close this window and retry."
track_studio_uninstall_failed_done:
FunctionEnd

!macro customUnWelcomePage
  UninstPage custom un.TrackStudioUninstallBootstrapCreate un.TrackStudioUninstallBootstrapLeave
  !define MUI_PAGE_CUSTOMFUNCTION_SHOW un.TrackStudioUninstallProgressShow
!macroend

!macro customUninstallPage
  !define MUI_PAGE_CUSTOMFUNCTION_SHOW un.TrackStudioUninstallFinishShow
  !define MUI_PAGE_CUSTOMFUNCTION_LEAVE un.TrackStudioUninstallFinishLeave
!macroend

; The frontend removes the large application tree in a background worker so
; its byte-count progress remains visible. NSIS only removes the locked
; uninstaller and any files that could not be removed by that worker.
!macro customRemoveFiles
  SetOutPath "$TEMP"
  RMDir /r "$INSTDIR"
!macroend
