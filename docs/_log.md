# DSH 插件台 —— 战斗卡（踩过的坑 + 走通的路）

> 按 `~/.dsh/AGENTS.md` 的要求，每完成一个技术任务就把「成功路线 + 踩坑」写回这里。
> 后续要动这个工程、或者要写类似的 DSH 周边工具，先看这一页。

---

## 一、DSH 插件的真相（改代码前必读）

### 1. profile 的「两套账」

一个 profile 目录（`~/.dsh/profiles/<name>/`）里有**两个互不相同的集合**：

| 文件 | 字段 | 含义 |
|---|---|---|
| `package.json` | `dependencies` | 真的装了什么 |
| `package.json` | `dsh.profile.bundles` | 启动时加载哪些层（**有序数组，顺序即加载顺序**） |
| `cordis.patch.yml` | 顶层数组 | 配置覆盖 / 停用（loader patch entries） |

**`bundles` 里会有 `dependencies` 里根本没有的包**（官方包 `@deepseek-ai/dsh-base`、`dsh-web-app`、`dsh-headless` 就是这样进来的）。
所以「已装插件清单」的数据源必须是 **`dependencies` ∪ `bundles`**，只看一个都不对。

### 2. 「这是不是一个 DSH 插件」的唯一判据

> `package.json` 里有没有 **`dsh.bundle.patch`**。

**不是**「有没有 `dsh` 字段」，**不是**包名带不带 `dsh-` 前缀，**更不是**名字里有没有 `dsh`。

证据：`@deepseek-ai/dsh-plugin-manager/lib/types/operations.js` 的
```js
function bundleManifest(name, dir, anchor) {
  const manifest = readProfileManifest('dsh', resolveBundleDir('dsh', name, anchor, dir))
  return manifest.dsh?.bundle?.patch === undefined ? undefined : manifest
}
```

**教训**：我第一版拿 `dsh` 字段存在性当判据，会把纯依赖塞进加载列表。DSH 会报
`warning: <name> declares no dsh.bundle — installed as a plain dependency, not as a profile layer`，
或者加载一个没有 patch 的包把 profile 弄坏。

### 3. `bundles` 的调和算法（`reconcile()`）

`@deepseek-ai/dsh-plugin-manager/lib/types/operations.js:96` 是宿主维护 `bundles` 的真实逻辑：

```js
const after = readProfileManifest('dsh', dir)
const dependencies = Object.keys(after.dependencies ?? {})
const beforeDeps = new Set(Object.keys(before.dependencies ?? {}))
const previous = after.dsh?.profile?.bundles ?? []
const bundles = previous.filter((name) => {
  if (!beforeDeps.has(name) && !dependencies.includes(name)) return true
  return dependencies.includes(name) && bundleManifest(name, dir, anchor) !== undefined
})
for (const name of dependencies) {
  if (beforeDeps.has(name)) continue
  const metadata = bundleManifest(name, dir, anchor)
  if (metadata?.dsh?.bundle === undefined) { /* 只警告，不加 */ continue }
  if (!bundles.includes(name)) bundles.push(name)   // ← 追加到末尾
}
```

三条推论，决定了我们的所有写操作：
1. **新增只追加到末尾**，已存在的保序。
2. **我们自己从 `bundles` 里摘掉一个包之后，后续走官方通道的安装不会把它塞回来**
   （`previous` 已不含它，循环只处理 `!beforeDeps.has(name)` 的新增项）。
   → 所以「停用 = 只摘 `bundles` + 记我们自己的 state.json」是自洽的，不需要去写用户的 `cordis.patch.yml`。
3. 从 `dependencies` 移除后，`bundles` 会被自动过滤掉那一项。

### 4. `dsh plugin --profile desktop ...` 被硬拒

`@deepseek-ai/dsh/lib/bin.js` 里：
```js
function rejectElectronProfile(program, profile) {
  if (profile.toLowerCase() === 'desktop')
    program.error('error: profile "desktop" is managed exclusively by the Electron application')
}
```
`manageDesktopProfile` 只在 Electron 桌面端调 `runCli()` 时才传 `true`。
**所以想对 `desktop` profile 做写操作，不能 spawn `node bin.js plugin --profile desktop add x`**，必须直接复用官方的 `operations` 模块（见下）。

### 5. 直接复用官方 `operations` 模块（最划算的一步）

```js
// main 是 CJS，用动态 import 载入 ESM
const ops = await import(pathToFileURL(
  '<installRoot>/resources/app/dsh/node_modules/@deepseek-ai/dsh-plugin-manager/lib/types/operations.js'
).href)
```
> ⚠️ 这个包**没有随包发 `.d.ts`**，官方模块零类型，只能自己声明用到的形状。

包里有独立 export 子路径 `"./operations"`。一次拿到五样我们本来要自己写的东西：

| 能力 | 官方实现 |
|---|---|
| `bundles` 调和 | `reconcile()`（上面那个算法） |
| 兼容性前置门禁 | 装之前比对 `engines.dsh` / `@deepseek-ai/dsh*` 的 peerDeps，不兼容就 **`exitCode 1` 且什么都不装** |
| 快照回滚 | `package.json` + `pnpm-lock.yaml` 内存快照，失败/兼容性拒绝时 `writeFileAtomic` 还原 |
| 诊断日志 | `<profile>/.plugin-manager/logs/operation-<随机>/pnpm.log` |
| 跨进程写锁 | `withFileLock(join(dir,'package.json'), ...)` |

**调用要点（每一个都踩过）**：
- `execution: 'service'` 是**唯一能拿到输出**的模式。`'cli'` 是 `inherit`，`child.stdout` 为 `null`，`onOutput` 永不触发，`output` 也是空。
- `environment = { ...(execution==='cli' ? process.env : scrubbedParentEnv()), ...options.env }`
  → **`PATH` 必须自己显式塞进 `options.env`**，否则 git 依赖和生命周期脚本找不到可执行文件。
- 官方只有 `idleTimeoutMs`（静默超时），**没有整体超时** → 整轮上限得自己用 `AbortController` + `setTimeout` 做成 `AbortSignal`，再 `AbortSignal.any([...])` 传进 `options.signal`。
- `INSTALL_ANCHOR` = `<installRoot>/resources/app/dsh/node_modules/@deepseek-ai/dsh/package.json`
  （`profile-boot-*.js:119`：`fileURLToPath(new URL("../package.json", import.meta.url))`）。

---

## 二、pnpm 11 的三个硬钉子

### 1. 构建脚本默认被拦 → 装了等于没装

`ERR_PNPM_GIT_DEP_PREPARE_NOT_ALLOWED`。装 GitHub 来源的插件时，仓库的 `prepare`/`build` 不跑，
**ppnpm 什么都不装就退出**，而且要求往 `<profile>/pnpm-workspace.yaml` 的 `allowBuilds` 里写一条
**带完整 codeload URL 的精确 key** —— 用户不可能自己猜出来。

> 走官方通道时这个要自己补：从报错里正则捞出要加的 key，写进 `pnpm-workspace.yaml` 的 `allowBuilds`，再重试一次。
> 实测两条 key 形如
> `'dshmarket@https://codeload.github.com/dsh-market/dsh-market/tar.gz/c01a967a...': true`
> 和 `dshmarket@1.73.8: true`。写进去之后仓库的 `prepare` 真的跑了（`Build complete in 110ms`）。

### 2. 供应链冷却把 `@latest` 悄悄压回旧版

现象：`dsh-context` 远端 0.79.0，`pnpm add dsh-context@latest` 只装到 **0.78.2**，导致「可更新」按钮永远亮着。

**错误解法**（两个都试过）：
- ❌ 把 argv 从 `@latest` 改成钉 `rec.latestVersion` —— 无效。因为那一批 `records` 是刚读盘的，
  `latestVersion` 一律是 **null**。
- ✅ 正解：**先补一次远端查询**拿到真实版本号，再往 `installArgs` 里钉**精确版本**。

pnpm 自己也会打一行 `Added 1 entry to minimumReleaseAgeExclude in pnpm-workspace.yaml ...` ——
说明**「钉精确版本」就是正解**，写 `minimumReleaseAgeExclude` 只是兜底。

### 3. `--reporter` 的位置有讲究

`--reporter=append-only` 必须插在**第一个非选项参数之前**（也就是子命令之前）；
调用方自带 `--reporter` 时不要重复加。不这么写，流式日志会变成一堆看不清的覆盖式输出。

---

## 三、Windows / Electron 工具链的坑

### 1. pnpm 11 拦掉 postinstall → electron 二进制没下载

```
[ERR_PNPM_IGNORED_BUILDS] Ignored build scripts: electron-winstaller@5.4.0
```
`node_modules/electron/dist/electron.exe` 根本不存在。

- 加 `pnpm-workspace.yaml` 的 `allowBuilds: { electron: true, esbuild: true, electron-winstaller: true }` —— **必要但不充分**。
- `pnpm rebuild electron` **无效**（试过）。
- ✅ **有效做法**：设 `ELECTRON_MIRROR=https://npmmirror.com/mirrors/electron/`，然后直接跑
  `node node_modules/electron/install.js`。
  **以后凡是 pnpm 下 electron/esbuild 二进制缺失，都直接跑它自己的 `install.js`，别指望 `pnpm rebuild`。**

### 2. `ELECTRON_RUN_AS_NODE` 会让 Electron 退化成 Node

现象：`TypeError: Cannot read properties of undefined (reading 'setName')`，日志尾部出现 `Node.js v24.x`。

**根因**：DSH 自己在环境里设了 `ELECTRON_RUN_AS_NODE`，子进程继承之后 `electron.exe .` 就是用 Node 跑 `.`。

**修法**：启动前 `Remove-Item Env:ELECTRON_RUN_AS_NODE`（在代码里则是在 spawn 的 env 里 `delete`）。
同一个坑在「用本程序拉起 DSH」时也要处理。

### 3. 单实例锁没释放会让新实例静默退出

`app.requestSingleInstanceLock()` 在前一个实例刚被 `Stop-Process` 时还没释放，
新实例拿到 `false` 立刻退出 —— 表现为 `alive=False` 而且**一句报错都没有**。

**修法**：`Stop-Process` 之后**等 4 秒**再启动。

### 4. 缩放显示器（150%）上的截图全是错的

`GetWindowRect` 把 DWM 阴影算进外侧矩形，`CopyFromScreen` 又按物理像素裁 —— 拍出来像是「右半区被硬切」，
特别容易误判成前端布局 bug（**我误判过一次**）。

正确姿势（`scripts/screenshot.ps1` 里已实现）：
1. **先 `SetProcessDpiAwarenessContext(new IntPtr(-4))`**（per-monitor v2），必须在碰任何窗口/GDI API 之前。
2. 用 `DwmGetWindowAttribute(hwnd, DWMWA_EXTENDED_FRAME_BOUNDS=9, ...)` 取真实可见边框。
3. 优先 `PrintWindow(hwnd, hdc, PW_RENDERFULLCONTENT=2)`。
4. **连抓两帧、用第二帧** —— 第一帧可能是黑的（Chromium 还没重绘）。

但 `PrintWindow` 抓 Electron 的 GPU 合成窗口会**随机丢图层**。
**评审静帧一律走 CDP**：`Page.captureScreenshot`（`scripts/cdp-eval.mjs --shot`），所见即所得。

### 5. PowerShell 里两个致命的字符串/命令问题

- `& npm view x version` 会失败 —— **args 被 PowerShell 啃掉**，要写 `& cmd /c "npm.cmd view x version"`。
- 用 PowerShell 做字符串替换时，**反引号转义 template literal 会失败**。
  → 需要精确改文件就写一次性 Node 脚本（`scripts/patch-*.mjs`），用括号计数或锚点字符串定位。

### 6. JSDoc 里出现 `*/` 会把块注释提前关掉

写了 `operation-*/pnpm.log` 之后，TS 报了一堆 `TS1443 Unterminated regular expression literal` ——
**28 条报错的根因就一个字符序列**。注释里永远不要出现 `*/`。

---

## 四、验证方法论

### 不动用户真实 profile 的验证法

在 `~/.dsh/profiles/` 下建一个**一次性 profile** 跑全流程，测完删掉：

```
C:\Users\YBY\.dsh\profiles\dsh-console-selftest
  ├─ package.json  → { name: "dsh-profile-selftest", dependencies: {}, dsh: { profile: { bundles: [] } } }
```

**每个测试前后都核对真实 profile 没变**（`desktop bundles=18 deps=16`）。
这条规矩救过好几次 —— 尤其是在验证更新/卸载这种会写 `package.json` 的操作时。

### 用 CDP 驱动界面做冒烟测试

应用带 `--remote-debugging-port=9333` 启动，然后 `scripts/cdp-eval.mjs` 在页面里 eval。
好处是可以直接调 `window.dsh.*` 走完整的 IPC 链路，而不是只测纯函数。

几个实际踩到的细节：
- tab 按钮的文案是 `已安装 22`（**带计数**），匹配必须用 `startsWith`，不能用 `===`。
- `OpResult.log` 是 **string**，不是 `OpLogLine` 数组；流式日志走 `EV.op:log` 事件。
- `AppSettings.extraPnpmArgs` 是 **string**（不是 `string[]`）。

---

## 五、网络 / GitHub

- 本机代理 `http://127.0.0.1:65535`。**不设代理时 npm registry 能直连，但 `git ls-remote` 到 github.com 会超时**
  （`Failed to connect to github.com port 443 after 21063 ms`）。所以 git 来源的插件必须配代理。
- `api.github.com` 无 token 只有 60 次/小时，**这台机器的出口 IP 已经被打光过**（`API rate limit exceeded for 203.10.99.66`）。
  → 读远端 `package.json` 改用 **`raw.githubusercontent.com/<owner>/<repo>/<ref>/package.json`**（200，无限制）。
  → 列 tag / 分支改用 **本机 `git ls-remote --symref --refs --heads --tags <url>`**（无限额，还能同时拿到默认分支）。
- `raw.githubusercontent` 的路径拼接：**按 `/` 分段 `encodeURIComponent`，但分支名里的 `/` 必须保留成路径分隔符**。

---

## 六、给后续的自己

- `@deepseek-ai/dsh-plugin-manager/operations` 是**唯一的正规写通道**。任何「自己拼 pnpm + 自己维护 bundles」的想法，
  先回来读第一节第 3、5 条。
- 我们自己的 state 只记**这个工具自己的账**（`<profile>/.dsh-console/state.json`，`disabled` 存的是**被移出 bundles 前的下标**，
  这样「启用」能恢复到底原位）。**patch 层是 DSH 的账，只读不写。**
- 改动前后一定留备份：`<profile>/.dsh-console/backup/`（`package.json`、`pnpm-workspace.yaml`），文件名带毫秒时间戳防同秒覆盖。

---

## 七、版本选择（换版本 / 降级）踩到的两个坑

### 1. 「当前版本」不能用预检结果，必须用**本地已装**版本

`installPreview` 的 `resolvedVersion` 是**远端最新版**。拿它当 VersionPicker 的 `current`，
会把远端最新标成「当前」、把真正已装的旧版标成「降级」——**方向全反**。

正确做法：从已装清单里查真实版本（`state.plugins` 里 `installed && name === 目标包名` 的 `version`）。
查不到就传 `undefined`（让组件自己去 `listPlugins` 兜底）——**传 `null` 会被当成「确实没有这个包」，兜底不会触发**。

### 2. npm 包喂给 picker 的必须是**包名**，不是 profile 里的 spec

profile 的 `dependencies` 里存的是 `"dsh-context": "^0.78.1"`。把 `spec` 字段（`^0.78.1`）当输入传进去，
`parseSpec` 会判成「只有版本号、没有包名」直接失败，面板空着。

规则：
- `sourceKind === 'npm'` → 传 **`rec.name`**；
- `sourceKind === 'git' | 'tarball'` → 传原 spec（`github:owner/repo#ref` 才有标签可挑）；
- `link: | file: | workspace:` → **本地目录没有版本列表，按钮不出现**（别让它点出一个永远空的面板）。

### 3. 顺手修的文案 bug

`install` 分支原来只统计「新增的包」，所以**换版本/降级**会被报成
「安装命令执行成功，但没有检测到新的包（可能本来就装过）」——用户看到的是一次成功操作被说成什么也没发生。

改成同时收集 `swapped`（本来就在、但版本变了的），摘要分三种：
`已安装 X` / `版本已替换：X 旧 → 新` / `安装命令跑完了，但这个包当前就已经是这个版本，没有变化`。

### 4. git 版本列表的额度问题

`api.github.com` 匿名额度在这台机器上已被打光（共享代理出口 IP），
列 tag / 分支必须走本机 `git ls-remote --symref --refs --heads --tags`。
**注意 `--refs` 会把 `ref: refs/heads/X	HEAD` 那行一起滤掉**，所以默认分支要另外补一次 `git ls-remote --symref <url> HEAD`。
上限也要**按类别各算**（80 tag + 80 branch）——dsh-market 有 195 个 tag，合并计数会把 28 个分支全挤没，而挑分支正是主用途。

---

## 八、外观改版（v3 亚克力外壳）踩到的坑

### 1. `backdrop-filter` 这层玻璃，有两件事必须先做对

**(a) 壁纸不能用 `file://` 给渲染层。** dev 下渲染页是 `http://localhost`，`file://` 图片直接被拦；
打包后 `'self'` 对任意目录的 `file://` 也没有可靠语义；而壁纸可能几十兆，走 IPC 转 data URL 会撑爆内存和消息体。
→ 自定义协议 `dshwp://`（`src/main/wallpaperProtocol.ts`），`protocol.registerSchemesAsPrivileged` **必须在 app ready 之前**调，
ready 之后再调就已经晚了 —— Chromium 只在协议注册表初始化时读这一份声明。
协议只开三个入口（`current` / `thumb/<id>` / `files/<rel>`），渲染层永远不需要知道真实文件名。
越界与不存在**都返 404，不区分二者**（否则目录结构就成了探测面）。

**(b) CSP 会静默拦掉一切。** 这次连着踩了两遍：先是 `img-src 'self' data:` 把 GitHub 上的图标全拦掉
（界面安静地回落首字母占位，控制台之外没有任何线索），修完又发现新协议没进白名单。
现在的值是 `img-src 'self' data: https: dshwp:`。
`connect-src` 仍然只有 `'self'` —— **这是有意保留的边界**：渲染层不能发任意网络请求，所有远程取数必须走主进程 IPC。

定位这刀的办法值得复用：**用 `<img>` 和 `fetch` 双路测同一个 URL**。两个都失败但 curl 能过，就是 CSP。

### 2. 透明度要记在「衬底」上，不是「面板」上

主区第一版直接沿用侧边栏的 `--gl-panel-color`（0.52 + 24%），叠在粉色壁纸上之后**描述文字发灰**。
根因不是模糊太重，是**数据落在了模糊层上** —— 违反 §0 第一条硬规则。
改成主区用更实的 `--gl-bed-color`（衬底），模糊只留 60% 强度、饱和 50%。
一句话：**玻璃可以虚，读数不能虚。**

### 3. `margin: a b c 0` 这个简写把 `margin-left` 也写成了 0

主区第二版为了「四周留距」写了 `margin: var(--sb-margin) var(--sb-margin) var(--sb-margin) 0`。
看起来第四位写 0 是「左边不留距、让侧边栏贴上去」，但**侧边栏是 `position: fixed`，根本不参与流式布局** ——
主区于是从 x=0 开始铺，整列插件名被压在玻璃底下，表头直接看不见。
修法是在这个简写**之后**再补一条 `margin-left: calc(var(--sb-w-expanded) + var(--sb-margin) * 2)`。
教训：**用简写覆盖旧值时，被省略方向的那一位是隐患。**

### 4. 同名组件的两条同特异性规则会被拆到不同文件

`.app__main` 原本在 `components.css` 里带 `border-left` 与实色 `background`，
`glass.css` 后加载才能覆盖。所以 `glass.css` 必须在 `main.tsx` 里**最后** import，
并且要显式覆盖 `border-left`（只覆盖 `border` 简写不会生效，因为后者的四个分量优先级更高）。

### 5. 拖拽覆盖层：React 的状态是异步的，探针要 await 一拍

第一版探针 `probe-wpdrop.js` 在派发合成 `dragenter` 之后**同步**读 DOM，得到 `overlay:false`，看起来像功能坏了。
实际是 React 批处理还没提交。`probe-wpdrop2.js` 改成每个阶段 `await requestAnimationFrame` 两帧 + 一点真实延时，
四段流程全部验证通过：

- 拖入非文件内容（`text/plain`）→ **不出现**覆盖层（只认文件，符合预期）
- `dragenter` 带文件 → 出现，`title` = 「松手前先确认这是张图片」
- `dragover` 带文件 → `is-valid`，`title` = 「释放以预览壁纸」
- `dragleave` → 消失
- `drop` → 底部错误条「没拿到这个文件的路径，可能是从别的地方拖过来的虚拟文件。」（**CDP 合成事件拿不到真实文件路径**，所以导入写入链路只能靠人工拖拽验证）

### 6. CDP 合成事件与真实拖拽的差距

`webUtils.getPathForFile()` 对合成 `File` 返回空字符串，所以：
**覆盖层的渲染、有效/无效两态、错误条可以自动化验证；真正的「拖进来 → 导入 → 预览」链路自动化验证不了。**
报告里这条要如实标注为「有代码、有渲染证据、无端到端证据」。

### 7. 设置面板本身已经是玻璃，里面不要再套一层

`appearance-settings.css` 里各分区只用衬底 `--gl-bed-*` 与细边，**一律不用 `backdrop-filter`** ——
在已经模糊过的面板里再模糊一次，除了多花 GPU 什么也得不到，而且会让层级彻底糊掉。

## 九、窗口按钮「看不见」—— 真凶是「画得太淡」，而我第一次测出来的「零墨点」是测量故障

**一句话教训**：这一节记录的不只是 bug，还包括**我自己的一次误诊**：我拿一组错误的像素数据推出「这几个 svg 根本没被光栅化」，被子代理复跑否掉。真凶是旧的 `--fg-1` × 失焦 `opacity:0.82` 合成后只有 4.97:1，加上 10×10 画布与 1.1px 描边。

**现象**：标题栏右上角的最小化 / 最大化 / 关闭三个按钮，用户说「看不见」。

**第一轮排查（全部指向「没问题」）**：
- 几何对：三个 `.titlebar__btn` 在 x 1188 / 1232 / 1276，y 0，w 44，h 37.33。
- 样式对：`opacity: 1`、`visibility: visible`、`display: flex`、`-webkit-app-region: no-drag`。
- 交互对：`document.elementFromPoint(按钮中心)` **命中按钮内部的 `<path>`**，说明没被任何东西盖住。
- 颜色对：计算 `stroke` = `rgb(51, 59, 72)`，`stroke-width` = 1.1px，`stroke-opacity` = 1。

**像素扫描（我第一次的读数 —— 后来被证明是测量故障，见下）**：把 1980×1323 的截图顶部条带（图像 y 0..56）逐像素统计，阈值「比背景深 80」：

| 区域 | 最深像素 | 暗像素数 |
|---|---|---|
| 最小化 (1782,0)-(1848,57) | (209,211,213) | **0** |
| 最大化 (1848,0)-(1914,57) | (209,211,213) | **0** |
| 关闭 (1914,0)-(1980,57) | (210,212,214) | **0** |
| 标题栏背景基准 | (211,213,215) | — |
| 品牌 logo 区域 | — | 722（正常） |

三块区域和纯背景**一个像素都不差**。**「几何在、命中在、样式对」完全不等于「画出来了」。**

**排除法（注入实验，逐个证明那块区域是可画的）**：
1. 标题栏里放三个 `position:fixed` 的 10×10 纯色 div → 红/绿/蓝**全部画出来** ⇒ 没被遮挡。
2. 往关闭按钮**内部** append 一个 10×10 洋红 div → **画出来** ⇒ 按钮内部也可画。
3. `border-top: 2px solid #000` 的纯 CSS 形状 → **画出来**。
4. 把原 svg 用**内联 style** 强制 `stroke:#000; stroke-width:2` → 关闭按钮区出现 **180 个暗像素** —— 但事后核对发现那 180 个墨点来自**同一次实验里另外 append 进去的一个全新 svg**，不是原字形画的。**这一步当时把我带偏了。**

**隔离实验（两个变量分开测）**：同一张截图里，最小化按钮只改宽度（`stroke-width: 3`，颜色不动），最大化按钮只改颜色（`stroke: #000000`，宽度不动 1.1px），计算值都已确认生效。**我这一次测到的是「零墨点」**：

```
最小化: darkest=(209,211,213)  inkPx=0   ← 3px 线宽，零墨点
最大化: darkest=(209,211,213)  inkPx=0   ← 纯黑，零墨点
关闭:   darkest=(210,212,214)  inkPx=0
品牌 logo: inkPx=722 -> OK（证明标题栏本身在正常绘制）
```

我据此写下过一个结论：「不是线太细也不是颜色太浅，是这几个 svg 根本没被光栅化」。

**这个结论是错的。** 子代理 `f509dddb` 原样复跑同一套隔离实验，**墨是在的**：

```
最小化: darkest=(80,86,98)   inkPx=141 -> OK   ← 3px 线宽，墨在（基线 96，加粗后更粗）
最大化: darkest=(38,38,39)   inkPx=154 -> OK   ← 纯黑×0.82 = (38,38,39)，整覆盖
关闭:   darkest=(38,38,39)   inkPx=135 -> OK
```

同帧 dump 确认 `filter: none`、`visibility: visible`、`opacity: 1`。**同一份代码、同一套内联改法，两边结论相反 —— 说明我那一次测的「0 墨点」是我这边的测量故障，不是产品缺陷。**

**真结论：这不是「没画出来」，是「画得太淡」。** 三个因素叠加：

| 因素 | 旧值 | 后果 |
|---|---|---|
| 字形画布 | **10×10**（按钮盒 44×37.33） | 只占按钮中间一小块 |
| 描边宽度 | **1.1 CSS px**（dpr 1.5 = 1.65 设备像素） | 抗锯齿之后只剩中间色 |
| 颜色 × 失焦压暗 | `--fg-1 #333b48` × `.titlebar[data-focused='false']{opacity:0.82}` | 对壁纸底 **painted 4.97:1** |

**机制这条要记住**：`.titlebar[data-focused='false']` 的 `opacity: 0.82` 是**窗口失焦/缩到托盘**时的压暗。用户在托盘状态下回头看一眼，看到的就是「一片浅灰里几乎没有东西」。所以修法要一次动三处：把画布放大到 16×16、把颜色提到 `--fg-0`、把描边挪到 CSS 并加粗到 1.5px（raw 12.20 / painted 7.85）。

**验证（仓库自带检查器，两边 exit=0）**：
```
修复前：最小化 96 / 最大化 154 / 关闭 135，darkest (80,86,98)
修复后：最小化 102 / 最大化 222 / 关闭 166，darkest (54,57,63)
品牌 logo 两图都是 496（同帧绘制对照）
```

**另外那两个「我这次为什么测到 0」的解释（都标未核实，谁先改代码谁是孙子）**：
1. **窗口不是 1320 宽** —— 三个按钮右对齐，窗口若最大化到 1707 CSS 宽就会挪到 x≈1575..1707，而 `inkcheck.py` 的采样盒写死 1188-1320，正好框在空白壁纸上；而品牌 logo 贴左边缘不受宽度影响，所以还剩 722 墨点。**这条能同时解释「三块都空 + 背景近似但不等 + logo 正常」。**
2. 抓到的那一帧整块控件区没进合成帧（同帧 logo 有墨、控件没有），子代理没能复现。

**补充核对（我这边能证的部分）**：上面那张出问题的截图是 **1980×1323 = 1320×882 @ dpr1.5** —— 也就是说**窗口当时确实是 1320 宽**，采样盒 x 1188-1320 本来就是对的位置。所以解释 1（窗口宽度对不上）**对那一张截图不成立**，只剩解释 2。这是我事后才想到核的一条，写在这里免得下次又绕。
（副作用教训：我排查完顺手把 `_t5.png` / `_iso.png` 这些证据图删了，导致现在没法回看那一帧。**排查用的原始截图在被结论覆盖之前不要删。**）

**方法论（这段最值钱）**：

1. **涉及「看不见」的 bug，最后一步一定要落到像素上。** 「几何在、命中在、样式对、计算值对」全都不能证明它**看得见** —— 但反过来，像素为 0 也**不能**单独证明它没画（见下条）。
2. **像素为 0 的第一嫌疑是取样故障，不是产品缺陷。** 检查器 `scripts/inkcheck.py` 因此内置了对照组：按 CSS 坐标 × dpr 换算三个按钮区域，统计「比背景深 80」的像素数，**并用品牌 logo 做对照** —— 如果连 logo 都是 0，先怀疑截图本身（窗口被遮挡时 CDP 会截出空表面）；如果 logo 有墨而按钮没有，先怀疑「采样盒与按钮实际位置对不上」（窗口宽度变化就会这样），**再去改代码**。
3. **一次只动一个变量**，而且**不要在同一次实验里同时注入「参考物」和「被测物」** —— 上面第 4 步就是这么被我读错的（把新 svg 的墨点当成了原字形的）。这条子代理也踩了同一类：它报的「注入新 CSS 后 26/88/113 墨点」不能和「旧包 96/154/135」并列成一组数据，因为前者是注入态、后者是产物态。
4. **两个独立的测量者结论相反时，先找「两次测量的条件差在哪」，别急着选一个信。** 这次真正的分歧点不是代码，是**窗口宽度 / 取帧时机**这两个没被记录下来的环境量。

同类教训还有一条更早的：`--sp-1/2/3/4/6` 从未定义，导致 46 处 `gap`/`padding` 声明被静默丢弃 —— 浏览器对**无效声明不报错**，只当你没写。**所以「改了没效果」要先怀疑「声明被丢了」或「根本没画」，再怀疑「逻辑没跑到」。**

---

## 十、「点退出 DSH，插件台自己也退出了」—— `taskkill /T` 把自己的进程树砍了

**现象**：用户点「退出 DSH」，插件台窗口跟着消失，用户以为「报错了」。而且他自己描述成「点了保存就退出了」—— 因为强杀那一刀比点击迟 2~3.5 秒才落。

**排查路径（这次靠日志，不靠猜）**：

1. 先建诊断设施 `src/main/diagnostics.ts`（`installDiagnostics()` 在 `app.setName` 之后、任何窗口创建之前调用）。它记四件事：启动时的 `pid/ppid/argv` 与**祖先进程链**、`uncaughtException`/`unhandledRejection`、`render-process-gone`/`child-process-gone`（带 reason 与 exitCode）、以及退出路径每一步（`before-quit`/`will-quit`/`window-all-closed`/`quit`）。**关键：用 `appendFileSync` 而不是异步写** —— 进程被 taskkill 砍掉时异步缓冲会丢，我们要的恰恰是「砍之前那一行」。
2. 第一次读日志：**插件台已经不在了，`diag.log` 里没有 `uncaughtException`，也没有退出轨迹** → 不是崩溃，是**被杀**（自己退的一定留下整串 `before-quit → will-quit → quit`，被杀的中途就断了）。
3. 用「计划任务」把插件台从 DSH 的进程树里摘出来启动（`schtasks /create ... cmd.exe /c cd /d <root> && electron.exe .`），日志首行出现祖先进程链：
   ```
   [proc-tree] 45516=electron.exe <- 22716=cmd.exe <- 3848=svchost.exe <- 2192=services.exe <- 2116=wininit.exe
   ```
   父进程是 `cmd.exe → svchost.exe`（计划任务），**不在 DSH 树里**。
4. 在这个前提下，打开设置 → 点保存 → **应用完好存活，日志里连一条异常都没有** → 「保存」这条路径本身不崩。

**真凶**：`src/main/engine/dshproc.ts` 的 `killPids()`：

```ts
const args = force ? ['/PID', String(pid), '/T', '/F'] : ['/PID', String(pid), '/T']
```

`/T` = **连同目标进程的整棵子进程树一起杀**。而开发期插件台是从 DSH 的 shell 里 `Start-Process` 起来的 —— **插件台自己就是 DSH 的后代**。于是「退出 DSH」这一刀顺着树走到了插件台身上，把自己砍了。

**修法**：去掉 `/T`，只按 PID 杀。

```ts
const args = force ? ['/PID', String(pid), '/F'] : ['/PID', String(pid)]
// 双保险：任何情况下都不对自己下手
if (pid === process.pid) continue
```

**为什么去掉 `/T` 也能杀干净**：DSH 的主进程、renderer、gpu、utility 跑的都是**同一个镜像名** `DeepSeek Harness.exe`；`stop()` 的每一刀都是**重新枚举镜像名**再打（现在改成最多两轮强杀），所以 PID 逐个打和整树打的结果一样。而镜像名匹配永远只命中 `DeepSeek Harness.exe`，**不可能命中我们自己**（开发期是 `electron.exe`，打包后是 `DSH 插件台.exe`）。

实测确认枚举是全的：`window.dsh.dshStatus()` 返回 **6 个 pid**，与 `tasklist /FI "IMAGENAME eq DeepSeek Harness.exe"` 完全一致。

同一类隐患在 `src/main/engine/dsh.ts` 的 `killByName()` 里也有一份（`taskkill /IM <exe> /F /T`），一并去掉 `/T` —— `/IM` 已经能命全部同镜像名进程了。

**注意 `src/main/engine/pnpm.ts:202` 那个 `/T` 要留着**：它打的是**我们自己 spawn 出来的 pnpm 进程**，`/T` 用来收掉 pnpm 拉起的 node 子进程，方向是往下打、不会碰到我们自己。

**教训（写给下次的自己）**：

1. **凡是要「杀掉别人」的代码，先问一句「我是不是它的人」**。`/T` 是按树打，树是双向的 —— 你在它的树里，它也在你的刀下。
2. **「谁退出的」这个问题必须能靠日志回答，不能靠猜**。自己退的留全轨迹，被杀的半路断掉，断点就是死点。写日志要用同步写。
3. **用户描述的时序常常是错的**（「点保存就退出」）。第二刀强杀在点击后 2~3.5 秒才落，这 2 秒足够让用户把因果安到中间那次点击上。**先把时序的可能窗口算出来，再对用户的叙述做归因。**
4. **开发期的启动方式会污染判断**：从 DSH 的 shell 里起插件台，等于给自己加了一个有生命周期的祖先。凡是「进程关系相关」的验证，都要先把自己从那个树里摘出来再测。

---

## 任务栏图标一直是 Electron 默认原子图 —— 根因是 explorer 的图标缓存，不是代码

**现象**：打包版装好后，任务栏按钮显示的是 Electron 默认的原子图标，而 exe 内嵌图标、窗口图标都是我们的 logo。Master 从 v0.1.0 一路升到 v0.1.3 都没变过。

**取证顺序（每一步都排除了一个可能）**：

1. `ExtractAssociatedIcon` 掏 `D:\Dowloads\DSH插件台\DSH 插件台\DSHPluginConsole.exe` → **粉发 + 蓝鲸，正确**。exe 内嵌图标没问题。
2. `SendMessage(hwnd, WM_GETICON, ICON_BIG / ICON_SMALL / ICON_SMALL2)` 三个通道全部取回 48×48 / 24×24 的 **logo 本身** → 窗口图标也设上了，`resolveWindowIcon()` + `ready-to-show` 的 `setIcon` 都在正常工作。
3. `resources\resources\icon.ico` 195383 B 在位 → 路径没问题。
4. 三条都排掉之后只剩一个变量：**explorer 侧**。`Stop-Process explorer` → 4 秒后系统自动拉起 → 图标立刻变对。

**结论**：Windows 的任务栏按钮图标**不是每次都重新问窗口**，它按 AppUserModelID 缓存一份在 `%LocalAppData%\Microsoft\Windows\Explorer\iconcache_*.db` 里。我们开发期用 `node_modules\electron\dist\electron.exe` 起同样的 AUMID（`com.yg.dsh-plugin-console`），那一刻缓存进去的是 **electron.exe 的原子图标**；之后换成真 exe、窗口图标再怎么设，缓存命中就还是原子。

**为什么这事只坑开发者的机器**：干净的机器第一次装上去没有旧缓存，直接就显示正确的 logo。只有「先跑过 dev 实例、再装打包版」的机器会中招 —— 也就是我们自己的机器。

**以后遇到同款（图标换了但任务栏没变），不要改代码，先按这个顺序验**：

1. `ExtractAssociatedIcon(exe)` —— exe 里到底是什么
2. `WM_GETICON` 三个通道 —— 窗口设上的是什么
3. 两者都对我们自己的图 → 一定是缓存，跑 `scripts\fix-icon-cache.ps1`

**教训**：**图标链路上有三个不同的宿主（exe 资源 / 窗口 HICON / explorer 缓存），排查必须逐个取证，不能因为「我改了 setIcon」就认定问题在代码里。** 这次差点去改 `setIcon` 的调用时机 —— 那个改动是对的但不解决这个问题，会白改一轮再打包。

---

## 插件市场：卡片没图 + 装任何插件都报「输入里有空格」—— 两条都是我们自己的锅

**Master 报的现象（原话）**：「1.我在插件市场安装的时候图片显示不出来 / 2.然后在插件市场安装某一个插件的时候显示有空格，都有，一个也装不上」。
截图里三个「操作失败」toast，正文清一色是：

```
无法解析来源：输入里有空格，无法识别为包名或仓库地址：
dsh plugin --profile web add dsh-dream-skin（本地路径请加 file:/link: 前缀）
```

### bug 2：目录里的 `install` 字段是一整条命令行，我们把它当 spec 直接传下去了

**取证**：报错文案是我们自己写的 —— `src\main\engine\spec.ts` 里那段「输入里有空格…」；触发点是 `src\renderer\src\components\MarketTab.tsx` 的 `onInstall`：

```ts
const spec = entry.install || entry.npm || entry.name
```

而目录（`dsh-plugin-catalog` 的 `plugins.json`，9111 条）里 `install` 的真实内容长这样：

```
"install": "dsh plugin --profile web add dsh-dream-skin"
"install": "dsh plugin --profile web add github:0xyxy/dsh-maid-atelier-tod"
"install": "dsh plugin --profile web add @smalltailqwq/dsh-client-ui-skin-maid-atelier"
```

**那是目录作者为了在 README 里给人抄的完整命令**，里面那个 `--profile web` 也不是我们的 profile。整串带空格 → 被 spec 解析器挡在门口，**所以「一个也装不上」——所有卡都走这条路**。

**修法**：新增 `src\renderer\src\lib\marketSpec.ts`，一条纯函数 `marketSpecOf(entry)` 做四级降级：

1. `install` 字段 → 正则取 ` add ` 后面那一段（容忍引号，`\s+["'`]?([^\s"'`]+)["'`]?\s*$`）→ **结果里还带空格就返回 null，绝不把坏串交下去**；
2. `npm` 字段；
3. 由 `url` 推 `github:owner/repo`（`/tree/<ref>/<sub>` 形态 → `#<sub>`）；
4. 兜底包名。

`MarketTab.tsx` 里**凡是显示安装命令的地方（卡片按钮、详情按钮、详情「安装 spec」行、确认框）全部改走同一个函数** —— 界面写的必须就是实际传给 pnpm 的。

**验证**：把 `marketSpec.ts` 单独 `tsc` 成 commonjs 跑了真实目录全量 9111 条 → **解析为空 0 条 / 结果仍含空格 0 条**（形态分布 npm 5581 + github 3530）；Master 报错的三条都拿到正确确认框；`dsh-dream-skin`（npm）和 `github:kingcharleslzy-ai/dsh-purge#v1.6.84`（git）都**真装成功**。

**顺手修的文案 bug**：确认框标题原来用 `entry.version`（目录收录时的快照，11.3.0），而实装的是 registry 最新（11.4.1），改成「最新版」。

### bug 1：卡片没图，是图标链覆盖率天生低 —— 加发布者头像兜底

**先把网络排除干净**：渲染层 `new Image()` 打 `raw.githubusercontent.com` 和 `avatars.githubusercontent.com` 都是 200，`HEAD` 当 ref 也能用 → **不是 CSP、不是代理、不是网络**。

**真相在数据里**：目录 9111 条里 `icon` 字段有值的只有 **763 条（8.4%）**，`screenshots` 有值 2132 条（23%）。星标前 12 名里只有 1 条声明了 `icon`；原来的「猜常见路径」链（`ICON_CANDIDATES`）实测只中 4 条，还全是 `dsh-web` 的 `packages/*/icon.svg`。所以**原来的卡有图上限就是 8%，首屏 48 张卡只有 2 张有图**，剩下全是首字母 monogram —— 这就是 Master 看到的「图片显示不出来」。

**修法**：给图标链加第三级 —— 猜不到就取**发布者头像**（`https://github.com/<login>.png?size=96`，302 到 `avatars.githubusercontent.com`，2KB 级的小图，CDN 缓存，不动布局）。

**这里踩了一个设计坑，值得记**：第一版把「猜图标」和「取头像」塞进**同一条并发队列**（上限 24）。结果一屏 48 张卡把 24 个位置全占满，头像**连排都排不进去**，实测屏幕照样整片首字母。改成**两条独立队列**（猜图 `4/24`、头像 `6/240`，`createProbeQueue` 工厂出两份），并让头像与猜图**并行发起**；显示优先级仍是「声明的 icon → 猜到的 → 头像」，头像先垫上、真图标一到就换。

**验证**：首屏 48 张卡 `img 2 / mono 46` → **`img 48 / mono 0`**；滚一屏后 `img 32 / mono 0`；抽查 `naturalWidth` 都是 128/150/192/420/460 的真图；打包前留档 `docs\shots\bugfix-market-0{1,2,3}*.png`。

### 顺带发现：目录里有死条目，而报错方向全错

Master 报错里的第三条 `github:0xyxy/dsh-maid-atelier-tod`：

- `git ls-remote` 走代理 → `remote: Repository not found`（直连 → `Connection was reset`）
- 该条目在目录里 `★ 0 / ↓ —`，从来没人装过 → **是个已删除/改名的仓库**
- 而 app 当时给的文案是「连不上 registry —— **网络或代理的问题**。到设置里测一下代理延迟」→ **方向全错，人会一直去折腾代理**

**修法**：失败分类器里把「仓库不存在」提到网络分支**前面**：

```ts
if (/Repository not found|ERROR: Repository not found|repository .{0,160}not found/i.test(s)) {
  return '这个 GitHub 仓库不存在（可能已改名或删除）—— 目录里的地址会过期，点条目里的「打开仓库」确认一下。'
}
```

### 顺带查清：git 走不走代理（结论：这台机器本来就抖，不是我们没传代理）

受控实验：用 DSH 自带 runtime 在临时目录跑 `pnpm add github:zjy1020/dsh-plugin-console`，四种 env 各一次：

| env | 结果 |
|---|---|
| 无代理 | 34.1s **成功** |
| 只给大写 `HTTP_PROXY/HTTPS_PROXY` | 17.2s **失败**（ECONNRESET） |
| 小写 `http_proxy/https_proxy` + `npm_config_*` | 105.5s **成功** |
| 大小写都给 + `GIT_CONFIG_*` 指 `http.proxy` | 3.5s **失败** |

同一仓库、同一台机器，四种组合两种成功两种失败；`git ls-remote` 对**同一个**仓库直连报 reset、走代理报 Repository not found。**结论：GitHub 的 git 访问在这台机器上时通时断（GFW 抖动 + 代理不稳定），代码侧已经该传的都传了**：`env.ts` 的 `buildChildEnv()` 同时设了大小写 + `npm_config_*` + `NO_PROXY`，`ops.ts` 的 `childEnvFor()` 又把同样的键塞进官方通道的 `options.env`（`{...scrubbedParentEnv(), ...options.env}`，后者覆盖）。

**教训：判断「代理有没有生效」不能看单次结果，得同一命令多跑几轮。**

### 这轮的方法论收获

- **确认框里能直接看出 bug**：bug 2 的真凶是在确认框正文里现形的 —— 「来源 `dsh plugin --profile web add @tt-a1i/archify-dsh`」「命令行等效：`pnpm add dsh plugin --profile web add @tt-a1i/archify-dsh`」。**把「界面写的」和「实际执行的」并排放在一个弹窗里，这类 bug 自己会跳出来。**
- **改工程代码之前，先拿真实数据跑纯函数**：`marketSpec.ts` 是纯函数，单独 `tsc` 出来配 4 行脚本就能把整个目录 9111 条喂一遍，一秒拿到「解析为空 0 / 含空格 0」。比开界面点一百次快得多。
- **数一下「有几张有图」比盯着截图看有用**：`img 2 / mono 46` 这个数字一眼就把「覆盖率问题」和「加载失败问题」分开了（加载失败会是 0/48 或者一半半）。
