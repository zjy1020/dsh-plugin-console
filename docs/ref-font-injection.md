# DSH 字体注入机制调研报告（供「插件台」改 DSH 本体字体用）

> 调研方式：**纯只读**。所有结论附 `文件:行号`。凡未实测/未定位到的，一律标「**未核实**」，不编。
> 调研对象：
> - 已装插件 `C:\Users\YBY\.dsh\profiles\desktop\node_modules\dsh-plugin-wallpaper-engine`（v1.4.2，字体逻辑在子包 `dsh-plugin-wallpaper-engine-fonts`）
> - DSH 本体 `D:\Dowloads\DeepSeekHarness\resources\app\dsh\`（@deepseek-ai 包）
> - 插件台 `D:\项目\DSH\deepseekharness插件台`

---

## 0. 结论速览

| 问题 | 结论 | 一句话依据 |
|---|---|---|
| ① wallpaper-engine 字体功能改什么 | 浏览器半边**纯 DOM 注入**：造一个 `style#we-font-scope`，把 CSS 文本塞进 `textContent`，用 DSH 的 theme 令牌服务覆盖 `--dsw-font-family` 等令牌 | `dsh-plugin-wallpaper-engine\lib\client.js:8754-8762`、`:8511`、`:8790-8804` |
| ② 存的哪 | **插件自己的数据目录**，不是 DSH 配置：`~/.dsh-wallpaper-engine/fontsets/<id>.json` + `config.json`（只有 `fontSetId`/`fontCustom` 开关）；前端 localStorage 只是缓存 | `...-fonts\lib\kernel\config.js:176`、`config.json` 实测内容 |
| ③ 字体列表哪来 | 宿主路由 `GET <BASE>/system-fonts`，多腿扫描系统字体（Windows 走 PowerShell `InstalledFontCollection`，退注册表 `Fonts`，再退扫字体目录），落盘缓存 7 天；客户端还有 canvas 探针判断能否匹配 | `...-fonts\lib\routes\system-fonts.js:1-56,71-89`；`lib\client.js:12011` |
| ④ DSH 本体有原生字体入口吗 | **有，而且是官方的**：`@deepseek-ai/dsh-client-ui-theme` 提供「正文字体/代码字体/终端字体」三行设置，写进设置文档（profile patch），字段 `textFontFamily`/`codeFontFamily`/`terminalFontFamily`，且是 **volatile（可热改）** | `@deepseek-ai\dsh-client-ui-theme\lib\index.js:65-69,187-195,200-215`；`lib\client.js:1182-1217,2336-2362` |
| ⑤ 桌面渲染进程字体来源 / 有无用户级 CSS 覆盖点 | 字体链：webserver 渲染 index.html → ui-theme 在 `webserver/index-inject` 推 head `<style>`+body `<script>` → 客户端 Presenter / base.css 生效。**未发现任何官方「用户 CSS 文件」机制**；官方支持的用户级覆盖点就是 ④ 的三组设置键 | `dsh-host-webserver\lib\index.js:28-98,646-660`；`dsh-client-ui-theme\lib\index.js:200-215`；`dsh-client-ui-layout\lib\client.js:583-626` |
| ⑥ 插件台可行路径 | **4 条**：A 写 profile patch 的 ui-theme config（首选，无需重启）；B 写 `~/.dsh/cordis.patch.yml` home patch（全 profile 生效）；C 生成/安装一个极小 bundle 注入 CSS（唯一能改 wallpaper-engine 管不到的细节）；D 直改 DSH 安装目录（能跑但不推荐）。另有 E：直写 wallpaper-engine 的字体集文件 | 见 §6 |

**关键结论一句话**：改 DSH 字体**不需要**注入 CSS 也**不需要**插件——DSH 自己就有 volatile 的字体设置键，插件台只要把这三个键写进 profile 的 `cordis.patch.yml`（或 home patch）即可，**且该文件被 DSH 的 HMR 监听，改完会热 reconcile，不用重启 DSH**。

---

## 1. 问题①：wallpaper-engine 的「更改字体」到底改的是什么

**答案：往渲染进程注入 `<style>` + 覆盖 DSH 的 CSS 令牌。不写 DSH 配置、不碰 DSH 安装目录、不写 DSH 的任何文件（除它自己数据目录）。**

### 1.1 唯一的样式表载体

`C:\Users\YBY\.dsh\profiles\desktop\node_modules\dsh-plugin-wallpaper-engine\lib\client.js:8754-8762`

```js
function fontScopeEl() { /* style#we-font-scope：插件唯一的字体样式表 */ }
  const st = document.createElement("style");
  st.id = "we-font-scope";
  (document.head || document.documentElement).appendChild(st);
```

写入点 `lib\client.js:8790-8804`（`applyComponentFonts()`）：

```js
st.textContent = buildComponentCss(cfg, ...) + buildDslBlocks(cfg, ...);
applyTerminalHostVar();
```

### 1.2 覆盖的 CSS 变量 / 关键常量

| 变量 | 位置 | 用途 |
|---|---|---|
| `--dsw-font-family` | `lib\client.js:8511` `const GLOBAL_FAMILY_TOKEN = '--dsw-font-family';` | 「全局字体」直接覆盖它 |
| `--dsw-font-<role>-font-size\|line-height\|font-family\|font-weight` 与 shorthand `--dsw-font-<role>` | `lib\client.js:8545-8551` `typeTokenNames(role)` | 角色级排版令牌 |
| `--dsw-font-<role>`（shorthand 值形态） | `lib\client.js:8627` `${prefix}${sizeExpr} / var(${t.lineHeight}) var(${t.family})` | 对应 DSH 组件里 `font: var(--dsw-font-<role>)` |
| `--we-host-font-family` / `--we-host-font-size`… | `lib\client.js:8694-8695`、快照函数 `:8813-8834` | 开写前先快照 DSH 原值，回落用 |
| 栈尾 `, var(--we-host-font-family, <FONT_STACK_FALLBACK>)` | `lib\client.js:22472` | 用户族名后面自动接上原 DSH 栈 |
| `--dsh-ssh-terminal-font`（写 body 内联） | `lib\client.js:8779-8789` `applyTerminalHostVar()` | 只在终端**构造那一刻**被 dsh-ssh 读走 |

令牌写出走 DSH 的 theme 令牌服务，source 名 `lib\client.js:8504`：

```js
const THEME_TYPE_SOURCE = 'wallpaper-engine-typography';
```

（注释说明：必须与 color-roles 用不同 source，同 source 会整层替换。）

### 1.3 注入的 CSS 到底是什么样（结构摘录）

- 角色表 `lib\client.js:8528-8543` `THEME_TYPE_ROLES`：`markdown-h1/h2/h3/h4`、`markdown-base`、`markdown-small`、`markdown-code`、`markdown-code-block`、`markdown-table`、`markdown-table-head`、`xs-13`、`xxs-12`（id 就是 DSH 令牌角色名，表达式照抄 DSH）。
- payload 组装 `lib\client.js:8562-8593` `buildTypePayload(...)`：`payload[GLOBAL_FAMILY_TOKEN] = { light, dark }`（两侧同值）+ 角色级 `-font-family` / shorthand。
- 组件级白名单 `lib\client.js:5070` `const COMPONENT_FONT_PROPS = ['font-size','font-weight','font-family'];`；`:5064-5066` 注释：只写白名单内组件，**不碰 katex、不生成 `@font-face`**。
- 没有 `@font-face`：字体一律按系统族名引用（族键形如 `sys:Cascadia Code SemiBold`），插件不做字体文件嵌入。

### 1.4 一个已被插件写死的坑（值得插件台直接抄）

`lib\client.js:8462-8485` 静态分析结论：
- DSH 组件的 `module.css` 里 `font:` **全是 shorthand**（`font: var(--dsw-font-<角色>)` 共 21 处）；
- 细粒度令牌里**只有 `-font-family` 有 1 处消费者**（`user-text.module.css`），`-font-size`/`-font-weight` 零消费者。

⇒ **只改 `--dsw-font-<角色>-font-size` 必然无效**，必须改 shorthand 或 `--dsw-font-family`；shorthand 的定义在 `@deepseek-ai\dsh-client-ui-theme\lib\client.js:1464` 的 base.css 串里。

---

## 2. 问题②：用户选的字体存在哪里

**答案：wallpaper-engine 自己的数据目录 `~/.dsh-wallpaper-engine/`，与 DSH 的配置体系完全无关。**

- 数据目录求解：`dsh-plugin-wallpaper-engine\lib\kernel\data-dir.js:31` `pluginDataDir()` = `DSH_WE_DATA_DIR` 覆盖，否则 `join(homedir(), '.dsh-wallpaper-engine')`；`configPath()` @ `:37`。
- 字体集目录：`dsh-plugin-wallpaper-engine\lib\kernel\config.js:176`

```js
function fontSetsDir() { return join(pluginDataDir(), 'fontsets'); }
```
同文件 `:245` 导出 `{ fontSetsDir, glassPresetsDir, readFontSetId, setFontSetId }`。

- 本机实测目录 `C:\Users\YBY\.dsh-wallpaper-engine\`：
  `avatars/ bin/ cache/ diag/ ffmpeg/ fontsets/ live-frames/ mascot/ overrides/ thumbs/ uploads/ build-stamp.json(204B) config.json(3326B) star-count.json(33B) system-fonts.json(4100B)`
- `config.json`（单行 3326B）里字体相关**只有开关与当前字体集 id**：
  `{"settings":{ …,"fontCustom":true,… },"fontSetId":"preset-font"}`
- 真正的字体选择在字体集文件里。`C:\Users\YBY\.dsh-wallpaper-engine\fontsets\preset-font.json`（375B）全文：

```json
{"$schema":"dsh-we/fontset@1","id":"preset-font","name":"默认",
 "values":{"themeColors":{},"themeDarkSeparate":false,"themeSize":{},"themeWeight":{},
 "themeFamily":{},"globalFamily":"sys:Cascadia Code SemiBold",
 "componentFonts":{"terminal":{"family":"sys:Cascadia Code SemiBold"}}}}
```

（`default.json`(241B) 同结构但 `values` 各子对象为空。）
⇒ 用户真选的是 **`values.globalFamily` + `values.componentFonts.<组件>.family`，值是族键 `sys:<族名>`**，不是 CSS 栈；栈在客户端拼（`fontFamilyStack(v)` `lib\client.js:22479`、`fontFamilyKeyOf` `:22487`、`fontFamilyStackConcrete` `:22502`）。

- 前端缓存：`localStorage` 键 `"dsh-wallpaper-engine:selection"`（`lib\client.js:22306`），宿主路由 `SETTINGS_URL = "/wallpaper-engine/settings"`（`:22312`）、`fontSetsUrl()` = `BASE+"/fontsets"`（`:9277`）、`systemFontsUrl()` = `BASE+"/system-fonts"`（`:11904`）；字体清单缓存键 `"we-system-fonts"`（`:11886`），TTL 10 分钟（`:11888`）。持久化纪律在 `:8846-8890`（宿主文件是真源，localStorage 只是同步缓存+迁移源+回滚）。
- 字体集目录 API（宿主半边）：`dsh-plugin-wallpaper-engine-fonts\lib\routes\fontsets.js`（23643B，路由实现）。

---

## 3. 问题③：字体列表从哪来

**答案：宿主侧扫系统字体（多腿取并集 + 落盘缓存），客户端再用 canvas 探针过滤。**

`dsh-plugin-wallpaper-engine-fonts\lib\routes\system-fonts.js`（29970B）：

- 头注释 `:1-56` 说明路由 `GET <BASE>/system-fonts` 与多腿采集：
  - macOS：`system_profiler SPFontsDataType -json -detailLevel mini` + CoreText（`osascript -l JavaScript` → `CTFontManagerCopyAvailableFontFamilyNames`）
  - Windows：`powershell … InstalledFontCollection`，失败退**注册表 `Fonts` 键值名**（结果标 `approximate`）
  - Linux：`fc-list --format=%{family}\n`
  - 全失败：扫字体目录按文件名推族名，标 `approximate: true`
- 常量 `:71-89`：`SYSTEM_FONTS_TTL_MS = 7*24*60*60*1000`（`:71`）、`SYSTEM_FONTS_CACHE_VERSION = 3`（`:80`）、`FONT_SCAN_TIMEOUT_MS = 25000`、`FONT_SCAN_MAX_BYTES = 16*1024*1024`、`SYSTEM_FONTS_MAX = 2000`、目录降级 `FONT_DIR_MAX_DEPTH = 3` / `FONT_DIR_MAX_FILES = 4000`。
- 落盘缓存：`pluginDataDir()/system-fonts.json`（本机存在，4100B）。
- 过滤：丢弃 `.` 私有族、过不了 `systemFontKeyOf` 的名字。
- 客户端可否匹配探针：`lib\client.js:12011` `a.style.fontFamily = '"' + name + '", monospace'`（`:12014` 用 serif）——量宽度判断浏览器能否匹配。
- **没有**用 `document.fonts` 枚举（grep 未命中相关用法）。

---

## 4. 问题④：DSH 本体有原生字体设置入口吗

**答案：有，官方自带，不需要任何插件。**

### 4.1 包与字段

`D:\Dowloads\DeepSeekHarness\resources\app\dsh\node_modules\@deepseek-ai\dsh-client-ui-theme\lib\index.js`（217 行）

```js
:11   THEME_SETTINGS_NAMESPACE = "ui-theme"
:65-69 const FONT_FAMILY_FIELDS = { text: "textFontFamily", code: "codeFontFamily", terminal: "terminalFontFamily" };
:76-78 function fontFamilyVariable(kind) { return `--dsh-font-family-${kind}`; }
:35-57 FONT_SIZE_SPECS = { text:{field:"fontSize",variable:"--dsh-content-font-size",min:10,max:22,default:14},
                           code:{field:"codeFontSize",variable:"--dsh-code-font-size",min:10,max:16,default:11},
                           terminal:{field:"terminalFontSize",variable:"--dsh-terminal-font-size",min:10,max:20,default:13} }
```

设置文档 schema（非 volatile，供 index 响应读持久值）`:87-95`：三族键 `z.string().default("")`。

**volatile 版 Config（决定「可热改」）`:187-195`**：

```js
textFontFamily: z.string().default("").volatile(),
codeFontFamily: z.string().default("").volatile(),
terminalFontFamily: z.string().default("").volatile(),
```
（非 volatile 字段会被 `dsh-settings\lib\index.js:511` 拒绝：`Config field "…" is not volatile`。）

### 4.2 UI

`@deepseek-ai\dsh-client-ui-theme\lib\client.js`：
- `FontFamilyRow({t,role,setFontFamily,useStore})` `:1182-1217`（Input，blur/Enter 提交，`maxLength: 200`，placeholder「默认」）。
- `FontSettingsGroup(...)` `:1321-1358`：**挂在 General 设置页 item slot**（注释 `:1311-1314`「Font settings registered into the General section item slot」）。默认折叠，只显示 `size("text")` 一行 + 展开按钮（`aria-label/title = t("fontSize.more")` `:1285-1286`）；展开后 `family("text"), family("code"), size("code"), family("terminal"), size("terminal")`（`:1347-1355`）。
- 注册点 `:2336-2362`：`ctx.slots.inject("settings.general.item", () => ctx.slots.register({ name:"settings.general.item", id:"appearance" | "font-size", order:10|11, … }, AppearanceRow | FontSettingsGroup))`。
- 中文文案 `:1561-1567`：`fontFamily.text.title = "正文字体"`、`fontFamily.code.title = "代码字体"`、`fontFamily.terminal.title = "终端字体"`、desc「用于界面与会话正文。多个字体用逗号分隔，留空使用默认字体」；`:1548`「字号大小」、`:1568`「更多字体设置」。
- 归一化 `lib\index.js:122-124` `normalizeFontFamily(value)`：逗号切分 → 去 `"'\\<>\u0000-\u001f\u007f` → 压空白 → 非泛型族名加双引号 → `join(", ")`；泛型白名单 `GENERIC_FAMILIES`（`lib\client.js:1105-1111`）。
- 客户端写入是**唯一入口**：`setFontFamily(role,value)` `lib\client.js:2016-2025`

```js
const list = normalizeFontFamily(value);
if (this.fontFamilies[role] === list) return;
this.fontFamilies = Object.freeze({ ...this.fontFamilies, [role]: list });
this.write(() => this.host.set(FONT_FAMILY_FIELDS[role], list));
this.publish();
```
（注释 `:2009-2015`：「the only font-family write entry」。）

### 4.3 持久化到哪 —— 就是 profile 的 `cordis.patch.yml`

- 设置写入经 `dsh-settings` → `dsh-config-editor`；`dsh-config-editor\lib\index.js:25` `return this.ownerContext.profileContext.patchPath;`（getter 注释「The profile patch edited by this service」）；写回持 `join(profileContext.dir,"package.json")` 文件锁并 `reconcileProfilePatches(...)` `:72-124`。
- **本机实证**：`C:\Users\YBY\.dsh\profiles\desktop\cordis.patch.yml:29-35`

```yaml
- id: ui-theme
  name: "@deepseek-ai/dsh-client-ui-theme"
  config:
    preference: dark
    fontSize: 14
    codeFontSize: 11
    terminalFontSize: 13
```
⇒ **三个 fontFamily 键目前还没写（默认空串 = 用内置栈）**，插件台要加的就是这三个键。

- 文件名常量：DSH 侧 `PROFILE_PATCH_FILENAME`（`dsh-app-boot\lib\index.js:1398` `const patchPath = join(dir, PROFILE_PATCH_FILENAME);`），插件台侧 `src\main\engine\patch.ts:25` `const PATCH_FILE = 'cordis.patch.yml'`。
- 手写原始值也安全：客户端读回时会归一化 —— `lib\client.js:2172-2177` `durableFontFamilies(section)`（注释「Hand-edited documents may hold raw input」）。

### 4.4 字体从哪里进 DOM（三处，都能被同一个键驱动）

1) **宿主引导注入**（页面加载时就在 HTML 里）：`dsh-client-ui-theme\lib\index.js:126-183`
`bootThemeStyle(preference)` `:137-143`、`bootThemeBodyScript(preference, fontSizes, fontFamilies)` `:145-160`（生成 body 内联脚本写 `--dsh-content-font-size` 等三字号 + 每个非空 `--dsh-font-family-<role>`）、`bootThemeInjections(...)` `:170-183` 返回 `[{kind:"style",text:…},{kind:"script",placement:"body",text:…}]`；接入点 `:200-215`：

```js
ctx.on("webserver/index-inject", table => {
  table.push(...bootThemeInjections(config.preference.get(), {…}, {
    text: config.textFontFamily.get(), code: config.codeFontFamily.get(), terminal: config.terminalFontFamily.get()
  }));
}, { prepend: true });
```

2) **客户端 Presenter 跟随**：`@deepseek-ai\dsh-client-ui-layout\lib\client.js:583-593`

```js
FONT_FAMILY_VARIABLES = { text:"--dsh-font-family-text", code:"--dsh-font-family-code", terminal:"--dsh-font-family-terminal" }
```
`ThemePresenter.apply(snapshot)` `:614-626`：空串 `body.style.removeProperty(name)`，否则 `body.style.setProperty(name, list)`。

3) **内置栈与最终合成**：`@deepseek-ai\dsh-client-ui-theme\lib\client.js:1464`（base.css 串）

```css
:root{ --dsh-font-family-text-default:-apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC", …;
       --dsw-font-family: var(--dsh-font-family-text-default);
       --dsh-font-family-code-default:"SF Mono", "JetBrains Mono", "Fira Code", Consolas, …;
       --ds-font-family-code: var(--dsh-font-family-code-default); … }
body{ --dsw-font-family: var(--dsh-font-family-text, var(--dsh-font-family-text-default)), var(--dsh-font-family-text-default);
      --ds-font-family-code: var(--dsh-font-family-code, var(--dsh-font-family-code-default)), var(--dsh-font-family-code-default); … }
```
`README.zh.md:66` / `README.md:66` 原话：用户变量排在内置栈之前，未设置就回落内置栈。

**⇒ 也就是说：只要让 `--dsh-font-family-text` / `-code` / `-terminal` 有值，DSH 正文/代码/终端字体就变了 —— 这就是官方「用户级」覆盖点。**

---

## 5. 问题⑤：桌面渲染进程字体从哪来 / 有无用户级 CSS 覆盖点

**字体链（已闭环）**：

1. Electron 桌面窗口加载的是 DSH webserver 的 index（`resources\app\lib\main.js:18355` `window.loadURL(`${this.origin}/`)`；`:13119`、`:18613` 等其它 view 同理）。
2. index.html 由 `dsh-host-webserver` 渲染，插件行注入：
   - `dsh-host-webserver\lib\index.js:28-57` `renderRow(row)`：`style` 固定进 **head**（`:47-50` `<style>${row.text}</style>`）、`script` 按 `row.placement`、`global`/`script-preload` 进 head、`html` 按 placement、`script-src` 带 src。
   - `:79-98` `renderIndexInjections(html, rows)`：head 行插到 `<head…>` 后，body 行插到 `<body…>` 后，末尾追加 `READY_MARKUP`（`:70`）。
   - `WebServer.renderIndex(html, peer)` `:658-660` = `applyIndexTaps(renderIndexInjections(html, this.collectIndexInjections(peer)))`；`collectIndexInjections` `:646-650` = `ctx.emit("webserver/index-inject", table, peer)`。
3. ui-theme 宿主把自己的 head `<style>` + body `<script>` 推入（见 §4.4-1）。
4. 客户端 `ThemePresenter` 与 ui-theme 的 font consumer 接管同名变量（§4.4-2/3）。

**用户级 CSS 覆盖点：未发现。**
- 在 `@deepseek-ai\` 下 grep `customCss|userCss|user.css|dsh-custom-css` 等只命中 xterm 内部 `_injectCss`（`dsh-client-ui-sidebar-terminal\lib\client.js` → 实为 `lib/client.terminal.js:1429/1441/1501`），与用户 CSS 无关。
- 没有任何名为 custom-css / user-style / font 的官方包（一层包名清单已枚举）。
- Electron 外壳只读不写字体：`resources\app\renderer\shell-theme.js`（6 行，只切 `data-ds-dark-theme`）；`resources\app\lib\preload-app.cjs:1545-1553` 自建 titlebar `<style>` 里 `:1549` `font-family: var(--dsw-font-family);`（读）、`:1553` `font: inherit; font-size: 14px;`（不写）；`main.js` grep `insertCSS|zoomFactor|setZoomLevel|font-family|fontFamily` 无命中。
- **结论**：官方支持的「用户级字体覆盖点」= §4 的三组设置键（落在 profile patch 的 `ui-theme.config`）+ profile/home patch 层；**没有 `.dsh/xxx.css` 之类被自动注入的 CSS 文件**。

---

## 6. 问题⑥：插件台改 DSH 字体，有哪些可行路径

> 前提：插件台已能写 profile 的 `package.json`（`src\main\engine\bundles.ts:82` `writeProfilePkg`、`:141-152` 只改 `dsh.profile.bundles`），但 `cordis.patch.yml` **目前只读**（`src\main\engine\patch.ts:19`「全部只读：本模块不写文件。」）；插件台 `src` 里 grep `font|字体` **零命中**。

### 路径 A（首选）：写 profile 的 `cordis.patch.yml` → `ui-theme.config` 的三个 fontFamily 键

**改哪里**：`C:\Users\YBY\.dsh\profiles\<profile>\cordis.patch.yml`（或 `$DSH_HOME` 指向的等价路径）里的 `- id: ui-theme` 条目，加：

```yaml
- id: ui-theme
  name: "@deepseek-ai/dsh-client-ui-theme"
  config:
    preference: dark
    fontSize: 14
    codeFontSize: 11
    terminalFontSize: 13
    textFontFamily: 'LXGW WenKai, "Microsoft YaHei", sans-serif'
    codeFontFamily: '"JetBrains Mono", Consolas, monospace'
    terminalFontFamily: '"Cascadia Mono", Consolas, monospace'
```

**实现要点（插件台侧）**：
- 需要在 `src\main\engine\` 新增一个 **patch 写入器**（现状只有读：`patch.ts`），语义是「UPSERT 一个顶层条目 / 在已有 `ui-theme` 条目的 `config:` 下 UPSERT 键」，并保持其余内容原样（DSH 自己的 `dsh-config-editor\lib\index.js:95` 也要求顶层必须是 YAML sequence）。
- 值可以写原始形态，客户端会 `normalizeFontFamily` 归一化（`dsh-client-ui-theme\lib\client.js:2172-2177`）。

**需要重启吗**：**不需要**（改文件即可热生效）。依据：
- 三个键是 `.volatile()`（`dsh-client-ui-theme\lib\index.js:187-195`）；
- `dsh-hmr\lib\index.js:849-873` 监听 `[profile.patchPath, join(profile.home, PROFILE_PATCH_FILENAME)]`（`watchConfig(filename, () => refresh(false))`）与 `package.json`；配置一变就 `reconcileProfile()`；
- HMR 默认启用：`@deepseek-ai\dsh-base\cordis.patch.yml:28-29` 有 `- id: hmr / name: '@deepseek-ai/dsh-hmr'`。
- 退一步：即便 HMR 没生效，页面刷新/重开窗口也会从新配置读引导脚本。**（热生效这一步建议真机实测一次，标为「待验证」。）**

**副作用 / 可靠性**：
- 高可靠（纯官方入口、官方 UI 就这么写）。
- 与 wallpaper-engine 冲突（**未实测**）：wallpaper-engine 覆盖的是 `--dsw-font-family`（`lib\client.js:8511,8562-8593`），而 ui-theme 的键最终喂给 `--dsh-font-family-text` 再由 base.css 合成 `--dsw-font-family`（`:1464`）。两者写同一结果变量，**谁生效取决于注入顺序与选择器特异性**。
  验证方法：开着 wallpaper-engine「全局字体」改 ui-theme 正文字体，然后在 DevTools 里看 `getComputedStyle(document.body).getPropertyValue('--dsw-font-family')`，并对比 `#we-font-scope` 与 ui-theme 令牌层的样式表顺序。
- 只覆盖 DSH 自己的 token 消费点；第三方插件若硬编码 `font-family`（如某些皮肤包）不受影响。

### 路径 B：写 **home patch** `~/.dsh/cordis.patch.yml`（全 profile 生效）

**改哪里**：`$DSH_HOME/cordis.patch.yml` —— `dsh\lib\profile-boot-e2mS45fC.js:110-118` `function homePatchPath() { return join(resolveDshHome(), PROFILE_PATCH_FILENAME); }`；同文件 `:122-126` 注释说明组合顺序「each bundle in package.json's dsh.profile.bundles, then cordis.patch.yml, then any --patch overlays」，`:228` 注释称 home patch 是「machine-local preferences」层。

**本机现状**：`C:\Users\YBY\.dsh\` 根目录**没有** `cordis.patch.yml`（插件台可新建）。
`$DSH_HOME` 解析规则：`dsh-home-paths\lib\index.js:11` `DSH_HOME_DIR_NAME=".dsh"`、`:15` `DSH_HOME_ENV="DSH_HOME"`、`:56` `join(homedir(), DSH_HOME_DIR_NAME)`、`:109-110` `resolveDshHome(configured, env)` = 显式配置 > `$DSH_HOME` > `~/.dsh`。桌面端 Launcher 的设置 `%APPDATA%\DSH\settings.json` 里 `dataDir` 指向 `%APPDATA%\DSH\data`（内含 `versions/`、`config.json`，**无 profiles**）⇒ 桌面端实际用的是默认 `~/.dsh`。

**需要重启吗**：不需要（home patch 也在 HMR 监听列表里：`dsh-hmr\lib\index.js:850` `join(profile.home, PROFILE_PATCH_FILENAME)`）。

**副作用**：机器级、对**所有** profile（desktop/web/headless）生效；且**优先级高于 profile 自己的 patch** —— `dsh-config-editor\lib\index.js:121` 明确抛错：「Configuration for "X" is overridden by a home patch or command-line overlay」，意味着一旦写进 home patch，用户在 DSH 设置面板里改字体**可能改不动**（被 home 层压住）。⇒ 只在插件台想「一次改所有 profile」时用，正常选择建议用路径 A。

**可靠性**：高，但侵入面比 A 大。

### 路径 C：生成并安装一个极小 bundle，自己注入 CSS

**这是唯一能改「ui-theme 三键管不到的细节」的路**（例如嵌 `@font-face` 自带字体文件、按角色改字号、覆盖第三方皮肤硬编码的 `font-family`，或像 wallpaper-engine 那样改 `--dsw-font-family`）。

**改哪里 / 走哪个 hook**：两条子路线，二选一或并用——
- **宿主半边推 style 行**（最省事，无客户端 JS）：`ctx.on("webserver/index-inject", table => table.push({ kind: "style", text: css }))`。行渲染规则见 `dsh-host-webserver\lib\index.js:47-50`（`style` 固定 head）。
  ⚠️ 注意顺序：head 里的 `<style>` 行排在运行时注入的 base.css **之前**，所以**别去覆写 `:root` 里 base.css 已定义的 `--dsh-font-family-text-default`**（同特异性后者胜）；要覆写的是 base.css **没定义**的 `--dsh-font-family-text` / `-code` / `-terminal`（base.css 的 `body` 规则是 `var(--dsh-font-family-text, …)` 消费它，`:1464`）：
  ```css
  :root{--dsh-font-family-text:"LXGW WenKai","Microsoft YaHei",sans-serif;
        --dsh-font-family-code:"JetBrains Mono",Consolas,monospace;
        --dsh-font-family-terminal:"Cascadia Mono",Consolas,monospace}
  ```
- **客户端半边注入 DOM**（照抄 wallpaper-engine，能改任意令牌）：`document.createElement("style")` + `textContent` + `document.head.appendChild`，插件样例见 `@smalltailqwq\dsh-client-ui-skin-maid-atelier\lib\client.js:117-121`（`tag.dataset.plugin` / `tag.dataset.pluginCss`）。

**需要重启吗**：装新 bundle 后需要 DSH 侧 reconcile（HMR 会因 `package.json` 变化触发，`dsh-hmr\lib\index.js:852-872`）+ **页面刷新**（客户端模块由 boot manifest 在页面加载时下发）；`index-inject` 的 style 行更是只在**每次 index 响应**时渲染，所以**必须刷新页面**才看得到。**是否必须整机重启 DSH：未核实（HMR 大概率够）。**

**副作用**：多一个插件要管理（版本、卸载残留）；客户端注入的样式与插件台自身生命周期解耦（插件台卸载了样式还在，要靠 bundle 自己清理）。

**可靠性**：中高。客户端 DOM 注入最灵活，但要处理热更新/清理。

#### 最小实现骨架（可直接当模板）

```
dsh-font-bundle/
├─ package.json
├─ cordis.patch.yml
└─ lib/index.js        # 宿主半边（default export 走这里）
```

`package.json`：

```json
{
  "name": "dsh-font-bundle",
  "version": "0.1.0",
  "type": "module",
  "main": "lib/index.js",
  "dsh": {
    "bundle": { "patch": "./cordis.patch.yml" }
  }
}
```
（对照真实样例：`@smalltailqwq\dsh-client-ui-skin-maid-atelier\package.json` 里 `dsh.bundle.patch = "./cordis.patch.yml"`，另有 `dsh.client = { inject: ["@deepseek-ai/dsh-client-ui-layout"], platform: "web" }`；若要客户端半边就再加 `"client": { "inject": ["@deepseek-ai/dsh-client-runtime"], "platform": "web", "immediately": true }`，字段校验见 `@deepseek-ai\dsh-client-modules\lib\index.js:82-98`，只有 `platform === "web"` 才会被当客户端入口 `:790`。）

`cordis.patch.yml`（真实样例：`...\dsh-client-ui-skin-maid-atelier\cordis.patch.yml`）：

```yaml
- insert:
    - id: font-bundle
      name: 'dsh-font-bundle'
```

`lib/index.js`（**注：DSH 宿主插件**，用 `webserver/index-inject` 推 CSS，hook 名与 ui-theme 完全一致）：

```js
export const name = 'dsh-font-bundle'

export function apply(ctx, config = {}) {
  const css = config.css ??
    ':root{--dsh-font-family-text:"LXGW WenKai","Microsoft YaHei",sans-serif;' +
    '--dsh-font-family-code:"JetBrains Mono",Consolas,monospace;' +
    '--dsh-font-family-terminal:"Cascadia Mono",Consolas,monospace}'
  ctx.on('webserver/index-inject', (table) => {
    table.push({ kind: 'style', text: css })
  })
}
```

装法（插件台已有能力）：写 profile `package.json` 的 dependencies + `dsh.profile.bundles`（`src\main\engine\bundles.ts:82,141-152`），pnpm 侧见 `src\main\engine\dshpm.ts`；也可用 `link:<本地目录>` 形式（本机 profile 里已有先例：`dsh-custom-brand: "link:D:\\项目\\DSH\\玩耍\\dsh-custom-brand"`）。

### 路径 D：直改 DSH 安装目录（能跑，不推荐）

可改点：`D:\Dowloads\DeepSeekHarness\resources\app\dsh\node_modules\@deepseek-ai\dsh-client-ui-theme\lib\client.js:1464` 的 base.css 串（内置栈）、或 `...\dsh-client-ui-layout\lib\client.js:583-626` 的变量表。
- **好处**：不装插件、立即生效（刷新页面即可）。
- **坏处**：升级 DSH 被覆盖；改动落在 `resources\app`（可能被完整性校验/自动更新擦掉）；一旦 DSH 换了 chunk 文件名（本机已见 `profile-boot-e2mS45fC.js` 这种带 hash 的文件名）就得重新定位。
- 本机已有同类先例：安装目录里存在 `@deepseek-ai\dsh-base\package.json.dshpurge.bak`、`cordis.patch.yml.dshpurge.bak`（说明该目录确实被本地工具改过）。
- **可靠性**：低（脆）。仅在临时验证时用。

### 路径 E（补充）：直写 wallpaper-engine 的字体集文件

若用户已装 `dsh-plugin-wallpaper-engine`，插件台可以直接写它的数据文件，等价于用户在那个插件里选字体：
- 写 `C:\Users\YBY\.dsh-wallpaper-engine\fontsets\<id>.json` 的 `values.globalFamily` / `values.componentFonts.<组件>.family`（值形如 `sys:Cascadia Code SemiBold`）；
- 或在 `config.json` 里切 `fontSetId` / `fontCustom`。
- **注意**：插件客户端有 localStorage 缓存与宿主「真源」同步纪律（`lib\client.js:8846-8890`），是否需要刷新页面/插件重载配置**未核实**。
- **可靠性**：中（依赖该插件存在与其内部格式 `dsh-we/fontset@1` 不变；上游改 schema 就废）。适合作「已装插件用户」的快捷通道，不适合当主路径。

---

## 7. 未核实清单（禁止当结论用）

1. 路径 A 改 patch 后 **DSH 是否真的无需刷新页面就热生效**（HMR 会 reconcile，但客户端 `--dsh-font-family-*` 由 Presenter 在配置变更时重写还是仅首帧写——需真机看 `theme/change` 是否触发 `ThemePresenter.apply`）。
2. **wallpaper-engine 全局字体 vs ui-theme 正文字体的优先级**（两者最终都落到 `--dsw-font-family`），需实测 computed value。
3. 桌面端 `$DSH_HOME` 是否被 Launcher 以 `DSH_HOME` 环境变量覆写（`%APPDATA%\DSH\settings.json` 的 `dataDir` 指向 `%APPDATA%\DSH\data`，但那里**没有** profiles 目录，推断桌面端用默认 `~/.dsh`；未 100% 确认进程环境变量）。
4. 安装新 bundle 后是否必须重启 DSH（HMR 大概率够，未实测）。
5. 写 home patch（路径 B）是否会**永久压住** DSH 设置面板的字体修改（`dsh-config-editor\lib\index.js:121` 的报错文案指向「会」，但面板是否走同一校验未实测）。
6. 路径 E 写字体集文件后是否需刷新/重载（未实测）。
7. DSH 安装目录是否存在完整性/签名校验（未核实；本机已有 `.dshpurge.bak` 说明被改过，但那是本地工具行为，不等于官方允许）。

---

## 8. 证据索引（速查）

**wallpaper-engine（`C:\Users\YBY\.dsh\profiles\desktop\node_modules\`）**
- `dsh-plugin-wallpaper-engine\package.json`：`dsh.bundle.patch = ./cordis.patch.yml`、`dsh.client = {inject:["@deepseek-ai/dsh-client-runtime"], platform:"web", immediately:true}`
- `dsh-plugin-wallpaper-engine\cordis.patch.yml`（103 行）：单条 `- insert:`，插 9 个 host 行（含 `-fonts`）
- `dsh-plugin-wallpaper-engine\lib\client.js:8462-8485`（组件 font shorthand 分析）、`:8504`（THEME_TYPE_SOURCE）、`:8511`（GLOBAL_FAMILY_TOKEN）、`:8528-8543`（THEME_TYPE_ROLES）、`:8545-8551`（typeTokenNames）、`:8562-8593`（buildTypePayload）、`:8627`（shorthand 形态）、`:8694-8695`（host 令牌）、`:8754-8762`（style#we-font-scope）、`:8779-8789`（终端变量）、`:8790-8804`（写 textContent）、`:8813-8834`（快照）、`:8846-8890`（持久化纪律）、`:22472/22479/22487/22502`（族名↔栈）、`:12011/12014`（canvas 探针）、`:22306/22312/9277/11904/11886/11888`（设置键与路由）
- `dsh-plugin-wallpaper-engine\lib\kernel\data-dir.js:31,37`；`lib\kernel\config.js:176,179,185,245`
- `dsh-plugin-wallpaper-engine-fonts\lib\index.js:65`（`apply(ctx,_config)`）；`lib\routes\system-fonts.js:1-56,71-89`；`lib\routes\fontsets.js`；`cordis.patch.yml`（6 行）
- 数据文件：`C:\Users\YBY\.dsh-wallpaper-engine\config.json`、`fontsets\{default,preset-font}.json`、`system-fonts.json`

**DSH 本体（`D:\Dowloads\DeepSeekHarness\resources\app\dsh\node_modules\@deepseek-ai\`）**
- `dsh-client-ui-theme\lib\index.js:11,35-57,65-69,76-78,84-95,122-124,126-183,187-195,200-215`
- `dsh-client-ui-theme\lib\client.js:1041-1052,1105-1111,1133,1182-1217,1275-1291,1311-1358,1370-1394,1464,1548-1568,1989-2046,2172-2177,2292-2362`
- `dsh-client-ui-theme\README.zh.md:48,66`；`README.md:66`
- `dsh-client-ui-layout\lib\client.js:571,581,583-593,614-626`
- `dsh-host-webserver\lib\index.js:28-57,70,79-98,445,646-650,658-663`
- `dsh-settings\lib\index.js:3,302-305,322,347-362,505-532`（`:511` volatile 校验）
- `dsh-config-editor\lib\index.js:18,23-36,72-124`（`:95` sequence 校验、`:121` home patch 覆盖报错）
- `dsh-hmr\lib\index.js:849-873`
- `dsh-base\cordis.patch.yml:28-29`；`dsh-base\package.json:37`
- `dsh-app-boot\lib\index.js:1306,1398`
- `dsh-home-paths\lib\index.js:11,13,15,56,109-110`
- `dsh\lib\profile-boot-e2mS45fC.js:110-128,228`
- `dsh-client-modules\lib\index.js:82-98,790`
- 桌面外壳：`resources\app\lib\main.js:18355`（loadURL）；`resources\app\lib\preload-app.cjs:1545-1553,1665,1673-1690,1709`；`resources\app\renderer\shell-theme.js`（全文 6 行）

**本机 profile / 数据**
- `C:\Users\YBY\.dsh\profiles\desktop\cordis.patch.yml:1-3,29-35`（ui-theme 条目）
- `C:\Users\YBY\.dsh\profiles\desktop\package.json:4-22`（deps）、`:23-45`（bundles）
- `C:\Users\YBY\.dsh\`（根，无 `cordis.patch.yml`）、`storages\`、`%APPDATA%\DSH\settings.json`、`%APPDATA%\dsh-desktop\`

**插件台（`D:\项目\DSH\deepseekharness插件台`）**
- `src\main\engine\patch.ts:2,19,25,28-36,111-196,206-219`（只读）
- `src\main\engine\bundles.ts:41,65-74,82,141-152`（能写 profile `package.json` 的 bundles）
- `src\main\engine\ops.ts:6-8`、`dshpm.ts:8`、`state.ts:6-7`
- `src\main\engine\themes.ts`、`wallpaper.ts`（未读，与本次字体需求相关度待评）
