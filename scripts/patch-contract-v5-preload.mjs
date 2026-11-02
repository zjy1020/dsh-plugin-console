/**
 * 契约层 v5 —— preload 桥接（单独一段，因为 patch-contract-v5.mjs 的 preload 锚点写错过一次）
 */
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const ROOT = process.argv[2]
if (!ROOT) throw new Error('用法: node patch-contract-v5-preload.mjs <项目根>')
const file = join(ROOT, 'src', 'preload', 'index.ts')
let src = readFileSync(file, 'utf8')

if (src.includes('webUtils')) {
  console.log('SKIP preload（已经打过了）')
  process.exit(0)
}

function replaceOnce(from, to, where) {
  const i = src.indexOf(from)
  if (i < 0) throw new Error(`找不到锚点（${where}）: ${from.slice(0, 90)}`)
  if (src.indexOf(from, i + 1) >= 0) throw new Error(`锚点不唯一（${where}）`)
  src = src.slice(0, i) + to + src.slice(i + from.length)
}

replaceOnce(
  `import { contextBridge, ipcRenderer } from 'electron'`,
  `import { contextBridge, ipcRenderer, webUtils } from 'electron'`,
  'electron import'
)

replaceOnce(
  `  UpdateCheckProgress,
  WindowState
} from '../shared/types'`,
  `  ThemeFileResult,
  ThemeSpec,
  UpdateCheckProgress,
  WallpaperAutoFit,
  WallpaperEntry,
  WallpaperImportResult,
  WindowState
} from '../shared/types'`,
  'type import'
)

replaceOnce(
  `  windowMinimize: () => ipcRenderer.invoke(CH.windowMinimize) as Promise<void>,`,
  `  /* ── 外观：壁纸 ─────────────────────────────────────── */

  wallpaperImport: () => ipcRenderer.invoke(CH.wallpaperImport) as Promise<WallpaperImportResult>,
  wallpaperFromPath: (filePath) =>
    ipcRenderer.invoke(CH.wallpaperFromPath, filePath) as Promise<WallpaperImportResult>,
  wallpaperList: () => ipcRenderer.invoke(CH.wallpaperList) as Promise<WallpaperEntry[]>,
  wallpaperSet: (id) => ipcRenderer.invoke(CH.wallpaperSet, id) as Promise<AppSettings>,
  wallpaperRemove: (id) => ipcRenderer.invoke(CH.wallpaperRemove, id) as Promise<boolean>,
  wallpaperPin: (id, pinned) =>
    ipcRenderer.invoke(CH.wallpaperPin, id, pinned) as Promise<boolean>,
  wallpaperAutoFit: (id) => ipcRenderer.invoke(CH.wallpaperAutoFit, id) as Promise<WallpaperAutoFit>,

  /* ── 外观：主题 ─────────────────────────────────────── */

  themesList: () => ipcRenderer.invoke(CH.themesList) as Promise<ThemeSpec[]>,
  themeApply: (id) => ipcRenderer.invoke(CH.themeApply, id) as Promise<AppSettings>,
  themeSave: (spec) => ipcRenderer.invoke(CH.themeSave, spec) as Promise<ThemeSpec>,
  themeDelete: (id) => ipcRenderer.invoke(CH.themeDelete, id) as Promise<boolean>,
  themeExport: (id) => ipcRenderer.invoke(CH.themeExport, id) as Promise<ThemeFileResult>,
  themeImport: (text) => ipcRenderer.invoke(CH.themeImport, text) as Promise<ThemeSpec>,

  /**
   * 拖拽文件的真实本地路径。
   * Electron 32+ 去掉了 File.path，官方替代是 webUtils.getPathForFile —— 必须在 preload
   * 里同步调用，因为 File 对象过不了 IPC 的结构化克隆。拿不到就返回空串。
   */
  pathForFile: (file: File): string => {
    try {
      return webUtils.getPathForFile(file)
    } catch {
      return ''
    }
  },

  windowMinimize: () => ipcRenderer.invoke(CH.windowMinimize) as Promise<void>,`,
  'windowMinimize 段'
)

writeFileSync(file, src)
console.log('OK   src/preload/index.ts')
