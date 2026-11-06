/**
 * engine/fonts.ts —— DSH 界面字体（读 / 写 profile 的 cordis.patch.yml）
 *
 * 为什么这个模块会去写用户的 cordis.patch.yml（和 plugins 那边「停用只动 bundles、
 * 绝不动 patch」的原则相反）：字体不是「加载哪几个插件」，而是 ui-theme 这个**已经在
 * 装配里**的条目的 config 值。DSH 的层序是 bundle 层 → profile patch → home patch，
 * 改加载列表有 console state + bundles 两条替代通道，改一个 config 值却只有 patch
 * 这一条通道 —— 所以这里必须直接编辑用户的 patch 文件。
 *
 * 正因为它是用户手写的文件，写入器只做「行级精确替换」：只碰 - id: ui-theme 那条
 * config 下的三个键（textFontFamily / codeFontFamily / terminalFontFamily），其余
 * 条目、其余键、注释、缩进风格、数组顺序一个字节都不动 —— 整份 YAML 序列化重写会
 * 吃掉注释和 - insert: 形态的条目，这个代价不能付。
 *
 * 生效链路（结论来自 docs/ref-font-injection.md）：宿主 @deepseek-ai/dsh-client-ui-theme
 * 把这三个字段声明成 volatile 配置项，浏览器侧 ThemePresenter 把它们写到 document.body 的
 * --dsh-font-family-<role> 变量上；DSH 的 HMR 又在监听 profile.patchPath 与 home patch，
 * 所以写完不需要重启 DSH，几秒内自己热加载。
 *
 * 本模块的两条铁律：
 *   1. 任何异常都转成返回值，不外抛（读不到 patch 也是正常状态，不是错误）；
 *   2. 写操作一律「先备份 → 再原子写」，并且写前/写中各校验一次 mtime —— DSH 自己的
 *      设置面板也在写同一个文件，盲盖会把用户刚在 DSH 里改的东西冲掉。
 */

import { execFileSync } from 'node:child_process'
import {
  closeSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  readSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { isAbsolute, join } from 'node:path'

import * as env from './env'

/* ------------------------------------------------------------------ *
 * 常量
 * ------------------------------------------------------------------ */

/** profile 补丁文件名（与 engine/patch.ts 的 PATCH_FILE 同值，读侧共用） */
export const CORDIS_PATCH_FILENAME = 'cordis.patch.yml'

/** 承载字体设置的宿主条目：@deepseek-ai/dsh-client-ui-theme */
export const FONT_SETTINGS_ID = 'ui-theme'
export const FONT_SETTINGS_NAME = '@deepseek-ai/dsh-client-ui-theme'

export const FONT_ROLES = ['text', 'code', 'terminal'] as const
export type FontRole = (typeof FONT_ROLES)[number]

/** 角色 → ui-theme 的 config 字段名（字段名来自宿主的 FONT_FAMILY_FIELDS） */
export const FONT_ROLE_FIELDS: Record<FontRole, string> = {
  text: 'textFontFamily',
  code: 'codeFontFamily',
  terminal: 'terminalFontFamily',
}

export const FONT_ROLE_LABELS: Record<FontRole, string> = {
  text: '正文字体',
  code: '代码字体',
  terminal: '终端字体',
}

const FIELD_TO_ROLE: Record<string, FontRole> = {
  textFontFamily: 'text',
  codeFontFamily: 'code',
  terminalFontFamily: 'terminal',
}

/** 单个值的长度上限：正常字体列表几十个字符，超了基本是粘贴事故 */
const VALUE_MAX_CHARS = 512

/* ------------------------------------------------------------------ *
 * 类型
 * ------------------------------------------------------------------ */

/** 三个角色的当前值（'' = 未设置 = 用 DSH 内置字体栈） */
export interface FontFamilyValues {
  text: string
  code: string
  terminal: string
}

/** 单个键在 patch 里的状态（present=false 表示这个键压根没写） */
export interface FontKeyState {
  present: boolean
  value: string
  line: number | null
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
  /** 入参原样（profile 名或绝对路径） */
  profile: string
  profileDir: string
  patchPath: string
  patchExists: boolean
  /** patch 里有没有 - id: ui-theme 这一条 */
  entryFound: boolean
  /** 条目所在行号（1 起，找不到为 null） */
  entryLine: number | null
  /** 从 profile patch 读到的值（'' = 没写） */
  values: FontFamilyValues
  /** 每个键的明细，UI 用它区分「没写」和「写了空串」 */
  keys: Record<FontRole, FontKeyState>
  /** 全 profile 补丁：它压住 profile patch，存在就得在 UI 上提示 */
  homePatchPath: string
  homePatchExists: boolean
  homePatchEntryFound: boolean
  homePatchValues: FontFamilyValues
  /** home patch 是否真的写了这三个键（都空不算） */
  homePatchSetsFonts: boolean
  /** 读的时候的 mtime，写的时候带上它做冲突检测 */
  mtimeMs: number | null
  note: string
}

/** 要写哪些键：缺省 = 不动；null 或空串 = 删掉这个键（回到 DSH 默认） */
export interface FontsWriteInput {
  text?: string | null
  code?: string | null
  terminal?: string | null
}

export interface FontsWriteResult {
  ok: boolean
  error: string | null
  /** DSH 在我们动手前后改过这个文件，本次放弃写入 */
  conflict: boolean
  patchPath: string
  backup: string | null
  createdPatch: boolean
  createdEntry: boolean
  createdConfig: boolean
  /** config 下最后一个键被删掉，顺手收掉了 config: 行 */
  removedConfigLine: boolean
  /** 实际改动的角色 */
  changed: FontRole[]
  /** 想改但没法改的（块标量、超长…） */
  skipped: { role: FontRole; reason: string }[]
  /** 写完后回读的真实值 */
  values: FontFamilyValues
  note: string
  mtimeMs: number | null
}

/* ------------------------------------------------------------------ *
 * 小工具
 * ------------------------------------------------------------------ */

function emptyValues(): FontFamilyValues {
  return { text: '', code: '', terminal: '' }
}

function errText(e: unknown): string {
  return e instanceof Error ? e.message : String(e)
}

/** 行级键名解析（与 engine/patch.ts 的 parseKeyValue 同一套规则） */
const RE_KEY = /^([A-Za-z_][\w$.-]*|[^:\s][^:]*)\s*:(?:\s+(.*))?$/

function parseKey(body: string): { key: string; rest: string } | null {
  const m = RE_KEY.exec(body)
  if (!m) return null
  return { key: m[1] as string, rest: (m[2] ?? '').trim() }
}

/** 去首尾引号（patch 里的 id / name 两种写法都吃） */
function unquote(raw: string): string {
  const s = raw.trim()
  if (s.length >= 2) {
    const q = s[0]
    if ((q === '"' || q === "'") && s[s.length - 1] === q) return s.slice(1, -1)
  }
  return s
}

/**
 * 切出「值」与「行尾注释」。
 *
 * 不能直接用 indexOf('#')：字体名里可能有 #（"Font #1"），所以先按引号成对跳过，
 * 再找前面带空白的 # —— YAML 的行尾注释必须是空白 + #。
 */
function splitInlineComment(rest: string): { value: string; comment: string } {
  let quote: string | null = null
  let i = 0
  while (i < rest.length) {
    const ch = rest[i] as string
    if (quote) {
      if (ch === '\\' && quote === '"') {
        i += 2
        continue
      }
      if (ch === quote) quote = null
      i += 1
      continue
    }
    if (ch === '"' || ch === "'") {
      quote = ch
      i += 1
      continue
    }
    if (ch === '#' && i > 0 && /\s/.test(rest[i - 1] as string)) {
      // 连值后面的空白一起带走：写回时原样接上，注释前面的空格宽度不被我们改掉
      let j = i
      while (j > 0 && /\s/.test(rest[j - 1] as string)) j -= 1
      return { value: rest.slice(0, j), comment: rest.slice(j) }
    }
    i += 1
  }
  return { value: rest.trimEnd(), comment: '' }
}

/** 值按 YAML 双引号标量转义：字体名里可能有引号或反斜杠 */
function yamlQuoted(value: string): string {
  return `"${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`
}

/* ------------------------------------------------------------------ *
 * 行模型（写入器的地基：只做精确替换，最终结果靠切片拼回，未碰的行全是原字节）
 * ------------------------------------------------------------------ */

interface TextLine {
  /** 行首（不含行尾）偏移 */
  start: number
  /** 行尾偏移（不含 \r\n） */
  end: number
  /** 行尾原文（'\n' / '\r\n' / 空串表示文件末尾最后一行没有换行） */
  eol: string
  /** 整行原文（含缩进，不含行尾） */
  text: string
  /** 去掉缩进后的正文 */
  body: string
  /** 前导空白字符数 */
  indent: number
}

function splitLines(text: string): TextLine[] {
  const lines: TextLine[] = []
  let pos = 0
  for (;;) {
    const nl = text.indexOf('\n', pos)
    const end = nl < 0 ? text.length : nl
    const rawEnd = end > pos && text[end - 1] === '\r' ? end - 1 : end
    const raw = text.slice(pos, rawEnd)
    const eol = nl < 0 ? '' : text.slice(rawEnd, nl + 1)
    const trimmed = raw.trimStart()
    lines.push({
      start: pos,
      end: rawEnd,
      eol,
      text: raw,
      body: trimmed,
      indent: raw.length - trimmed.length,
    })
    if (nl < 0) break
    pos = nl + 1
  }
  return lines
}

/** 文件的主换行符：取第一处换行，取不到用 \n */
function dominantEol(lines: TextLine[]): string {
  for (const ln of lines) {
    if (ln.eol) return ln.eol
  }
  return '\n'
}

/** 删掉一整行时应该抹掉的区间（末行没有换行符，就连前一个换行一起抹） */
function lineDeleteRange(lines: TextLine[], index: number): { start: number; end: number } {
  const ln = lines[index] as TextLine
  if (ln.eol !== '') return { start: ln.start, end: ln.end + ln.eol.length }
  const prevEnd = index > 0 ? (lines[index - 1] as TextLine).end : 0
  return { start: prevEnd, end: ln.end }
}

interface Edit {
  start: number
  end: number
  text: string
}

function applyEdits(text: string, edits: Edit[]): string {
  const sorted = [...edits].sort((a, b) => b.start - a.start || b.end - a.end)
  let out = text
  for (const e of sorted) {
    out = out.slice(0, e.start) + e.text + out.slice(e.end)
  }
  return out
}

/* ------------------------------------------------------------------ *
 * patch 结构扫描（读侧 / 写侧共用）
 * ------------------------------------------------------------------ */

interface ConfigKeyHit {
  line: number
  value: string
  /** 值原文是 YAML 块标量（| 或 >），这种我们不动 */
  block: boolean
}

interface EntryScan {
  found: boolean
  entryLine: number | null
  /** 条目区域（下一处顶层 - 行之前） */
  regionStart: number
  regionEnd: number
  dashIndent: number
  keyIndent: number
  configLine: number | null
  /** config 行冒号之后的原文（'' 表示块形态） */
  configInline: string
  configIndent: number
  childIndent: number
  /** 三个角色键的命中情况 */
  hits: Partial<Record<FontRole, ConfigKeyHit>>
  /** config 块里既不是这三个键、也不是注释的行数 */
  otherChildKeys: number
  /** config 块里的注释行数 */
  childComments: number
}

function emptyScan(): EntryScan {
  return {
    found: false,
    entryLine: null,
    regionStart: 0,
    regionEnd: 0,
    dashIndent: 0,
    keyIndent: 2,
    configLine: null,
    configInline: '',
    configIndent: 0,
    childIndent: 4,
    hits: {},
    otherChildKeys: 0,
    childComments: 0,
  }
}

/**
 * 在 patch 文本里找 - id: <wantId> 这一条，并把它的 config 块摸清楚。
 *
 * 只认顶层（缩进 0）的条目：- insert: 容器里的条目缩进更深，那不是我们要改的东西。
 * 条目区域取到「下一处顶层 - 行」为止（而不是「下一处缩进 0 的行」）—— 顶层注释
 * 不该截断条目，否则我们会看不见注释后面的 config 块，转手再追加一条重复的 config:。
 */
function scanPatch(text: string, wantId: string): EntryScan {
  const scan = emptyScan()
  const lines = splitLines(text)

  let dashLine = -1
  let dashIndent = 0
  let idInline: string | null = null
  let idLine = -1

  for (let i = 0; i < lines.length; i++) {
    const ln = lines[i] as TextLine
    if (ln.body === '' || ln.body.startsWith('#')) continue
    if (!ln.body.startsWith('-') || ln.indent !== 0) continue
    dashLine = i
    dashIndent = ln.indent
    idInline = null
    idLine = i
    const afterDash = ln.body.slice(1).trim()
    if (afterDash !== '') {
      const kv = parseKey(afterDash)
      if (kv && kv.key === 'insert') {
        dashLine = -1
        continue
      }
      if (kv && kv.key === 'id') idInline = unquote(kv.rest)
    } else {
      // - 单独成行、id 在下一行
      const nxt = lines[i + 1]
      if (nxt) {
        const kv = parseKey(nxt.body)
        if (kv && kv.key === 'id') {
          idInline = unquote(kv.rest)
          idLine = i + 1
        }
      }
    }
    if (idInline === null || idInline !== wantId) continue
    dashLine = i
    break
  }

  if (idInline === null || idInline !== wantId || dashLine < 0) return scan

  scan.found = true
  scan.entryLine = idLine + 1 // 行号 1 起
  scan.regionStart = dashLine
  scan.dashIndent = dashIndent

  // 区域结束：下一处顶层 - 行（或文件末尾）
  let regionEnd = lines.length
  for (let j = dashLine + 1; j < lines.length; j++) {
    const ln = lines[j] as TextLine
    if (ln.indent === 0 && ln.body.startsWith('-')) {
      regionEnd = j
      break
    }
  }
  scan.regionEnd = regionEnd

  // 条目内键的缩进（拿第一行有内容的键量，量不到就按 YAML 惯例 +2）
  scan.keyIndent = dashIndent + 2
  for (let j = dashLine + 1; j < regionEnd; j++) {
    const ln = lines[j] as TextLine
    if (ln.body === '' || ln.body.startsWith('#')) continue
    if (ln.indent <= dashIndent) continue
    scan.keyIndent = ln.indent
    break
  }

  // config: 行
  for (let j = dashLine + 1; j < regionEnd; j++) {
    const ln = lines[j] as TextLine
    if (ln.body === '' || ln.body.startsWith('#')) continue
    if (ln.indent <= dashIndent) continue
    const kv = parseKey(ln.body)
    if (!kv || kv.key !== 'config') continue
    scan.configLine = j
    scan.configIndent = ln.indent
    scan.configInline = kv.rest
    break
  }

  if (scan.configLine === null) return scan

  const cfg = scan.configLine
  let childIndent = scan.configIndent + 2
  let firstChild = -1
  for (let j = cfg + 1; j < regionEnd; j++) {
    const ln = lines[j] as TextLine
    if (ln.body === '') continue
    if (ln.indent <= scan.configIndent) break
    firstChild = j
    break
  }
  if (firstChild >= 0) childIndent = (lines[firstChild] as TextLine).indent
  scan.childIndent = childIndent

  for (let j = cfg + 1; j < regionEnd; j++) {
    const ln = lines[j] as TextLine
    if (ln.body === '') continue
    if (ln.indent <= scan.configIndent) break
    if (ln.body.startsWith('#')) {
      scan.childComments += 1
      continue
    }
    const kv = parseKey(ln.body)
    if (!kv) continue
    const role = FIELD_TO_ROLE[kv.key]
    if (!role) {
      scan.otherChildKeys += 1
      continue
    }
    const { value } = splitInlineComment(kv.rest)
    scan.hits[role] = {
      line: j,
      value: unquote(value),
      block: value.startsWith('|') || value.startsWith('>'),
    }
  }

  return scan
}

/* ------------------------------------------------------------------ *
 * 读
 * ------------------------------------------------------------------ */

interface ResolvedProfile {
  ok: boolean
  error: string | null
  dir: string
  patchPath: string
}

/** 入参既可以是 profile 名（desktop），也可以是绝对目录（ops 那层传的就是目录） */
function resolveProfile(profile: string): ResolvedProfile {
  const raw = String(profile ?? '').trim()
  const home = env.getDshHome()
  if (!raw) {
    return {
      ok: false,
      error: '没有指定 profile —— 插件台不知道该改哪一份 cordis.patch.yml',
      dir: '',
      patchPath: join(home, CORDIS_PATCH_FILENAME),
    }
  }
  const winAbs = /^[a-zA-Z]:[\\/]/.test(raw)
  const dir = isAbsolute(raw) || winAbs ? raw : env.getProfileDir(raw)
  return { ok: true, error: null, dir, patchPath: join(dir, CORDIS_PATCH_FILENAME) }
}

/** 全 profile 补丁：$DSH_HOME/cordis.patch.yml（层序上比 profile patch 更晚生效） */
export function homePatchPath(): string {
  return join(env.getDshHome(), CORDIS_PATCH_FILENAME)
}

/** 读 patch 文本；不存在/读不动都给空串（读不到是正常状态，不是错误） */
function readPatchText(file: string): { exists: boolean; text: string; mtimeMs: number | null } {
  try {
    const st = statSync(file)
    return { exists: true, text: readFileSync(file, 'utf8'), mtimeMs: st.mtimeMs }
  } catch {
    return { exists: false, text: '', mtimeMs: null }
  }
}

export function readFonts(profile: string): FontsReadResult {
  const resolved = resolveProfile(profile)
  const home = homePatchPath()
  const result: FontsReadResult = {
    ok: resolved.ok,
    error: resolved.error,
    profile: String(profile ?? ''),
    profileDir: resolved.dir,
    patchPath: resolved.patchPath,
    patchExists: false,
    entryFound: false,
    entryLine: null,
    values: emptyValues(),
    keys: {
      text: { present: false, value: '', line: null },
      code: { present: false, value: '', line: null },
      terminal: { present: false, value: '', line: null },
    },
    homePatchPath: home,
    homePatchExists: false,
    homePatchEntryFound: false,
    homePatchValues: emptyValues(),
    homePatchSetsFonts: false,
    mtimeMs: null,
    note: '',
  }

  const notes: string[] = []
  if (!resolved.ok) {
    result.note = resolved.error ?? '读取失败'
    return result
  }

  const own = readPatchText(resolved.patchPath)
  result.patchExists = own.exists
  result.mtimeMs = own.mtimeMs
  if (!own.exists) {
    notes.push('这个 profile 还没有 cordis.patch.yml，现在的字体来自 DSH 内置字体栈（或全 profile 补丁）')
  } else {
    const scan = scanPatch(own.text, FONT_SETTINGS_ID)
    result.entryFound = scan.found
    result.entryLine = scan.entryLine
    if (!scan.found) {
      notes.push(`patch 里没有 id: ${FONT_SETTINGS_ID} 这一条，第一次写入时插件台会补上`)
    } else if (scan.configLine === null) {
      notes.push('这一条还没有 config 块，第一次写入时插件台会按现有缩进补上')
    } else {
      for (const role of FONT_ROLES) {
        const hit = scan.hits[role]
        if (!hit) continue
        result.keys[role] = { present: true, value: hit.value, line: hit.line + 1 }
        result.values[role] = hit.value
      }
    }
  }

  const homeRead = readPatchText(home)
  result.homePatchExists = homeRead.exists
  if (homeRead.exists) {
    const scan = scanPatch(homeRead.text, FONT_SETTINGS_ID)
    result.homePatchEntryFound = scan.found
    if (scan.found) {
      for (const role of FONT_ROLES) {
        const hit = scan.hits[role]
        if (hit) result.homePatchValues[role] = hit.value
      }
      const any = FONT_ROLES.some((r) => result.homePatchValues[r] !== '')
      result.homePatchSetsFonts = any
      notes.push(
        any
          ? '存在全 profile 补丁，并且它也设了字体：它的层序比这里晚，会压住这里写的值'
          : '存在全 profile 补丁（还没设字体），注意它最终会压住 profile patch',
      )
    } else {
      notes.push('存在全 profile 补丁，注意它的层序比 profile patch 晚')
    }
  }

  result.note = notes.length > 0 ? notes.join('；') : '当前字体取自这个 profile 的补丁'
  result.ok = true
  return result
}

/* ------------------------------------------------------------------ *
 * 写
 * ------------------------------------------------------------------ */

/** 备份到 <profileDir>/.dsh-console/backup/cordis.patch.yml.<ISO 时间戳> */
function backupPatch(profileDir: string): string | null {
  try {
    const src = join(profileDir, CORDIS_PATCH_FILENAME)
    const dir = join(profileDir, '.dsh-console', 'backup')
    mkdirSync(dir, { recursive: true })
    const stamp = new Date().toISOString().replace(/[:.]/g, '-').replace(/Z$/, '')
    const dest = join(dir, `${CORDIS_PATCH_FILENAME}.${stamp}`)
    copyFileSync(src, dest)
    return dest
  } catch {
    return null
  }
}

/** DSH 自己生成 patch 文件时用的头部注释（照抄它的模板，免得我们造出一个不同风格的文件） */
function headerComment(eol: string): string {
  return [
    '# Your patch layer for this dsh profile, applied after every bundle layer:',
    '# a top-level YAML array of loader patch entries (id-targeted config',
    '# overrides, disables, and insert lists; `!!js` expressions allowed).',
  ].join(eol) + eol
}

function writeFail(error: string, extra?: Partial<FontsWriteResult>): FontsWriteResult {
  return {
    ok: false,
    error,
    conflict: false,
    patchPath: '',
    backup: null,
    createdPatch: false,
    createdEntry: false,
    createdConfig: false,
    removedConfigLine: false,
    changed: [],
    skipped: [],
    values: emptyValues(),
    note: error,
    mtimeMs: null,
    ...extra,
  }
}

/**
 * 写入字体设置。
 *
 * @param profile          profile 名或绝对目录
 * @param patch            要写的键（未给出的角色不动，null / 空串 = 删掉这个键）
 * @param expectedMtimeMs 面板读到的 mtime；给了就做「DSH 期间改过」检测
 */
export function writeFonts(
  profile: string,
  patch: FontsWriteInput,
  expectedMtimeMs?: number | null,
): FontsWriteResult {
  const resolved = resolveProfile(profile)
  if (!resolved.ok) return writeFail(resolved.error ?? '没有指定 profile')

  // 1. 归一化输入：空串按「回到默认」处理（ui-theme 的默认值就是空串，写空串等于没写）
  const wanted: { role: FontRole; field: string; value: string | null }[] = []
  const skipped: { role: FontRole; reason: string }[] = []
  for (const role of FONT_ROLES) {
    if (!Object.prototype.hasOwnProperty.call(patch, role)) continue
    const raw = patch[role]
    if (raw === undefined) continue
    if (raw === null) {
      wanted.push({ role, field: FONT_ROLE_FIELDS[role], value: null })
      continue
    }
    const norm = String(raw)
      // 控制字符（含换行）会破坏 YAML 结构，直接抹成空格：DSH 侧的 normalizeFontFamily 也会剥掉它们
      .replace(/[\u0000-\u001f\u007f]/g, ' ')
      .trim()
    if (norm === '') {
      wanted.push({ role, field: FONT_ROLE_FIELDS[role], value: null })
      continue
    }
    if (norm.length > VALUE_MAX_CHARS) {
      skipped.push({ role, reason: `字体列表过长（${norm.length} 字符，上限 ${VALUE_MAX_CHARS}）` })
      continue
    }
    wanted.push({ role, field: FONT_ROLE_FIELDS[role], value: norm })
  }

  if (wanted.length === 0) {
    return writeFail(
      skipped.length > 0 ? '所有改动都被跳过了' : '没有要写入的字体设置',
      { patchPath: resolved.patchPath, skipped },
    )
  }
  if (wanted.every((w) => w.value === null) && !readPatchText(resolved.patchPath).exists) {
    return writeFail('这个 profile 还没有 cordis.patch.yml，也没有要写入的值', {
      patchPath: resolved.patchPath,
      skipped,
    })
  }

  // 2. 读原文（保留 BOM，最后拼回去）
  const before = readPatchText(resolved.patchPath)
  const bom = before.text.startsWith('\uFEFF') ? '\uFEFF' : ''
  const srcText = bom ? before.text.slice(1) : before.text
  const mtimeMs = before.mtimeMs

  // 3. DSH 是不是在我们读完之后又改过它
  if (
    expectedMtimeMs !== null &&
    expectedMtimeMs !== undefined &&
    before.exists &&
    mtimeMs !== null &&
    Math.abs(mtimeMs - expectedMtimeMs) > 0.5
  ) {
    return writeFail('DSH 刚刚改过这个文件，请重试', {
      conflict: true,
      patchPath: resolved.patchPath,
      mtimeMs,
      skipped,
    })
  }

  const lines = splitLines(srcText)
  const eol = dominantEol(lines)
  const scan = scanPatch(srcText, FONT_SETTINGS_ID)
  const edits: Edit[] = []
  const notes: string[] = []
  const changed: FontRole[] = []
  let createdEntry = false
  let createdConfig = false
  let removedConfigLine = false

  if (!scan.found) {
    // 4a. 整条都没有：按文件现有缩进风格追加一条（顶层 dash 缩进，通常是 0）
    let dashIndent = 0
    for (const ln of lines) {
      if (ln.indent === 0 && ln.body.startsWith('-')) {
        dashIndent = ln.indent
        break
      }
    }
    const dash = ' '.repeat(dashIndent)
    const key = `${dash}  `
    const child = `${key}  `
    const newLines: string[] = []
    for (const w of wanted) {
      if (w.value === null) continue
      newLines.push(`${child}${w.field}: ${yamlQuoted(w.value)}`)
    }
    if (newLines.length === 0) {
      return writeFail('这一条还不存在，但传进来的值都是空的（没什么可写的）', {
        patchPath: resolved.patchPath,
        skipped,
      })
    }
    const block = [
      `${dash}- id: ${FONT_SETTINGS_ID}`,
      `${key}name: "${FONT_SETTINGS_NAME}"`,
      `${key}config:`,
      ...newLines,
    ].join(eol) + eol
    const needLead = srcText.length > 0 && !srcText.endsWith('\n')
    const head = srcText.length === 0 ? headerComment(eol) : needLead ? eol : ''
    edits.push({ start: srcText.length, end: srcText.length, text: head + block })
    createdEntry = true
    createdConfig = true
    for (const w of wanted) {
      if (w.value !== null) changed.push(w.role)
    }
    notes.push('patch 里原本没有这一条，已追加')
  } else if (scan.configLine === null) {
    // 4b. 有这一条但没有 config 块：在条目末尾补一块
    const key = ' '.repeat(scan.keyIndent)
    const child = `${key}  `
    const newLines: string[] = []
    for (const w of wanted) {
      if (w.value === null) continue
      newLines.push(`${child}${w.field}: ${yamlQuoted(w.value)}`)
    }
    if (newLines.length === 0) {
      return writeFail('这一条没有 config 块，但传进来的值都是空的（没什么可写的）', {
        patchPath: resolved.patchPath,
        skipped,
      })
    }
    // 插到这一条的最末尾（区域结束行之前）：挂在最后一个非空行的行尾后面
    let anchor: TextLine | null = null
    for (let j = scan.regionEnd - 1; j > scan.regionStart; j -= 1) {
      const ln = lines[j]
      if (!ln || ln.body === '') continue
      anchor = ln
      break
    }
    const at = anchor ? anchor.end : srcText.length
    edits.push({
      start: at,
      end: at,
      text: `${eol}${key}config:${eol}${newLines.join(eol)}`,
    })
    createdConfig = true
    for (const w of wanted) {
      if (w.value !== null) changed.push(w.role)
    }
    notes.push(`补上了 config 块（缩进 ${scan.keyIndent + 2} 空格）`)
  } else {
    // 4c. 正常路径：在 config 块里改 / 加 / 删
    if (scan.configInline !== '' && scan.configInline !== '{}') {
      return writeFail(
        `这一条的 config 是行内 YAML（config: ${scan.configInline}），插件台不重写行内块，请手动编辑 ${resolved.patchPath}`,
        { patchPath: resolved.patchPath, skipped },
      )
    }

    const cfgLine = lines[scan.configLine] as TextLine
    // config 块的最后一行（空行不算），插入新键时挂在它后面
    let lastChild = -1
    for (let j = scan.configLine + 1; j < scan.regionEnd; j++) {
      const ln = lines[j] as TextLine
      if (ln.body === '') continue
      if (ln.indent <= scan.configIndent) break
      lastChild = j
    }

    // 行内 config: {} —— 先把它还原成块形态
    if (scan.configInline === '{}') {
      edits.push({
        start: cfgLine.start,
        end: cfgLine.end,
        text: `${' '.repeat(scan.configIndent)}config:`,
      })
      createdConfig = true
    }

    const insertAt = lastChild >= 0 ? (lines[lastChild] as TextLine).end : cfgLine.end
    const insertLines: string[] = []
    const deletedLines = new Set<number>()

    for (const w of wanted) {
      const hit = scan.hits[w.role]
      if (w.value === null) {
        if (!hit) continue
        if (hit.block) {
          skipped.push({ role: w.role, reason: '该键是 YAML 块标量（| 或 >），插件台不重写' })
          continue
        }
        edits.push({ ...lineDeleteRange(lines, hit.line), text: '' })
        deletedLines.add(hit.line)
        changed.push(w.role)
        continue
      }

      const quoted = yamlQuoted(w.value)
      if (hit) {
        if (hit.block) {
          skipped.push({ role: w.role, reason: '该键是 YAML 块标量（| 或 >），插件台不重写' })
          continue
        }
        // 值已经一样（引号形态不同也算一样）就别动它：白改一次 mtime 会白触发一轮 DSH 热加载
        if (hit.value === w.value) continue
        const ln = lines[hit.line] as TextLine
        const kv = parseKey(ln.body)
        // comment 里带着原文的空格宽度，直接原样接回去
        const { comment } = splitInlineComment(kv ? kv.rest : '')
        const rawKey = kv ? ln.body.slice(0, ln.body.indexOf(kv.key) + kv.key.length) : w.field
        edits.push({
          start: ln.start,
          end: ln.end,
          text: `${' '.repeat(ln.indent)}${rawKey}: ${quoted}${comment}`,
        })
        changed.push(w.role)
        continue
      }
      insertLines.push(`${' '.repeat(scan.childIndent)}${w.field}: ${quoted}`)
      changed.push(w.role)
    }

    if (insertLines.length > 0) {
      edits.push({ start: insertAt, end: insertAt, text: eol + insertLines.join(eol) })
    }

    // config 块被删空时收掉 config: 行（只收「真的一点内容都不剩」的情况）
    if (deletedLines.size > 0) {
      let remainKeys = 0
      for (let j = scan.configLine + 1; j < scan.regionEnd; j++) {
        if (deletedLines.has(j)) continue
        const ln = lines[j] as TextLine
        if (ln.body === '') continue
        if (ln.indent <= scan.configIndent) break
        if (ln.body.startsWith('#')) continue
        remainKeys += 1
      }
      const remainComments = scan.childComments
      if (remainKeys === 0 && remainComments === 0) {
        edits.push({ ...lineDeleteRange(lines, scan.configLine), text: '' })
        removedConfigLine = true
      } else if (remainKeys === 0) {
        notes.push('config 下只剩注释，为不动你的注释保留了 config: 行')
      }
    }
  }

  if (changed.length === 0) {
    if (skipped.length > 0) {
      return writeFail('要改的键被跳过了，本次没有写入', { patchPath: resolved.patchPath, skipped })
    }
    // 无改动不是失败：告诉调用方「磁盘已经是这样了」，别让它当成错误弹红字
    return {
      ok: true,
      error: null,
      conflict: false,
      patchPath: resolved.patchPath,
      backup: null,
      createdPatch: false,
      createdEntry: false,
      createdConfig: false,
      removedConfigLine: false,
      changed: [],
      skipped,
      values: readFonts(profile).values,
      note: '磁盘上的值已经是这样了，没有改动（没写文件，也没动它的 mtime）',
      mtimeMs,
    }
  }

  const next = applyEdits(srcText, edits)

  // 5. 落笔前再确认一次：DSH 自己的设置面板也在写这个文件
  if (before.exists) {
    try {
      const now = statSync(resolved.patchPath)
      if (mtimeMs !== null && (now.mtimeMs !== mtimeMs || now.size !== Buffer.byteLength(before.text, 'utf8'))) {
        return writeFail('DSH 刚刚改过这个文件，请重试', {
          conflict: true,
          patchPath: resolved.patchPath,
          mtimeMs: now.mtimeMs,
          skipped,
        })
      }
    } catch {
      return writeFail('文件刚刚被删掉了，请重试', {
        conflict: true,
        patchPath: resolved.patchPath,
        skipped,
      })
    }
  }

  const backup = before.exists ? backupPatch(resolved.dir) : null
  const tmp = `${resolved.patchPath}.tmp`
  try {
    writeFileSync(tmp, bom + next, 'utf8')
    renameSync(tmp, resolved.patchPath)
  } catch (e) {
    try {
      rmSync(tmp, { force: true })
    } catch {
      /* 清理失败无所谓，报错信息已经给到用户 */
    }
    return writeFail(`写入失败：${errText(e)}`, {
      patchPath: resolved.patchPath,
      backup,
      skipped,
    })
  }

  const after = readFonts(profile)
  const values = after.ok ? after.values : emptyValues()
  const labels = changed.map((r) => FONT_ROLE_LABELS[r]).join('、')
  const noteParts = [`已写入 ${labels}`]
  if (createdEntry) noteParts.push('新建了 ui-theme 条目')
  if (createdConfig) noteParts.push('补上了 config 块')
  if (removedConfigLine) noteParts.push('config 已空，顺手收掉 config: 行')
  noteParts.push('DSH 会热加载这个文件，几秒内生效；没变化就刷新一下 DSH 窗口')
  if (backup) noteParts.push(`原文件已备份到 ${backup}`)
  if (notes.length > 0) noteParts.push(...notes)
  if (skipped.length > 0) noteParts.push(`跳过：${skipped.map((s) => `${FONT_ROLE_LABELS[s.role]}（${s.reason}）`).join('、')}`)

  return {
    ok: true,
    error: null,
    conflict: false,
    patchPath: resolved.patchPath,
    backup,
    createdPatch: !before.exists,
    createdEntry,
    createdConfig,
    removedConfigLine,
    changed,
    skipped,
    values,
    note: noteParts.join('；'),
    mtimeMs: readPatchText(resolved.patchPath).mtimeMs,
  }
}

/* ------------------------------------------------------------------ *
 * 系统字体枚举
 * ------------------------------------------------------------------ */

const FONT_CACHE_MS = 10 * 60 * 1000
const RE_FONT_FILE = /\.(?:ttf|ttc|otf|otc|fon|fnt|woff2?)$/i
const RE_KIND_SUFFIX = /\s*\((?:TrueType|OpenType|Type 1|Type1|All res|Vectors?|PostScript[^)]*)\)\s*$/i

function cleanFontName(raw: string): string {
  let name = raw.trim()
  for (let i = 0; i < 3; i += 1) {
    const next = name.replace(RE_KIND_SUFFIX, '')
    if (next === name) break
    name = next
  }
  return name.trim()
}

/**
 * OEM 代码页 → TextDecoder 的标签。只列我们会遇到的。
 *
 * 用 TextDecoder 而不是自己接 iconv：Node / Electron 自带 ICU，`gbk`/`big5`/`shift_jis`
 * 这些标签都能用，不引第三方库。表里没有的（比如 437，WHATWG 编码表里没有 ibm437）
 * 就让 TextDecoder 抛，下面按候选投票兜住。
 */
const OEM_LABELS: Record<string, string> = {
  '866': 'ibm866',
  '874': 'windows-874',
  '932': 'shift_jis',
  '936': 'gbk',
  '949': 'euc-kr',
  '950': 'big5',
  '1250': 'windows-1250',
  '1252': 'windows-1252',
  '1253': 'windows-1253',
  '1254': 'windows-1254',
  '1256': 'windows-1256',
  '1257': 'windows-1257',
  '1258': 'windows-1258',
}

let oemLabelCache: string | null | undefined

/** 读系统 OEM 代码页（中文系统 = 936）。读不到返回 null，交给候选投票。 */
function oemCodePageLabel(exe: string): string | null {
  if (oemLabelCache !== undefined) return oemLabelCache
  oemLabelCache = null
  try {
    // 这条命令本身只有 ASCII 输出，按 utf8 读是安全的
    const text = execFileSync(exe, ['query', 'HKLM\\SYSTEM\\CurrentControlSet\\Control\\Nls\\CodePage', '/v', 'OEMCP'], {
      encoding: 'utf8',
      windowsHide: true,
      timeout: 3000,
      maxBuffer: 1024 * 1024,
      stdio: ['ignore', 'pipe', 'ignore'],
    })
    const m = /OEMCP\s+REG_SZ\s+(\d+)/.exec(text)
    if (m) oemLabelCache = OEM_LABELS[m[1] as string] ?? null
  } catch {
    oemLabelCache = null
  }
  return oemLabelCache
}

function countReplacements(text: string): number {
  let n = 0
  for (let i = 0; i < text.length; i += 1) if (text.charCodeAt(i) === 0xfffd) n += 1
  return n
}

function decodeWith(label: string, buf: Buffer): string | null {
  try {
    return new TextDecoder(label).decode(buf)
  } catch {
    return null
  }
}

/**
 * 解 Windows 命令行工具的输出。
 *
 * ★ 这里是踩过坑的：**不能**直接 `encoding:'utf8'`。
 *   `reg.exe` 的 stdout 跟随**控制台输出代码页**（中文系统 = 936/GBK）。同一个 exe、
 *   同一台机器、同一份注册表，**有没有控制台决定了吐出来的字节**：我在 pwsh 里验证
 *   「注册表读出来是合法 UTF-8」是对的，但打包后的 GUI 进程没有控制台，它吐的是 GBK，
 *   我们再按 UTF-8 解 →「思源黑体 Medium」变成 4 个 U+FFFD（界面上一排问号方块），
 *   而 Arial 这种纯 ASCII 的名字照样正确，所以很容易被当成「个别字体坏了」。
 *   现场实测：同一命令，pwsh 里 utf8 坏字符 0 / GBK 坏字符 72；Electron 里
 *   utf8 坏字符 88 / GBK 坏字符 0。
 *
 * 做法：先按系统 OEM 代码页解，再用「U+FFFD 的个数」投票选最像样的候选。
 */
function decodeConsoleText(buf: Buffer, exe: string): string {
  const labels: string[] = []
  const oem = oemCodePageLabel(exe)
  if (oem) labels.push(oem)
  labels.push('utf8', 'gbk', 'big5', 'shift_jis', 'euc-kr')

  let best: string | null = null
  let bestBad = Number.POSITIVE_INFINITY
  for (const label of labels) {
    const text = decodeWith(label, buf)
    if (text === null) continue
    const bad = countReplacements(text)
    if (bad === 0) return text
    if (bad < bestBad) {
      bestBad = bad
      best = text
    }
  }
  // 全都带坏字符：latin1 是无损字节映射（只是会显示成乱码），总比丢字符强
  return best ?? buf.toString('latin1')
}

/**
 * 解 name 表里的字符串。Windows / Unicode 平台是**大端** UTF-16（Node 只有 utf16le，
 * 所以先 swap16 再解），Mac 平台按 latin1 兜。
 */
function decodeNameString(platform: number, raw: Buffer): string | null {
  let text: string
  if (platform === 0 || platform === 3) {
    const even = raw.length % 2 === 0 ? raw : raw.subarray(0, raw.length - 1)
    text = Buffer.from(even).swap16().toString('utf16le')
  } else if (platform === 1) {
    text = raw.toString('latin1')
  } else {
    return null
  }
  const value = text.replace(/\0/g, '').trim()
  return value === '' ? null : value
}

/**
 * 从字体文件的 name 表里读出**家族名**（TTF / OTF / TTC 都走这条）。
 *
 * ★ 为什么非得读文件，而不是直接用注册表的值名：
 *   注册表值名是「安装时的全名」，通常带字重 / 字形后缀，而 CSS 只认**家族名**。
 *   现场实测（canvas 量同一串字的宽度，和不存在的家族对比）：
 *     "CaskaydiaMono NF"              命中
 *     "CaskaydiaMono Nerd Font"       命中
 *     "CaskaydiaMono NF Bold Italic"  命中不了（等于写了个不存在的字体）
 *   注册表里写的正是第三种。用户装的 Nerd Font 在面板里搜「Nerd」一条都搜不到，
 *   根因就在这 —— 注册表值名里根本没有「Nerd」，家族名只写在字体文件里。
 *
 * ★ 取名规则（274 条注册表项 → 143 个名字，实测 57ms）：
 *   1. **有 nameID 16（Typographic Family）就用它，完全不看 nameID 1**。
 *      16 是「一个字体家族」的名字，能把 Bold / Italic 这些字重收敛掉；而 1 是
 *      每个字重各自的 legacy 家族（CaskaydiaMono NFM SemiBold…），放进来就是噪音。
 *      只有没有 16 的字体（Arial、宋体这些老字体）才退回 1。
 *   2. **英文名 + 中文名都给**（0x0409 / 0x0804）。中文系统上 DSH 自己的字体设置里
 *      写的就是「微软雅黑」这种中文名，只给英文名等于把中文用户的一半字体藏起来。
 *      两个名字 CSS 都能命中，所以它们是两条并列条目，不是别名。
 *   3. 读不到文件（12 个，多为 .fon 位图字体）由调用方退回注册表值名。
 *
 * 只读文件头 + 表目录 + name 表三小段（几 KB），不整份读。
 */
function readFontFamilyNames(file: string): string[] {
  let fd: number | undefined
  try {
    fd = openSync(file, 'r')
    const hdr = Buffer.alloc(12)
    if (readSync(fd, hdr, 0, 12, 0) < 12) return []
    let base = 0
    if (hdr.toString('latin1', 0, 4) === 'ttcf') {
      // TTC 集合：取第一个字体的偏移（表目录里的偏移是相对文件开头算的）
      const head = Buffer.alloc(16)
      if (readSync(fd, head, 0, 16, 0) < 16) return []
      base = head.readUInt32BE(12)
      if (readSync(fd, hdr, 0, 12, base) < 12) return []
    }
    const numTables = hdr.readUInt16BE(4)
    if (!numTables || numTables > 512) return []
    const dir = Buffer.alloc(numTables * 16)
    if (readSync(fd, dir, 0, dir.length, base + 12) < dir.length) return []
    let off = 0
    let len = 0
    for (let i = 0; i < numTables; i += 1) {
      const rec = dir.subarray(i * 16, i * 16 + 16)
      if (rec.toString('latin1', 0, 4) === 'name') {
        off = rec.readUInt32BE(8)
        len = rec.readUInt32BE(12)
        break
      }
    }
    if (!off || !len || len > 2 * 1024 * 1024) return []
    const tbl = Buffer.alloc(len)
    if (readSync(fd, tbl, 0, len, off) < len) return []
    const count = Math.min(tbl.readUInt16BE(2), 4096)
    const strOff = tbl.readUInt16BE(4)
    // id -> 语言码 -> 名字（Windows 平台）；id -> 名字（其它平台的兜底）
    const langs = new Map<number, Map<number, string>>()
    const loose = new Map<number, string>()
    for (let i = 0; i < count; i += 1) {
      const p = 6 + i * 12
      if (p + 12 > tbl.length) break
      const platform = tbl.readUInt16BE(p)
      const language = tbl.readUInt16BE(p + 4)
      const id = tbl.readUInt16BE(p + 6)
      if (id !== 1 && id !== 16) continue
      const l = tbl.readUInt16BE(p + 8)
      const o = tbl.readUInt16BE(p + 10)
      const value = decodeNameString(platform, tbl.subarray(strOff + o, strOff + o + l))
      if (!value) continue
      if (platform === 3) {
        let bucket = langs.get(id)
        if (!bucket) {
          bucket = new Map<number, string>()
          langs.set(id, bucket)
        }
        if (!bucket.has(language)) bucket.set(language, value)
      } else if (!loose.has(id)) {
        loose.set(id, value)
      }
    }
    const english = (id: number) => langs.get(id)?.get(0x0409) ?? loose.get(id) ?? null
    const chinese = (id: number) => langs.get(id)?.get(0x0804) ?? langs.get(id)?.get(0x0404) ?? null
    const out: string[] = []
    const push = (v: string | null) => {
      if (v && !out.includes(v)) out.push(v)
    }
    if (english(16) || chinese(16)) {
      push(english(16))
      push(chinese(16))
    } else {
      push(english(1))
      push(chinese(1))
    }
    return out
  } catch {
    return []
  } finally {
    if (fd !== undefined) closeSync(fd)
  }
}

/**
 * 读注册表里的字体表：值名（安装全名）+ 值数据（字体文件路径，HKLM 常常只是文件名）。
 *
 * 用 reg.exe（不是 PowerShell：后者起进程要几百毫秒还依赖执行策略）。它是同步调用，
 * 结果在进程内缓存 10 分钟 —— 字体列表是「装一次系统才变一次」的东西。读不到返回空
 * 数组，交给上层退化。
 */
function readRegistryFontEntries(): Array<{ display: string; file: string | null }> {
  if (process.platform !== 'win32') return []
  const exe = join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'reg.exe')
  const winFonts = join(process.env.SystemRoot ?? 'C:\\Windows', 'Fonts')
  const keys = [
    'HKLM\\SOFTWARE\\Microsoft\\Windows NT\\CurrentVersion\\Fonts',
    'HKCU\\SOFTWARE\\Microsoft\\Windows NT\\CurrentVersion\\Fonts',
  ]
  const out: Array<{ display: string; file: string | null }> = []
  for (const key of keys) {
    let text = ''
    try {
      const buf = execFileSync(exe, ['query', key], {
        encoding: 'buffer',
        windowsHide: true,
        timeout: 5000,
        maxBuffer: 8 * 1024 * 1024,
        stdio: ['ignore', 'pipe', 'ignore'],
      })
      text = decodeConsoleText(buf, exe)
    } catch {
      continue
    }
    for (const line of text.split(/\r?\n/)) {
      // 值行形如「    Arial (TrueType)    REG_SZ    arial.ttf」
      const m = /^\s{2,}(.+?)\s{2,}REG_[A-Z_]+\s*(.*)$/.exec(line)
      if (!m) continue
      const display = m[1] as string
      const data = (m[2] ?? '').trim()
      let file: string | null = null
      if (data && !/^REG_/.test(data)) {
        const candidate = isAbsolute(data) ? data : join(winFonts, data)
        if (existsSync(candidate)) file = candidate
      }
      if (cleanFontName(display)) out.push({ display, file })
    }
  }
  return out
}

/** 退化方案：扫 %WINDIR%\Fonts 的文件名（拿不到家族名，只能给出文件名） */
function readFontDirNames(): string[] {
  const dir = join(process.env.SystemRoot ?? 'C:\\Windows', 'Fonts')
  try {
    return readdirSync(dir)
      .filter((f) => RE_FONT_FILE.test(f))
      .map((f) => f.replace(RE_FONT_FILE, ''))
  } catch {
    return []
  }
}

let fontCache: SystemFontsResult | null = null

/** 枚举系统字体家族名（家族名读自字体文件的 name 表，退化到字体目录），进程内缓存 10 分钟 */
export function listSystemFonts(force = false): SystemFontsResult {
  if (!force && fontCache && Date.now() - fontCache.scannedAt < FONT_CACHE_MS) return fontCache

  const fromReg = readRegistryFontEntries()
  const raw: string[] = []
  let fromFile = 0
  for (const entry of fromReg) {
    const names = entry.file ? readFontFamilyNames(entry.file) : []
    if (names.length > 0) {
      fromFile += 1
      for (const name of names) raw.push(name)
      continue
    }
    // 读不到 name 表（多为 .fon 位图字体）：退回注册表值名，聊胜于无
    const shown = cleanFontName(entry.display)
    if (shown) raw.push(shown)
  }
  const fromDir = raw.length > 0 ? [] : readFontDirNames()
  const source: SystemFontsResult['source'] =
    raw.length > 0 ? 'registry' : fromDir.length > 0 ? 'fontdir' : 'none'

  const seen = new Set<string>()
  const fonts: string[] = []
  for (const name of raw.length > 0 ? raw : fromDir) {
    const k = name.toLowerCase()
    if (seen.has(k)) continue
    seen.add(k)
    fonts.push(name)
  }
  fonts.sort((a, b) => a.localeCompare(b, 'en', { sensitivity: 'base', numeric: true }))

  const note =
    source === 'registry'
      ? `从 ${fromReg.length} 条注册表项读到 ${fonts.length} 个字体家族（字体文件里解析出家族名的有 ${fromFile} 个）`
      : source === 'fontdir'
        ? `读注册表失败，已退化成扫 %WINDIR%\\Fonts 的文件名（${fonts.length} 项，不是家族名，可能搜不到想要的字体）`
        : '既读不到注册表也扫不到字体目录，请手动输入字体名'

  fontCache = { fonts, source, count: fonts.length, scannedAt: Date.now(), note }
  return fontCache
}
/** 让下一次 listSystemFonts 重新扫描（面板上的「重新扫描」用） */
export function clearSystemFontsCache(): void {
  fontCache = null
}
