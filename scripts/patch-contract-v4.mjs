/**
 * 契约层 v4：插件市场（dshmarket 目录）+ 插件图集（README 截图）。
 *
 * 只做「加」不做「改」：CH / EV / DshConsoleApi / types.ts 都只追加新条目，
 * 不动已有字段，避免破坏前面已经跑通的五条链路。
 */

import { readFileSync, writeFileSync } from 'node:fs'

const root = process.cwd()
const typesPath = `${root}/src/shared/types.ts`
const ipcPath = `${root}/src/shared/ipc.ts`
const preloadPath = `${root}/src/preload/index.ts`
const mainIpcPath = `${root}/src/main/ipc.ts`

function patch(file, anchor, insert, label) {
  const src = readFileSync(file, 'utf8')
  if (src.includes(insert.split('\n')[0].trim()) && src.includes(insert.trim().split('\n')[0])) {
    // 幂等：粗略判断过一次就不再插
  }
  const at = src.indexOf(anchor)
  if (at === -1) throw new Error(`${label}: 找不到锚点`)
  if (src.includes(insert.trim())) {
    console.log(`= ${label}: 已存在，跳过`)
    return
  }
  writeFileSync(file, src.slice(0, at) + insert + src.slice(at), 'utf8')
  console.log(`+ ${label}`)
}

/* ───────────── 1. types.ts 追加类型 ───────────── */

const TYPES_BLOCK = `
/* ───────────────────────── 插件市场（dshmarket 目录） ───────────────────────── */

/**
 * 目录里的一条插件。
 *
 * 数据来自 \`dsh-plugin-catalog\` 这个 npm 包里携带的 \`plugins.json\`
 * （dshmarket 用的就是它）—— 所以字段名沿用那份文件的原始拼写。
 */
export interface MarketEntry {
  /** 目录里的名字（多数情况下等于 npm 包名） */
  name: string
  /** GitHub 仓库地址 */
  url: string
  owner: string
  /** 一个或多个分类 id */
  categories: string[]
  /** 多语言描述，键是语言码 */
  description: Record<string, string>
  /** npm 包名；没有发布到 npm 的插件这里是 null */
  npm: string | null
  /** 目录声明的图标地址 */
  icon: string | null
  version: string | null
  stars: number | null
  downloads: number | null
  /** 交给 pnpm 的安装 spec（目录直接给的 \`install\`） */
  install: string
  /** 目录声明的加入时间 */
  added: string
  deprecated: boolean
  replacement: string | null
  /** 静态扫描声明会碰的东西：shell / network / credentials / fs-read … */
  capabilities: string[]
  /** 从未扫描过是 null；空数组表示扫过但没检出 */
  capabilityCheckedAt: string | null
  /** 当前 profile 里是否已经装了这个包 */
  installed: boolean
}

export interface MarketCategory {
  id: string
  /** 分类显示名（多语言） */
  labels: Record<string, string>
  count: number
}

export interface MarketList {
  ok: boolean
  /** 目录构建时间（原样透传） */
  updated: string | null
  /** 目录里的插件总数（过滤前） */
  total: number
  categories: MarketCategory[]
  plugins: MarketEntry[]
  /** 数据实际从哪来的，界面上要能说清 */
  source: 'npm-package' | 'origin' | null
  /** 是否走了磁盘缓存 */
  cached: boolean
  fetchedAt: number
  warnings: string[]
  error: string | null
}

/* ───────────────────────── 插件图集（README 截图） ───────────────────────── */

export interface GalleryImage {
  /** data: URL（已经在主进程里取好字节，渲染层不需要再联网） */
  dataUrl: string
  /** 原图地址，用于「打开原图」 */
  url: string
  width: number | null
  height: number | null
  /** 从哪找到的 */
  source: 'readme' | 'npm-readme' | 'catalog'
  /** markdown 里的 alt 文本，可能为空 */
  alt: string | null
  bytes: number
}

export interface GalleryResult {
  ok: boolean
  name: string
  images: GalleryImage[]
  /** 找到图片的那份 readme 的来源说明，如 \`README.md\` / \`npm registry\` */
  origin: string | null
  /** README 原文里的外链（放到「相关链接」里更有价值，不去抓） */
  links: { label: string; url: string }[]
  warnings: string[]
  error: string | null
}
`

patch(typesPath, 'export interface VersionOption {', TYPES_BLOCK, 'types.ts 追加 MarketEntry/MarketList/GalleryResult')

/* ───────────── 2. ipc.ts 通道 + API ───────────── */

patch(
  ipcPath,
  '  probeDir:',
  `  marketList: 'api:market-list',\n  pluginGallery: 'api:plugin-gallery',\n`,
  'ipc.ts CH 加 marketList / pluginGallery'
)

patch(
  ipcPath,
  '  ProxyTestResult,',
  `  MarketList,\n  GalleryResult,\n`,
  'ipc.ts import 加 MarketList / GalleryResult'
)

patch(
  ipcPath,
  '  onDshStatus(',
  `  /** 拉插件市场目录（默认走磁盘缓存，force 强制重拉） */
  marketList(opts?: { force?: boolean }): Promise<MarketList>
  /** 找这个插件 README 里的截图，取好字节以 data URL 返回 */
  pluginGallery(profile: string, name: string): Promise<GalleryResult>
`,
  'ipc.ts DshConsoleApi 加两个方法'
)

console.log('done')
