import { readFileSync, writeFileSync } from 'node:fs'

const root = 'D:/项目/DSH/deepseekharness插件台/'
const read = (p) => readFileSync(root + p, 'utf8')
const write = (p, s) => writeFileSync(root + p, s, 'utf8')
const must = (c, m) => {
  if (!c) throw new Error(m)
}
const cut = (s, from, to) => {
  must(s.includes(from), `找不到锚点：${from.slice(0, 70)}`)
  return s.replace(from, to)
}

/* ═══ types.ts ═══ */
{
  const p = 'src/shared/types.ts'
  let s = read(p)
  s += `
/* ───────────────────────── 版本选择 / 降级 ───────────────────────── */

export interface VersionOption {
  /** 直接交给 pnpm 的完整 spec，如 \`dsh-context@1.2.3\`、\`github:owner/repo#v1.0.0\` */
  spec: string
  /** 界面上显示的主文本：版本号 / 标签名 / 分支名 */
  label: string
  /** 版本号、dist-tag 名或 git ref */
  value: string
  /** npm 的正式版本 / npm 的 dist-tag / git 标签 / git 分支 */
  kind: 'version' | 'dist-tag' | 'tag' | 'branch'
  /** 发布时间（npm 有，git 没有） */
  publishedAt: string | null
  /** 相对当前已装版本：升 / 降 / 同 / 无法比较 */
  direction: 'up' | 'down' | 'same' | null
}

export interface VersionList {
  ok: boolean
  /** 来源类型 */
  kind: 'npm' | 'git' | 'unknown'
  /** 包名，或 \`owner/repo\` */
  name: string
  /** npm 的 latest，或 git 的默认分支 */
  latest: string | null
  /** 当前已装的版本 / ref */
  current: string | null
  options: VersionOption[]
  /** 版本太多被截断了吗 */
  truncated: boolean
  warnings: string[]
  error: string | null
}
`
  write(p, s)
  console.log('types.ts ok')
}

/* ═══ ipc.ts ═══ */
{
  const p = 'src/shared/ipc.ts'
  let s = read(p)
  s = cut(s, '  pluginIcon:', "  versions: 'api:versions',\n  pluginIcon:")
  s = cut(
    s,
    '  /** 插件图标（dataURL）；读不到返回 ok:false */',
    `  /** 列出可安装的版本 / 标签 / 分支；input 可以是包名、npm spec 或 GitHub 链接 */
  versions(
    input: string,
    opts?: { profile?: string; current?: string | null }
  ): Promise<VersionList>

  /** 插件图标（dataURL）；读不到返回 ok:false */`
  )
  s = cut(s, '  PluginIconResult,\n  ProxyTestResult,', '  PluginIconResult,\n  ProxyTestResult,\n  VersionList,')
  write(p, s)
  console.log('ipc.ts ok')
}

/* ═══ preload ═══ */
{
  const p = 'src/preload/index.ts'
  let s = read(p)
  s = cut(s, '  PluginIconResult,\n  ProxyTestResult,', '  PluginIconResult,\n  ProxyTestResult,\n  VersionList,')
  s = cut(
    s,
    '  pluginIcon: (profile, name) =>',
    `  versions: (input, opts) => ipcRenderer.invoke(CH.versions, input, opts) as Promise<VersionList>,

  pluginIcon: (profile, name) =>`
  )
  write(p, s)
  console.log('preload ok')
}

/* ═══ main/ipc.ts ═══ */
{
  const p = 'src/main/ipc.ts'
  let s = read(p)
  s = cut(s, "import * as icon from './engine/icon'", "import * as icon from './engine/icon'\nimport * as versions from './engine/versions'")
  s = cut(
    s,
    '  /* ---------------- 插件图标 ---------------- */',
    `  /* ---------------- 版本列表 ---------------- */

  ipcMain.handle(
    CH.versions,
    async (_e, input: string, opts?: { profile?: string; current?: string | null }) =>
      versions.listVersions(input, opts ?? {})
  )

  /* ---------------- 插件图标 ---------------- */`
  )
  write(p, s)
  console.log('main/ipc.ts ok')
}

console.log('契约层 v3 完成')