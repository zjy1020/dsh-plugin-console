import { readFileSync, writeFileSync } from 'node:fs'

const root = 'D:/项目/DSH/deepseekharness插件台/'
const read = (p) => readFileSync(root + p, 'utf8')
const write = (p, s) => writeFileSync(root + p, s, 'utf8')
const must = (cond, msg) => {
  if (!cond) throw new Error(msg)
}
const cut = (s, from, to) => {
  must(s.includes(from), `找不到锚点：${from.slice(0, 70)}`)
  return s.replace(from, to)
}

/* ═══════════════ 1. shared/types.ts ═══════════════ */
{
  const p = 'src/shared/types.ts'
  let s = read(p)

  s = cut(s, "  | 'repair'\n", "  | 'repair'\n  | 'install-manifest'\n")

  s = cut(
    s,
    "  /** 主题 */\n  theme: 'dark' | 'light' | 'system'",
    "  /** 关窗口时收进系统托盘而不是退出 */\n  minimizeToTray: boolean\n  /** 主题 */\n  theme: 'dark' | 'light' | 'system'"
  )

  s += `
/* ───────────────────────── 插件图标 ───────────────────────── */

export interface PluginIconResult {
  ok: boolean
  name: string
  /** \`data:image/png;base64,...\` —— 直接给 <img src>；找不到就是 null */
  dataUrl: string | null
  /** 从哪找到的：package / registry / repo；找不到是 null */
  source: string | null
  error: string | null
}

/* ───────────────────────── 代理测速 ───────────────────────── */

export interface ProxyTestResult {
  ok: boolean
  /** 归一化后的代理地址，例如 http://127.0.0.1:65535 */
  target: string
  latencyMs: number | null
  status: number | null
  error: string | null
}

/* ───────────────────────── DSH 进程 ───────────────────────── */

export interface DshStatus {
  running: boolean
  pids: number[]
  exePath: string | null
  installRoot: string | null
  /** 探测时间戳（毫秒） */
  checkedAt: number
}

export interface DshActionResult {
  ok: boolean
  message: string
  status: DshStatus
}

/* ───────────────────────── 清单导出 / 导入 ───────────────────────── */

export interface ManifestEntry {
  name: string
  spec: string
  sourceKind: SourceKind
  version: string | null
  inBundles: boolean
  disabled: boolean
}

export interface ManifestFile {
  /** 固定标记，导入时用来认自家文件 */
  kind: 'dsh-plugin-console/manifest'
  version: 1
  exportedAt: string
  dshVersion: string | null
  profile: string
  plugins: ManifestEntry[]
}

export interface ManifestExportResult {
  ok: boolean
  path: string | null
  count: number
  error: string | null
}

export interface ManifestPreview {
  ok: boolean
  profile: string
  total: number
  /** 清单里有、当前 profile 也有的包名 */
  present: string[]
  /** 清单里有、当前 profile 没有的条目 */
  missing: ManifestEntry[]
  /** 逐条安装时要交给 pnpm 的 spec（按清单顺序） */
  specs: string[]
  warnings: string[]
  error: string | null
}
`
  write(p, s)
  console.log('types.ts ok')
}

/* ═══════════════ 2. shared/ipc.ts ═══════════════ */
{
  const p = 'src/shared/ipc.ts'
  let s = read(p)

  s = cut(
    s,
    '  windowMinimize:',
    `  pluginIcon: 'api:plugin-icon',
  proxyTest: 'api:proxy-test',
  dshStatus: 'api:dsh-status',
  dshStart: 'api:dsh-start',
  dshStop: 'api:dsh-stop',
  exportManifest: 'api:export-manifest',
  importManifest: 'api:import-manifest',
  windowMinimize:`
  )

  s = cut(s, "  toast: 'ev:toast'", "  toast: 'ev:toast',\n  dshStatus: 'ev:dsh-status'")

  s = cut(
    s,
    '  windowMinimize(): Promise<void>',
    `  /** 插件图标（dataURL）；读不到返回 ok:false */
  pluginIcon(profile: string, name: string): Promise<PluginIconResult>
  /** 测代理连通性和延迟；输入可以是 65535 / 127.0.0.1:65535 / http://... */
  proxyTest(input: string): Promise<ProxyTestResult>

  /** DSH 桌面端进程状态 */
  dshStatus(): Promise<DshStatus>
  dshStart(): Promise<DshActionResult>
  dshStop(): Promise<DshActionResult>

  /** 弹出保存对话框，把当前 profile 的已装清单导出成 JSON */
  exportManifest(profile: string): Promise<ManifestExportResult>
  /** 只解析不安装：算出清单里哪些缺、哪些已有 */
  importManifest(profile: string, text: string): Promise<ManifestPreview>

  windowMinimize(): Promise<void>`
  )

  s = cut(
    s,
    '  onToast(cb: (t: ToastPayload) => void): () => void',
    `  onToast(cb: (t: ToastPayload) => void): () => void
  onDshStatus(cb: (s: DshStatus) => void): () => void`
  )

  s = cut(
    s,
    'import type {\n  AppSettings,',
    `import type {
  AppSettings,
  DshActionResult,
  DshStatus,
  ManifestExportResult,
  ManifestPreview,
  PluginIconResult,
  ProxyTestResult,`
  )

  s = cut(s, "  forceBundle: false,\n", "  forceBundle: false,\n  minimizeToTray: true,\n")

  write(p, s)
  console.log('ipc.ts ok')
}

/* ═══════════════ 3. preload ═══════════════ */
{
  const p = 'src/preload/index.ts'
  let s = read(p)

  s = cut(
    s,
    'import type {\n  AppSettings,',
    `import type {
  AppSettings,
  DshActionResult,
  DshStatus,
  ManifestExportResult,
  ManifestPreview,
  PluginIconResult,
  ProxyTestResult,`
  )

  s = cut(
    s,
    '  windowMinimize: () =>',
    `  pluginIcon: (profile, name) =>
    ipcRenderer.invoke(CH.pluginIcon, profile, name) as Promise<PluginIconResult>,
  proxyTest: (input) => ipcRenderer.invoke(CH.proxyTest, input) as Promise<ProxyTestResult>,

  dshStatus: () => ipcRenderer.invoke(CH.dshStatus) as Promise<DshStatus>,
  dshStart: () => ipcRenderer.invoke(CH.dshStart) as Promise<DshActionResult>,
  dshStop: () => ipcRenderer.invoke(CH.dshStop) as Promise<DshActionResult>,

  exportManifest: (profile) =>
    ipcRenderer.invoke(CH.exportManifest, profile) as Promise<ManifestExportResult>,
  importManifest: (profile, text) =>
    ipcRenderer.invoke(CH.importManifest, profile, text) as Promise<ManifestPreview>,

  windowMinimize: () =>`
  )

  s = cut(
    s,
    '  onToast: (cb) => subscribe<ToastPayload>(EV.toast, cb)',
    `  onToast: (cb) => subscribe<ToastPayload>(EV.toast, cb),
  onDshStatus: (cb) => subscribe<DshStatus>(EV.dshStatus, cb)`
  )

  write(p, s)
  console.log('preload ok')
}

/* ═══════════════ 4. main/ipc.ts ═══════════════ */
{
  const p = 'src/main/ipc.ts'
  let s = read(p)

  s = cut(
    s,
    "import * as dsh from './engine/dsh'",
    `import * as dsh from './engine/dsh'
import * as icon from './engine/icon'
import * as proxy from './engine/proxy'
import * as dshproc from './engine/dshproc'
import * as manifest from './engine/manifest'`
  )

  s = cut(
    s,
    'function broadcast(channel: string, payload: unknown): void {',
    'export function broadcast(channel: string, payload: unknown): void {'
  )

  s = cut(
    s,
    "import type { AppSettings, OpLogLine, OpRequest, UpdateCheckProgress, WindowState } from '../shared/types'",
    `import type {
  AppSettings,
  DshStatus,
  OpLogLine,
  OpRequest,
  UpdateCheckProgress,
  WindowState
} from '../shared/types'`
  )

  s = cut(
    s,
    '  /* ---------------- 窗口控制 ---------------- */',
    `  /* ---------------- 插件图标 ---------------- */

  ipcMain.handle(CH.pluginIcon, async (_e, profile: string, name: string) =>
    icon.pluginIcon(profile, name)
  )

  /* ---------------- 代理 ---------------- */

  ipcMain.handle(CH.proxyTest, async (_e, input: string) => proxy.testProxy(input))

  /* ---------------- DSH 进程 ---------------- */

  ipcMain.handle(CH.dshStatus, async () => dshproc.status())
  ipcMain.handle(CH.dshStart, async () => dshproc.start())
  ipcMain.handle(CH.dshStop, async () => dshproc.stop())

  /* 进程状态变了就推给界面：托盘菜单和主界面按钮共用同一份真相 */
  dshproc.watch((s: DshStatus) => broadcast(EV.dshStatus, s), 4000)

  /* ---------------- 清单导出 / 导入 ---------------- */

  ipcMain.handle(CH.exportManifest, async (e, profile: string) => {
    const win = BrowserWindow.fromWebContents(e.sender)
    if (!win) return { ok: false, path: null, count: 0, error: '窗口不存在' }
    return manifest.saveToFile(win, profile)
  })

  ipcMain.handle(CH.importManifest, async (_e, profile: string, text: string) =>
    manifest.preview(profile, text)
  )

  /* ---------------- 窗口控制 ---------------- */`
  )

  write(p, s)
  console.log('main/ipc.ts ok')
}

/* ═══════════════ 5. electron-builder.yml ═══════════════ */
{
  const p = 'electron-builder.yml'
  let s = read(p)
  if (!s.includes('extraResources')) {
    s = cut(
      s,
      'asar: true',
      `asar: true

# 托盘 / 窗口图标要在打包后按绝对路径读到，所以放到 asar 外面
extraResources:
  - from: resources
    to: resources
    filter:
      - "**/*"`
    )
    write(p, s)
    console.log('electron-builder.yml ok')
  } else {
    console.log('electron-builder.yml 已有 extraResources')
  }
}

console.log('契约层完成')