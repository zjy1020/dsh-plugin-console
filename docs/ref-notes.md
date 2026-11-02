# 材质与侧边栏设计参考笔记

> 用途：给「毛玻璃 / Mica / Liquid Glass / 侧边栏」提供**可直接落到代码的数值**。
> 覆盖来源：**26 个来源 / 30 余个页面**（MS Learn 16 页、Apple HIG 6 页 + WWDC25 逐字稿 + SwiftUI 文档、NN/g、W3C WCAG 4 条、WinUI 与 androidx 官方源码 6 个文件、Raycast 手工页 + 主题站 API、Android 开发者页、Wallpaper Engine 11 页），其中**绝大部分数值已升级为一手源码真值**。
> 抓取方式：主力工具 `read_page`（Firecrawl 云端渲染，取渲染后正文），失败时退 `web_fetch`（Apple HIG 走 `developer.apple.com/.../<page>.md` 静态源），再不行用 `web_search` 找二手转述；后期 Firecrawl keyless 额度耗尽（HTTP 429）→ 全面转 `web_fetch` + 子代理直取官方源码。
> 标注约定：`[来源名]` 标一手官方文档；**（二手）** 表示第三方参考站 / 社区答复 / GitHub issue 中的非正式数值，不能当作官方默认值；**（推断）** 表示官方只给定性描述，数值是我按描述折算的估计值。凡引用 WinUI / androidx 源码的行，标 `[WinUI XAML-A/C/D]` `[WinUI AcrylicBrush.h]` `[Android Palette 源码]` 等，均为一手源码。
> 本笔记只做研究与记录，不改任何代码。

## 六个直问速查

| # | 问题 | 一句话答案 | 详见 |
|---|---|---|---|
| 1 | Mica / Acrylic 的典型不透明度与 tint 规则，各用在什么层级 | Mica = **不透明**（"an opaque, dynamic material"）长期窗口底材质，只采样壁纸一次 `[§1.1]`；Acrylic = 半透明 + 模糊 + 噪点 + tint 的**临时浮层**材质（flyout / 上下文菜单 / light-dismiss），**竖排侧栏官方建议不用** `[§1.2 §1.4]`。**真实 tint（WinUI 源码）**：暗 `TintColor #2C2C2C / TintOpacity 0.15 / TintLuminosityOpacity 0.96`、亮 `#FCFCFC / 0.0 / 0.85`；Base 变体暗 `0.5 / 0.96`、亮 `0.0 / 0.9` —— **观感几乎全靠亮度补偿 0.85–0.96，色染极轻** `[§1.23]`。层级：base 层放材质，content 层用低 alpha 纯色（`LayerFillColorDefault` 暗 30% 白 / 亮 50% 白）`[§1.1 §1.23]` | §1.1 §1.2 §1.4 §1.23 |
| 2 | Acrylic 的噪点是官方要求吗？alpha 多少 | **是官方固定层**：配方 = `translucency → blur → exclusion blend → color/tint → noise`；`AcrylicBrush` 类描述 "uses multiple effects including **blur and a noise texture**"。**一手真值（源码常量）**：`sc_blurRadius = 30.0f`（**blur 30px**）、`sc_noiseOpacity = 0.02f`（**噪点 2%**）、`sc_exclusionColor = #1AFFFFFF`（≈**10.2% 白**）、`sc_saturation = 1.25f`；噪点贴图 256×256 PNG `[§1.28]` | §1.4 §1.28 |
| 3 | 边框 alpha 与 1px 内高光 | 线宽 **1px 是官方硬值**（Win11 所有 elevation 档 stroke width = 1）`[§1.7]`；**alpha 有官方源码真值**：默认描边 暗 `#12FFFFFF`（白 7%）⇄ 亮 `#0F000000`（黑 6%）、次级 白 9.4%⇄黑 16%、卡片描边 黑 10%⇄6%、分隔线 白 8%⇄6% `[§1.23]`。**1px 内高光 = 官方本来就这么做**：`ControlElevationBorderBrush` 是竖直 `LinearGradientBrush`（`0,0→0,3`，stop 0.33 → 较亮、1.0 → 较暗，配 `ScaleY="-1"` 保证顶部恒亮）`[§1.23]` | §1.7 §1.23 §1.11 |
| 4 | 对比度阈值（壁纸/复杂底） | 正文 **≥ 4.5:1**、大字号（**≥24px 或 ≥18.5px 粗体**）**≥ 3:1**、AAA **7:1**，且**不可四舍五入**（4.499 不达标）`[§1.12]`；Apple 侧同值（≤17pt 4.5:1 ／ ≥18pt 3:1 ／ **加粗任意字号 3:1**）`[§1.19]`；**非文字元素（1px 描边、图标、状态）另按 ≥3:1 打分** `[§1.30]`。毛玻璃保底三招：让背景受控（纯色/单色）、把 blur 提到 40px+、提供「降低透明度」开关换纯色；Apple clear 变体在亮底上另加 **35% 暗化层** `[§1.11 §1.13]`。已确认「4.5:1 / 3:1」正是官方数值，不是估算 | §1.9 §1.12 §1.13 §1.19 §1.30 §5 |
| 5 | 动效时长 | **Windows 官方给足了毫秒**：面板滑入 **300ms + Default Decelerate**、滑出/淡出 **150ms + Default Accelerate**、纯淡入淡出 **83ms（Linear）** `[§1.26]`；签名动效表：进入 **167 / 250 / 333ms**、退出固定 **167ms**（"(ALWAYS combine with fade out)"）`[§1.25]`；token `ControlFaster/Fast/Normal` = **83 / 167 / 250ms** `[§1.24]`。**Apple 侧一个毫秒都不给**，只有 "Keep durations short" 与「用 fade 替代位移」`[§1.18]`。reduce motion：Windows 关 `Animation effects` / 读 `UISettings.AnimationsEnabled`，Apple 用 dissolve 替代 zoom/slide 并**去掉 blur 的进出场动画** `[§1.29 §1.19]` | §1.24 §1.25 §1.26 §1.18 §1.29 |
| 6 | Liquid Glass 动态高光 | 机制 = 环境光源照到材质几何（"highlights that **respond to geometry**"），交互时"**从指尖底下起光**"并扩散到邻近玻璃元素；设备运动只"**in some cases**"参与 —— 陀螺仪语义存在但非全场景，**官方没有公开指针坐标映射/跟随延迟参数** `[§1.17]`。工程上有 API 级证据：「高光不该一直动」= SwiftUI 的 `interactive(_:)` 是**显式开关，不打开就不响应触碰与指针** `[§1.22]`；Motion HIG 亦写明 "Don't add motion for the sake of adding motion."、触摸比触控板响应更强 `[§1.18]` | §1.16 §1.17 §1.22 |

---

## 1. 每篇来源的要点（逐篇）

**节号索引**（正文及速查表里的 `§1.N` 引用对应下表，顺序即下面各节的排列顺序）：

| 节号 | 来源 | 节号 | 来源 |
|---|---|---|---|
| §1.1 | Microsoft Learn — Mica material | §1.17 | Apple WWDC25 Session 219（Meet Liquid Glass 逐字稿） |
| §1.2 | Microsoft Learn — Fluent 材质总览 | §1.18 | Apple HIG — Motion |
| §1.3 | Fluent 2 Design System — Material | §1.19 | Apple HIG — Accessibility |
| §1.4 | Microsoft Learn — Acrylic material（细节最全） | §1.20 | Apple HIG — Color |
| §1.5 | Microsoft Learn — AcrylicBrush 类（API） | §1.21 | Apple HIG — Images |
| §1.6 | Microsoft Learn — System backdrops | §1.22 | SwiftUI — Applying Liquid Glass to custom views |
| §1.7 | Microsoft Learn — Layering & elevation | §1.23 | WinUI 3 主题资源源码实测（Common_themeresources_any.xaml） |
| §1.8 | Microsoft Learn — XAML 主题资源 | §1.24 | Microsoft Learn — Timing and easing |
| §1.9 | Microsoft Learn — 无障碍文本要求 | §1.25 | Microsoft Learn — Motion in Windows（签名动画表） |
| §1.10 | Fluent 2 Design System — Motion | §1.26 | Microsoft Learn — motion-in-practice（面板转场毫秒） |
| §1.11 | NN/g — Glassmorphism | §1.27 | Microsoft Learn（旧 WUX）— Animating pop-up UI |
| §1.12 | W3C WCAG 2.2 — SC 1.4.3 | §1.28 | WinUI 源码 — AcrylicBrush.h 实现常量 |
| §1.13 | Apple HIG — Materials | §1.29 | Windows 系统级「关闭动画」开关 |
| §1.14 | Apple HIG — Sidebars | §1.30 | W3C WCAG 2.2 — 1.4.6 / 1.4.11 / 2.3.3 |
| §1.15 | Wallpaper Engine — 官网与官方文档 | §1.31 | Raycast — 主题系统（手工页 + 主题站 API + 源码） |
| §1.16 | Apple Newsroom — Liquid Glass 发布稿 | §1.32 | Android — 动态配色官方做法（Material You） |

### Microsoft Learn — Mica material — https://learn.microsoft.com/en-us/windows/apps/design/style/mica

- **Mica 是不透明材质，不是毛玻璃**："Mica is an opaque, dynamic material." 它用桌面壁纸给**长期驻留的窗口背景**上色，视觉上把窗口和桌面连起来 `[MS Mica]`。
- **性能上只采样一次**："it only samples the desktop wallpaper once to create its visual effect." 所以用作窗口背景不会持续消耗 GPU `[MS Mica]`。
- **Mica Alt 是更强染色的变体**："Mica Alt is a variant of Mica, with stronger tinting of the user's desktop background color."，适合带标签页的标题栏；需要 Windows App SDK 1.1+ / Windows 11 build 22000+ `[MS Mica]`。
- **层级规则**：base 层用 Mica，content 层用 `LayerFillColorDefaultBrush`（原文描述为 "a low-opacity solid color"）；Mica Alt 方案下再加一层 commanding 层，用 `LayerOnMicaBaseAltFillColorDefaultBrush` `[MS Mica]`。
- **两条硬禁令**："Don't apply backdrop material more than once in an application."；"Don't apply backdrop material to a UI element."（材质是窗口级底，不能当某个控件的背景；只有当上层完全透明时才透出） `[MS Mica]`。
- **降级清单**（材质必须能被系统关掉）：高对比度模式改用系统色；关闭「透明效果」、开启 Battery Saver、低端硬件、**窗口失活**、Windows < 22000 时统一退为纯色，token 是 `SolidBackgroundFillColorBase` / `SolidBackgroundFillColorBaseAlt` `[MS Mica]`。

**可直接用的数值**：无 alpha/blur 公布；token 名 `SolidBackgroundFillColorBase`（光 #F3F3F3 / 暗 #202020，二手）、`LayerFillColorDefault`（光 #FFFFFF / 暗 #2A2A2A，二手）；层级 = 2 层（base + content），Mica Alt 时 3 层（base + content + commanding）。

### Microsoft Learn — Fluent 材质总览 — https://learn.microsoft.com/en-us/windows/apps/design/signature-experiences/materials

- **材质分两类**：occluding（acrylic、mica —— 放在交互控件下方当 base 层，可以遮挡后面内容）与 transparent（smoke —— 只压暗） `[MS Materials]`。
- **Acrylic 的定义与用途**："Acrylic is a semi-transparent material that replicates the effect of frosted glass."；原文限定了使用面：**"Acrylic is used only for transient, light-dismiss surfaces such as flyouts and context menus."** `[MS Materials]`。
- **Windows 11 把它调亮了**：Acrylic 在 Win11 更新为 "brighter and more translucent"，即更透、更亮，可读性靠下面的 exclusion blend 层兜 `[MS Materials]`。
- **Mica 的定位**：Win11 新增的 opaque 材质，"subtly tinted with the user's desktop background color"，且自带 active/inactive 两种状态（失焦自动降调） `[MS Materials]`。
- **Smoke**："always translucent black in both light and dark mode"，用于模态 dialog 背后压暗 `[MS Materials]`。
- **所有材质都 mode aware**（光/暗两套），且**本节没有公布任何 alpha / blur 数值** `[MS Materials]`。

**可直接用的数值**：无。只给了材质清单与适用范围（flyout / context menu / dialog scrim / 窗口背景）。

### Fluent 2 Design System — Material（补充来源）— https://fluent2.microsoft.design/material

- 官方层面只有四种材质：**solid / mica / acrylic / smoke**，没有第五种 `[Fluent2 Material]`。
- 用途复述："Use it for transient, light-dismiss surfaces such as popovers and menus."（acrylic） `[Fluent2 Material]`。
- **Mica 失焦行为**：窗口不活跃时 Mica "takes on a neutral color"，即丢掉壁纸染色、回到中性色 `[Fluent2 Material]`。
- 本页仍**未给任何数值**（这是 Microsoft 文档体系的一致做法：只给材质语义，不给参数） `[Fluent2 Material]`。

**可直接用的数值**：无。

### Microsoft Learn — Acrylic material（细节最全的一手页）— https://learn.microsoft.com/en-us/windows/apps/design/style/acrylic

- **两种混合模式**：**background acrylic**（透出桌面壁纸和其他窗口）与 **in-app acrylic**（应用内层叠，只在应用自己的内容上） `[MS Acrylic]`。
- **竖排侧栏明确不用 acrylic**：原文 **"For vertical panes or surfaces that help section off content of your app, we recommend you use an opaque background instead of acrylic."** 只有 NavigationView 的 Compact / Minimal 这种**浮在内容之上**的竖栏才用 in-app acrylic `[MS Acrylic]`。
- **分层禁令**："Avoid layering multiple acrylic surfaces"；Do/Don't 还写 "Don't place multiple acrylic panes next to each other because this results in an undesirable visible seam."（并排两块 acrylic 会出现可见接缝） `[MS Acrylic]`。
- **不要大面积用**："Don't put desktop acrylic on large background surfaces."；同时要求 "Do extend acrylic to at least one edge of your app"（材质要贴边，别做成悬空小块） `[MS Acrylic]`。
- **配方层序（回答噪点问题的原话）**："We started with translucency, blur, and noise to add visual depth and dimension to flat surfaces. We added an exclusion blend mode layer to ensure contrast and legibility of UI placed on an acrylic background. Finally, we added color tint for personalization opportunities." 配图说明为 "The acrylic recipe: background, blur, exclusion blend, color/tint overlay, noise" —— **噪点层是官方配方的一环，且中间夹了 exclusion blend 层专门保对比度** `[MS Acrylic]`。
- **可读性硬规则**：官方声明 "We've optimized the acrylic resources such that text meets contrast ratios on top of acrylic."；但**禁止在 acrylic 上放强调色文字** —— "these combinations are likely to not pass minimum contrast ratio requirements **at the default 14px font size**"，并建议不在 acrylic 上放超链接；自定义 tint 色/不透明度时后果自负 `[MS Acrylic]`。
- **性能与全局开关**：acrylic GPU 开销大，Battery Saver 时自动关闭；用户可在「设置 > 个性化 > 颜色」关闭「透明效果」全局禁用材质；background acrylic 在窗口失活、Xbox / HoloLens / 平板模式下替换为纯色 `[MS Acrylic]`。

**可直接用的数值**：官方**未公布** tint 的 alpha 数值；可用的硬数字只有：正文默认字号 **14px**（可读性判定的基准字号）、材质层级只能 1 层、相邻 pane 之间有接缝。

### Microsoft Learn — AcrylicBrush 类（WinAppSDK API）— https://learn.microsoft.com/en-us/windows/windows-app-sdk/api/winrt/microsoft.ui.xaml.media.acrylicbrush

- **类描述确认噪点纹理**：`AcrylicBrush` "Paints an area with a semi-transparent material that uses multiple effects including **blur and a noise texture**." `[MS AcrylicBrush]`。
- **可调参数就这几个**：`TintColor`、`TintOpacity`、`TintLuminosityOpacity`、`TintTransitionDuration`（tint 变化时的自动过渡时长）、`FallbackColor`、`AlwaysUseFallback`、`Opacity` `[MS AcrylicBrush]`。
- **`TintOpacity` 的默认值是 1.0**（属性页原文："The opacity expressed as a value between 0 and 1.0. The default value is 1.0, which is full opacity."）—— 注意这是**属性默认值**，实际观感由主题画刷里设定的值决定，不是材质本身的最终不透明度 `[MS AcrylicBrush.TintOpacity]`。
- API 页**没有列出** `TintOpacity` / `TintLuminosityOpacity` 在主题里的实际取值（需要去 WinUI 主题资源 XAML 里取，见 §1.13） `[MS AcrylicBrush]`。

**可直接用的数值**：属性取值范围 0–1.0；`TintOpacity` 属性默认 1.0；有 `TintTransitionDuration`（tint 变色动画），但官方未给推荐时长。

### Microsoft Learn — System backdrops（七种材质挂载方式）— https://learn.microsoft.com/en-us/windows/apps/develop/ui/system-backdrops

- **窗口级挂载**：`Window.SystemBackdrop = MicaBackdrop`（可选 `Kind="BaseAlt"` 即 Mica Alt）或 `DesktopAcrylicBackdrop`；Flyout / Popup / MenuFlyoutPresenter / ContentIsland **也各自带 SystemBackdrop** —— 也就是说浮层的毛玻璃是「给浮层单独挂 backdorop」，不是全局叠一层 `[MS SystemBackdrops]`。
- **Acrylic 有两种厚度**：`DesktopAcrylicController.Kind` 可取 `Base` 与 `Thin`（`DesktopAcrylicKind.Thin`）—— 这对应 WinUI 的「标准 acrylic / 薄 acrylic」两档 `[MS SystemBackdrops]`。
- **控制器只有 4 个可覆盖属性**：`FallbackColor`、`LuminosityOpacity`、`TintColor`、`TintOpacity`；一旦自定义，"it no longer applies default Light or Dark values"，必须自己跟随主题（这是很容易踩的坑） `[MS SystemBackdrops]`。
- **WinAppSDK 2.0 新增 `SystemBackdropElement`**：可在任意区域渲染材质、支持 `CornerRadius`，官方示例给的是 `CornerRadius="8"` `[MS SystemBackdrops]`。

**可直接用的数值**：圆角示例 **8**；Acrylic 两档 Kind（Base / Thin）；可覆盖参数 4 个。

### Microsoft Learn — Layering & elevation（描边就是 elevation 的载体）— https://learn.microsoft.com/en-us/windows/apps/design/signature-experiences/layering

- 描边与阴影是同一件事的两半："Shadows and contour (outlines) are used on controls and surfaces to subtly communicate an object's elevation." `[MS Layering]`。
- **Windows 11 的 elevation / stroke width 全表**（Elevation value / Stroke width）：Window 128 / 1；Dialog 128 / 1；Flyout 32 / 1；Tooltip 16 / 1；Card 8 / 1；Control 2 / 1（Hover 2 / 1，Pressed 1 / 1）；Layer 1 / 1 —— **所有层级的 stroke width 都是 1** `[MS Layering]`。
- **阴影随层级变大变软**："The higher the elevation, the larger and softer the shadow becomes."；阴影是功能性提示，不是装饰 `[MS Layering]`。
- **两层内容体系**：base 层（菜单、命令、导航）+ content 层（连续内容或卡片） `[MS Layering]`。

**可直接用的数值**：**边框线宽 1px（官方硬值，所有层级一致）**；elevation 数值阶梯 1 / 2 / 8 / 16 / 32 / 128（可当阴影强度的排序依据，官方未给 blur/offset 的单位值）。

### Microsoft Learn — XAML 主题资源（token 与字号阶梯）— https://learn.microsoft.com/en-us/windows/apps/develop/platform/xaml/xaml-theme-resources

- 主题资源实际定义在 WinUI 仓库的 `Common_themeresources_any.xaml`（github.com/microsoft/microsoft-ui-xaml/blob/main/controls/dev/CommonStyles/Common_themeresources_any.xaml），**色值必须去那里取**，文档页只给名字与用法 `[MS ThemeResources]`。
- 文档给出的示例色：Light 下 `TextFillColorPrimary = #E4000000`（alpha 0xE4 ≈ **89%**），Dark 下 `TextFillColorPrimary = #FFFFFFFF` `[MS ThemeResources]`。
- **文字色分层 = 不透明度分层**（同一套颜色不同 alpha，随主题反转），这是「在不确定底色上保可读性」的关键机制 `[MS ThemeResources]`。
- **排版 ramp（px）**：Caption 12 / Body 14 / Body Strong 14(semibold) / Body Large 18 / Subtitle 20 / Title 28 / Title Large 40 / Display 68；字体 Segoe UI Variable `[MS ThemeResources]`。

**可直接用的数值**：正文 **14px**、Caption 12px、Body Large 18px；`TextFillColorPrimary` 光 = 89% 黑。

### Microsoft Learn — 无障碍文本要求 — https://learn.microsoft.com/en-us/windows/apps/design/accessibility/accessible-text-requirements

- **Windows 平台自己的红线**："visible text must have a minimum luminance contrast ratio of **4.5:1** against its background"，对齐 WCAG G18 `[MS AccessibleText]`。
- **例外**：logo、incidental text（如失活 UI 里的文字）、纯装饰文字无对比度要求 `[MS AccessibleText]`。
- **不要把高对比度模式当成可读性的主要补救**："Do not treat high-contrast mode as the primary mitigation for low readability." `[MS AccessibleText]`。
- **不要把文字烤进图片**；系统文本缩放 `TextScaleFactor` 允许范围 **[1, 2.25]**（即文字最多放大到 225%，布局要能扛） `[MS AccessibleText]`。
- **本页没有**出现 3:1 的大字号例外阈值（要去 WCAG 1.4.3 取，见 §1.12） `[MS AccessibleText]`。

**可直接用的数值**：4.5:1；`TextScaleFactor` 1–2.25。

### Fluent 2 Design System — Motion — https://fluent2.microsoft.design/motion

- 四条 motion 原则：Functional / Natural / Consistent / Appealing `[Fluent2 Motion]`。
- **时长指导全是定性的**："Give larger elements more time to animate than smaller elements."、"Aim for a fast and smooth motion without making people wait." —— **本页没有任何毫秒数值** `[Fluent2 Motion]`。
- **四种 transition**：Enter and exit / Elevation / Top level / Container transform；其中 **Top level 明确要求用淡入淡出而不是滑动**："use a quick fade transition instead of moving or sliding UI elements around on and off the screen"（大页面切换别滑） `[Fluent2 Motion]`。
- **Enter and exit** 就是菜单、dialog 这类元素的进出场（本页只说用于 "menus, dialogs, and other interactive elements"，**未给时长**） `[Fluent2 Motion]`。
- **编排（choreography）**：staggering 与 hierarchy；"For most scenarios, a staggered animation is preferred."、"use short offsets between them"；重要元素用更长时长更明显的动作 `[Fluent2 Motion]`。
- **无障碍降级（原文可抄）**："Design for and include a 'no motion' setting for your app or website as recommended by the WCAG."、"Keep durations short and the movement natural."、"Keep the motion constrained to the element in focus."；受影响人群包括 "people with vestibular disorders, people with low vision, people who use screen readers, or people who are sensitive to visual stimuli" `[Fluent2 Motion]`。

**可直接用的数值**：无毫秒值；可用的只有「大页面切换 = fade 不 slide」「重要元素时长更长、次要元素同步」这两条结构性规则。

### NN/g — Glassmorphism: Definition and Best Practices — https://www.nngroup.com/articles/glassmorphism/

（作者 Megan Brown，2024-06-07；本笔记第五节的核心依据）

- **定义**："Glassmorphism is a visual-design style that utilizes different levels of translucency to create depth and contrast between foreground and background elements, mimicking frosted glass." 两个必备特征：**半透明 + 背景模糊**；描边/渐变只是可选增强 `[NNG]`。
- **模糊量的参考数量级（原文举例）**："a white rectangle with 30% opacity and a 25-pixel blur will distort background elements but still have somewhat distinguishable edges"，把 blur 拉到 **100px** 后背景元素会更失焦、糊成一片 —— 即 **25px = 还能看出底是什么，100px ≈ 底彻底糊掉** `[NNG]`。
- **最佳实践① Meet Contrast Requirements**："Ensure that text and graphical elements meet contrast requirements." —— 因为半透明组件会跨过**多种**底色，同一段文字可能只在部分区域达标；NN/g 建议直接在底图上用取色工具（Figma Contrast 插件）逐点验证 `[NNG]`。
- **最佳实践② More Blur Is Better**："More background blur is better, especially with intricate backgrounds (e.g., video, photography, animations)."；低不透明度 + 低模糊会同时**降低文字对比度**并让背景显得吵闹；“if you have control of what appears behind a translucent component, opt for simple or single-color backgrounds”；弹层/上下文菜单的模糊必须 "account for the many possible backgrounds on which the item may appear" `[NNG]`。
- **最佳实践③ Let Users Adjust Transparency**："give users the option to control contrast or transparency settings"；举 Apple 的 reduce transparency / increase contrast 为例，开启后 "replaces any glassmorphic component with a solid color"（毛玻璃直接变纯色） `[NNG]`。
- **兜底原话**："if your budget or time constraints do not allow this type of customization, then make sure that any glassmorphic elements in your interface are WCAG-compliant."；总体结论 "glassmorphism is best when utilized sparingly to create an illusion of depth." `[NNG]`。
- **内高光的做法来源（原文）**：在受控背景上 "add a low-opacity or gradient stroke around a component to create an illusion of thickness"，用 gradient fill "mimic the reflection of light on actual glass" `[NNG]`。

**可直接用的数值**：示例不透明度 **30%**、blur **25px**（仍可辨边）/ **100px**（背景完全糊化）；NN/g 本身**没有**给 4.5:1 这类具体数字，只说 WCAG-compliant。

### W3C WCAG 2.2 — SC 1.4.3 Contrast (Minimum) — https://www.w3.org/WAI/WCAG22/Understanding/contrast-minimum.html

- **正文阈值**：文字与文字图像 "has a contrast ratio of at least **4.5:1**" `[WCAG 1.4.3]`。
- **大字号例外**："Large-scale text and images of large-scale text have a contrast ratio of at least **3:1**"；**大字号 = 18pt 或 14pt bold**；官方换算 "1pt = 1.333px"，即 **14pt ≈ 18.5px、18pt ≈ 24px**（≥18.5px 粗体 或 ≥24px 常规 → 只需 3:1） `[WCAG 1.4.3]`。
- **不四舍五入**："4.499:1 would not meet the 4.5:1 threshold" `[WCAG 1.4.3]`。
- **AAA（1.4.6）= 7:1**，对应 20/80 视力；4.5:1 的来源是 3:1 × 1.5（20/40 视力的对比敏感度损失 ≈1.5 倍） `[WCAG 1.4.3]`。
- **例外清单**：失活的 UI 组件内文字、纯装饰、不可见文字、图片里的招牌（incidental）、logo/品牌名；但**若 logo 当交互组件用**，官方建议仍要满足对比度 `[WCAG 1.4.3]`。
- **一个对毛玻璃很有用的注记**：如果提供了让用户调整前景/背景色的机制，用户选出的低对比组合本身不算违规（原文 note 说明这类组合 "is not a violation of this Success Criterion, provided there is a mechanism that will return to the required values"） `[WCAG 1.4.3]`。
- 抗锯齿的影响：官方提示细体/异体字可能「名义达标、实际偏淡」，建议选笔画更粗的字体或留出余量 `[WCAG 1.4.3]`。

**可直接用的数值**：**4.5:1**（常规文字）/ **3:1**（≥18.5px 粗体 或 ≥24px）/ **7:1**（AAA）；`1pt = 1.333px`；阈值不可四舍五入。

### Apple HIG — Materials（Liquid Glass + standard materials）— https://developer.apple.com/design/human-interface-guidelines/materials

（抓取方式说明：Firecrawl 免费额度耗尽（HTTP 429, retry_after 86142s）导致 `read_page` 拿不到 JS 正文；改用 `web_fetch` 取 Apple 的静态 `materials.md` 源成功。页面 change log 最新条目 2026-06-08，为线上当前版。）

- **Apple 只有两类材质**："Apple platforms feature two types of materials: Liquid Glass, and standard materials."；Liquid Glass 是**动态材质**，构成浮在内容层之上的独立功能层（tab bar / sidebar 都在这一层），standard materials 负责内容层内部的视觉区分 `[Apple HIG Materials]`。
- **禁止把 Liquid Glass 用在内容层**："Don't use Liquid Glass in the content layer."；理由是内容层出现材质会造成 "unnecessary complexity and a confusing visual hierarchy"；同时 "Use Liquid Glass effects sparingly." `[Apple HIG Materials]`。
- **Liquid Glass 分 regular / clear 两个变体，侧边栏被点名用 regular**："Use the regular variant when background content might create legibility issues, or when components have a significant amount of text, such as alerts, sidebars, or popovers."；regular 的对策是 "blurs and adjusts the luminosity of background content to maintain legibility"，再叠 scroll edge effects（模糊 + 降低背景不透明度）`[Apple HIG Materials]`。
- **clear 变体只在视觉丰富背景上用**："Only use clear Liquid Glass for components that appear over visually rich backgrounds."；对 clear 还有个**具体数值**："If the underlying content is bright, consider adding a dark dimming layer of **35% opacity**." `[Apple HIG Materials]`。
- **内容层材质是四档离散档位**：iOS/iPadOS 的 standard materials = **ultra-thin / thin / regular（默认）/ thick**，官方**不给任何 opacity 百分比** `[Apple HIG Materials]`。
- **vibrancy 是可读性机制**："Help ensure legibility by using vibrant colors on top of materials."（配图对比：同一个符号用 `systemGray3` 在材质上 "difficult to see" 属 incorrect，改用 vibrant 颜色即清晰）；且**禁止**在 thin/ultraThin 上放 quaternary 层级（"because the contrast is too low"）`[Apple HIG Materials]`。
- **材质必须按语义选，不能按颜色选**："Avoid selecting a material or effect based on the apparent color it imparts to your interface, because system settings can change its appearance and behavior."；辅助功能设置（reduce transparency / increase contrast）会改变变体外观 `[Apple HIG Materials]`。
- **厚薄材质的取舍**："Thicker materials, which are more opaque, can provide better contrast for text and other elements with fine features."；"Thinner materials, which are more translucent, can help people retain their context..." `[Apple HIG Materials]`。
- **本页未给数值项**：blur radius、圆角、动画时长**均未给**；全页可抄的硬数值只有 **35% opacity 暗化层** 与四档材质名 `[Apple HIG Materials]`。

**可直接用的数值**：clear 变体背后的暗化层 **35% 不透明度**（底层明亮时）；standard materials 四档：ultra-thin / thin / regular / thick；无 blur / 圆角 / 时长数值。

### Apple HIG — Sidebars — https://developer.apple.com/design/human-interface-guidelines/sidebars

- **侧边栏定位**："A sidebar appears on the leading side of a view and lets people navigate between areas of your app or top-level collections of content..."，且需要大量空间："A sidebar requires a large amount of vertical and horizontal space." `[Apple HIG Sidebars]`。
- **侧边栏属于 Liquid Glass 层、浮在内容之上**："In iOS, iPadOS, and macOS, as with other controls such as toolbars and tab bars, sidebars can float above content in the Liquid Glass layer." `[Apple HIG Sidebars]`。
- **要求内容延伸到侧边栏下方**（本节最可直接落地的一条）："**Extend visually rich content beneath the sidebar.** ... you can extend content beneath the sidebar either by letting it horizontally scroll or by applying a *background extension effect*. A background extension effect mirrors adjacent content to give the impression of stretching it under the sidebar."（配图为正误对照：错误做法是图片在 sidebar 边缘停住）`[Apple HIG Sidebars]`。
- **默认不要藏起侧边栏**："Avoid hiding the sidebar by default to ensure that it remains discoverable."；并让显隐走平台既有手势/按钮（macOS 可在 View 菜单放 Show/Hide Sidebar） `[Apple HIG Sidebars]`。
- **层级最多两层**："In general, show no more than two levels of hierarchy in a sidebar."；超过两层改用带内容列表的 split view `[Apple HIG Sidebars]`。
- **底部不要放关键内容**："Avoid putting critical information or actions at the bottom of a sidebar."（用户移动窗口常会挡住底边）`[Apple HIG Sidebars]`。
- **图标颜色跟随用户 accent**："By default, sidebar icons use your app's accent color. In macOS, people can change the system accent color... so make sure your sidebar icons display the color people choose."；只有在有明确目的时才用固定色 `[Apple HIG Sidebars]`。
- **尺寸是离散档位**："A sidebar's row height, text, and glyph size depend on its overall size, which can be **small, medium, or large**."（可编程设置，用户也能在 General 里改）`[Apple HIG Sidebars]`。
- **相邻分栏用 1pt 分隔线**（出自 Split views 页）："The thin divider measures **one point** in width." `[Apple HIG Split views]`。
- **本页未给数值项**：blur radius、圆角、sidebar 宽高、动画时长**均未给**；也**未涉及** reduce transparency / increase contrast（该页没提）`[Apple HIG Sidebars]`。

**可直接用的数值**：sidebar 尺寸档 **small / medium / large**；分栏分隔线 **1pt**；层级 ≤ **2 层**；内容延伸用 background extension effect 或水平滚动；无 blur / 时长数值。

### Wallpaper Engine — 官网与官方文档 — https://www.wallpaperengine.io/en （+ help.wallpaperengine.io / docs.wallpaperengine.io）

（本节只摘与「壁纸如何被消费/适配」有关的部分，性能与音频参数从略；详细抓取记录见子代理报告。）

- **壁纸是桌面的一部分，不是独立窗口**："Wallpaper Engine creates wallpapers which are part of the desktop which means they are part of the Windows Explorer process." → 壁纸与 Explorer 共享同一个 GPU，且必须与 Explorer 用同一块 GPU `[WE Help: DWM]`。
- **壁纸会自动让位**：默认行为是 "Wallpaper Engine pauses itself while you are in-game."；设置项原名 `Other application fullscreen`，可取 `Keep running` / `Mute` / `Pause` / **`Stop (free memory)`**（卸载内存）`[WE Help: game]`。
- **另外五档自动降级触发**：`Other application maximized`、`Other application focused`、`Other application playing audio`、`Display asleep`、`Laptop on battery`，取值同样是 Keep running / Mute / Pause / Stop(free memory)；**官方只公开了「进游戏暂停」的默认值为暂停**，其余项目默认值来自二手移植项目 wiki（标注二手）`[WE Help / 二手]`。
- **锁屏不能跑动态壁纸**："The Windows login screen is not meant to be modified as a design decision by Microsoft."；只能拿当前壁纸的一张静态快照去覆盖锁屏图 `[WE Help: lockscreen]`。
- **官方自带主色提取 API（对「壁纸配色」最相关）**：`wallpaperRegisterMediaThumbnailListener` 一次返回 `thumbnail`（Base64 PNG）+ `primaryColor` + `secondaryColor` + `tertiaryColor` + `textColor`（文档注明 "Text color guaranteed to have sufficient contrast with primary color."）+ `highContrastColor`（"Black or white, depending on what has higher contrast with the primary color."）`[WE Docs: media]`。
- **注意方向**：这套取色是**从正在播放媒体的封面图**取色，不是「从桌面壁纸取主色给系统主题」；官方明确 Windows 端没有壁纸→系统主题的联动，Material You 式自动主题色只在 Android 端公告里出现 `[WE Docs / Steam 公告]`。
- **调色参数**：壁纸详情右侧栏可调 `brightness` / `contrast` / `saturation`，另有 `hue shift`（"allows you to completely change the colors of any wallpaper"）——即「壁纸本身作为可被消费的资源」时，官方给的是这四个参数 `[Steam 官方公告]`。

**可直接用的数值**：自动暂停/降级触发共 **6 项**；取值枚举 4 种（Keep running / Mute / Pause / Stop(free memory)）；锁屏 `Override lock screen image`（仅静态快照）；取色字段 6 个（thumbnail / primary / secondary / tertiary / text / highContrast）；颜色属性为 **Vec3，分量 0–255**。

### Apple Newsroom — Liquid Glass 发布稿 — https://www.apple.com/newsroom/2025/06/apple-introduces-a-delightful-and-elegant-new-software-design/

（2025-06-09 官方新闻稿，正文 15882 字符，`read_page` 取渲染正文成功。**全文没有任何 alpha / 百分比 / 毫秒数值**。）

- **高光的官方唯一表述**："Liquid Glass uses real-time rendering and dynamically reacts to movement with specular highlights." —— 只讲「实时渲染 + 对运动做反应」，**没有点名 pointer / gyroscope / device motion 任何一个词** `[Apple Newsroom]`。
- **颜色来自环境**："Its color is informed by surrounding content and intelligently adapts between light and dark environments."（材质本身不带固有色）`[Apple Newsroom]`。
- **它是独立功能层**："Controls are crafted out of Liquid Glass and act as a distinct functional layer that sits above apps."（与 HIG 的 "content layer" 禁令互为印证）`[Apple Newsroom]`。
- **覆盖范围**：从最小元素（buttons, switches, sliders, text, media controls）一直到 tab bars / sidebars，以及锁屏、主屏、通知、控制中心 `[Apple Newsroom]`。
- **本页未给数值**：无 alpha、无百分比、无毫秒；「高光不该一直动」之类的规定**未找到** `[Apple Newsroom]`。

**可直接用的数值**：无。只有一条可执行语义：**高光 = 实时渲染 + 随运动变化**（不是静态贴图）。

### Apple WWDC25 Session 219 — Meet Liquid Glass（官方逐字稿，问题 6 的一手来源）— https://developer.apple.com/videos/play/wwdc2025/219/

- **高光的物理模型（指针/倾斜的上位机制）**："Light sources inside of this environment shine on the material producing highlights that respond to geometry just as you'd expect." `[Apple WWDC25-219]`
- **交互时光会「在材质上流动」**："On interactions, such as locking and unlocking your phone, these lights move in space, causing light to travel around the material, defining its silhouette." `[Apple WWDC25-219]`
- **设备运动（陀螺仪等效）确实存在，但官方措辞是「某些情况下」**："And in some cases, the lighting responds to device motion, making it feel like Liquid Glass is aware of its position in the real world." —— 不是所有场景都跟陀螺仪 `[Apple WWDC25-219]`。
- **触摸点起光（指针/触摸映射的官方描述）**："When you interact with Liquid Glass, the material illuminates from within as a form of feedback." + "Starting right under your fingertips, the glow spreads throughout the element and onto any Liquid Glass elements nearby" —— **起光点是交互点，向外扩散，且会传染邻近的玻璃元素** `[Apple WWDC25-219]`。
- **阴影随底图自适应（有定性、无 alpha）**：元素感知身后内容 —— 压在文字上时 "increases the opacity of its shadow"，压在纯浅色背景上时 "lowers the opacity of its shadow" `[Apple WWDC25-219]`。
- **禁止 glass on glass**："always avoid glass on glass"、"Stacking Liquid Glass elements on top of each other can quickly make the interface feel cluttered and confusing."；且 "In steady states, such as when an app first launches, avoid intersections between content and Liquid Glass." `[Apple WWDC25-219]`
- **三个辅助功能开关的官方语义（问题 5/4 的降级依据）**：Reduce Transparency "makes Liquid Glass frostier and obscures more of the content behind it"；Increase Contrast "makes elements predominantly black or white and highlights them with a contrasting border"；Reduce Motion "decreases the intensity of some effects and disables any elastic properties for the material."；系统级开启即全局生效 `[Apple WWDC25-219]`。
- **clear 变体的三个使用前提**：元素位于媒体丰富内容之上、内容层不会被压暗层破坏、其上内容粗壮明亮；clear "is permanently more transparent"，缺压暗层时 "legibility gets noticeably worse" `[Apple WWDC25-219]`。
- **大元素不翻转明暗**："Bigger elements, like menus or sidebars also adapt based on context, but they don't flip from light to dark." `[Apple WWDC25-219]`
- **tint 的生成机制**：选色后生成一组色调，按被着色元素**下方内容的亮度**映射（"changing its hue, brightness and saturation depending on whats behind"）`[Apple WWDC25-219]`。

**可直接用的数值**：无 alpha/毫秒；可执行的三条：①高光起点 = 交互点、向外扩散；②稳态（未交互）不要有元素与内容相交；③三个系统开关都必须能被承接。

### Apple HIG — Motion（含 Liquid Glass 与输入方式的关系）— https://developer.apple.com/design/human-interface-guidelines/motion

- **唯一直接写「输入方式影响 Liquid Glass 动效强度」的官方原话**："the movement of Liquid Glass responds to direct touch interaction with greater emphasis to reinforce the feeling of a tactile experience, but produces a more subdued effect when a person interacts using a trackpad." → **触摸 > 触控板；指针悬停未被提及** `[Apple HIG Motion]`。
- **「高光不该无意义常动」的最接近依据**："Add motion purposefully, supporting the experience without overshadowing it. Don't add motion for the sake of adding motion."；"Gratuitous or excessive animation can distract people and may make them feel disconnected or physically uncomfortable." `[Apple HIG Motion]`
- **高频交互不要加动效**："In apps, generally avoid adding motion to UI interactions that occur frequently." `[Apple HIG Motion]`
- **动效必须可选、可取消**："Make motion optional."、"Let people cancel motion." `[Apple HIG Motion]`
- **唯一两个频率数值**：游戏 30–60 fps 为流畅基线；visionOS "avoid showing an oscillation that has a frequency of around **0.2 Hz**"（防持续振荡） `[Apple HIG Motion]`。
- **本页仍无毫秒时长**，也没有专门针对「面板滑入/淡入」的推荐区间 `[Apple HIG Motion]`。

**可直接用的数值**：30–60 fps（流畅基线）；**禁止约 0.2 Hz 的持续振荡**；触摸比触控板动效更强（可理解为指针设备下应该更收敛）。

### Apple HIG — Accessibility（对比度阈值与 Reduce Motion 降级清单）— https://developer.apple.com/design/human-interface-guidelines/accessibility

- **对比度阈值正式确认（问题 4）**：文本 ≤17pt 全字重 = **4.5:1**；**18pt 及以上**全字重 = **3:1**；**加粗（所有字号）= 3:1**。原文说明这是 "uses the following values from WCAG Level AA as guidance"，并写 "Strive to meet color contrast minimum standards." `[Apple HIG Accessibility]`。
- **要求用标准工具算**："Use standard contrast calculators to ensure your UI meets acceptable levels." —— **没有**「图片上的文字可以不用比例公式衡量」这类豁免表述 `[Apple HIG Accessibility]`。
- **Increase Contrast 是强制兜底**："If your app doesn't provide this minimum contrast by default, ensure it at least provides a higher contrast color scheme when the system setting Increase Contrast is turned on." `[Apple HIG Accessibility]`
- **Reduce Motion 的 5 条具体降级动作（可直接抄成 checklist）**：① "Tightening animation springs to reduce bounce effects"；② "Tracking animations directly with people's gestures"（动效直接跟手，不做补间）；③ "Avoiding animating depth changes in z-axis layers"；④ "Replacing transitions in x-, y-, and z-axes with fades to avoid motion"；⑤ "Avoiding animating into and out of blurs"（连 blur 的进出场动画都要去掉） `[Apple HIG Accessibility]`。
- **触发条件原话**："When this setting is active, ensure your app or game responds by reducing automatic and repetitive animations, including zooming, scaling, and peripheral motion." `[Apple HIG Accessibility]`
- **字号可放大下限**：理想 ≥ **200%**（watchOS ≥ 140%） `[Apple HIG Accessibility]`。

**可直接用的数值**：**4.5:1（≤17pt）/ 3:1（≥18pt，或任意字号加粗）**；文字可放大 ≥200%；Reduce Motion 下 5 类动画必须去掉（含 blur 进出场）。

### Apple HIG — Color（Liquid Glass 的着色与不透明度规则）— https://developer.apple.com/design/human-interface-guidelines/color

- **默认无固有色**："By default, Liquid Glass has no inherent color, and instead takes on colors from the content directly behind it." `[Apple HIG Color]`。
- **着色要克制，且优先给背景上色**："Apply color sparingly to the Liquid Glass material, and to symbols or text on the material."；强调主操作时 "apply color to the background rather than to symbols or text" `[Apple HIG Color]`。
- **大元素（含侧边栏）会自动变得更不透明**（问题 1/4 的交叉证据）："Liquid Glass appears more opaque in larger elements like sidebars to preserve legibility over complex backgrounds and accommodate richer content on the material's surface." `[Apple HIG Color]`。
- **小元素会自动明暗翻转，大元素不翻转**：toolbar / tab bar 这类小元素随环境在 light/dark 之间切换，符号与文字单色化；sidebar / menu 这类大元素不翻转 `[Apple HIG Color]`。
- 本页**没有**任何对比度数值，也没有 blur / 不透明度数值 `[Apple HIG Color]`。

**可直接用的数值**：无量化值。可执行语义：**面积越大 → 材质越不透明**（这正是我们侧栏该走的方向）。

### Apple HIG — Images（文本压在图片上的保底做法）— https://developer.apple.com/design/human-interface-guidelines/images

- **HIG 没有「别在图片上放文字」的通用禁令**，只对空间照片给了保底效果："Prefer the feathered glass background effect to display text over spatial photos." `[Apple HIG Images]`。
- **该保底效果的机制**："The effect adds contrast to make the text readable, and it blurs out detail to help reduce visual discomfort when people view text over spatial photos." → **同时做两件事：加对比 + 糊掉细节** `[Apple HIG Images]`。
- **分层图片的硬规则**："Generally, keep text in the foreground."；"Keep the background layer opaque."（背景层必须不透明）`[Apple HIG Images]`。

**可直接用的数值**：无。可执行语义：图上的文字要么压在**不透明**的背景层上，要么在文字后面加一层「加对比 + 糊细节」的局部玻璃（而不是全图降透明度）。

### Apple Developer — SwiftUI · Applying Liquid Glass to custom views（高光与交互的 API 层原文）— https://developer.apple.com/tutorials/data/documentation/SwiftUI/Applying-Liquid-Glass-to-custom-views.md

- **指针交互明文**："Liquid Glass is a material that blurs content behind it, reflects color and light of surrounding content, and **reacts to touch and pointer interactions in real time**." `[Apple SwiftUI LG]`
- **交互是一个显式开关**："Add `interactive(_:)` to custom components to make them react to touch and pointer interactions. This applies the same responsive and fluid reactions that glass provides to standard buttons." → **不打开 `interactive` 就没有跟随交互的响应**：这是「高光不该一直乱动」最强的官方结构性证据（虽然 Apple 从没这么写） `[Apple SwiftUI LG]`。
- **默认形态**：默认 regular 变体 + Capsule 形状；tint 用法示例 `.regular.tint(.orange).interactive()`；多个玻璃元素用 `GlassEffectContainer` 合并以避免 glass-on-glass 堆叠 `[Apple SwiftUI LG]`。

**可直接用的数值**：无量化值。可执行语义：**高光/响应做成可选开关（默认静止），只有 interactive 元素才跟随指针**。

### WinUI 3 主题资源源码实测（问题 1/3 的数值来源）— https://raw.githubusercontent.com/microsoft/microsoft-ui-xaml/main/controls/dev/CommonStyles/Common_themeresources_any.xaml

（来源代号：**A** = `CommonStyles/Common_themeresources_any.xaml`（55806 B, sha `ca07acb96…`）；**B** = `CommonStyles/Common_themeresources.xaml`；**C** = `Materials/Acrylic/AcrylicBrush_themeresources.xaml`（25216 B, sha `146524c5…`）；**D** = `CommonStyles/CornerRadius_themeresources.xaml`。写法 `token = Default(暗) / Light(亮)`。这是**官方源码而非设计规范页**，属一手但非文档；A 的 HighContrast 字典里所有 `<Color>` 字面是占位 `#FF0000`，实际走 `SystemColor*`。）

- **★ Acrylic 的真实 tint 参数（文档里查不到的答案在这里）**：`AcrylicBackgroundFillColorDefaultBrush` + `AcrylicInAppFillColorDefaultBrush` —— 暗色 **TintColor `#2C2C2C` / TintOpacity `0.15` / TintLuminosityOpacity `0.96`** / FallbackColor `#2C2C2C`；亮色 **TintColor `#FCFCFC` / TintOpacity `0.0` / TintLuminosityOpacity `0.85`** / FallbackColor `#F9F9F9` `[WinUI XAML-C]`。
  → **结论：WinUI 的「毛玻璃观感」主要来自 LuminosityOpacity 0.85–0.96（亮度补偿），色染 TintOpacity 反而是 0（亮）/ 0.15（暗）。**
- **Base 变体（更浓）**：暗 `#202020 / 0.5 / 0.96 / #1C1C1C`；亮 `#F3F3F3 / 0.0 / 0.9 / #EEEEEE`。Accent 版最浓：`TintOpacity 0.8`、`TintLuminosityOpacity` 暗 0.8 / 亮 0.9 `[WinUI XAML-C]`。
- **`AcrylicBackgroundFillColorThinBrush` 在 main 分支未找到**（只有 Default / DefaultInverse / Base + Accent 版），尽管 `DesktopAcrylicKind.Thin` 存在于 API 层 `[WinUI XAML-C]`。
- **★ 边框 alpha（官方真实值，回答「border alpha 是多少」）**：`ControlStrokeColorDefault = #12FFFFFF / #0F000000`（白 7% / 黑 6%）；`ControlStrokeColorSecondary = #18FFFFFF / #29000000`（白 9.4% / 黑 16%）；`CardStrokeColorDefault = #19000000 / #0F000000`；`DividerStrokeColorDefault = #15FFFFFF / #0F000000`；`SurfaceStrokeColorDefault = #66757575 / #66757575`（明暗同值，灰 40% alpha）；`SurfaceStrokeColorFlyout = #33000000 / #0F000000`（黑 20% / 6%）；`ControlStrongStrokeColorDefault = #8BFFFFFF / #72000000`（白 55% / 黑 45%）`[WinUI XAML-A]`。
- **★ 内高光的官方实现（1px 竖直渐变边框，问题 3 的答案）**：`ControlElevationBorderBrush` 不是纯色，而是 `LinearGradientBrush`，`MappingMode="Absolute"`、`StartPoint="0,0"`、`EndPoint="0,3"`，两个 stop：**Offset 0.33 → `ControlStrokeColorSecondary`（较亮）、Offset 1.0 → `ControlStrokeColorDefault`（较暗）**；暗色版本同一个画刷带 `ScaleTransform ScaleY="-1"` 翻转让**顶部仍是相对较亮的一侧**；`AccentControlElevationBorderBrush` 同构（0.33 → OnAccentSecondary、1.0 → OnAccentDefault）`[WinUI XAML-A]`。
  → **即官方「1px 顶部亮线」= 用竖直渐变描边做（顶亮底暗），亮色主题 = 黑 16%→6%，暗色主题 = 白 9.4%→7%。**
- **图层填充 / 材质底色（真实值）**：`LayerFillColorDefault = #4C3A3A3A / #80FFFFFF`；`LayerOnAcrylicFillColorDefault = #09FFFFFF / #40FFFFFF`；`LayerOnMicaBaseAltFillColorDefault = #733A3A3A / #B3FFFFFF`；`SolidBackgroundFillColorBase = #202020 / #F3F3F3`；`SolidBackgroundFillColorBaseAlt = #0A0A0A / #DADADA`；`CardBackgroundFillColorDefault = #0DFFFFFF / #B3FFFFFF`（暗：白 5%；亮：白 70%）；`SmokeFillColorDefault = #4D000000 / #4D000000`（黑 30%，明暗同值）`[WinUI XAML-A]`。
- **圆角（一手）**：`ControlCornerRadius = 4,4,4,4`；`OverlayCornerRadius = 8,8,8,8`（Default / Light / HighContrast 三套字典一致）；`LayerCornerRadius` **未找到** `[WinUI XAML-D]`。
- **文字色（一手）**：`TextFillColorPrimary = #FFFFFF / #E4000000`；`Secondary = #C5FFFFFF / #9E000000`；`Tertiary = #87FFFFFF / #72000000`；`Disabled = #5DFFFFFF / #5C000000`（即暗色主题下 100% / 77% / 53% / 36% 白）`[WinUI XAML-A]`。
- **明确「未找到」两项（重要，避免误以为有官方配方）**：**噪点/颗粒纹理 token 在主题 XAML 里不存在**（A 全文 `Noise` 0 命中）；**顶部内高光专用 token 也不存在**（`TopStroke` / `ControlStrokeColorTop` / `EdgeHighlight` 全 0 命中）—— 内高光只能靠上面的渐变描边实现 `[WinUI XAML-A]`。
- 其它可抄：`SystemControlTransientBorderBrush` = 黑，**Opacity 0.36（暗）/ 0.14（亮）**；B 里 `TextControlBorderThemeThickness = 1`、`TextControlBorderThemeThicknessFocused = 1,1,1,2`、`TextControlThemePadding = 10,5,6,6`、`ApplicationPageBackgroundThemeBrush → SolidBackgroundFillColorBase` `[WinUI XAML-C/B]`。

**可直接用的数值（这是本次最有价值的一组）**：Acrylic tint：暗 `#2C2C2C / 0.15 / 0.96`、亮 `#FCFCFC / 0 / 0.85`，Base 变体暗 `0.5 / 0.96`、亮 `0 / 0.9`；边框 alpha：默认描边白 7% ⇄ 黑 6%，次级描边白 9.4% ⇄ 黑 16%，卡片描边黑 10%（暗）/ 6%（亮），分隔线白 8%（暗）/ 黑 6%（亮）；材质底色 `CardBackgroundFillColorDefault` 暗 5% 白 / 亮 70% 白；Smoke 黑 30%；圆角 4（控件）/ 8（浮层）。

### Microsoft Learn — Timing and easing（动效 token 与曲线）— https://learn.microsoft.com/en-us/windows/apps/design/motion/timing-and-easing

- **官方只给 3 个控件级时长 token**（页内 "Standard animation duration values" 表）：`ControlFasterAnimationDuration` = **83ms**、`ControlFastAnimationDuration` = **167ms**、`ControlNormalAnimationDuration` = **250ms** `[MS Timing]`。
- **可直接用在自己的动画里**："WinUI 3 provides a set of standard animation durations that are used throughout the platform controls. You can use these named resources when building custom Storyboard animations as well." `[MS Timing]`
- **进入（导航/生成）用减速曲线**：Fast Out, Slow In = **`cubic-bezier(0, 0, 0, 1)`**，"Use for objects or UI entering the scene, either navigating or spawning" `[MS Timing]`。
- **退出用加速曲线**：Slow Out, Fast In = **`cubic-bezier(1, 0, 1, 1)`**，"Use for UI or objects that are exiting the scene" `[MS Timing]`。
- 本页**不含** `durationFast` / `durationNormal` / `controlFastOutSlowIn` 这些名字（那是 Fluent UI React 的命名体系），也没有进出场毫秒的不对称对照（不对称数值在 motion-in-practice，见下） `[MS Timing]`。

**可直接用的数值**：**83ms / 167ms / 250ms** 三个 token；进入 `cubic-bezier(0,0,0,1)`、退出 `cubic-bezier(1,0,1,1)`。

### Microsoft Learn — Motion in Windows（Signature experiences 的完整动画表）— https://learn.microsoft.com/en-us/windows/apps/design/signature-experiences/motion

- **"Animation properties" 表逐行原文**（用途｜曲线｜cubic-bezier｜时长｜属性）：
  - Direct Entrance｜Fast – In｜`Cubic-bezier(0,0,0,1)`｜**167, 250, 333 ms**｜Position, Scale, Rotation
  - Existing Elements｜Point to Point｜`Cubic-bezier(0.55,0.55,0,1)`｜167, 250, 333 ms
  - Direct Exit｜Fast – Out｜`Cubic-bezier(0,0,0,1)`｜**167 ms**｜原文 "(ALWAYS combine with fade out)"
  - Gentle Exit｜Soft – Out｜`Cubic-bezier(1,0,1,1)`｜**167 ms**｜Position, Scale
  - Bare Minimum｜Fade – In + Out｜Linear｜**83 ms**｜Opacity
  - Strong Entrance｜Elastic In（3 关键帧）｜K1 `(0.85,0,0,1)` 167ms；K2 `(0.85,0,0.75,1)` 167ms；K3 `(0.85,0,0,1)` 333ms
  `[MS Motion]`
- **方向不对称可确认**：进入取 167/250/333ms 三档，**退出固定 167ms**（离开永远更快） `[MS Motion]`。
- **同一入口的浮层必须同进同出**："Surfaces that share the same UI entry point should invoke and dismiss the same way"；实例原文 "All taskbar flyouts slide up when invoked, and slide down when dismissed." `[MS Motion]`。
- 五条设计原则：Connected / Consistent / Responsive / Delightful / Resourceful `[MS Motion]`。

**可直接用的数值**：进入 **167 / 250 / 333 ms**、退出 **167 ms**；纯淡入淡出 **83 ms** Linear；`cubic-bezier(0,0,0,1)`（进入）/ `cubic-bezier(1,0,1,1)`（退出）/ `cubic-bezier(0.55,0.55,0,1)`（位置变更）。

### Microsoft Learn — Animations in Windows apps（motion-in-practice：面板/浮层转场的官方推荐值）— https://learn.microsoft.com/en-us/windows/apps/develop/motion/motion-in-practice

- **★★★★ 这是全笔记唯一给出「面板转场」毫秒值的官方页（回答直问 5）**：
  - Direction **Forward In**："Slide up **150px: 300ms**; Easing: **Default Decelerate**"
  - Direction **Forward Out**："Fade out: **150ms**; Easing: **Default Accelerate**"
  - Direction **Backward Out**："Slide down 150px: **150ms**; Easing: **Default Accelerate**"
  - Direction **Backward In**："Fade in: **300ms**; Easing: **Default Decelerate**"
  `[MS MotionInPractice]`
- **即官方推荐「进入 300ms + 减速、退出 150ms + 加速」的 2:1 不对称节奏**；展开/收起同理：**Expand 300ms（Standard）／Contract 150ms（Default Accelerate）** `[MS MotionInPractice]`。
- **位移量官方示例 = 150px**（旧 WUX 文档给的是 50px，见下一条，两代数值不同） `[MS MotionInPractice]`。
- 三种落地方式："Implicit animation / Built-in animation / Custom animation following guidance recommendations"；隐式动画（`OpacityTransition` / `ScalarTransition` / `Vector3Transition` / `BrushTransition`）只覆盖 Opacity / Rotation / Scale / Translation 与 Border / ContentPresenter / Panel 的 Background `[MS MotionInPractice]`。
- 总纲："Timing, easing, directionality, and gravity work together to form the foundation of Fluent motion." `[MS MotionInPractice]`

**可直接用的数值**：**进入/滑入 300ms + Decelerate；退出/滑出 150ms + Accelerate；位移 150px**；展开 300ms / 收起 150ms。

### Microsoft Learn（旧版 WUX 文档）— Animating pop-up UI — https://learn.microsoft.com/en-us/previous-versions/windows/apps/jj649433(v=win.10)

- **浮层动画 = 淡入淡出 + 垂直位移**，位移量原文："In most cases, the translation should be **50 pixels**, moving in an upwards direction. However, if the pop-up element is displayed below the UI element that triggered the pop-up, then the translation should be 50 pixels, moving downwards." `[MS PopupUI]`
- 内建动画直接可用（不用自己写）：`PopInThemeAnimation` / `PopOutThemeAnimation` / `PopupThemeTransition`；Popup、Flyout、MenuFlyout "already have built-in library animations" `[MS PopupUI]`。
- **内置浮层时长是预置且未公开**：`PopOutThemeAnimation` 文档注明 "setting the Duration property has no effect on this object since the duration is preconfigured."（**二手**，来自搜索摘要命中 MicrosoftDocs/winapps-winrt-api） `[二手]`。
- 相关官方 API：`Windows.UI.Core.AnimationMetrics` 可读系统动画的 duration / stagger delay / z-order / 起止不透明度与缩放 / cubic Bezier 控制点 `[MS AnimationMetrics]`。

**可直接用的数值**：位移 **50px**（旧文档）；上行（触发器在上方）／下行（触发器在下方）两种方向。

### WinUI 源码 — AcrylicBrush.h 实现常量（blur / noise / exclusion / saturation 的真值）— https://raw.githubusercontent.com/microsoft/microsoft-ui-xaml/main/controls/dev/Materials/Acrylic/AcrylicBrush.h

- **官方实现常量（回答直问 2 与「blur 到底多少」）**：`sc_blurRadius = **30.0f**`、`sc_noiseOpacity = **0.02f**`、`sc_exclusionColor{26,255,255,255}`（= `#1AFFFFFF`，约 **10.2% 白**）、`sc_saturation = **1.25f**`、`sc_defaultTintColor{204,255,255,255}`（= `#CCFFFFFF`）、`sc_defaultTintOpacity{1.0}`、`sc_defaultTintTransitionDuration{**500ms**}` `[WinUI AcrylicBrush.h]`。
  → **Mica 的噪点层官方强度就是 0.02（2%）**，与 issue #2402 里官方人员的答复完全一致（那条可以升级为「源码证实」）；模糊半径真值 **30px**；额外做 **1.25 倍饱和度**提升。
- **噪点贴图实物**：`controls/dev/Materials/Acrylic/Assets/NoiseAsset_256X256_PNG.png`，**256×256** PNG（3241 B，sha1 `41de173d9014b38f8290acf270c490b37fc79a60`），由 `EnsureNoiseBrush()` 铺成 `CompositionSurfaceBrush`（另有 DPI 缩放副本） `[WinUI Assets]`。
- **WinUI 3 只有 in-app acrylic**："In WinUI 3, AcrylicBrush provides in-app acrylic only… The UWP BackgroundSource property (which enabled a HostBackdrop mode for window-level acrylic) is not available in WinUI 3." `[WinUI AcrylicBrush.h]`
- **tint 亮度不透明度可以不填**："If you don't specify a TintLuminosityOpacity value, the system will automatically adjust its value based on your TintColor and TintOpacity." → 属性页上写的默认 1.0 只是样板文字，真实生效值见 §1.19 的 0.8–0.96 `[WinUI AcrylicBrush.h]`。
- **版本漂移证据**：旧 19h1 文件里 `AcrylicBackgroundFillColorBaseBrush` 的 TintOpacity 明暗都是 `0.0`、Fallback 为 `#202020`/`#F3F3F3`；main 变成 `0.5`、`#1C1C1C`/`#EEEEEE` —— Win11 世代重调过 Acrylic Base 刷 `[WinUI AcrylicBrush.h]`。
- **动画常量（同族主题资源）**：ControlNormal **250ms** / Fast **167ms** / FastAfter **168ms** / Faster **83ms**，spline `"0,0,0,1"` —— 与 Learn 的 timing 页一致 `[WinUI XAML-A]`。
- **UWP 遗留刷（旧值，可作对照）**：`SystemControlAcrylicWindowBrush` / `…MediumHighBrush` / `…MediumBrush` 的 TintOpacity 分别是 **0.8 / 0.7 / 0.6**，TintColor = `SystemChromeAltHighColor`；Window = HostBackdrop、Element = Backdrop `[WinUI AcrylicBrush_themeresources]`。

**可直接用的数值**：**blur 30px、噪点 2%（贴图 256×256）、exclusion 层 `#1AFFFFFF`（≈10.2% 白）、saturation 1.25、tint 过渡 500ms**。

### Windows 系统级「关闭动画」开关（降级终点）— https://support.microsoft.com/en-us/accessibility/windows/make-it-easier-to-focus-on-tasks

- **Win11 路径**（原文）：Start > Settings > Accessibility > **Visual effects**，"If you don't want Windows to show animations, turn off the **Animation effects** toggle."；**Win10 路径**：Start > Settings > Ease of Access > Display，"Turn on or off the **Show animations in Windows** toggle." `[MS Support]`
- **程序读取该开关的官方 API**：`UISettings.AnimationsEnabled` —— "Gets whether animations are enabled for the user interface."，返回 "true if animations are enabled; false if not." `[MS UISettings]`
- **闪频红线（Win32 UX Guide，Seizure 节）**："**Limit use of animations.** Some users are particularly sensitive to screen movement, especially in the periphery of their visual field."；"Don't use flashing or blinking text, objects, or other elements having a flash or blink frequency in the range between **2-55 Hz**." `[MS Win32 UX]`
- 同页还要求：UI 超时用相对值（"Make UI timeout values relative to `GetDoubleClickTime()`"），别用绝对时间 `[MS Win32 UX]`。

**可直接用的数值**：闪频**禁止 2–55 Hz** 区间；降级开关 = `Animation effects` / `UISettings.AnimationsEnabled`。

### W3C WCAG 2.2 — 1.4.6 / 1.4.11 / 2.3.3（对比度与「可关闭动效」）— https://www.w3.org/WAI/WCAG22/Understanding/non-text-contrast.html

- **SC 1.4.11 Non-text Contrast（AA，本次新补，直接管我们的边框和图标）**："The visual presentation of the following have a contrast ratio of at least **3:1** against adjacent color(s): **User Interface Components**（视觉信息用于识别组件与状态）… **Graphical Objects**（理解内容所需的图形）"；豁免 inactive components 与由用户代理决定外观的组件；阈值同样不可四舍五入："2.999:1 would not meet the 3:1 threshold" `[WCAG 1.4.11]`。
  → **含义：1px 描边与图标这类「非文字」元素的对比度要在 3:1 上打分**，这比文字阈值松，但意味着**alpha 太低的描边（例如白 6%）在多数底色上是不过线的**，必须靠底色的明度差而非单靠透明度。
- **SC 2.3.3 Animation from Interactions（AAA）**："Motion animation triggered by interaction **can be disabled**, unless the animation is essential to the functionality or the information being conveyed."；三条实现：避免无必要动画、提供开关、"Take advantage of the **reduce motion** feature in the user agent or operating system"；技术 C39 / SCR40（CSS `prefers-reduced-motion`） `[WCAG 2.3.3]`。
- **SC 1.4.6 Contrast (Enhanced)（AAA）**："has a contrast ratio of at least **7:1**"，大字号 ≥ **4.5:1**；Techniques 里 Situation A（<18pt 非粗体 / <14pt 粗体）用 7:1、Situation B（≥18pt / ≥14pt 粗体）用 4.5:1 `[WCAG 1.4.6]`。

**可直接用的数值**：非文字元素（边框/图标/控件状态）**≥ 3:1**；AAA 正文 7:1、AAA 大字 4.5:1；动效必须可关闭（`prefers-reduced-motion`）。

### Raycast — 主题系统（手工页 + 主题站 API + 官方源码）— https://manual.raycast.com/themes

（三个一手来源合并：手册页 `manual.raycast.com/themes`；主题数据 API `themes.ray.so/api/themes`（返回 **106 个主题**的 JSON，50165 B）；官方仓库 `github.com/raycast/theme-explorer` 的 `lib/theme.ts` / `lib/url.ts`；另查 `manual.raycast.com/settings`。Raycast 主题功能是 **`Tier: Pro Exclusive`**、`Available on: Mac, Windows`。）

- **主题可调的就是三组颜色，且亮暗两套独立**："You can adjust the background, primary text, and support colors, which adapts across Raycast in Light and Dark mode."；Studio 支持**直接粘 hex** 或用取色器 `[Raycast Themes]`。
- **★ 主题 JSON 结构（可直接照抄的 schema，8 顶层键 + 12 颜色键）**：`{ author, authorUsername, version, name, appearance: "light"|"dark", slug, og_image, colors }`；`colors` 恰好 12 个键：`background, backgroundSecondary, text, selection, loader, red, orange, yellow, green, blue, purple, magenta`。实测 106/106 主题**这些键一个不缺**，`version` 恒为 `"1"` `[Raycast API]` `[Raycast theme-explorer]`。
- **值格式：全部是 6 位 `#RRGGBB`**，106 主题 × 12 键里非 hex 值数量 = **0**，没有 alpha / rgba / gradient 字符串。样例（Almost Cyan）：`background #000A42 / backgroundSecondary #004282 / text #FFFFFF / selection #A8C1FF / loader #00E2FF` `[Raycast API]`。
- **导入 / 导出机制（可直接借鉴的设计）**：导出双通道 —— `Copy as URL`（"Themes are shared as URLs that encode their colors, appearance, and creator information."，站点 themes.ray.so）与 `Copy as JSON`；导入走 `raycast://theme?appearance=…&name=…&version=1&author=…&authorUsername=…&colors=<12 色逗号分隔>`（`lib/url.ts` 的 `makeRaycastImportUrl`），**colors 顺序被写死**，顺序错=颜色错位 `[Raycast Themes]` `[Raycast theme-explorer]`。
- **★ 主题系统里没有「透明度 / 模糊 / 材质」这一类字段 —— 明确未找到**：JSON schema 无 opacity/blur/vibrancy/material 键；Settings 的 Appearance 段只有 `Follow System Appearance`、`Interface Size`（Default / Large / Larger）、`Window Mode`（Compact / Expanded + Show Favorites in Compact Mode），对 `transparen|blur|vibran|material|glass|gradient` 的检索**零命中** `[Raycast Settings]`。
- **透明度曾存在、后被主动删掉（很有说服力的先例）**：`convertLegacyColorIfNeeded()` 遇到 8 位 hex 会砍后两位 —— `if (value.length === 8) return '#' + value.slice(0, -2)`，即旧格式 `#RRGGBBAA` 被降级成 `#RRGGBB`；仓库里 `lib/alpha.ts` 存在而 `lib/opacity.ts` 是空文件 `[Raycast theme-explorer]`。
- **发布是纯 PR 流程**：主题以 `/themes/<username>/<theme-name>.json` 提交 Pull Request，再跑 `npm run generate-og-images` 生成预览图（仓库已迁至 `raycast/ray-so`）`[Raycast theme-explorer]`。
- **未找到**：background **gradient 的 JSON / URL 编码格式**（Studio 里能设 gradient，但 106 个 store 主题的 `background` 全是单色，schema 也只声明 `background: string`）；主题**本地磁盘路径与文件名**；Store 的**正式审核/字段校验规则**。

**可直接用的数值**：主题 JSON = **8 顶层键 + 12 颜色键**；颜色格式 **6 位 hex（无 alpha）**；`version` 恒 `"1"`；`appearance` 仅 `light|dark`；导入参数只有 4 个会被校验（appearance / name / version / colors）。

### Android — 动态配色官方做法（Material You）— https://developer.android.com/develop/ui/views/theming/dynamic-colors

（合并一手来源：官方页（Last updated 2026-10-28）、`m3.material.io/styles/color/system/how-the-system-works`、`m3.material.io/styles/color/roles`、`palette` API 文档、androidx `Palette.java`/`Target.java` 源码、Compose `DynamicTonalPalette.android.kt` 源码、MCU 0.4.0 `color_spec_2021.js`/`contrast_curve.js` 源码。这是「从图片/壁纸提取配色」最完整的一套官方流水线。）

- **四步流水线（原文）**：① "The system detects the main colors in the selected wallpaper image and extracts a *source* color." ② "…extrapolate five key colors known as *Primary*, *Secondary*, *Tertiary*, *Neutral*, and *Neutral variant*." ③ "…interprets each key color into a tonal palette of **13 tones**." ④ "…derive five different color schemes" `[Android DynamicColors]`。
- **计数关系**：**1 个 source color → 5 个 key color → 每板 13 个 tone → 5 套 scheme**；tone 规则 "given a number from **0 to 100 in increments of 10, as well as 95, 98, and 99**"（源码 `mc3_palette` 实际字段是 `0,10,…,90,95,99,100`，**不含 98**），"Tonal values range from **0 (black)** to **100 (white)**" `[Android DynamicColors]` `[M3 System]` `[Compose M3 源码]`。
- **角色→tone 的官方举例**："the algorithm assigns the color tone **primary40** to the **primary** role and the tone **primary100** to the **on primary** role."；离屏/应用内取色也一样，还可选三种取源：壁纸 / 应用内内容 / 手选 `[M3 System]`。
- **★ 可读性的官方硬指标（对我们的侧栏/浮层直接适用）**："The color system is built on **accessible color pairings**. These color pairs provide an accessible minimum **3:1 contrast**."；桌面侧的 4.5:1 是文字要求，**组件配对/容器对底色的底线是 3:1** `[M3 Roles]`。
- **★ 对比度三档（官方口径 + 源码实现）**：文档写 **Medium = 最低 3:1、High = 7:1**、Standard 为默认；源码里 `ContrastCurve(low, normal, medium, high)` 对应 `contrastLevel = -1.0 / 0.0 / **0.5** / **1.0**`，每个角色有自己的曲线，例如 `primary (3, 4.5, 7, 7)`、`onSurface (4.5, 7, 11, 21)`、`onSurfaceVariant (3, 4.5, 7, 11)`、`outline (1.5, 3, 4.5, 7)`、`outlineVariant (1, 1, 3, 4.5)` —— **即同一角色的「标准」目标就是 4.5:1（文字类）/ 3:1（次要文字）/ 更低的 1.5–3:1（描边与分隔线）** `[M3 System]` `[MCU 源码]`。
- **★ 分隔线的官方立场（回答直问 3 的关键交叉证据）**：`Outline variant` 被官方指定用于 "dividers, **and when other elements provide 4.5:1 contrast**"，其对比度曲线是 `(1, 1, 3, 4.5)` —— **分隔线/描边本身可以远低于 3:1，前提是其它元素（文字）已经满足 4.5:1** `[M3 Roles]` `[MCU 源码]`。
- **surface 阶梯的官方 tone 值（可当「层级用亮度差而非阴影」的量化依据）**：Light —— `surfaceBright 98 / surfaceDim 87 / containerLowest 100 / Low 96 / base 94 / High 92 / Highest 90`；Dark —— `Bright 24 / Dim 6 / Lowest 4 / Low 10 / base 12 / High 17 / Highest 22`；`surfaceTint = primary40(light) / primary80(dark)` `[Compose M3 源码]`。
- **Surface 从 tone 99 改到 98、中性板 chroma 从 4 提到 6**（2025-05 更新原文："Updated the default light theme surface from tone 99 to tone 98"、"increasing it from 4 to 6"），并用 tone-based surface **取代**旧的 elevation overlay（+1…+5）`[M3 Overview]`。
- **从图片取色的具体 API 与默认参数**：`Palette.from(Bitmap).maximumColorCount(16).resizeBitmapArea(12544).generate()`；六种 profile（Vibrant / Vibrant Dark / Vibrant Light / Muted / Muted Dark / Muted Light）；`getDominantSwatch()` = "the swatch with the **greatest population (frequency)**" `[Palette API]`。
- **★ Palette 源码默认值与权重（可照搬到我们自己的取色代码）**：`DEFAULT_CALCULATE_NUMBER_COLORS = 16`、`DEFAULT_RESIZE_BITMAP_AREA = 112 * 112 = 12544`、`MIN_CONTRAST_TITLE_TEXT = 3.0f`、`MIN_CONTRAST_BODY_TEXT = 4.5f`；打分权重 `WEIGHT_SATURATION 0.24 / WEIGHT_LUMA 0.52 / WEIGHT_POPULATION 0.24`（**亮度权重最大**）；剔除过黑/过白 swatch 的阈值 `BLACK_MAX_LIGHTNESS 0.05f`、`WHITE_MIN_LIGHTNESS 0.95f`；调参建议 "For landscapes, good values are in the range **10-16**. For images which are largely made up of people's faces then this value should be increased to **~24**" `[androidx Palette 源码]` `[Palette API]`。
- **品牌色协调只动 tone 不动色相**：`HarmonizedColors.applyToContextIfAvailable(Context, …)` 的作用是 "shift the tone of custom colors … accessible contrast" `[Android DynamicColors]`。
- **版本分叉（同机不同值的坑）**：Compose 源码里 `SDK_INT >= 34` 走 chroma6 的 neutral 板，`31-33` 用 `neutralVariant`(chroma 8) 充当 surface；34+ 直接读系统主题 `mc3_light_scheme`/`mc3_dark_scheme` `[Compose M3 源码]`。
- **角色数量**："There are **26 standard color roles** organized into six groups: primary, secondary, tertiary, error, surface, and outline"，含扩展角色时 **45 个** `[M3 Roles]`。

**可直接用的数值**：source 1 → key 5 → tone 13 → scheme 5；组件配对底线 **3:1**、对比档 medium 3:1 / high 7:1；角色对比度曲线示例 `primary (3,4.5,7,7)`、`onSurface (4.5,7,11,21)`、`outline (1.5,3,4.5,7)`、`outlineVariant (1,1,3,4.5)`；取色默认 `16` 色 / 采样面积 `12544`；权重 `0.24 / 0.52 / 0.24`。

### 二手参考（不能当官方默认值）

- **fluent2 / WinUI token 合成色值（二手）** — https://abacktools.com/tools/design/color-tools/windows-11-colors 。该站自述 "checked October 2026; some entries are approximations"、"Control, material, link and divider values are approximations"。可用值：`TextFillColorPrimary` 光 #E4000000（89%）/ 暗 #FFFFFFFF；`TextFillColorSecondary` 光 #9E000000（62%）/ 暗 #C5FFFFFF（77%）；`TextFillColorTertiary` 光 #72000000（45%）/ 暗 #87FFFFFF（53%）；`TextFillColorDisabled` 光 #5C000000（36%）/ 暗 #5DFFFFFF（36%）；`CardBackgroundFillColorDefault` 光 **#B3FFFFFF（70% 白）** / 暗 #2A2A2A；`AcrylicBackgroundFillColorDefault` 光 rgb(246,246,246) / 暗 rgb(44,44,44)；`MicaBackgroundFillColorDefault` 光 rgb(243,243,243) / 暗 rgb(32,32,32)；`SolidBackgroundFillColorBase` 光 #F3F3F3 / 暗 #202020；`LayerFillColorDefault` 光 #FFFFFF / 暗 #2A2A2A；`DividerStrokeColorDefault` 光 #E0E0E0 / 暗 #444444；`FocusStrokeColorDefault` 光 #005A9E `[abacktools（二手）]`。
  - 同页 FAQ 的**未证实**说法："Mica … uses approximately 30-40% wallpaper colour mixed with a base neutral" —— 在一手文档里**未找到**对应数值，仅作参考 `[abacktools（二手）]`。
- **Acrylic 噪点层 = 2% 不透明度（二手，官方团队口头答复）** — github.com/microsoft/microsoft-ui-xaml/issues/2402 中官方人员回复："Acrylic's noise texture actually has an alpha of 100%, but when it is layered onto the surface, that layer is set to 2%." → 噪点贴图本身 100% alpha，**叠加时降到 2%**；社区（Reddit r/Windows11）补充其作用是 "make color banding less noticeable" `[microsoft-ui-xaml #2402（二手）]`。
- **Fluent UI React v9 motion tokens 时长档位（二手）** — https://storybooks.fluentui.dev/react/?path=/docs/motion-tokens--docs 列出 Duration 档：**50 / 100 / 150 / 200 / 250 / 300 / 400 / 500 ms**（JS 侧如 `motionTokens.durationFast`）；该页示例把 duration 与 curve 混排，取用时注意区分 `[Fluent UI v9（二手）]`。
- **UWP AcrylicBrush 示例里出现过的 tint 值（二手，仅示例非默认）**：`TintOpacity="0.8"`、`TintLuminosityOpacity="0.5"`（UWP 文档示例代码）；社区常引的 "TintOpacity 0.5 / TintLuminosityOpacity 0.8" 属流传值，**未在任何一手来源确认** `[社区（二手）]`。
- **其它动效时长参考（二手）**：Material Design 3 easing-and-duration 列 Emphasized accelerate 200ms（退出屏幕）、Standard 300ms（屏内开始与结束）、Standard decelerate 250ms（进入屏幕）；UX Stack Exchange 讨论称 "The sweet spot that shows up time after time in game and UI design is 250-300ms"（弹性动作 400–500ms）；Telerik Kendo token：brief 100 / rapid 200 / swift 250 / speedy 300 / brisk 350 / moderate 500 / measured 550 ms `[二手汇总]`。

---

## 2. 跨来源共识（所有规范都同意的）

1. **材质 = 分层，不是装饰**。Microsoft 明确「base 层放材质、content 层用低不透明度纯色」，并禁止 "apply backdrop material more than once" 和禁止把材质贴到 UI 元素上 `[MS Mica]`；Apple / NNG 也都把毛玻璃定位为**制造深度**的手段而非背景纹理 `[NNG]`。
2. **毛玻璃只适合临时、可关闭、面积小的表面**。MS："Acrylic is used only for transient, light-dismiss surfaces such as flyouts and context menus." `[MS Materials]`；"Don't put desktop acrylic on large background surfaces." `[MS Acrylic]`；NNG："glassmorphism is best when utilized sparingly to create an illusion of depth." `[NNG]`。
3. **常驻的竖排侧栏不该用毛玻璃**。MS 原文直接推荐竖栏/分隔内容的面板 "use an opaque background instead of acrylic" `[MS Acrylic]`；只有浮在内容之上（Compact/Minimal）的导航才用 in-app acrylic `[MS Acrylic]`。
4. **模糊不够时要靠对比度兜底，且对比度是硬指标**。MS 侧栏自己的红线是 4.5:1 `[MS AccessibleText]`，WCAG 给出 4.5:1 / 3:1（大字号）/ 7:1（AAA）三级 `[WCAG 1.4.3]`；NNG 把「满足对比度要求」列为毛玻璃第一条最佳实践 `[NNG]`。
5. **背景越复杂，模糊要越大**。NNG："More background blur is better, especially with intricate backgrounds" `[NNG]`；MS 的做法则是加一层 exclusion blend "to ensure contrast and legibility of UI placed on an acrylic background" `[MS Acrylic]` —— 两家用不同机制解决同一个问题。
6. **必须给用户关闭透明度的开关**。MS：用户可在「设置 > 个性化 > 颜色」关闭透明效果全局禁用，且 Battery Saver 自动关闭 `[MS Acrylic]`；NNG 列为第三条最佳实践，并点名 Apple 的 reduce transparency / increase contrast 会把毛玻璃变纯色 `[NNG]`；Fluent 2 要求提供 "no motion" 无障碍开关 `[Fluent2 Motion]`。
7. **描边是 1px 且是有语义的**。Windows 11 所有 elevation 档位 stroke width = 1 `[MS Layering]`；NNG 把 low-opacity / gradient stroke 当作制造「厚度感」的标准手法 `[NNG]`。
8. **不要在材质上放大面积彩色文字**。MS："Don't place accent-colored text over acrylic surfaces."，并解释了原因（默认 14px 下很可能过不了最小对比度） `[MS Acrylic]`；WCAG 的 4.5:1 就是这条的量化版本 `[WCAG 1.4.3]`。
9. **毛玻璃配方里「噪点」是固定一环，但强度极小（2%）**：WinUI 源码常量 `sc_noiseOpacity = 0.02f` + 256×256 噪点贴图 `[WinUI AcrylicBrush.h]`；MS 文档把 noise 写进配方 `[MS Acrylic]`，官方团队答复也是 2% `[microsoft-ui-xaml #2402（二手）]` —— **三方一致：有噪点，但只有 2%**。
10. **描边一律 1px，且官方是用「竖直渐变」而不是纯色描边**：Win11 全部 elevation 档 stroke width = 1 `[MS Layering]`；`ControlElevationBorderBrush` 用 `LinearGradientBrush`（stop 0.33 较亮 → 1.0 较暗）配 `ScaleY="-1"` 保证顶部恒亮 `[WinUI XAML-A]`；NNG 也推荐 low-opacity / gradient stroke 来造厚度感 `[NNG]`；Apple 的分栏分隔线同样是 **1pt** `[Apple HIG Split views]`。
11. **「退出比进入快」是两家的共同节奏**：MS 签名动效进入 167/250/333ms、退出固定 167ms `[MS Motion]`；MS 面板转场进入 300ms / 退出 150ms `[MS MotionInPractice]`；Apple 侧虽无毫秒，但同样要求 "Keep durations short and the movement natural." 且高频交互不加动效 `[Apple HIG Motion]`。
12. **动效必须可关闭，且关闭后要能保住信息**：Fluent 2 要求提供 "no motion" 设置 `[Fluent2 Motion]`；Apple 要求 "Make motion optional."/"Let people cancel motion." `[Apple HIG Motion]`；WCAG 2.3.3（AAA）要求交互动效可禁用，技术是 `prefers-reduced-motion` `[WCAG 2.3.3]`；Windows 提供系统级 `Animation effects` 开关与 `UISettings.AnimationsEnabled` `[MS Support]` `[MS UISettings]`。
13. **「非文字元素」另有一条 3:1 底线**：WCAG 1.4.11 要求 UI 组件与图形对象对相邻色 **≥3:1** `[WCAG 1.4.11]`；Material 3 说其配色对（角色配对）保证 "an accessible minimum **3:1** contrast" `[M3 Roles]`；Palette 源码里 `MIN_CONTRAST_TITLE_TEXT = 3.0f` 也对应这档 `[androidx Palette 源码]`。**但分隔线可以低于它**：M3 明说 `Outline variant` 用于分隔线，条件是"其它元素已提供 4.5:1" `[M3 Roles]`。
14. **透明/材质类参数「不该做进主题系统」有先例**：Raycast 主题 JSON 只有 12 个不透明 hex 键，旧格式的 8 位 alpha 被主动截断，Settings 里也没有任何透明度/模糊偏好 `[Raycast theme-explorer]` `[Raycast Settings]`。

---

## 3. 冲突点（来源之间说得不一样的）

1. **「更多模糊」还是「更少使用」**
   - NNG 的立场：**More Blur Is Better**，"More background blur is better, especially with intricate backgrounds"；反对「低不透明度」，因为那会同时降低文字对比度并让背景显得吵 `[NNG]`。
   - Microsoft 的立场：不讨论模糊量级，而是**限制使用面**（只在临时表面、不要大面积、不要并排、竖栏用不透明）+ 用 exclusion blend / 优化过的资源保证文字达标 `[MS Acrylic]`。
   - 冲突实质：NNG 认为「做得更糊」能救场；MS 认为「不该出现在那里」才是解法。**落到我们的参数表：面积大的侧栏按 MS（不透明），临时浮层按 NNG（blur 加大到 40px+ 并压底色）。**

2. **Mica 到底是不是「毛玻璃」**
   - MS 明确 Mica 是 **opaque**（"an opaque, dynamic material"）`[MS Mica]`；Fluent 2 也把它归到遮蔽型材质 `[Fluent2 Material]`。
   - 但第三方参考站把 Mica 描述成和 Acrylic 并列的材质并给「壁纸色 30–40% 混合中性底」这类配方（二手）`[abacktools（二手）]`，容易被误读成半透明。
   - 结论：**按 MS 一手说法，Mica 是不透明的**；「30–40% 壁纸色」的说法在一手来源里**未找到**。

3. **Acrylic 的 tint / 不透明度：文档空白，源码有值（本条的冲突已被解决）**
   - MS 文档正文**没有任何 alpha 数值**，只给属性名（`TintOpacity` / `TintLuminosityOpacity`）`[MS Acrylic]` `[MS AcrylicBrush]`；属性页说 `TintOpacity` 默认 `1.0`，但那只是 API 样板默认值 `[MS AcrylicBrush.TintOpacity]`。
   - 社区流传「TintOpacity 0.5 / TintLuminosityOpacity 0.8」，**与官方源码对不上** `[社区（二手）]`。
   - **官方源码真值**：暗 `#2C2C2C / 0.15 / 0.96`、亮 `#FCFCFC / 0.0 / 0.85`，Base 变体暗 `0.5 / 0.96`、亮 `0.0 / 0.9` `[WinUI XAML-C]`；且 `AcrylicBrush.h` 的 `sc_defaultTintColor = #CCFFFFFF`、`sc_defaultTintOpacity = 1.0` `[WinUI AcrylicBrush.h]`。
   - 结论：**以源码为准 —— WinUI 的毛玻璃「色染极轻、亮度补偿极重（0.85–0.96）」**；文档口径的空白不代表没有值，只是没公布。

4. **动效时长：一家给足、一家一个数都不给（本条的冲突已被解决）**
   - 「Fluent 2 只给定性描述」仍然成立 `[Fluent2 Motion]`，但**同属 Microsoft 的 Learn 文档给了精确值**：进入 300ms + Decelerate、退出 150ms + Accelerate、纯 fade 83ms、进入档 167/250/333ms、退出固定 167ms `[MS MotionInPractice]` `[MS Motion]` `[MS Timing]`。
   - Fluent UI React v9 token 给 50–500ms 八档，**与官方 token 不冲突**（167/250 可映射到 durationFast/Normal 附近）`[Fluent UI v9（二手）]`；第三方设计系统的「200–300ms 最佳区间」更接近 Apple 的"brief"口径 `[二手汇总]`。
   - **Apple 完全不给毫秒**，只给"Keep durations short"、30–60 fps、以及禁用 ~0.2 Hz 持续振荡 `[Apple HIG Motion]`。
   - 结论：**Windows 侧直接采用官方 300 / 150ms 的 2:1 不对称**；Apple 侧只能靠定性判断，两者不构成数值冲突，只是详细程度不同。

5. **大字号对比度阈值有没有 Windows 官方背书**
   - WCAG 1.4.3 给了「18pt / 14pt bold → 3:1」的例外 `[WCAG 1.4.3]`；Apple 也确认同样阈值（并额外声明「加粗任意字号 = 3:1」）`[Apple HIG Accessibility]`。
   - Microsoft 的无障碍文本要求页**只写了 4.5:1**，没有写 3:1 例外 `[MS AccessibleText]`。
   - 结论：**在 Windows 目标上按 4.5:1 执行更安全**；要放松到 3:1 需引 WCAG 或 Apple HIG，而非 MS 文档。

6. **侧边栏能不能让内容透出来（两家方向相反，本笔记最值得注意的冲突）**
   - **MS**：竖排侧栏/分隔内容的面板 "we recommend you use an **opaque background** instead of acrylic"；只有浮在内容之上（NavigationView Compact/Minimal）的竖栏才用 in-app acrylic `[MS Acrylic]`。
   - **Apple**：侧边栏属于 Liquid Glass 层、"sidebars **can float above content** in the Liquid Glass layer."，并且要求 **"Extend visually rich content beneath the sidebar."**（用水平滚动或 background extension effect 镜像相邻内容）`[Apple HIG Sidebars]`；同时大元素（含 sidebar）会自动 **"more opaque"** 以保可读性 `[Apple HIG Color]`。
   - 冲突实质：**Apple 要「内容从侧栏下方穿过 + 材质更不透明」；MS 要「侧栏就用不透明纯色」**。落到我们项目：单用户本地工具没有 macOS 那种「照片铺满窗口」的文化，但可以取中间路线 —— **侧栏用不透明底，浮层用材质**；若将来做「内容延伸到侧栏下」，必须同时把侧栏底色提到接近不透明（Apple 的做法）。

7. **关闭透明度之后的行为，两家并不一样（容易误读）**
   - MS：材质退为系统纯色（`SolidBackgroundFillColorBase` 等），高对比度模式用系统色 `[MS Mica]` `[MS Acrylic]`；NNG 的描述也是"replaces any glassmorphic component with a solid color" `[NNG]`。
   - Apple：**Reduce Transparency 是把 Liquid Glass 变得更"frostier"（更糊、更遮挡），不是变纯色**；变纯黑/纯白并加对比描边的是 **Increase Contrast**（"makes elements predominantly black or white and highlights them with a contrasting border"）`[Apple WWDC25-219]`。
   - 结论：NNG 对 Apple 行为的转述**不精确**；我们实现时按「降低透明度 = 底变不透明纯色」+「提高对比 = 文字变纯黑/纯白 + 加描边」两个独立开关来设计更稳妥。

8. **描边/分隔线到底该多亮（三家给的范围一致，但定性不同）**
   - MS 源码的真值范围：默认描边 alpha 6–7%、次级 9.4–16%、卡片描边 6–10%、分隔线 6–8%、飞层描边（flyout）黑 20% `[WinUI XAML-A]`。
   - Apple：不给任何 alpha，只给线宽 1pt `[Apple HIG Split views]`。
   - Material 3：分隔线（Outline variant）的对比度曲线是 `(1, 1, 3, 4.5)`，即**允许低于 3:1**，条件是文字已满足 4.5:1 `[M3 Roles]` `[MCU 源码]`；而 WCAG 1.4.11 对「组件边界」要求 3:1 `[WCAG 1.4.11]`。
   - 结论：**纯装饰分隔线 6–10% alpha 是官方量级，可以照抄；但若这条线是「控件边界/输入框边界」，1.4.11 的 3:1 是硬要求，不能只靠 6% alpha** —— 这是两份规范真正的张力点。

---

## 4. 落到我们项目上的可执行参数表

项目背景（来自 `docs/design-brief.md`）：本地开发者工具，单用户，页面阅读时长 30 秒–2 分钟，首屏要成立的是**数据**本身；`frontend-design` 技能已禁止「每张卡 hover 抬升」「每个 section fade-and-slide-up」「同一个柔和灰阴影全站通用」等通用默认 —— 因此下面的数值只作为**上界与下限约束**使用，视觉个性不该靠材质堆出来。

| 参数 | 推荐值 | 依据来源 | 备注 |
|---|---|---|---|
| 常驻侧边栏背景 | **不透明纯色**：光 `#F3F3F3`、暗 `#202020`；需要分层时叠官方 content 层色 `LayerFillColorDefault`（暗 `#4C3A3A3A`=白 30% / 亮 `#80FFFFFF`=白 50%）而不是毛玻璃 | `[MS Acrylic]`（竖栏/分隔内容面板推荐不透明背景）、`[MS Mica]`（token `SolidBackgroundFillColorBase`）、`[WinUI XAML-A]`（真实色值） | 侧栏是本工具主要导航面、常驻不动 → 按 MS 规则**不做毛玻璃**；色值现已全为一手源码值 |
| 侧边栏描边（右缘 1px） | **1px**，直接用官方 token 级 alpha：暗主题 `#12FFFFFF`（白 7%）、亮主题 `#0F000000`（黑 6%）；纯分隔线用 `#15FFFFFF` / `#0F000000` | `[MS Layering]`（stroke width 全程 1）、`[WinUI XAML-A]`（描边 alpha 真值） | 已从「二手近似」升级为**官方源码真值**；注意 WCAG 1.4.11 对「控件边界」另有 3:1 要求（见下行） |
| 输入框/可交互控件边界 | 不能只靠 6–7% alpha 的线：需让边界对相邻色 **≥3:1**（WCAG 1.4.11），或改用填充差/投影来表达边界 | `[WCAG 1.4.11]`、`[WinUI XAML-A]`（更亮的 `ControlStrongStrokeColorDefault` 白 55% / 黑 45% 可用于此） | 这是「装饰分隔线」与「功能边界」的分界线，两者不能用同一个 alpha |
| 浮层 / 弹出菜单背景（flyout、popover、右键菜单） | **`backdrop-filter: blur(30px) saturate(125%)`**（官方源码 `sc_blurRadius=30`、`sc_saturation=1.25`）+ 贴合官方 tint：暗 `#2C2C2C` @ LuminosityOpacity≈0.96、亮 `#FCFCFC` @ 0.85；**必须同时给 fallback 纯色** | `[WinUI AcrylicBrush.h]`（blur/saturation 真值）、`[WinUI XAML-C]`（tint 真值）、`[MS Materials]`（acrylic 仅用于临时轻量关闭表面）、`[MS SystemBackdrops]`（自定义后必须自己跟随主题） | **认知修正**：WinUI 的毛玻璃其实**很接近实色**（亮度不透明度 0.85–0.96），只有边缘/底图高对比处才看得出透。想更透可降到 0.75–0.80，但要按 §5 重测对比度 |
| 浮层背景（底图复杂 / 有壁纸时） | blur **40–60px**，并把「对比保证层」的权重提高（而不是一味降 alpha） | `[NNG]`（"More background blur is better, especially with intricate backgrounds"；25px 仍可辨底、100px 全糊） | 复杂背景（壁纸、GIF、视频）下 30px 不够 |
| 对比保证层（等价微软的 exclusion blend） | 在 blur 之上再压一层纯色/混合层，**不要靠调低整体 alpha**；CSS 可选 `mix-blend-mode: exclusion` + `rgba(255,255,255,.102)`（= `#1AFFFFFF`）或直接叠一层背景色 | `[MS Acrylic]`（配方含 exclusion 层专门保对比度）、`[WinUI AcrylicBrush.h]`（`sc_exclusionColor = #1AFFFFFF`） | 官方层序：`translucency → blur → exclusion blend → color/tint → noise`，顺序别乱 |
| 噪点 / 颗粒层 | **2% 不透明度的噪点 overlay**（贴图 256×256，`repeat` 平铺，不随内容滚动） | `[WinUI AcrylicBrush.h]`（`sc_noiseOpacity = 0.02f`，**一手源码**）、`[WinUI Assets]`（贴图 256×256 PNG） | **已升级为一手值**：不再依赖 issue #2402 的二手答复；2% 足以消色带又不显脏，**建议加** |
| 大面积内容区背景 | **不透明**，不用 desktop acrylic | `[MS Acrylic]`（"Don't put desktop acrylic on large background surfaces."） | 我们的插件列表就是大面区域 → 不透明 |
| 材质层数 | 全应用**只允许 1 层** backdrop 材质；浮层材质与窗口材质不同时出现；**也禁止 glass on glass** | `[MS Mica]`（"Don't apply backdrop material more than once in an application."）、`[MS Acrylic]`（避免多层/并排接缝）、`[Apple WWDC25-219]`（"always avoid glass on glass"） | 三家口径一致 |
| 边框线宽 / 内高光 | 1px；内高光**直接用官方渐变描边**：暗主题 `linear-gradient(180deg, rgba(255,255,255,.094), rgba(255,255,255,.07))`，亮主题 `linear-gradient(180deg, rgba(0,0,0,.16), rgba(0,0,0,.06))`（对应 stop 0.33 → 1.0），或用 `inset 0 1px 0` 近似 | `[MS Layering]`（1px）、`[WinUI XAML-A]`（`ControlElevationBorderBrush` 真实实现 0.33/1.0 + `ScaleY=-1`）、`[NNG]`（gradient stroke 造厚度感） | **已从「推断」升级为官方做法**：顶部亮线是**渐变**而不是单色 alpha |
| 圆角 | 浮层/卡片 **8px**；小控件 **4px** | `[WinUI XAML-D]`（`OverlayCornerRadius = 8,8,8,8`、`ControlCornerRadius = 4,4,4,4`，三套主题字典一致）、`[MS SystemBackdrops]`（示例 `CornerRadius="8"`） | 全部一手源码值 |
| 阴影 | 不追求层级阶梯，**至多一档**：`0 8px 24px rgba(0,0,0,.18)`（浮层），elevation 数值按 1/2/8/16/32/128 量级理解 | `[MS Layering]`（越高越大越软、阴影要 purposeful）、`docs/design-brief.md`（禁止全站同一柔和灰阴影） | 简报已禁「通用柔和灰阴影全站铺开」→ 只给浮层一档；层级差优先用**亮度差**表达（见下方 surface 阶梯行） |
| 面板滑入 / 淡入时长 | 进入 **300ms + Accel/Decelerate 组合里的 Decelerate**（`cubic-bezier(0,0,0,1)`）；退出 **150ms + Accelerate**（`cubic-bezier(1,0,1,1)`） | `[MS MotionInPractice]`（“Slide up 150px: **300ms**; Default Decelerate” / “Fade out: **150ms**; Default Accelerate”）、`[MS Timing]`（`ControlNormalAnimationDuration` 250ms、进入曲线 Fast Out Slow In `cubic-bezier(0,0,0,1)`、退出 `cubic-bezier(1,0,1,1)`）、`[Fluent UI v9]`（durationSlow 300 / Fast 150 + curveDecelerateMid / curveAccelerateMid） | 官方唯一给「面板转场毫秒」的页面，**直接用这一组**；进入:退出 = 2:1 是三家的共同节奏。备选同步档：167 / 250 / 333ms `[MS Motion]` |
| 面板位移量 | 官方页面级示例 **150px**；旧浮层文档 **50px**；本项目侧栏/面板建议 **8–24px** | `[MS MotionInPractice]`（"Slide up 150px"）、`[MS popupUI（二手）]`（"50 pixels"）、`docs/design-brief.md`（禁满页 fade-and-slide、禁全站卡 hover 抬升） | 150px 是整页转场量级；桌面工具里位移大了会显得「整套 UI 在动」 |
| 大页面 / 视图切换 | **纯淡入淡出，不做位移滑动**；最短保底 **83ms**，常规 150ms | `[Fluent2 Motion]`（Top level："use a quick fade transition instead of moving or sliding UI elements around on and off the screen"）、`[MS Motion]`（Bare Minimum Fade Linear **83ms**）、`[MS Timing]`（`ControlFasterAnimationDuration` 83ms） | 官方明说的，可放心执行；83ms 同时是「减少动效」的保底时长 |
| 列表进场编排 | staggered 进场，**offset 20–40ms**，总时长 ≤ 400ms；重复加载时改变 offset | `[Fluent2 Motion]`（"For most scenarios, a staggered animation is preferred."、"use short offsets between them"、"Give important elements more emphasis through more prominent movements and longer durations"） | offset 具体值官方未给 → （推断） |
| 动效曲线 token | 进入 `cubic-bezier(0,0,0,1)`；退出 `cubic-bezier(1,0,1,1)`；通用双向 `cubic-bezier(0.33,0,0.67,1)`；**linear 只给旋转/纯淡出** | `[MS Timing]`、`[Fluent UI v9]`（AccelerateMid `(1,0,1,1)`、DecelerateMid `(0,0,0,1)`、EasyEase `(0.33,0,0.67,1)`）、`[Fluent2 Motion]`（linear "can feel unnatural; use it only in cases that need a consistent rate, like rotations"） | — |
| 降低动效 / 减少动效 | `prefers-reduced-motion: reduce` → 去掉位移与 stagger，只保留 **≤83ms 的 opacity 淡入**（或直接切换）；Apple 对等做法是用 dissolve 代替 zoom/slide；Windows 侧读 `UISettings.AnimationsEnabled` | `[MS Motion]`（83ms）、`[Apple 支持页（二手）]`（"Screen transitions and effects use the dissolve effect instead of zoom or slide effects."）、`[Apple WWDC25-219]`（Reduce Motion "decreases the intensity of some effects and disables any elastic properties"）、`[WCAG 2.3.3]`、`[Fluent2 Motion]`（"design for and include a 'no motion' setting…as recommended by the WCAG"） | WCAG 2.3.3（AAA）要求交互动效可关闭；Apple 另有 "Make motion optional." / "Let people cancel motion."；必须「跟随系统 + 应用内开关」双轨 |
| 降低透明度 / 提高对比 | **拆成两个开关**：①降低透明度 → 材质底变**不透明纯色**（光 `#F3F3F3`、暗 `#202020`）；②提高对比 → 文字变**纯黑/纯白**并加对比描边 | `[NNG]`（"replaces any glassmorphic component with a solid color"）、`[MS Acrylic]`（关闭系统透明效果即全局禁用）、`[Apple WWDC25-219]`（Reduce Transparency 只是"frostier"；Increase Contrast 才 "predominantly black or white…contrasting border"） | **注意** NNG 把两个开关混为一谈；Apple 的语义更细。建议默认跟随系统「透明效果」设置 |
| 正文文字对比度 | **≥ 4.5:1**（首选 ≥ 7:1 留余量）；文字色用官方分层 alpha：暗 100 / 77 / 53 / 36%，亮 89 / 62 / 45 / 36% | `[MS AccessibleText]`（4.5:1）、`[WCAG 1.4.3]`、`[WCAG 1.4.6]`（7:1）、`[WinUI XAML-A]`（`TextFillColorPrimary`–`Disabled` 真实值） | alpha 值需在实际底色上重新算对比度，不能直接照搬；禁用态 36% 属 "incidental" 例外，不得用于正文 |
| 大字号文字对比度 | ≥ **24px 常规** 或 ≥ **18.5px 粗体** → **≥ 3:1**（Apple：加粗**任意**字号即可 3:1） | `[WCAG 1.4.3]`（18pt / 14pt bold，1pt=1.333px，"4.499:1 would not meet the 4.5:1 threshold"）、`[Apple HIG Accessibility]`（≤17pt 4.5:1、≥18pt 3:1、加粗 3:1） | MS 侧没有这条例外，保守做法仍按 4.5:1 |
| 非文字元素对比度 | **≥ 3:1**（图标、开关、输入框边界、状态指示器、图表） | `[WCAG 1.4.11]`（"2.999:1 would not meet the 3:1 threshold"，豁免 inactive 组件）、`[M3 Roles]`（"accessible minimum 3:1 contrast"）、`[Apple HIG Accessibility]` | 容易漏掉；也解释了为什么 6–7% alpha 的描边**不能**用作输入框的功能性边界 |
| 材质上的彩色文字 | **禁止**把强调色文字/超链接放在毛玻璃上；必须放时另加深色底或改为非文字强调（描边、图标、色块） | `[MS Acrylic]`（"Don't place accent-colored-text over acrylic surfaces"，理由：默认 14px 下很可能过不了最小对比度）、`[M3 Roles]`（Container 色 "should not be used for text or icons"） | 侧边栏选中态若用强调色，应加不透明底或加粗+提高对比 |
| 文字缩放 | 布局要支持 100%–225% 不破版（Apple：≥ **200%**；watchOS 140%） | `[MS AccessibleText]`（`TextScaleFactor` 范围 [1, 2.25]）、`[Apple HIG Accessibility]` | 侧边栏宽度建议按内容自适应而非硬编码 |
| 层级差（优先于阴影） | 用**背景亮度阶梯**表达层级：暗 `#0A0A0A`(baseAlt) → `#202020`(base) → `#2C2C2C` → `#333333`；亮 `#F3F3F3` → `#F9F9F9` → `#FFFFFF` | `[WinUI XAML-A]`（`SolidBackgroundFillColorBase`–`Senary` 六档真值）、`[M3 Roles]`（Surface 五档 lowest/low/default/high/highest；tone-based surface 已取代 elevation overlay） | **比阴影更贴合简报**（禁全站灰阴影）；MS 暗色阶梯每档只差 4–7 个灰阶 |
| 主题/配色的可导出性 | 若做主题系统：**只导出扁平 hex 色板**（Raycast 先例：12 键、全 6 位 `#RRGGBB`、零 alpha/blur/gradient 字段），材质与透明参数写死进代码 | `[Raycast 主题 schema]`（106 主题 × 12 色 = 全 hex，非 hex 数 0）、`[Raycast legacy]`（`convertLegacyColorIfNeeded()` 遇 8 位 hex 直接截断后两位）、`[Raycast settings]`（`transparen\|blur\|vibran\|material\|glass` 零命中） | 「颜色可换、材质不可换」是成熟产品的一致选择；能省掉一堆对比度事故 |
| 取色流水线（若要按壁纸/图标取色） | 先降采样到 **≈112×112**、取 **16 个主色**；选色权重 `饱和度 0.24 / 亮度 0.52 / 占比 0.24`；再映射到 5–13 个 tone，对比档 Standard / Medium(≥3:1) / High(≥7:1) | `[Android Palette 源码]`（`DEFAULT_RESIZE_BITMAP_AREA = 112*112`、`DEFAULT_CALCULATE_NUMBER_COLORS = 16`、权重与 luma 锚点）、`[MCU 源码]`（`ContrastCurve`、`onSurface (4.5,7,11,21)`、`outline (1.5,3,4.5,7)`）、`[Android 动态配色页]`（1 主色 → 5 key color → 每色 13 tone → 5 套 scheme） | 别自己发明色彩量化算法；官方参数已给全。`getDominantSwatch` = 最大 population 色块 |
| 材质降级触发条件 | 窗口失活 / 电池省电模式 / 关闭透明效果 / 高对比度 / 低端硬件 → 一律退纯色 | `[MS Mica]`、`[MS Acrylic]`、`[MS SystemBackdrops]`（自定义属性后 "it no longer applies default Light or Dark values"，需自行跟随主题）、`[Apple WWDC25-219]`（Reduce Transparency 只是更 frostier，与 MS 不同） | 高对比度模式用系统色，不做自定义材质；Web UI 至少实现「关闭透明效果 / 高对比 / 减少透明度偏好」三条 |

---

## 5. 可读性红线（NN/g 专节）

NN/g 的观点是这一节的主干 `[NNG]`，其余数值来自 WCAG 与 Microsoft 官方，二者互补：NN/g 说「怎么设计」，WCAG 说「到哪条线」。

### 5.1 NN/g 的三条最佳实践（原文标题）

1. **Meet Contrast Requirements** —— "Ensure that text and graphical elements meet contrast requirements."
   毛玻璃的文字会**同时跨过多种底色**：同一段文字在浅色区域可能达标，滑到深色/图案区域就不达标。NN/g 明确建议直接在底图上取样验证（例如 Figma 的 Contrast 插件逐点测）。
2. **More Blur Is Better** —— "More background blur is better, especially with intricate backgrounds (e.g., video, photography, animations)."
   原话同时点出反面：低不透明度会**降低文字对比度**，并让背景显得吵闹（busy）。
3. **Let Users Adjust Transparency** —— "give users the option to control contrast or transparency settings."
   NN/g 举 Apple 的 reduce transparency / increase contrast 为例：开启后 "replaces any glassmorphic component with a solid color"。
   **⚠️ 这条转述不精确**：Apple 一手说法是 Reduce Transparency 让材质变得更"frostier"（更糊、更遮挡），**变纯色是 Microsoft 的行为**；Apple 变纯黑/纯白并加对比描边的是 **Increase Contrast** `[Apple WWDC25-219]` `[MS Acrylic]`。实现时按两个独立开关做（见 §4）。

### 5.2 什么时候不该用毛玻璃（把来源的禁令合成清单）

- **常驻的竖排侧栏/分隔内容的面板** → 用不透明背景。原文："For vertical panes or surfaces that help section off content of your app, we recommend you use an opaque background instead of acrylic." `[MS Acrylic]`
- **大面积背景表面** → "Don't put desktop acrylic on large background surfaces." `[MS Acrylic]`
- **两块 acrylic 并排** → "Don't place multiple acrylic panes next to each other because this results in an undesirable visible seam." `[MS Acrylic]`
- **同一个应用里叠两层材质** → "Don't apply backdrop material more than once in an application." `[MS Mica]`
- **在毛玻璃上放强调色文字 / 超链接** → "Don't place accent-colored text over acrylic surfaces."（默认 14px 字号下很可能过不了最小对比度）`[MS Acrylic]`
- **把材质叠在材质上（glass on glass）** → "always avoid glass on glass"、"Stacking Liquid Glass elements on top of each other can quickly make the interface feel cluttered"；且「稳定态下」要避免内容与材质相交："In steady states… avoid intersections between content and Liquid Glass" `[Apple WWDC25-219]`
- **把材质用在内容层** → "Don't use Liquid Glass in the content layer."（材质只属于最上层控件层）`[Apple HIG Materials]`
- **在 thin / ultraThin 材质上放四级（quaternary）文字** → "because the contrast is too low"；同一规则也意味着**侧栏这类有大量文字的组件必须用 regular 变体**："Use the regular variant when background content might create legibility issues, or when components have a significant amount of text, such as alerts, sidebars, or popovers." `[Apple HIG Materials]`
- **clear 变体用在非富媒体背景上** → clear 仅用于 media-rich 内容之上，且缺暗化层时 "legibility gets noticeably worse"；底层明亮时须加 **35% 不透明度暗化层**："If the underlying content is bright, consider adding a dark dimming layer of 35% opacity." `[Apple HIG Materials]`
- **背景不可控且底部是视频/照片/动画** → 要么把 blur 拉到 40px+，要么退成单色背景："if you have control of what appears behind a translucent component, opt for simple or single-color backgrounds" `[NNG]`
- **装饰性地到处用** → "glassmorphism is best when utilized sparingly to create an illusion of depth." `[NNG]`

### 5.3 保底对比度的具体数字与做法

| 场景 | 阈值 | 依据 |
|---|---|---|
| 正文 / 小字号文字 | **≥ 4.5:1**（不可四舍五入，4.499:1 不达标） | `[MS AccessibleText]` `[WCAG 1.4.3]` `[Apple HIG Accessibility]` |
| 大字号（≥24px 或 ≥18.5px 粗体） | **≥ 3:1**（Apple：加粗**任意**字号即 3:1） | `[WCAG 1.4.3]` `[Apple HIG Accessibility]` |
| **非文字元素**（图标、开关、输入框边界、状态指示器、图表） | **≥ 3:1**（2.999:1 亦不达标） | `[WCAG 1.4.11]` `[M3 Roles]` `[Apple HIG Accessibility]` |
| 追求 AAA / 长文本舒适 | **≥ 7:1** | `[WCAG 1.4.6]` |
| 失活 UI 内文字、纯装饰、logo | 无要求（但 logo 若当交互组件仍建议达标） | `[WCAG 1.4.3]` `[MS AccessibleText]` |
| 毛玻璃压在明亮的富媒体内容上 | 加 **35% 不透明度暗化层** | `[Apple HIG Materials]` |

保底做法（按优先级）：

1. **让毛玻璃只出现在背景可控的地方**；背景不可控时，把 blur 提到 40px+ 并提高材质底色不透明度 `[NNG]`。
2. **加一层对比保证层**：微软在配方里用 exclusion blend 层专门做这件事（"We added an exclusion blend mode layer to ensure contrast and legibility of UI placed on an acrylic background."）`[MS Acrylic]`；Web 上的等价做法是在 blur 之上再压一层纯色 alpha 底（而不是直接调低整个材质的 alpha）。
3. **不依赖单一测量点**：在半透明组件覆盖的所有底图上逐点测对比度 `[NNG]`。
4. **提供「降低透明度」开关**，把毛玻璃换成纯色 `[NNG]` `[MS Acrylic]`。
5. **不要把高对比度模式当兜底**："Do not treat high-contrast mode as the primary mitigation for low readability." `[MS AccessibleText]`
6. 若这些全做不到，NN/g 给的兜底是："make sure that any glassmorphic elements in your interface are WCAG-compliant." `[NNG]`

---

## 6. 抓取状态与失败记录

| 来源 | URL | 状态 |
|---|---|---|
| MS Mica | learn.microsoft.com/…/design/style/mica | 成功（一手） |
| MS Fluent 材质 | learn.microsoft.com/…/signature-experiences/materials | 成功（一手） |
| Fluent 2 Material | fluent2.microsoft.design/material | 成功（一手，无数值） |
| MS Acrylic | learn.microsoft.com/…/design/style/acrylic | 成功（一手，配方层序 + Do/Don't 全文） |
| MS AcrylicBrush API | learn.microsoft.com/…/media.acrylicbrush（+ TintOpacity 属性页） | 成功（一手） |
| MS System backdrops | learn.microsoft.com/…/develop/ui/system-backdrops | 成功（一手） |
| MS Layering（elevation） | learn.microsoft.com/…/signature-experiences/layering | 成功（一手，1px stroke 与 elevation 阶梯） |
| MS XAML 主题资源 | learn.microsoft.com/…/platform/xaml/xaml-theme-resources | 成功（一手，未给色值 → 转源码补齐） |
| MS 无障碍文本要求 | learn.microsoft.com/…/accessibility/accessible-text-requirements | 成功（一手） |
| MS Timing and easing / Motion | learn.microsoft.com/…/design/motion/timing-and-easing、/signature-experiences/motion | 成功（一手，83/167/250/300ms） |
| MS motion-in-practice | learn.microsoft.com/…/develop/motion/motion-in-practice | 成功（一手，**唯一给面板转场毫秒**） |
| Fluent 2 Motion | fluent2.microsoft.design/motion | 成功（一手，无数值；Top level / accessible motion 原文） |
| NN/g Glassmorphism | nngroup.com/articles/glassmorphism/ | 成功（一手，本笔记核心） |
| WCAG 1.4.3 / 1.4.6 / 1.4.11 / 2.3.3 | w3.org/WAI/WCAG22/Understanding/* | 成功（一手） |
| Apple Liquid Glass newsroom | apple.com/newsroom/2025/06/apple-introduces-a-delightful-and-elegant-new-software-design/ | 成功（一手，仅定性） |
| Apple HIG Materials | developer.apple.com/design/human-interface-guidelines/materials | 成功（一手，经 `page.md` 静态源） |
| Apple HIG Sidebars / Split views / Color / Motion / Accessibility / Images | developer.apple.com/design/human-interface-guidelines/* | 成功（一手，同上） |
| Apple WWDC25 Session 219 逐字稿 | apple.com/videos/play/wwdc2025/219/ | 成功（一手 transcript） |
| SwiftUI Liquid Glass 文档 | developer.apple.com/documentation/swiftui/applying-liquid-glass-to-custom-views | 成功（一手） |
| Raycast Themes | manual.raycast.com/themes（+ themes.ray.so API + theme-explorer 源码） | 成功（一手手工页 + 官方源码，schema 全量实测） |
| Android 动态配色 | developer.android.com/develop/ui/views/theming/dynamic-colors | 成功（一手，Last updated 2026-10-28） |
| Android Palette / MCU 源码 | androidx Palette.java、Target.java、DynamicTonalPalette.android.kt、MCU 0.4.0 | 成功（一手源码） |
| Wallpaper Engine | wallpaperengine.io/en + help./docs.wallpaperengine.io | 成功（一手，11 页） |
| WinUI 主题资源真实 alpha | github.com/microsoft/microsoft-ui-xaml（Common_themeresources_any.xaml、AcrylicBrush_themeresources.xaml、CornerRadius_themeresources.xaml、AcrylicBrush.h） | 成功（一手源码，回答了直问 2/3） |
| abacktools WinUI 色值 | abacktools.com/…/windows-11-colors | 成功（**二手近似**，现已被源码真值取代） |
| microsoft-ui-xaml #2402 | github.com/microsoft/microsoft-ui-xaml/issues/2402 | 成功（**二手**，其 2% 说法已被源码 `sc_noiseOpacity = 0.02f` 证实） |
| Fluent UI v9 motion tokens | storybooks.fluentui.dev/react/?path=/docs/motion-tokens--docs（+ `packages/tokens/src/global/durations.ts`） | 成功（**二手**，与官方 token 不冲突） |

**抓取失败的 URL / 工具障碍**
- `developer.android.com/develop/ui/views/graphics/palette` → **404**；`.../compose/designsystems/material3` → `TypeError: fetch failed`；`m3.material.io/styles/color/dynamic` → Firecrawl **429（retry_after ≈86211s）**。
- `manual.raycast.com/appearance` → **404**；`themes.ray.so/api/themes.json`、`/api/list` → 返回 HTML 外壳（非 JSON）。
- `learn.microsoft.com/…/design/motion/overview` → **404**；`…/design/motion/duration-easing` → **404**（真实路径是 `timing-and-easing`）。
- `support.microsoft.com/…/make-windows-easier-to-see-6b250a86-…` → **404**；`react.fluentui.dev/?path=/docs/theme-motion--docs` → 无此条目。
- Apple 支持页 `…/reduce-motion` → `web_fetch` 报 `unsupported content type "application/octet-stream"`（改用二手转述，已在文中标注）。
- 工具链记录：`curl` 走 `HTTP_PROXY/HTTPS_PROXY=http://127.0.0.1:65535` 恒返回 `000`（代理不通）→ 弃用；`read_page`（Firecrawl 云端渲染）前期可用；后期 keyless 额度耗尽（**HTTP 429，retry_after ≈86077–86211s**）→ 改用 `web_fetch`，Apple HIG 走官方 `<page>.md` 静态源；`pwsh Invoke-WebRequest` 抓 `raw.githubusercontent.com` 挂起 >120s（已 kill）→ 改用子代理 + 直接抓取。

**未找到（确认为空白，勿再找）**
1. ~~Acrylic 的官方 tint alpha 数值~~ → **已由源码补齐**（`AcrylicBrush_themeresources.xaml`，见 §1.23/§1.28）。
2. ~~内高光的官方条目~~ → **已由源码补齐**（`ControlElevationBorderBrush` 渐变描边，见 §1.23）。
3. **Mica 的「壁纸色占比」** —— 只在二手站看到 "approximately 30-40% wallpaper colour"，一手来源**未找到**（MS 只说 opaque + "subtly tinted"）。
4. **Apple 的任何毫秒时长 / 动效上限** —— HIG Motion 与 Materials 全无；唯一数值是 30–60 fps 与 visionOS "avoid ~0.2 Hz oscillation"。Apple 预定义曲线的控制点也未公布。
5. **「高光相对指针坐标的映射」与陀螺仪采样参数**（直问 6 的后半）—— 未找到；Newsroom 只说 "dynamically reacts to movement with specular highlights"，WWDC 说 "in some cases, the lighting responds to device motion…"，无角度/延迟/强度数值。
6. **「高光只应在交互时出现」的明文规定** —— 未找到明文；但有 API 级证据：SwiftUI 的 `interactive(_:)` 是**显式开关**（不打开就没有跟随指针的响应）。
7. **WinUI 内置 Flyout / Popup 转场的实际毫秒** —— 文档只说 "duration is preconfigured"，`PopOutThemeAnimation` 的 `Duration` 无效（二手）。
8. **「Default Accelerate / Default Decelerate / Standard」的精确控制点** —— motion-in-practice 只给名字不给贝塞尔值；`controlFastOutSlowIn` token 名亦未找到。
9. **Wallpaper Engine 的官方质量档位参数表 / CPU-GPU 占用百分比 / FPS 官方 range** —— 未找到（只有二手 FPS 10/15/25/30）。
10. **Raycast gradient 主题的 JSON/URL 编码、主题本地磁盘路径、Store 审核规则** —— 未找到。
11. **`AcrylicBackgroundFillColorThinBrush`** —— main 分支无此 token（`DesktopAcrylicKind.Thin` 只存在于 API 层）。
