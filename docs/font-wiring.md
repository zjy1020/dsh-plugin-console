# DSH 字体面板 —— 接线说明（给主 agent）

字体引擎与面板已经写好，**既有文件一个都没动**。下面是要你接的 5 处，每处都给可直接粘贴的代码。
设计依据见 [`ref-font-injection.md`](./ref-font-injection.md)（§6 路径 A）。

## 0. 新增文件（都在，不许我再动既有文件）

| 文件 | 行数 | 作用 |
| --- | --- | --- |
| `src/main/engine/fonts.ts` | 1113 | 引擎：读/写 `cordis.patch.yml` 的 ui-theme 三键 + 枚举系统字体 |
| `src/renderer/src/components/FontPanel.tsx` | 483 | 面板 UI（三行是可搜索字体选择器） |
| `src/renderer/src/styles/font-panel.css` | 328 | 面板样式（只引 tokens 变量，不用 `backdrop-filter`） |

自测：`fonts.ts` 在沙盒 profile 上跑过 14 组用例 **pass 50 / fail 0**，其中最硬的一条是
「真实 desktop 补丁副本写入后 diff 只多 3 行、无删除行、ui-theme 条目头部原样」。
`npx tsc -p tsconfig.node.json --noEmit` 与 `-p tsconfig.web.json --noEmit` 当前都是 **0 错误**。

引擎导出（方法名就是下面 preload 要用的名字）：

```ts
readFonts(profile: string): FontsReadResult
writeFonts(profile: string, patch: FontsWriteInput, expectedMtimeMs?: number): FontsWriteResult
listSystemFonts(force = false): SystemFontsResult
clearSystemFontsCache(): void
homePatchPath(): string
```

## 1. `src/shared/types.ts` —— 追加类型（约 40 行）

**为什么要在 shared 里再写一遍**：渲染进程的 `tsconfig.web.json` 只 include
`src/renderer/**`、`src/shared/**`、`src/preload/*.d.ts`，`src/main` 一个字符都不在里面，
所以 `FontPanel.tsx` 只能吃 shared 里的类型定义。字段必须和 `src/main/engine/fonts.ts`
里的同名接口保持一致（那边是权威）。

```ts
/* ── DSH 本体字体（src/main/engine/fonts.ts 的字段镜像；渲染进程拿不到 src/main 的类型） ── */

export type FontRole = 'text' | 'code' | 'terminal'

/** 三个角色的当前值；空串 = 交给 DSH 内置字体栈 */
export interface FontFamilyValues {
  text: string
  code: string
  terminal: string
}

/** 某个键在补丁文件里的落点：present=false 表示文件里没有这一行 */
export interface FontKeyState {
  present: boolean
  value: string
  line: number
}

export interface SystemFontsResult {
  fonts: string[]
  source: 'registry' | 'fontdir' | 'none'
  count: number
  scannedAt: number
  note: string
}

export interface FontsReadResult {
  ok: boolean
  error: string | null
  profile: string
  profileDir: string
  patchPath: string
  patchExists: boolean
  entryFound: boolean
  entryLine: number
  values: FontFamilyValues
  keys: Record<FontRole, FontKeyState>
  homePatchPath: string
  homePatchExists: boolean
  homePatchEntryFound: boolean
  homePatchValues: FontFamilyValues
  /** home patch 里也设了字体 —— 它会压住 profile 补丁，UI 要提示 */
  homePatchSetsFonts: boolean
  mtimeMs: number
  note: string
}

/** string = 写入；null 或空串 = 把这个键删掉（回 DSH 默认）；undefined = 不动 */
export interface FontsWriteInput {
  text?: string | null
  code?: string | null
  terminal?: string | null
}

export interface FontsWriteResult {
  ok: boolean
  error: string | null
  /** 写之前文件被 DSH 改过：放弃写入，让用户重试 */
  conflict: boolean
  patchPath: string
  backup: string | null
  createdPatch: boolean
  createdEntry: boolean
  createdConfig: boolean
  removedConfigLine: boolean
  changed: FontRole[]
  skipped: Array<{ role: FontRole; reason: string }>
  values: FontFamilyValues
  note: string
  mtimeMs: number
}
```

## 2. `src/shared/ipc.ts` —— 两个地方

**2.1** `CH` 里加三个常量（放在 `themesList / themeApply / themeSave` 那一组后面，`CH` 约 81~104 行区域；命名照抄现有 `'api:xxx'` 风格）：

```ts
  /* ── DSH 本体字体 ── */
  readFonts: 'api:fonts-read',
  writeFonts: 'api:fonts-write',
  systemFonts: 'api:fonts-system',
```

**2.2** `DshConsoleApi` 里加三个方法（挨着 `themesList(): Promise<ThemeSpec[]>` 那一带，约 193~210 行）：

```ts
  /** 读某个 profile 的 ui-theme 字体设置（不抛，异常走返回值里的 ok/error） */
  readFonts(profile: string): Promise<FontsReadResult>
  /** 写 ui-theme 的字体三键；expectedMtimeMs 用来拦「DSH 刚刚改过这个文件」 */
  writeFonts(
    profile: string,
    patch: FontsWriteInput,
    expectedMtimeMs?: number
  ): Promise<FontsWriteResult>
  /** 枚举 Windows 已装字体（进程内缓存 10 分钟，force=true 强制重扫） */
  systemFonts(force?: boolean): Promise<SystemFontsResult>
```

记得在文件头的 `import type { … } from './types'` 清单里补上
`FontFamilyValues / FontKeyState / FontsReadResult / FontsWriteInput / FontsWriteResult / SystemFontsResult`。

## 3. `src/main/ipc.ts` —— 一个 import + 三个 handler

**3.1** 顶部 import 区（`import * as features from './engine/…'` 那一串里）加一行：

```ts
import * as fonts from './engine/fonts'
```

**3.2** handler 放在主题那几个旁边（`ipcMain.handle(CH.themesList, …)` / `CH.themeApply` 约 456~458 行附近）：

```ts
  /* ── DSH 本体字体（路径 A：写 profile 的 cordis.patch.yml） ── */

  ipcMain.handle(CH.readFonts, async (_e, profile: string) => fonts.readFonts(profile))

  ipcMain.handle(
    CH.writeFonts,
    async (_e, profile: string, patch: FontsWriteInput, expectedMtimeMs?: number) =>
      fonts.writeFonts(profile, patch, expectedMtimeMs)
  )

  ipcMain.handle(CH.systemFonts, async (_e, force?: boolean) => fonts.listSystemFonts(force === true))
```

（`FontsWriteInput` 从 `../shared/types` import；main 侧能引 shared，没问题。）

## 4. `src/preload/index.ts` —— api 对象加三个方法（方法名别改）

放在「外观：主题」那一段（`themeImport` 之后、`appearanceReset` 附近）：

```ts
  /* ── DSH 本体字体 ───────────────────────────────────── */

  readFonts: (profile) => ipcRenderer.invoke(CH.readFonts, profile) as Promise<FontsReadResult>,
  writeFonts: (profile, patch, expectedMtimeMs) =>
    ipcRenderer.invoke(CH.writeFonts, profile, patch, expectedMtimeMs) as Promise<FontsWriteResult>,
  systemFonts: (force) => ipcRenderer.invoke(CH.systemFonts, force) as Promise<SystemFontsResult>,
```

**方法名必须是 `readFonts / writeFonts / systemFonts`**：`FontPanel.tsx` 在不传 `api` prop 时
会去 `globalThis.dsh` 上找这三个名字（渲染进程里 shim 成 `listSystemFonts` 也行，但别改名，
否则要额外写适配层）。同理 preload 的类型 import 里补上
`FontsReadResult / FontsWriteResult / SystemFontsResult`。

## 5. 挂载面板（二选一）

面板签名：

```tsx
<FontPanel profile={state.activeProfile} onChanged={() => { /* 可选 */ }} />
```

- `profile` 传 **profile 名**（`'desktop'`），不是目录 —— 引擎自己用 `env.getProfileDir()` 解析。
- `api` 可以不传（走 `window.dsh`）；要显式传就传一个满足 `FontsApi` 的对象。
- 组件自己 import 了 `../styles/font-panel.css`，不用你再加样式入口。

### 方案 A（推荐，改动最小）：挂进设置对话框

`src/renderer/src/components/SettingsDialog.tsx`：

1. 顶部 import：`import { FontPanel } from './FontPanel'`
2. 第 45 行类型加一个键：`type SettingsSection = 'appearance' | 'fonts' | 'env' | 'install' | 'general'`
3. 第 47~52 行 `SECTIONS` 里插一项（位置决定左侧导航顺序，建议摆在「外观」后面）：

```ts
  { key: 'appearance', label: '外观' },
  { key: 'fonts', label: 'DSH 字体' },
```

4. `settings__pane` 里（第 450 行 `section === 'appearance'` 那个分支后面）加：

```tsx
              {section === 'fonts' ? <FontPanel profile={state.activeProfile} /> : null}
```

`state.activeProfile` 这个组件里已经有了（它已经在用 `state.runtime` / `state.settingsOpen` 等）。

### 方案 B：侧边栏开一个新视图（改动大，要碰 store 与 App）

只有当你想要「字体」是一级页面时才走这条，要改 4 个文件：

1. `src/renderer/src/lib/store.ts`：`export type ViewKey = 'plugins' | 'install' | 'logs' | 'fonts'`（第 88 行），初始值与 `setView` 的签名跟着一起改；若要给字体视图加一条导航动画的落点，看 `state.view` 的消费处。
2. `src/renderer/src/App.tsx`：在渲染 `state.view === 'logs'` 的同一层加 `state.view === 'fonts' ? <FontPanel profile={state.activeProfile} /> : null`。
3. `src/renderer/src/components/SidebarShell.tsx`：在 `navGroups` 里加一项（照 `logs` 那一项的写法，约 176~183 行）：

```tsx
        {
          id: 'fonts',
          label: 'DSH 字体',
          icon: <IconGear />,
          hint: '改 DSH 本体界面的正文 / 代码 / 终端字体',
          go: () => actions.setView('fonts'),
          active: state.view === 'fonts'
        }
```

（要新画一个 `IconFont` 也行 —— 现有图标都是 16×16、stroke 1.5 的线性图标。）

## 6. 行为说明（别在别处再补一套）

- **写入只碰目标键**：`writeFonts` 是行级扫描 + 精确替换，其它条目 / 其它键 / 注释 / 缩进 /
  数组顺序一个字节都不动；`- insert:` 容器里同名的键不会被误伤；`config: {…}` 这种行内形态
  直接拒绝（返回错误、文件不动）。
- **确定性**：值相同（引号形态不同也算相同）直接跳过不写文件，**不会白改 mtime 触发 DSH 热加载**；
  无改动时返回 `ok:true` + `changed: []` + `note`（不是失败）。
- **并发保护**：写前记 mtime/size，写时再 stat 一次，变了返回 `conflict: true`，面板提示
  「DSH 刚刚改过这个文件，请重试」。DSH 自己的设置面板写的就是这个文件，不能盲盖。
- **备份**：每次真写入前复制到 `<profileDir>/.dsh-console/backup/cordis.patch.yml.<ISO 时间戳>`。
- **生效**：DSH 的 hmr 同时 watch profile patch 与 home patch，改完几秒内热生效，**不用重启 DSH**；
  但 **home patch（`~/.dsh/cordis.patch.yml`）优先级更高**，它若设了字体，profile 里的值会被压住
  —— 面板会据此显示醒目提示。
- **空串语义**：留空 = 删掉该键 = 回 DSH 内置字体栈。

## 7. 你接完之后怎么验

1. `npx tsc -p tsconfig.node.json --noEmit`、`npx tsc -p tsconfig.web.json --noEmit` 都 0 错误。
2. 测试用沙盒 profile，**别拿 `desktop` 做写入实验**：

   ```powershell
   Copy-Item "$env:USERPROFILE\.dsh\profiles\desktop" "$env:USERPROFILE\.dsh\profiles\dsh-font-selftest" -Recurse
   ```

   面板里选它、写几个值，然后 `git diff --no-index` 或直接看
   `~\.dsh\profiles\dsh-font-selftest\cordis.patch.yml`：应只多出 `    textFontFamily: "…"` 这类行。
3. 想验证 DSH 侧真的吃到了值：打开 DSH → 设置 → 通用 → 「更多字体设置」，
   展开后那三个输入框应该显示插件台写进去的字体名（同一个配置真源）。
4. 删掉测试 profile：`Remove-Item "$env:USERPROFILE\.dsh\profiles\dsh-font-selftest" -Recurse -Force`。
