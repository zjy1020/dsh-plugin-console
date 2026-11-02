# DSH 安装根 / DSH_HOME / 运行时（node·pnpm）探测重写 —— 设计与实测

> 本文对应一次性修复：新电脑装上「DSH 插件台」后报
> `安装失败（exit -1）：找不到 DSH 自带的 node/pnpm，请到设置里指定安装根`、
> `启动 DSH 失败：找不到 DSH 可执行文件：<安装目录未知>。可以在设置里指定安装目录`。
>
> 目标：**自动找到，不要手动配**。
>
> 涉及文件（只这 6 个）：
> `src/main/engine/env.ts`、`src/main/engine/pnpm.ts`、`src/main/engine/dsh.ts`、
> `src/main/engine/dshproc.ts`、`src/main/ipc.ts`、`src/preload/index.ts`。
> 契约文件 `src/shared/types.ts` / `src/shared/ipc.ts` 由主控冻结，未改。

---

## 0. 一句话结论

旧实现把「安装根在哪」当成一道**命名约定题**（6 个写死的候选路径），
而真实世界的答案有四种载体：设置、提示文件、**注册表**、**快捷方式**，
以及「用户爱放哪儿就放哪儿」的磁盘现实。新实现把探测做成**多路由 + 分层执行**：

- 同步路由（设置 / 环境变量 / 提示文件 / 固定猜测 / 父目录枚举 / 快捷方式 / 有界磁盘扫描）
  必须**零子进程**，保证 `getInstallRoot()` 这个热路径调用不吃几十毫秒；
- 异步富化（注册表 / 运行中的进程 / WScript 精确解析快捷方式）单独导出，
  在应用起来之后补一刀，命中就写进程内缓存 + 落 `settings.installRoot`（只在原本为空时写）；
- 每条路由的成败都进 `DiscoveryStep[]` 诊断轨迹，UI 能显示「试过哪些、为什么没成」。

本机实测（见第 4 节）：**把「设置 + 环境变量 + 提示文件」三条明确来源全部屏蔽后，
新路由仍然命中 `D:\Dowloads\DeepSeekHarness`**；把同步路由也全部屏蔽，
异步路由分别从**注册表**、**运行中的进程**、**WScript 快捷方式**三条独立路径各自命中同一目录。

---

## 1. 老机器为什么能找到，新电脑为什么找不到

### 1.1 现象 ←→ 归因

| 用户看到的现象 | 真实原因 |
| --- | --- |
| `安装失败（exit -1）：找不到 DSH 自带的 node/pnpm，请到设置里指定安装根` | 文案把**两件独立的事**混成了一句：①安装根没探到；②DSH_HOME 下没有 `dsh-runtimes\*\dependencies\node\bin\node.exe`。旧代码只检查②，却让人去改①。 |
| `启动 DSH 失败：找不到 DSH 可执行文件：<安装目录未知>` | `env.getInstallRoot()` 返回 `null`，`dsh.findExe()` 无路可走。 |
| 清单批量安装时 12 个包**逐个**报同一条 | 每个包都会各自走一次 `resolveNodePath()/resolvePnpmPath()`，而它们是「每次现算、没缓存命中就再算一遍」的路径；探测失败**不是**一次性的，是每个包一遍。 |

### 1.2 老机器靠的是「提示文件」，不是「猜」

旧 `installRootCandidates()`（旧 `env.ts:119-166`）只有 6 条候选，按序：

1. `settings.installRoot`
2. `process.env.DSH_INSTALL_ROOT`
3. `<dshHome>/dsh-purge/desktop-install.txt` 的第一行
4. `%LOCALAPPDATA%\Programs\DeepSeekHarness`
5. `C:\Program Files\DeepSeekHarness`
6. `%LOCALAPPDATA%\deepseek-harness`

老机器（开发者机）命中的是 **③**。实测该文件内容就是一行：

```
D:/Dowloads/DeepSeekHarness
```

（旧代码只做了 `/`→`\` 的替换，所以这一行能直接当路径用。）

### 1.3 新电脑三个都没了，而「固定猜测」全错在名字上

新电脑上：

- ① `settings.installRoot` 是 `null`（全新安装，没人填过）；
- ② 环境变量没有（没人会去设 `DSH_INSTALL_ROOT`）；
- ③ **`desktop-install.txt` 不存在** —— 这个文件是「本机曾经启动过 DSH / 卸载器留下的记录」，
  新电脑上先装插件台、DSH 还没跑过，就没有它；
- ④⑤⑥ 三条固定猜测的**目录名都不对**：真实目录名是 **`DeepSeek Harness`（带空格，与 exe 同名）**，
  而候选写的是 `DeepSeekHarness`（无空格）、`deepseek-harness`。

于是 `installRoot = null`，紧接着 `checkRuntime()` 的判定顺序会把它报成「缺安装根」，
但旧文案却写的是「找不到 node/pnpm」——用户被指去了错误的方向。

本机 `%LOCALAPPDATA%\Programs` 下的实际内容（实测）：

```
CC Switch, Codex++, Common, Cua, DSH Desktop（空目录）, Fiddler Everywhere,
oh-my-posh, Python, TraeDaddy, WorkDaddy, WorkDaddy AI, ZCode
```

注意：**有 `DSH Desktop`，但它是空目录**（没有 `resources\app\package.json`）。
这条不仅说明「名字变体」要补，还说明**光靠名字永远不够，必须过校验**。

### 1.4 现成的答案一直躺在注册表里

本机 `HKCU\Software\Microsoft\Windows\CurrentVersion\Uninstall\{1bf39983-50d0-5fe0-9ef4-cece76f67c5e}`：

```
DisplayName     = DeepSeek Harness 0.2.1-rc.5
InstallLocation = D:\Dowloads\DeepSeekHarness
UninstallString = "D:\Dowloads\DeepSeekHarness\Uninstall DeepSeek Harness.exe" /currentuser
DisplayIcon     = D:\Dowloads\DeepSeekHarness\DeepSeek Harness.exe,0
```

三个字段指向同一个目录，任取其一都能反推出安装根。新电脑上同样会有这条
（Electron/NSIS 安装器都会写 Uninstall 项），这才是「新电脑上一定存在」的信息源。

⚠️ 但**不能只读 `InstallLocation`**：我们自己的安装包（`DSH 插件台`）那条注册表项
`InstallLocation` 是空串，只有 `UninstallString` / `DisplayIcon` 可用。
所以反推顺序必须三级：`InstallLocation` → `UninstallString` 里第一个 `"X:\...\*.exe"` 的
`dirname` → `DisplayIcon` 去掉尾部的 `,0` 再 `dirname`。

### 1.5 「找不到 node/pnpm」是另一件独立的事

`getNodePath()`（旧 `env.ts:211-223`）**只**从 `<dshHome>/dsh-runtimes/*/dependencies/node/bin/node.exe`
找，与 `installRoot` 完全无关。所以：

- 安装根找不到 → 报「找不到 node/pnpm」，**错**；
- 安装根找到了、但 DSH 一次都没启动过（`dsh-runtimes` 还没展开）→ 也报同一句，**方向对但不精确**。

修复后的 `checkRuntime()` 把这两件事拆成 `/install-root`、`node`、`pnpm` 三档，**缺哪环说哪环**。

---

## 2. 新探测的完整路由表

### 2.1 installRoot：同步路由（`env.ts`，零子进程）

顺序即优先级，**每一条都必须过 `isValidInstallRoot()` 才算命中**
（读 `<dir>/resources/app/package.json`，要求 `name === '@deepseek-ai/dsh-desktop'`）。

| # | group | 来源 | 做法 | 开销（本机实测/估） | 失败模式 |
| --- | --- | --- | --- | --- | --- |
| A1 | 设置 | 用户手填 | `settings.installRoot` | ~0.2ms | 路径无效 → 单条 warning |
| A2 | 环境变量 | `DSH_INSTALL_ROOT` | 直接用 | ~0.1ms | 未设置 |
| A3 | 提示文件 | `<dshHome>/dsh-purge/desktop-install.txt` 第一行（`/`→`\`） | 读一行 | ~0.3ms | 新电脑上文件不存在 |
| B | 固定猜测 | 名字变体 × 标准落点 | `DeepSeek Harness` / `DeepSeekHarness` / `DSH Desktop` / `deepseek-harness` ×（`%LOCALAPPDATA%\Programs`、`%ProgramFiles%`、`%ProgramFiles(x86)%`）+ `%LOCALAPPDATA%` 直下两个变体 + 旧值 `C:\Program Files\DeepSeekHarness` | 10 次 `existsSync`，~1ms | 名字对不上就全灭 |
| C | 父目录枚举 | **不猜名字** | 对 `%LOCALAPPDATA%\Programs`、`%ProgramFiles%`、`%ProgramFiles(x86)%` 的**每个**子目录（每个上限 80）直接校验 | 本机 41 条候选，~5ms | 目录不在三个标准父目录下 |
| D | 快捷方式 | 桌面 / 开始菜单 `.lnk` 的二进制字符串 | 名字匹配 `/deepseek\|harness\|dsh/i` 的 `.lnk`（含子目录，上限 24 个文件 / 150 个目录 / 深度 3），`toString('utf16le')` 扫出候选路径 → 逐级 `dirname` 全部校验 | 本机 4 个 lnk，约 30ms（V2） | 用户没建快捷方式 / 名字里没有关键词 |
| E | 磁盘扫描 | 有界兜底 | 见 2.2 | 本机 18ms（V3） | 见 §3.2 |

**关键设计：D 与 E 只在前面全不中时才生成（`ctx.anyValid()` 短路）**，
短路时往轨迹里补一条「跳过：前面的候选里已经命中有效安装根…」，
免得看轨迹的人以为这些路由「一条都没试」。

### 2.2 installRoot：E 磁盘扫描的两层策略

| 层 | 范围 | 判据 | 上限 |
| --- | --- | --- | --- |
| 0 | `<盘>\DeepSeekHarness`、`<盘>\DeepSeek Harness` | 直接校验 | 每盘 2 条 |
| 1 | `<盘>\*` 的**每个**一级子目录 | 名字无关，**全部直接校验** | 每盘 200 |
| 2 | 只对「值得下探」的一级目录再列一层 | `DISK_SCAN_INTENT_RE` 命中 **或** 该目录下直接存在 `resources` | 每个目录 50 |
| 3 | （不扫） | —— | —— |

`DISK_SCAN_INTENT_RE`（`env.ts:501`）= `/deepseek|harness|dsh|download|dowload|down|software|program|apps?|tools?|portable|green|setup|install|bin|下载|软件|程序|便携|绿色|工具|安装包/i`

跳过目录（`SYSTEM_DIR_NAMES`，`env.ts:464`）：`$…` 前缀、`windows`、`program files`、
`program files (x86)`、`programdata`、`users`、`$recycle.bin`、`system volume information`、
`recovery`、`perflogs`、`msocache`、`boot`、`config.msi`、`$windows.~bt`、`$windows.~ws`、
`documents and settings`、`windows.old`、`intel`、`amd`、`nvidia`、`temp`、`tmp`、`node_modules`。

### 2.3 installRoot：异步富化（`enrichInstallRoot()`，`env.ts:1318`）

| # | group | 手段 | 命令 | 开销（本机实测） |
| --- | --- | --- | --- | --- |
| F | 注册表 | `reg.exe query` × 3 个 hive（HKCU / HKLM / HKLM\WOW6432Node 的 Uninstall）并行 | `reg.exe query "<hive>" /s`（`timeout:8000, windowsHide, maxBuffer:4MB, encoding:'buffer'` + GBK 解码） | **2130ms** |
| G | 运行中的进程 | 正在跑着的 DSH 的 exe 路径 | `powershell.exe -NoProfile … Get-CimInstance Win32_Process -Filter "Name LIKE '%DeepSeek%' OR …" \| Select-Object -ExpandProperty ExecutablePath` | **460ms** |
| H | 快捷方式（WScript 精确解析） | 同步二进制解析失败时的备用 | 一条 PS 命令里拼 ≤20 个 lnk：`$s=New-Object -ComObject WScript.Shell; …$s.CreateShortcut('…').TargetPath`，每条目标前打 `<<序号>>` 标记防错位 | **365ms** |

- 注册表反推三级：`InstallLocation` → `UninstallString` 第一条 `"X:\…\*.exe"` 的 `dirname` → `DisplayIcon` 去 `,\d+` 后 `dirname`；
  只有 `DisplayName` 或任一值匹配 `/deepseek|harness|dsh/i` 的段落才算候选。
- 进程路由跳过 `process.execPath`（自己），避免把「插件台」自己当 DSH。
- **H 只在同步路由 + F + G 全都没拿到时才跑**（`else if (!root)`，`env.ts:1364`）。
- 命中后**只写进程内 `installRootCache`**；落盘 `settings.installRoot` 由 IPC 层统一做（见 §7），
  且**只在原本为空时写**，绝不覆盖用户手填。

### 2.4 DSH_HOME 路由（`resolveDshHome()`，`env.ts:196`）

| # | 来源 | 判据 |
| --- | --- | --- |
| 1 | `settings.dshHome` | **只要目录存在就认**（用户明确指定的，不做「像不像」的二次判断） |
| 2 | `DSH_HOME` 环境变量 | 同上 |
| 3 | `%USERPROFILE%\.dsh` | 必须过 `looksLikeDshHome()` |
| 4 | `%USERPROFILE%\.deepseek` | 同上 |
| 5 | `%APPDATA%\dsh` | 同上 |
| 6 | `%LOCALAPPDATA%\dsh` | 同上 |
| 7 | `%APPDATA%\DeepSeek Harness` | 同上 |
| 8 | `%LOCALAPPDATA%\DeepSeek Harness` | 同上 |
| 9 | `%USERPROFILE%\.dsh-desktop` | 同上 |
| 10 | **退回旧行为** `~/.dsh` | 不校验（兼容） |

`looksLikeDshHome(dir)`（`env.ts:174`）：目录下存在 `dsh-runtimes\` **或** `profiles\` **或**
`plugins\` **或** `config.json` / `settings.json`。

`getDshHome(): string` **返回类型保持 `string`**（大量调用方假设它永远有值）；
来源另经 `getDshHomeFrom(): string`（`env.ts:249`）暴露，进 `RuntimeInfo.dshHomeFrom`。

### 2.5 诊断轨迹 `DiscoveryStep[]`

分组名（UI 直接按这个分栏）：
`设置`、`环境变量`、`提示文件`、`固定猜测`、`父目录枚举`、`快捷方式`、`磁盘扫描`、
`注册表`、`运行中的进程`、`运行时`、`DSH_HOME`。

- 上限：`MAX_STEPS_PER_GROUP = 40`（`env.ts:121`）。超出时**整组合并**成一条
  `…另有 N 条同类，已省略`（`clampDiscoverySteps()`，`env.ts:157`）。
  为什么要上限：父目录枚举 + 磁盘扫描天然会产生几百条，IPC 上不该传几 MB 的数组。
- `resolveInstallRoot(warnings?, steps?, log?)`（`env.ts:674`）在逐条校验时写轨迹：
  - 命中 → `命中：resources/app/package.json 的 name = @deepseek-ai/dsh-desktop`
  - 未命中 → `没有 resources/app/package.json，或包名不是 @deepseek-ai/dsh-desktop`
- `resolveNodePath(steps?)` / `resolvePnpmPath(node, steps?)` 也把「在哪找过」写进 `运行时` 组。
- `buildRuntimeInfo()`（`env.ts:1410`）合并规则：`installRoot = 同步结果 ?? installRootCache?.value ?? null`
  —— **异步路由找到的根不能被同步路由的 `null` 覆盖**（否则 `enrich` 白干）。

---

## 3. 每条路由为什么这么写

### 3.1 为什么同步部分绝不能包含注册表和进程

`getInstallRoot()` 是**热路径**：`pnpm.spawnProcess()`、`dsh.findExe()`、`dshproc.locateExePath()`、
`inventory`、`spec`、设置面板……都在同步上下文里直接问它。它一旦开始起子进程：

- 单次 `reg.exe query /s` 实测 **2130ms**、`Get-CimInstance Win32_Process` 实测 **460ms**；
- 上面那些调用点有的在 `ipcMain.handle` 里（会卡住 UI 线程，Electron 主进程是单线程）；
- 批量安装 12 个包就是 12 次 → 分钟级的卡死。

所以拆成两段：**同步段只做「文件/注册表之外的事」**（读设置、读一个小的提示文件、`existsSync`、
`readdirSync`、读 `.lnk` 的字节），异步段（`enrichInstallRoot()`）才起进程。
同步段的整体实测：**V1 4ms / V2 33ms / V3 18ms**（见第 4 节）。

### 3.2 为什么磁盘扫描必须有界，界在哪

四道闸（`env.ts:518-521`）：

```
DISK_SCAN_MAX_MS       = 1200   // 时间闸：超时即停，没扫到的算认命
DISK_SCAN_MAX_TOP_DIRS = 200    // 每个盘的一级目录上限
DISK_SCAN_MAX_DIRS     = 260    // 全局 readdir 次数上限
DISK_SCAN_MAX_KIDS     = 50     // 每个「值得下探」的目录再列几个子目录
```

最坏情况可以算出来：`6 个盘（C..H）× 200 个顶层目录 × 1 次 existsSync`
＋ `≤260 次 readdir`（＋每次 readdir 内部的 `withFileTypes`），**任何一项先到即停，1.2s 硬封顶**。

为什么第一层要「名字无关、全部直接测」：
几百次 `existsSync` + 小 JSON 读的代价可以忽略（本机实测整轮十几毫秒），
换来的是「不管用户把目录起成什么名字都能撞上」。命名约定这条路已经被证明不够用了（§1.3）。

为什么跳过那些系统目录：它们**一定能枚举但一定不是安装根**，
而 `System Volume Information` / `$RECYCLE.BIN` 这类目录 `readdir` 还容易因权限卡住或很慢，
先排掉能省一大半预算。`node_modules` 同理（数量巨大、绝无可能）。

为什么要 `statSync`/`isDirectory` 先过滤：`<盘>\*` 里可能有几十个**文件**（比如散落的
`.iso`、`.zip`），它们不需要任何后续处理，`e.isDirectory()` 一次判断就省掉一串无谓的 `join`。

### 3.3 为什么第二层的判据必须放宽（本次修复最核心的一课）

本机真实布局是：

```
D:\Dowloads\DeepSeekHarness\        ← 用户把 Downloads 拼成了 Dowloads
D:\Dowloads\Bandizip\
D:\Dowloads\...
```

第一版实现第二层的判据是「名字匹配 `/deepseek|harness|dsh/i` 才往下探」——
**`Dowloads` 不匹配，于是第二层永远打不开，也就永远找不到**。
这恰好是「新电脑 / 陌生机器」最典型的失败形态：别人的目录结构不是按你的命名约定长的。

所以判据放宽成三者任一：

1. 名字匹配 `/deepseek|harness|dsh/i`；
2. 名字匹配**存放软件的意图词**（`download|dowload|down|software|program|apps?|tools?|portable|green|setup|install|bin` + `下载|软件|程序|便携|绿色|工具|安装包`）—— 连 `dowload` 这种真实错拼都收录进去了；
3. **该目录下直接存在 `resources`**（那就别猜了，直接测）。

对应地，第一层对**每个**顶层目录都直接 `push` 一次校验：`D:\Dowloads` 本身也会被试一遍，
万一用户就是把安装文件直接解压成了 `<盘>\<某个奇怪名字>\resources\app\package.json`，也照样命中。

### 3.4 为什么 D / E 只在前面全不中时才跑

- D 读 24 个 `.lnk` + 每个文件做 UTF-16 扫描 + 每个候选沿 `dirname` 上溯 8 跳（实测约 30ms）；
- E 要 `readdir` 两三百次（实测 18ms，但目录结构大的机器上是百毫秒级）。

设置里 / 明确来源已经给了能用的路径时，这些开销纯粹是浪费。
所以短路，并在轨迹里补一条说明——**短路的语义是「跳过生成候选」，不是「跳过校验」**。

### 3.5 为什么 `.lnk` 解析不能用一条贪婪正则

实测把 `C:\Users\YBY\Desktop\桌面图标\DeepSeek Harness.lnk`
用 `readFileSync().toString('utf16le').replace(/\u0000/g,'')` 打开，得到的是**一整段粘连文本**：

```
EElectron desktop shell for a bundled dsh runtime and external plugins.
D:\Dowloads\DeepSeekHarness0D:\Dowloads\DeepSeekHarness\DeepSeek Harness.exe
```

路径、描述文字、长度字段**没有 NUL 分隔**（甚至中间夹了一个字面字符 `0`）。
用 `/[\w\s\u4e00-\u9fa5().\-_\\:]+?\.exe/` 这种写法只会匹配出一整条粘连串，
`dirname` 之后必然不是有效目录 —— 旧代码「拿最长的那个」的做法在这里直接失效。

新做法（`lnkPathVariants()`，`env.ts:421`）：把文本按**每个盘符起点** `[A-Za-z]:\\` 切成若干段，
每段用**懒惰**正则只取到第一个 `.exe` 为止；然后对每个种子沿 `dirname` **逐级上溯 8 跳**，
把沿途每一级都当候选校验一次。

实测这条链在本机的行为正好印证了必要性：先试出无效的 `D:\Dowloads\DeepSeekHarness0`、
再上溯到 `D:\Dowloads`、`D:\`，最后命中真目标 `D:\Dowloads\DeepSeekHarness`（V2 轨迹可见）。

### 3.6 为什么 `enrich` 只写进程内缓存、落盘交给 IPC 层

探测函数保持**纯粹**（只回答「找到了没有」），
「要不要写进用户的 `settings.json`」这条规则只有一处：`ipc.ts` 的启动补刀里，
且**只在 `settings.installRoot` 原本为空时写**。理由：

- 用户手填过的路径是他的**显式意图**，任何自动探测都不该覆盖它；
- 一旦覆盖，用户改回来还会被下一次探测再改掉，变成打地鼠；
- 反过来，自动探测写进去又有个好处：下次冷启动 `settings.installRoot` 已经是有效值，
  同步路由 A1 直接命中，**不必再跑磁盘扫描**。

### 3.7 为什么 `getDshHome()` 必须有校验、却又必须仍然返回 `string`

必须有校验：旧实现「`~/.dsh` 不存在也照样返回」，于是后面所有路径拼接都在一个不存在的目录下
展开，报错信息变成了指向错误方向的一堆「找不到」。

必须仍然返回 `string`：`getProfileDir()` / `listProfileNames()` / `buildChildEnv()` /
`<dshHome>/dsh-runtimes` 的拼法全都假设它非空，改签名会波及几十处调用点，
且 `RuntimeInfo.dshHome` 的类型也是 `string`（契约冻结）。所以：

- 明确来源（设置 / 环境变量）**只要目录存在就认**——不做「像不像 DSH_HOME」的二次判断，
  否则用户在设置里指定了一个「还没被 DSH 展开过」的空目录，会被静默丢弃，比不认更让人困惑；
- 猜测来源必须过 `looksLikeDshHome()`；
- 全不通过 → 退回 `~/.dsh`（旧行为），并在 `RuntimeInfo.warnings` 里说明目录不存在。

### 3.8 为什么 `checkRuntime()` 要拆开报

原来 pnpm.ts 里那句 `找不到 DSH 自带的 node/pnpm，请到设置里指定安装根` 同时踩了两个坑：

1. 它把「安装根没有」和「运行时没有」混在一起，用户照着改「安装根」也可能无效；
2. 它出现在**批量安装**的循环里，12 个包刷 12 遍同一句，
   完全看不出「根因只有一个」。

`checkRuntime()`（`env.ts:1017`）按 `install-root` → `node` → `pnpm` 顺序判定，
**第一个缺的**就是 `missing`，`message` 说清缺什么，`fix` 给一句可操作的动作。
pnpm.ts 的三处（`pnpm.ts:137`、`pnpm.ts:326`、`pnpm.ts:346`）改成用它，
并且日志拆成两条：一条短句（喂给 UI），一条带完整路径（排障用）。

### 3.9 为什么 node 的负结果要有 20 秒 TTL

`<dshHome>/dsh-runtimes` 是 **DSH 自己**在启动时展开的。
插件台比 DSH 先起来时，这条路径必然还不存在。如果负结果被永久缓存，
就会出现「DSH 已经启动好了，但插件台还认为没有 node，必须重启插件台」。
`NODE_MISS_TTL_MS = 20_000`（`env.ts:855`）让负结果 20 秒后自动失效重算；
正结果（找到了）一直有效到 `invalidate()`。

---

## 4. 实测证据（Windows，用户 YBY，本机）

### 4.1 探针怎么搭的（**没有为测试在仓库代码里留任何开关**）

为了能逐条屏蔽路由，我做了 `%TEMP%` 下的独立探针（跑完删除，不进仓库）：

```
C:\Users\YBY\AppData\Local\Temp\dsh-env-probe\
  src\main\engine\{env.ts,settings.ts}   ← 仓库文件的副本
  src\shared\{types.ts,ipc.ts}           ← 仓库文件的副本
  node_modules\                          ← junction 指向项目的 node_modules
  userdata\ , fakehome\                  ← 两个空目录
  probe.js                               ← 探针（Module._load 桩 + fs 桩）
  out\ , out-worst\                       ← 编译产物
```

编译：

```powershell
& <项目>\node_modules\typescript\bin\tsc --outDir $tmp\out --rootDir $tmp\src `
  --module commonjs --target es2022 --moduleResolution node --skipLibCheck `
  --types node --esModuleInterop --allowSyntheticDefaultImports $tmp\src\main\engine\env.ts
# exit=0
```

`probe.js` 做的事：

- `Module._load` 桩：`electron` → `{ app: { getPath: () => stubUserData } }`；
- `fs` 桩按命令行开关生效：

| 开关 | 屏蔽的事 |
| --- | --- |
| `--hide-explicit` | 把 `DSH_HOME` 指到空目录 `fakehome`（于是没有 `desktop-install.txt`）+ 删掉 `DSH_INSTALL_ROOT` |
| `--hide-lnk` | 桌面 / 开始菜单目录 `readdir` 抛 `ENOENT` |
| `--hide-lnkparse` | `.lnk` 的 `readFileSync` 返回垃圾（只废**同步二进制解析**，保留 WScript 那条路） |
| `--hide-drives` | `existsSync('X:\\')` 一律 `false` |
| `--hide-reg` | `reg.exe` 调用返回空 |
| `--hide-proc` | 含 `Win32_Process` 的 `execFile` 返回空 |
| `--deep` | 顺带跑 `enrichInstallRoot()` |
| `--worst` | 改用 `out-worst`：去掉磁盘扫描短路的临时副本（测最坏情况） |

- 输出：`syncRoot / syncMs / enrichRoot / enrichFrom / enrichMs / dshHome / dshHomeFrom /
  nodePath / pnpmPath / check / stepsByGroup / warnings`。

### 4.2 十种场景的真实输出

| 场景 | 命令行开关 | 命中来源 | 耗时 | 结果 |
| --- | --- | --- | --- | --- |
| V1 基线 | （无） | `desktop-install.txt` | sync **4ms** | `D:\Dowloads\DeepSeekHarness` |
| V2 屏蔽明确来源 | `--hide-explicit` | **快捷方式**（二进制） | sync **33ms** | 同上 |
| V3 再屏蔽快捷方式 | `--hide-explicit --hide-lnk` | **磁盘扫描** | sync **18ms** | 同上 |
| V4 同步全灭 | `+ --hide-drives` | —— | sync 9ms | `null` → `checkRuntime` 报 `install-root` |
| V5 异步补刀 | V4 `+ --deep` | **注册表** | enrich **2130ms** | 同上（命中） |
| V6 再屏蔽注册表 | V5 `+ --hide-reg` | **运行中的进程** | enrich **460ms** | 同上（命中） |
| V7 异步也全灭 | `--hide-reg --hide-proc --hide-lnk` | —— | enrich 2ms | `null`（预期：`--hide-lnk` 同时掐掉了 WScript 的 lnk 收集） |
| V8 只剩 WScript | `--hide-explicit --hide-lnkparse --hide-drives --hide-reg --hide-proc --deep` | **快捷方式**（WScript） | enrich **365ms** | 同上（命中） |
| V9 最坏情况 | `--hide-explicit --hide-lnk --worst`（×3 次） | 磁盘扫描（四盘全扫完） | sync **14 / 13 / 26ms** | 同上 |

### 4.3 核心验收点：屏蔽前三条明确来源，仍然命中

父代理给的硬指标就是这一条。**V2 的真实输出**（`--hide-explicit`：设置为空、
`DSH_INSTALL_ROOT` 不存在、`desktop-install.txt` 所在的 DSH_HOME 被换成一个空目录）：

```json
{
  "syncRoot": "D:\\Dowloads\\DeepSeekHarness",
  "syncMs": 33,
  "installRootFrom": "快捷方式",
  "dshHome": "C:\\Users\\YBY\\AppData\\Local\\Temp\\dsh-env-probe\\fakehome",
  "dshHomeFrom": "DSH_HOME 环境变量"
}
```

再把快捷方式也屏蔽（**V3**）——只剩磁盘扫描：

```json
{
  "syncRoot": "D:\\Dowloads\\DeepSeekHarness",
  "syncMs": 18,
  "installRootFrom": "磁盘扫描"
}
```

V3 的 `磁盘扫描` 轨迹里可以清楚看到**放宽后的第二层确实进得去 `Dowloads`**：

```
D:\Dowloads                          ✗ 没有 resources/app/package.json…
D:\Dowloads\Bandizip                 ✗ …
D:\Dowloads\DeepSeekHarness          ✓ 命中：resources/app/package.json 的 name = @deepseek-ai/dsh-desktop
```

再把磁盘也屏蔽（**V5/V6/V8**）：异步三条路由**各自独立**都能命中同一个目录。

结论：**四类信息源（提示文件 / 快捷方式 / 磁盘 / 注册表·进程·WScript）互相独立，
任意一类可用就能定位到安装根**。新电脑上「设置空 + 提示文件不存在 + 目录名不认识」
这三件事同时发生，仍然有三条以上的路可以走通。

### 4.4 耗时实测汇总

| 路由 | 实测耗时 | 备注 |
| --- | --- | --- |
| 同步整体（含提示文件） | 4ms | V1 |
| 同步整体（含 `.lnk` 二进制解析） | 33ms | V2 |
| 同步整体（含磁盘扫描） | 18ms | V3 |
| 磁盘扫描最坏（四盘全扫，无短路） | 13 / 14 / 26ms | V9，跑 3 次 |
| 注册表（3 hive 并行 `reg query /s`） | 2130ms | V5 |
| 运行中的进程（`Get-CimInstance`） | 460ms | V6 |
| WScript 批量解析 20 个 lnk | 365ms | V8 |

**为什么最坏只有十几毫秒**：本机四个盘的一级目录数是 `C=20 / D=23 / E=9 / F=8`
（G、H 不存在），扣掉系统目录后约 40 个候选，加上第二层展开的若干次 `readdir`，
总共约 36 条磁盘扫描轨迹 —— 也就是几十次 `existsSync` + 十几次 `readdir` 的量级。
换到「一级目录几万个」的机器上，则由 `MAX_TOP_DIRS=200` 与 `MAX_MS=1200` 封顶。

### 4.5 轨迹上限确实生效

V3 的 `stepsByGroup`：`固定猜测` 10 条、`父目录枚举` **41 条**（第 41 条是
`…另有 1 条同类，已省略`）、`磁盘扫描` 36 条。
即：单组超过 40 条时会被合并成一条省略说明，IPC 上不会出现几 MB 的数组。

---

## 5. 我没能验证的东西（如实列）

1. **新电脑上的真实表现**：本机是开发者机，注册表 / 快捷方式 / 提示文件全都在。
   V2–V8 是用探针**逐条屏蔽**模拟新电脑，属于等价性验证，
   没有在真正的 clean 安装机器上跑过（手上只有这一台）。
2. **我们自己的安装包（`DSH 插件台`）的注册表项**：任务书说它的 `InstallLocation` 是**空串**，
   只能从 `UninstallString` / `DisplayIcon` 反推。**本机没有装过它**，
   `HKCU\...\Uninstall` 下只有 DeepSeek Harness 一条，所以「`InstallLocation` 为空串时
   走第二、三级反推」这条分支**只有代码保证，没有实测样本**。
3. **`%PROGRAMFILES%` / `%PROGRAMFILES(X86)%` 下的安装**：本机这两个目录下
   没有任何 deep/harness/dsh 相关目录，所以「装到 Program Files」这条路径没有实测。
4. **非中文系统 / 非 GBK 代码页**：`decodeToolOutput()` 先试 `TextDecoder('gbk')` 再退 latin1。
   英文 / 日文系统上 `reg.exe` 的输出编码不同（日文 CP932 等），
   **没有在那些系统上验证过**。注意：我们只关心路径和英文 `DisplayName`，
   即便解码有噪声也不影响匹配，但这一点没有实测。
5. **`.lnk` 解析的普适性**：只实测了一个 `.lnk`（`DeepSeek Harness.lnk`，1080 字节，
   ShellLink 的 `LinkInfo` + `StringData` 变体）。其他安装器产出的 `.lnk`
   （带 `EnvironmentVariableDataBlock`、或目标含环境变量、或指向 `%ProgramFiles%` 展开形式）
   没有样本。**兜底在异步的 WScript 路由**——它走的是系统 API，不依赖二进制布局。
6. **超长时间运行的进程**：`enrichInstallRoot()` 的注册表查询实测 2.1 秒，
   如果注册表 hive 特别大（企业机器上 `Uninstall` 项可能几百条），**可能顶到 8 秒的
   `execFile` timeout**。顶到之后该路由退化为「没找到」+ 一条轨迹，不会崩，但也没测过那种规模。
7. **多用户 / 非管理员 / 受限令牌**：没在标准用户上测过（本机当前用户能读 HKCU 与 HKLM）。
   `reg query` 在受限环境下的行为未验证（代码里任何失败都退化成空结果 + 轨迹）。
8. **electron-vite 打包后的真实行为**：本次未跑 `electron-vite build`（会踩共用的 `out/`），
   只在 `tsc --noEmit` 层面验证了类型。运行时行为只在探针（编译后的 CJS 模块）里验证过。

---

## 6. node / pnpm 拓宽后的查找顺序表

### 6.1 `resolveNodePath(steps?)`（`env.ts:865`）

| 顺序 | 位置 | 说明 |
| --- | --- | --- |
| 1 | `<dshHome>/dsh-runtimes/dsh-primary-runtime/dependencies/node/bin/node.exe` | 原第一顺位，保留 |
| 2 | `<dshHome>/dsh-runtimes/*/dependencies/node/bin/node.exe` | 原逻辑（`runtimeDirs()` 下每个运行时目录），保留 |
| 3 | **`<dshHome>` 的兄弟目录及其下一级**里找 `dsh-runtimes/*/dependencies/node/bin/node.exe` | 老版本可能把 `dsh-runtimes` 放在别处（`siblingRuntimeRoots()`，`env.ts:750`） |
| 4 | **`<installRoot>` 下随包的 node**：`SCRIPT_ROOT_SUBPATHS` = `resources`、`resources\app`、`resources\app\dsh`、`resources\app\dsh\dsh-runtimes`、`dsh-runtimes`，在**这五棵子树里**做**有界 DFS**（深度 ≤4、目录数 ≤400、带时间闸）找 `node.exe` | 便携版常把运行时塞在 app 里；**只在这几个子路径里找，不全盘递归** |
| 5 | 系统 node：`process.env.PATH` 逐段拼 `node.exe` → `%ProgramFiles%\nodejs\node.exe` → `%LOCALAPPDATA%\Programs\nodejs\node.exe` | 最后兜底（本机实测会命中 `D:\Dowloads\Node\node.exe`，V2 里可见） |

缓存：正结果长期有效（到 `invalidate()`），负结果 20 秒 TTL（`NODE_MISS_TTL_MS`）。
传 `steps` 时绕过负缓存，以便产出完整轨迹。

### 6.2 `resolvePnpmPath(nodePath, steps?)`（`env.ts:940`）

按序在这些 roots 下找 `pnpm/bin/pnpm.cjs`、`pnpm/bin/pnpm.mjs`：

1. `dirname×3(nodePath)` —— 也就是找到 node 的那个 `<dependencies>` 目录；
2. `dirname×2(nodePath)` —— 上一级（有些版本 pnpm 与 node 不同级）；
3. **每个 `<dshHome>/dsh-runtimes/*/dependencies`**（原逻辑，保留）；
4. 每个 `<dshHome>/dsh-runtimes/*`（再上一层）；
5. 兄弟 `dsh-runtimes/*/dependencies`（与 node 的第 3 条对称）；
6. `PATH` 里各段下的 `pnpm.cjs` 与 `pnpm\bin\pnpm.cjs`。

`getNodePath()` / `getPnpmPath()` 的**签名与返回类型（`string | null`）未改**。

---

## 7. 附：本轮其余改动点（与探测直接相关）

| 文件 | 位置 | 改了什么 / 为什么 |
| --- | --- | --- |
| `src/main/engine/pnpm.ts` | `runtimeMissingLines()` pnpm.ts:447、三处调用 pnpm.ts:137 / 326 / 346、`missingRuntime()` pnpm.ts:495 | 缺运行时的文案改成 `checkRuntime()` 的 `message`，日志拆成「短句 + 带路径的排障行」，并**多说一句缺的是 node 还是 pnpm**。`spawnProcess` 签名与 `RunHandle` 形状未动。 |
| `src/main/engine/dsh.ts` | `isUninstallerLike()` dsh.ts:44、`findExe()` dsh.ts:60、过滤 dsh.ts:84 | 扫目录兜底时第一版只排 `unins*`，而真实卸载器叫 `Uninstall DeepSeek Harness.exe` → 会把**卸载器**当成主程序去 `taskkill` / 拉起。现在按 `uninstall / 卸载 / setup / installer` 过滤，再优先名字像主程序的 exe。 |
| `src/main/engine/dshproc.ts` | `safeInstallRoot()` dshproc.ts:139、`safeCheckRuntime()` dshproc.ts:148、`start()` 里 `await env.enrichInstallRoot()` dshproc.ts:393 | `start()` 是 async 的，所以在这里先补一刀深度探测（同步路由全靠命名约定，新电脑会全落空，而注册表/进程是**当场就存在**的信息），命中后 `env.invalidate()` + `exeCache.clear()`。失败文案带上 `checkRuntime().message + fix`。 |
| `src/main/ipc.ts` | `CH.envRedetect` ipc.ts:58、`CH.envDiagnose` ipc.ts:61、`CH.pickDirectory` ipc.ts:69、启动补刀 ipc.ts:370 附近 | 三个新 handler；`registerIpc()` 末尾挂一个异步 IIFE：`getInstallRoot()` 已有值就直接返回，否则 `enrichInstallRoot()` → **只在 `settings.installRoot` 为空时**写入 → `invalidate()` → `diag('env-enrich', …)`。 |
| `src/preload/index.ts` | 三个桥接（`pickDirectory` / `envRedetect` / `envDiagnose`） | 与既有桥接同风格：`ipcRenderer.invoke(CH.xxx, …)`。 |

---

## 8. 复现本文所有实测

```powershell
# 1) 类型检查（必须 exit 0；注意不能用 npx）
& "C:\Users\YBY\.dsh\dsh-runtimes\dsh-primary-runtime\dependencies\node\bin\node.exe" `
  "node_modules\typescript\bin\tsc" --noEmit -p tsconfig.node.json

# 2) 探针（%TEMP% 下，跑完即删）
$tmp = Join-Path $env:TEMP 'dsh-env-probe'
$node = "C:\Users\YBY\.dsh\dsh-runtimes\dsh-primary-runtime\dependencies\node\bin\node.exe"
& $node "$tmp\probe.js" --hide-explicit --deep          # V2 → 快捷方式
& $node "$tmp\probe.js" --hide-explicit --hide-lnk      # V3 → 磁盘扫描
& $node "$tmp\probe.js" --hide-explicit --hide-lnk --hide-drives --deep            # V5 → 注册表
& $node "$tmp\probe.js" --hide-explicit --hide-lnk --hide-drives --hide-reg --deep # V6 → 运行中的进程
& $node "$tmp\probe.js" --hide-explicit --hide-lnkparse --hide-drives --hide-reg --hide-proc --deep  # V8 → WScript
& $node "$tmp\probe.js" --hide-explicit --hide-lnk --worst   # V9 → 最坏情况磁盘扫描
```
