/**
 * engine/patch.ts —— 只读扫描 profile 的 cordis.patch.yml。
 *
 * 为什么手写扫描器：项目不引入 YAML 依赖，而这里只关心两件事——
 *   1) 补丁层里出现过的条目 id（- id: xxx）
 *   2) 哪些条目被 disabled: true 关掉了（以及它的 name，即包名）
 * 其余结构（config / insert 嵌套）一律跳过。
 *
 * 真实文件长这样（节选）：
 *   - id: agent-default-model
 *     name: "@deepseek-ai/dsh-agent-default-model"
 *     config: ...
 *   - id: dsh-auto-collapse
 *     disabled: true
 *   - insert:
 *       - id: some-plugin
 *         name: some-plugin
 *
 * 全部只读：本模块不写文件。
 */

import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

const PATCH_FILE = 'cordis.patch.yml'

/** 原样读出 cordis.patch.yml；不存在 / 读不动 → 空串 */
export function readPatchRaw(profileDir: string): string {
  try {
    const p = join(String(profileDir ?? ''), PATCH_FILE)
    if (!existsSync(p)) return ''
    return readFileSync(p, 'utf8')
  } catch {
    return ''
  }
}

/* ------------------------------------------------------------------ *
 * 极简 YAML 结构扫描
 * ------------------------------------------------------------------ */

type NodeKind = 'entry' | 'insert' | 'skip'

interface Node {
  /** 「- 」本身所在列 */
  dashIndent: number
  /** 该条目自身 key 块的起始缩进（≈ dashIndent + 2），用于归属判断 */
  keyIndent: number
  kind: NodeKind
  id: string | null
  name: string | null
  disabled: boolean
  /** 是否嵌在 - insert: 块里 */
  inInsert: boolean
}

/** 去掉包裹的引号（'x' / "x"）与行尾注释，返回裸标量 */
function unquoteScalar(raw: string): string {
  let v = String(raw ?? '').trim()
  if (!v) return ''
  // 行尾注释：只在值不是引号串时才粗暴切 #（足够应付书写习惯）
  const quoted = (v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))
  if (!quoted) {
    const hash = v.search(/\s#/)
    if (hash >= 0) v = v.slice(0, hash).trim()
  }
  if (v.length >= 2) {
    const a = v[0]
    const b = v[v.length - 1]
    if ((a === '"' && b === '"') || (a === "'" && b === "'")) v = v.slice(1, -1)
  }
  return v.trim()
}

interface KeyValue {
  key: string
  value: string
}

/** 'id: xxx' / 'disabled: true' / 'config:' → { key, value } */
function parseKeyValue(text: string): KeyValue | null {
  const m = /^([A-Za-z_][\w$.-]*|[^:\s][^:]*)\s*:(?:\s+(.*))?$/.exec(text.trim())
  if (!m) return null
  return { key: m[1].trim(), value: (m[2] ?? '').trim() }
}

function applyKeyValue(node: Node, kv: KeyValue): void {
  if (kv.key === 'id') {
    if (!node.id) node.id = unquoteScalar(kv.value)
    return
  }
  if (kv.key === 'name') {
    if (!node.name) node.name = unquoteScalar(kv.value)
    return
  }
  if (kv.key === 'disabled') {
    const v = unquoteScalar(kv.value).toLowerCase()
    if (v === 'true' || v === 'yes' || v === 'on') node.disabled = true
  }
}

/**
 * 扫出所有条目节点。
 *
 * 规则：
 * - `- ` 开头（不要求列 0）→ 一个新条目；列的缩进决定它闭掉哪些祖先。
 * - `- id: X` → 新条目的 id；`- insert:` → 插入容器（其下的 `- id:` 也算条目）。
 * - 非 `- ` 的 key 行（如 `  name: ...`、`  disabled: true`）归属最近的、缩进更浅的条目。
 * - 落在普通条目 config 里的嵌套 `- xxx:` 视为子项，用 skip 节点吞掉，不污染父条目。
 */
function scanNodes(text: string): Node[] {
  const nodes: Node[] = []
  if (!text) return nodes
  const stack: Node[] = []

  const popForDash = (dashIndent: number): void => {
    while (stack.length && stack[stack.length - 1].dashIndent >= dashIndent) stack.pop()
  }
  const popForKey = (indent: number): void => {
    while (stack.length && stack[stack.length - 1].keyIndent > indent) stack.pop()
  }
  const inInsert = (): boolean => stack.some((n) => n.kind === 'insert')

  for (const line of text.split(/\r?\n/)) {
    if (!line.trim()) continue
    if (line.trim().startsWith('#')) continue

    const dash = /^(\s*)-\s*(.*)$/.exec(line)

    if (dash) {
      const dashIndent = dash[1].length
      const content = dash[2].trim()
      popForDash(dashIndent)

      // - insert:
      if (/^insert\s*:/.test(content)) {
        const node: Node = {
          dashIndent,
          keyIndent: dashIndent + 2,
          kind: 'insert',
          id: null,
          name: null,
          disabled: false,
          inInsert: inInsert()
        }
        nodes.push(node)
        stack.push(node)
        continue
      }

      const nested = inInsert()
      const parent = stack[stack.length - 1]

      // 普通条目 config 里的列表项（如 models: 下的 - id: sn-glm-5-3）→ 吞掉
      if (parent && parent.kind === 'entry' && !nested && parent.dashIndent < dashIndent) {
        const skip: Node = {
          dashIndent,
          keyIndent: dashIndent + 2,
          kind: 'skip',
          id: null,
          name: null,
          disabled: false,
          inInsert: false
        }
        nodes.push(skip)
        stack.push(skip)
        continue
      }

      const node: Node = {
        dashIndent,
        keyIndent: dashIndent + 2,
        kind: 'entry',
        id: null,
        name: null,
        disabled: false,
        inInsert: nested
      }
      const kv = parseKeyValue(content)
      if (kv) applyKeyValue(node, kv)
      nodes.push(node)
      stack.push(node)
      continue
    }

    const indent = /^\s*/.exec(line)?.[0].length ?? 0
    popForKey(indent)
    const top = stack[stack.length - 1]
    if (!top || top.kind === 'skip' || top.kind === 'insert') continue
    const kv = parseKeyValue(line)
    if (!kv) continue
    applyKeyValue(top, kv)
  }

  return nodes
}

/**
 * 被补丁层关掉的条目：返回「条目 id」+「该条目的 name（包名）」两种写法。
 *
 * 只统计 `disabled: true` 的条目——
 *   1) 顶层条目：id 与 name 都进集合（上层用包名匹配最省事）；
 *   2) `- insert:` 里的嵌套条目：只取它的 id（那里通常只有 id，没有包名语义）。
 * 这样上层 `set.has(pkgName)` 一次就能覆盖「按 id 关」和「按包名关」两种情况。
 */
export function readPatchDisabledIds(profileDir: string): Set<string> {
  const out = new Set<string>()
  try {
    const nodes = scanNodes(readPatchRaw(profileDir))
    for (const node of nodes) {
      if (node.kind !== 'entry' || !node.disabled) continue
      if (node.id) out.add(node.id)
      if (!node.inInsert && node.name) out.add(node.name)
    }
  } catch {
    /* 解析炸了就当作没有补丁 */
  }
  return out
}