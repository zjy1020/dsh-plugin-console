# 03 DSH 插件机制与官方通道

本章讲 DSH（DeepSeek Harness）这一侧的真实机制：一个 profile 目录里记了几套账、「是不是 DSH 插件」由哪个字段判定、宿主 `reconcile()` 怎么调和加载列表、`dsh plugin` CLI 为什么在这台机器上不能用来管 `desktop`、本项目为什么选择直接复用官方库而不是照抄参考项目、以及 pnpm 11 在 Windows 上实际卡住我们的三件事。

所有机制结论都来自本机已安装的 DSH 运行时源码与本机 profile 的真实文件，不是推测。

## 0. 证据约定

- 每条结论追溯到真实文件，形式 `路径:行号`，多行用 `路径:起-止`。行号取自本次撰写时的文件快照。
- 相对路径以仓库根 `D:\项目\DSH\deepseekharness插件台` 为基准（下称「仓库」）。
- 本机 DSH 安装目录、profile 目录不在仓库内，统一用下列代号，首次出现给绝对路径：

| 代号 | 绝对路径 |
| --- | --- |
| `HOST` | `D:\Dowloads\DeepSeekHarness\resources\app\dsh` |
| `MGR` | `HOST\node_modules\@deepseek-ai\dsh-plugin-manager` |
| `PROFILES` | `C:\Users\YBY\.dsh\profiles` |
| `MARKET-REF` | `D:\项目\DSH\_recon\dsh-market`（参考项目源码，只读） |

- 本机只有三个 profile：`desktop`、`web`、`headless`（`PROFILES` 目录实测）。
- 代码里读不出、或本次没有实测的，一律写「未核实」，不做推断性描述。
- 参考项目 dsh-market 的分析见 `docs/market-parity.md`（858 行）；本章引用它时标 `market-parity.md:行号`，并说明那是**二手结论 + 源码行号**，不是本章一手核实。

---

## 1. 先给结论：六句话

1. **一个 profile 有两套账**：`package.json` 的 `dependencies` 记「装了什么」，`dsh.profile.bundles` 记「加载什么」，两者不等价，差集是常态（本机 `desktop`：16 个依赖 / 18 个加载层 / 并集 22 条记录）。
2. **「是不是 DSH 加载层」的唯一判据是 `package.json` 里有没有 `dsh.bundle.patch`**，不是 `dsh` 字段、不是包名、不是 `dsh-` 前缀（`MGR/lib/types/operations.js:83-87`）。
3. **宿主 `reconcile()` 只在「新增依赖」方向动手**：已存在的条目原地保留、新增条目一律追加到末尾、自己从 `bundles` 摘掉的包不会被塞回来（`MGR/lib/types/operations.js:96-124`）。
4. **`dsh plugin` 只把参数原样转发给 pnpm，且拒绝对 `desktop` profile 工作**（`HOST/lib/bin.js:36-38`、`bin.js:120`），所以本项目不可能 spawn CLI 管桌面端 profile。
5. **官方 `runProfilePnpm` 的默认行为对本项目不可用**：`execution: 'cli'` 时 stdio 是 `inherit`（`onOutput` 永不触发），只有静默超时没有整轮超时，环境变量被清洗（PATH 要自己塞）。
6. **pnpm 11 卡人的不是网络，是三条静默策略**：构建脚本默认被拦（`ERR_PNPM_GIT_DEP_PREPARE_NOT_ALLOWED`）、供应链冷却把 `@latest` 压回旧版、`--reporter=append-only` 的位置必须精确。

---

## 2. profile 结构：一个目录，两套账

### 2.1 三个 profile 的实测对照

| profile | `dependencies` 条数 | `dsh.profile.bundles` 条数 | bundles 里不在 dependencies 的包 |
| --- | --- | --- | --- |
| `desktop` | 16（`package.json:5-20`） | 18（`package.json:24-43`） | 6 个 `@deepseek-ai/*` 官方包 |
| `web` | 7 | 9 | 2 个：`@deepseek-ai/dsh-base`、`@deepseek-ai/dsh-web-app` |
| `headless` | **0**（`"dependencies": {}`） | 2 | 2 个：`@deepseek-ai/dsh-base`、`@deepseek-ai/dsh-headless` |

`headless` 那一行是本章最重要的反例：**`bundles` 里可以出现 `dependencies` 里根本没有的包**。所以任何「插件清单」的数据源都必须是 `dependencies ∪ bundles`，只读 `dependencies` 会漏掉整个官方基座。

### 2.2 `dependencies`：装了什么

`PROFILES\desktop\package.json:5-20` 是 16 条依赖，形态三种：

- 普通 npm 版本号：`"dsh-context": "0.78.1"`（`:12`）、`"@liustack/modsearch": "5.10.11"`（`:6`）
- `link:` 指到本地开发目录：`"dsh-agent2api-hud": "link:D:\\项目\\DSH\\开发插件\\agent2api"`（`:9`）、`"dsh-custom-brand"`（`:13`）、`"dsh-raccoon-merge"`（`:18`）
- `file:` 指向打包好的 tgz：`"dsh-purge-community": "file:C:/Users/YBY/.dsh/dsh-purge-community/pkgs/…/dsh-purge-community-1.6.69.tgz"`（`:17`）

三种形态的后果不同：`link:` / `file:` 装的包没有远端版本可比，更新检测必须跳过，否则界面会给出永远点不动的「更新」按钮（`src/main/engine/ops.ts:1114` 把 `link` / `workspace` 过滤掉）。

### 2.3 `dsh.profile.bundles`：加载什么（有序）

`PROFILES\desktop\package.json:22-45` 的结构是 `dsh.profile.bundles` 一个数组，18 个名字，从 `@deepseek-ai/dsh-base`、`@deepseek-ai/dsh-web-app` 一直到末尾的 `dsh-purge-community`。

这是一个**有序数组**，不是集合，顺序有语义：DSH 按这个顺序逐层叠加 patch（2.6 节），先加载的层是被后加载的层覆写的底座。所以「插到第 3 位」和「追加到末尾」在运行期不是一回事——这也是本项目 `addBundle(profileDir, name, at)` 支持可选下标的原因（`src/main/engine/bundles.ts:156-169`：`at` 合法就 `splice` 插入，否则 `push` 到末尾）。

### 2.4 清单数据源为什么必须是并集

`src/main/engine/inventory.ts:359-371` 的实现就是并集：先按 `dependencies` 的键顺序生成记录，再补上「只在 `bundles` 里出现」的名字；排序 `:390-394` 是「内置包靠后 → 在加载列表里的靠前 → 名字字典序」。

`desktop` 的并集账：`dependencies` 16 条、`bundles` 18 条、交集 12 条、只在一侧 4 + 6 = 10 条，**并集 22 条记录**。界面上「装了 16 / 加载了 18 / 共 22 条」三个数字同时成立，一个都不多余：只读 `dependencies` 会凭空少 6 个官方包；只读 `bundles` 会少 4 个「装了但没加载」的包——而后者恰好是本工具要讲的故事（第 9 节）。

### 2.5 同目录的其它文件

| 文件 | 作用 | 本机实测 |
| --- | --- | --- |
| `package.json` | 两套账的载体 | 46 行 |
| `cordis.yml` | profile 根条目列表 | 正文 `[]`，仅头注释 |
| `cordis.patch.yml` | **用户层补丁**，最后叠加 | 468 行，见 10.3 |
| `pnpm-workspace.yaml` | pnpm 11 工程配置 + 两条策略豁免 | 18 行 |
| `pnpm-lock.yaml` | 锁文件 | 存在，另有 `.bak-20261028-tool` / `.bak-20261029-tool` 两份历史备份 |
| `node_modules/` | 真实包体 | 存在 |
| `.plugin-manager/logs/operation-*/pnpm.log` | 官方通道诊断日志 | 官方库自建（`MGR/lib/types/operations.js:305-307`） |
| `.dsh-console/state.json` | **本工具自己的账**（停用名单 + 原下标） | `{"disabled": {}, "updatedAt": 1793590549063}` |
| `.dsh-console/backup/` | 本工具备份目录 | 8 个 `package.json.2026-11-02T03-35-*.json` |

`cordis.yml` 的头注释把装配顺序写死了：

```
# The tree is composed as patches: each bundle in package.json's
# dsh.profile.bundles, then cordis.patch.yml, then any --patch overlays.
# Edit cordis.patch.yml, not this file.
```

### 2.6 装配顺序：三层

```
dsh.profile.bundles[0] → [1] → … → [n]     ← 每个包自带的 cordis.patch.yml
        ↓
cordis.patch.yml（用户层，最后说话）
        ↓
--patch <file>（命令行覆盖，测试用）
```

这条顺序决定了本项目的**只读策略**是安全的：`cordis.patch.yml` 最后说话，读它能知道「用户到底关了什么」；但写它等于抢占用户手写层，所以 v1 不写（10.4 节）。文件名常量在 `HOST/dsh-app-boot/lib/index.js` 里（`market-parity.md:819` 引 `:509`）。

---

## 3. 唯一判据：`dsh.bundle.patch`

### 3.1 源码

`MGR/lib/types/operations.js:83-87`：

```js
export function bundleManifest(name, dir, anchor) {
    const packageDir = resolveBundleDir('dsh', name, anchor, dir);
    const manifest = readProfileManifest('dsh', packageDir);
    return manifest.dsh?.bundle?.patch === undefined ? undefined : manifest;
}
```

函数名 `bundleManifest`，返回值语义就是「这个包算不算一个加载层」：有 `dsh.bundle.patch` → 返回 manifest（真值）；没有 → `undefined`。

### 3.2 判据不是什么

- **不是 `dsh` 字段的存在**。可以有 `dsh: {…}` 而没有 `bundle.patch`，那它只是普通依赖，装完不进加载列表。
- **不是包名**。名字带 `dsh-` 不代表是插件；官方包 `@deepseek-ai/dsh-base` 不带 `dsh-` 前缀也照样是加载层。
- **不是有没有 `cordis.patch.yml` 这个文件**。声明了路径但包本身没有 `dsh.bundle` 结构，一样不算。

`market-parity.md:848-849` 对参考项目的批评是同一条：「不要用一堆启发式拼起来，宿主自己的判据只有一个」。

### 3.3 DSH 自己的告警文案

官方调和逻辑对「装进来却没声明」的包会往 stderr 打（`MGR/lib/types/operations.js:111`）：

```
dsh: warning: <name> declares no dsh.bundle — installed as a plain dependency, not as a profile layer
```

本项目自建通道里打了语义等价的中文日志（`src/main/engine/ops.ts:963-967`）：「<name> 装了但没进加载列表：它的 package.json 没有声明 dsh.bundle.patch，只会作为普通依赖存在」。

### 3.4 声明格式还有校验

`dsh.bundle.patch` 只能是「一个文件路径」或「路径数组」，格式不对宿主直接抛（`market-parity.md:823` 引 `HOST/dsh-app-boot/lib/index.js:519`）：

```
dsh.bundle.patch must be a file path or a list of file paths
```

本项目读这字段的两处实现：`src/main/engine/inventory.ts:280-284`（`isBundlePackage = !!dsh.bundle`）与判断分支 `ops.ts:961`（`declaresBundle(pkg) || forceBundle`）。`probeBundle()`（`src/main/engine/dshpm.ts:168-196`）则直接调官方 `bundleManifest` 探针，避免自己写第二套判定。

### 3.5 本机抽样：四个「装了没加载」的包都声明了

实测 `PROFILES\desktop\node_modules` 里那 4 个不在 `bundles` 的包：

| 包 | 版本 | `dsh.bundle.patch` | 链接形态 |
| --- | --- | --- | --- |
| `dsh-custom-brand` | 1.0.0 | `./cordis.patch.yml` | Junction |
| `dsh-pet` | 0.3.8 | `./cordis.patch.yml` | 普通目录 |
| `dsh-raccoon-merge` | 0.1.0 | `./cordis.patch.yml` | Junction |
| `dsh-whale-widget` | 0.4.2 | `./cordis.patch.yml` | 普通目录 |

四个**全都声明了**。所以「装了、是插件、但没进加载列表」的成因不是「它其实不是插件」，而是别的原因（9.2 节逐条拆）。

---

## 4. 宿主 `reconcile()`：bundles 调和的真相

### 4.1 源码（15 行以内，逐字）

`MGR/lib/types/operations.js:96-124`：

```js
async function reconcile(before, dir, anchor, options) {
    const after = readProfileManifest('dsh', dir);
    const dependencies = Object.keys(after.dependencies ?? {});
    const beforeDeps = new Set(Object.keys(before.dependencies ?? {}));
    const previous = after.dsh?.profile?.bundles ?? [];
    const bundles = previous.filter((name) => {
        if (!beforeDeps.has(name) && !dependencies.includes(name)) return true;
        return dependencies.includes(name) && bundleManifest(name, dir, anchor) !== undefined;
    });
    for (const name of dependencies) {
        if (beforeDeps.has(name)) continue;
        const metadata = bundleManifest(name, dir, anchor);
        if (metadata?.dsh?.bundle === undefined) { options.onOutput?.(`…declares no dsh.bundle…`, 'stderr'); continue; }
        …
        if (!bundles.includes(name)) bundles.push(name);
    }
```

省略的两处是 `bundlePatchPaths()` 遍历 + `loadOverlayPatches()`，与 bundles 数组无关。

### 4.2 逐段解读

**第一步：三个集合。** `dependencies` = 装完后的全部依赖名；`beforeDeps` = 装之前的依赖名（只用来判「是不是新增」）；`previous` = 装之前文件里记的 bundles 数组（有序）。

**第二步：`filter` 决定「保谁」。** 对 `previous` 里每个名字：若它**既不在旧依赖、也不在新依赖**里 → `return true`（保留）——这是给官方基座留的路，`desktop` 的 bundles 里 6 个 `@deepseek-ai/*` 既不是旧依赖也不是新依赖，于是原样保留；否则必须**同时**满足「在新依赖里」且「声明了 `dsh.bundle.patch`」才保留。效果：`pnpm remove` 掉一个包，它的 bundles 行被自动过滤（还在 `beforeDeps`、但新 `dependencies` 没了）；包被改造成没有 `dsh.bundle.patch` 了，行也被过滤。

**第三步：`for` 决定「加谁」。** 只遍历新增依赖（`beforeDeps.has(name)` 直接 `continue`）。两道闸：`metadata?.dsh?.bundle === undefined` → 打警告 `continue`，不进 bundles；否则先把它的 `bundle.patch` 文件都 `loadOverlayPatches` 预载一遍（把 YAML 错误提前暴露在安装阶段，而不是下次启动），再 `if (!bundles.includes(name)) bundles.push(name)`。

**第四步：序列化比较决定「写不写盘」。** `:120-123`：

```js
if (JSON.stringify(previous) === JSON.stringify(bundles)) return;
after.dsh = { ...after.dsh, profile: { ...after.dsh?.profile, bundles } };
await saveManifest(dir, after);
```

比较的是**数组的 JSON 字符串**，顺序变化也算变化；没变就一次盘都不写。`saveManifest`（`:92-94`）用 `writeFileAtomic` 写 `package.json`，2 空格缩进、结尾补 `\n`、权限 `0o600`。

### 4.3 三条推论（决定本项目的行为）

**推论 ①：自己从 `bundles` 里摘掉一个包，后续走官方通道的安装不会把它塞回来。** 因为第三步只遍历**新增**依赖（`:107-108`）。一个包只要装之前就在 `dependencies` 里，它在这次调和里根本进不了循环体。于是「停用 = 只摘 `bundles` + 在自己的账本里记下标」这套设计**与官方算法自洽**，不需要额外守卫，也不怕下次官方安装把它偷偷加回来。本项目实现正是这套：`src/main/engine/ops.ts:1321-1333`（停用时 `bundleIndexOf` 记下标 → `removeBundle` → 写进 `disabledMap`），启用时 `:1303-1320` 按记下的下标 `addBundle(profileDir, name, at)` 回插原位。全程只动 `package.json` 的 `bundles` 数组和 `.dsh-console/state.json`。

**推论 ②：新增项一律追加到末尾，不插队。** `:116-118` 只有 `push`，没有 `splice`，也没有按字母序/依赖权重排序。所以官方通道装进来的新插件永远在加载顺序最后，即它能覆写前面所有层，但不会被任何层覆写（除 `cordis.patch.yml`）。本项目在自建通道保持了同样语义（`bundles.ts:156-169`：不给下标时 `push`，只有「从停用里恢复」才用记下的原下标插回原位）——插回原位是本工具独有的能力，官方 `reconcile` 做不到，因为它不记得你的历史。

**推论 ③：`dependencies` 里移除的包，`bundles` 行会被自动过滤。** `:101-105` 的 `filter` 已覆盖；`cordis.patch.yml` 里同名条目属另一本账（10.3 节），不会被这里清理。

### 4.4 另一份实现：`dsh-app-boot` 里的 `reconcileProfilePlugins`

`market-parity.md:399-426` 记录了宿主里另一份等价实现 `HOST/dsh-app-boot/lib/index.js:1209`：

```js
const bundles = previous.filter(name => !(beforeNames.has(name) || afterNames.has(name)) || bundleNames.has(name));
for (const dependency of after.dependencies)
    if (dependency.bundle && !disabled.has(dependency.name) && !bundles.includes(dependency.name)) bundles.push(dependency.name);
```

骨架一致（保序 filter + 末尾 push），差别两点：① 它遍历**全部** `after.dependencies`（不是只遍历新增），由 `!bundles.includes(...)` 保证幂等——于是它对已存在的包也会判定一次，**只要有 `bundle` 且没被 `disabled` 就补进 bundles**；② 它有 `preserveDisabled` 开关，本次操作前就关闭的 bundle 不会被加回（`market-parity.md:419`）。

**这意味着推论 ① 有边界**：走 `dsh plugin` CLI 用的是 `operations.js` 那份（只动新增）；但 Electron 桌面端自己走 `dsh-app-boot` 那份时，若调了不带 `preserveDisabled` 的路径，被摘掉的包**有被补回的可能**。这一点本次**未实测**（没在桌面端真实触发「装一个包 + 观察被停用包是否复活」），写进 13 节。本项目的自我保护是「停用状态也记进自己的账本」：即使 bundles 被补回，界面仍显示「已被停用」，且再次停用幂等。

### 4.5 一条残留行就能让整个 profile 起不来

`market-parity.md:442`：`dsh plugin` 只在 **pnpm 退出码为 0** 时才 reconcile。若 pnpm 失败但 `package.json` 里留了一行指向「下次启动解析不到的包」的 bundle，loader 在第一行就死，整个 profile 起不来（桌面端窗口都打不开）。

这就是本项目两处防御的来源：写 `package.json` 前先备份（`src/main/engine/bundles.ts:82-113`，备份到 `.dsh-console/backup/`）；官方通道做事时先把 `package.json` + `pnpm-lock.yaml` 读进内存快照，失败自动回滚（`MGR/lib/types/operations.js:318`、`:331-338`），并在 `:551-552` 区分「连 node_modules 一起恢复」和「只恢复两个文件、node_modules 需重装」两种结局。

---

## 5. `dsh plugin` CLI 的两条硬约束

### 5.1 它只转发参数，不做 bundles 簿记

`HOST/lib/bin.js:117-118` 的命令描述就是自述：

```
manage a profile's plugins by forwarding the remaining arguments to pnpm in the profile directory
argument("[args...]", "pnpm arguments, forwarded verbatim (add <pkg>, remove <pkg>, why <pkg>, ...)")
```

转发实现在 `HOST/lib/plugin-BiveYA7h.js:63-99`：构造 `context`（`:74-79`，含 `installAnchor: INSTALL_ANCHOR`）与 `options`（`:80-89`，`execution: "cli"`、`outputBytes: 16384`、`lockWaitMs: 12e4`、`lookupTimeoutMs: 12e4`、`onOutput` 直接写自己的 stdio），再按 profile 名分叉（`:90-93`）：

- `desktop` → `withFileLock(join(dir,'package.json'), …, {waitMs: 12e4})` 包住 `runProfilePnpm`（`:90-92`）
- 其它 profile → `runPluginCommand`（`:93`），后者**自带** `withFileLock`（`MGR/lib/types/operations.js:591-594`）

即：库函数 `runProfilePnpm` **不带锁**，带锁的是 `runPluginCommand` 这个外层包装。本项目直接调库，就必须自己加锁（6.4 节）。

### 5.2 `desktop` profile 被硬拒

`HOST/lib/bin.js:36-38`：

```js
function rejectElectronProfile(program, profile) {
    if (profile.toLowerCase() === "desktop")
        program.error("error: profile \"desktop\" is managed exclusively by the Electron application");
}
```

调用点在 `bin.js:120`（plugin 子命令）：`if (!manageDesktopProfile) rejectElectronProfile(plugin, options.profile);`。`manageDesktopProfile` 是 `parseDshArgs(argv, version, manageDesktopProfile = false)` 的第三个参数（`bin.js:99-102`），注释写得清楚：`@param manageDesktopProfile - permit Desktop's installed carrier to manage its reserved profile's plugins.`

即：**只有 Electron 桌面端自己的进程内部调用时才传 `true`**；外部进程 spawn `dsh plugin --profile desktop …` 在参数解析阶段就 `program.error` 退出，连 pnpm 都不会起。

### 5.3 结论：不能靠 spawn CLI 管 desktop profile

| 路 | 可行性 | 证据 |
| --- | --- | --- |
| spawn `dsh plugin --profile desktop add x` | **死** | `bin.js:120` + `bin.js:36-38` |
| 复用官方库 `runProfilePnpm` | 可行 | `plugin-BiveYA7h.js:90-92` 桌面端内部就是这么干的 |
| 自己拼 pnpm 命令 | 可行但残缺 | 拿不到 bundles 调和、兼容性门禁、快照回滚 |

本项目取第 2 条为主、第 3 条为降级（第 6 节）。

---

## 6. 本项目的选择：直接复用官方 `operations` 模块

### 6.1 为什么是库而不是 CLI

`market-parity.md:830-831` 给过一条建议：「所有包操作只走 `dsh plugin --profile X add|remove`，绝不自拼 pnpm 命令」。这条建议**在本机不成立**，原因就是 5.2 节：`desktop` 正是要管的那个 profile，而 CLI 对它直接退出。

所以本项目的实际选择是：**在库层复刻桌面端内部那条调用链**——同一个 `runProfilePnpm`、同一个 `INSTALL_ANCHOR`、同一把 `withFileLock`（`@deepseek-ai/dsh-atomic-write`），只把 stdio 从 `inherit` 换成 `pipe`、把环境变量自己拼。写报告时这点要讲清楚：参考文档写那条建议时**默认 CLI 对自己要管的 profile 可用**；一旦目标是 `desktop`，建议失效，必须下沉一层。

### 6.2 官方 `operations` 一次给五样东西

`MGR/package.json:39-42` 声明子路径导出 `"./operations": { "types": "./lib/types/operations.d.ts", "default": "./lib/types/operations.js" }`；本机落盘实现是 `MGR/lib/types/operations.js`（653 行）。它提供的五个能力正好覆盖本项目全部需要：

1. **`reconcile()` 的 bundles 调和**（`:96-124`）——第 4 节整节
2. **兼容性前置门禁**（`:351-374`）——对 `add`/`install`/`i` 后面的位置参数逐个 `namedSpecManifest` + `evaluatePluginCompatibility`，不兼容就 `rejected(preflight, 'nothing was installed')`（`:373-374`），**什么都不装，profile 未被改动**
3. **内存快照与失败回滚**（`:318` + `:331-338`）——`package.json` + `pnpm-lock.yaml` 读进内存，失败时 `writeFileAtomic` 还原或 `rm`
4. **诊断日志**（`:305-307`）——`<profile>/.plugin-manager/logs/operation-*/`，日志路径随结果返回（`plugin-BiveYA7h.js:96` 打印它）
5. **`withFileLock`**（`:59` 从 `@deepseek-ai/dsh-atomic-write` 引入；`:591-594` 用 `join(dir,'package.json')` 做锁文件）——跨进程写锁

### 6.3 `resolveOfficialPaths()` 解析哪三个文件

`src/main/engine/dshpm.ts:122` 的 `resolveOfficialPaths(installRoot)`，候选只有一组（`:105-117`）：

```
runtimeDir    = <installRoot>/resources/app/dsh
scope         = <runtimeDir>/node_modules/@deepseek-ai
installAnchor = <scope>/dsh/package.json
opsEntry      = <scope>/dsh-plugin-manager/lib/types/operations.js
atomicEntry   = <scope>/dsh-atomic-write/lib/index.js
```

命中条件是**双存在**（`:127`）：`existsSync(opsEntry) && existsSync(installAnchor)`。`atomicEntry` 只用于 `withOfficialLock`，缺了不影响 `runProfilePnpm` 本身。加载方式是**动态 ESM import**（`:147-157`：`import(pathToFileURL(entry).href)`）——主进程产物是 CJS（工程刻意不加 `"type": "module"`，见 `docs/report/02-架构与实现.md` 1.2 节），只能这样跨进 ESM 世界。

### 6.4 `execution` 必须是 `'service'`

`MGR/lib/types/operations.js:382-385`：

```js
stdout: options.execution === 'cli' ? 'inherit' : 'pipe',
stderr: options.execution === 'cli' ? 'inherit' : 'pipe',
killDescendants: options.execution === 'service',
buffer: false, stdin: options.execution === 'cli' ? 'inherit' : 'ignore',
```

`'cli'` 模式下子进程直接继承父进程 stdio 句柄，输出根本不经过 Node——于是 `options.onOutput` **永远不会被调用**（`:416` 只在 `collect()` 里被调，`collect` 只在 piped 时有意义），返回值的 `output` **永远是空串**（`:323-329` 的 `append` 同理空转）。官方 CLI 自己就用 `execution: "cli"`（`plugin-BiveYA7h.js:82`），因为它有终端可以继承；本项目是 GUI，要拿输出做进度条和失败摘要，所以 `src/main/engine/dshpm.ts:297` 写 `execution: 'service'`。

顺带一个副作用：`killDescendants: options.execution === 'service'`（`:384`）——`'service'` 下 execa 杀整棵进程树（注释 `:376-378`：生命周期脚本会活得比 pnpm 久），正是 GUI 需要的：用户点「取消」必须把 pnpm 起的那一堆 node 子进程一起收掉。

### 6.5 官方只有静默超时，没有整轮超时

`MGR/lib/types/operations.js:397-408` 的 `armIdle()`：`if (control.settled || options.idleTimeoutMs === undefined) return;`，定时器到点 `control.stalled = true; child.kill()`。语义是「**多久没有输出**就杀」——只要 pnpm 一直有输出，它就能跑到天荒地老。这对落后网络下的 git 依赖（clone 一个慢仓库）是真风险。

本项目补了两层（`src/main/engine/dshpm.ts:270-276`）：自己的整轮上限 `timeoutMs ?? 10*60_000` → `setTimeout(() => controller.abort(...))`；用 `AbortSignal.any([controller.signal, opts.signal])` 把「整轮超时」和「用户点取消」合成一个信号传给 `options.signal`——官方在 `:385-386` 已经把它和内部的 `cancellation.signal` 又 `AbortSignal.any` 一次，链路是通的。静默超时仍保留，默认 `idleTimeoutMs ?? 5*60_000`。

### 6.6 PATH 必须由调用方塞进 `options.env`

`MGR/lib/types/operations.js:330`：

```js
const environment = { ...(options.execution === 'cli' ? process.env : scrubbedParentEnv()), ...options.env };
```

`'service'` 模式下基线是**被清洗过的** `scrubbedParentEnv()`，不是 `process.env`；更狠的是 execa 的 `extendEnv: false`（`:381`）——连 Node 默认的环境继承都不做，给的 `env` 是什么就是什么。后果很具体：`PATH` 不在 → pnpm 起的 npm 生命周期脚本、git 依赖的 `prepare`、任何 `spawn('node')` 都找不到可执行文件；`HOME` / `APPDATA` / `USERPROFILE` / `SystemRoot` 缺失 → 部分工具链直接行为异常（Windows 上 `SystemRoot` 缺失尤其容易出怪问题）；代理变量（本机 `http_proxy` 指向 `http://127.0.0.1:65535`）也必须显式传。所以 `src/main/engine/ops.ts:340-354` 调 `dshpm.runOfficialChange` 时显式带了 `env: childEnvFor(settingsSnapshot)`。

### 6.7 `INSTALL_ANCHOR` 是什么

`HOST/lib/plugin-BiveYA7h.js:1`：`import { t as INSTALL_ANCHOR } from "./profile-boot-C14i-8IN.js";`。来源是 `HOST/lib/profile-boot-*.js` 里的 `fileURLToPath(new URL('../package.json', import.meta.url))`——即 `HOST/node_modules/@deepseek-ai/dsh/package.json`，**DSH 自己的 manifest**。

它作为 `resolveBundleDir('dsh', name, anchor, dir)` 的 `anchor` 参数：`reconcile` 需要区分「profile 目录里的包」和「安装目录里的官方包」（后者不在 `profile/node_modules` 下，而在 `HOST/node_modules` 下），锚点就是入口。本项目的对应物是 `src/main/engine/dshpm.ts:105-117` 的 `installAnchor = <scope>/dsh/package.json`，语义一致。

### 6.8 没有随包发 `.d.ts`，降级链兜住

`MGR/package.json` 的 `exports` 写了 `"types": "./lib/types/operations.d.ts"`，`files` 也写了 `lib/types/**/*.d.ts`（`:55`）——但**实际装到本机的包里 `lib/types/` 只有 13 个 `.js`，一个 `.d.ts` 都没有**（实测：`build-approval` / `failure` / `github-connection` / `index` / `install-failure` / `install-spec` / `official-install-target` / `operations` / `patch` / `registry` / `run-tree` / `tools` / `types`）。于是本项目只能手写形状声明：`src/main/engine/dshpm.ts:87-97` 的 `interface OfficialOperations`（只声明真正用到的 `runProfilePnpm` 与可选的 `reconcile`），注释里明写「没有随包发 .d.ts」。这是**有意的窄声明**：官方升级加了参数，这里不会因类型对不上而编译失败，只会行为不同——所以运行期还有一层 `typeof ops.runProfilePnpm === 'function'` 探测。

降级链：

```
officialAvailable(installRoot)?
   ├─ 是 → withOfficialLock → runProfilePnpm(execution:'service') → reconcile + 门禁 + 快照回滚
   └─ 否 → throw OfficialUnavailableError → 捕获 → pnpm.runPnpm（自建 pnpm）
```

代码路径 `src/main/engine/ops.ts:233`（探测）→ `:235`（走官方）→ `:236-239`（只捕 `OfficialUnavailableError`，日志「官方通道不可用（…），改用自带 pnpm」）→ `:242-251`（退化到 `pnpm.runPnpm`）；异常类型在 `dshpm.ts:198-203`。设计要点：**只捕 `OfficialUnavailableError`**，不 catch 一切——跑失败（pnpm 退出码非 0）是业务结果，不该被降级逻辑吞掉。

### 6.9 什么时候整条官方通道就是不可用

`getInstallRoot()` 拿不到 → `installRoot === null` → `resolveOfficialPaths(null)` 返回 `null` → `officialAvailable` 为假 → 每次操作都走降级。`getInstallRoot` 的候选顺序（`src/main/engine/env.ts:119-166`）：设置 → `DSH_INSTALL_ROOT` → `<dshHome>/dsh-purge/desktop-install.txt` 首行 → `LOCALAPPDATA\Programs\DeepSeekHarness` → `C:\Program Files\DeepSeekHarness` → `LOCALAPPDATA\deepseek-harness`；每个候选过校验 `:113-117`：`<候选>/resources/app/package.json` 的 `name === '@deepseek-ai/dsh-desktop'`。所以「DSH 装在奇怪路径 + 没配设置」这一种情况下官方通道全灭——不是坏，是设计上退化成自建 pnpm（第 12 节第 3 条）。

---

## 7. pnpm 11 的三个硬钉子

### 7.1 构建脚本默认被拦

**现象**：git 装的插件，`prepare` / `build` 不跑，包装上了但 `lib/` 是空的，运行期报找不到入口。pnpm 报 `ERR_PNPM_GIT_DEP_PREPARE_NOT_ALLOWED`，并要求往 `<profile>/pnpm-workspace.yaml` 的 `allowBuilds` 写一条**带完整 codeload URL 的精确 key**。本机实测到的两条真实 key（`docs/_log.md:121` 附近）：

```yaml
allowBuilds:
  'dshmarket@https://codeload.github.com/dsh-market/dsh-market/tar.gz/c01a967a…': true
  dshmarket@1.73.8: true
```

第一条含 40 位 commit、含 `://`、含 `.` 和 `/`——**用户不可能自己猜出来**，而 pnpm 把它打印在报错里、只打印一次。

**本项目的解法是自愈**（`src/main/engine/profileYaml.ts`）：① 从 pnpm 输出解析 key —— `parseGitPrepareKeys(log)`（`:295-336`）认三种形态（`allowBuilds:` 块里已写好的 `key: true` / `git-hosted package "([^"]+)" needs to execute build scripts` / `Ignored build scripts:` 后的逗号列表）；② 备份原文件 —— `backupYaml`（`:55-67`）→ `.dsh-console/backup/pnpm-workspace.yaml.<时间戳>.bak`；③ 写入 —— `ensureAllowBuilds`（`:194-198`）→ `ensureBlock`（`:108-188`）能处理三种现状（已有行内 flow map / 已有块式 / 整块不存在），空文件甚至先补 `packages: ['.']`（`:119-121`）；④ 原子落盘 `writeAtomic`（`:69-83`：`<target>.<pid>.tmp` + `rename`）；⑤ 重试 —— `ops.ts:278-292`，**最多 2 轮**。

key 的引号处理单独有 `yamlKey()`（`:49-53`）：不安全就单引号包裹、内部 `'` 转成 `''`；上面那条 codeload key 就靠它才写成合法 YAML。写进去之后 pnpm 的行为会变：`docs/_log.md:113-140` 记录实测 `Build complete in 110ms`。

### 7.2 供应链冷却把 `@latest` 悄悄压回旧版

**现象**：`dsh-context` 远端最新 `0.79.0`，但 `pnpm add dsh-context@latest` 只装到 `0.78.2`。原因是 pnpm 11 的 `minimumReleaseAge` 默认拒绝「太新」的版本，且**不报错**，只是把你 pin 回一个它认为够老的版本。后果在界面上很直接：「可更新」按钮永远亮着，点一百次都升不上去。

**正解是钉精确版本**（`pnpm add dsh-context@0.79.0`），而不是豁免冷却——这样 pnpm 自己会往 `pnpm-workspace.yaml` 打一行 `Added 1 entry to minimumReleaseAgeExclude in pnpm-workspace.yaml`。本机 `PROFILES\desktop\pnpm-workspace.yaml` 里 `minimumReleaseAgeExclude` 已有 10 条（形如 `dsh-context@0.61.0 || 0.71.0 || 0.73.3 || 0.76.0 || 0.78.1`），就是这套机制留下的沉积层。`ensureReleaseAgeExclude`（`profileYaml.ts:204-247`）+ `parseMinimumReleaseAgeKeys`（`:339-351`）是兜底路径：装完发现版本比预期低，就把 key 补进去再装一次（`ops.ts:1201-1237`）。

**关键坑（本项目在这条上卡过一次）**：`opUpdate` 里读盘的 `PluginRecord.latestVersion` **一律是 `null`**——`inventory.ts:308-312` 在生成记录时把它初始化为 `null`、`updateAvailable` 为 `false`，真正的远端查询发生在 `updates.checkUpdates`。于是 `ops.ts:1161` 这行：

```ts
rec.sourceKind === 'npm' ? `${name}@${rec.latestVersion ?? 'latest'}` : rec.spec
```

会拼出 `${name}@latest`，正好踩进 7.2 的坑。修复在 `:1166-1185`：装之前**先补一次远端查询**，把 `@latest` 改写成 `@<精确版本>`，再合并成一次 `['add', ...installArgs]`（`:1191`，一次 pnpm 调用装多个包，不是循环 spawn）。

### 7.3 `--reporter=append-only` 的位置

**规则**：必须插在**第一个非选项参数之前**（也就是子命令之前）。`pnpm --reporter=append-only add x` 合法；`pnpm add x --reporter=append-only` 在某些 pnpm 版本里会被当成给包的附加参数。

两条通道两种修法：**自建通道**用 `src/main/engine/pnpm.ts:461-477` 的 `withReporter(args)`——已有 `--reporter` / `--reporter=` 就完全不碰，否则找**第一个不以 `-` 开头的参数**（`:466-472`）把 `--reporter=append-only` `splice` 到它前面（注释 `:456-459` 把理由写死了：「插到第一个非选项参数之前（= 子命令之前），这样 `pnpm add x` / `pnpm install` 都合法」）。**官方通道**不能改 `args`（`:380` 会把它们 `anchorPathSpec` 后再拼到后面），所以把标志放进 `options.args` 前缀位——`src/main/engine/dshpm.ts:296` 的 `args: [pnpmPath, '--reporter=append-only']`，最终命令是 `node <pnpmPath> --reporter=append-only add <spec>`。

---

## 8. 一次安装的全过程

### 8.1 流程图（标了进程与磁盘文件）

```
┌─ 渲染进程 renderer ─────────────────────────────────────────────────┐
│  插件市场 / 已装列表里点「安装」→ window.dsh.ops.install({ spec })    │
└───────────────────────────┬─────────────────────────────────────────┘
                            │ ipcRenderer.invoke（contextBridge）
┌───────────────────────────▼─ 主进程 main（Electron）────────────────┐
│  ipc handler → ops.opInstall                                        │
│  ①  spec.parseSpec → 规范化 spec                                    │
│  ②  backupProfilePkg → .dsh-console/backup/package.json.<ISO>.json  │
│  ③  before 快照：listPlugins + bundlesSnapshot（只读）               │
│  ④  runPnpmAddish(['add', spec])                                    │
│        ├─ officialAvailable? ─→ withOfficialLock                    │
│        │                          → dshpm.runOfficialChange         │
│        │                            execution:'service'              │
│        │                            env = childEnvFor(...)           │
│        └─ 否 → OfficialUnavailableError → pnpm.runPnpm（自建）       │
│        └─ 失败按需自愈 pnpm-workspace.yaml，最多重试 2 轮            │
└───────────────────────────┬─────────────────────────────────────────┘
                            │ execa spawn（子进程）
┌───────────────────────────▼─ pnpm 子进程（cwd = profile 目录）──────┐
│  解析依赖 → 拉取/解包/git clone → 生命周期（prepare/build 受         │
│  allowBuilds 约束）→ 链接 node_modules                              │
│  写盘：node_modules/<pkg>/…  package.json  pnpm-lock.yaml            │
│        pnpm-workspace.yaml（自愈时由主进程写）                       │
│        .plugin-manager/logs/operation-*/pnpm.log                     │
└───────────────────────────┬─────────────────────────────────────────┘
                            │ 退出码回到主进程
┌───────────────────────────▼─ 官方库（主进程内执行，不是子进程）─────┐
│  退出码 0 → reconcile(before, dir, anchor)                          │
│    读 dependencies → 对新增项判 dsh.bundle.patch → 追加 bundles 末尾 │
│    → 序列化比较 → 有变才 saveManifest（写 package.json）            │
└───────────────────────────┬─────────────────────────────────────────┘
┌───────────────────────────▼─ 主进程收尾──────────────────────────────┐
│  ⑥ after 快照 → diff（added / swapped）                             │
│  ⑦ 官方通道：只 reportBundleDiff，不再手写 bundles                   │
│     自建通道：declaresBundle(pkg) || forceBundle 才 addBundle        │
│  ⑧ 从 .dsh-console/state.json 的 disabled 名单移除这些包             │
│  ⑨ finish(restartRequired: true) → 界面提示「重启 DSH 后生效」        │
└───────────────────────────┬─────────────────────────────────────────┘
                            │ 用户点「重启 DSH」（或 DSH 自己 HMR）
┌───────────────────────────▼─ DSH 宿主进程（新起或热重组）────────────┐
│  读 package.json → 按 bundles 顺序逐层装配 → 叠加 cordis.patch.yml   │
│  → 叠加 --patch 覆盖 → 每层读它自己的 dsh.bundle.patch               │
└─────────────────────────────────────────────────────────────────────┘
```

### 8.2 逐步对照表

| # | 位置 | 动作 | 动了磁盘上哪个文件 | 证据 |
| --- | --- | --- | --- | --- |
| 1 | renderer | `window.dsh.ops.install` | 无 | 契约层（见 `02-架构与实现.md` 3.7） |
| 2 | main | `spec.parseSpec` 规范化 | 无 | `ops.ts:896-904` |
| 3 | main | 备份 profile manifest | `.dsh-console/backup/package.json.<ISO>.json` | `bundles.ts:119-135` |
| 4 | main | before 快照 | 无 | `ops.ts:910-912` |
| 5 | main | 组装 execa 参数与环境 | 无 | `dshpm.ts:287-306`、`ops.ts:340-354` |
| 6 | pnpm 子进程 | 装包 | `node_modules/`、`package.json`、`pnpm-lock.yaml` | `MGR/lib/types/operations.js:380-387` |
| 7 | pnpm → main | git 依赖被拦 → 解析 key 自愈 | `pnpm-workspace.yaml`（`allowBuilds`） | `profileYaml.ts:295-336`、`ops.ts:278-292` |
| 8 | pnpm → main | 版本被冷却压回 → 补豁免 + 重装 | `pnpm-workspace.yaml`（`minimumReleaseAgeExclude`） | `profileYaml.ts:339-351`、`ops.ts:1201-1237` |
| 9 | main（官方库） | `reconcile()` 调和 bundles | `package.json`（`dsh.profile.bundles`） | `MGR/lib/types/operations.js:96-124` |
| 10 | main（官方库） | 写诊断日志 | `.plugin-manager/logs/operation-*/` | `MGR/lib/types/operations.js:305-307` |
| 11 | main | after 快照 + diff | 无 | `ops.ts:928-945` |
| 12 | main（自建通道） | 补写 bundles | `package.json`（`dsh.profile.bundles`） | `ops.ts:957-984` |
| 13 | main | 清停用账 | `.dsh-console/state.json` | `ops.ts:987-1004` |
| 14 | main | 返回 `restartRequired` | 无 | `ops.ts:1016` |
| 15 | DSH 宿主 | 按 bundles 装配 | 只读 | `cordis.yml` 头注释、`market-parity.md:821` |

**第 15 步要不要「重启」**：本项目保守地返回 `restartRequired: true`。而参考项目分析指出宿主自带 profile watcher，`dsh.profile.bundles` 变化后约 2 秒自己重组（`market-parity.md:777-789`，`PROFILE_HMR_ENTRY = '@deepseek-ai/dsh-hmr'`，等 replay 上限 8 秒）。两者不矛盾——HMR 是「宿主已经在跑」时的路径，装上来的**新包代码**要不要重新 import 一遍本次**未实测**，所以本工具仍让用户重启，把它当兜底。

---

## 9. 「装了什么」vs「加载了什么」：差集与可视化

### 9.1 22 条记录怎么来

```
dependencies  16 ─────────┐
                           ├─ 交集 12 ─→ 装了且在加载列表
dsh.profile.bundles 18 ────┘
        ├─ 只在 bundles 的 6 个：@deepseek-ai/dsh-base / dsh-web-app /
        │   dsh-experimental-voice-input-bundle / -plugin-market-bundle /
        │   -terminal-bundle / -tool-worktree     ← 官方基座，不在 profile deps
        └─ 只在 dependencies 的 4 个：dsh-custom-brand / dsh-pet /
            dsh-raccoon-merge / dsh-whale-widget   ← 装了但没加载

并集 = 16 + 6 = 22 条记录
```

`src/main/engine/inventory.ts:359-371` 就按这个并集出记录。

### 9.2 差集为什么会存在：四种成因

「装了但没进加载列表」不是 bug，它有四种互相独立的成因，而界面上看起来是同一个现象。

**成因 1：包本身没声明 `dsh.bundle.patch`。** 就是 3.3 的告警，这类包永远进不了 bundles（`:110-113`）。本机当前 4 个「装了没加载」的包**都不是这一类**——它们四个全都声明了（3.5 节实测）。

**成因 2：用户在 DSH 里停用了（`bundles` 被摘掉）。** 本工具的停用就是这个语义：摘 `bundles` + 记下标（`ops.ts:1321-1333`）。`state.json` 当前 `disabled` 是空对象，所以本机当前也不是这一条。

**成因 3：用户层 patch 把它按住了（`cordis.patch.yml` 里 `disabled: true`）。** 本机 `PROFILES\desktop\cordis.patch.yml` 里至少两处直接对应这个差集：`- id: custom-brand` / `  disabled: true`（`:442-443`）、`- id: raccoon-merge` / `  disabled: true`（`:444-445`）。`readPatchDisabledIds()`（`src/main/engine/patch.ts:206-219`）把顶层条目的 `id` 与 `name` 都收进集合，再经 `patchDisables()`（`inventory.ts:246-259`）做四种变体匹配（原 id / 去 scope / 去 `dsh-` 前缀 / camelCase），所以 `custom-brand` 能对上 `dsh-custom-brand`。这就是 3.5 表里那 4 个包的真相：**它们是有效插件，只是被 patch 层关了**（或从来没被加进去过）。

**成因 4：安装时跳过了加 bundles 这一步。** 自建通道里若 `declaresBundle` 判定失败（比如包还没装完就去读它），或官方通道在 pnpm 失败时根本没走到 `reconcile`。这一条本机没有实证，标「未核实」。

### 9.3 本工具怎么把它画出来：`GapStrip.tsx`

`src/renderer/src/components/GapStrip.tsx`（129 行）的定位写在头注释（`:1-12`）：「一格 = 一个依赖；实心 = 它进了 `dsh.profile.bundles`（DSH 真的会加载它）；下沉的空心缺口 = 装了但不在 `bundles` 里」。三个实现关键点：

1. **一格 = 一个已装插件**（`:37-44` 的 `buildTicks`：`.filter(p => p.installed)`），`index` 取 `p.bundleIndex`，`loaded = p.inBundles && !p.disabled`
2. **水平次序 = `bundles` 数组下标**（`:46-54` 排序：有下标的按下标升序在前，没下标的排最后）。于是刻度带左半部分是「真实的加载顺序」，右端那截没有下标的格子是「装了但没有位置」
3. **下沉表达缺口**：CSS 类切换 `gap-strip__tick` / `gap-strip__tick--gap`（`:106`），`aria-label` 把整句读出来（`:103`）：「共 N 个已装插件，M 个已加载，K 个不在加载列表」；`titleOf()`（`:59-63`）给单格三种文案：`bundles[3] · 已加载` / `bundles 无此下标 · 不在加载列表` / `bundles[7] · 已被停用`

两个工程细节：超过 56 格换密排（`:17` `DENSE_LIMIT`，注释说 1px 间隙会糊成一条黑带）；数据不可信时（列表加载失败）整条带子切成错误态而不是假装有数据（`:68-77`）；竖排收起态只画前 42 格（`:19` `V_TICKS`），多的用 `+N` 标出来（`:122-126`）。

头注释里写的「18 个依赖里 4 个没进加载层」是写下时的快照数字；当前实测是 16 个依赖、18 个加载层、22 条记录（2.4 节）。**注释里的数字会随 profile 漂移，代码不会**——这个组件每次从 `PluginRecord[]` 现算。

---

## 10. 参考项目 dsh-market 的逆向结论

`MARKET-REF` 是从 GitHub clone 的参考仓库（**只有 `src/`，没有 `lib/`**，即没有构建产物）。完整分析在 `docs/market-parity.md`（858 行，16 个问题逐条带 `文件:行号`）。这里抽与本章机制相关的五条，每条标明是「引用」还是「本章核实」。

### 10.1 它的已装列表只读 `dependencies`

`market-parity.md:25`（引用）：枚举已装插件「直接读 `<profile>/package.json` 的 `dependencies`，不用 `--dump-config`，也不用 `npm ls`」，代码在 `MARKET-REF/src/profile.ts:59 readInstalled()`。它读的是 `dependencies` **加上**内置 bundle 白名单 `INBOX_BUNDLES = new Set(['@deepseek-ai/dsh-base','dsh-web-app','dsh-headless'])`（`market-parity.md:46-54` 引 `src/profile.ts:52`）——用「硬编码 3 个内置包」绕开 2.4 节那个并集问题。而 `desktop` 的 `bundles` 里其实有 6 个 `@deepseek-ai/*`，白名单会漏掉 `dsh-experimental-*-bundle`。这条本章只做了文件对比，没跑它的界面，标「引用 + 差异推断」。

### 10.2 它自己不写 bundles

`market-parity.md:397`（引用）：**正常路径下 dsh-market 自己不写 `bundles`**，靠宿主在 `dsh plugin add` 内部调和；只在「拆分安装 / 恢复重试 / 开关」这些异常路径上手写，且都是 `bundles.push(name)` 末尾追加（`market-parity.md:428-438` 引 `src/routes.ts:2130-2169`）。这和第 4 节完全对上：官方唯一的追加语义就是末尾追加，任何实现都不该插队。

### 10.3 它写 `cordis.patch.yml` 的精确格式

`market-parity.md:522-530`（引用 `MARKET-REF/src/patch.ts:496`）——生成器只有一行模板：

```ts
return `- id: ${rowId}\n  disabled: ${disabled ? 'true' : 'false'}\n`
```

即 **`- id: <rowId>` + 换行 + 两空格缩进 `disabled: true`，不带 `name:`，不带引号**。id 由 `ROW_ID_RE = /^[A-Za-z0-9_.-]+$/u`（`market-parity.md:530`）保证是纯标量，永远不会触发 YAML 引号问题。启用方向是**删掉那个块**，不是写 `disabled: false`（`market-parity.md:550-563` 引 `src/patch.ts:670 enableRow()`）；只有「下层把它按住」时才补一条 `disabled: false`。

它踩过的两个坑（`market-parity.md:565-570`）：删到只剩注释文件 → DSH 启动报 `must be a top-level YAML array of loader patch entries`，profile 直接变砖，所以要 `withPlaceholderRestored()` 把 `# []` 复活成 `[]`；顶层是 `[` / `{` 或解析失败时**拒绝追加**，否则会把用户的 flow 风格 YAML 写坏。

### 10.4 它停用是两层同写，本项目 v1 只写一层

`market-parity.md:578-605`（引用 `MARKET_REF/src/routes.ts:1119 switchPluginLayers()`）：**停用两层同写**——摘 `bundles`（`removeProfileBundle`）+ 写 patch 层 `disabled: true`；启用是 `addProfileBundle` + 删 `disabled: true`；且启用方向「一层失败两层都不写并回滚」（`:604`）；`INBOX_BUNDLES` 永不动（`:605`）。

本项目 v1 刻意**只写 `bundles`**，patch 层只读不写（`src/main/engine/patch.ts:19` 明写「全部只读：本模块不写文件」）。理由：patch 层是**用户手写的层**（`PROFILES\desktop\cordis.patch.yml` 是 468 行、带大量 `config:` 的人写文件），写它等于抢用户的手；只写 bundles 已足够「下次启动不加载」，因为 bundles 才是装配入口；反过来读 patch 层是必须的，否则界面会把「被 patch 关掉」的包显示成「已加载」（9.2 成因 3）。代价要说清楚：**被 patch 层按住的包，本工具停用按钮的语义是「摘 bundles」，而它本来就不在 bundles 里**——这种情况下按钮会显得没反应，是 v1 的已知取舍（13 节）。

### 10.5 更新检测：npm 走 semver，git 比 commit

`market-parity.md:213-252`（引用）：npm 包打 `registry.npmjs.org/<name>/latest`（10s）+ semver 比较，失败回退全量 packument；git 依赖**比 commit**，扫 `pnpm-lock.yaml` 里记的 revision；远端最新**不走 `api.github.com`**（额度限制），走 git ref advertisement：`<remote>/info/refs?service=git-upload-pack`，6s 超时（`MARKET_REF/src/updates.ts:156 resolveGitRemoteHead`）；读远端 `package.json` 走 `raw.githubusercontent.com/<repo>/HEAD/<path>`，6s（`market-parity.md:221`）。五条降级：`/latest` 429 → 回退 packument；`time[version]` 缺失 → cache-buster 重试；拿不到发布时间 → `UNKNOWN_PUBLISH_HOLD_MS = 30*60*1000`；任何异常 → `updateAvailable: false`；非插件 → `notAPlugin: true`。缓存 `UPDATES_TTL_MS = 30*60*1000`。

「不走 `api.github.com`」在本机是硬约束不是优化：`docs/_log.md:231` 记录本机出口 IP 203.10.99.66 的匿名额度已被打光（`API rate limit exceeded for 203.10.99.66`），`docs/_log.md:278` 重复了一次。

### 10.6 它没有自由粘贴入口，包名装完才读

`market-parity.md:854-855`（引用）：不给「粘贴任意 GitHub URL 就装」的入口，只从目录条目装，且 tarball 必须属于条目自己的 repo。包名不在远端猜：装完读 `node_modules/<pkg>/package.json` 的 `name`（`market-parity.md:67-73` 引 `MARKET_REF/src/profile.ts:473 readInstalledPackageName()`）。原因很实在：一个 git 仓库的 `package.json` 里的 `name` 可能和仓库名完全不同，猜错就会往 `bundles` 里写一个解析不到的名字——正好是 4.5 节那条「整 profile 起不来」的引信。

---

## 11. 社区插件目录的数据源

### 11.1 目录内容在哪

目录不是某个 API，而是**一个 npm 包里的一个 JSON 文件**：包名 `dsh-plugin-catalog`，文件 `package/plugins.json`（`src/main/engine/market.ts:38-40`）。

### 11.2 三级抓取

`src/main/engine/market.ts` 头部注释（`:4-11`）写死了优先级：① `GET <registry>/dsh-plugin-catalog/latest` → 取 `dist.tarball` → 下载 → gunzip → 解 tar → 取出 `package/plugins.json`（`:445-460`）；② 回退 `registry.npmmirror.com`（`:44 NPM_MIRROR`）；③ 再回退 `https://awesome-dsh-plugin.com/plugins.json` 直取原件（`:42 CATALOG_ORIGIN`）。`dist.tarball` 缺失时给的是明确错误而不是静默空表（`:459-460`：「包信息里没有 dist.tarball（版本 …）」）。

tar 解析是**零依赖手写**的（`:54-60` 常量区）：`NAME_OFFSET 0/100`、`SIZE_OFFSET 124/12`、`TYPE_OFFSET 156`、`BLOCK 512`——工程不带 `tar` 依赖，自己按 USTAR 头字段切。

### 11.3 实测体量与缓存

本机磁盘缓存实测（`C:\Users\YBY\AppData\Roaming\DSH 插件台\catalog.json`）：

| 指标 | 值 |
| --- | --- |
| 文件大小 | **9,650,826 字节（9.65 MB）** |
| 条目数 `count` | **8281** |
| `plugins` 数组长度 | 8281 |
| 分类数 | **23**（agi, ui, usage, theme, model, identity, session, memory, tools, wsl, browser, vision, voice, docs, skill, workflow, git, notify, dev, security, remote, market, fun） |
| `updated` | `2026-11-01` |
| `source` | `npm-package`（走的是第 1 级抓取） |
| TTL | 6 小时（`market.ts:50 CACHE_TTL_MS = 6*60*60*1000`） |

缓存位置 `cachePath()` = `join(dirname(getSettingsPath()), 'catalog.json')`（`market.ts:229`），即 Electron `userData` 目录下。两个防御性设计：**空目录不算缓存命中**（`:243-245`，宁可重拉也不要拿坏数据糊弄界面）；**只写非空目录**（`:263-265`），`.tmp` + `rename`，写盘失败静默兜底（内存里那份已生效）。分类不是目录里写好的，而是**现场统计**出来的（`buildCategories`，`:598-608`：按每个插件实际带的 `category` 计数、只留 `count > 0`、按数量降序）——所以 23 是「当前目录里真正被用到的分类数」，不是固定枚举。

---

## 12. 哪些路是死路（诚实清单）

| # | 死路 | 为什么死 | 证据 |
| --- | --- | --- | --- |
| 1 | spawn `dsh plugin --profile desktop …` | 参数解析阶段就 `program.error` 退出，pnpm 都不会起 | `HOST/lib/bin.js:36-38`、`:120`；`manageDesktopProfile` 只由 Electron 内部传 `true`（`:99-102`） |
| 2 | 靠 `api.github.com` 查插件远端最新 | 匿名 60 次/小时，本机出口 IP 已被打光 | `docs/_log.md:231` `API rate limit exceeded for 203.10.99.66`；`:278` 重复 |
| 3 | `getInstallRoot()` 拿不到时还想走官方通道 | `resolveOfficialPaths(null)` 直接 `null`，每次都降级 | `env.ts:113-166`；`dshpm.ts:122-127` |
| 4 | 用 `execution: 'cli'` 在 GUI 里拿输出 | stdio 被 `inherit` 掉，`onOutput` 永不触发、`output` 永远空 | `MGR/lib/types/operations.js:382-385`、`:416` |
| 5 | 只靠 `idleTimeoutMs` 防挂死 | 它是「静默超时」，一直有输出就不会杀 | `MGR/lib/types/operations.js:397-408` |
| 6 | 传了 `options.env` 就不管 PATH | `'service'` 基线是 `scrubbedParentEnv()`，且 `extendEnv: false` | `MGR/lib/types/operations.js:330`、`:381` |
| 7 | 把 `--reporter=append-only` 塞在位置参数后面 | 位置非法，某些 pnpm 版本会当成包参数 | `pnpm.ts:456-477` 的正解与注释 |
| 8 | `pnpm add <pkg>@latest` 当更新用 | 供应链冷却静默压回旧版，「可更新」永远亮 | 7.2 节；`ops.ts:1201-1237` |
| 9 | 停用时顺手把 patch 层也写了（v1 的选择） | 抢用户手写层，还要处理「删空变砖」 | 10.4 节；`patch.ts:19` |
| 10 | 前端猜包名往 bundles 里写 | git 仓库名 ≠ `package.json` 的 `name`，写错就是一条解析不到的 bundle 行 | 4.5 节；`market-parity.md:442` |

第 1~3 条是**能力边界**（做不到），第 4~10 条是**行为陷阱**（能做但会错）。写在这里的意义：后续谁要动这几处，先看一眼这张表。

---

## 13. 未核实与待验清单

1. **桌面端自己走 `dsh-app-boot` 的 `reconcileProfilePlugins` 时，会不会把用户停用过的包补回 `bundles`。** 4.4 节的边界，本次没有在真实桌面端触发。验证方法：一次性 profile 里停用一个包 → 用桌面端 UI 装另一个包 → 读 `package.json` 看 bundles 是否变长。
2. **新装的包在 HMR 下能否免重启生效。** 宿主 watcher 重组 bundles 有据（`market-parity.md:777-789`），但「新包代码会不会被重新 import」没实测；本工具仍返回 `restartRequired: true`。
3. **`dsh-plugin-catalog` 的 23 个分类是否稳定。** 8281 条 / 23 类是本次快照（`fetchedAt=1793595908254`），`buildCategories` 现算，上游改分类会直接反映到数字上。
4. **被 patch 层按住的包，本工具停用按钮「没反应」的体验问题。** 10.4 节末的已知取舍，只在代码语义层面确认，没有实机点过。
5. **`MARKET-REF` 的 `INBOX_BUNDLES` 白名单漏 `dsh-experimental-*-bundle` 的实际影响。** 10.1 节是从两边源码对比推出的差异，没跑参考项目界面做对照。
6. **`docs/market-parity.md` 全篇结论均为二手**（引用 `MARKET-REF` 源码行号，未运行）。本章引用处都标了「引用」。

---

## 14. 本章证据索引

| 主题 | 一手证据 |
| --- | --- |
| 「是不是加载层」判据 | `MGR/lib/types/operations.js:83-87` |
| bundles 调和算法 | `MGR/lib/types/operations.js:96-124`（写盘 `:120-123`） |
| 兼容性前置门禁 | `MGR/lib/types/operations.js:351-374`（拒绝文案 `:342`） |
| 快照与回滚 | `MGR/lib/types/operations.js:318`、`:331-338`、`:541`、`:551-552` |
| 诊断日志 | `MGR/lib/types/operations.js:305-307` |
| `execution` 决定 stdio | `MGR/lib/types/operations.js:379-387` |
| 静默超时 | `MGR/lib/types/operations.js:397-408` |
| 环境变量基线 | `MGR/lib/types/operations.js:330` |
| 跨进程锁 | `MGR/lib/types/operations.js:591-594`；`dshpm.ts:206-223` |
| desktop 硬拒 | `HOST/lib/bin.js:36-38`、`:120`；`plugin-BiveYA7h.js:64-69` |
| CLI 只转发 | `HOST/lib/bin.js:117-118`；`plugin-BiveYA7h.js:80-93` |
| 官方路径解析 | `src/main/engine/dshpm.ts:105-127`、`:147-157` |
| 本项目调用官方库 | `src/main/engine/dshpm.ts:287-309`；`ops.ts:315-374` |
| 降级链 | `ops.ts:233-251`；`dshpm.ts:198-203` |
| allowBuilds 自愈 | `src/main/engine/profileYaml.ts:295-336`、`:108-198`；`ops.ts:278-292` |
| 供应链冷却 | `src/main/engine/profileYaml.ts:204-247`、`:339-351`；`ops.ts:1201-1237` |
| reporter 位置 | `src/main/engine/pnpm.ts:456-477`；`dshpm.ts:296` |
| 安装主流程 | `src/main/engine/ops.ts:894-1016` |
| 停用/启用 | `src/main/engine/ops.ts:1277-1348`；`bundles.ts:156-182`；`state.ts:27-29`、`:70-94` |
| 清单并集 | `src/main/engine/inventory.ts:344-398`、`:261-336` |
| patch 层只读 | `src/main/engine/patch.ts:19`、`:206-219` |
| 缝隙刻度 | `src/renderer/src/components/GapStrip.tsx:1-12`、`:37-57`、`:89-106` |
| 目录数据源 | `src/main/engine/market.ts:4-11`、`:38-52`、`:229-295`、`:445-460`、`:598-608` |
| 参考项目结论 | `docs/market-parity.md:25`、`:397-442`、`:522-570`、`:578-605`、`:766-791`、`:815-824`、`:828-858` |