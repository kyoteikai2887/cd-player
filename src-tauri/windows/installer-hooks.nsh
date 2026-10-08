; No shutdown, process termination, or application-data deletion is permitted here.
; A stale writer lease also stops setup: launch the portable app to recover, then exit.
; Silent mode skips the maintenance page: compare installed versions independently.
!macro CD_CheckVersion
  !if "${ALLOWDOWNGRADES}" == "false"
    ReadRegStr $R7 SHCTX "${UNINSTKEY}" "DisplayVersion"
    ${If} $R7 != ""
      nsis_tauri_utils::SemverCompare "${VERSION}" $R7
      Pop $R8
      ${If} $R8 = -1
        SetErrorLevel 2
        IfSilent +2
          MessageBox MB_OK|MB_ICONEXCLAMATION "已经安装了较新的播放器版本，安装已停止。收藏与程序文件保留。"
        Abort
      ${EndIf}
    ${EndIf}
  !endif
!macroend

; Only invoke this product's registered uninstaller, in update mode. Its exact
; resource list removes obsolete assets while retaining unrelated files/data.
!macro CD_RemovePreviousFiles
  ReadRegStr $R5 SHCTX "${MANUPRODUCTKEY}" ""
  ReadRegStr $R6 SHCTX "${UNINSTKEY}" "UninstallString"
  ${If} $R5 != ""
  ${AndIf} $R6 != ""
    ${If} $R6 != '$\"$R5\uninstall.exe$\"'
      SetErrorLevel 2
      Abort "旧版卸载登记不一致，未开始替换程序。"
    ${EndIf}
    IfFileExists "$R5\uninstall.exe" +3 0
      SetErrorLevel 2
      Abort "旧版卸载程序缺失，未开始替换程序。"
    ClearErrors
    ExecWait '$\"$R5\uninstall.exe$\" /S /UPDATE _?=$R5' $R6
    ${If} ${Errors}
    ${OrIf} $R6 != 0
      SetErrorLevel 2
      Abort "旧版资源清理未完成，安装已停止。收藏与备份保留。"
    ${EndIf}
  ${EndIf}
!macroend

!macro CD_CheckAppStopped
  !define CD_CheckID ${__LINE__}
  IfFileExists "$APPDATA\${BUNDLEID}\writer.lock" 0 cd_lease_clear_${CD_CheckID}
    SetErrorLevel 2
    IfSilent +2
      MessageBox MB_OK|MB_ICONEXCLAMATION "请先从播放器托盘选择“退出”，再安装或卸载。若上次异常关闭，请先打开现有播放器完成恢复，再退出。收藏与音乐文件会保留。"
    Abort
  cd_lease_clear_${CD_CheckID}:
  !insertmacro RestartManager_StartSession $R0
  ${If} $R0 == ""
    SetErrorLevel 2
    Abort "无法检查程序是否已退出，未修改程序文件。"
  ${EndIf}
  !insertmacro RestartManager_RegisterFile $R0 "$INSTDIR\${MAINBINARYNAME}.exe"
  ${If} $0 == 0
    !insertmacro RestartManager_RegisterFile $R0 "$INSTDIR\runtime\node.exe"
  ${EndIf}
  ${If} $0 == 0
    System::Call 'RSTRTMGR::RmGetList(p R0, *i .r1, *i .r2, p 0, *i .r3) i .r0'
  ${EndIf}
  StrCpy $R4 $0
  !insertmacro RestartManager_EndSession $R0
  ${If} $R4 != 0
    SetErrorLevel 2
    IfSilent +2
      MessageBox MB_OK|MB_ICONEXCLAMATION "播放器或播放服务仍在使用程序文件，请从托盘退出后重试。安装器不会强行关闭程序。"
    Abort
  ${EndIf}
  !undef CD_CheckID
!macroend
