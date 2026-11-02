# DSH 插件台 · 项目报告总索引

> 一句话：给 DeepSeek Harness 做一个**能装、能卸、能升能降、能看市场**的桌面插件管理器，
> 外壳是亚克力悬浮面板，底座是 Electron + React，写操作全部走 DSH 官方的
> `@deepseek-ai/dsh-plugin-manager/operations` 库层。
>
> 本目录是七个子代理分章写出来的完整技术报告，这份 README 是主控写的总索引与勘误。
> 最后同步时间：**2026-11-02 14:35 (+08:00)**。

---

## 1. 先看什么

| 你想知道 | 去看 |
| --- | --- |
| 这东西到底能干什么、有没有漏需求 | [01-产品与功能.md](01-产品与功能.md) |
| 代码怎么分层、契约怎么冻结、一次安装到底做了什么 | [02-架构与实现.md](02-架构与实现.md) |
| DSH 的插件到底是什么、为什么不能直接调 `dsh plugin` | [03-DSH插件机制与官方通道.md](03-DSH插件机制与官方通道.md) |
| 亚克力外壳怎么调出来的、设计纲领逐条落地了吗 | [04-外观系统与设计落地.md](04-外观系统与设计落地.md) |
| 踩过哪些坑，同类项目可以少走哪几步 | [05-踩坑与工程经验.md](05-踩坑与工程经验.md) |
| 哪些功能真的验过、哪些只有代码没有证据 | [06-测试验收与截图索引.md](06-测试验收与截图索引.md) |
| 打包成 exe 要准备什么、现在卡在哪 | [07-打包与交付.md](07-打包与交付.md) |

**证据等级约定**（七章统一）：每条结论后面跟 `路径:行号` 或真实命令输出。
找不到出处的，正文写「未核实」而不是猜 —— 02 章第 12 节集中列了 32 条未核实项，
06 章第 4 节列了 5 类缺口。**这两节比正文更值得先读。**

---

## 2. 七章速览

| 章 | 行数 | 体积 | 一句话内容 |
| --- | --- | --- | --- |
| 01 产品与功能 | 552 | 55 KB | 定位 + 信息架构 + 六批需求逐条对照 + 10 条用户链路 + 边界缺口 |
| 02 架构与实现 | 1309 | 198 KB | 三层架构 + 冻结契约 v1→v5 + 23 个 engine 模块导出签名 + 一次写操作的 24 步生命周期 |
| 03 DSH 插件机制 | 663 | 58 KB | profile 两套账 + `dsh.bundle.patch` 唯一判据 + 官方 `reconcile()` 逐行算法 + pnpm 11 三个钉子 |
| 04 外观系统 | 965 | 142 KB | design-brief / ref-notes / design-v3 三份设计文档 + token 与玻璃层 + 六个渲染组件 + 四轮实机迭代 |
| 05 踩坑与工程经验 | 438 | 59 KB | Windows+Electron / CDP 截图 / 前端性能 / 工程方法 四组坑，每条「现象→根因→修法→验证」 |
| 06 测试验收与截图索引 | 609 | 68 KB | 69 张截图逐张列尺寸 + 78 个探针脚本索引 + 17 个功能域 36 张用例表 + 缺口清单 |
| 07 打包与交付 | 542 | 47 KB | 构建配置 + 图标资产管线 + 任务栏图标 A/B 结论 + 运行时资源路径三套语义 |

配套的设计与调研文档在上一层 `docs/`：

| 文件 | 体积 | 内容 |
| --- | --- | --- |
| `docs/design-brief.md` | 10 KB | 我给设计主管的任务书（含 5 类 AI 生成设计特征黑名单） |
| `docs/design-v3.md` | 104 KB | 外观设计纲领（§0 三条硬规则 → §6 黑名单自查 + §6.7 十四项待校准） |
| `docs/ref-notes.md` | 113 KB | WinUI / Apple HIG / WCAG 2.2 一手资料取证，30 个一手来源 |
| `docs/market-parity.md` | 51 KB | 对标 dshmarket 的逆向结论（**注意：其中「只走 CLI」一条在 desktop profile 上不成立，见 03 章**） |
| `docs/_log.md` | 20 KB | 战斗卡：按时间顺序记的踩坑，八节 |

---

## 3. 六个最值得记住的硬结论

1. **`dsh plugin --profile desktop` 是死路。** `bin.js` 的 `rejectElectronProfile()` 会直接拒掉
   desktop，理由是「由 Electron 应用独占管理」。本项目因此下沉到库层，直接复用
   `@deepseek-ai/dsh-plugin-manager/operations` 的 `runProfilePnpm` / `reconcile` / `withFileLock`。
2. **判定「一个包是不是加载层」的唯一判据是包内 `dsh.bundle.patch !== undefined`。**
   不是 `dsh` 字段，不是包名，也不是「在 node_modules 里」。拿错判据会把纯依赖塞进加载列表，
   后果是 profile 直接坏掉。
3. **profile 是两套账**：`dependencies` 16 个、`dsh.profile.bundles` 18 个、并集 22 个。
   只在 deps 里的 4 个包**全部声明了 `dsh.bundle.patch`**，它们不是「不是插件」，
   而是被 `cordis.patch.yml` 的 `disabled: true` 按住了。清单数据源必须是 **deps ∪ bundles**。
4. **pnpm 11 有三个钉子**：①默认拦构建脚本，electron 二进制根本不会下载 ②供应链冷却会把
   `@latest` 悄悄压回旧版（`dsh-context` 远端 0.79.0 装成 0.78.2）③git 包的 prepare 脚本会被拦，
   报错要求手写一条带完整 codeload URL 的精确 key。三条都有自愈路径，写在 `profileYaml.ts`。
5. **注入 `ELECTRON_RUN_AS_NODE` 会让 `electron.exe .` 退化成 Node**，症状是一个莫名其妙的
   `TypeError: Cannot read properties of undefined (reading 'setName')`，日志尾部还会打
   `Node.js v24.22.1`。启动前必须 `Remove-Item Env:ELECTRON_RUN_AS_NODE`，并且 `Stop-Process`
   之后要**等 4~5 秒**，否则旧实例的单实例锁没释放，新实例静默退出且不报任何错。
6. **CSP 会静默拦掉一切。** 同一个坑踩了两遍：先 `img-src 'self' data:` 拦掉 GitHub 图标，
   再新加的 `dshwp:` 协议没进白名单。定位办法是**用 `<img>` 与 `fetch` 双路测同一个 URL** ——
   两个都失败但 curl 能过，就是 CSP。`connect-src` 至今锁 `'self'`，所以**任何远程取数必须走主进程 IPC**，
   这是有意保留的边界，不是遗漏。

---

## 4. 勘误：任务书与实测不一致的地方

子代理没有照抄我给的数字，而是自己复核后按实测写，这一点做得对。汇总于此：

| 我原先说 | 实测 | 出处 |
| --- | --- | --- |
| engine 有 21 个 `.ts` | **23 个** | 02 章 §5 / §12.1 |
| `AppSettings` 外观段新增 22 个字段 | **21 个**（`AppSettings` 共 31 字段） | 02 章 §3.6 / §12.1 |
| `patch.ts` 里有 patch 停用的变体匹配 | 在 **`inventory.ts:246-259`**，`patch.ts` 没有 | 02 章 §12.1 |
| 确认弹窗是 `pendingConfirm` 队列 | 是**单槽位** `confirm` + `confirmBusy` + 抢占 | 02 章 §12.1 |
| 第六批是「14 节」设计纲领 | `design-v3.md` 顶层实为 **§0–§6 + 附录共 7 节**；「14」是 §6.7 待校准项的条数 | 01 章 |
| 按仓库地址猜图命中率约 2% | 落盘值是 `docs/_guess2.json` 的 `hitRate:"0/12"`，**2% 这个数没有出处** | 01 章 |
| 「PNG 被 Windows 忽略」 | 准确说法：PNG 只能提供**单帧**，`ICON_BIG`/`ICON_SMALL2` 都被撑成 512×512；只有多帧 `.ico` 才按 16/24/32/48 供给 | 05 章 |
| 导出按钮 title 写「16 个」但实际导出 12 | **已经不成立** —— 那张对照截图滞后于代码，运行实例实测 title 就是「12 个」 | 06 章 §4.4 勘误 |
| `data-contrast` / `data-motion` 有降级块 | **零个选择器消费**（App.tsx 写了根属性，CSS 没人读）→ 已在本轮修掉 | 04 章 §2.2 |

另外 07 章自己挖出一个我完全没意识到的 Electron 行为：
**`nativeImage.getSize()` 对任何 `.ico` 恒报 256×256**（`tray.ico` 最大帧只有 32 也照报），
所以判断「这张图到底有没有加载成功」必须用 `isEmpty()`，不能看尺寸。

---

## 5. 本轮补掉的一条真缺口：外观设置终于落到像素上

04 章复核时揪出三类「设置面板是摆设」的问题，我逐一复核成立，已全部修掉：

| 问题 | 根因 | 修法 |
| --- | --- | --- |
| 侧边栏「宽度 / 圆角 / 透明度 / 模糊强度」四个滑块拖了界面不变 | 四个字段只被设置面板自己读，**全仓零处 `document.documentElement.style.setProperty`**，样式表里的 `--sb-w-expanded` / `--gl-panel-alpha` / `--gl-panel-blur` 全是常量 | `App.tsx` 加一条「设置 → 根元素自定义属性」的桥 |
| 「圆角」没有对应的 CSS 变量 | `.sb { border-radius: var(--r-lg) }` 用的是按钮/卡片/对话框共用的全局圆角，改它会牵连整页 | 新增 `--sb-radius: var(--r-lg)`，`.sb` 改用它 |
| 强调色 / 环境色无效 | `accent`/`ambient` 只有设置面板在读；品牌派生色 `--p-brand-06/08/10/soft` 是写死的 rgba，只改 `--p-brand` 会剩下一堆旧蓝的浅色底 | 派生色改成 `color-mix(in srgb, var(--p-brand) N%, transparent)`；`--p-ambient` 默认等于原遮罩色（不带壁纸时观感一字不变），`--gl-veil-color` 指向它 |
| `data-contrast="high"` 与 `data-motion="reduced"` 没有下游 | 11 个 CSS 里零个选择器消费 | 在 `tokens.css` 末尾补三组块：`[data-motion="reduced"]` 压短两套时长 token、`[data-motion="off"]` 全部 1ms、`[data-contrast="high"]` 抬高 `--fg-1/2/3` 并压实玻璃边缘 |
| 选了「深海蓝」主题但界面是默认蓝 | `activeThemeId` 有值，`accent`/`ambient` 却是空串 —— 渲染层只认具体颜色，空串就落回 tokens 里的通用默认蓝 | 启动时 `syncActiveTheme()` 把当前主题的强调色/环境色补进设置（只补空值，不碰手调过的） |

**动效豁免这条单独说**：`[data-motion="reduced"]` 最初写的是 `animation-name: none !important`，
一刀切会把「正在转的加载圈」也冻住 —— 那是唯一在告诉用户「程序在跑」的东西，冻住等于撒谎。
最终改成掐掉装饰性循环（呼吸点 / 骨架微光 / 图标呼吸），但给 `.spinner` 与 `.dot--loading`
用更高特异性 + `!important` 捞回来并放慢到 1.1s。

### 验证方法（全部落在运行实例上，不是静态阅读）

| 探针 | 验的是什么 | 结果 |
| --- | --- | --- |
| `scripts/probe-appearance.js` | 同时读三层：计算值 / 内联值 / 元素实测几何 | 三组配置全部吻合 |
| `scripts/probe-appearance-save.js` | 走完整用户路径：开设置 → 拖「宽度」到 300 → 点保存 | 拖动时变量仍是 248px（草稿态不生效是对的），保存后 `--sb-w-expanded` 与内联值双双变 300px |

三组配置的实测数字：

| 配置 | `--sb-w-expanded` | `--sb-radius` | `--gl-panel-alpha` | `--gl-panel-blur` | `--p-brand` | 元素实测 |
| --- | --- | --- | --- | --- | --- | --- |
| 基线（248/16/0.62/28，accent 空） | 248px | 16px | 0.62 | 28px | `#4c9aff`（主题默认） | `backdrop-filter: blur(28px) saturate(1.45)`、背景 alpha 0.62 |
| 测试值（300/4/0.9/48，accent `#ff3b6b`） | 300px | 4px | 0.9 | 48px | `#ff3b6b`，`--p-brand-06` 跟着变成 `color-mix(in srgb, #ff3b6b 6%, transparent)` | 宽 300、圆角 4px、`blur(48px)`、alpha 0.9、主区 `margin-left: 320px`（= 300 + 10×2） |
| 玻璃关 + motion off | 300px | 4px | **1** | **0px** | `#ff3b6b` | 内联的 alpha/blur **被主动摘掉**，降级块赢：`blur(0px) saturate(1)`、背景不透明、`--t-1/--t-6` = 1ms |

动效豁免单独验了一遍（往 DOM 里塞临时元素读计算样式再删掉）：
`.spinner` → `spin 1.1s infinite`、`.dot--loading` → `dot-spin 1.1s infinite`、
`.dot--running` 的呼吸圈 → `animation-name: none`。**干活的那两个还在转，装饰的那个停了。**

截图：`docs/shots/v4-appearance-01.png`（1980×1323）。

---

## 6. 还没做完的（按要紧程度排）

1. **NSIS 安装包没出过正式件。** `release\` 现在只有 `builder-debug.yml` 与 `win-unpacked\`，
   没有 `setup.exe`。打包配置与前置检查清单在 07 章，**但那章明确没跑过 electron-builder**。
   这一项要等 Master 看完界面点头之后再做。
2. **拖拽导入壁纸的端到端链路没验。** 覆盖层渲染、有效/无效两态、错误条都用合成事件验过了
   （`probe-wpdrop2.js`），但 `webUtils.getPathForFile()` 对合成 `File` 返回空，真实拖文件落盘
   这一段自动化验不了 —— **有代码、有渲染证据、没有端到端证据**。
3. **主题的深浅双材质没做。** `design-v3.md` §4 给的是每套主题「深色 + 浅色两套材质」，
   而 `ThemeSpec` 带一个 `mode` 字段，每套主题自带它属于哪个模式。所以现在的实现路线是
   **「主题锁模式」**，不是「一套主题两种材质」。这是一个产品决策，不是 bug，但两边对不上。
4. **`design-v3.md` §6.7 的十四项数值没做 A/B 截屏校准**（面板 blur 30/26、sat 1.45/1.30、
   lum 0.94/1.03、噪点 0.02/0.014、内高光峰值 0.14/0.30、三个 spring）。
5. **任务栏右键菜单与托盘双击没人工验过。** 程序化验证不了，要人手点。
6. `components/Sidebar.tsx`（121 行）是 v1 遗留、**没被任何地方 import**，可以删。

---

## 7. 从零复现环境

```powershell
# 运行时
$node = "C:\Users\YBY\.dsh\dsh-runtimes\dsh-primary-runtime\dependencies\node\bin\node.exe"
$pnpm = "C:\Users\YBY\.dsh\dsh-runtimes\dsh-primary-runtime\dependencies\pnpm\bin\pnpm.cjs"

# 依赖（pnpm 11 会拦 electron 的 install 脚本，必须补这一刀）
& $node $pnpm install
$env:ELECTRON_MIRROR = "https://npmmirror.com/mirrors/electron/"
$env:HTTPS_PROXY  = "http://127.0.0.1:65535"
& $node node_modules\electron\install.js

# 静态检查 + 构建（npx 在这台机器上不可用）
& $node node_modules\typescript\bin\tsc --noEmit -p tsconfig.node.json
& $node node_modules\typescript\bin\tsc --noEmit -p tsconfig.web.json
& $node node_modules\electron-vite\bin\electron-vite.js build

# 启动（顺序不能变：杀进程 → 等 5 秒 → 清环境变量 → 启动 → 等 9~11 秒）
Get-Process electron -ErrorAction SilentlyContinue | Stop-Process -Force
Start-Sleep -Seconds 5
Remove-Item Env:ELECTRON_RUN_AS_NODE -ErrorAction SilentlyContinue
Start-Process node_modules\electron\dist\electron.exe -ArgumentList ".","--remote-debugging-port=9333"
Start-Sleep -Seconds 11

# 探针 / 截图
& $node scripts\cdp-eval.mjs --file scripts\probe-appearance.js
& $node scripts\cdp-eval.mjs --shot docs\shots\foo.png --wait 1200
```

**不要做**的三件事（都踩过）：
- 不要用 `npx`（`npm error could not determine executable to run`）
- 不要在 `Page.captureScreenshot` 上自己写裸 WebSocket（会挂死不返回）
- 不要在窗口被遮挡时截图（CDP 截出来是空表面），也不要指望那时候 `requestAnimationFrame` 会回调

---

## 8. 目录一览

```
D:\项目\DSH\deepseekharness插件台\
├─ src\
│  ├─ main\          主进程：index / window / tray / ipc / wallpaperProtocol
│  │  └─ engine\     23 个模块：settings env state patch inventory spec net updates
│  │                 versions market gallery icon wallpaper themes manifest proxy
│  │                 dsh dshproc pnpm dshpm profileYaml ops bundles
│  ├─ preload\       唯一那座桥（contextBridge + webUtils.getPathForFile）
│  ├─ renderer\      React 19：App + 20 个组件 + 11 个 css
│  └─ shared\        冻结契约：types.ts（类型）+ ipc.ts（通道常量）
├─ docs\
│  ├─ report\        本目录，七章 + 这份索引
│  ├─ shots\         71 张截图（v2 旧外壳 / v3 新外壳 / v4 外观落地）
│  ├─ design-*.md / ref-notes.md / market-parity.md / _log.md
│  └─ _*.json        探针落盘的原始数据
├─ scripts\          82 个：截图、探针、图标生成、启动辅助
├─ build\            icon.ico（7 帧）、electron-builder 资源
├─ resources\        tray.ico / icon.png（extraResources，asar 外）
└─ release\          win-unpacked\（可跑，无 setup.exe）
```