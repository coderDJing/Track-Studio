; Track Studio Windows installer integration.
;
; The electron-builder NSIS executable remains the signed installer and update
; payload. For interactive installs it runs the project-owned WPF frontend while
; keeping the stock NSIS wizard hidden. Silent/background updates bypass the
; frontend; explicit restart-to-update runs it in a dedicated update mode.

!include WinMessages.nsh
!include nsDialogs.nsh

!define TRACK_STUDIO_INSTALLER_UI "${__FILEDIR__}\..\dist\installer-ui\TrackStudioInstallerUi.exe"

!ifndef BUILD_UNINSTALLER
!define MUI_CUSTOMFUNCTION_GUIINIT TrackStudioGuiInit

Var TrackStudioIsChinese
Var TrackStudioNativeParked

!macro preInit
  !ifndef BUILD_UNINSTALLER
    IfSilent track_studio_preinit_done
    System::Call 'kernel32::OpenMutexW(i 0x00100000, i 0, w "${APP_GUID}")p.r0'
    StrCmp $0 0 track_studio_preinit_done
    System::Call 'kernel32::CloseHandle(p r0)'
    System::Call 'kernel32::GetUserDefaultUILanguage()i.r0'
    IntOp $0 $0 & 1023
    StrCpy $TrackStudioIsChinese "0"
    StrCmp $0 4 0 +2
    StrCpy $TrackStudioIsChinese "1"
    !insertmacro TrackStudioLocalizedString $4 \
      "另一个 Track Studio 安装程序仍在运行。请先关闭它，然后重试。" \
      "Another Track Studio installer is still running. Close it and try again."
    MessageBox MB_OK|MB_ICONEXCLAMATION|MB_TOPMOST "$4"
    SetErrorLevel 1618
    Abort
track_studio_preinit_done:
  !endif
!macroend

!macro TrackStudioLocalizedString OUTPUT CHINESE ENGLISH
  StrCpy ${OUTPUT} "${ENGLISH}"
  StrCmp $TrackStudioIsChinese "1" 0 +2
  StrCpy ${OUTPUT} "${CHINESE}"
!macroend

; Keep the executable name FRKB for application compatibility, but expose the
; product name in the file shown by Windows' uninstall elevation prompt.
!macro customHeader
  !ifdef UNINSTALL_FILENAME
    !undef UNINSTALL_FILENAME
  !endif
  !define UNINSTALL_FILENAME "Uninstall Track Studio.exe"
!macroend

Function TrackStudioGuiInit
  IfSilent track_studio_gui_done
  System::Call 'kernel32::GetUserDefaultUILanguage()i.r0'
  IntOp $0 $0 & 1023
  StrCpy $TrackStudioIsChinese "0"
  StrCmp $0 4 0 +2
  StrCpy $TrackStudioIsChinese "1"
  StrCpy $TrackStudioNativeParked "1"
  Call TrackStudioParkNativeWindow
track_studio_gui_done:
FunctionEnd

Function TrackStudioParkNativeWindow
  ; nsDialogs needs a live native parent for its page loop. Keep that window
  ; alive but remove it from the taskbar and park it outside the virtual desktop.
  System::Call 'user32::GetWindowLongW(p $HWNDPARENT, i -20)i.r0'
  IntOp $0 $0 & -262145
  IntOp $0 $0 | 128
  System::Call 'user32::SetWindowLongW(p $HWNDPARENT, i -20, i r0)'
  System::Call 'user32::SetWindowPos(p $HWNDPARENT, p 0, i -32000, i -32000, i 0, i 0, i 21)'
  ShowWindow $HWNDPARENT 8
FunctionEnd

Function TrackStudioRestoreNativeWindow
  System::Call 'user32::GetWindowLongW(p $HWNDPARENT, i -20)i.r0'
  IntOp $0 $0 & -129
  IntOp $0 $0 | 262144
  System::Call 'user32::SetWindowLongW(p $HWNDPARENT, i -20, i r0)'
  System::Call 'user32::SetWindowPos(p $HWNDPARENT, p 0, i 120, i 120, i 0, i 0, i 21)'
  ShowWindow $HWNDPARENT 5
  BringToFront
FunctionEnd

!include FileFunc.nsh
!include StrFunc.nsh
!ifndef StrStr_INCLUDED
  ${StrStr}
!endif

Var TrackStudioInteractive
Var TrackStudioSessionFile
Var TrackStudioPage
Var TrackStudioFrontendMode
Var TrackStudioLastHeartbeat
Var TrackStudioNoHeartbeatTicks
Var TrackStudioProgressWindow
Var TrackStudioLastProgress
Var TrackStudioUpdatePrepared
Var TrackStudioUpdateOriginalDir
Var TrackStudioUpdateStagingDir
Var TrackStudioUpdateBackupDir
Var TrackStudioUpdateOldUninstallString
Var TrackStudioUpdateOldQuietUninstallString
Var TrackStudioInstallRegistryKey
Var TrackStudioUninstallRegistryKey

Function TrackStudioBootstrapCreate
  IfSilent track_studio_bootstrap_skip

  StrCpy $TrackStudioInteractive "1"
  StrCpy $TrackStudioLastHeartbeat ""
  StrCpy $TrackStudioNoHeartbeatTicks 0
  InitPluginsDir
  StrCpy $TrackStudioSessionFile "$PLUGINSDIR\track-studio-installer.ini"
  StrCmp $TrackStudioUpdatePrepared "1" track_studio_keep_rollback_session
  Delete "$TrackStudioSessionFile"
track_studio_keep_rollback_session:
  WriteINIStr "$TrackStudioSessionFile" "engine" "state" "ready"

  StrCpy $TrackStudioFrontendMode "install"
  ${GetParameters} $0
  ${StrStr} $1 $0 "--updated"
  StrCmp $1 "" track_studio_mode_ready
  StrCpy $TrackStudioFrontendMode "update"
track_studio_mode_ready:

  ClearErrors
  SetOutPath "$PLUGINSDIR"
  IfErrors track_studio_bootstrap_error
  ClearErrors
  File /oname=TrackStudioInstallerUi.exe "${TRACK_STUDIO_INSTALLER_UI}"
  IfErrors track_studio_bootstrap_error

  nsDialogs::Create 1018
  Pop $TrackStudioPage
  StrCmp $TrackStudioPage "error" track_studio_bootstrap_error

  ClearErrors
  StrCpy $0 "$INSTDIR"
  StrCmp $TrackStudioUpdatePrepared "1" 0 track_studio_bootstrap_install_dir_ready
  StrCpy $0 "$TrackStudioUpdateOriginalDir"
track_studio_bootstrap_install_dir_ready:
  Exec '"$PLUGINSDIR\TrackStudioInstallerUi.exe" --session-file "$TrackStudioSessionFile" --install-dir "$0" --version "${VERSION}" --mode "$TrackStudioFrontendMode" --estimated-size-kb "${APP_64_UNPACKED_SIZE}" --engine-window "$HWNDPARENT" --install-registry-key "$TrackStudioInstallRegistryKey" --uninstall-registry-key "$TrackStudioUninstallRegistryKey"'
  IfErrors track_studio_bootstrap_error

  ${NSD_CreateTimer} TrackStudioPollBootstrap 180
  nsDialogs::Show
  Return

track_studio_bootstrap_error:
  Call TrackStudioCancelUpdate
  Call TrackStudioRestoreNativeWindow
  !insertmacro TrackStudioLocalizedString $4 \
    "Track Studio 安装界面无法启动，请重新运行安装程序。" \
    "The Track Studio installer window could not start. Run the installer again."
  MessageBox MB_OK|MB_ICONSTOP|MB_TOPMOST "$4"
  SetErrorLevel 2
  Quit

track_studio_bootstrap_skip:
  Abort
FunctionEnd

Function TrackStudioPollBootstrap
  Call TrackStudioWatchFrontend
FunctionEnd

Function TrackStudioBootstrapLeave
  ReadINIStr $0 "$TrackStudioSessionFile" "frontend" "command"
  StrCmp $0 "cancel" track_studio_cancel_install
  StrCmp $0 "install" 0 track_studio_missing_path
  ReadINIStr $1 "$TrackStudioSessionFile" "frontend" "installPath"
  StrCmp $1 "" track_studio_missing_path
  StrCmp $TrackStudioUpdatePrepared "1" track_studio_keep_prepared_install_dir
  StrCpy $INSTDIR "$1"
track_studio_keep_prepared_install_dir:
  WriteINIStr "$TrackStudioSessionFile" "frontend" "command" ""
  WriteINIStr "$TrackStudioSessionFile" "engine" "state" "installing"
  ${NSD_KillTimer} TrackStudioPollBootstrap
  Return

track_studio_missing_path:
  WriteINIStr "$TrackStudioSessionFile" "engine" "state" "failed"
  !insertmacro TrackStudioLocalizedString $4 \
    "安装路径无效，请重新运行安装程序。" \
    "The install path is invalid. Run the installer again."
  WriteINIStr "$TrackStudioSessionFile" "engine" "message" "$4"
  Abort

track_studio_cancel_install:
  ${NSD_KillTimer} TrackStudioPollBootstrap
  Call TrackStudioCancelUpdate
  SetErrorLevel 1223
  Quit
FunctionEnd

Function TrackStudioInstallPageShow
  StrCmp $TrackStudioInteractive "1" 0 track_studio_install_show_done
  Call TrackStudioPrepareUpdate
  Call TrackStudioParkNativeWindow
  WriteINIStr "$TrackStudioSessionFile" "engine" "state" "installing"
  StrCpy $TrackStudioLastProgress 0
  WriteINIStr "$TrackStudioSessionFile" "engine" "progressDirectory" "$PLUGINSDIR\7z-out"
  WriteINIStr "$TrackStudioSessionFile" "engine" "progress" "0"
  ${NSD_CreateTimer} TrackStudioPollInstallProgress 180
track_studio_install_show_done:
FunctionEnd

Function TrackStudioPollInstallProgress
  GetDlgItem $TrackStudioProgressWindow $HWNDPARENT 1004
  StrCmp $TrackStudioProgressWindow 0 track_studio_progress_by_files
  System::Call 'user32::SendMessageW(p rTrackStudioProgressWindow, i 0x0408, i 0, i 0)i.r0'
  IntCmp $0 0 track_studio_progress_by_files track_studio_progress_by_files track_studio_progress_write
  Goto track_studio_progress_done
track_studio_progress_by_files:
  ; Some Windows builds do not expose the MUI progress position while the
  ; native window is parked. Estimate from bytes already written to staging.
  ClearErrors
  ${GetSize} "$INSTDIR" "/S=0K" $0 $1 $2
  IfErrors track_studio_progress_done
  IntOp $0 $0 * 100
  IntOp $0 $0 / ${APP_64_UNPACKED_SIZE}
  IntCmp $0 99 0 track_studio_progress_file_cap track_studio_progress_file_cap
  Goto track_studio_progress_file_compare
track_studio_progress_file_cap:
  StrCpy $0 99
track_studio_progress_file_compare:
  IntCmp $0 $TrackStudioLastProgress track_studio_progress_done track_studio_progress_write track_studio_progress_done
track_studio_progress_write:
  StrCpy $TrackStudioLastProgress $0
  WriteINIStr "$TrackStudioSessionFile" "engine" "progress" "$0"
track_studio_progress_done:
FunctionEnd

Function TrackStudioPrepareUpdate
  StrCmp $TrackStudioFrontendMode "update" 0 track_studio_update_prepare_done
  StrCmp $TrackStudioUpdatePrepared "1" track_studio_update_prepare_done
  StrCpy $TrackStudioUpdateOriginalDir "$INSTDIR"
  StrCpy $TrackStudioUpdateStagingDir "$TrackStudioUpdateOriginalDir.__track-studio-update-stage"
  StrCpy $TrackStudioUpdateBackupDir "$TrackStudioUpdateOriginalDir.__track-studio-update-old"
  RMDir /r "$TrackStudioUpdateStagingDir"
  RMDir /r "$TrackStudioUpdateBackupDir"
  CreateDirectory "$TrackStudioUpdateStagingDir"
  ReadRegStr $TrackStudioUpdateOldUninstallString SHELL_CONTEXT "$TrackStudioUninstallRegistryKey" UninstallString
  ReadRegStr $TrackStudioUpdateOldQuietUninstallString SHELL_CONTEXT "$TrackStudioUninstallRegistryKey" QuietUninstallString
  WriteINIStr "$TrackStudioSessionFile" "rollback" "installLocation" "$TrackStudioUpdateOriginalDir"
  WriteINIStr "$TrackStudioSessionFile" "rollback" "stagingLocation" "$TrackStudioUpdateStagingDir"
  WriteINIStr "$TrackStudioSessionFile" "rollback" "backupLocation" "$TrackStudioUpdateBackupDir"
  WriteINIStr "$TrackStudioSessionFile" "rollback" "uninstallString" "$TrackStudioUpdateOldUninstallString"
  WriteINIStr "$TrackStudioSessionFile" "rollback" "quietUninstallString" "$TrackStudioUpdateOldQuietUninstallString"
  ; Prevent electron-builder's pre-install uninstall from removing the old tree.
  WriteRegStr SHELL_CONTEXT "$TrackStudioUninstallRegistryKey" UninstallString ""
  WriteRegStr SHELL_CONTEXT "$TrackStudioUninstallRegistryKey" QuietUninstallString ""
  StrCpy $TrackStudioUpdatePrepared "1"
  StrCpy $INSTDIR "$TrackStudioUpdateStagingDir"
track_studio_update_prepare_done:
FunctionEnd

Function TrackStudioRestoreUpdateRegistration
  StrCmp $TrackStudioUpdatePrepared "1" 0 track_studio_restore_update_done
  WriteRegStr SHELL_CONTEXT "$TrackStudioInstallRegistryKey" InstallLocation "$TrackStudioUpdateOriginalDir"
  WriteRegStr SHELL_CONTEXT "$TrackStudioUninstallRegistryKey" UninstallString "$TrackStudioUpdateOldUninstallString"
  WriteRegStr SHELL_CONTEXT "$TrackStudioUninstallRegistryKey" QuietUninstallString "$TrackStudioUpdateOldQuietUninstallString"
track_studio_restore_update_done:
FunctionEnd

Function TrackStudioCancelUpdate
  StrCmp $TrackStudioUpdatePrepared "1" 0 track_studio_cancel_update_done
  RMDir /r "$TrackStudioUpdateStagingDir"
  Call TrackStudioRestoreUpdateRegistration
track_studio_cancel_update_done:
FunctionEnd

Function TrackStudioFinishShow
  Call TrackStudioParkNativeWindow
  ${NSD_KillTimer} TrackStudioPollInstallProgress
  WriteINIStr "$TrackStudioSessionFile" "engine" "progress" "100"
  WriteINIStr "$TrackStudioSessionFile" "engine" "state" "success"
  ${NSD_CreateTimer} TrackStudioPollFinish 180
FunctionEnd

Function TrackStudioPollFinish
  Call TrackStudioWatchFrontend
FunctionEnd

Function TrackStudioFinishLeave
  ${NSD_KillTimer} TrackStudioPollFinish
  ReadINIStr $0 "$TrackStudioSessionFile" "frontend" "launch"
  StrCmp $0 "1" 0 track_studio_finish_done
  Call TrackStudioStartApp

track_studio_finish_done:
  SetErrorLevel 0
FunctionEnd

Function TrackStudioWatchFrontend
  ReadINIStr $2 "$TrackStudioSessionFile" "frontend" "heartbeat"
  StrCmp $2 "" track_studio_frontend_stale
  StrCmp $2 $TrackStudioLastHeartbeat track_studio_frontend_stale
  StrCpy $TrackStudioLastHeartbeat $2
  StrCpy $TrackStudioNoHeartbeatTicks 0
  StrCmp $TrackStudioNativeParked "1" track_studio_frontend_watch_done
  ReadINIStr $3 "$TrackStudioSessionFile" "frontend" "state"
  StrCmp $3 "ready" 0 track_studio_frontend_watch_done
  StrCpy $TrackStudioNativeParked "1"
  Call TrackStudioParkNativeWindow
  Return

track_studio_frontend_stale:
  IntOp $TrackStudioNoHeartbeatTicks $TrackStudioNoHeartbeatTicks + 1
  IntCmp $TrackStudioNoHeartbeatTicks 60 track_studio_frontend_timeout track_studio_frontend_watch_done track_studio_frontend_timeout
track_studio_frontend_watch_done:
  Return

track_studio_frontend_timeout:
  ${NSD_KillTimer} TrackStudioPollBootstrap
  ${NSD_KillTimer} TrackStudioPollFinish
  Call TrackStudioRestoreNativeWindow
  !insertmacro TrackStudioLocalizedString $4 \
    "Track Studio 安装界面已停止响应。请关闭当前安装程序后重试。" \
    "The Track Studio installer window stopped responding. Close this installer and try again."
  MessageBox MB_OK|MB_ICONSTOP|MB_TOPMOST "$4"
  SetErrorLevel 2
  Quit
FunctionEnd

Function .onInstFailed
  StrCmp $TrackStudioInteractive "1" 0 track_studio_failed_done
  ${NSD_KillTimer} TrackStudioPollInstallProgress
  Call TrackStudioCancelUpdate
  Call TrackStudioRestoreUpdateRegistration
  WriteINIStr "$TrackStudioSessionFile" "engine" "state" "failed"
  !insertmacro TrackStudioLocalizedString $4 \
    "安装未能完成，请重新运行安装程序。" \
    "Installation could not finish. Run the installer again."
  WriteINIStr "$TrackStudioSessionFile" "engine" "message" "$4"
track_studio_failed_done:
FunctionEnd

!macro customWelcomePage
  Page custom TrackStudioBootstrapCreate TrackStudioBootstrapLeave
!macroend

!macro customInit
  ; Keep the internal executable name FRKB for compatibility, but expose the
  ; product name in the default per-machine installation directory.
  StrCpy $TrackStudioInstallRegistryKey "${INSTALL_REGISTRY_KEY}"
  StrCpy $TrackStudioUninstallRegistryKey "${UNINSTALL_REGISTRY_KEY}"
  InitPluginsDir
  StrCpy $TrackStudioSessionFile "$PLUGINSDIR\track-studio-installer.ini"
  ${GetParameters} $0
  ${StrStr} $1 $0 "--updated"
  StrCmp $1 "" track_studio_custom_init_ready
  StrCpy $TrackStudioFrontendMode "update"
  Call TrackStudioPrepareUpdate
track_studio_custom_init_ready:
  ReadRegStr $0 SHELL_CONTEXT "$TrackStudioInstallRegistryKey" InstallLocation
  StrCmp $0 "" 0 track_studio_keep_existing_install_dir
  StrCpy $INSTDIR "$PROGRAMFILES\Track Studio"
track_studio_keep_existing_install_dir:
!macroend

Function TrackStudioCommitUpdate
  StrCmp $TrackStudioUpdatePrepared "1" track_studio_commit_update_start track_studio_commit_update_done

track_studio_commit_update_start:
  ; The old tree has not been touched while the new package was extracted.
  ; Rename both directories on the same volume so the final switch is fast.
  SetOutPath "$TEMP"
  ClearErrors
  IfFileExists "$TrackStudioUpdateOriginalDir\*.*" 0 track_studio_no_old_tree
  Rename "$TrackStudioUpdateOriginalDir" "$TrackStudioUpdateBackupDir"
  IfErrors track_studio_commit_update_failed

track_studio_no_old_tree:
  Rename "$TrackStudioUpdateStagingDir" "$TrackStudioUpdateOriginalDir"
  IfErrors track_studio_commit_update_restore
  StrCpy $INSTDIR "$TrackStudioUpdateOriginalDir"
  Call TrackStudioRestoreUpdateRegistration
  RMDir /r "$TrackStudioUpdateBackupDir"
  Return

track_studio_commit_update_restore:
  IfFileExists "$TrackStudioUpdateBackupDir\*.*" 0 track_studio_commit_update_failed
  Rename "$TrackStudioUpdateBackupDir" "$TrackStudioUpdateOriginalDir"

track_studio_commit_update_failed:
  RMDir /r "$TrackStudioUpdateStagingDir"
  Call TrackStudioRestoreUpdateRegistration
  MessageBox MB_OK|MB_ICONSTOP|MB_TOPMOST "$(^Name) 更新未完成，旧版本已保留。$\nThe update could not be completed. The previous version was kept."
  Abort

track_studio_commit_update_done:
FunctionEnd

!macro customInstall
  Call TrackStudioCommitUpdate
  StrCmp $TrackStudioUpdatePrepared "1" 0 track_studio_update_metadata_done
  StrCpy $appExe "$INSTDIR\${APP_EXECUTABLE_FILENAME}"
  !insertmacro registryAddInstallInfo
  !insertmacro addStartMenuLink "false"
  !insertmacro addDesktopLink "false"
  ${if} ${FileExists} "$newStartMenuLink"
    StrCpy $launchLink "$newStartMenuLink"
  ${else}
    StrCpy $launchLink "$appExe"
  ${endIf}
  !ifmacrodef registerFileAssociations
    !insertmacro registerFileAssociations
  !endif
track_studio_update_metadata_done:
!macroend

!macro customPageAfterChangeDir
  !define MUI_PAGE_CUSTOMFUNCTION_SHOW TrackStudioInstallPageShow
!macroend

!macro customFinishPage
  Function TrackStudioStartApp
    ${if} ${isUpdated}
      StrCpy $1 "--updated"
    ${else}
      StrCpy $1 ""
    ${endif}
    ${StdUtils.ExecShellAsUser} $0 "$launchLink" "open" "$1"
  FunctionEnd

  !define MUI_PAGE_CUSTOMFUNCTION_SHOW TrackStudioFinishShow
  !define MUI_PAGE_CUSTOMFUNCTION_LEAVE TrackStudioFinishLeave
  !insertmacro MUI_PAGE_FINISH
!macroend

!else
!include "${__FILEDIR__}\uninstaller-ui.nsh"
!endif

; Remove context-menu entries written at runtime. The extension registry keys
; themselves are retained.
!macro FrkbDeleteMenusForRoot ROOT BASE UNIQ
  Push $R0
  Push $R1
  DeleteRegKey ${ROOT} "${BASE}\*\shell\PlayWithFRKB"
  StrCpy $R1 0
frkb_loop_${UNIQ}:
  EnumRegKey $R0 ${ROOT} "${BASE}\SystemFileAssociations" $R1
  StrCmp $R0 "" frkb_done_${UNIQ}
  DeleteRegKey ${ROOT} "${BASE}\SystemFileAssociations\$R0\shell\PlayWithFRKB"
  IntOp $R1 $R1 + 1
  Goto frkb_loop_${UNIQ}
frkb_done_${UNIQ}:
  Pop $R1
  Pop $R0
!macroend

!macro FrkbDeleteMenusAllUsers
  Push $0
  Push $1
  StrCpy $1 0
loop_users:
  EnumRegKey $0 HKU "" $1
  StrCmp $0 "" done_users
  !insertmacro FrkbDeleteMenusForRoot HKU "$0\Software\Classes" hku
  IntOp $1 $1 + 1
  Goto loop_users
done_users:
  Pop $1
  Pop $0
!macroend

!macro customUnInstall
  !insertmacro FrkbDeleteMenusForRoot HKCU "Software\Classes" hkcu
  !insertmacro FrkbDeleteMenusAllUsers
!macroend
