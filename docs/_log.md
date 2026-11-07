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

---

## 2026-11-06 第七批①：已装列表 / 搜索结果的简介全是英文

**Master 原话**：「这些简介他们的README没有中文的吗，英文的看不懂，导致不知道这个插件的功能是什么」

### 结论：插件市场目录里 100% 有中文，是我们没接

`C:\Users\YBY\AppData\Roaming\DSH 插件台\catalog.json` 里 **9111 条，`description.zh` 覆盖 9111/9111**。我们三个界面（已装列表行、详情面板、npm 搜索命中）用的却是包自己的 `package.json description` —— 社区插件十有八九写英文。中文一直在磁盘上，从来没读。

**顺手核了一件容易想歪的事**：`capabilities` 字段不是「能力说明」，是权限标签（`fs-write` / `network`）；`capabilityRedLines` 同理。目录里**没有 README**，中文简介就是 `description.zh` 那一行完整句子（不是摘要片段）。

### 索引键：缺一个就大面积漏

拿已装 17 个依赖实测，只靠 `name` 只能命中一部分。**四个键都得建索引**：

| 键 | 例子 |
|---|---|
| `name` | `dsh-context` |
| `npm` 字段 | `dsh-market` ← 装的是 `dshmarket`（名字不一样，靠这列命中） |
| `name` 里 `#` 之后那段（monorepo 子目录） | `dsh-web#packages/dsh-remote-web-ui` ← 装的是 `@linxin666/dsh-remote-web-ui` |
| 各段的**最后一级路径** | `dsh-wallpaper-engine` ← 装的是 `dsh-plugin-wallpaper-engine` |

实测命中 **14/17**；没命中的三个（`dsh-agent2api-hud` / `dsh-purge-community` / `dsh-raccoon-merge`）前两个的 `package.json description` 本来就是中文，第三个根本没有 description 字段（显示 `—`）。

### 落点：在 IPC 出口注释，不塞进 inventory / net

```
ipcMain.handle(CH.plugins, ...)       → catalogZh.annotatePlugins(await inventory.listPlugins(...))
ipcMain.handle(CH.registrySearch, ...) → catalogZh.annotateHits(await net.npmSearch(...))
```

理由：`inventory` 是纯读盘映射，让它去读目录缓存就等于「列个插件列表还要取决于市场页有没有抓过目录」。放在出口，两个引擎模块对这层一无所知。渲染层统一走 `src/renderer/src/lib/desc.ts` 的 `pluginDesc(rec)` = `rec.descZh ?? rec.description`。

**缓存键用 `mtime:size`**，所以市场点「重新拉取」重写 catalog.json 之后自动失效，不需要任何显式清理；读不到 / 文件坏掉一律返回 null（**少一句中文是遗憾，空一行是 bug** —— 界面会平滑退回英文原文）。

### 详情面板里那行「原文（英文）」

目录的中文有时是 README 首段（`dsh-plugin-wallpaper-engine` 那条以「前置要求：…」开头），不是概述。所以详情面板在「中文是目录补的、且原文和中文不一样」时，多渲染一行小字标出原文 —— 用户想核对作者原话时对得上，也不会以为这是作者写的中文。

**配色踩了一脚**：第一版给了 `--fg-3`，实测是 `#4a5260` = 这张 token 表的**「禁用文字」**档，对深色衬底只有约 2.2:1，一整句英文读起来费劲。改 `--fg-2`（`#6d7788`，「弱化文字 / 元信息」那一档，约 3.8:1）。**教训：`--fg-*` 是按语义分的，不是按「越往后越淡」排的 —— 拿禁用档写正文，视觉上是「这块坏了」。**

### 验证

- 已装列表 **17 行 → 16 行中文**（第 17 行本来就没有 description）；`node scripts/cdp-eval.mjs --file scripts/_probe-zh-desc.js`
- 详情面板：`dsh-context` 出中文简介（108 字）+ 原文行（3 行，`overflowsX 0`）
- npm 搜索：`window.dsh.registrySearch('dsh-context', 4)` → 3 条有中文、`dsh-context-milvus-core` 目录里没有 → 正确退回 null
- 截图 `docs\shots\bugfix-zh-desc-01.png`

---

## 2026-11-06 第七批②③：README 截图预览「很小而且很偏」+ 给插件台加 DSH 字体功能

### ② 截图预览：两个齿轮同时空转

- **量宿主矩形量错了对象**：`PluginGallery` 原来用 `rootRef.current?.closest('.detail')` 找宿主面板量尺寸，而**市场详情页的外壳不是 `.detail`**（是 `.mkt__sheet`）——`closest` 返回 null，于是退化成量 `.gal` 自己（653x243）；同时 `gallery.css` 里 `.detail .gal-preview { inset:0 !important }` 那条特例也只对 `.detail` 生效。两个齿轮一起空转，1440x810 的截图被压成 **173x97**。
- **改成整窗灯箱**：删掉 measure / rect / resize·scroll 重算整套逻辑，`.gal-preview` 直接 `position:fixed; inset:0`。**必须 `createPortal` 到 `document.body`** —— `.app__main.shell-main` 上有 `backdrop-filter`，它会成为 `position:fixed` 的包含块，留在原地的话「整窗」只等于「主区」，还会被 `overflow:hidden` 裁掉一个角。
- 实测：`layerRect [731,427,653,134] → [0,0,1320,882]`；`stageRect` 高 `16 → 698`。

### ② 又一层：README 里的「截图」常常不是截图

`hindsight` 的 README 里 6 张图，前 5 张是赞助商横幅（1040x238 / 1913x464 / 1280x511，宽高比 4.1–4.4）。加了三层筛：装饰图关键词（sponsor|badge|logo|banner|shield|…）→ 截图路径优先排序 → 下载后按宽高比（>3.2:1 或 <0.42:1）丢。

**再补一层尺寸筛（短边 < 280px）**：图标 / logo 是 180x180、256x256 这种，宽高比正常所以前一层的筛子放它们过去，但一眼就知道不是界面截图。**这里有个反直觉的连锁反应值得记**：原来的「第一张永远保底」规则会救回一张 180x180 的 logo，放大 4 倍只是个更大的糊块。所以补了一条 —— 如果**幸存的那一张本身就是小图**，判成「这个来源没有截图」，返回空让调用方去下一级来源（包内 README → 目录截图）。实测 `hindsight`：npm readme 那级全是图标 → 落到 GitHub raw README.md → 拿到 **4 张真截图（6755x3097 / 1708x878 / 1080x388 / 1080x787）**。

**灯箱的放大策略也改了**：原来是「绝不放大超过天然尺寸」，理由是「硬拉只会是一格更大的糊块」—— 道理没错，但**用户的抱怨是「很小」**，180x180 在 1213x698 的舞台上就是一枚邮票。现在铺满舞台 + 上限 `UPSCALE_MAX = 4` 倍（地板 320px，免得极小的图被放大成噪点），并且**把真实尺寸写在说明行里**（`6755 × 3097  Overview`）—— 放大可以，但不能让用户以为原图就这分辨率。

### ③ DSH 字体功能：接线文档与代码不一致 → 白屏

- 调研结论（详见 `docs\ref-font-injection.md`）：**路径 A** = 写 profile 的 `cordis.patch.yml` 里 `- id: ui-theme` 条目 `config` 的 `textFontFamily / codeFontFamily / terminalFontFamily` 三个键。DSH 侧这三个键是 `volatile()`（热改，不用重启），`dsh-hmr` 监听 patch 文件，所以落盘后**几秒内 DSH 自己的界面就换字体**。这条路不碰渲染进程注入，也不碰安装目录。
- **炸出的真 bug**：子代理交稿时 `tsc` 双绿、`electron-vite build` EXIT=0，但**界面全白**（`#root` 一个子节点都没有）。它的接线文档写「方法名必须是 readFonts / writeFonts / **systemFonts**」，而它自己的 `FontsApi` 接口第三个方法叫 **`listSystemFonts`** —— 我按文档接的 preload，面板调 `api.listSystemFonts()` 当场抛 `TypeError`，异常在 `useEffect` 里、没有 try/catch，**把整棵 React 树带崩**。
- **教训一：接线文档是别人的话，代码才是事实。** 交稿后必须真启动一次，`tsc` 过不算数（两边都是 `any` / 结构兼容时它查不出来）。
- **教训二：白屏类问题的第一件事是抓异常，不是看 DOM。** DOM 是空的，什么线索都没有。为此写了 `scripts\cdp-errors.mjs`（附加 CDP → `Runtime.enable` + `Log.enable` → `Page.reload` → 打印 `Runtime.exceptionThrown` / `console.error` / `Log.entryAdded`），一跑就抓到那行 `TypeError`。
- 修法：契约方法名统一成 `listSystemFonts`（channel 名 `api:fonts-system` 不动），并在那段 `useEffect` 外面包 try/catch + 注释写明为什么。

### 字体功能的实机验证（在一次性 profile 上做，不动 desktop）

复了 `desktop` 的 `cordis.patch.yml` 成 `dsh-font-selftest`（`dependencies:{}` + `bundles:[]`），把 `settings.json` 的 `defaultProfile` 指过去，测完还原并删除。**绝不在用户的真 profile 上做写操作** —— 这条从第一轮验收沿用至今，一次都没破例。

- 读取：`已读到 270 个系统字体（注册表）`（走 `reg.exe query`，不 spawn PowerShell）
- 选字体 → 预览 → 应用：`textFontFamily：SimSun & NSimSun（新增）` → 落盘后 ui-theme 块里**只多一行**，别的条目零改动（`Compare-Object` 只差这一行 + 我故意加的外部标记行）
- **并发冲突保护**：趁面板开着，从外部往文件里追加一行，再点「应用」→ 被拦下：`DSH 刚刚改过这个文件，插件台没有硬写。已重新读取文件，你选的字体还在，再点一次「应用」就会写进去。`，并且**第二次点真的写进去了** —— 这里我顺手改掉了子代理的一个逻辑不一致：它原来说「已重新读取，请再点一次」但重新读取会把草稿对齐到磁盘（用户选的字体被冲掉），于是「再点一次」其实无事可做。给 `load()` 加了 `keepDraft` 参数，只在冲突路径上传 true。
- 恢复默认：两段确认（`恢复默认` → `确认恢复默认`），三个键被精确删掉，文件其余部分逐字节不变（除我加的标记行）。
- 备份：每次写入前 `<profileDir>/.dsh-console/backup/cordis.patch.yml.<ISO>`，实测两次写入两份备份，大小都等于原文件。

### 又一个探针坑：合成键盘事件测不出「Esc 分层关闭」

我一开始用 `document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }))` 测「Esc 只关灯箱不关详情页」，结论是**详情页也被关掉了** —— 差点当成 bug 去改代码。真因是：合成事件是从 `document` 直接派发的，**不经过焦点元素**，React 挂在 `#root` 上的委托监听收不到，而挂在 `document` 上的监听又会误收。

改用 CDP 的 `Input.dispatchKeyEvent` 发真键（新工具 `scripts\cdp-key.mjs`）之后，行为完全正确：**Esc 第一次只关灯箱、焦点回缩略图；第二次才关详情页、焦点回卡片**。**教训：测键盘交互别用合成事件，要么走 CDP Input，要么用真实的 keydown 派发到焦点元素上。**

### 顺手修的小文案

`FontPanel` 里「档里已有（第 N 行）/ 档里没有」的「档」太内部化，改成「补丁里已有（第 N 行）/ 补丁里没有」—— 用户看到的文件名是 `cordis.patch.yml`，界面上就该说「补丁」。


---

## 2026-11-06 第七批补：字体名乱码 + 字体面板贴边（Master 两条）

### ① 字体名里一堆问号方块 —— `reg.exe` 的输出编码看「有没有控制台」

现象：字体选择器里有一条 `?,????? Medium`，而 `Arial` 之类的英文名完全正常 —— 所以第一眼像是「个别字体坏了」。

取证（同一个 exe、同一台机器、同一份注册表，两次结果不同）：

| 从哪跑 | utf8 解的坏字符(U+FFFD) | gbk 解的坏字符 |
|---|---|---|
| pwsh 里的 node | 0 | 72 |
| Electron 主进程（GUI，无控制台） | **88** | **0** |

原因是 `reg.exe` 的 stdout 跟随**控制台输出代码页**：有控制台（pwsh，CP 936 且被测出是 UTF-8 行为）和没有控制台（Electron GUI 子进程）吐出的字节不一样。`src/main/engine/fonts.ts` 原来写死 `encoding: 'utf8'`，于是 `思源黑体` 被解成 4 个 U+FFFD（U+FFFD 在多数字体里渲染成方框/问号，正是用户看到的样子）。

修法（`fonts.ts` 新增 `decodeConsoleText(buf, exe)`）：拿 buffer 自己解 —— 先按系统 OEM 代码页（`HKLM\SYSTEM\CurrentControlSet\Control\Nls\CodePage` 的 `OEMCP`，936→gbk / 950→big5 / 932→shift_jis / 949→euc-kr …，结果缓存），再用「U+FFFD 个数」在 `[oem, utf8, gbk, big5, shift_jis, euc-kr]` 里投票选最干净的那个，全都不干净才退到 latin1（无损字节映射，至少不丢字符）。不引第三方库，用 Node/Electron 自带 ICU 的 TextDecoder。

实测：改前 274 条里 11 条带 U+FFFD，改后 **0 条**；`华文中宋` / `华文彩云` / `思源黑体 Medium` 全部正确，搜「黑体」能搜到。

**教训**：Windows 命令行工具的输出编码不能靠「我在终端里看是好的」定论 —— **同一个进程有没有控制台会改变它吐什么字节**。凡是 GUI 进程里 spawn 出来的 Windows 自带工具（reg / wmic / ipconfig / net …），一律拿 buffer 自己解 + 用坏字符数投票。

### ② 字体面板太靠左 —— 整页视图的三笔账得自己认领

`.app__view` 是 **0 padding 的 flex 容器**，内边距/滚动/撑满宽度都由各个视图自己带（`.install`、`.logdrawer` 都带了）。字体面板第一版只写了 `display:flex; flex-direction:column`，漏了三条，后果：宽度停在内容宽度（实测 795px，而 view 是 1041px）、贴着侧边栏零间距、没有滚动容器。

修法（`font-panel.css` 的 `.fp`）：补 `flex: 1 1 auto` + `min-height: 0` + `overflow-y: auto` + `padding: var(--sp-5) var(--sp-4) var(--sp-6)`。横向取 16px 是为了和上方 subbar 的 tab 左右对齐（实测内容左边界 x=285 = 269+16，与 tab 一致）。

**教训**：这是这个项目第三次被同一类「简写/缺省」咬到（前两次是 `margin: t r b 0` 把 margin-left 写成 0、`--sp-*` 变量缺失导致 padding 静默失效）。新加一个整页视图时，先照抄 `.install` 的那四条（flex / min-height / overflow / padding），别从零写。

### 2026-11-06 第七批补②：字体列表「找不到我的字体、只显示前 60 个」

用户报了两条（附一张 `CaskaydiaCove Nerd Font` 的截图）：**①我明明有这个字体，为什么列表里找不到？②怎么只显示前 60 个？我想看到电脑上有的字体。**

#### ① 「找不到」的真根因：我们列的是注册表值名，那不是 CSS 家族名

`fonts.ts` 原来读 `HKLM/HKCU\...\Fonts`，把**注册表值名**当成字体名交给界面。值名是「安装时的全名」，一般带字重 / 字形后缀：

```
CaskaydiaMono NF Bold Italic (TrueType)      <- 注册表值名（旧代码列的）
CaskaydiaMono NFM SemiBold (TrueType)
CaskaydiaMono NFP ExtraLight (TrueType)
```

而**CSS 只认家族名**。用 canvas 量宽 + 和「不存在的家族」对比实测（`scripts/_probe-cssfamily.js`）：

| 写进 font-family | 命中 |
|---|---|
| `CaskaydiaMono NF` | ✅ |
| `CaskaydiaMono Nerd Font` | ✅ |
| `CaskaydiaMono Nerd Font Mono` / `Propo` | ✅ |
| `CaskaydiaMono NF Bold Italic` | ❌（等于写了个不存在的字体） |

所以旧列表里 274 条**大半选了也没用**，而且注册表值名里**根本没有「Nerd」这个词** —— 用户搜「Nerd」「CaskaydiaCove」一律 0 条命中。这就是「我明明有这个字体却找不到」。

修法：新增 `readFontFamilyNames(file)` —— 直接解析字体文件的 `name` 表（只读文件头 + 表目录 + name 表三小段，几 KB）。取名规则：

1. **有 nameID 16（Typographic Family）就用 16，完全不看 nameID 1**。16 是「一个字体家族」的名字，把 Bold/Italic 这些字重收敛掉；1 是每个字重各自的 legacy 家族（`CaskaydiaMono NFM SemiBold`…），放进来就是噪音。没有 16 的老字体（Arial、宋体）才退回 1。
2. **英文名 + 中文名都给**（0x0409 / 0x0804）。第一版只取英文名，结果中文名全没了（`cjkCount: 0`）—— 中文系统上用户找的是「微软雅黑」「思源黑体」，只给英文名等于把一半字体藏起来。两个名字 CSS 都能命中，所以是两条并列条目。
3. 读不到文件的（274 条里 12 条，多为 `.fon` 位图字体）退回注册表值名。

实测：**274 条注册表项 → 143 个家族**（中文名 23 个），耗时 **57ms**，进程内缓存 10 分钟不变。`CaskaydiaMono Nerd Font` / `… Mono` / `… Propo` / `MartianMono Nerd Font` 等 6 个 Nerd Font 家族全部出现，搜「nerd」6 条、搜「cask」3 条。

参数：`decodeNameString` 里 **platform 0/3 是大端 UTF-16** —— Node 只有 `utf16le`，所以要先 `Buffer.swap16()` 再解（我第一版直接 `toString('utf16le')`，解出来是「䌀愀猀欀…」这种鬼东西，一眼就知道字节序错了）。TTC 集合要先读 `ttcf` 头取第一个字体的偏移。

#### ② 「只显示前 60 个」：上限本来就该按「装得下」给

`FontPanel.tsx` 的 `LIST_LIMIT = 60`，多出来的只在计数行写「显示前 60 / 匹配 274 个，继续输入缩小范围」。用户要的是**看见本机有什么**，不是被催着打字。改成 `600`（够装下任何一台普通机器），`.fpick__list` 的 `max-height` 232px → 340px。实测 143 条全部渲染、盒子 340px、scrollHeight 3825（可滚）。

#### ③ 顺带查清：这台机器上**没有** `CaskaydiaCove Nerd Font`

- 注册表：HKLM 217 条 + HKCU 56 条，含 `Cove` 的 **0 条**（含 `Nerd` 的 54 条，全是 CaskaydiaMono / MartianMono）。
- 磁盘：`C:\Windows\Fonts` + `%LOCALAPPDATA%\Microsoft\Windows\Fonts` 里 `*Cask*` 只有 36 个 `CaskaydiaMonoNerdFont*`；`Downloads` / `Documents` / `Desktop` 递归三代 **0 个** Caskaydia 文件（连压缩包都没有）。
- 家族名层面（新解析出来的 143 个）里匹配 `cove` 的结果为空。

结论：用户手上是 **CaskaydiaMono** Nerd Font（+ MartianMono Nerd Font），`CaskaydiaCove Nerd Font` 是另一个家族（字形比例版），他截图里那个大概是网页 / README 上的字体展示。要装的话得从 nerd-fonts 的 release 下 `CaskaydiaCove.zip` 再装。

**教训**：**「系统里有哪些字体」这件事，注册表给的是「安装记录」，字体文件才给「CSS 能用的名字」**。凡是把系统信息交给 CSS / 渲染层用的地方，都要拿渲染层真能匹配的标识（家族名），而不是安装记录里的显示名 —— 这类错会表现成「列表里全是选了没反应的东西」，用户只会说「找不到我的字体」。验证手段也很简单：**canvas 量同一串字的宽度，和不存在的家族对比**，比读文档猜靠谱。

## 2026-11-07 第八批：清单导入「明明装上了却报安装失败」（Master 在朋友机器上遇到的）

用户原话（m12166）：「我在我朋友电脑上安装了之后，我把我的清单导入给他安装一下，他那里一直显示安装失败，但是还是安装上了呀，我看日志一直显示安装失败，vpn也配置了」

### ① 真凶：pnpm 因为「不批准构建脚本」退出 1，包其实装上了 —— 我们只看退出码

复现（一次性 profile，手工造一份带构建脚本依赖的树）：

```
$ pnpm add dsh-music-player@1.0.3
dependencies:
+ dsh-music-player 1.0.3          ← 明明装上了
[ERR_PNPM_IGNORED_BUILDS] Ignored build scripts: cloudflared@0.7.3, …
Run "pnpm approve-builds" to pick which dependencies should be allowed to run scripts.
$ echo $LASTEXITCODE
1                                 ← 我们拿这个判成败
```

pnpm 11 的 `strictDepBuilds` 默认开着：**只要树里有「带构建脚本但没被批准」的依赖，就报错并以退出码 1 结束**，而依赖图其实已经写好了。这个状态还会**传染** —— 之后每一次 pnpm 操作都复现，所以用户看到的是「一直显示安装失败」。

修法分三层：

1. **判成败不看退出码，看磁盘**。新增 `installedOnDisk(profileDir, name)`（唯一判据 = `node_modules/<name>/package.json` 在不在）。
   - 批量装非零 → 先逐个查磁盘，全都已落盘就记一条「命令退出码是 N，但清单里的 M 个包都已经在磁盘上了 —— 按实际状态算成功」并**跳过逐个降级重装**（原逻辑会为这 15 个包再跑 15 次 pnpm，白等 10 分钟）。
   - 逐个装非零 → 同样先查磁盘，落盘即算成功；第 7 步 `after.has(name)` 判空时用磁盘兜底。
   - `opInstall` / `opUpdate` 也照这个来（更新用「版本真的变了」当判据）。
2. **自愈：写 `strictDepBuilds: false` 重试一次**（`profileYaml.ensureStrictDepBuildsOff`）。写进 profile 的 `pnpm-workspace.yaml` 之后，同样的安装变成：
   ```
   Ignored build scripts: cloudflared@0.7.3.
   Done in 672ms using pnpm v11.28.5      ← 退出码 0
   ```
   **脚本依然不会被执行**（只是不再当成错误），安全性没变。
   反例（都无效，别浪费时间）：单写 `ignoredBuiltDependencies: [包名]` 无效；`<profile>/.npmrc` 里 `strict-dep-builds=false` 无效。
3. **部分成功不该显示成「操作失败」**：`OpResult` 加 `partial?: boolean`，store 里 `toast('warn', '部分完成', …)`。原来的文案是「0 个装好，15 个失败」，实际 11 个装好了 —— 这种谎比不报还糟。

复测（一次性 profile，15 条清单）：**改前 `清单导入：0 个装好，15 个失败` → 改后 `清单导入：11 个装好，4 个失败` + `partial: true`**，日志里能看到自愈真的触发。

### ② 顺手捞出来的第二类失败：profile 缺 DSH 的 pnpm 基线

那一轮 4 个真失败里有 3 个是 `ERR_PNPM_NO_MATCHING_VERSION`：`@smalltailqwq/dsh-client-ui-skin-maid-atelier` 要 `@deepseek-ai/dsh@>=0.2.2 <0.3.0`、`dsh-better-sidebar` 要 `dsh-client-ui-conversation@>=0.2.2 <0.3.0-0`、`wallpaper-engine` 要 `dsh-client-ui-slots@>=0.2.0 <0.3.0-0`。

- 两个 registry 实测：`@deepseek-ai/dsh-*` 的 **0.2.x 稳定版数量 = 0**（各 15 个全是 rc/alpha，`dist-tags.latest` 还停在 `0.0.1-rc.1`）→ semver 区间不含预发布版，**范围本身无解**，不是镜像问题。
- 但本机三个 profile 的 `pnpm-workspace.yaml` 都带着：

  ```yaml
  packages: ['.']
  nodeLinker: hoisted
  autoInstallPeers: false
  ```

  这是 DSH 自己写的基线。**`autoInstallPeers: false` 一关，pnpm 就不会去给 peer 找正式版** —— 那三个包立刻都能装（实测 `dsh-better-sidebar 0.30.1` / `dsh-plugin-wallpaper-engine 1.4.2` / `dsh-client-ui-skin-maid-atelier 0.1.9` 全 exit 0）。

所以 `ops.ts` 里加了 `ensurePnpmBaseline(ctx, hooks)`（5 处调用点），用 `profileYaml.ensurePnpmBaseline` **只补缺的键**，DSH / 用户写过的值一律不动。全新 profile 上实测输出：「profile 缺 DSH 的 pnpm 基线配置，已补上：nodeLinker: hoisted、autoInstallPeers: false」。

**注意**：这三个包在「全新 profile」上失败，本来就不是用户的错，也不是我们写错了什么 —— 是我们的工具在一个 DSH 还没初始化过的 profile 上跑，少了 DSH 自己会写的那两行。**替用户补基线，比给一句「版本不存在」的报错强。**

### 全新 profile 端到端复测（模拟朋友那台机器）

把一次性 profile 复位成 `{"dependencies":{}}` + `pnpm-workspace.yaml` 只有一行 `packages: ['.']`，再导 15 条清单：

- **`清单导入：13 个装好，2 个失败` + `partial: true`**（改前是「0 个装好，15 个失败」）。
- 13 条 npm 全进，包括之前「必然失败」的那三个。
- 2 个失败是**真的连不上 GitHub**：`Recv failure: Connection was reset` / `Could not connect to github.com port 443 after 21062 ms` —— git 来源的包在这台机器上本来就在抖（第七批实验表里记过），文案也如实说「连不上 registry —— 网络或代理的问题」。
- bundle 加载列表进了 12 条。

`pnpm-workspace.yaml` 最终态（我们的两处自愈都写进去了）：

```yaml
packages: ['.']
nodeLinker: hoisted
autoInstallPeers: false
strictDepBuilds: false
```

### 教训

1. **pnpm 的退出码不等于「装没装上」**。11 的反供应链策略会拿非零退出码表达「我不想执行你的构建脚本」，而依赖树已经落地。凡是要判成败的地方，判据得是**磁盘上的事实**（`node_modules/<name>/package.json`），退出码只能当参考。
2. **失败文案说错方向比不说更费用户时间**。这一轮里三条原始文案都在带偏：假的「安装失败」、git 失败被说成「网络或代理的问题」（有时真因是仓库不存在，`Repository not found` 分支是前一轮加的）、`NO_MATCHING_VERSION` 被说成「版本号写错了」（真因是 DSH 运行时只有预发布版）。**每次给用户一句归因，都要先问自己：这句话把他推向哪个动作？推错方向就是负价值。**
3. **「全新机器」要专门造**：把 profile 复位成 `dependencies: {}`、`pnpm-workspace.yaml` 只剩一行，才是用户朋友那台机器。在自己的老 profile 上测，基线早就齐了，什么都测不出来。
4. **Toast 会自动消失，轮询会漏**。等一个可能只活 5 秒的 Toast，正确姿势是**先装一个 `MutationObserver` 记录器**（`scripts/_toast-watch.js`），再触发操作，最后读记录 —— 用 `setInterval` 轮询去抓等于赌运气。
