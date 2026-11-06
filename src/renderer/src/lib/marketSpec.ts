/**
 * 插件目录（dsh-plugin-catalog）里「这一条到底该装什么」的解析。
 *
 * 目录的 `install` 字段给的是一整条**命令行**，不是 spec：
 *   dsh plugin --profile web add dsh-dream-skin
 *   dsh plugin --profile web add github:0xyxy/dsh-maid-atelier-tod
 *   dsh plugin --profile web add @smalltailqwq/dsh-client-ui-skin-maid-atelier
 * 整条串里全是空格，直接当 spec 交给主进程会被判成「输入里有空格，
 * 无法识别为包名或仓库地址」，于是市场里**一个都装不上**（v0.1.3 的实际症状）。
 *
 * 真正要交给 pnpm 的只是 `add` 后面那一段。这个文件把「目录条目 → 真 spec」
 * 收成唯一一处，安装、卡片 title、详情里的「安装 spec」全都走它 ——
 * 界面上写的和实际传给 pnpm 的永远是同一个东西。
 */

import type { MarketEntry } from '../../../shared/types'

/** `add` / `install` / `i` 后面那一段（pnpm / npm 都一样）；参数可能被引号包着（`add "pkg"`）；末尾再带别的参数就取第一段 */
const ADD_TAIL = /(?:^|[\s"'`])(?:add|install|i)\s+["'`]?([^\s"'`]+)["'`]?\s*$/i

/**
 * 把目录给的 `install` 洗成能用的 spec。
 *
 * - 带引号先剥掉：`add "pkg"` 也见过
 * - 是命令行就取 `add` 后面那段：`dsh plugin --profile web add x` → `x`
 * - 本来就是干净 spec（没有空格）就原样返回
 * - 任何情况下**不会**返回带空格的串：带空格的一律当解析不出来（返回 null），
 *   让调用方退到下一条来源，而不是把坏串丢给安装链路
 */
export function specFromInstallField(raw: string | null | undefined): string | null {
  if (typeof raw !== 'string') return null
  let s = raw.trim()
  if (s === '') return null

  // 首尾引号成对出现时剥掉（`add "x"` / 整个串被引号包着）
  if ((s.startsWith('"') && s.endsWith('"')) || (s.startsWith("'") && s.endsWith("'"))) {
    s = s.slice(1, -1).trim()
  }

  const m = ADD_TAIL.exec(s)
  if (m && m[1]) s = m[1]
  s = s.replace(/^["'`]+|["'`]+$/g, '').trim()

  if (s === '' || /\s/.test(s)) return null
  return s
}

/**
 * GitHub 仓库地址 → `owner/repo`。
 * url 常常指向子目录（`…/tree/main/packages/xxx`），所以只取前两段；
 * 不是 GitHub 的地址返回 null（那种情况不猜 spec）。
 */
export function repoOfUrl(url: string | null | undefined): string | null {
  if (!url) return null
  const m = /github\.com\/([^/?#]+)\/([^/?#]+)/.exec(url)
  if (!m) return null
  const repo = m[2].replace(/\.git$/, '')
  if (!m[1] || !repo || repo === 'tree') return null
  return `${m[1]}/${repo}`
}

/**
 * 条目名里 `#` 后面那段 = 它在这台仓库里的子目录
 * （`archify#integrations/deepseek-harness`）；
 * 没有 `#` 就从 url 的 `/tree/<ref>/<sub>` 里抠。含 `..` 的一律不要。
 */
export function subdirOfEntry(entry: MarketEntry): string | null {
  const hash = entry.name.indexOf('#')
  const fromName = hash >= 0 ? entry.name.slice(hash + 1) : ''
  if (fromName && !fromName.includes('..')) return fromName.replace(/^\/+|\/+$/g, '') || null
  const m = /github\.com\/[^/]+\/[^/]+\/(?:tree|blob)\/[^/]+\/(.+)$/.exec(entry.url ?? '')
  if (m && m[1] && !m[1].includes('..')) return m[1].replace(/^\/+|\/+$/g, '') || null
  return null
}

/**
 * 目录条目 → 真正要装的 spec。四级降级，**保证不会返回带空格的串**：
 *   1. `install` 洗出来的（作者自己声明的安装目标，可能钉了 git 引用）
 *   2. `npm` 包名（发布到 npm 的插件走这条路最稳）
 *   3. 仓库地址推出来的 `github:owner/repo`（有子目录就带 `#sub`）
 *   4. 兜底：名字里 `#` 前那半段
 * 全都没有时返回空串，由调用方提示（不静默拿个坏串去装）。
 */
export function marketSpecOf(entry: MarketEntry): string {
  const fromInstall = specFromInstallField(entry.install)
  if (fromInstall) return fromInstall

  const npm = (entry.npm ?? '').trim()
  if (npm && !/\s/.test(npm)) return npm

  const repo = repoOfUrl(entry.url)
  if (repo) {
    const sub = subdirOfEntry(entry)
    return sub ? `github:${repo}#${sub}` : `github:${repo}`
  }

  const bare = entry.name.split('#')[0]?.trim() ?? ''
  return /\s/.test(bare) ? '' : bare
}

/**
 * 这个 spec 是不是「本地路径」形态 —— 展示时要能跟 npm / git 区分开。
 * 目录里正常不会有，留着是为了界面上说清楚。
 */
export function specKindLabel(spec: string): string {
  if (/^(file|link|workspace):/i.test(spec)) return '本地路径'
  if (/^github:/i.test(spec) || /^git\+|\.git(#|$)/i.test(spec)) return 'GitHub'
  return 'npm'
}
