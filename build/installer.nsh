; ==============================================================================
;  build/installer.nsh —— 「DSH 插件台」NSIS 安装器定制脚本
;
;  作用：把安装向导「选择安装位置」页里用户选中的目录当作【父目录】，
;        安装程序自动在其中创建「DSH 插件台」子目录，并以该子目录为真正的
;        安装目录（$INSTDIR）。用户选 E:\软件 -> 实际装到 E:\软件\DSH 插件台；
;        选 E:\ -> 实际装到 E:\DSH 插件台。
;
;  为什么不用 electron-builder 的配置项解决：nsis 的 scheme 里**没有**任何
;  installDirectory / 子目录 相关选项（已 grep scheme.json 确认），
;  官方自带的「补一层子目录」逻辑写死在 templates/nsis/assistedInstaller.nsh
;  里（见下面 ④ 的说明），只能在 NSIS 脚本层接管。
;
;  本文件由 electron-builder 自动加载：nsis.include 默认值就是
;  build/installer.nsh（app-builder-lib/out/targets/nsis/NsisTarget.js:709
;  的 getResource(options.include, "installer.nsh")），这里额外在
;  electron-builder.yml 里显式写明，便于后来人一眼看到这个文件的存在。
; ==============================================================================


; ------------------------------------------------------------------------------
; ① 常量：自动创建的子目录名（本脚本的唯一真源）
;    为什么抽成常量：这个名字同时出现在三个地方 ——
;      a) 默认安装目录名（靠 ② 覆盖 APP_FILENAME 来对齐）
;      b) 用户选完父目录后自动追加的那一层子目录名（④ 里的追加逻辑）
;      c) 目录选择页上给用户看的中文提示（③）
;    抽成常量后，将来要改名只动这一行，三处不会互相漂移。
; ------------------------------------------------------------------------------
!define DSH_APP_DIRNAME "DSH 插件台"


; ------------------------------------------------------------------------------
; ② 把 APP_FILENAME 覆盖成产品名，让「默认安装目录」也自带这一层
;
;    事实（读源码得出，不是猜的）：
;      electron-builder 给 makensis 传的 /DAPP_FILENAME 取自
;      getWindowsInstallationDirName(appInfo, !oneClick || isPerMachine)
;      —— out/targets/nsis/NsisTarget.js:270；
;      该函数在 win.executableName 是「纯 ASCII」时优先用 executableName
;      —— out/targets/targetUtil.js:40-42（正则 /^[-_+0-9a-zA-Z .]+$/）；
;      本项目 win.executableName = "DSHPluginConsole"（ASCII），
;      isTryToUseProductName = !oneClick || isPerMachine = true，
;      => APP_FILENAME = "DSHPluginConsole"（**不是** "DSH 插件台"）。
;
;    后果：不覆盖的话，默认安装目录是
;      %LOCALAPPDATA%\Programs\DSHPluginConsole
;    （默认值构成见 templates/nsis/multiUser.nsh:30,36,47：
;      $LocalAppData\Programs 再拼 ${APP_FILENAME}），
;    自动追加的子目录也会叫 DSHPluginConsole，跟「DSH 插件台」对不上。
;
;    所以这里用 !define /redef 覆盖它，覆盖后：
;      默认目录 = %LOCALAPPDATA%\Programs\DSH 插件台  ← 末段就是目标名
;      自动追加的名字 = DSH 插件台
;    这样「用户什么都不改直接下一步」时，④ 的幂等判定会认出末段已达标，
;    不会再套一层，绝不会出现 ...\DSH 插件台\DSH 插件台。
;
;    为什么必须带 /redef：APP_FILENAME 来自命令行 /D，属于「已在命令行上定义」
;    的符号，不带 /redef 去重复定义会被 NSIS 拒绝/告警。
;    （已用真实 makensis 3.0.4.1 + -DAPP_FILENAME=DSHPluginConsole 实测通过，
;      见交稿「验证记录」。）
; ------------------------------------------------------------------------------
!define /redef APP_FILENAME "${DSH_APP_DIRNAME}"


; ------------------------------------------------------------------------------
; ③ 目录选择页文案：必须在页面上就告诉用户「会多建一层子目录」
;    否则页面显示的是父目录、实际装进子目录，界面就是在骗人。
;
;    为什么用 MUI_DIRECTORYPAGE_TEXT_TOP：MUI2 目录页顶部说明文字的官方旋钮，
;    最终喂给 DirText 的第一个参数
;    —— Contrib\Modern UI 2\Pages\Directory.nsh:38（MUI_DEFAULT 先定义者优先）
;       与 :47（DirText "${MUI_DIRECTORYPAGE_TEXT_TOP}" ...）。
;    本文件在整份脚本的**最前面**被 !include，所以这里的定义早于
;    MUI_PAGE_DIRECTORY 的插入点，能稳定生效（模板里也没有别的地方定义它，
;    已 grep messages.yml / assistedMessages.yml 确认无冲突）。
;    产品安装包语言是简体中文（electron-builder.yml: nsis.language '2052'），
;    所以文案直接用中文。
; ------------------------------------------------------------------------------
!define MUI_DIRECTORYPAGE_TEXT_TOP "提示：安装程序会在你选择的文件夹内自动创建「${DSH_APP_DIRNAME}」子文件夹，并把程序安装到该子文件夹中。"


; ------------------------------------------------------------------------------
; ④ 真正的搬运逻辑
;
;    为什么挂在 customPageAfterChangeDir 里：
;      templates/nsis/assistedInstaller.nsh 里，官方把这个宏插在
;        :30  !define MUI_PAGE_CUSTOMFUNCTION_PRE instFilesPre   （stock 的 PRE 回调）
;        :42  !ifmacrodef customPageAfterChangeDir
;        :43    !insertmacro customPageAfterChangeDir           ← 我们在这里展开
;        :46  !insertmacro MUI_PAGE_INSTFILES
;      也就是说我们的宏体展开在「stock 定义 PRE」之后、「instfiles 页声明」之前，
;      此刻 !define /redef MUI_PAGE_CUSTOMFUNCTION_PRE 就能把 stock 的
;      instFilesPre 顶掉，换成我们自己的函数。而 MUI2 的页面回调是在插入页面那一刻
;      取当前 define 值（Contrib\Modern UI 2\Pages.nsh:105-110，取完立刻 !undef），
;      所以抢在 :46 之前改写是有效的。
;
;    为什么必须用 instfiles 页的 PRE 这个时机（不能挂在目录页 leave 上）：
;      stock 源码自己注释了原因 —— assistedInstaller.nsh:28-29
;      "pageDirectory leave doesn't work (it seems because $INSTDIR is set after
;       custom leave function)"，即目录页 leave 回调里 $INSTDIR 还没定下来。
;      instfiles 页 PRE 是「用户离开目录页之后、Section 真正开始安装之前」，
;      $INSTDIR 此时已是最终候选值，且**早于**所有
;        SetOutPath $INSTDIR / 装文件 / 写注册表 / 建快捷方式
;      （证据：installSection.nsh:60 SetOutPath $INSTDIR，
;        :66-69 installApplicationFiles / registryAddInstallInfo / 快捷方式，
;        以及 include/installer.nsh:104 WriteRegStr ... InstallLocation "$INSTDIR"、
;        :121-123 UninstallString 指向 "$INSTDIR\Uninstall ..."）
;      => 卸载器、快捷方式、注册表全都跟着改后的 $INSTDIR 走，卸载/升级不受影响。
; ------------------------------------------------------------------------------
!macro customPageAfterChangeDir

  ; 顶掉 stock 的 instFilesPre（stock 版本是子串判定 + 不处理尾斜杠/磁盘根，
  ; 且追加的是 ASCII 的 APP_FILENAME）。
  !define /redef MUI_PAGE_CUSTOMFUNCTION_PRE dshInstFilesPre

  ; ----------------------------------------------------------------------------
  ; 内部工具：判断「$INSTDIR 的最后一段」是不是刚好等于 $R8
  ;   入参 $R8 = 目标目录名，出参 $R9（"1" = 是，"0" = 否）
  ;
  ; 为什么不用 stock 那套 ${StrContains}（子串判定）：
  ;   子串判定会把父目录里刚好含产品名的路径（例如 E:\DSH 插件台\软件）
  ;   误判成「已经到位」，于是文件就散落在父目录里，用户看到的现象反而更糟。
  ;   这里必须比「最后一段 == 目标名」，并且要求它前面紧跟一个 '\'
  ;   （避免 E:\xxDSH 插件台 这种末段只是以目标名结尾的目录被误判）。
  ; ----------------------------------------------------------------------------
  Function dshInstDirEndsWith
    StrCpy $R9 "0"
    StrLen $R1 $INSTDIR          ; 当前路径字符数
    StrLen $R2 $R8               ; 目标目录名字符数
    IntCmp $R1 $R2 dsh_ee_same dsh_ee_short dsh_ee_long

    dsh_ee_short:
      ; 路径比目标名还短，不可能等于它
      Goto dsh_ee_end

    dsh_ee_same:
      ; 整串就是目标名
      StrCmp $INSTDIR $R8 0 dsh_ee_end
      StrCpy $R9 "1"
      Goto dsh_ee_end

    dsh_ee_long:
      StrCpy $R3 $INSTDIR "" -$R2          ; 取末尾 N 个字符（负偏移 = 从右往左数）
      StrCmp $R3 $R8 0 dsh_ee_end          ; 末段不是目标名 -> 否
      IntOp $R4 $R1 - $R2                  ; 末段之前还剩几个字符
      IntOp $R4 $R4 - 1                    ; 指向末段前一个字符
      StrCpy $R5 $INSTDIR 1 $R4
      StrCmp $R5 "\" 0 dsh_ee_end          ; 前面不是 '\' -> 是长名字的后半截，不算
      StrCpy $R9 "1"

    dsh_ee_end:
  FunctionEnd

  ; ----------------------------------------------------------------------------
  ; instfiles 页 PRE 回调：在这里把 $INSTDIR 从「用户选的父目录」修正为
  ; 「父目录\DSH 插件台」。
  ; ----------------------------------------------------------------------------
  Function dshInstFilesPre
    ; ---- 0) $INSTDIR 是空串（理论上不该发生）-> 什么都不做，保持 stock 行为 ----
    StrCmp $INSTDIR "" dsh_exit

    ; ---- 1) 规整：去掉末尾所有反斜杠 ----
    ; 为什么要在副本 $R1 上算：用户可能手输 "\" 这种把路径删空的情况，
    ; 先在副本上试，只有确认非空才写回 $INSTDIR，避免把安装路径搞成空串。
    ; 为什么要去尾斜杠：
    ;   a) 「E:\软件\」+"\DSH 插件台" 会变成 "E:\软件\\DSH 插件台"；
    ;   b) 磁盘根 "E:\" 去尾斜杠后得到 "E:"，统一补一个 '\' 才是 "E:\DSH 插件台"
    ;      （不去尾斜杠会得到 "E:\\DSH 插件台"）；
    ;   c) UNC "\\server\share\" 同理。
    StrCpy $R1 $INSTDIR
    dsh_trim:
      StrCpy $R0 $R1 1 -1                ; 取最后一个字符
      StrCmp $R0 "\" 0 dsh_trim_done     ; 不是 '\' -> 规整完成
      StrCpy $R1 $R1 -1                  ; 去掉这个 '\'
      StrCmp $R1 "" dsh_trim_empty dsh_trim
    dsh_trim_empty:
      ; 整串都是反斜杠（"\"/"\\"）：这不是目录页能给出的合法路径，
      ; 此时既不改写 $INSTDIR、也不追加，直接放弃定制，避免把安装路径弄坏
      Goto dsh_exit
    dsh_trim_done:
    StrCpy $INSTDIR $R1

    ; ---- 2) 幂等（A）：末段已经就是目标名 -> 直接收工，不再追加 ----
    ; 为什么必须做这一步：
    ;   a) 用户可能自己手动敲到了 ...\DSH 插件台；
    ;   b) 用户「什么都不改直接下一步」时，$INSTDIR 是 ② 设定的默认目录，
    ;      末段本来就是 DSH 插件台（这正是我特意去覆盖 APP_FILENAME 的原因）；
    ;   c) 重装/手动覆盖安装时，$INSTDIR 已被 initMultiUser 用注册表里的旧
    ;      InstallLocation 预填（multiUser.nsh:26-28），末段命中本判定；
    ;      若这里漏判就会变成 ...\DSH 插件台\DSH 插件台，
    ;      卸载器/快捷方式/注册表全部指向不存在的路径。
    StrCpy $R8 "${DSH_APP_DIRNAME}"
    Call dshInstDirEndsWith
    StrCmp $R9 "1" dsh_exit

    ; ---- 2b) 幂等（B）：注册表说「这个位置已经装过」-> 原地升级，不再追加 ----
    ; 为什么 2) 不够：本版本之前的旧安装包目录名是 ASCII 的 DSHPluginConsole
    ; （推导见 ②），旧版写进注册表的 InstallLocation 因此指向 ...\DSHPluginConsole。
    ; 用户拿新版直接覆盖安装时，$INSTDIR 被预填成那个旧目录，末段不等于
    ; DSH 插件台，2) 判不出来；若继续追加就会装进
    ; ...\DSHPluginConsole\DSH 插件台 —— 旧目录残留、卸载器在旧目录里找不到自己。
    ; 这里用「注册表里的安装位置 == 当前 $INSTDIR」这一通用条件兜住这种情况，
    ; 将来哪怕再改名也不会失效（不用把旧目录名硬编码进来）。
    ; 为什么 HKCU 和 HKLM 都读：perMachine=false 时安装位置写在 HKCU
    ; （multiUser.nsh:26），但安装器也支持提权成 all-users
    ; （installer.nsi:69-75 的 $hasPerMachineInstallation），两种上下文都判一遍才不漏。
    ; 为什么用 !ifdef 包住：INSTALL_REGISTRY_KEY 由 multiUser.nsh:8 定义
    ; （"Software\${APP_GUID}"）。万一将来模板改了键名，这里自动退化（跳过本判定）
    ; 而不是编译不过。
    ; 为什么 $R0 为空串不会误判：上面第 0 步已挡掉 $INSTDIR 为空的情况，
    ; 所以 $R0 == $INSTDIR 只有在注册表确实存了这个路径时才成立。
    !ifdef INSTALL_REGISTRY_KEY
      ReadRegStr $R0 HKCU "${INSTALL_REGISTRY_KEY}" InstallLocation
      StrCmp $R0 $INSTDIR dsh_exit
      ReadRegStr $R0 HKLM "${INSTALL_REGISTRY_KEY}" InstallLocation
      StrCmp $R0 $INSTDIR dsh_exit
    !endif

    ; ---- 3) 追加一层子目录（$INSTDIR 此时已无尾斜杠，这里统一补一个 '\'）----
    ; 为什么统一补 '\'：规整后 "E:\软件" -> "E:\软件\DSH 插件台"；
    ; 磁盘根规整后是 "E:" -> "E:\DSH 插件台"（不会变成 "E:\\DSH 插件台"）；
    ; UNC "\\srv\share" -> "\\srv\share\DSH 插件台"。
    StrCpy $INSTDIR "$INSTDIR\${DSH_APP_DIRNAME}"

    dsh_exit:
  FunctionEnd

!macroend
