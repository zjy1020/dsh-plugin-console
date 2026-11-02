# 环境缺失类故障点审计（env-error-surfaces）

> 本文件由一次只读审计产出。审计期间**没有修改任何 `src/` 文件，没有启动 Electron，没有跑 build / 类型检查，没有 git 操作**。
> 报告只描述「用户会看到什么、能做什么」，不描述修复实现。

## 0. 审计元信息与读法

- 审计时刻：**2026-11-02 18:12 – 18:30（Asia/Shanghai）**，工作目录 `D:\项目\DSH\deepseekharness插件台`。
- 被审计文件的内容指纹（SHA256，审计时刻）：

  | 文件 | SHA256 |
  | --- | --- |
  | `src/main/engine/env.ts` | `C534CC5DD9C91E01BAD024A657B0B7F8F0769B9933F81D3F5CA6F536C4F18923` |
  | `src/main/engine/pnpm.ts` | `6D1D4A9BB7125D5B3C88C865B106DF277CA9D6D168F113B32B4A3AA46DA519D7` |
  | `src/main/engine/ops.ts` | `2E92929C9DB2C12DF2DEFA3897603E9C4C354FC6F603FBCF7CB9D6198AC99107` |
  | `src/main/engine/dshproc.ts` | `2CF1E84FFA8BB9DA7C54C585995652D44A9E472421E9CF3A38C09596FDCFBF89` |
  | `src/renderer/src/lib/store.ts` | `3F41FE7D9B3179F2DE088D8CBB580FC68FE68DF4B26D67980AC868386B293C61` |

- **重要前提：另一条线正在同时改这个仓库。** 审计窗口内 `git status` 不适用（该目录不是 git 仓库），但按文件 mtime 可见：`src/shared/ipc.ts`、`src/shared/types.ts` 18:11 被改；`src/renderer/src/components/EnvDiagnostics.tsx` 18:16 新建；`src/renderer/src/styles/env-setup.css` 18:16 新建；`src/renderer/src/components/SettingsDialog.tsx` 18:17 被改；`src/renderer/src/App.tsx` 18:18 被改。
  因此：
  - 本报告里 `App.tsx`、`SettingsDialog.tsx`、`shared/ipc.ts`、`shared/types.ts` 的引用是**审计时刻那一版**的行号；
  - `env.ts` 尚未被那一线改动（mtime 早于 16:54），它的行号在修复落地后大概率会整体位移。
- 行号基准：一律用读取工具得到的**文件真实行号**（`Get-Content | Measure-Object -Line` 不数空行，数字会偏小，本报告不用它）。
- 「出口」三档的定义：
  - **有可点击的出口**：界面上有按钮/链接，点了会真的发生一次有意义的动作；
  - **只有文字指引**：文案告诉用户「去某处做某事」，用户得自己找、自己敲（例如手打路径）；
  - **什么都没有**：提示看完就消失，或提示只在 `title` / 控制台 / 日志里。
- 「未核实」= 我在本次审计中没有拿到能支撑该结论的证据，不写成结论。

---

## 1. 故障通路：一个根因，三种呈现层

用户报告的四条反馈，实际落在**同一条数据流**的三个断点上。先把通路画出来，后面每张卡片都挂在某一段上。

```
① 探测层  src/main/engine/env.ts
   installRootCandidates()  6 条写死候选   ──全不中──▶  installRoot = null
   resolveNodePath()/resolvePnpmPath()     ──找不到──▶  nodePath/pnpmPath = null
   buildRuntimeInfo() 把上面结果压成 RuntimeInfo{ ... , warnings: string[] }
                     │
② 执行层  src/main/engine/pnpm.ts + dshpm.ts + ops.ts
   ops.runOp(kind) ──▶ runPnpmAddish ──▶ pnpm.runPnpm/runNode
                     │  缺 node/pnpm 时 → missingRuntime() 合成假句柄，code = -1
                     │  → ops 把 code/-1 与固定文案拼进 message
                     │
③ 呈现层  src/renderer/**  +  src/main/ipc.ts 广播
   EV.opDone ──▶ store.ts:1088  toast('error', '操作失败', result.message)
   runtimeInfo() ──▶ App.tsx 引导卡 / warnings 横幅 / EnvPanel 折叠面板
```

**三个断点各自的用户可见后果：**

| 断点 | 后果 | 归属反馈 |
| --- | --- | --- |
| 安装根 = null | 「找不到 DSH 可执行文件：`<安装目录未知>`」 | 反馈 2 |
| node/pnpm = null | 「找不到 DSH 自带的 node/pnpm，请到设置里指定安装根」 | 反馈 1、4 |
| 多目标操作 × 固定文案 | 「清单导入：0 个装好，12 个失败（同句 ×12）」 | 反馈 4 |
| 无任何「选目录」通道 | 用户只能手打路径 | 反馈 1 的体感来源 |
| 顶部提示语本身 | 把「安装根」当成 node/pnpm 的原因 → 用户改了没用的那一个 | 反馈 1、4 的归因错误 |
| 代理地址被原样回显进提示 | 「连不上 127.0.0.1:65535，代理没在跑？」里的 `65535` 是用户自己的 VPN 端口，界面不解释它从哪来 | 反馈 3（见 F14，半核实） |

---

## 2. 故障点卡片

编号规则：`组-序号`。字段固定五项：**触发条件 / 代码位置 / 用户看到的原文 / 出口 / 自评严重度**。

共 **68** 张卡片：A 组 12 / B 组 5 / C 组 10 / D 组 9 / E 组 11 / F 组 14 / G 组 7。按自评严重度统计：**P0 = 15 张，P1 = 31 张，P2 = 22 张**（用 `grep -c '自评严重度\*\*：P0'` 可复核）。

### A 组：环境探测层（`src/main/engine/env.ts`，经 `RuntimeInfo.warnings` 呈现）

#### A01 六条候选全不中 → `installRoot = null`
- **触发条件**：`getInstallRoot()` 被调用（任何 install/update 类操作、`dshproc.status()`、`dsh.findExe()`），且 6 条候选路径没有一个存在 `<候选>/resources/app/package.json` 且其 `name === '@deepseek-ai/dsh-desktop'`。
- **代码位置**：`src/main/engine/env.ts:181`（`resolveInstallRoot` 全不中分支），校验逻辑 `env.ts:113-117`。
- **用户看到的原文**：`未找到 DSH 桌面端安装根，请到设置里手动指定`
- **出口**：只有文字指引（进 `App.tsx` 引导卡 / warnings 横幅的告警行；横幅上有「设置」「忽略」两个按钮，但「设置」只是把用户丢进设置页）。
- **自评严重度**：P0

#### A02 候选表只有 6 条，且全是「猜路径」没有一条「问系统」
- **触发条件**：恒成立。新电脑上安装到 D 盘、自定义目录名、或从别的机器整目录拷贝过来的情形，6 条候选全部不中。
- **代码位置**：`src/main/engine/env.ts:119-166`。具体 6 条：设置值（:123-125）、`DSH_INSTALL_ROOT` 环境变量（:127-130）、`<dshHome>/dsh-purge/desktop-install.txt` 首行（:132-144）、`%LOCALAPPDATA%\Programs\DeepSeekHarness`（:146-149）、硬编码 `C:\Program Files\DeepSeekHarness`（:150）、`%LOCALAPPDATA%\deepseek-harness`（:151-153）。
- **用户看到的原文**：不直接产生文案；它是 A01 的根因。
- **出口**：不适用（这是缺陷本身，不是提示）。
- **自评严重度**：P0

#### A03 设置里的安装根填了但不合格
- **触发条件**：`settings.installRoot` 非空，但该目录没有 `resources/app/package.json` 或包名不对。
- **代码位置**：`src/main/engine/env.ts:175-177`。
- **用户看到的原文**：`设置里的安装根无效（没有 resources/app/package.json 或包名不对）：<用户填的路径>`
- **出口**：只有文字指引（文案指明了判定标准，这一点是好的；但没有「重新选目录」的按钮）。
- **自评严重度**：P1

#### A04 `DSH_HOME` 目录不存在
- **触发条件**：三级取值（`settings.dshHome` → `process.env.DSH_HOME` → `~/.dsh`，见 `env.ts:95-101`）得到的路径不存在。
- **代码位置**：`src/main/engine/env.ts:316`。
- **用户看到的原文**：`DSH_HOME 目录不存在：<dshHome>`
- **出口**：只有文字指引。
- **自评严重度**：P1

#### A05 安装目录里没有 dsh CLI 入口
- **触发条件**：`installRoot` 非空，但 `<installRoot>/resources/app/dsh/node_modules/@deepseek-ai/dsh/lib/bin.js` 不存在（`env.ts:331` 才有这个判断；`env.ts:329` 是它的结果）。
- **代码位置**：`src/main/engine/env.ts:329`。
- **用户看到的原文**：`安装目录里没找到 dsh CLI 入口（resources/app/dsh/node_modules/@deepseek-ai/dsh/lib/bin.js），「重启 DSH」可能不可用`
- **出口**：只有文字指引。
- **自评严重度**：P2

#### A06 桌面端 / 随包 runtime 的 package.json 读不出来
- **触发条件**：`readJson` 失败（文件缺失、JSON 损坏、权限不足），且 `installRoot` 非空（`env.ts:331`/`334` 的守卫）。
- **代码位置**：`src/main/engine/env.ts:332`（桌面端）、`src/main/engine/env.ts:335`（runtime）。
- **用户看到的原文**：`桌面端 package.json 读取失败，无法确定桌面端版本` / `随包 runtime package.json 读取失败，无法确定 runtime 版本`
- **出口**：只有文字指引；对用户几乎没有可执行动作（他改不了别人的安装目录）。
- **自评严重度**：P2

#### A07 未找到随包 Node 运行时
- **触发条件**：`resolveNodePath()` 为空 —— 即 `<dshHome>/dsh-runtimes/dsh-primary-runtime/dependencies/node/bin/node.exe`（`env.ts:215`）和所有 `<dshHome>/dsh-runtimes/*/dependencies/node/bin/node.exe`（`env.ts:211-223`）都不存在。**注意：这条路径完全不看 `installRoot`。**
- **代码位置**：`src/main/engine/env.ts:340`。
- **用户看到的原文**：`未找到随包 Node 运行时（<DSH_HOME>\dsh-runtimes\*\dependencies\node\bin\node.exe），无法执行 pnpm 操作`
- **出口**：只有文字指引。文案本身是正确的（指明了真实位置），但**它和 A11 那句「指定安装根」指的不是同一个修法**，用户在两条提示之间会做错选择。
- **自评严重度**：P0

#### A08 未找到 pnpm 入口
- **触发条件**：`resolvePnpmPath(nodePath)` 为空 —— 在 `[dirname ×3 of nodePath] + 各 runtime 的 dependencies` 里都找不到 `pnpm/bin/pnpm.cjs` 或 `pnpm.mjs`（`env.ts:226-242`）。
- **代码位置**：`src/main/engine/env.ts:345`。
- **用户看到的原文**：`未找到 pnpm 入口（dsh-runtimes\...\dependencies\pnpm\bin\pnpm.cjs），安装 / 卸载功能不可用`
- **出口**：只有文字指引。
- **自评严重度**：P0

#### A09 `node -v` / `pnpm -v` 探测失败
- **触发条件**：命令执行出错或超时（`env.ts:353`/`354` 两条独立 warning）。
- **代码位置**：`src/main/engine/env.ts:353`、`src/main/engine/env.ts:354`。
- **用户看到的原文**：`Node 版本探测失败（执行 node -v 出错或超时）` / `pnpm 版本探测失败（执行 pnpm -v 出错或超时）`
- **出口**：只有文字指引。
- **自评严重度**：P2

#### A10 `fallbackRuntimeInfo()` 的兜底文案
- **触发条件**：`buildRuntimeInfo()` 抛异常时（`getRuntimeInfo()` 内 catch，`env.ts:371-381`）。
- **代码位置**：`src/main/engine/env.ts:297-310`，warning 在 `env.ts:308`。
- **用户看到的原文**：`运行环境探测异常，请到设置里手动指定 DSH_HOME 与安装根`
- **出口**：只有文字指引（整条 `RuntimeInfo` 全字段为 null，界面同时会出现 A01/A07/A08 的呈现态）。
- **自评严重度**：P1
- **附注（可达性存疑）**：`buildRuntimeInfo` 内部大量使用 try/catch 与 `safeSettings()`，我在本次审计中**没有找到**能稳定让它在正常环境下抛出的路径。这条兜底更像「防御性代码」，实际用户能否看到 **未核实**。

#### A11 `RuntimeInfo` 声明了 `dshHomeFrom` / `installRootFrom` / `discovery`，生产者一个都没填
- **触发条件**：恒成立（`buildRuntimeInfo` 与 `fallbackRuntimeInfo` 的返回对象都没有这三个字段）。
- **代码位置**：声明 `src/shared/types.ts:46`（`dshHomeFrom`）、`:50`（`installRootFrom`）、`:52`（`discovery: DiscoveryStep[]`）；生产端 `src/main/engine/env.ts:356-367`（返回对象字面量）、`src/main/engine/env.ts:297-310`（fallback）。
- **用户看到的原文**：不直接产生文案 —— 后果是「安装根是从哪条路由找到的」和「每条路由试过什么」在界面上永远不存在。`src/renderer/src/App.tsx:337` 与 `:352`/`:392` 都在读 `info.discovery ?? []`，永远拿到空数组。
- **出口**：什么都没有（本该由它支撑的「环境诊断」面板拿不到数据）。
- **自评严重度**：P1

#### A12 「忽略」告警只顶一次刷新
- **触发条件**：用户点了 warnings 横幅的「忽略」（`actions.dismissWarnings`）。
- **代码位置**：`src/renderer/src/lib/store.ts:462-463`（`case 'runtime'` 把 `warningsDismissed` 重置为 `false`）；置位在 `store.ts:651-652`。
- **用户看到的原文**：不产生新文案 —— 后果是同一条告警在每次环境刷新后重新出现，用户会以为「忽略没生效」。
- **出口**：有可点击的出口（「忽略」按钮），但效果被下一次刷新抹掉。
- **自评严重度**：P2

### B 组：pnpm 执行层（`src/main/engine/pnpm.ts`）

B 组三条共用**同一句文案**，这是反馈 1 与反馈 4 的产地。

#### B01 `spawnProcess` 发现可执行文件不存在
- **触发条件**：`pnpm.runPnpm/runNode` 传进来的 `cmd`/入口为空或 `!existsSync(cmd)`。
- **代码位置**：`src/main/engine/pnpm.ts:134-148`，文案在 `pnpm.ts:135`。
- **用户看到的原文**：`找不到 DSH 自带的 node/pnpm，请到设置里指定安装根`
- **出口**：什么都没有（这句先是日志行，再由 `ops.ts` 拼进 `message`，最终变成 toast 的 detail）。
- **自评严重度**：P0

#### B02 `runNode` 拿不到 node
- **触发条件**：`safeNodePath()` 为 null，即 A07 成立。
- **代码位置**：`src/main/engine/pnpm.ts:320-326`（调用 `missingRuntime` 在 `pnpm.ts:323`）。
- **用户看到的原文**：同 B01。
- **出口**：什么都没有（原因见 `missingRuntime` 的行为，见 B04）。
- **自评严重度**：P0

#### B03 `runPnpm` 拿不到 node 或 pnpm
- **触发条件**：`!nodePath || !pnpmPath`，即 A07 或 A08 任一成立。
- **代码位置**：`src/main/engine/pnpm.ts:338-346`（`pnpm.ts:342`）。
- **用户看到的原文**：同 B01。
- **出口**：什么都没有。
- **自评严重度**：P0

#### B04 `missingRuntime()` 合成一个「已失败的句柄」，没有真实进程
- **触发条件**：B02 / B03 命中时。
- **代码位置**：`src/main/engine/pnpm.ts:435-454`。它调 `onSpawn(message)` + `onLine(message,'stderr')`，`done = Promise.resolve({ code: -1, log: message })`，`cmdline = message`。**不 spawn 任何进程。**
- **用户看到的原文**：无新文案。后果有两条：
  1. `code = -1` 是合成值，不是进程退出码，但 `ops.ts:925` 会把它原样写进面向用户的句子「安装失败（exit -1）」；
  2. 日志抽屉的「取消」按钮（`src/renderer/src/components/LogDrawer.tsx:114-123`，title 是 `中断当前 pnpm 进程`）在这个句柄上没有任何进程可中断。
- **出口**：有按钮，但按钮与真实状态不符。
- **自评严重度**：P1

#### B05 官方通道内部自检也报「没探测到自带的 node / pnpm」
- **触发条件**：走到 `ops.runViaOfficial` 且 `env.getNodePath()/getPnpmPath()` 为空（`src/main/engine/ops.ts:322-326`）。
- **代码位置**：`src/main/engine/ops.ts:322-326`。
- **用户看到的原文**：`没探测到自带的 node / pnpm`（作为 `OfficialUnavailableError.message`，进日志行 `官方通道不可用（…），改用自带 pnpm`，`ops.ts:238`）。
- **出口**：什么都没有（只在日志抽屉里）。
- **自评严重度**：P1

### C 组：结果拼装层（`src/main/engine/ops.ts`）

#### C01 安装失败（反馈 1 的原句）
- **触发条件**：`opInstall` 的 `pnpm add` 返回非 0。缺 node/pnpm 时 `run.code === -1` 且 `run.log` 就是 B01 那句，`errorSummary(run.log)` 取到同一句。
- **代码位置**：`src/main/engine/ops.ts:919-926`（拼装在 `ops.ts:925`）。
- **用户看到的原文**：`安装失败（exit -1）：找不到 DSH 自带的 node/pnpm，请到设置里指定安装根`
- **出口**：只有文字指引，且这句指引**指错了地方**（见第 4 节）。
- **自评严重度**：P0

#### C02 更新失败
- **触发条件**：`opUpdate` 的 `pnpm update` 非 0（同 C01 的三种 detail 选择）。
- **代码位置**：`src/main/engine/ops.ts:1263-1270`。
- **用户看到的原文**：`更新失败（exit <code>）：<detail>`，detail 三选一：`安装超时，已终止` / `与当前 dsh 运行时不兼容，官方已拒绝安装（profile 未被改动）` / `errorSummary(log)`。
- **出口**：只有文字指引（当 detail 是 B01 那句时）。
- **自评严重度**：P1

#### C03 依赖对齐失败
- **触发条件**：`opRepair` 的 `pnpm install` 非 0。
- **代码位置**：`src/main/engine/ops.ts:1436-1439`。
- **用户看到的原文**：`依赖对齐失败（exit <code>）：<detail>`
- **出口**：只有文字指引。
- **自评严重度**：P2

#### C04 清单导入把 N 个失败明细全塞进一条字符串（反馈 4 的原句）
- **触发条件**：`opInstallManifest` 里 `pv.specs.length > 1`，批量 `pnpm add` 非 0 → 降级逐个安装（`ops.ts:1522-1557`）→ 每个包各失败一次，`failed` 收集到 N 条 `{name, detail}` → 拼成一条 message（`ops.ts:1637-1643`）。
- **代码位置**：拼装在 `src/main/engine/ops.ts:1639-1642`，逐包失败点 `src/main/engine/ops.ts:1545-1546`。
- **用户看到的原文**（12 个包全因缺 node/pnpm 时）：
  `清单导入：0 个装好，12 个失败（@linxin666/dsh-remote-web-ui：找不到 DSH 自带的 node/pnpm，请到设置里指定安装根；…同句 ×12）`
- **出口**：只有文字指引；且这条 message 在 toast 里被裁到 68px（见 E02），在日志抽屉里可完整看到（`LogDrawer.tsx:166-171`）。
- **自评严重度**：P0

#### C05 批量失败的原因只写进日志
- **触发条件**：C04 的降级路径进入时。
- **代码位置**：`src/main/engine/ops.ts:1525-1529`。
- **用户看到的原文**：`批量安装失败（exit <code>）：<detail>`（日志抽屉行）。
- **出口**：什么都没有（在 toast 上看不到「批量这一步也失败了」），用户只看到 C04 的逐包明细。
- **自评严重度**：P2

#### C06 无法解析 profile 目录
- **触发条件**：`profileDir` 解析抛错（`ops.ts:847-850`）。
- **代码位置**：`src/main/engine/ops.ts:849`。
- **用户看到的原文**：`无法解析 profile 目录：<原始错误>`
- **出口**：什么都没有（`fail()` 只产生 message → toast；文案里带的是内部错误原文）。
- **自评严重度**：P1

#### C07 profile 目录不存在
- **触发条件**：解析出的目录不存在（`ops.ts:851-854`）。
- **代码位置**：`src/main/engine/ops.ts:853`。
- **用户看到的原文**：`profile 目录不存在：<profileDir 或 profile 名>`
- **出口**：只有文字指引（用户可去设置改 DSH_HOME，但没有直达入口）。
- **自评严重度**：P1

#### C08 兜底：不认识的操作类型 / 操作异常终止
- **触发条件**：`kind` 未命中 switch（`ops.ts:877`）；runOp 外层 catch（`ops.ts:879-884`）。
- **代码位置**：`src/main/engine/ops.ts:877`、`src/main/engine/ops.ts:883`。
- **用户看到的原文**：`不认识的操作类型：<kind>` / `操作异常终止：<message>`
- **出口**：什么都没有（纯内部术语）。
- **自评严重度**：P2

#### C09 预检也报「profile 目录不存在」
- **触发条件**：`installPreview` 找不到 profile 目录。
- **代码位置**：`src/main/engine/ops.ts:574`（走 `emptyPreview`，最终显示在 `InstallPanel` 的 AutoTab 错误区 `InstallPanel.tsx:250-254` / `:306`）。
- **用户看到的原文**：`profile 目录不存在：<profileDir>`
- **出口**：什么都没有。
- **自评严重度**：P2

#### C10 官方通道不可用时静默降级，界面不告知
- **触发条件**：`dshpm.officialAvailable(installRoot)` 为 false（`ops.ts:233`）。
- **代码位置**：降级在 `src/main/engine/ops.ts:233-240`；可用性判定 `src/main/engine/dshpm.ts:141-143`（= `resolveOfficialPaths() !== null`）。
- **用户看到的原文**：只有日志行 `官方通道不可用（<原因>），改用自带 pnpm`（`ops.ts:238`）。**toast 不提示。**
- **出口**：什么都没有（用户不知道装插件走的是哪条通道，也不知道官方通道为什么不可用）。
- **自评严重度**：P1

### D 组：DSH 进程控制层（`dshproc.ts` / `dsh.ts` / `tray.ts` / `DshControl.tsx`）

#### D01 找不到 DSH 可执行文件（反馈 2 的原句）
- **触发条件**：`dshproc.start()` 时 `before.exePath` 为 null 或文件已不存在（`dshproc.ts:364-365`）。`exePath` 为 null 的上游是 `locateExePath()` —— 它第一件事就是 `env.getInstallRoot()`，为 null 直接 return null（`dshproc.ts:98`）。
- **代码位置**：`src/main/engine/dshproc.ts:369`，展示值组装在 `src/main/engine/dshproc.ts:366`。
- **用户看到的原文**：`找不到 DSH 可执行文件：<安装目录未知>。可以在设置里指定安装目录`
- **出口**：只有文字指引（用户得自己去侧栏「设置」→ 手打「安装根」→ 点保存）。
- **自评严重度**：P0

#### D02 「安装目录找到了、但里面没有 exe」时，文案仍在说「指定安装目录」
- **触发条件**：`installRoot` 非空但 `installRoot` 下没有可用的 `.exe`（`pickExeFile` 的过滤规则见 `dshproc.ts:61-88`：排除卸载器，优先名字含 harness/deepseek/dsh）。
- **代码位置**：`src/main/engine/dshproc.ts:366` 的 `before.installRoot ? join(before.installRoot,'<未找到 .exe>') : '<安装目录未知>'` 与 `dshproc.ts:369` 的固定尾句。
- **用户看到的原文**：`找不到 DSH 可执行文件：D:\…\DeepSeekHarness\<未找到 .exe>。可以在设置里指定安装目录`
- **出口**：只有文字指引，而且**指引与事实不符**（目录已经找到了，问题是里面没有 exe；用户按提示再改一次安装目录也不会好）。
- **自评严重度**：P1

#### D03 spawn 抛错
- **触发条件**：`spawn(target, [], …)` 同步抛异常（权限、路径失效、被拦）。
- **代码位置**：`src/main/engine/dshproc.ts:387`。
- **用户看到的原文**：`启动 DSH 失败：<异常文本>`
- **出口**：什么都没有。
- **自评严重度**：P1

#### D04 拉起来了但没检测到
- **触发条件**：spawn 后 15 秒轮询 `status()` 仍 `running === false`。
- **代码位置**：`src/main/engine/dshproc.ts:395`。
- **用户看到的原文**：`进程已拉起，但 15 秒内没检测到它在运行`
- **出口**：什么都没有（用户不知道下一步该等还是该重试）。
- **自评严重度**：P1

#### D05 退出 DSH 时进程还在
- **触发条件**：`taskkill /F` 后复查仍有 pids（`dshproc.ts:436-476`）。
- **代码位置**：`src/main/engine/dshproc.ts:473`。
- **用户看到的原文**：`没能结束 DSH 进程（还活着：PID …），可能需要管理员权限`
- **出口**：只有文字指引。
- **自评严重度**：P1

#### D06 重启 DSH 找不到 exe / 拉不起来
- **触发条件**：`restartDsh()` 的 `findExe()` 为 null（`dsh.ts:48`），或 `spawn` 失败。
- **代码位置**：`src/main/engine/dsh.ts:132`、`src/main/engine/dsh.ts:141`。
- **用户看到的原文**：`没找到 DSH 桌面端可执行文件，请手动重启 DSH` / `没能拉起 <exeName>，请手动重启 DSH`
- **出口**：只有文字指引（「手动重启 DSH」= 用户自己去开 DSH，因为插件台找不到 exe，用户大概也找不到）。
- **自评严重度**：P1

#### D07 托盘里启停失败只说「详情见控制台」
- **触发条件**：托盘菜单的「启动 DSH」/「退出 DSH」失败（`tray.ts:153` / `:188`）。
- **代码位置**：`src/main/tray.ts:153`、`src/main/tray.ts:188`。
- **用户看到的原文**：`启动 DSH 失败，详情见控制台` / `退出 DSH 失败，详情见控制台`（系统通知；`notify()` 在 Notification 不可用时退化为 `console.log`，`tray.ts:81-89`）
- **出口**：什么都没有（这对普通用户来说「控制台」不存在）。
- **自评严重度**：P1

#### D08 `exePath` 为 null 时界面对此完全沉默
- **触发条件**：`installRoot` 找不到，或安装目录里没有 exe。
- **代码位置**：`src/renderer/src/components/DshControl.tsx:176-180`（`idle && status?.exePath` 才渲染路径行）。
- **用户看到的原文**：没有任何文案 —— 界面只是不显示路径。用户看到的是「DSH 未运行」+ 一个可点的「启动 DSH」按钮。
- **出口**：什么都没有（这是 D01 发生**之前**的静默期；用户只有在点了按钮、被弹一次确认、再拿到 D01 才第一次知道有问题）。
- **自评严重度**：P1

#### D09 读不到 DSH 状态
- **触发条件**：`useDshStatus.reload()` 抛错（`useDshStatus.ts:28-38`）。
- **代码位置**：`src/renderer/src/components/DshControl.tsx:146-151`。
- **用户看到的原文**：`读不到 DSH 状态：<err>`（`banner--danger`，`role=alert`）
- **出口**：有可点击的出口（同区块的 ↻ 刷新按钮，title `重新读取 DSH 进程状态`，`DshControl.tsx:133-142`）。
- **自评严重度**：P2

### E 组：渲染层出口（`src/renderer/src/lib/store.ts` 及 toast 呈现）

#### E01 所有操作级失败的 toast 标题只有「操作失败」四个字
- **触发条件**：任何 `EV.opDone` 且 `result.ok === false`（C01、C02、C04、C06…全走这里）。
- **代码位置**：`src/renderer/src/lib/store.ts:1086-1091`（toast 在 `store.ts:1088`）。
- **用户看到的原文**：标题 `操作失败`；正文是主进程给的整段 message。
- **出口**：**只有「正文文字」** —— toast 上没有任何按钮（`Toasts.tsx:21-41` 只有 mark / title / detail / 关闭）。
- **自评严重度**：P0

#### E02 toast 的正文被硬裁到 68px、3.5 秒后消失、没有展开
- **触发条件**：message 很长时（C04 的 12 条明细天然很长）。
- **代码位置**：`AUTO_DISMISS_MS = 3500` 在 `src/renderer/src/components/Toasts.tsx:11`；正文渲染在 `Toasts.tsx:28`（无截断逻辑）；裁剪规则在 `src/renderer/src/styles/components.css:1883-1891`（`max-height: 68px; overflow: hidden;`，≈4 行，**没有省略号、没有滚动、没有展开入口**）；toast 栈自身也不滚（`components.css:1792-1803` 的 `.toasts` 无 `max-height`/`overflow`）。
- **用户看到的原文**：`清单导入：0 个装好，12 个失败（@linxin666/dsh-remote-web-ui：找不到 DSH 自带的 node/pnpm，请到设置里指…` —— 后半截被裁掉，且 3.5 秒后整条消失。
- **出口**：什么都没有（想看完必须自己打开「日志」抽屉，而 UI 上没有从 toast 过去的入口）。
- **自评严重度**：P0

#### E03 toast 队列只留最后 4 条，前面的静默丢弃
- **触发条件**：短时间内压入超过 4 条 toast。
- **代码位置**：`src/renderer/src/lib/store.ts:654-656`（`toasts.length > 4 ? toasts.slice(toasts.length - 4) : toasts`）。
- **用户看到的原文**：无新文案 —— 后果是连环失败时最早的两条（常常是最关键的第一条）无声消失。
- **出口**：什么都没有。
- **自评严重度**：P1

#### E04 「启动 DSH」确认框在 `installRoot` 为 null 时语法是坏的
- **触发条件**：`runtime?.installRoot` 为 null 时点「启动 DSH」。
- **代码位置**：`src/renderer/src/lib/store.ts:1482-1499`，文案在 `store.ts:1486`（`会用 ${installRoot ?? '安装目录'} 下的可执行文件拉起 DSH 桌面端。`）。
- **用户看到的原文**：`会用 安装目录 下的可执行文件拉起 DSH 桌面端。`
- **出口**：有可点击的出口（确认框的确认按钮），但确认之后必然失败（走到 D01）。
- **自评严重度**：P1

#### E05 `refreshEnv` 失败 → `fatal` 级（注释与实现错配）
- **触发条件**：`api().runtimeInfo()` 这个 IPC 本身抛错（preload 缺失 / handler 未注册）。
- **代码位置**：`src/renderer/src/lib/store.ts:1018-1027`，注释在 `store.ts:1024`（「环境探测整体失败 = 找不到 DSH，属于 fatal 级」）。
- **用户看到的原文**：指向 `fatal` 横幅的正文（`state.fatal` 字符串）+ toast 标题 `环境探测失败`。
- **出口**：取决于 `App.tsx` 的分支（见 F 组）。
- **自评严重度**：P2
- **附注**：`env.getRuntimeInfo()` 内部是「永不抛」（兜成 fallbackRuntimeInfo，`env.ts:371-381`），所以「installRoot 找不到」**走不到这条 fatal**，它只会变成 warnings。这条注释把两件事写成了一件，容易误导后续改动。

#### E06 启动时 `settingsGet` 失败 → 直接 `fatal`
- **触发条件**：`boot` 里 `settingsGet` 抛错（`store.ts:1059-1076`）。
- **代码位置**：`src/renderer/src/lib/store.ts:1069`。
- **用户看到的原文**：`state.fatal` 的正文（`toMessage(err)` 原文，可能是技术文案）。
- **出口**：同 F 组（引导卡 / 横幅）。
- **自评严重度**：P1

#### E07 `reloadAll` 静默吞掉 `settingsGet` 失败
- **触发条件**：刷新时 `settingsGet` 抛错而 `refreshEnv` 成功。
- **代码位置**：`src/renderer/src/lib/store.ts:1029-1047`，注释在 `store.ts:1041`（「设置拉不到不该让整次刷新失败」）。
- **用户看到的原文**：无（还会弹一句 `已刷新` 的成功提示）。
- **出口**：什么都没有。
- **自评严重度**：P2

#### E08 插件列表读取失败
- **触发条件**：`api().plugins()` 抛错。
- **代码位置**：`src/renderer/src/lib/store.ts:992-996`。
- **用户看到的原文**：toast 标题 `读取插件列表失败` + detail 原文；列表区另有空态（`PluginList.tsx:115-126`）。
- **出口**：有可点击的出口（列表空态的 `重试` 按钮）。
- **自评严重度**：P1

#### E09 清单导入的前置校验提示（空文本 / 无 profile）
- **触发条件**：`text` 为空（`store.ts:1396-1399`）或 `target` 为空（`store.ts:1401-1404`）。
- **代码位置**：`src/renderer/src/lib/store.ts:1396-1404`。
- **用户看到的原文**：`先选一份清单再装` / `没有选中的 profile`
- **出口**：只有文字指引。
- **自评严重度**：P2

#### E10 取消操作无效
- **触发条件**：`opId` 为 null 或 `cancelOp` 返回 false。
- **代码位置**：`src/renderer/src/lib/store.ts:1448-1461`。
- **用户看到的原文**：`当前没有可取消的操作` / `取消没有被接受`（detail：`操作可能已经结束了`）
- **出口**：只有文字指引。
- **自评严重度**：P2

#### E11 导出清单失败但主进程没给原因
- **触发条件**：`res.error` 为空且 `res.ok === false`（`res.error === '已取消'` 时是正常取消，静默返回，`store.ts:1533`）。
- **代码位置**：`src/renderer/src/lib/store.ts:1522-1543`。
- **用户看到的原文**：`导出清单失败` + detail `主进程没有给出原因`
- **出口**：什么都没有。
- **自评严重度**：P2

### F 组：首屏与各面板的呈现出口（审计时刻那一版）

#### F01 环境引导卡：三个出口里有两个是禁用状态（审计时刻）
- **触发条件**：`state.fatal !== null` 或（`state.ready` 且 `missingEnvParts(runtime).length > 0`）（`App.tsx:206-207`）→ 渲染 `EnvSetupCard`（`App.tsx:216`）。
- **代码位置**：`src/renderer/src/App.tsx:325-467`；两处禁用判断在 `App.tsx:419`（`disabled={busy !== null || !autoFn}`）与 `App.tsx:433`（`disabled={busy !== null || !pickFn}`）；`autoFn`/`pickFn` 来自 `envRedetectFn()`/`pickDirectoryFn()`（`App.tsx:331-332`），而这两个函数在 preload 没有对应方法时返回 `null`（`src/renderer/src/components/EnvDiagnostics.tsx:69-91`）——**审计时刻 preload 里确实没有这两个方法（见 G01）**。
- **用户看到的原文**：卡片标题 `DSH 环境不完整：缺 安装目录、随包 node`（`App.tsx:340`）+ 正文 `…下面两个按钮随便点一个就能自己解决，不用手打路径。`（`App.tsx:343`）；按钮文案是 `自动检测一遍`（`App.tsx:427`）与 `手动选择安装目录…`（`App.tsx:441`），两者都被禁用，`title` 分别是 `主进程还没接上「重新检测」通道`（`App.tsx:423`）与 `主进程还没接上「选择文件夹」通道`（`App.tsx:437`）。
- **出口**：**正文承诺了两个出口、实际两个都点不动**；第三个按钮 `打开设置`（`App.tsx:443-445`）可用，但回到「用户自己敲路径」。
- **自评严重度**：P0

#### F02 引导卡里的「环境诊断」明细永远是空的
- **触发条件**：恒成立（`steps` 初值 `runtime?.discovery ?? []`，而 `discovery` 生产者不填，见 A11）。
- **代码位置**：`src/renderer/src/App.tsx:337`、`src/renderer/src/App.tsx:458-464`。
- **用户看到的原文**：`点一下上面的「自动检测一遍」，就能看到我们按顺序试过哪些地方。`（`App.tsx:463`）—— 而这个按钮在 F01 里是禁用的；一旦点得动，正文的 `emptyText` 又会变成「这次探测一条路由都没有记录 —— 通常意味着探测本身没跑起来。」（`EnvDiagnostics.tsx:181`）。
- **出口**：什么都没有（子元素 `steps.filter((s) => !s.ok)` 恒为空数组）。
- **自评严重度**：P1

#### F03 warnings 横幅在环境残缺时被引导卡取代
- **触发条件**：`envBroken === true`。
- **代码位置**：`src/renderer/src/App.tsx:219`（`!envBroken && warnings.length > 0` 才渲染横幅）。
- **用户看到的原文**：不产生新文案；warnings 改由引导卡内的 `EnvDiagnostics warnings={runtime?.warnings}`（`App.tsx:461`）呈现，而该区域的明细是空的（F02）。
- **出口**：有可点击的出口（横幅的 `设置` / `忽略` 在非残缺态仍然存在，`App.tsx:230-235`）。
- **自评严重度**：P2

#### F04 插件列表：没有可操作的 profile
- **触发条件**：`state.profiles.length === 0`（含「DSH_HOME 不存在 → `listProfiles` 静默返回 `[]`」，见 `src/main/engine/inventory.ts:133-136`）。
- **代码位置**：`src/renderer/src/components/PluginList.tsx:99-108`。
- **用户看到的原文**：标题 `没有可操作的 profile`；正文 `主进程没在 DSH_HOME 下找到任何 profile。去设置里确认 DSH_HOME 与安装根是否正确。`
- **出口**：**有可点击的出口且做得最完整**：`打开设置`（primary）+ `重新探测`（secondary）。
- **自评严重度**：P1

#### F05 插件列表：读取插件列表失败
- **触发条件**：`state.pluginsError` 非空。
- **代码位置**：`src/renderer/src/components/PluginList.tsx:115-126`。
- **用户看到的原文**：标题 `读取插件列表失败`；正文 `主进程返回了错误。可能是 profile 的 package.json 损坏，或 node_modules 读取权限不足。`；脚注是原始错误；动作 `重试`。
- **出口**：有可点击的出口（`重试`）。
- **自评严重度**：P1

#### F06 侧栏：一个 profile 都没找到（纯文字）
- **触发条件**：同 F04。
- **代码位置**：`src/renderer/src/components/Sidebar.tsx:25-28`。
- **用户看到的原文**：`一个 profile 都没找到。检查设置里的 DSH_HOME 是否正确。`
- **出口**：只有文字指引（同屏有「设置」按钮，但它不是这条提示的一部分）。
- **自评严重度**：P1

#### F07 安装面板：先选一个 profile
- **触发条件**：`state.activeProfile` 为空（`InstallPanel.tsx:48`）。
- **代码位置**：`src/renderer/src/components/InstallPanel.tsx:62-73`。
- **用户看到的原文**：标题 `先选一个 profile`；正文 `安装需要一个目标 profile。左侧列表里还没选中任何 profile，或 DSH_HOME 下没找到 profile。`
- **出口**：有可点击的出口（`打开设置`，`InstallPanel.tsx:69`）。
- **自评严重度**：P1

#### F08 环境面板：`安装根`/`node`/`pnpm` 三行的兜底值
- **触发条件**：对应字段为 null。
- **代码位置**：`src/renderer/src/components/EnvPanel.tsx:71`（`安装根`，`'未找到'`，tone=warn）、`EnvPanel.tsx:74`（`node`，`'未找到'`，tone=danger）、`EnvPanel.tsx:75`（`pnpm`，`'未找到'`，tone=danger）；`node.exe`/`pnpm 入口`/`dsh CLI` 三行的兜底是 `—`（`EnvPanel.tsx:76-78`）。
- **用户看到的原文**：`未找到` / `未找到` / `未找到`（无句子，无解释）。
- **出口**：有可点击的出口 —— 但只是折叠面板本身（面板里的「重新探测」按钮，见 F09），且该按钮在读缓存时救不了任何东西。
- **自评严重度**：P1

#### F09 「重新探测」按钮其实只读缓存，不重跑探测
- **触发条件**：用户点 `EnvPanel` 的「重新探测」。
- **代码位置**：`src/renderer/src/components/EnvPanel.tsx:33`（`useQuery<RuntimeInfo>(() => api().runtimeInfo(), …)`）→ 主进程 `src/main/ipc.ts:51` 直接调 `env.getRuntimeInfo()`，而后者带 `infoCache`（`src/main/engine/env.ts:371-381`，缓存变量在 `env.ts:289`）。清缓存的唯一入口是 `env.invalidate()`，只在 `settingsSet`（`src/main/ipc.ts:146`）与 `appearanceReset`（`src/main/ipc.ts:290`）里被调。
- **用户看到的原文**：按钮文案 `重新探测`；点了之后界面上数值**不会变化**（除非中间保存过设置）。注释里承诺的 `envRedetect()`「一定重算」（`src/shared/ipc.ts:214-220`）在审计时刻没有实现（G01/G02）。
- **出口**：按钮可点击，但它做不到它的名字所承诺的事。
- **自评严重度**：P1

#### F10 环境面板：还没探测到 / 探测通道报错
- **触发条件**：`state.runtime` 为 null（`EnvPanel.tsx:66-67`）；或 `probe.error` 非空（`EnvPanel.tsx:103`）。
- **代码位置**：`src/renderer/src/components/EnvPanel.tsx:66-67`、`src/renderer/src/components/EnvPanel.tsx:103`。
- **用户看到的原文**：`还没探测到环境。点下面的「重新探测」。` / `<probe.error 原文>`
- **出口**：有可点击的出口（面板内的「重新探测」，见 F09 的局限）。
- **自评严重度**：P2

#### F11 缝隙刻度带错误态：原因只挂在 `title` 上
- **触发条件**：`GapStrip` 收到 `error`（列表加载失败）。
- **代码位置**：`src/renderer/src/components/GapStrip.tsx:68-77`。
- **用户看到的原文**：视觉上是一条空白带；错误原因只存在于 `aria-label` 与 `title` 属性里。
- **出口**：什么都没有（非悬停不可见）。
- **自评严重度**：P2

#### F12 设置面板：保存失败的技术腔文案
- **触发条件**：`settingsSet` 抛错。
- **代码位置**：`src/renderer/src/components/SettingsDialog.tsx:242`。
- **用户看到的原文**：`保存失败，主进程拒绝了这次写入。看日志抽屉与 Toast 里的具体原因。`
- **出口**：只有文字指引（让用户去另两个地方看原因）。
- **自评严重度**：P2

#### F13 设置面板：「浏览…」与「重新检测」在主进程未接时全部禁用
- **触发条件**：`pickDir`/`redetect` 为 null（preload 没有对应方法，G01）。
- **代码位置**：`SettingsDialog.tsx:264-266`（取通道）→ `:387`（DSH_HOME 的 `浏览…`，按钮文案 `:394`）、`:428`（安装根的 `浏览…`，按钮文案 `:435`）、`:461`（`重新检测`）；禁用时的 title：`主进程还没接上「选择文件夹」通道，现在只能手打路径`（`:391`/`:432`）、`主进程还没接上「重新检测」通道`（`:465`）；诊断区错误在 `:326`（`主进程还没接上「环境诊断」通道，暂时拿不到探测过程。`）。
- **用户看到的原文**：三个控件灰掉；悬停才看到「主进程还没接上」。
- **出口**：**只有手打路径这一条**（输入框仍然可编辑，`SettingsDialog.tsx:400`/`:441` 的「检测」按钮仍可用）。
- **自评严重度**：P1

#### F14 代理回显把用户自己的端口号（如 `65535`）当成诊断结论推给用户（反馈 3 的落点）
- **触发条件**：`settings.proxy` 非空（这台机器上是 `http://127.0.0.1:65535`），用户在「设置 → 代理」点一次「测试」（`SettingsDialog.tsx:183` → `api().proxyTest(...)`），代理不可达时回显。
- **代码位置**：`src/main/engine/proxy.ts:301-323`（`explain()`；`case 'ECONNREFUSED': return \`连不上 ${host}:${port}，代理没在跑？\`` → 实际渲染成 `连不上 127.0.0.1:65535，代理没在跑？`）；回显点 `src/renderer/src/components/SettingsDialog.tsx:647`、`:659`（`{proxyResult.target}`）、`:619`（`正在连 {(draft.proxy ?? "").trim() || '直连'}…`）、`:589-596`（输入框 value）；归一化来源 `src/main/engine/proxy.ts:110`（`/^\d{1,5}$/` → `http://127.0.0.1:${raw}`）与 `src/renderer/src/components/SettingsDialog.tsx:43-50`（同款）；端口上界校验在 `src/main/engine/proxy.ts:241`（`port <= 0 || port > 65535` → `null`）。
- **用户看到的原文**：`连不上 127.0.0.1:65535，代理没在跑？`；以及回显行 `http://127.0.0.1:65535`。
- **出口**：**只有文字指引**（用户能改输入框，但界面从不解释「你输的那串是怎么被理解成这个地址的」）。
- **自评严重度**：P2
- **证据**：`65535` 字面量在 `src/renderer/**` **0 命中**；在 `src/**` 只出现在 `src/main/engine/proxy.ts`（`:91-94` 注释示例、`:156` IPv6 注释、`:241` 上界）。`docs/_log.md:229` 记「本机代理 `http://127.0.0.1:65535`」，`docs/proxy-audit.md:4`/`:104`/`:221`/`:271` 记「真代理 `65535`」——**65535 是这台机器上用户自己 VPN 监听的端口，不是插件台的默认值**。所以「端口那里显示的 65535」只可能来自「回显用户自己配置的代理地址」的上面四处；改法见 §5 第 32 条。
- **半核实**：代码路径已核实到行；用户截图里究竟落在四处中的哪一处（测试失败文案 / 回显行 / 输入框 / 清单安装时的 pnpm 输出）未做运行时验证，见 §6 第 3 条。

### G 组：契约与基础设施缺口

#### G01 preload 没有挂出 `pickDirectory` / `envRedetect` / `envDiagnose`
- **触发条件**：恒成立（审计时刻）。
- **代码位置**：`src/preload/index.ts:42-142`（`const api: DshConsoleApi = { … }`）—— 用 `grep` 在 `src/preload/index.ts` 搜 `redetect|diagnose|pick` **0 命中**；声明在 `src/shared/ipc.ts:212`/`:220`/`:228`，通道名在 `src/shared/ipc.ts:88-90`。
- **用户看到的原文**：不直接产生文案；后果见 F01 与 F13（按钮全禁用）。
- **出口**：什么都没有。
- **自评严重度**：P0

#### G02 主进程没有注册这三个 `ipcMain.handle`
- **触发条件**：恒成立（审计时刻）。
- **代码位置**：`src/main/ipc.ts`（`grep pickDirectory|envRedetect|envDiagnose` 在 `src/` 下只命中 `src/shared/ipc.ts` 与渲染层 `EnvDiagnostics.tsx`，`src/main/ipc.ts` 0 命中）。
- **用户看到的原文**：不直接产生文案；即便 preload 挂上，调用也会以「no handler registered」抛出（会经 `toMessage` 变成技术文案，见 G05）。
- **出口**：什么都没有。
- **自评严重度**：P0

#### G03 官方通道路径缓存把 `null` 也缓存住，且没有失效入口
- **触发条件**：`resolveOfficialPaths()` 第一次被调用时找不到官方模块（含「这时 `installRoot` 还是 null」）。
- **代码位置**：`src/main/engine/dshpm.ts:119`（`let cachedPaths: OfficialPaths | null | undefined`）、`src/main/engine/dshpm.ts:123`（`if (cachedPaths !== undefined) return cachedPaths`）；失效函数 `src/main/engine/dshpm.ts:137-139` 用 `grep invalidateOfficialPaths` 在全库**只有定义、0 个调用点**。
- **用户看到的原文**：不直接产生文案；后果是：**用户在设置里把安装根填对并保存后，本进程内官方通道仍不可用（要重启插件台）**。表现是插件安装继续走降级通道，或继续报 C10/B01 的话。
- **出口**：什么都没有。
- **自评严重度**：P1

#### G04 诊断日志能写下来，但用户没有入口去拿
- **触发条件**：恒成立。
- **代码位置**：`src/main/diagnostics.ts:153-155`（`diagPath()`）、`src/main/diagnostics.ts:158-160`（`diagDir()`），注释写着「设置面板里要能一键打开它」；`grep diagDir|diagPath` 在 `src/` 下**只有这两处定义**，0 个调用点。
- **用户看到的原文**：什么都不显示（用户根本不知道有 `diag.log`）。
- **出口**：什么都没有（远程排障时，用户仍然只能截图）。
- **自评严重度**：P1

#### G05 preload 缺失时的内部技术文案会直接进用户视野
- **触发条件**：`window.dsh` 不存在（preload 没注入 / 构建产物缺失）。
- **代码位置**：`src/renderer/src/api.ts:24-31`，抛出文案在 `api.ts:27`：`window.dsh 不可用：preload 未注入。检查 preload 构建产物是否生成、contextIsolation 是否为 true。`
- **用户看到的原文**：上述原文（经 `toMessage` 进 toast / 空态脚注）。
- **出口**：什么都没有。
- **自评严重度**：P2

#### G06 系统通知不可用时静默退化
- **触发条件**：`Notification` 不可用（`tray.ts:81-89`）。
- **代码位置**：`src/main/tray.ts:81-89`。
- **用户看到的原文**：无（只写 `console.log`）。
- **出口**：什么都没有。
- **自评严重度**：P2

#### G07 托盘创建失败 → 关窗即退出（与「找不到安装」体感相关的候选）
- **触发条件**：托盘图标缺失或 `Tray` 构造失败（`tray.ts:211-222`）。
- **代码位置**：`src/main/tray.ts:211-222`（失败路径）+ `src/main/tray.ts:285-287`（`hasTray()`）+ `src/main/index.ts:84-88`（`window-all-closed` 里 `if (hasTray()) return; app.quit()`）。
- **用户看到的原文**：只在控制台有 `[托盘] 找不到托盘图标，已跳过托盘创建：<iconPath>`；界面上什么都不说。
- **出口**：什么都没有。
- **自评严重度**：P2
- **附注**：用户反馈里「新电脑找不到安装」是否与「点关闭就退出、以为只是收进托盘」有关，**未核实** —— 我没有拿到那位用户的现场信息。

---

## 3. 「同一个根因被复制 N 次」清单

### 3.1 现场：清单导入的 12 行
链路与具体位置：

| 步 | 位置 | 做了什么 |
| --- | --- | --- |
| 1 | `src/main/engine/ops.ts:1516` | 一次性 `pnpm add <全部 spec>` |
| 2 | `src/main/engine/ops.ts:1522-1524` | 非 0 且包数 > 1 → 进降级分支 |
| 3 | `src/main/engine/ops.ts:1532-1547` | **对 N 个包各跑一次 `pnpm add`**；每次失败 `failed.push({name, detail})`，`detail` 来自 `errorSummary(one.log)` |
| 4 | `src/main/engine/pnpm.ts:435-454` | 每次运行的 `detail` 都是同一句固定文案（`pnpm.ts:323`/`:342` 传进去的 `message`） |
| 5 | `src/main/engine/ops.ts:1639-1642` | `failed.map(f => \`${f.name}：${f.detail}\`).join('；')` 拼进一条 message |
| 6 | `src/renderer/src/lib/store.ts:1088` | `toast('error','操作失败', message)` |
| 7 | `src/renderer/src/styles/components.css:1889` | 68px 裁掉，3.5 秒后整条消失（`Toasts.tsx:11`） |

**现在为什么是 N 条**：不是「渲染层渲染了 N 次」，而是**主进程把 N 条明细 join 成了一条字符串**。12 条这个数字来自「清单里缺 12 个包」，不是任何固定上限。

### 3.2 三个可能的聚合点，性质不同

1. **主进程结果结构层（推荐落点）**：`src/main/engine/ops.ts:1637-1643`。
   现在 `message` 既是「给人看的口头结论」又是「故障明细容器」，两种职责压在一个字符串上。建议在 `OpResult`（`src/shared/types.ts`）里加结构化字段（例如 `failures: Array<{name, detail, reasonKind}>`），`message` 只留摘要；并按 `detail` 去重计数，例如
   `清单导入：0 个装好，12 个失败（12 个同一原因：找不到 DSH 自带的 node/pnpm…）`。
   这一层的收益最大：所有消费者（toast / 日志抽屉 / 以后的通知）都能各自决定怎么展示。
2. **渲染层 toast 层**：`src/renderer/src/lib/store.ts:1088`。
   只做「摘要 + 一条去日志的入口」，例如 `12 个包失败` + 按钮 `看日志`。**前提是 toast 要能带动作**（现在 `Toasts.tsx:21-41` 没有动作位）。
3. **日志抽屉层**：`src/renderer/src/components/LogDrawer.tsx:166-171`。
   它已经能完整显示 message，是唯一「长文案有地方待」的容器。**它是目前的既成聚合点，只是从 toast 没有路过去。**

### 3.3 反向问题：有的批量操作是「0 条明细」
同一个仓库里，批量口径是**不统一**的：

| 操作 | 失败明细去哪 | 位置 | 用户能不能看到原因 |
| --- | --- | --- | --- |
| 清单导入 | **全塞进 message** | `ops.ts:1639-1642` | 能，但被 toast 裁掉 |
| 卸载 | 只进日志 + message 只给计数 | 明细 `ops.ts:1057`，汇总 `ops.ts:1088-1093` | 不能（`卸载完成：成功 X 个，失败 Y 个`） |
| 更新 | message 只给计数/成功名单 | `ops.ts:1336-1339` | 部分 |
| 启用/停用 | message 只给计数 | `ops.ts:1415-1416` | 不能 |
| 批量安装（清单） | 只进日志 | `ops.ts:1525-1529` | 不能 |

**结论**：所谓「12 行重复」不是「复制太多」，而是**同一个操作把明细全放进了用户最短命的那个容器（toast）**；而其它批量操作把明细放进了用户看不见的容器（日志）。**两种都不对，正确做法是「结构化明细 + 摘要 + 一个能看到明细的可点入口」。**

### 3.4 顺带记录：三个「12」不是同一件事
- `src/main/engine/ops.ts` 拼出的 12 条：清单里缺 12 个包。
- `src/renderer/src/lib/store.ts:62` 的 `CONFIRM_LIST_MAX = 12`：确认弹窗明细最多列 12 条，第 13 条起折成「…等 N 个」。
- `src/renderer/src/components/InstallPanel.tsx:574` 的 `MISSING_PREVIEW_MAX = 12`：清单预览里「需要安装」的列表最多列 12 条（截断在 `InstallPanel.tsx:767-769`）。
三处独立，**不要把它们合并成同一个常量**，它们约束的分别是「结果明细条数」「确认框明细条数」「预览条数」。

---

## 4. 文案与事实不符

本节只列「一句话把两件事混成一件」或「说的和实际发生的不一致」的地方，并给出建议改写。**第 1–3 条是同一个认知错误的三个副本，建议一次性统一。**

### 4.1 `找不到 DSH 自带的 node/pnpm，请到设置里指定安装根`

- **出现位置**：`src/main/engine/pnpm.ts:135`、`src/main/engine/pnpm.ts:323`、`src/main/engine/pnpm.ts:342`（三处一模一样；经 `ops.ts:925`、`ops.ts:1268`、`ops.ts:1641` 呈现给用户）。
- **不符之处**：`node`/`pnpm` 的探测路径**完全不经过 `installRoot`** —— 它们只在 `<DSH_HOME>/dsh-runtimes/...` 下找（`src/main/engine/env.ts:211-242`）。而安装根只决定「官方通道能不能用」（`src/main/engine/dshpm.ts:105-143`）。**用户按这句话去改「安装根」，改完了 node/pnpm 依然找不到。** 这正是反馈 4 里用户「照做了也没用」的直接原因。
- **建议改写**（按实际缺失项分流，至少三个分支）：
  - 只缺 node/pnpm：`DSH 运行时不完整：没找到随包的 node.exe（应在 <当前 DSH_HOME>\dsh-runtimes\*\dependencies\node\bin\）。装插件要靠它，请先确认 DSH_HOME 指向的是装过 DSH 的那份目录。`
  - 只缺安装根：`没找到 DSH 的安装目录（找过：设置里的值、DSH_INSTALL_ROOT、desktop-install.txt、%LOCALAPPDATA%\Programs、C:\Program Files、%LOCALAPPDATA%）。装插件本身不需要它，但「官方安装通道」和「启动 DSH」需要。`
  - 两者都缺：分两行列出，不要合成一句。

### 4.2 `找不到 DSH 可执行文件：<…>。可以在设置里指定安装目录`

- **出现位置**：`src/main/engine/dshproc.ts:369`（拼装在 `:366`）。
- **不符之处**：当 `installRoot` **已经找到了**、只是里面没有可用 `.exe` 时，展示值会变成 `<安装根>\<未找到 .exe>`（`dshproc.ts:366`），而尾句仍然让用户「指定安装目录」—— 用户再指定一次同一个目录不会好。这条与 4.1 是同一类错误的第二处，**任务书已点名，本次确认成立**。
- **建议改写**：
  - `installRoot` 为 null：`没找到 DSH 桌面端装在哪，所以不知道该启动哪个 exe。请在设置里指定 DSH 的安装目录（选到含 resources 文件夹的那一层）。`
  - `installRoot` 有值：`安装目录 <路径> 里没有找到 DeepSeek Harness 的可执行文件（已排除卸载程序）。这个目录可能只装了运行时不完整，或者壳程序被单独移走了。`

### 4.3 引导卡正文说「装插件要靠安装根下面 resources 里的 node 和 pnpm」

- **出现位置**：`src/renderer/src/components/EnvDiagnostics.tsx:46`（`missingEnvParts` 里「安装目录」这一项的 hint）。
- **不符之处**：**这是同款混淆在审计窗口内新写的第三份副本**（该文件 18:16 才创建）。事实是：`node.exe`/`pnpm` 来自 `<DSH_HOME>/dsh-runtimes/...`（`env.ts:211-242`），安装根下面是官方通道模块（`dshpm.ts:105-117`）。
- **建议改写**：`没找到 DeepSeek Harness 装在哪 —— 「启动 DSH」和「走官方安装通道」需要它；装插件本身靠的是 DSH_HOME 下那份随包 node。`

### 4.4 `主进程没在 DSH_HOME 下找到任何 profile。去设置里确认 DSH_HOME 与安装根是否正确。`

- **出现位置**：`src/renderer/src/components/PluginList.tsx:99-108`（hint）。
- **不符之处**：profile 列表只由 `DSH_HOME` 决定（`src/main/engine/inventory.ts:127-136` 读 `<dshHome>/profiles`），**「安装根」与它无关**。让用户去确认一个不相关的字段，会让他改错东西。
- **建议改写**：`DSH_HOME 下没找到任何 profile（<当前 DSH_HOME>\profiles）。这个目录由 DSH_HOME 决定，跟安装根无关。`

### 4.5 「重新探测」按钮不重新探测

- **出现位置**：按钮 `src/renderer/src/components/EnvPanel.tsx:93-104`，实现 `EnvPanel.tsx:33` + `src/main/ipc.ts:51` + `src/main/engine/env.ts:371-381`。
- **不符之处**：名字承诺「重探」，行为是「读缓存」。契约里明明有 `envRedetect()`「一定重算」的注释（`src/shared/ipc.ts:214-220`），但审计时刻它没实现。
- **建议改写**：按钮先接 `envRedetect()`；在通道不可用之前，至少把文案改成 `刷新显示`，不要承诺它会重新探测。

### 4.6 `安装失败（exit -1）：…`

- **出现位置**：`src/main/engine/ops.ts:925`（`run.code` 为 -1 时）。
- **不符之处**：`-1` 不是进程退出码，是 `missingRuntime()` 合成的「没跑起来」标记（`pnpm.ts:435-454` 的 `code:-1`；`pnpm.ts:134-148` 同样返回 `-1`）。对用户来说「exit -1」看起来像崩溃，会把排障引到「pnpm 崩了」而不是「根本没执行」。
- **建议改写**：`-1` 单独分支：`没跑起来：本机没找到 DSH 自带的 node/pnpm，安装命令没有被执行。` 其余情况才写 `（退出码 <code>）`。

### 4.7 `这次探测一条路由都没有记录 —— 通常意味着探测本身没跑起来。`

- **出现位置**：`src/renderer/src/components/EnvDiagnostics.tsx:181`（`emptyText` 默认值）。
- **不符之处**：审计时刻它为空的原因不是「探测没跑起来」，而是**生产者压根没填 `discovery`**（A11）。这句把「功能未实装」说成「运行时异常」，会让人去查错误的方向。
- **建议改写**：先接上 `discovery`；在那之前，空态直接说 `暂时拿不到探测明细。`

### 4.8 `设置里的安装根无效（没有 resources/app/package.json 或包名不对）：<路径>`

- **出现位置**：`src/main/engine/env.ts:176`。
- **不符之处**：这条**没有不符**，而且是全仓唯一一条把判定标准讲清楚的环境文案（点名了要校验的文件与包名）。**建议把它作为其它环境文案的改写范本。** 唯一可加强的是补一句「包名应为 `@deepseek-ai/dsh-desktop`」。

### 4.9 反例（做对了的）：`一个 profile 都没找到。检查设置里的 DSH_HOME 是否正确。`

- **出现位置**：`src/renderer/src/components/Sidebar.tsx:27`。
- **说明**：只提 `DSH_HOME`，没有把安装根拉进来，与实现一致。**建议把 4.4 / 4.3 改成这个口吻。**

---

## 5. 修复清单（按 P0 / P1 / P2 排序）

格式：`优先级 | 一句话问题 | 代码位置 | 建议改法`

**P0**

1. `P0 | 三道环境通道（选文件夹 / 重新探测 / 诊断）在 preload 没挂，界面上的按钮全禁用 | src/preload/index.ts:42-142 | 在 api 对象里补 pickDirectory/envRedetect/envDiagnose 三个方法，分别 invoke CH.pickDirectory / CH.envRedetect / CH.envDiagnose |`
2. `P0 | 三个 handler 在主进程没注册，调用必抛 no handler | src/main/ipc.ts（registerIpc） | 补三个 ipcMain.handle；pickDirectory 用 dialog.showOpenDialog({properties:['openDirectory']})；envRedetect 内先 env.invalidate() 再 getRuntimeInfo()；envDiagnose 返回 discovery 明细 |`
3. `P0 | node/pnpm 缺失的文案指向了错的字段（安装根），用户照做无效 | src/main/engine/pnpm.ts:135 / :323 / :342 | 抽成一个 buildMissingRuntimeMessage(kind) 分流：缺 node/pnpm → 指向 DSH_HOME 与 dsh-runtimes；缺安装根 → 指向安装根；两者分开写 |`
4. `P0 | 环境探测只有 6 条写死候选，新电脑装到别处就全不中 | src/main/engine/env.ts:119-166 | 在候选表之后追加「问系统」的几类来源（注册表卸载项/安装项、开始菜单与桌面快捷方式的目标目录、进程镜像路径、限定深度的磁盘扫描），并把每一步结果写进 to 返回的 discovery |`
5. `P0 | discovery / installRootFrom / dshHomeFrom 声明了但生产者不填，诊断面板永远空 | src/main/engine/env.ts:356-367（补齐字段） | 让 installRootCandidates()/resolveInstallRoot() 返回带 from 与 ok 的步骤记录，buildRuntimeInfo 里填进 discovery 与 installRootFrom/dshHomeFrom |`
6. `P0 | 所有操作失败只弹一句「操作失败」，明细挤在会被裁掉的 toast 里 | src/renderer/src/lib/store.ts:1088 + src/renderer/src/styles/components.css:1889 | 给 OpResult 加结构化 failures 字段；toast 只放摘要 + `看日志` 按钮；把 .toast__detail 的 max-height/overflow 改成可滚动或去掉裁剪 |`
7. `P0 | 清单导入把 N 条失败明细 join 成一条超长字符串 | src/main/engine/ops.ts:1639-1642 | 按 detail 分组计数后再生成摘要（`12 个失败：同一原因「…」×12`），明细放结构化字段，不再无条件 join 进 message |`
8. `P0 | 引导卡承诺「两个按钮随便点一个就能解决」，实际两个都灰着 | src/renderer/src/App.tsx:419 / :433 | 与第 1、2 条一起修（通道接上即自动恢复）；在通道未接时把 title 里的「主进程还没接上」改成用户能懂的话，并隐藏而不是禁用无效按钮 |`
9. `P0 | 找安装根失败只给一条告警，用户除了手打路径无路可走 | src/main/engine/env.ts:181 | 告警行后面直接带动作：在 App 的告警呈现里为这条 warn 挂「选择安装目录…」按钮（复用第 1 条的通道） |`

**P1**

10. `P1 | 官方通道路径缓存把 null 也缓存，且失效函数 0 调用点 | src/main/engine/dshpm.ts:119-139 | settingsSet 成功后调 invalidateOfficialPaths()；并在缓存里区分「未探测」与「探测失败的时机」，或让 invalidate 由 env.invalidate() 一并触发 |`
11. `P1 | 「重新探测」按钮只读缓存，做不到它名字承诺的事 | src/renderer/src/components/EnvPanel.tsx:33 | 改调 envRedetect()（第 1 条）；未接之前把按钮文案改为「刷新显示」 |`
12. `P1 | 清单/插件面板的指引让用户去确认与故障无关的「安装根」 | src/renderer/src/components/PluginList.tsx:99-108、src/renderer/src/components/InstallPanel.tsx:62-73 | 按 4.4 改写；只在真的缺安装根时才提安装根 |`
13. `P1 | 「安装目录找到了、里面没 exe」仍说「可以在设置里指定安装目录」 | src/main/engine/dshproc.ts:366-369 | 按 4.2 分成两个分支文案；同时在 DshControl 里把「目录里有几个 exe、挑了哪个」显示出来 |`
14. `P1 | 安装根 = null 时确认框文案语法坏掉 | src/renderer/src/lib/store.ts:1486 | installRoot 为 null 时改成 `还没找到 DSH 装在哪，先带你去找它。` 并把确认按钮直接变成「打开设置」 |`
15. `P1 | 12 条明细的另一半容器（日志抽屉）没有入口 | src/renderer/src/components/Toasts.tsx:21-41 | 给 toast 结构加可选 action（label + onClick），失败类 toast 默认挂「看日志」→ actions.openLogs() |`
16. `P1 | toast 队列上限 4，最早的关键提示被静默丢弃 | src/renderer/src/lib/store.ts:654-656 | 失败级 toast 不参与「只留最后 4 条」的淘汰（按 level 保护），或者被淘汰时写入日志抽屉 |`
17. `P1 | 托盘启停失败只说「详情见控制台」 | src/main/tray.ts:153 / :188 | 走 EV.toast 推给渲染层（通道已在 store.ts:1097-1100 接好），文案改成用户能懂的动作指引 |`
18. `P1 | exePath 为 null 时界面完全沉默，用户点按钮才知道坏 | src/renderer/src/components/DshControl.tsx:176-180 | exePath 为 null 时渲染一行 `未找到 DSH 可执行文件` + 一个「去找」按钮（复用第 1 条通道） |`
19. `P1 | 诊断日志写下来但用户没有入口 | src/main/diagnostics.ts:153-160 | 在设置面板加「打开诊断日志目录」按钮，调用 shell.openPath(diagDir()) |`
20. `P1 | 官方通道不可用时静默降级，用户不知道走的是哪条路 | src/main/engine/ops.ts:233-240 | 降级时向渲染层推一条 info toast（或把「本次走官方/降级通道」写进结果结构并在日志抽屉结论行显示） |`
21. `P1 | ops 层的 profile 目录类失败全是内部术语 | src/main/engine/ops.ts:849 / :853 | 补可执行指引（`这通常是 DSH_HOME 指错了，去设置里改 DSH_HOME`），并挂「打开设置」动作 |`
22. `P1 | startup settingsGet 失败直接把界面打成 fatal | src/renderer/src/lib/store.ts:1069 | 降级到 FALLBACK_SETTINGS + 一条 warn toast，继续跑；只有 preload 完全不可用时才 fatal |`
23. `P1 | 环境残缺时 warnings 横幅被引导卡顶掉，而引导卡的明细是空的 | src/renderer/src/App.tsx:219 / :461 | 与第 5 条一起修：discovery 填上后此处自然恢复；未填前把 warnings 列表也渲染进引导卡 |`

**P2**

24. `P2 | 「忽略」告警只顶一次刷新 | src/renderer/src/lib/store.ts:462-463 | 用 runtime 的指纹（如 warnings.join 的哈希）记录「已忽略的那一版」，内容变了才重新弹 |`
25. `P2 | reloadAll 静默吞掉 settingsGet 失败 | src/renderer/src/lib/store.ts:1029-1047 | 吞掉但记一条日志行（logSystem 之外的渲染层日志），或在 toast 里降级提示 |`
26. `P2 | node -v / pnpm -v 探测失败的告警对用户没有可执行动作 | src/main/engine/env.ts:353-354 | 合并成一条并附「这一项只影响版本显示，不影响安装」 |`
27. `P2 | 缝隙刻度带的错误原因只在 title 里 | src/renderer/src/components/GapStrip.tsx:68-77 | 错误态在带子旁边渲染一行短文字（可截断 + title 全文） |`
28. `P2 | preload 未注入时把内部实现细节讲给用户 | src/renderer/src/api.ts:27 | 面向用户的文案改成 `界面没能连上后台进程，请重启插件台。`，技术原文只进 diag.log |`
29. `P2 | 保存失败让用户自己去别处找原因 | src/renderer/src/components/SettingsDialog.tsx:242 | 把 settingsSet 的失败原文直接渲染在设置面板的错误条里（现在只有一句指路） |`
30. `P2 | 托盘/通知不可用时静默退化 + 关窗即退出 | src/main/tray.ts:81-89 / :211-222 + src/main/index.ts:84-88 | 托盘创建失败时把 minimizeToTray 视为 false 并在设置面板显示一行状态；窗口关闭前给一次一次性提示 |`
31. `P2 | 预检与 runOp 的兜底文案带内部术语 | src/main/engine/ops.ts:574 / :877 / :883 | 面向用户的兜底统一为 `这次操作没能开始，原因已记入日志。`，原文只进日志 |`
32. `P2 | 代理提示把用户自己的端口号（127.0.0.1:65535）当结论显示，用户看不懂也不想要（反馈 3） | src/main/engine/proxy.ts:301-323（explain 的 ECONNREFUSED 分支）；回显点 src/renderer/src/components/SettingsDialog.tsx:589-596 / :619 / :647 / :659 | explain() 改成先说人话再给地址：`代理端口没有响应（它没在跑，或者地址填错了）`，`host:port` 降为次要信息；设置面板的 target 回显拆成「地址 + 端口」两行小字，并在输入框旁显示归一化结果（`你输入的是「65535」→ 按 http://127.0.0.1:65535 测试`），让那个数字有出处 |`

---

## 6. 未核实清单

以下条目我在本次审计中**没有拿到足够证据**，故不写结论（列出来是为了避免被后续的人当成已经查过）：

1. **A10** `fallbackRuntimeInfo()` 在真实环境下能否被触发 —— 我没有找到能让 `buildRuntimeInfo()` 抛出的稳定路径，也没跑运行时验证。
2. **G07** 用户反馈「新电脑找不到安装」是否与「托盘创建失败 → 关闭窗口即退出」有关。我没有那位用户的现场信息（是否最小化过、托盘是否可见）。
3. **反馈 3「端口那里不要显示 65535」的落点** —— 代码层面已定位（见 F14）：`65535` 在 `src/renderer/**` 0 命中，在 `src/**` 只出现在 `src/main/engine/proxy.ts:91-94`（注释示例）、`:156`（IPv6 注释）、`:241`（端口上界）；而这台机器上用户自己的 VPN 就监听 `127.0.0.1:65535`（`docs/_log.md:229`、`docs/proxy-audit.md:4`/`:271`）。因此它是「回显用户自己配置的代理地址」，候选四处为 `src/main/engine/proxy.ts:305`（`连不上 host:port，代理没在跑？`）与 `src/renderer/src/components/SettingsDialog.tsx:589-596`/`:619`/`:647`/`:659`。**未核实的是「用户截图里具体是哪一处」**——我没有做运行时验证，也没有他的截图原图，只能给出候选集与统一改法（§5 第 32 条）。附带一条**已核实**但不属于插件台 UI 的命中：`scripts/probe-setproxy.js`、`scripts/probe-shots2.js`、`scripts/verify-sidebar-all.js` 把代理设成 `127.0.0.1:65535`（另一条线的探测脚本），若用户看到的是这些脚本留下的设置值，那是测试数据而不是产品默认值。
4. **`preload/index.ts` 缺失三个方法是否会让 `tsc` 报错** —— 该文件是 `const api: DshConsoleApi = { … }`（`preload/index.ts:42`），按类型应当报缺字段，但本次明确不跑类型检查，**未核实**。
5. **`EnvDiagnostics.tsx` / `env-setup.css` / `App.tsx` / `SettingsDialog.tsx` 的审计时刻版本是否还会继续变** —— 那一线在 18:11–18:18 连续提交，我引用的是我读取到的那一版；若其后有改动，本报告中这些文件的行号可能已位移。
6. **`market.ts` / `net.ts` / `proxy.ts` / `versions.ts` / `gallery.ts` / `icon.ts` 的网络类错误文案** —— 它们对「环境缺失出口」只构成旁证，本次未逐条审计。
7. **生产构建产物（`out/`、`release/`）与安装包** —— 未检查；本报告的结论全部基于 `src/`。
8. **`shared/ipc.ts` 里 `envRedetect` 注释提到的「注册表 / 快捷方式 / 进程 / 磁盘扫描」** —— 这四类来源在 `src/` 中**不存在**任何实现（`env.ts` 只有那 6 条候选）。它们是设计意图，不是现状。
9. **`inventory.ts` 是否有其它路径产生的错误文案** —— 我读到的是「全部兜成空数组、不产生 error 字符串」；若还有别的分支，未核实。
