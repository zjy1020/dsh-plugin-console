# dsh-market 实现事实文档（供 DSH 插件台对齐）

> 取证对象：`D:\项目\DSH\_recon\dsh-market`（`package.json` name=`dshmarket`, version=`1.73.8`, git HEAD `c01a967a2603f670795eea7e4e1bd9717e05d3ff`）。
>
> **重要更正**：任务描述里说「已编译产物在 `lib/`」——该目录**不存在**（`.gitignore` 排除，仓库只提交 `src/`）。因此本文所有证据均取自 `src/` 的 TypeScript 源码。行号按该 commit 的 `src/` 文件计。
>
> 参考实现分两层：**dsh-market 自己的 src/**（下文 `src/xxx.ts`）与**宿主 DSH 的实现**（下文 `HOST/dsh-app-boot/lib/index.js`、`HOST/dsh/lib/plugin-BiveYA7h.js`，指 `D:\Dowloads\DeepSeekHarness\resources\app\dsh\node_modules\@deepseek-ai\`）。凡是「最终由谁执行」的问题，答案几乎都在宿主层。

---

## 0. 一句话总览

dsh-market **不自己读写 DSH 的插件装配逻辑**，它只做三件事：

1. **读**：直接读 `<profile>/package.json` 的 `dependencies` + `dsh.profile.bundles`，直接读 `<profile>/cordis.patch.yml` 的文本行，直接读 `<profile>/node_modules/<pkg>/package.json`。**全程不调 `dsh --dump-config`**。
2. **写**：所有包操作都**委托给 `dsh plugin --profile <p> add|remove|update|install`**，自己只写两处非包管理的状态——`cordis.patch.yml`（停/启用行）与 `.dsh-market/state.json`（自己的开关记录、分组、区域等）。
3. **生效**：靠宿主对 profile 配置文件的**文件监听 + 自动重组合**（约 1～2 秒），只在必须整进程重启时提供「一键重启」（detached 辅助进程等待端口释放后重放原 argv）。

---

## A. 清单与状态

### A1. 如何枚举「已装插件」？读哪些文件？

**结论：直接读 `<profile>/package.json` 的 `dependencies`，不用 `dsh --dump-config`，也不用 `npm ls`。**

`src/profile.ts:59`：

```ts
export function readInstalled(profile: string, explicitDir?: string): Record<string, string> {
  try {
    const manifest = JSON.parse(
      readFileSync(join(profileDir(profile, explicitDir), 'package.json'), 'utf8'),
    ) as { dependencies?: Record<string, string> }
    const dependencies = manifest.dependencies ?? {}
    const installed: Record<string, string> = {}
    for (const [name, spec] of Object.entries(dependencies)) {
      if (INBOX_BUNDLES.has(name)) continue
      installed[name] = spec
    }
    return installed
  } catch { return {} }
}
```

`src/profile.ts:52` 的内置白名单只有三条：

```ts
export const INBOX_BUNDLES = new Set([
  '@deepseek-ai/dsh-base',
  'dsh-web-app',
  'dsh-headless',
])
```

profile 目录解析（`src/profile.ts:39`）：

```ts
export function profileDir(profile: string, explicitDir?: string): string {
  if (explicitDir !== undefined) return explicitDir
  return join(resolveDshHome(), 'profiles', profile)
}
```

辅助的只读接口：

| 用途 | 位置 |
| --- | --- |
| 「谁声明了它」——区分用户直选插件 vs pnpm auto-install-peers 带进来的传递依赖 | `src/profile.ts:153` `readDependencyOwners()`，扫 `dependencies`/`optionalDependencies`/`peerDependencies` |
| `node_modules` 顶层包名（含 `@scope/` 目录） | `src/profile.ts:197` `topLevelPackageNames()` |
| 已装包的真实版本 | `src/profile.ts:458` `readInstalledVersion()`，读 `node_modules/<name>/package.json` 的 `version` |
| 已装包的真实包名 | `src/profile.ts:473` `readInstalledPackageName()`，读同一文件的 `name` |
| 回滚快照（deps 原文 + bundles 是否存在） | `src/profile.ts:242` `readProfileManifestSnapshot()` |

**反证**：`--dump-config` 在 dsh-market 的 `src/` 里只出现在 `src/check.ts:1096 / 1106 / 1134` 三处**注释**里，没有任何调用点。

---

### A2. 如何判断一个插件「已停用」？

**结论：有两套记录，但有唯一权威——`cordis.patch.yml`（patch 层）。`.dsh-market/state.json` 的 `disabled` 数组是「市场自己的开关记录」，它在启动时被**重放**成运行时的禁用，并在 patch 层显示「外部已启用」时自我纠正。**

1）patch 层是唯一共同真相。`src/routes.ts:790` 的注释原文（节选）：

```ts
/**
 * Follow an enable made OUTSIDE the market (#696).
 *
 * The market keeps its own disable list in state.json, and the self-heal
 * guard below and the boot replay put any plugin on that list back down.
 * DSH's own Settings → Plugins page enables a row by flipping it to
 * `disabled: false` in the shared patch layer — it has never heard of
 * state.json — so its enable was silently undone within a second and again
 * on every boot, and the official switch looked broken.
 *
 * The patch layer is the one truth both managers share. ...
 */
function followOutsideEnable(name: string): boolean {
  const patch = readUserPatchState(userPatchPath)
  const flags = packagePatchFlags(host, activeProfileDir, [name], patch)
  if (!flags.forced.includes(name) || flags.disabled.includes(name)) return false
  disabled.delete(name)
  writeMarketState(activeProfileDir, { disabled, groups, groupOrder })
  ...
}
```

2）patch 层怎么读：`src/patch.ts:156` `readUserPatchState()` **按行扫描，不做 YAML 解析**，只认两种形态——`- id: X` 后跟 `  disabled: true`（disables）或 `  disabled: false`（forced）。

3）启动时把 `state.json.disabled` 重放下去（`src/routes.ts:854`）：

```ts
// Replay the persisted disable list: bundle-layer plugins the user
// switched away from get live-disabled again (bundle trees are
// in-memory, so the disable never persists on its own). Client-only
// shims for disabled plugins were already skipped by mountClientOnlyDeps.
for (const name of [...disabled]) {
  if (followOutsideEnable(name)) continue
  noteHomeLayerConflict(name)
  if (await themes.setEntryDisabled(name, true)) logEvent('info', 'boot', `plugin kept off: ${name}`)
}
```

4）自愈守卫：任何被关掉的插件若又起了一个 fiber，立刻按下去（`src/routes.ts:868`）：

```ts
host.on?.('internal/plugin', (payload) => {
  const fiber = payload as { entry?: { options?: { name?: string } } }
  const name = fiber.entry?.options?.name
  if (name !== undefined && disabled.has(name) && !followOutsideEnable(name)) void themes.setEntryDisabled(name, true)
})
```

**两者的关系（一句话）**：`state.json.disabled` = 市场自己的账本（决定「本次运行要不要压住它」）；`cordis.patch.yml` 的 `disabled: true` 行 = 跨进程持久的账本（决定「下次启动装配时它是否在树里」）。两者由同一个函数**一起写**（见 C11），任何一方被外部改动时以 **patch 层**为准。

---

### A3. `.dsh-market/state.json` 各字段含义

路径：`src/hot.ts:215`

```ts
export function stateFile(profileDir: string): string {
  return join(profileDir, HOT_DIR, 'state.json')
}
// HOT_DIR = '.dsh-market'  (src/hot.ts:96)
```

接口定义在 `src/hot.ts:219` 起，字段语义如下（本机 `desktop` 实例为 `{"disabled":["dsh-custom-brand","dsh-raccoon-merge"],"groups":{},"groupOrder":[],"region":"china","regionAuto":true,"sidebarEntry":true}`）：

| 字段 | 类型 | 含义 | 证据 |
| --- | --- | --- | --- |
| `disabled` | `string[]`（内存里是 `Set`） | 市场自己关掉的插件名；每次启动重放成 `setEntryDisabled`。兼容旧字段名 `disabledSkins` | `src/hot.ts:507` `readMarketState` |
| `groups` | `Record<组名, 包名[]>` | 用户自建分组，成员就是包名 | `src/groups.ts:5`；`src/hot.ts:513` |
| `groupOrder` | `string[]` | 分组的显示顺序；「未分组」隐含不列出。写回时与 `groups` 交叉归一（有组无序→追加到末尾，有序无组→丢弃） | `src/hot.ts:551` |
| `region` | `'china' \| 'global' \| …` | 下载区域；**缺失会触发一次性网络探测** | `src/hot.ts:274`；`src/routes.ts:705` |
| `regionAuto` | `boolean` | `region` 是自动探测出来的（而非用户手选）。只在 `region` 有效且 `=== true` 时保留 | `src/hot.ts:564` |
| `sidebarEntry` | `boolean` | 是否在侧栏放市场入口。**默认关**，`true`/`false` 都持久化（区分「从未选过」） | `src/hot.ts:323`、`src/routes.ts:661` |

同文件里还有一批次要字段（同一份 state，一并记录）：`notes`（每插件一行备注，≤200 字符，`src/hot.ts:505`）、`channel`（发布渠道）、`favorites`（收藏的目录 URL，键是 registry url 而非包名）、`blocked`（从 Discover 隐藏的包名，与 `disabled` 无关）、`updateExempt`（不提醒更新的包名）、`githubProxy`（自定义 HTTPS 代理前缀）、`settingsSection` / `pluginsTab`（只在显式 `false` 时存储）、`brokenPlugins`（因构建残缺被移出 manifest 的包，记 spec 以便重装）、`buildEnv`（操作者固定的构建环境）。

写入是**原子替换**（`src/hot.ts:607` `publishFile`：先写 `<target>.new` 再 `renameSync`），且写前会先 `readMarketState` 兜底合并——调用方只写自己关心的字段，其余字段从磁盘回读（`src/hot.ts:648` `writeMarketState`）。省略 = 保留，显式 `undefined` = 清除。

---

## B. 更新检查

### B4. 版本比较的完整逻辑

**npm 来源**：比 `dist-tags` / channel tag 上的**语义版本**。

`src/updates.ts:202` 起：

```ts
const SEMVER = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/
export function compareVersions(a: string, b: string): number | null { /* 忽略 build metadata；正式版 > 同核心预发布版；数字段按数字比，故 rc.10 > rc.9 */ }
export function isUpgrade(installed: string | null, latest: string | null): boolean { /* 只在语义更高时才为真 */ }
```

`isUpgrade` 的关键取舍（注释 #64）：用 `!==` 会在「latest 落后于已装 pin」时报更新，点更新就**降级到起不来**。

调用链：`/latest` → `versionOnChannel()`（`src/updates.ts:538`，渠道是 **tag 集合**而非单 tag：`EXTRA_TAGS = {stable: [], beta: ['beta'], dev: ['beta','dev']}` @552）→ `isUpgrade()`。装了预发布而 latest 更低时单独报 `channelSwitch`；只有当已装版本含 `-` 或高于 latest 时才去问 `newerPrereleaseFor()`（`['next','alpha','beta','canary']` 四个 tag 并发，`src/updates.ts:609`）。

**git 来源**：比**锁定 commit**，且必须问到「install 真正选中的那个 ref」。

- 当前 commit 的三种取法（`src/updates.ts:880-936`）：`githubCommitOfTarget(spec)`（spec 里 `#<40hex>`）→ `readGitResolutionCommit(profile,spec,dir)` → `readLockCommits(profile).get('github.com/owner/repo')`（扫 `pnpm-lock.yaml`，`src/profile.ts:811`）。
- 远端最新 commit：**不用 `api.github.com`**，用 git 的 ref advertisement（`src/updates.ts:156`）：

```ts
export async function resolveGitRemoteHead(spec: string, ref?: string): Promise<string | null> {
  // gitUploadPackUrl(spec) + marketFetch，UA `git/2.40.0`
  // 校验 contentType 不含 text/html、body 含 `# service=git-upload-pack`、含 40 位 sha
  // 无 ref → 取 HEAD 后的 sha；有 ref → heads/tags 都试，
  //           tags 优先取 peeled ref `refs/tags/<t>^{}`
}
```

理由（注释 #349）：REST 未认证 60 次/小时/IP 会被耗尽；peeled ref 是因为 annotated tag 的 object 不是 lockfile 里的 commit（#597）。

- GitHub 还有一条**版本比较**通道：直接读仓库里的 `package.json` 版本（`src/updates.ts:666` `remoteGitVersion`）：

```ts
const url = `https://raw.githubusercontent.com/${target.repo}/HEAD/${file}`
// file = `<subpath>/package.json` 或 `package.json`
```

`updateAvailable = byVersion ?? (current !== null && latest !== null && current !== latest)`。注释 #824：浮动安装用 commit 比会**永远**报「有新版本」，所以先试版本。

- **其他 git host（GitLab / Gitea / 任意 https remote）只比 commit，绝不按包名问 npm**（`src/updates.ts:911-936`）——注释 #525：同名 npm 包会被当成更新，然后覆盖掉 git 源安装。

---

### B5. 调用了哪些接口？失败/限流怎么降级？并发与缓存？

| 接口 | 位置 | 超时 |
| --- | --- | --- |
| `https://registry.npmjs.org/<name>/latest` | `site updates.ts:571` `fetchNpmLatest` | 10s |
| 全量 packument `https://registry.npmjs.org/<name>` | 同上（`/latest` 失败时回退） | 10s |
| `https://registry.npmjs.org/<name>/<tag>` | `src/updates.ts:559` `tagVersion` | 10s |
| `https://raw.githubusercontent.com/<repo>/HEAD/<path>package.json` | `src/updates.ts:666` `remoteGitVersion` | 6s（`RAW_VERSION_TIMEOUT_MS` @628） |
| `<remote>/info/refs?service=git-upload-pack` | `src/updates.ts:156` `resolveGitRemoteHead` | 6s |

统一出口是 `src/net.ts:135` `marketFetch()`：走 undici 自带 `fetch` 并显式挂 dispatcher；有代理用 `EnvHttpProxyAgent`，无代理用单例 `Agent`；**loopback 代理（`127.0.0.1`/`localhost`/`::1`）抛错时回退直连重试一次**（#1042）。请求头与超时由各调用方自带（`src/updates.ts:434`）：

```ts
async function fetchJson(url: string): Promise<unknown> {
  const response = await marketFetch(url, {
    headers: { accept: 'application/json', 'user-agent': 'dsh-market' },
    signal: AbortSignal.timeout(10_000),
  })
  if (!response.ok) throw new Error(`HTTP ${String(response.status)}`)
  return await response.json()
}
```

**降级策略（一步步都写明了）**：

- `/latest` 返回非 2xx（实测镜像/限流会给 429，而 packument 仍 200）→ 回退拉全量 packument 自己取 `dist-tags.latest`（`src/updates.ts:571`，注释 #932）。返回 null 会让市场「装了更旧版本」，所以必须回退。
- `time[version]` 缺失（镜像常见 `/latest` 已更新但 packument 未同步）→ **重试一次并带 cache-buster `?t=${Date.now()}`**（`src/updates.ts:498`，注释 #961/#927）。
- 拿不到发布时间 → `latestPublishedRecently()` 返回 `null`，调用方**不得**在 null 时宣称「安全等待」，改用 `UNKNOWN_PUBLISH_HOLD_MS = 30 * 60 * 1000`（`src/updates.ts:485`）。
- **任何异常** → `updateAvailable: false`（`src/updates.ts:989-991`）：「失败即无更新」，不让整个列表崩掉。
- 非插件（无 `dsh` 字段、不在 `bundles`、无 patch 行加载）→ 强制 `updateAvailable:false` 并标 `notAPlugin:true`（`src/updates.ts:996`）。

**并发**：`await Promise.all(Object.entries(installed).map(async ([name, spec]) => …))`（`src/updates.ts:825`）——**没有显式并发上限**，只有每请求自身的超时兜底。这是本实现的一个明确短板（见末节建议）。

**缓存**：`UPDATES_TTL_MS = 30 * 60 * 1000`（`src/updates.ts:147`）。键 = `activeProfileDir` + hold 标记 + `channelFor` + `onlineSourceFor` + catalog 映射排序串 +（hold 时）profile 策略指纹：

```ts
if (!force && updatesCache?.key === cacheKey && Date.now() < updatesCache.recheckAt) return updatesCache.data
```

`invalidateUpdates()`（`src/updates.ts:255`）在安装/更新/卸载成功后置 null；**探测模式（probe）下不清缓存**。切换 registry 也清缓存（`setUpdateRegistry` @283，注释：镜像可能滞后）。

---

### B6. 「dsh 本体版本与插件不兼容」怎么判？`dsh plugin allow-version` 是什么机制？

**这是两件事，由两个不同的代码库负责。**

**(1) dsh-market 的 `src/compatibility.ts` 只做「事前预检 + 方向化提示」**，不阻断（`src/compatibility.ts:230`）：

```ts
export function assessCompatibility(profileDirectory: string, options?: …) {
  // 调 analyzeProfile()（check.ts），对 report.peerMismatches 里 satisfied === false 的逐条 classifyPeer()
  // resolved 为 null → none
  // optional peer     → warning(reason:'optional')
  // 低于所有下界      → risk(direction:'belowMin')
  // 高于所有上界      → 只有作者写了显式上界/精确 pin 才是 risk(direction:'aboveMax')，否则仅 warning
}
```

它自己解析 range（`boundsFor()` @84 支持 `||` 与 `^ ~ >= > < <= =`），并用 `crossesImplicitCeiling()` @174 判断「宿主是否跨过了作者用 `^`/`~` 声明的 minor 线」，只有跨线才升级为风险。`introducedRisks()` / `introducedDuplicateNames()` 只报**本次操作新增**的问题，据此可以回滚。

**(2) 真正的硬门禁在宿主 `HOST/dsh-app-boot/lib/index.js`。**

判定函数 @L311：

```js
function evaluatePluginCompatibility(manifest, exemptions = {}, runtimeVersion = getDshRuntimeVersion()) {
	const requirements = unmetRequirements(fields, runtimeVersion);
	if (Object.keys(requirements).length === 0) return void 0;
	const key = `${name}@${version}`;
	return { name, version, runtimeVersion, requirements,
		exempted: (Object.hasOwn(exemptions, key) ? exemptions[key] : void 0)?.includes(runtimeVersion) === true };
}
```

`unmetRequirements()` @L281-298：

```js
if (Object.hasOwn(engines, "dsh")) {          // ① engines.dsh 存在则「它一个人说了算」，peerDependencies 被忽略
	const range = engines.dsh;
	return satisfies(runtimeVersion, range) ? {} : { "engines.dsh": range };
}
for (const [name, range] of Object.entries(fields.peerDependencies)) {
	if (name !== "@deepseek-ai/dsh" && !name.startsWith("@deepseek-ai/dsh-")) continue;  // ② 只看 dsh 家族的 peer
	if (!satisfies(runtimeVersion, ["workspace:^","workspace:~","workspace:*"].includes(range) ? runtimeVersion : range)) unmet[name] = range;
}
```

装配时直接 `throw`（@L1019-1026）：

```js
const exemptions = bundles.length === 0 ? {} : readProfileVersionExemptions(dir);
...
const issue = evaluatePluginCompatibility(bundleManifest, exemptions);
if (issue !== void 0 && !issue.exempted) throw new Error(pluginCompatibilityWarning(issue));
```

**`dsh plugin allow-version` 的机制**：写 `<profile>/compatibility.json`（mode `0o600`），形如 `{"pkg@1.2.3": ["0.9.4"]}` —— 精确「包名@版本」→ 精确「DSH 运行时版本」数组。

`HOST/dsh-app-boot/lib/index.js` @L341 与 @L434：

```js
const PROFILE_COMPATIBILITY_FILENAME = "compatibility.json";
...
async function setProfileVersionExemption(profileDir, packageVersion, runtimeVersion, enabled, acceptRisk) {
	validatePluginVersionExemption(packageVersion, runtimeVersion);   // 必须 name@exactSemver + 精确 runtime 版本
	if (enabled && !acceptRisk) throw new Error("Incompatible plugins may cause crashes or data loss. … --accept-risk (acceptRisk: true).");
	if (!current.rewritable) throw new Error(`${PROFILE_COMPATIBILITY_FILENAME} must be repaired before exemptions change: …`);
	const versions = exemptions[packageVersion] ?? [];
	if (enabled) exemptions[packageVersion] = [...new Set([...versions, runtimeVersion])];
	...
	await writeFileAtomic(filename, JSON.stringify(exemptions, void 0, 2) + "\n", { mode: 384 });
}
```

CLI 侧 `HOST/dsh/lib/plugin-BiveYA7h.js`：

```js
if (command !== "allow-version" && command !== "revoke-version" && command !== "version-exemptions") return void 0;   // L16
if (argument === "--accept-risk" && command === "allow-version" && !acceptRisk) acceptRisk = true;                     // L22
throw new Error(`usage: dsh plugin ${command} <package@version> --dsh-version <exact>${…}`);                          // L30
process.stderr.write("dsh: warning: allowing incompatible plugin versions can break the application or corrupt data. …\n"); // L36
await setProfileVersionExemption(dir, request.packageVersion, request.runtimeVersion, command === "allow-version", acceptRisk); // L47
```

安装后若被宿主判不兼容，CLI 还会把补救命令打给用户（@L95）：

```
dsh: to accept the risk, run: dsh plugin --profile <p> allow-version <name>@<ver> --dsh-version <runtimeVer> --accept-risk
```

**注意**：dsh-market 的 `src/` 里**没有**调用这三个子命令的地方（`allow-version` 只在 `src/pnpm-compat.ts:485` 作为一条错误文案出现）。它把豁免交给用户/官方插件页，自己只做前置提示。

---

## C. 写操作（最关键）

### C7. 安装走什么命令？

**走 `dsh plugin --profile <profile> add <target>`，不是直接调 pnpm。**

`src/dsh-cli.ts:1346`：

```ts
export function runDshPlugin(profile: string, pluginArgs: string[]): Promise<InstallResult> {
  const { file, args, cwd, viaShell } = dshArgv()
  const prepared = preparePluginArgs(dir, pluginArgs)
  const child = spawnShim(file, [...args, 'plugin', '--profile', profile, ...prepared], {
    cwd, env: { ...spawnEnv(), ...pnpmConfigEnvForArgs(prepared) },
    stdio: ['ignore', 'pipe', 'pipe'], viaShell,
    detached: process.platform !== 'win32',
  })
  // 超时 INSTALL_TIMEOUT_MS 后 killTree；超时会 clearOwnedProfileLock(profile, child.pid)（#914）
  // stdout/stderr 各留 256KB / 64KB 尾部；解析 ndjson 拿 pnpm 的 error / errorCode / ignoredBuilds
}
```

`src/dsh-cli.ts:1217` 的参数预处理：

```ts
export function preparePluginArgs(profileDirectory: string, pluginArgs: readonly string[]) {
  const prepared = pluginArgsFor(profileDirectory, pluginArgs)   // src/pnpm-compat.ts:31
  const target = prepared.at(-1)
  if (target !== undefined && !TARGET_RE.test(target)) throw new Error(…)  // TARGET_RE = /^[A-Za-z0-9@:./_#+~^=-]+$/ (dsh-cli.ts:1211)
  // 命令属于 NDJSON_COMMANDS = new Set(['add','remove','install','update']) 时追加 --reporter=ndjson
}
```

`dsh` 可执行文件怎么找（`src/dsh-cli.ts:479` `dshArgv`）：若 `process.argv[1]` 匹配 `node_modules/@deepseek-ai/dsh-desktop-host/lib/cli.js` 或 `/[\\/](?:bin\.(?:js|ts)|dsh)$/`，用 `node <绝对路径>` 重放（绝对路径，否则子进程按自己 cwd 解析会 `MODULE_NOT_FOUND` #13）；否则回退 `dsh` + `viaShell`（Windows 上是 `.cmd`）。

市场会附加三个 pnpm 配置覆盖（`src/install.ts`）：

```ts
export const RELEASE_AGE_OVERRIDE = '--config.minimum-release-age=0'      // :31
export const FETCH_TIMEOUT_OVERRIDE = '--config.fetchTimeout=600000'      // :48
export const AUTO_INSTALL_PEERS_OFF = '--config.auto-install-peers=false' // :71
```

**特例**：官方 Desktop 分支下**不得**发 `dsh plugin --profile desktop`，改走宿主公布的包管理器调用 `runHostPnpm()`（`src/dsh-cli.ts:1281`，注释 #900）。

---

### C8. 装完之后如何维护 `dsh.profile.bundles`？

**结论：正常路径下 dsh-market 自己不写 bundles——由宿主 CLI 在 `dsh plugin add` 内部调和。市场只在「修复/重装/开关」路径上手写。**

**(a) 宿主侧的调和逻辑（权威）**，`HOST/dsh-app-boot/lib/index.js` @L1209：

```js
function reconcileProfilePlugins(options) {
	const after = readProfilePlugins(options);
	const beforeNames = new Set(options.before.dependencies.map(d => d.name));
	const afterNames  = new Set(after.dependencies.map(d => d.name));
	const bundleNames = new Set(after.dependencies.filter(d => d.bundle).map(d => d.name));
	const disabled = new Set(options.preserveDisabled ? options.before.dependencies.filter(d => d.bundle && !d.enabled).map(d => d.name) : []);
	const previous = after.manifest.dsh?.profile?.bundles ?? [];
	const bundles = previous.filter(name => !(beforeNames.has(name) || afterNames.has(name)) || bundleNames.has(name));
	for (const dependency of after.dependencies)
		if (dependency.bundle && !disabled.has(dependency.name) && !bundles.includes(dependency.name)) bundles.push(dependency.name);
	...
}
```

三条要点：

1. **位置**：新 bundle 一律 **`push` 到末尾**；已存在的保持原位（`previous.filter(...)` 保序）；被移除或「丢了 bundle 声明」的条目被过滤掉。
2. **什么时候加**：包管理器操作**成功之后**，一次调和全量。`preserveDisabled` 为真时，**本次操作前就处于关闭状态的 bundle 不会被重新加回**。
3. **「不是 DSH 插件就不进 bundles」的判断依据**：`dependency.bundle`，源头在 @L1175：

```js
bundle: bundleManifest(location, name)?.dsh?.bundle?.patch !== void 0,
```

即 **`package.json` 里必须声明了 `dsh.bundle.patch`**（与之配套的读取函数 `bundlePatchFiles()` @L517 只接受字符串或字符串数组，否则抛 `dsh.bundle.patch must be a file path or a list of file paths`）。**不是**看有没有 `dsh` 字段、也不是看名字里有没有 `dsh-`。

**(b) 市场自己写 bundles 的地方**：`src/routes.ts:2130-2169`（拆分安装/恢复重试路径）——重新读盘后 `current.dsh.profile.bundles.push(name)`，同样是**追加到末尾**：

```ts
const item = await runPlugin(config.profile, ['add', target])
...
if (desiredBundles.includes(name)) {
  const current = JSON.parse(readFileSync(join(activeProfileDir, 'package.json'), 'utf8'))
  current.dsh.profile.bundles.push(name)   // 末尾追加
  writeFileSync(…)
}
```

以及开关路径的 `addProfileBundle/removeProfileBundle`（`src/profile.ts:1388 / 1365`，见 C11）。

⚠️ 市场在 `src/install.ts:884` 的注释里明确记了一个坑：**`dsh plugin` 只在 pnpm 退出码为 0 时才 reconcile bundles**；一条残留的 bundle 行指向「下次启动解析不到的包」→ loader 死在第一行 → **整个 profile 起不来**（桌面端窗口打不开）。

---

### C9. 卸载的完整步骤 + 两步确认的 UI 逻辑

路由 `POST /dsh-market/uninstall`（`src/routes.ts:7065`），在 `withMutationLock(response, 'install', …)` 里串行执行。顺序如下：

**第 1 段：拒绝门（任何一条命中就 4xx 返回，什么都不改）**

| # | 检查 | 响应 |
| --- | --- | --- |
| 1 | 方法必须 POST / `sameOrigin(request)` | 405 / 403 `untrusted origin` |
| 2 | 不能卸自己（`name === 'dsh-market' \|\| 'dshmarket'`） | 400 `the market cannot uninstall itself; use the dsh CLI` |
| 3 | `NPM_NAME_RE.test(name)`（防 `../../evil` 逃出 bridge join） | 400 `plugin is not installed` |
| 4 | `readInstalled(...)[name] === undefined` | 400 `plugin is not installed` |
| 5 | `userPatchPackageReferences(userPatchPath, name)` **返回 `null`（patch 读不出）** 且未 `force` | **409 + `forceable: true`**（唯一可强制的场景） |
| 6 | 同上返回**非空数组**（patch 还在 insert 这个包） | 409 `userPatchReferenced: true` + `patchReferences`，**不可强制** |
| 7 | 有 agent 在跑且未 `confirmAgentsRunning` | 409 `agentsBusy: true` + `runningAgents` |
| 8 | drain 预检：等待期间已装 spec/版本变了 | 409 `targetChanged: true`，请刷新后重新确认 |

第 5/6 条的取值来自 `src/patch.ts:198` `userPatchPackageReferences()`。

**第 2 段：破坏性步骤之前的取样（都在 remove 之前读，因为 remove 会毁掉证据）**

```ts
const beforeInstalled = readInstalled(config.profile, activeProfileDir)
const activation     = { [name]: verifyActivation(config.profile, name, liveNames(), activeProfileDir, disabled.has(name)) }
const hadClientPart  = packageHasClientPart(activeProfileDir, name)
const heldNativeAddon = holdsNativeAddon(config.profile, name, activeProfileDir)   // Node 无 dlclose，.node 到进程退出才释放（#441）
const ownedRows = rowIdsForPackage(host, activeProfileDir, name)                   // 包自己的 bundle patch 会被 remove 删掉（#799）
const rowJournal = PendingRowJournal.forProfile(activeProfileDir)
rowJournal.begin({ profile: config.profile, name, patchPath: userPatchPath, rows: ownedRows })   // #987 先记账再动手
```

**第 3 段：执行与对账**

```ts
const result = await runPlugin(config.profile, ['remove', name])
const ok = result.exitCode === 0 && !result.timedOut && !cancelled
// 半卸载守卫：pnpm 可能在删掉 node_modules 之后、写 package.json 之前失败（#65 的镜像）
const halfGone = !ok && !cancelled && !existsSync(join(activeProfileDir, 'node_modules', name, 'package.json'))
if (halfGone) {
  reconciled = dropFromManifest(config.profile, name, activeProfileDir)   // 以磁盘真相修复
  if (isHostPortCollision(result)) ok = true                             // #975：remove 成功但宿主端口冲突
}
```

**第 4 段：清理（ok 或 halfGone 时）**

```ts
invalidateUpdates()
removeDanglingHostBridge(name, activeProfileDir, …)       // #662 删宿主 node_modules 桥接链接
const hostResult = hostActivation ? await hostActivation.activate() : undefined
hot = hostActivation ? hostResult!.ok : await hotUnmount(name)
const entryDisabled = await themes.setEntryDisabled(name, true)   // #37：热卸载后 entry 还活着，刷新会 404 卡死整页
const cleanedOwned = removeRowBlocks(userPatchPath, ownedRows)     // 清自己写的 patch 行
disabled.delete(name); replacedWhileLive.delete(name)
removeFromGroups({ groups, groupOrder }, name)
writeMarketState(activeProfileDir, { disabled, groups, order })
```

**两步确认的 UI**（`src/client/MarketSection.tsx`）：

- 第一次点「卸载」只是打开确认弹窗，不发请求：`:6123` `if (id === 'uninstall' && !uninstallBusy) setRemoveConfirm(name)`；`:6651` `onClick={() => setRemoveConfirm(instName)}`。
- 弹窗（`:8895`）：

```tsx
title={t('uninstall') + ' ' + removeConfirm + '?'}
description={t(activations[removeConfirm]?.library === true ? 'uninstallLibraryConfirmDesc' : 'uninstallConfirmDesc')}
<Button variant="primary" disabled={removingName !== null} onClick={() => doUninstall(removeConfirm)}>{t('uninstall')}</Button>
```

- 第二个门是**独立的 agent 运行确认**弹窗（`:2761` `agentsConfirm`），服务端 409 `agentsBusy` 之后才出现，按钮文案 `opUninstallNow`（`:8886`）——即 `confirmAgentsRunning: true` 才会真正重发。
- 真正发请求：`:5148` `fetch(api('/dsh-market/uninstall'), …)`。

---

### C10. 停用/启用写 `cordis.patch.yml` 的精确格式

`src/patch.ts:496`，生成器只有一行模板：

```ts
function rowBlock(rowId: string, disabled: boolean): string {
  return `- id: ${rowId}\n  disabled: ${disabled ? 'true' : 'false'}\n`
}
```

即：**列表项 `- id: <rowId>`，下一行两个空格缩进 `disabled: true|false`，不带 `name:`，不带引号**（`ROW_ID_RE = /^[A-Za-z0-9_.-]+$/u` @138 保证 id 是纯标量，永远不会触发引号需求）。

`disableRow()`（`src/patch.ts:635`）：先就地改写已有的 `disabled: false` → `true`，没有才追加：

```ts
export function disableRow(patchPath: string, rowId: string): Promise<{ ok, reason }> {
  return queuedWrite(async () => {
    if (!ROW_ID_RE.test(rowId)) return { ok: false, reason: … }
    const before = readFileSync(patchPath, 'utf8')
    const next = rewriteRowBlocks(before, rowId, 'any', block => block.replace(`  disabled: false`, `  disabled: true`))
    if (lastRowFlag(next, rowId) !== 'true') {
      const appended = appendPatchEntry(patchPath, rowBlock(rowId, true))
      if (!appended.ok) return appended
    } else writePatchFile(patchPath, next)
    logEvent('info', 'patch', `disabled row ${rowId} in ${patchPath}`)
    return { ok: true, reason: null }
  })
}
```

`enableRow()`（`src/patch.ts:670`）：**删除** `disabled: true` 块；只有在「下层把它按住」时才追加 `disabled: false`：

```ts
export function enableRow(patchPath: string, rowId: string) {
  return queuedWrite(async () => {
    const next = rewriteRowBlocks(readFileSync(patchPath, 'utf8'), rowId, 'true', () => '')
    writePatchFile(patchPath, withPlaceholderRestored(next))   // 见下
    const state = readUserPatchState(patchPath)
    if (state.forced.includes(rowId)) return { ok: true, reason: null }   // 已有 forced 则幂等
    if (state.disables.includes(rowId)) return { ok: false, reason: … }
    return appendPatchEntry(patchPath, rowBlock(rowId, false))            // 只有「被下层停用」才需要 false
  })
}
```

**两个极易踩的坑，它都处理了**：

1. `withPlaceholderRestored()`（`src/patch.ts:702`）：删掉最后一行后会剩下一个「只有注释」的文件，DSH 启动直接报 `must be a top-level YAML array of loader patch entries`（profile 变砖）。所以要么把 `# []` 复活成 `[]`，要么补一个 `[]\n`。
2  `appendPatchEntry()`（`src/patch.ts:576`）：空文件直接写；只有注释则追加；**内容去掉注释后等于 `[]` / `[ ]` 时先把占位符注释成 `# []` 再追加**（这正是官方 profile 模板的形态，本机 `desktop/cordis.yml` 就是 `[]` + 注释）；顶层是 `[`/`{` 开头或 `parsePatchFile` 返回 null 时**拒绝追加**：「补丁层不是合法的条目数组,已拒绝追加以免破坏;请先修正 YAML」。

`rewriteRowBlocks()`（`src/patch.ts:506`）的定位正则会跳过紧跟其后的缩进行（config/config.name 等），避免删掉长条目的后半截（#821），并允许注释/空行夹在中间（#930）。同一 id 出现多次时 `lastRowFlag()`（@533）以**最后一条带 disabled 的**为准。

`packagePatchFlags()`（`src/patch.ts:461`）负责回答「这个包现在到底是被谁按住的」：拿 `rowIdsForPackage()` 得到的行 id 去比对 patch 状态，并**排除 bundle 自己就写死的 opt-out 行**（#876）。

---

### C11. 停用是否也改 `dsh.profile.bundles`？两处的关系？

**是——两层同写或都不写（注释 #696 的姊妹票 #575）。** 核心函数 `switchPluginLayers()`，`src/routes.ts:1119` 起：

```ts
// 目标行
const targets = rowIdsForPackage(host, activeProfileDir, name)            // :1138
const optOutRows     = bundleOptOutRowIds(join(activeProfileDir,'node_modules',name))     // :1147
const expressionRows = bundleExpressionRowIds(…)                                          // :1152
const carrierRows = carrierRowIds(activeProfileDir, name)                // :1165
const foreignRows = foreignRowIds(activeProfileDir, name)                // :1166
const isCarrier   = carrierRows.length > 0

// 是否要同时动 stack（bundles）
const stackToggle = !INBOX_BUNDLES.has(name) && declaresBundle(activeProfileDir, name)
                    && (isCarrier || foreignRows.length === 0)            // :1181
const reBundle = enabled && !isCarrier && !readProfileBundles(activeProfileDir).includes(name)

const stackChanged = enabled ? addProfileBundle(activeProfileDir, name)
                             : removeProfileBundle(activeProfileDir, name)   // :1195
const patchGate = (ok || !enabled) && (enabled ? bundleSwitch.ok : true)     // :1227
```

要点：

- 用的是 **`isCarrier`（这个包自己的 bundle 声明携带了哪些行）** 而不是「名字里有没有 dsh」。
- **停用方向**：`removeProfileBundle` + 写 `disabled: true` → 下次启动它压根不在装配树里。
- **启用方向**：`addProfileBundle`（追加到末尾）+ 删 `disabled: true` 行；若下层把它按住，再补一条 `disabled: false`。
- **`patchGate`**：启用方向只要有一层失败就两层都不写（并回滚已经翻过的行，`src/routes.ts:1266-1292` 逐个翻回去再 `removeProfileBundle` 撤销）；停用方向无条件写。
- **`INBOX_BUNDLES` 永不动**——内置 bundle 只受 patch 层管。

---

### C12. 安装/卸载/更新前有没有备份？备份到哪？能不能回滚？

**分三档，粒度不同：**

**(1) 每次安装/更新：内存中的精确 manifest + lockfile 快照，失败即回滚**（`src/routes.ts:7662-7674`）：

```ts
// Exact manifest snapshot for failure rollback (#65, #339): the
// host writes dependencies and dsh.profile.bundles before the
// build-script check / registry fetches run. Either residue can
// break every later operation or the next boot.
const manifestBefore = readProfileManifestSnapshot(config.profile, activeProfileDir)
const lockfileBefore = captureProfileLockfile()
```

失败时的回滚（`:7771`）：

```ts
if ((result.exitCode !== 0 || result.timedOut) && !cancelled && !portCollisionLanded) {
  const rolledBack = restoreProfileManifest(config.profile, manifestBefore, activeProfileDir)
  if (lockfileBefore.ok) restoreProfileLockfile(lockfileBefore.snapshot)
}
```

注释还说明了为什么**取消**（cancelled）不回滚：「用户看到 diff 自己决定」。`restoreProfileManifest` 定义在 `src/profile.ts:314`。

**(2) 操作后可撤销：`pendingRollbacks` + `POST /dsh-market/rollback`**（`src/routes.ts:1922` / `:7340`）。令牌里带**整个 profile 的指纹**（`package.json` 字节 + `pnpm-lock.yaml` 字节），回滚前逐字节比对：

```ts
if (!profileStateMatches(pending.expectedState)) {
  pendingRollbacks.delete(id)
  sendJson(response, 400, { error: 'rollback is not available because the profile changed after this operation / 操作后配置已发生变化，回滚不可用' })
}
```

这是为了防「终端里另一次 pnpm 已经改过文件，旧令牌覆盖新改动」。更新方向的回滚还要先过一遍可行性判定（`src/routes.ts:5540`）：git monorepo 子目录 / 无法确认先前 commit / Release tarball URL（URL 不是内容标识，资产可被替换）/ lockfile 版本与更新前不一致 → 判为**不可回滚**并给出中英双语原因。

**(3) 持久快照：`.dsh-market/snapshots/`**（`src/snapshot.ts:25`）

```ts
const SNAPSHOT_DIR = join('.dsh-market', 'snapshots')
const SNAPSHOT_FILES = ['package.json', 'cordis.patch.yml', '.dsh-market/state.json'] as const
export const DEFAULT_MAX_SNAPSHOTS = 20
```

`createProfileSnapshot()`（`src/snapshot.ts:333`）把这三个文件**结构化**存成一份 JSON（`package.json` 与 `state.json` 存解析后的对象，`cordis.patch.yml` 存行数组；某个文件不存在则记 `absent: true`——这很重要，因为「缺失」和「空」在装配语义上不同），写完立刻按 `maxSnapshots` 修剪。恢复用 `restoreSnapshot()`（`src/snapshot.ts:430`）。

**但要清楚：安装/卸载/更新路径不会自动建持久快照。** 建快照的调用点只有三处：

- `src/routes.ts:3582`（改 **bundle 顺序**时，并且同时 `createProfileBackup()` 做进程内兜底，注释 #126 说这是「双重保护」）
- `src/routes.ts:3700`（快照 tab 里手动建）
- `src/presets.ts:319`、`src/host-recovery.ts:178`

**另外还有整份 profile 备份/导出**（`src/backup.ts:19` `createProfileBackup`，`BACKUP_FORMAT = 'dsh-profile-backup'`，上限 2MB / 256 文件，跳过 `node_modules`/`.dsh-market`/`.git`/`pnpm-lock.yaml`），可上传 WebDAV（`uploadWebdav` @372，带 `isPublicHostname` 私网校验）。恢复时是**合并而非覆盖**（`mergeRestoreManifest` @630，`src/routes.ts:2102`：现有 deps 保留，备份里的 spec 在重名时胜出，bundles 取并集）。

---

## D. GitHub 自定义安装

### D13. 接受哪些输入形态？归一化成什么 spec？

**重要事实：dsh-market 没有「粘贴任意 URL / owner/repo 就能装」的自由输入入口。** 安装目标一律来自它内置的目录条目（catalog entry：`{ url, npm?, tarball? }`），由 `installTargetFor()` 归一化。

`src/sources.ts:499`：

```ts
export function installTargetFor(entry: { url: string; npm?: unknown; tarball?: unknown }): string | null {
  const source = parseSourceUrl(entry.url)
  if (source === null) return null
  // 市场自己固定走 npm 包，因为从仓库 URL 装会先跑 prepare 脚本（此时还没法弹构建审批）
  if (source.subpath === null && source.repo.toLowerCase() === MARKET_REPO) return MARKET_NPM_NAME
  if (typeof entry.npm === 'string' && NPM_NAME_RE.test(entry.npm)) return entry.npm
  const tarball = releaseTarballTarget(entry.tarball, source.repo)
  if (tarball !== null) return tarball
  return githubSourceTarget(source)      // `github:owner/repo` 或 `github:owner/repo#path:/sub`
}
```

解析函数与正则（全部在 `src/sources.ts`）：

| 函数 | 行 | 接受形态 |
| --- | --- | --- |
| `parseSourceUrl(url)` | 58 | `https://github.com/<owner>/<repo>[/tree/<branch>/<subpath>]` —— 正则 `/^https:\/\/github\.com\/([^/]+\/[^/]+?)(?:\/tree\/[^/]+\/(.+?))?\/?$/`；subpath 必须过 `validSubpath()`（禁空段/`.`/`..`，防 `#path:` 逃逸） |
| `parseGitHubRepository(value)` | 76 | `github:owner/repo`、`owner/repo`、`https?|git|ssh://…github.com/…`、`git@github.com:owner/repo` |
| `parseGitHubRemote(url)` | 93 | 同上 + 允许代理前缀（取最后一个 `github.com` 出现） |
| `releaseTarballTarget(value, repo)` | 35 | 只接受 `https://github.com/<owner>/<repo>/releases/**/x.tgz|tar.gz`，且**前两段必须等于该条目自己的 repo** |
| `githubShortcut(spec)` | 162 | `/^github:([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+?)(?:\.git)?(?:#(.*))?$/`，fragment 以 `&` 分割，最多一个 `path:/x` |
| `repoFromTarget(spec)` | 181 | 上述 shortcut + `codeload.github.com/o/r/tar.gz/<40hex>`（代理前缀用**子串**匹配，因为代理在真 URL 前面） |

`NPM_NAME_RE = /^(@[a-z0-9-~][a-z0-9-._~]*\/)?[a-z0-9-~][a-z0-9-._~]*$/`（`src/sources.ts:16`）。

真正交给 pnpm 的 spec 只有这几种：`<npm名>`、`<npm名>@<version>`、`<gitHub Release tarball URL>`、`github:owner/repo[#path:/sub]`。

另外还有一条降级：`sourceFallbackFor()`（`src/sources.ts:534`），当 tarball 装失败且失败码是 `missing-tarball-integrity` 时，退回该条目自己的 `github:` 源（pnpm 11.0–11.8 在 `nodeLinker: hoisted` 下不给裸 release-asset URL 记 integrity，#797）。

---

### D14. 白名单站点校验是怎么做的？

分三层，都很窄：

1. **URL 必须是 github.com**（`src/sources.ts:44`）：

```ts
if (url.protocol !== 'https:' || url.hostname !== 'github.com') return null
if (!url.pathname.endsWith('.tgz') && !url.pathname.endsWith('.tar.gz')) return null
```

2. **tarball 必须绑定到条目自己的 repo**（`src/sources.ts:48`）——`src/sources.ts:18` 的注释把动机写死了：

```
 * url:     https://github.com/good/plugin
 * tarball: https://github.com/evil/repo/releases/download/v1/p.tgz
```

同一个理由解释了为什么**明确拒绝** `objects.githubusercontent.com` 与 `release-assets.githubusercontent.com`：它们的路径里没有 owner/repo，无法绑定（注释 @29-33）。

3. **交给子进程前还有一道字符白名单**（`src/dsh-cli.ts:1211`）：

```ts
export const TARGET_RE = /^[A-Za-z0-9@:./_#+~^=-]+$/
```

另有两处「白名单」属于别的语义，别混淆：`src/http.ts:38` 的 `trustedHosts`（谁能访问市场自己的 HTTP 路由，来源是宿主 `connection.trustedHosts`，`src/index.ts:192`）；`src/client/market-data.ts:1221` 的 `SCREENSHOT_HOSTS`（插件截图/头像允许哪些图床）。

---

### D15. 它如何从一个 GitHub 仓库判断包名？

**不在远端猜：装完直接读 `node_modules`。**

`src/profile.ts:473`：

```ts
/**
 * The `name` in the package.json of the directory a dependency is installed
 * under, or null. DSH Desktop requires it to equal the dependency key (#694).
 */
export function readInstalledPackageName(profile: string, name: string, explicitDir?: string): string | null {
  try {
    const manifest = JSON.parse(readFileSync(join(profileDir(profile, explicitDir), 'node_modules', name, 'package.json'), 'utf8'))
    return typeof manifest.name === 'string' ? manifest.name : null
  } catch { return null }
}
```

远端读 `package.json` 只有两个用途，**都不是为了「先知道包名再安装」**：

- 更新检查里读**版本**：`src/updates.ts:666` `remoteGitVersion()` → `https://raw.githubusercontent.com/<repo>/HEAD/<subpath>/package.json`。
- 安装**失败后**诊断子目录是否已不存在：`src/routes.ts:2073` `staleSubpath()`，只在 `add` 已失败之后才请求，404 就给一句人话（注释：曾审计实时目录，224 条 subpath 里有 8 条指向已消失的目录）。

目录浏览侧的兼容性表另有 `src/discovery-compatibility.ts:84` `githubManifest()`（同样 `raw.githubusercontent.com/<repo>/<ref>/package.json`），用于展示，不参与安装决策。

---

## E. 生效方式

### E16. 改完 profile 之后怎么让 DSH 生效？有没有一键重启？

**主要靠 HMR，不重启；重启是兜底。**

1. **patch 层**在约 1 秒内被重组合（`src/patch.ts:10`）：

```ts
 * The profile's config-file watcher (HMR) re-composes within ~1s of the
 * file being saved, so a disable/enable needs no restart …
```

2. **`dsh.profile.bundles` 变化**由宿主自己的 profile watcher 处理，约 2 秒（`src/routes.ts:320`）：

```ts
/**
 * The host's profile watcher (#827). While its entry is live, a change to
 * `dsh.profile.bundles` makes the host compose the new bundle itself, about
 * two seconds after the manifest settles — on a plain `dsh web` as much as on
 * a desktop shell. A market mount made before that replay is a second copy of
 * the same rows, and the replay then fails on the routes the copy holds.
 */
const PROFILE_HMR_ENTRY = '@deepseek-ai/dsh-hmr'
const PROFILE_HMR_REPLAY_WAIT_MS = 8000    // 等这次 replay 的上限
```

3. **一键重启**：`POST /dsh-market/restart`（`src/routes.ts:6801`，注释「One-click restart contributed in #14」）。四道门：`restartAllowed(config)`、`detectedDebugger() !== null` 拒绝、`trustedRestartRequest()`（仅同源 loopback）、`writing || installing || restarting` 409。然后 `scheduleRestart(servingPort(request), handoff)`（`src/routes.ts:6847`）。

重启的实现很值得抄（`src/restart.ts:689`）：

```ts
export function scheduleRestart(port: number | null = null, recovery?: RecoveryHandoffConfig): RestartResult {
  const launch = restartLaunch()                 // dshArgv() + process.argv.slice(2)，即「重放原 argv」
  const spawned = respawnInvocation(launch)      // Windows → powershell -NoProfile -WindowStyle Hidden -Command '& <file> ...'
  const logOut = join(tmpdir(), `dsh-market-restart-${stamp}.out.log`)
  const logErr = join(tmpdir(), `dsh-market-restart-${stamp}.err.log`)
  // 可选：写 recovery.json 交给 recovery.js，若新进程起不来就起一个恢复页
  const helper = spawn(nodeExecutable(), ['-e', restartHelperSource(spawned, launch, { out: logOut, err: logErr }, port, handoff)], {
    detached: true, stdio: 'ignore', env: process.env,
  })
  helper.unref()
  setTimeout(() => process.kill(process.pid, 'SIGTERM'), 500)
  return { pid: process.pid, helperPid: helper.pid, logOut, logErr, recovery: handoff }
}
```

辅助脚本本体是 `restartHelperSource()`（`src/restart.ts:492`）生成的字符串，它**轮询端口真正释放**而不是睡固定 1500ms（注释 #177：旧实现睡 1500ms 后 spawn，监听 socket 还没释放 → 新进程秒死 `EADDRINUSE`，而 spawn 被 `catch {}` 吞掉，用户只看到一个「点了没反应」的按钮）。Windows 上还要用 `powershell -WindowStyle Hidden` 包一层，否则 `detached` 映射成 `DETACHED_PROCESS`，新宿主没有 console，它后续 spawn 的控制台子进程（如沙箱工具）会**弹黑窗**（注释 #40）；并且显式点名 `dsh.cmd` 而不是裸 `dsh`（否则 PowerShell 优先找 `dsh.ps1`，Restricted 执行策略直接拒绝，#397）。

---

## 附：宿主侧直接相关的事实（对齐时必须知道）

| 事实 | 证据 |
| --- | --- |
| profile patch 文件名常量 | `HOST/dsh-app-boot/lib/index.js:509` `const PROFILE_PATCH_FILENAME = "cordis.patch.yml"` |
| 兼容性豁免文件名常量 | 同文件 `:341` `const PROFILE_COMPATIBILITY_FILENAME = "compatibility.json"` |
| bundle 层拼装顺序 | bundle 层（按 `dsh.profile.bundles` 顺序）→ `cordis.patch.yml` → `--patch` 覆盖 |
| bundle 判定 | 同文件 `:1175` `bundle: bundleManifest(location, name)?.dsh?.bundle?.patch !== void 0` |
| bundle 声明格式错误会抛 | 同文件 `:519` `"dsh.bundle.patch must be a file path or a list of file paths"` |
| 装了不兼容插件时的补救命令打印 | `HOST/dsh/lib/plugin-BiveYA7h.js:95` |

---

## 对我们（DSH 插件台）的实现建议

1. **照抄：所有包操作只走 `dsh plugin --profile X add|remove|update`，绝不自拼 pnpm 命令。**
   理由：bundles 调和、兼容性门禁、lockfile 一致性、ignoredBuilds 上报全在 CLI 里；绕过去就等于把 C8 里那条「残留 bundle 行 → 整个 profile 起不来」的坑接到自己身上。

2. **照抄：清单只读 `<profile>/package.json` + `node_modules/<pkg>/package.json`，不要调 `--dump-config`。**
   理由：一次进程 spawn 换一份 JSON，成本高、还会受 profile 锁影响；dsh-market 全程零次调用。

3. **照抄：patch 行只写 `- id: <id>` + 两空格 `disabled: true|false`，且务必处理「删到只剩注释」的空壳文件。**
   理由：见 C10 的 `withPlaceholderRestored()`——不补 `[]` 会让 profile 直接变砖，这是本项目最高危的一行代码。

4. **照抄：停用 = 摘 bundles + 写 patch 行，两处要么都成要么都不成；失败要把已翻的行翻回去。**
   理由：见 C11 `patchGate`。只写一处会出现「配置说关了、运行时还活着」或反过来的幽灵状态。

5. **照抄：`state.json` 用 `.new` + `rename` 原子替换，写前先回读合并未知字段。**
   理由：市场与其他管理器（官方插件页、用户手改）并发写同一个 profile 是常态；`writeMarketState` 的 `hasOwnProperty` 三元语义（省略=保留 / 显式 undefined=清除）是最省心的做法。

6. **照抄：一键重启用「detached helper 轮询端口释放 → 重放原 argv → unref → 自己 SIGTERM」，Windows 上包 `powershell -WindowStyle Hidden` 并点名 `.cmd`。**
   理由：见 E16，两个 bug（#177 固定 sleep、#40 弹黑窗）都是踩过的。

7. **避开：不要像它那样把「是否 DSH 插件」用一堆启发式拼起来（`hasDshManifest` / 在 bundles / 有 patch 行 / 名字像）。**
   宿主自己的判据只有一个：`package.json` 里有没有 `dsh.bundle.patch`（`dsh-app-boot:1175`）。我们**读这个字段**就够，启发式越多越容易把普通依赖误判成插件、写进 bundles。

8. **避开：更新检查不要 `Promise.all` 无上限并发打 registry / GitHub。**
   理由：见 B5——dsh-market 这里没有并发池，只靠每请求超时兜底；插件数上到 30+ 时对镜像和 GitHub 都很不友好，也容易自己触发 429。我们加一个 4~6 的信号量，并把结果写进同一份 TTL 缓存。

9. **避开：不要给用户一个「粘贴任意 GitHub URL 就装」的自由入口（除非我们自己做完整的 repo→包名绑定校验）。**
   理由：dsh-market 用「只从目录条目装 + tarball 必须属于条目自己 repo」把供应链收窄了（D14）；放开输入就必须自己承担 `#path:` 逃逸、同名顶替、tarball 换字节这三类问题。

10. **照抄：任何破坏性操作前先读证据（native addon / client part / 自己拥有的 patch 行 / 版本指纹），并在动手前把「将来要清理的东西」记账。**
    理由：见 C9 的取样块 + `rowJournal.begin()`。remove 之后这些信息就没了，事后补救只能靠猜；`holdsNativeAddon` 这一条在 Windows 上直接决定「这次卸载能不能宣称无需重启」。