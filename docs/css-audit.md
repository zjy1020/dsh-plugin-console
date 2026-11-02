# DSH 插件台 · 全库 CSS 静态审计

> **快照时间**：2026-11-02 15:19。仓库此刻正被主控并发修改（`glass.css` 15:08、`detail.css` 15:15 新增、`gallery.css` 15:16、`components.css` 在审计中从 2363 行涨到 2380 行）。本报告所有行号以该快照为准。
> **范围**：`src/renderer/src/styles/` 下 12 个 CSS（tokens 563 / base 790 / components 2380 / glass 1377 / market 518 / appearance-settings 396 / version-picker 379 / gallery 394 / wallpaper-drop 203 / plugin-icon 62 / titlebar 31 / detail 95），以及 `src/renderer/src/` 下 29 个 tsx/ts（判断类名与属性是否真的被渲染/写入）。
> **只读**：未修改 `src/` 任何文件，未启动 Electron，未构建，未 git 操作。

## 0. 结论摘要

| 类别 | 命中数 | 其中真 bug | 最严重的一条 |
| --- | --- | --- | --- |
| 1. `var()` 引用未定义令牌 | 1 | 1 | `components.css:169` `padding-left: var(--brand-x);` —— 全库无该令牌定义、无兜底，声明被静默丢弃 |
| 2. 定义但从未引用的死令牌 | 28 | 2 | `tokens.css:314「--gl-panel-lum」`/`322「--gl-bed-blur」` 在三个降级开关里被反复赋值，却没有任何 `var()` 读取，降级动作空转 |
| 3. 选择器类名在 TSX 里不存在 | CSS→TSX 17 / TSX→CSS 5 | 17 | `glass.css:421` `.sb__item[aria-selected='true']` 的"选中态"整套（文本+图标）永不命中（同类见第 4 类） |
| 4. `data-*` / `aria-*` 双向错配 | 6 | 6 | `aria-selected` 从不落在 `.sb__item` 上（`SidebarShell.tsx:415` 改用 `aria-current`），侧栏选中项只靠滑块位移表达 |
| 5. 修饰符 CSS 有规则、TSX 永不产生 | 2 | 2 | `SidebarShell.tsx:414` 输出的 `is-active` 在 CSS 里**一条规则都没有**（grep 全库零命中） |
| 6. 跨文件顺序 / 特异性冲突 | 18（跨文件 1 + 同文件后置 9 + 内联 1 + 死规则 7） | 5 | `glass.css:1315-1321` 的 `prefers-reduced-transparency` 覆盖块被同文件 1334-1344 同特异性后置块整体压死 |

**三句话总结**

1. 这一类"写了不生效且不报错"的缺陷，本库还有 **1 处** 属于最纯粹的形态（第 1 类），另外 **2 处** 属于"机制上永远不成立"（第 4 类选中态、第 6 类 a11y 块被压死）——这三条都是不报错、不看代码发现不了的。
2. 主控已修的校准案例 A（`--sp-1..--sp-6` 未定义）与案例 B（`data-contrast`/`data-motion` 无消费者）本次复核**确认都已修好**，见 §1 末尾与 §4.3。
3. 最大的一块"看起来做了、实际没有"是**状态修饰符与类名残留**：17 条 CSS 类在 TSX 里根本不存在，5 条 TSX 类在 CSS 里不存在，它们都是改名/重构后留下的旧壳，全部可安全清理。

---

## 1. `var(--x)` 引用了从未定义的令牌

**总结**：全库 12 个 CSS 共出现 **151 个**被引用令牌名、**1723 处** `var()` 调用；**定义**为 178 个名字、322 处定义点（逐行 `^\s*(--name)\s*:` 建表，注释里的同名文本不计）。差集结果：**只有 1 个令牌被引用但全库零定义**。

| 文件:行号 | 原文 | 问题 | 影响 | 建议修法 |
| --- | --- | --- | --- | --- |
| `components.css:167` | `* 现在这里吃侧栏那条链本身（--brand-x，定义见文件末尾「品牌锁定对位」一节）：` | 注释声称"定义见文件末尾"，但文件末尾并不存在该节；全库 grep `brand-x` 只有 167（注释）与 169（使用）两处 | —— | 与下一条同批处理 |
| `components.css:169` | `padding-left: var(--brand-x);` | 引用零定义令牌、**且无兜底值** → 属于"invalid at computed-value time"，整条声明被丢弃，不报错 | `.titlebar` 只剩这一条左内边距来源，`padding-left` 实际回落 0，标题栏 logo 与侧栏 logo 的左沿对齐（165-168 注释描述的"同一个数"）完全失效；而 `--brand-x` 的语义链（外边距 10 + 面板 1px 边框 + 内边距 12 = 23px）在注释里反而被完整写出，说明本意是让它成为唯一真源 | 在 `tokens.css` 里补齐 `--brand-x: calc(var(--sb-margin) + 1px + 12px);`（或侧栏 logo 实际左沿所用的表达式），并让侧栏 logo 也引用它；若短期不想动令牌层，至少写 `var(--brand-x, 23px)` 让它有兜底 |

**为什么其它情况不计入"命中"（逐类排除，避免把下落回兜底误报成 bug）**

| 情形 | 实例 | 排除理由 |
| --- | --- | --- |
| `var(--x, fallback)` 带兜底 | `plugin-icon.css:10-18` 全部写成 `var(--bg-3, #1b2130)`、`:20-36` 同理 | 即使令牌缺失也只是回落，视觉有值 |
| 作用域块内定义 | `market.css:14` `--mkt-card-h: 158px;`，消费者 `market.css:158` | 定义与消费都在 `.install__pane.mkt` 子树内，成立 |
| 媒体查询内覆盖（有基值） | `components.css:1974` `--detail-w: 340px;`、`1984` `--sidebar-w: 236px;`、`1985` `--detail-w: 300px;`、`2010` `--log-h: 190px;`、`2011` `--row-h: 46px;` | 四个变量都有基值：`tokens.css:114-117`（`--sidebar-w: 268px` / `--detail-w: 400px` / `--row-h: 52px` / `--log-h: 250px`），媒体块只是收窄，成立 |
| JS 运行时 `setProperty` 写入 | `App.tsx:84-85` `--sb-w-expanded`/`--sb-radius`、`App.tsx:88-89` `--gl-panel-alpha`/`--gl-panel-blur`、`App.tsx:91-92` `--p-brand`/`--p-ambient` | 6 个变量在 `tokens.css` 里也都有静态定义（`tokens.css:270-271` 等），JS 只是覆盖值 |

**校准案例 A 复核（已修）**：`tokens.css:257` `--sp-1: var(--space-1);` … `261` `--sp-5: var(--space-5);`、`263` `--sp-8: var(--space-8);`，并保留 `265` `--sp-hair: 2px;`、`267` `--sp-3h: 14px;`、`268` `--sp-12: 48px;`。当前 `var(--sp-1..6)` 全部可解析，46 处声明不再被丢弃。副作用：`--sp-5`、`--sp-8` 这两个别名没有任何消费者（见 §2）。

---

## 2. 定义了但从来没有被引用的死令牌

**总结**：178 个已定义令牌里 **28 个**从未出现在任何 `var()` 中（15.7%）。全部集中在 `tokens.css`，按族分布：间距 6、字号 4、玻璃/动效 9、颜色 5、阴影/描边 2、半径 1、缓动 1。其中 **2 个**属于真 bug（被降级开关写入却无人读），其余为纯死代码。

| 文件:行号 | 原文 | 问题 | 影响 | 建议修法 |
| --- | --- | --- | --- | --- |
| `tokens.css:314` | `--gl-panel-lum: 0.94;` | 该名在 `tokens.css:314`、`412`（`[data-glass="off"]`）、`436`（`forced-colors`）**三处赋值**，零处 `var()` 读取 | 三个降级/无障碍开关里"调面板亮度"的动作空转，开关看起来写了效果 | 要么在玻璃层的 `filter: brightness()`/`color-mix` 里消费它，要么整条链删掉 |
| `tokens.css:322` | `--gl-bed-blur: 8px;` | 在 `322/417/429/444/447` **五处赋值**（含 `prefers-reduced-transparency`、`forced-colors`），零处读取 | 同上：降级时"衬底模糊归零"没有落地 | 同上，二选一 |
| `tokens.css:245` | `--fs-readout: clamp(17px, 1rem + 0.28vw, 21px);` | 注释写"唯一的重量级读数：延迟 / diff 位数"，零引用 | 侧栏延迟数字本该用的"重音字号"没落地（`glass.css:1172` 反而把它压成 `var(--fs-body2)`，见 §6.3） | 在 `.sb__readout-val` 上启用 |
| `tokens.css:246` | `--fs-display: …` | 零引用 | 展示级字号无消费者 | 删或接入 |
| `tokens.css:215` | `--p-aurora: #7c6cf0;` | 注释称给"主题身份 / diff 新增位 / 滑块内折射"，零引用 | 主题的身份色只存在于令牌层 | 接入或删 |
| `tokens.css:230/231/233` | `--p-brand-06` / `--p-brand-08` / `--p-brand-soft` | 三兄弟只有 `--p-brand-10`（`tokens.css:232`）被消费 | 品牌色成套缺一半，`App.tsx:63` 注释声称"选中项底色 / 滑块折射 / 角标"用到了 06/08/soft，实际没有 | 接入或整族删 |
| `tokens.css:293` | `--r-xl: 22px;` | 半径梯度里只有 XL 无人用（`--r-sm/md/lg` 全在用） | 梯度断层 | 删或给浮动面板用 |
| `tokens.css:282` | `--sb-gap-quick-nav: 16px;` | 侧栏间距族里唯一没人用的一个 | 侧栏"快捷区与导航"的间距退回硬编码（对比 `glass.css:1255`） | 删 |
| `tokens.css:312/325/333/338` | `--gl-panel-blur-min: 18px;` / `--gl-hl-sheen: linear-gradient(…);` / `--gl-hl-dur: 320ms;` / `--gl-blur-count: 2;` | 玻璃高光/模糊这是一整套设计参数，全部零引用 | 高光 sheen 动效完全没有实现（只有令牌和名字） | 接入或删；`--gl-blur-count` 若不是给 CSS 用的就直接删 |
| `tokens.css:54-56` | `--info: …` / `--info-soft: …` / `--info-line: …` | info 语义色三件套零引用（`--ok/--warn/--danger` 都在用） | 语义色不齐 | 删或接给提示条 |
| `tokens.css:65` | `--shadow-1: …` | 阴影梯度只有 1 号无人用 | —— | 删 |
| `tokens.css:68` | `--ring-danger: …` | 焦点环只做了默认与 focus 两种，危险态环无人用 | 危险按钮的键盘焦点环缺失（配合 §4 的 `aria-disabled` 死钩子） | 接到 `.btn--danger:focus-visible` |
| `tokens.css:94/97` | `--dur-slow: 300ms;` / `--ease-linear: linear;` | 两个时序原语零引用 | 动效时长梯度不齐（`--dur-*` 其余全在用） | 删 |
| `tokens.css:109` | `--fs-xl: 18px;` | 字号梯度里 XL 断档（`--fs-lg 17px` → `--fs-2xl`） | —— | 删 |
| `tokens.css:265/267/268` | `--sp-hair: 2px;` / `--sp-3h: 14px;` / `--sp-12: 48px;` | 校准案例 A 留下的三个字面量令牌，零引用 | 与 `--space-*` 体系脱钩 | 删（或改写成 `var(--space-*)` 别名） |
| `tokens.css:261/263` | `--sp-5: var(--space-5);` / `--sp-8: var(--space-8);` | 别名补齐时顺手多定义的两个，零引用 | —— | 删 |

**纯冗余（合并成一句）**：上述 28 条之外，还有约 20 条令牌只在"暗色/高对比/降透明/强制色"覆盖块里被重新赋值、但基值本身已无消费者（如 `--gl-panel-lum`、`--gl-bed-blur` 的全部覆盖点），以及 `glass.css` 里被后置块整体覆盖的重复声明（见 §6.3）——这些不单列，统一按 §7 的 P2 清理。

---

## 3. 选择器指向的类名在 TSX 里根本不存在

### 3.1 CSS 有规则、TSX 从不产出（真死 17 条）

**总结**：脚本对 582 个 CSS 类名做全量 TSX/TS token 检索，34 个缺失中有 17 个是模板字符串动态拼出的合法变体（下一小节列出），剩下 **17 条是真死**——它们要么是改名没同步，要么是被新实现取代后的旧壳。

| 文件:行号 | 原文 | 问题 | 影响 | 建议修法 |
| --- | --- | --- | --- | --- |
| `base.css:519-521` | `.field__hint--err { color: var(--danger); }` | TSX 用的是 `field__hint--danger`（`base.css:511` 自己也有这条） | 错误提示的红色其实由 `--danger` 那条兜住了，本条纯重复 | 删 |
| `glass.css:787-790` | `.dot--online { background: var(--ok); box-shadow: 0 0 0 3px color-mix(in srgb, var(--ok) 18%, transparent); }` | 状态点在 TSX 里只有 `dot--loading/--fail/--running/--offline` 四种（`SidebarShell.tsx:247-254` 的 `dotClass`），没有 `--online` | 设计里的"在线=绿点带光晕"没有实现，在线态落到 `--running`/`--offline` 的表达上 | 若"在线"是独立语义，补到 `dotClass`；否则删 |
| `glass.css:834-836` | `.dot--ok { background: var(--ok); }` | 同上，`--ok` 变体从不产出 | 死规则 | 删（与 `--online` 二选一保留） |
| `glass.css:586-588` | `.gap-strip__tick--added { animation: gap-grow var(--t-4) var(--e-decel) 1; }` | `GapStrip.tsx:106` 只产出 `gap-strip__tick--gap`，永不产出 `--added`（`glass.css:1090` 的 reduced-motion 版本一同失效） | 代码注释（585 行"新增格从 0 高长到 14px，标记 2 秒后淡出"）描述的动效从未发生 | 在 GapStrip 里补 `--added` 的判定，或删掉这两段 |
| `glass.css:241-243` | `.sb__ctx-name { font-weight: 500; white-space: nowrap; … }` | TSX 无 `sb__ctx-name` | 死规则 | 删 |
| `glass.css:291-293` | `.sb__search-label { flex: 1 1 auto; text-align: left; … }` | 已被 `.sb__search-text`（`glass.css:1141` 一带）取代 | 死规则，且与现行实现并存易误改 | 删 |
| `glass.css:353-355` | `.sb__quick-btn--busy { color: var(--fg-2); }` | TSX 无 `--busy` 变体 | 快捷按钮"忙碌态"没有样式 | 补判定或删 |
| `glass.css:708-710` | `.sb__readout-val--danger { color: var(--danger); }` | TSX 无该变体 | 延迟读数"超标变红"没实现（配合 §2 的 `--fs-readout` 死令牌，读数这块整体没落地） | 补判定或删 |
| `glass.css:761-763` | `.sb__status-empty { display: flex; align-items: center; … }` | TSX 无该类 | 状态卡"空态"没有对应实现 | 删 |
| `glass.css:1030-1032` | `.sb__quick-mini, .sb__foot { display: none; }` | `sb__foot` 在 TSX 里零命中（`1022` 的 `.sb--collapsed .sb__foot` 同样死） | 收起态底部按钮区整套是旧壳（现行收起态用 `sb__mini-*`） | 删两条 |
| `glass.css:1039-1041` | `.sb__mini-status { display: flex; flex-direction: column; … }` | TSX 无 `sb__mini-status` | 收起态"点+两位延迟数字"没有实现 | 删或补 |
| `base.css:572-576` | `.badge--mono { font-family: var(--font-mono); text-transform: none; letter-spacing: 0; }` | TSX 无 `badge--mono` | 徽标等宽变体没落地 | 删或接给插件 ID 徽标 |
| `base.css:608-610` | `.nowrap { white-space: nowrap; }` | 零命中 | 工具类无人用 | 删 |
| `base.css:612-622` | `.sr-only { position: absolute; width: 1px; … clip: rect(0, 0, 0, 0); … }` | 零命中 | 无障碍隐藏工具类无人用 —— 反过来说明界面里没有"仅供读屏"的补充文本 | 保守保留（这是标准工具类），但要知道当前无消费者 |
| `base.css:624-628` | `.row-flex { display: flex; align-items: center; gap: var(--space-2); min-width: 0; … }` | 零命中 | 布局工具类无人用 | 删 |
| `base.css:269-272` | `.icon-btn--danger:hover:not(:disabled) { … }` | 图标按钮的 danger 变体从未产出 | 删除类危险操作的红色悬停态没实现 | 补类名或删 |
| `components.css:188` | `.titlebar__logo { … }`（accent 色块 logo） | `TitleBar.tsx:81` 用的是 `titlebar__logo-img`，样式在 `titlebar.css:8`；`titlebar__logo` 是前缀假阴性但确实无完整匹配 | 属于改名残留：`components.css` 里那套 logo 尺寸/圆角规则全部无效，真正生效的只有 `titlebar.css:8-20` | 删 `components.css:183-195` 整块，或把 `titlebar__logo` 改名对齐 |

### 3.2 动态拼出的变体（不是 bug）

脚本报缺失、但逐个人工确认是模板字符串拼接的 17 条，对应关系如下（这类**不是 bug**，列出来是为了让后来者不必重查）：

| 变体族 | TSX 拼接点 | 取值来源 | 结论 |
| --- | --- | --- | --- |
| `change__act--{added,removed,updated,bundled,unbundled}` | `LogDrawer.tsx:143` `change__act--${c.action}` | `src/shared/types.ts:243` | 合法 |
| `empty--{danger,warn}` | `EmptyState.tsx:34` `` `empty empty--${tone}` `` | `EmptyState.tsx:8` `'neutral' \| 'warn' \| 'danger'` | 合法（`empty--neutral` 无规则，但那是默认态，无害） |
| `logline--{stdout,stderr,system}` | LogDrawer 渲染日志行 | `types.ts:235` `'stdout' \| 'stderr' \| 'system'` | 合法 |
| `toast--{info,success,warn,error}` | `Toasts.tsx:22` `toast--${item.level}` | `types/ipc.ts:100` | 合法 |
| `vpick__badge--{up,down,same}` | `VersionPicker.tsx:298` | `types.ts:540` `'up' \| 'down' \| 'same' \| null` | 合法 |
| `badge--` / `banner--` / `grep` 前缀 | 各组件模板字符串 | —— | 合法 |

另外 `base.css` 里被扫出的 `.w3` 是误报：来自 `glass.css:57` 的 SVG data-URI 文本 `www.w3.org`，不是类名。

> 附带发现（边界项，记入 §8）：`types.ts:243` 的 `action` 联合里有 `'unchanged'`，而 CSS 只有 5 个 `change__act--*` 变体，缺 `--unchanged`。这是"数据枚举比样式多一项"，不属本次 6 类。

### 3.3 TSX 有类名、CSS 里没有任何规则（5 条）

| 文件:行号 | 原文 | 问题 | 影响 | 建议修法 |
| --- | --- | --- | --- | --- |
| `App.tsx:155` | `<div className={`app${settings.sidebarExpanded === false ? ' app--sb-collapsed' : ''}`}>` | 全库 CSS 无 `.app--sb-collapsed`（助手是 `.sb--collapsed`，`glass.css` 里大量使用） | 根节点上的收起标记无人消费，看起来"收起态已接线"，实际靠 `.sb--collapsed` 那条链 | 删掉这个类，或把 `.sb--collapsed` 的规则挂到它上面 |
| `App.tsx:198` | ``<div className={`app__body${state.logsOpen ? ' has-logs' : ''}`}>`` | 无 `.has-logs` 规则；日志抽屉 `.logdrawer` 是 `components.css:1400` 里的 flex 子项、不是 fixed 层 | 类名纯残留 | 删 |
| `ConfirmDialog.tsx:50` | `className="overlay overlay--confirm"` | 无 `.overlay--confirm` 规则（只有 `components.css:1628` 的 `.overlay`） | 确认框与其它遮罩无差异化（圆角/边框等） | 补规则或删类名 |
| `PluginList.tsx:325` | `<span className="plist__col plist__col--main">插件</span>` | 无 `.plist__col--main` 规则（CSS 只有 `components.css:779` `.plist__col` 与 `787` `--ops`） | 列宽实际由 `grid-template-columns` 决定，类名无作用 | 删类名 |
| `PluginList.tsx:326` | `<span className="plist__col plist__col--ver">版本</span>` | 无 `.plist__col--ver` 规则，同上 | 同上 | 删类名 |

---

## 4. `data-*` / `aria-*`：CSS 消费但 React 从不设置，或反之

**总结**：CSS 侧共有 4 组属性选择器在跑（`aria-disabled`、`aria-selected`、`data-focused`、`data-theme/glass/motion/contrast`）。双向都对得上的只有 `data-focused` 与四个根级 `data-*`。**6 处错配**里 4 处是死钩子、2 处是"React 写了没人读"。

### 4.1 CSS 有选择器，React 从不设置

| 文件:行号 | 原文 | 问题 | 影响 | 建议修法 |
| --- | --- | --- | --- | --- |
| `glass.css:421-424` | `.sb__item[aria-selected='true'] { color: var(--fg-0); font-weight: 500; }` | `.sb__item` 从不带 `aria-selected`；`SidebarShell.tsx:415` 写的是 `aria-current={it.active ? 'page' : undefined}` | 侧栏选中项的文字不变色、不加粗——选中态只剩 `.gl-slider` 的位移 | 改成 `.sb__item[aria-current='page']`（与 TSX 对齐），或让 TSX 同时输出 `aria-selected` |
| `glass.css:441-444` | `.sb__item[aria-selected='true'] .sb__item-icon, .sb__item:hover .sb__item-icon { color: currentColor; }` | 同上；后半（`:hover`）有效，前半永不命中 | 选中项的图标颜色不跟随文字（`glass.css:437` 默认 `color: var(--fg-2)`） | 同上 |
| `glass.css:509` | `/* 收起态的左指示条（展开态指示条画在项内，见 .sb__item[aria-selected] 的伪元素） */` | 注释声称"展开态指示条画在 `.sb__item[aria-selected]` 的伪元素里"，但 `glass.css` 全文**不存在**该伪元素规则（`sb__item` 相关 16 处选择器无 `::before`/`::after`） | 展开态"指示条在项内"这个设计从未实现，注释还在骗人 | 删注释，或按注释实现伪元素并改成 `aria-current` |
| `base.css:137` | `.btn[aria-disabled="true"] { cursor: not-allowed; }` | 全库 tsx/ts **0 处** `aria-disabled`（按钮禁用一律用原生 `disabled`） | 后半选择器永久无效；"视觉禁用但可聚焦"的形态没人用 | 删该选择器后半，或把需要软禁用的按钮改成 `aria-disabled` |
| `version-picker.css:233-234` | `/* 预留钩子：真给某行标 aria-disabled 时就有可见反馈 */` + `.vpick__row[aria-disabled='true'] { … }` | 同上，`VersionPicker.tsx` 不产出该属性 | 预留钩子当前 0 命中 | 保留（注释已自认是预留），但要接受它是死代码 |

> 另：`Sidebar.tsx:38`/`:72` 写 `aria-current={active ? 'true' : undefined}`，而全库 CSS 无任何 `aria-current` 选择器——语义属性本身正确，只是"没有视觉消费"，不算 bug，但与本节的选中态问题同源。

### 4.2 React 设置了、CSS 从不消费

| 文件:行号 | 原文 | 问题 | 影响 | 建议修法 |
| --- | --- | --- | --- | --- |
| `SidebarShell.tsx:272` | `data-collapsed={isCollapsed ? 'true' : 'false'}` | 全库 CSS 无 `[data-collapsed]` 选择器 | 收起态靠 `.sb--collapsed` 类表达，这个属性是冗余出口（易被误认为"这里也能挂钩"） | 删，或作为唯一真源改造 `.sb--collapsed` 规则 |
| `PluginIcon.tsx:127/143/157` | `data-icon-state="loading" / "ready" / "fallback"` | 无 `[data-icon-state]` 消费者 | 图标三态的样式实际由 `plugin-icon.css` 的 `.picon-ph--loading` 等类表达 | 删属性或补选择器 |
| `PluginRow.tsx:46` | `data-plugin-name={p.name}` | 无消费者（不是 JS 钩子，`document.querySelector` 里也没用它） | 纯残留属性，会出现在 DOM 里 | 删 |

> 说明：`data-search-input`（`App.tsx:114` 的 `querySelector`）与 `data-install-input`（`SidebarShell.tsx:309`）是**给 JS 用的**，CSS 不消费属正常，不计入命中。

### 4.3 双向正常的（校准案例 B 复核：已修）

| 属性 | React 写入点 | CSS 消费点 |
| --- | --- | --- |
| `data-focused` | `TitleBar.tsx:78` `<header className="titlebar" data-focused={win.focused ? 'true' : 'false'}>` | `components.css:172`、`titlebar.css:23` |
| `data-theme` | `App.tsx:43` `root.dataset.theme = …` | `tokens.css:133` 等 |
| `data-glass` | `App.tsx:70-71` | `tokens.css:407`、`561`，`glass.css:1106` |
| `data-motion` | `App.tsx:76-77` | `tokens.css:462`、`505` |
| `data-contrast` | `App.tsx:73-74` | `tokens.css:536`、`548` |

### 4.4 语义属性无 CSS 消费（登记项，不算 bug）

| 属性 | 产出点 | CSS 消费 | 结论 |
| --- | --- | --- | --- |
| `aria-selected` | `App.tsx:211`、`App.tsx:221`（子栏页签）、`InstallPanel.tsx:86`、`VersionPicker.tsx:285` | 无 | 语义正确、视觉靠 `is-active` 类；两条 `aria-selected` 类规则（§4.1）恰好写在**另一个组件**的选择器上，才成了死规则 |
| `aria-current` | `Sidebar.tsx:38`、`Sidebar.tsx:72`（值为 `'true'`）、`SidebarShell.tsx:415`（值为 `'page'`） | 无 | 同上；注意两处取值不一致（`'true'` vs `'page'`），若将来补 CSS 消费，`.sb__item` 用 `[aria-current='page']`，旧 Sidebar 用 `[aria-current='true']` |

---

## 5. 修饰符类名：CSS 有规则，TSX 从不条件性加上

**总结**：CSS 里所有 `is-*` 修饰符（`is-active` / `is-on` / `is-valid` / `is-loading` / `is-disabled` / `is-open` / `is-fail` / `is-ok` / `is-missing` / `is-selected` / `is-updatable` / `is-unknown`）都逐一回查过 TSX，**20 处输出条件全部成立**，没有"写了但永远进不去"的。命中 2 条，都是"TSX 输出、CSS 缺规则/缺一半"的反向形态——效果同样是"看起来做了状态，实际没有视觉"。

| 文件:行号 | 原文 | 问题 | 影响 | 建议修法 |
| --- | --- | --- | --- | --- |
| `SidebarShell.tsx:414` | ``className={`sb__item${it.active ? ' is-active' : ''}`}`` | TSX 会输出 `sb__item is-active`，但全库 CSS **没有任何** `.sb__item.is-active` 规则（grep `.sb__item.is-active` 零命中；`glass.css` 里 `.sb__item` 相关 16 条选择器也不含它） | 选中态的类名是空壳；与 §4.1 的 `aria-selected` 双死叠加，侧栏选中项在展开态**没有任何颜色/字重反馈** | 二选一：把 `glass.css:421/441` 的选择器改成 `.sb__item.is-active`（改 CSS，风险最低），或改 TSX 输出 `aria-selected` |
| `EnvPanel.tsx:44` | ``className={`env${open ? ' is-open' : ''}`}`` | CSS 只有 `.env__caret.is-open`（`components.css:523`），没有 `.env.is-open` | 环境面板"打开"时容器本身没有任何样式差异，只有小三角旋转——视觉上像没生效 | 补 `.env.is-open`（行高/边框/背景任一处差异），或删掉该修饰符 |

### 5.1 全量修饰符对照表（20 处 TSX 输出 × CSS 规则点）

这张表是"零遗漏"的凭证：CSS 里每一个 `is-*` 规则都找到了自己的产出点，每一处 TSX 输出也找到了（或找不到）对应规则。

| 修饰符 | CSS 规则点 | TSX 产出点 | 结论 |
| --- | --- | --- | --- |
| `is-active`（子栏页签） | `components.css:124` `.subbar__tab:hover:not(.is-active)`、`129` `.subbar__tab.is-active`、`133` `.subbar__tab.is-active::after` | `App.tsx:212`、`222` | 正常 |
| `is-active`（安装页签） | `components.css:1231`、`1236`、`1240` | `InstallPanel.tsx:88` | 正常 |
| `is-active`（侧栏项） | **无** | `SidebarShell.tsx:414` | **§5 命中 1** |
| `is-active`（旧 Sidebar 组件） | `components.css:370` `.profiles__item.is-active`、`426` `.filters__item.is-active`、`449` 计数徽标 | `Sidebar.tsx:37`、`71` | 正常（该组件是否仍被挂载见 §8） |
| `is-on`（分段选择器） | `appearance-settings.css:90` `.apseg__opt.is-on` | `AppearanceSettings.tsx:45` | 正常 |
| `is-on`（开关） | `appearance-settings.css:160` `.apsw.is-disabled`（禁用态）+ is-on 的轨道规则 | `AppearanceSettings.tsx:445`、`107` | 正常 |
| `is-on`（壁纸格） | `appearance-settings.css:264` `.apwall__cell.is-on` | `AppearanceSettings.tsx:670` | 正常 |
| `is-on`（主题卡） | `appearance-settings.css:355` `.aptheme__card.is-on` | `AppearanceSettings.tsx:708` | 正常 |
| `is-on` / `is-unknown`（状态点） | `components.css:2174` `.dshctl__dot.is-on`、`2180` `.dshctl__dot.is-unknown`、`2246`（reduced-motion 里再声明一次） | `DshControl.tsx:116` | 正常 |
| `is-disabled`（插件行） | `components.css:864` `.prow.is-disabled`、`869-870` 悬停 | `PluginRow.tsx:31` | 正常 |
| `is-missing` | `components.css:860` `.prow.is-missing`、`870` | `PluginRow.tsx:32` | 正常 |
| `is-selected` | `components.css:851` `.prow.is-selected`、`973` 操作区 | `PluginRow.tsx:33` | 正常 |
| `is-updatable` | `components.css:856` `.prow.is-updatable .prow__name`、`958` `.prow__latest.is-updatable` | `PluginRow.tsx:30`、`97` | 正常 |
| `is-loading` | `base.css:238` `.btn.is-loading` | `ConfirmDialog.tsx:154` | 正常 |
| `is-open`（环境三角） | `components.css:523` `.env__caret.is-open` | `EnvPanel.tsx:52` | 正常 |
| `is-open`（环境容器） | **无** | `EnvPanel.tsx:44` | **§5 命中 2** |
| `is-valid`（壁纸投放） | `wallpaper-drop.css:34` `.wpdrop.is-valid .wpdrop__frame`、`67` `.wpdrop.is-valid .wpdrop__title` | `WallpaperDrop.tsx:153` | 正常（`67` 那条同值空转，见 §6.6） |
| `is-ok` / `is-fail` | `components.css:1544` `.logdrawer__result.is-ok`、`1548` `.is-fail`、`1569` / `1573` 标题 | `LogDrawer.tsx:118` | 正常 |

> 表外说明：CSS 里的 `has-*` 修饰符 **零命中**（grep `.has-` 无结果），`App.tsx:198` 的 `has-logs` 是唯一以 `has-` 命名却无规则的类（已记入 §3.3）。

---

## 6. 同一元素被拆在多文件 / 靠 import 顺序决胜负 / 特异性冲突

### 6.1 加载顺序：全部组件 CSS 都排在 `tokens/base/components/glass` **之前**

`main.tsx:9` `import { App } from './App';` 出现在 `main.tsx:11-14` 的 `import './styles/tokens.css'` / `base.css` / `components.css` / `glass.css` **之前**。ESM 会先求值 `App` 的整条依赖图（各组件自带的 CSS），所以真实产物顺序是：

`appearance-settings.css → market.css → gallery.css → plugin-icon.css → titlebar.css → wallpaper-drop.css → version-picker.css → detail.css →（tokens → base → components → glass）`

`main.tsx:2-3` 的注释声明的是"tokens → base → components → glass"，**与实际相反**。这一点不是推测，仓库里已有自证：`detail.css:11-17` 写着

```
 * ⚠ 为什么每条选择器都多带一层 `.detail`：
 * main.tsx 先 `import './App'`（第 9 行）再 `import './styles/components.css'`（第 13 行），
 * 于是**组件自己的 CSS 在产物里排在 components.css 之前** —— 上一版产物
 * out/renderer/assets/index-C28bivm5.css 里，gallery.css 的规则落在 2.2KB 处，
 * 而 components.css 的 `.detail__head` 在 85KB 处、glass.css 更靠后。
```

**影响**：任何"组件 CSS 想覆盖 base/components 里的同名规则"的写法都必须抬特异性（`detail.css` 已按此执行，写成 `.detail .detail__head`），否则静默失效。**建议**：把 `main.tsx` 的四个样式 import 提到 `import { App }` 之前，让顺序与注释一致；`detail.css` 那套 0,2,0 抬升可以保留（不冲突）。

### 6.2 跨文件同选择器同属性（真冲突 1 组）

| 文件:行号 | 原文 | 问题 | 影响 | 建议修法 |
| --- | --- | --- | --- | --- |
| `components.css:170` | `background: var(--bg-0);`（选择器 `.titlebar`，块起 159 行） | 与 `glass.css:1292` `background: transparent;`（选择器 `.titlebar`，块起 1291 行）同特异性 0,1,0 | **glass 胜**（后加载 + 同特异性）＝实际生效 `transparent`。`.titlebar` 不透明底是死声明；`glass.css:1290` 注释"壁纸要一直透到窗口最上面一行"说明透明才是设计意图 | 删 `components.css:170`，或把其降级为 `var(--bg-0)` 的兜底并注释清楚 |

### 6.3 同文件后置再声明（后写者胜，值不同）

| 文件:行号 | 原文 | 问题 | 实际生效 | 建议修法 |
| --- | --- | --- | --- | --- |
| `glass.css:1315-1321` | `@media (prefers-reduced-transparency: reduce) { .app__main.shell-main { backdrop-filter: none; -webkit-backdrop-filter: none; background: var(--bg-1); } }` | 同文件 `glass.css:1334-1344` 又用**完全相同选择器** `.app__main.shell-main` 声明了 `background: color-mix(…)` 与 `backdrop-filter: blur(…) saturate(…)`，特异性同为 0,2,0 | **1334-1344 胜**（同特异性、后出现）。系统"降低透明度"对主区**完全无效**，模糊照旧 | 把 1334-1344 那条挪到 `1315` 之前，或给 a11y 块加 `:root` 前缀抬特异性（与 `tokens.css` 的救援块同一手法）；这是本次最贵的一条，改动只是顺序 |
| `glass.css:384` → `1246` | `flex: 0 0 auto;` → `.sb__nav { flex: 1 1 auto; min-height: 0; overflow-y: auto; … }` | 后置块把导航从"不伸缩"改成"可伸缩+可滚" | 1246 胜 | 属有意重构（1247-1250 配套），建议合并进首个声明并删掉旧值，避免"读到 384 以为不可滚" |
| `glass.css:697` → `1172` | `font-size: var(--fs-num);` → `.sb__readout-val { font-size: var(--fs-body2); line-height: 1.15; }` | 后置块把"重音读数"缩回正文级字号 | 1172 胜 | 若"延迟数字要重"是设计意图，应改回 `var(--fs-readout)`（该令牌目前零引用，见 §2）；两者矛盾说明意图没落定 |
| `glass.css:867` → `1255` | `min-height: var(--sb-gap-status-user);` → `.sb__spacer { min-height: 10px; }` | 令牌退回硬编码 `10px` | 1255 胜（1254 注释说这是"下限"） | 用 `min(var(--sb-gap-status-user), 10px)` 表达意图，或直接删旧声明 |
| `glass.css:1185` → `1243` | `padding: 0 var(--sb-pad-x);` → `.sb__group-head { padding: 0; }` | 缩进由 `.sb__nav` 的 padding 统一提供（1242 注释说明） | 1243 胜 | 合并成一处，避免两处真相 |
| `glass.css:663` → `1305-1308` | `padding: var(--sp-2h) var(--sp-3);` → `padding: var(--sp-2) var(--sp-2h); gap: var(--sp-2); margin-top: var(--sb-gap-nav-status);` | 状态卡"瘦身"（1304 注释） | 1305-1308 胜 | 合并 |
| `glass.css:1270` → `1336` | `margin: var(--sb-margin) var(--sb-margin) var(--sb-margin) 0;` → `margin-left: calc(var(--sb-w-expanded) + var(--sb-margin) * 2);`（1335 注释"放在 margin 简写之后，覆盖掉那个 0"） | 简写把 margin-left 写成 0，随后再补 | 1336 胜 | 把 `0` 那处删掉即可；这类"先写坏再补"是同类静默 bug 的温床 |
| `glass.css:1297-1302` | `.app__main.shell-main .plist, .app__main.shell-main .detail, .app__main.shell-main .subbar, .app__main.shell-main .toolbar { background: transparent; }` | `.detail` 是 `.app__body` 的子节点、**与 `.app__main.shell-main` 平级**（`App.tsx:198-255` 结构；`glass.css:1353` 注释与 `1361` 的 `.app__body > .detail` 自证），所以第二行选择器**永不匹配** | 其余三行生效，`.detail` 那行是死规则 | 改成 `.app__body > .detail` |
| `glass.css:196-201` / `1118-1124` | `.sb__brand-text` 整块逐字重复 | 同一选择器同值声明两遍 | 后者胜（值相同） | 删一份 |

### 6.4 `!important` 清单（仅 2 个文件使用）

| 文件:行号 | 原文 | 用途 | 评价 |
| --- | --- | --- | --- |
| `tokens.css:192`、`474`（含 `483` `animation-name: none !important;`） | 降低动效的全局压制 | 唯一正确用法：压 `*` 的动画 | 合理 |
| `tokens.css:495`、`498`、`517` | `:root[data-motion="reduced"] .spinner, :root[data-motion="off"] .spinner { animation: … !important; }` 等 | 从 `*` 压制里"救回"加载指示器（0,3,0 压 0,2,0） | 合理，且注释说明了为何必须 `!important` |
| `gallery.css:283-286` | `.detail .gal-preview { inset: 0 !important; width: auto !important; height: auto !important; }` | 压掉 `PluginGallery.tsx:102-105` 写的内联视口坐标（`265-282` 注释说明 backdrop-filter 建立包含块导致预览层被裁） | 合理，属于"必须压内联"的合法场景 |

除上述 8 条外，全库无其它 `!important`；组件层**没有**互相压的 `!important` 战争。

### 6.5 内联变量压过样式表（P1）

`App.tsx:88-89` 每帧把 `--gl-panel-alpha`、`--gl-panel-blur` 写到根元素内联样式上：

```
put('--gl-panel-alpha', glassOff ? null : String(settings.sidebarOpacity));
put('--gl-panel-blur', …);
```

而 `tokens.css:421-431` 的 `@media (prefers-reduced-transparency: reduce) { :root { --gl-panel-alpha: 1; --gl-panel-blur: 0px; … } }` 想在这两个变量上生效——**内联样式优先级高于任何样式表规则**，所以该媒体查询里 7 个变量中有 2 个永远被压过（其余 5 个：`--gl-veil-alpha`、`--gl-panel-refract`、`--gl-hl-peak`、`--gl-bed-alpha`、`--gl-bed-blur` 仍生效）。`App.tsx:57-60` 的注释只意识到 `glassOff` 那一种情况，没有意识到独立的系统级媒体查询。**建议**：JS 侧读取 `matchMedia('(prefers-reduced-transparency: reduce)')` 后决定是否 `removeProperty`，或把透明度从内联变量改成 `data-*` 驱动的样式表规则。

### 6.6 其它"写了不生效"的死规则

| 文件:行号 | 原文 | 问题 |
| --- | --- | --- |
| `wallpaper-drop.css:151-153` | `.wpprev__fit { /* 复用设置面板里那套自动适配样式（appearance-settings.css） */ }` | 空规则，声明体为空 |
| `wallpaper-drop.css:67-69` | `.wpdrop.is-valid .wpdrop__title { color: var(--fg-0); }` | 与 `56-59` 的 `.wpdrop__title { … color: var(--fg-0); }` 同值，修饰符空转 |
| `market.css:353-355` | `.mkt__sheet:focus-visible { outline: none; }` | 只关不补：对比 `500-504` 的 `.mkt__link:focus-visible` 补了 `box-shadow: var(--ring)`；面板级焦点环被抹掉 |
| `base.css:740-743` + `745` | `.progress--indeterminate .progress__fill { width: 35%; animation: slide 1.1s var(--ease-in-out) infinite; }` + `@keyframes slide` | `PluginList.tsx:300` 只产 `progress--full`；"检查中"时进度条没有 `--full`，宽度停在 0%，`slide` 关键帧整套无人使用 |
| `base.css:301` vs `components.css:2301-2311` | `.input, .select, .textarea { … height: 30px; … }` vs `.mfst__text { … height: auto; min-height: 168px; padding: var(--space-2); }`（2306-2307 注释自认"高度和上下内边距在这里覆写"） | 跨文件同属性靠加载顺序决胜负；当前 components 在后所以成立，但顺序一变就翻车（同类隐患，非当前 bug） |
| `base.css:205` | `.btn--danger:hover { background: rgba(255, 93, 93, 0.22); }` | 唯一未走令牌的硬编码颜色，浅色主题下会偏暗 |
| `glass.css:1255` | `.sb__spacer { min-height: 10px; }` | 硬编码替代了令牌（见 §6.3） |

### 6.7 按机制复核过、判定**不是**问题的地方

写在这里是为了避免后来者重复怀疑这些点，同时给出"为什么不是"的依据。

| 疑点 | 依据 | 结论 |
| --- | --- | --- |
| `@keyframes` 会不会跨文件重名互相顶掉 | 12 个 CSS 里共 14 个 `@keyframes` 名，**无重名** | 不是问题（`slide`、`gap-grow`、`picon-breathe`、`mkt-rise`、`dot-spin` 等各自独一份） |
| 组件 CSS 会不会污染全局自定义属性 | 全库只有 3 个文件定义自定义属性：`tokens.css`（316 处）、`components.css`（5 处，全在媒体查询内：`1974`、`1984`、`1985`、`2010`、`2011`）、`market.css:14` | 基本干净；组件层没有随手定义全局令牌 |
| `plugin-icon.css` 的令牌缺失风险 | 该文件每个 `var()` 都带 hex 兜底（如 `var(--bg-3, #1b2130)`） | 即使令牌改名也不会空白，属防御性写法 |
| `tokens.css` 里 `!important` 救援块是否与压制块冲突 | 压制 `:root[data-motion="reduced"] *` 特异性 0,2,0；救援 `:root[data-motion="reduced"] .spinner` 为 0,3,0 | 有意为之且数值正确，动画指示器在降级模式下仍会转 |
| 媒体查询里的 `--detail-w` 等算不算"未定义" | `tokens.css:114-117` 有基值，媒体块只是收窄 | 不算（§1 已排除） |
| `empty--neutral` 无规则 | `EmptyState.tsx:8` 的 `'neutral'` 是默认态 | 无害，不需要补规则 |
| `data-search-input` / `data-install-input` 无 CSS 消费 | `App.tsx:114`、`SidebarShell.tsx:309` 是 `querySelector` 用的 JS 钩子 | 设计如此，不是缺陷 |
| `aria-pressed` / `aria-expanded` / `aria-busy` / `aria-live` 无 CSS 消费 | 纯语义属性 | 正常 |
| `glass.css` 里 `.app__main.shell-main` 出现 4 次是否都冲突 | `1269`（本轮之前的块）、`1334`（覆盖块）、`1211`（transition）、`1214`（reduced-motion 的 `transition: none`） | 只有 `1315` 与 `1334` 那一组是真冲突（§6.3 第一行），其余是不同属性的渐进覆盖 |
| `.sb--collapsed .sb__user` 两处声明是否冲突 | `1014` 与 `1203` 分别声明 `margin`/`width` 与 `flex-direction`/`gap`，属性不重叠 | 不冲突 |
| `.sb__group` 两处声明 | `glass.css:367` 与 `1225`，后者带注释说明是重排 | 有意覆盖，非 bug |
| `components.css` 的 `:root` 覆盖是否会被 `glass.css` 影响 | `glass.css` 不定义任何 `--detail-w/--sidebar-w/--log-h/--row-h` | 不冲突 |

---

## 7. 按严重度排序的修复清单

### P0（功能 / 可读性受损，必须修）

| # | 位置 | 问题 | 一句话修法 |
| --- | --- | --- | --- |
| 1 | `components.css:169` | `padding-left: var(--brand-x)` 引用零定义令牌、无兜底，声明被静默丢弃 | 在 `tokens.css` 补齐 `--brand-x` |
| 2 | `glass.css:421-424`、`441-444` + `SidebarShell.tsx:414-415` | 选中态两套写法全错位：CSS 等 `aria-selected`，TSX 给 `is-active` + `aria-current`，而 `is-active` 在 CSS 里零规则 | 把 CSS 两条选择器改成 `[aria-current='page']`（改 2 处 CSS 即可，不动 TSX） |
| 3 | `glass.css:1315-1321` | `prefers-reduced-transparency` 覆盖块被同文件 1334-1344 同特异性后置块整体压死 | 把 1334-1344 移到 1315 之前，或给 a11y 块抬特异性 |

### P1（设计意图没落地）

| # | 位置 | 问题 |
| --- | --- | --- |
| 1 | `tokens.css:421-431` + `App.tsx:88-89` | 系统"降低透明度"里的 `--gl-panel-alpha`/`--gl-panel-blur` 被 JS 内联值压过（7 个变量中 2 个失效） |
| 2 | `base.css:137`、`version-picker.css:234` | `aria-disabled` 钩子全库 0 产出（2 条规则永久无效） |
| 3 | `EnvPanel.tsx:44` | `is-open` 只有 `.env__caret.is-open` 一半实现 |
| 4 | `glass.css:697` vs `1172` | `.sb__readout-val` 字号被后置块缩回 `--fs-body2`，`--fs-readout`/`--fs-readout-val--danger`/`--fs-display` 全族未落地 |
| 5 | `glass.css:787/834`、`586`、`353`、`708`、`761`、`1039`、`1030` | 状态变体（online/ok/added/busy/danger/empty/mini-status/foot）CSS 有、TSX 无 |
| 6 | `base.css:740` | `progress--indeterminate` 从未产出，"检查中"无进度反馈 |
| 7 | `market.css:353-355` | `.mkt__sheet:focus-visible` 抹掉轮廓且不补替代焦点环 |
| 8 | `tokens.css:314`、`322` | `--gl-panel-lum`（3 处赋值）、`--gl-bed-blur`（5 处赋值）被降级开关写入却无人读 |
| 9 | `App.tsx:155`、`198`、`ConfirmDialog.tsx:50` | `app--sb-collapsed`/`has-logs`/`overlay--confirm` 三个类名在 CSS 里不存在 |
| 10 | `glass.css:1298` | `.app__main.shell-main .detail` 永不匹配（`.detail` 是兄弟节点） |

### P2（死代码，可清）

1. **17 条死类名**：`base.css:269/519/572/608/612/624`、`glass.css:241/291/353/586/708/761/787/834/1030/1039`、`components.css:188`（详见 §3.1）。
2. **28 条死令牌**：`tokens.css:54/55/56/65/68/94/97/109/215/230/231/233/245/246/261/263/265/267/268/282/293/312/314/322/325/333/338/350`（详见 §2）。
3. **空规则 / 同值规则**：`wallpaper-drop.css:151-153`（空体）、`wallpaper-drop.css:67-69`（与 56-59 同值）、`glass.css:196-201` 与 `1118-1124` 重复。
4. **同文件后置覆盖需合并**：`glass.css:384/1246`、`663/1305`、`1185/1243`、`867/1255`、`1270/1336`、`1297-1302`。
5. **硬编码回退**：`base.css:205` `rgba(255, 93, 93, 0.22)`、`glass.css:1255` `min-height: 10px`。
6. **`main.tsx` import 顺序**：把 4 个样式 import 移到 `import { App }` 之前，让顺序与注释一致（当前产物顺序相反，只是靠 `detail.css` 抬特异性兜住）。

---

## 8. 未核实项

| # | 事项 | 为什么查不出 |
| --- | --- | --- |
| 1 | 所有"哪条实际生效"的结论都是**CSS 层叠推演**（同特异性 + 后加载者胜），未在真机 `getComputedStyle` 上验证 | 约束禁止启动 Electron；应用有单实例锁，无法开第二个实例读 computed style。推演依据是标准级联规则，机制确定，但像素结果未目视 |
| 2 | 组件 CSS 与 `tokens/base/components/glass` 的**真实打包顺序** | 由 `main.tsx` 的 import 图推演，并用 `detail.css:11-17` 的注释与上一版产物 `out/renderer/assets/index-C28bivm5.css` 的偏移（gallery 2.2KB / components 85KB）旁证；本会话不许构建，未生成新产品核验。若将来改用 CSS 合并插件（如 `vite-plugin-css-injected-by-js` 之外的排序策略），该顺序可能变化 |
| 3 | `--brand-x` 是否由样式表之外的地方注入（扩展、注入脚本、构建期 PostCSS 替换） | 全库 grep `brand-x` 只有注释与那一处 `var()`；`App.tsx` 的 `setProperty` 清单里没有它。但不能排除运行时有第三方注入，静态手段到此为止 |
| 4 | 17 条死类名是"重构残留"还是"给未来功能预留" | 代码里只有注释能表达意图，部分（如 `sr-only`、`version-picker.css:233` 的"预留钩子"）明显是预留，部分（`sb__search-label` 已被 `sb__search-text` 取代）是残留。逐条意图无法从静态代码确证 |
| 5 | `change__act--unchanged` 缺失的实际影响 | `types.ts:243` 的 `action` 联合含 `'unchanged'`，CSS 只有 5 个变体；但无法确认运行时是否真会产出 `unchanged`（取决于主进程 diff 逻辑，不在本次 CSS 审计范围）。属 §3 的边界项，故记在此 |
| 6 | 行号随时间漂移 | 审计期间仓库被并发修改（`components.css` 2363→2380 行、`gallery.css` 15:16、`detail.css` 15:15 新增）。本报告行号对应 2026-11-02 15:19 快照；若文件已再变，以 `grep` 定位原文为准 |

---

## 附录 A：审计方法与可复现步骤

全部结论由"先建清单、再读原文"两段式得出，没有凭印象判断。

### A.1 令牌定义 / 引用差分（§1、§2 的数据来源）

```powershell
$dir = 'src\renderer\src\styles'
$defLines = @(); $refs = @()
foreach ($f in Get-ChildItem "$dir\*.css") {
  $i = 0
  foreach ($l in Get-Content $f.FullName) {
    $i++
    $m = [regex]::Match($l, '^\s*(--[A-Za-z0-9_-]+)\s*:')      # 定义：行首 --name:
    if ($m.Success) { $defLines += [pscustomobject]@{ Name = $m.Groups[1].Value; Site = "$($f.Name):$i" } }
    foreach ($r in [regex]::Matches($l, 'var\(\s*(--[A-Za-z0-9_-]+)')) {   # 引用：var(--name
      $refs += [pscustomobject]@{ Name = $r.Groups[1].Value; Site = "$($f.Name):$i" }
    }
  }
}
$defNames = $defLines.Name | Sort-Object -Unique
$refNames = $refs.Name     | Sort-Object -Unique
"DEF_NAMES=$($defNames.Count) DEF_SITES=$($defLines.Count) REF_NAMES=$($refNames.Count) REF_SITES=$($refs.Count)"
$refNames | Where-Object { $defNames -notcontains $_ }        # 未定义（§1）
$defNames | Where-Object { $refNames -notcontains $_ }        # 死令牌（§2）
```

实跑结果：`DEF_NAMES=178 DEF_SITES=322 REF_NAMES=151 REF_SITES=1723`，未定义集合 = `--brand-x`，死令牌集合 = 28 个。

### A.2 类名对 TSX 的差分（§3）

取 CSS 里所有 `.class`（排除 `0%`/`from`/`to` 这类关键帧步与 `w3` 误报），再去掉 TSX/TS 中**全部**字符串与模板字面量的并集比对：

- CSS 侧 582 个类名；缺失 34 个 → 人工剔除 17 个动态前缀后，真死 17 条。
- 动态前缀的剔除方式：对每个缺失名取最长公共前缀（如 `change__act--`），在 TSX 里 grep 该前缀并读上下文，确认是模板字符串产出。
- 假阴性校验：`titlebar__logo` 在 TSX 里以 `titlebar__logo-img` 存在，属前缀误判，已单列。

### A.3 规则冲突扫描（§6）

解析全部声明（3762 条）为 `(选择器, 属性)` 分组，同组取值不同即标记：

- **跨文件**同组冲突：1 处（`.titlebar` / `background`）。
- **同文件**后置再声明：见 §6.3（9 组，逐条读了注释判断是有意还是失误）。
- `!important` 全量清点：8 处（§6.4）。
- 媒体查询内的 `:root` 覆盖单独核对，确认基值存在（§1 末）。

### A.4 属性选择器与 TSX 交叉（§4）

CSS 侧提取 `[...]` 内的所有 `data-*` / `aria-*`，TSX 侧 grep 同名属性赋值点，双向建表（§4.1 / §4.2 / §4.3）。

### A.5 本次未使用的手段（受约束限制）

- 未启动 Electron（单实例锁）、未构建、未 `git` 操作，因此**没有**运行时的 `getComputedStyle` 实测值；
- 所有"实际生效"判断都是标准级联推演（特异性 → 先后顺序 → 内联优先），机制层面确定，像素层面未目视。

### A.6 复核建议（给下一轮执行者）

1. 先修 §7 的 3 条 P0，它们互不依赖，可以并行开三个小 PR；
2. 修 P0 第 2 条时只需改 `glass.css:421` 与 `441` 两条选择器（改成 `[aria-current='page']`），不要动 TSX，风险最低；
3. 修完 P0 后建议跑一次 `docs/css-audit.md` 的本附录 A.1/A.2 脚本做回归，确认未定义集合仍为空、死类名数量下降；
4. §6.1 的 import 顺序问题一旦修（把样式 import 提到 `import { App }` 之前），`detail.css` 的 0,2,0 抬升不会失效（抬特异性是"加法"），可保留。