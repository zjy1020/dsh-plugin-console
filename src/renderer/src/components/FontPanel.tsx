/* 字体面板：改的是 DSH 本体（桌面端界面自己）的字体，不是插件台自己的字体。
 *
 * 为什么走 cordis.patch.yml 而不是插件台自己的设置：
 * 插件台自己的偏好可以存在 userData 里，但「DSH 的界面字体」这个值 DSH 只认它自己的
 * 配置真源 —— profile 目录下的 cordis.patch.yml 里 ui-theme 条目的 config 三键。
 * DSH 监听这个文件（hmr 同时 watch profile patch 与 home patch），所以改文件是热生效的，
 * 不需要重启 DSH；反过来，如果插件台把这个值只存在自己家里，DSH 永远看不到。
 *
 * 这个组件不认识 store，也不 import src/main 里的任何东西（渲染进程的 tsconfig 不包含
 * src/main，连 type 也拿不到）。所以下面镜像了一份字体引擎的类型，并约定由外部把一个
 * 满足 FontsApi 的东西注进来；不注就直接用 window.dsh（接线时由 preload 暴露）。
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'

// 样式跟着组件走（和 logdrawer.css / market.css 一样），这样只要挂上这个面板样式就一定在
import '../styles/font-panel.css'

/* ============================ 与引擎对齐的类型 ============================ */

export interface FontFamilyValues {
  text: string
  code: string
  terminal: string
}

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
  keys: Record<keyof FontFamilyValues, FontKeyState>
  homePatchPath: string
  homePatchExists: boolean
  homePatchEntryFound: boolean
  homePatchValues: FontFamilyValues
  homePatchSetsFonts: boolean
  mtimeMs: number
  note: string
}

export interface FontsWriteInput {
  text?: string | null
  code?: string | null
  terminal?: string | null
}

export interface FontsWriteResult {
  ok: boolean
  error: string | null
  conflict: boolean
  patchPath: string
  backup: string | null
  createdPatch: boolean
  createdEntry: boolean
  createdConfig: boolean
  removedConfigLine: boolean
  changed: string[]
  skipped: Array<{ role: string; reason: string }>
  values: FontFamilyValues
  note: string
  mtimeMs: number
}

/** 外部需要给的东西：三个调用。plugin/main 侧本来就是这么导出的，直接透传即可。 */
export interface FontsApi {
  readFonts(profile: string): Promise<FontsReadResult>
  writeFonts(profile: string, patch: FontsWriteInput, expectedMtimeMs?: number): Promise<FontsWriteResult>
  listSystemFonts(force?: boolean): Promise<SystemFontsResult>
}

export interface FontPanelProps {
  /** 目标 profile 名（如 desktop / web），对应 ~/.dsh/profiles/<name> */
  profile: string
  /** 省略时自动取 window.dsh */
  api?: FontsApi
  /** 写入或恢复默认之后回调（外层可以顺手刷新别的东西） */
  onChanged?: () => void
}

/* ============================== 小工具 ============================== */

const msg = (e: unknown): string => (e instanceof Error ? e.message : String(e))

/** 渲染进程里没有 src/shared 的 dsh 声明可用时就退到全局对象上找 */
function globalApi(): FontsApi | null {
  const bag = globalThis as unknown as { dsh?: Partial<FontsApi> }
  const dsh = bag.dsh
  if (!dsh || typeof dsh.readFonts !== 'function' || typeof dsh.writeFonts !== 'function') return null
  return dsh as FontsApi
}

interface RoleSpec {
  key: keyof FontFamilyValues
  label: string
  field: string
  hint: string
}

const ROLES: RoleSpec[] = [
  { key: 'text', label: '正文字体', field: 'textFontFamily', hint: '界面与会话正文用的字体栈' },
  { key: 'code', label: '代码字体', field: 'codeFontFamily', hint: '代码块与行内代码' },
  { key: 'terminal', label: '终端字体', field: 'terminalFontFamily', hint: '终端面板（只影响终端）' },
]

const RESET_ARM_MS = 6000
/**
 * 下拉里最多渲染几条。
 *
 * ★ 原来是 60，被用户当场抓到：「还是只显示前 60 个，我想显示的是我电脑有的字体」——
 *   60 条对一台装了 Nerd Font 的机器远远不够（这台 119 个家族，前 60 个里根本没有
 *   他找的那款），而列表本身已经带了 max-height + 滚动，多渲染几十条没有代价。
 *   现在按「够装下任何一台普通机器的全部字体」给，真超出了也有下面的计数行兜底。
 */
const LIST_LIMIT = 600

/** 空串 = 交给 DSH 用内置栈（写文件时等于把这个键删掉） */
const forWrite = (v: string): string | null => (v.trim() === '' ? null : v.trim())

function sameValues(a: FontFamilyValues, b: FontFamilyValues): boolean {
  return a.text === b.text && a.code === b.code && a.terminal === b.terminal
}

function describeWrite(role: RoleSpec, next: string, current: string): string {
  const v = next.trim()
  if (v === '') {
    return current.trim() === ''
      ? `${role.field}：删除（本来就是默认，不动）`
      : `${role.field}：删除，回到 DSH 内置字体栈`
  }
  if (v === current.trim()) return `${role.field}：${v}（没变）`
  return current.trim() === '' ? `${role.field}：${v}（新增）` : `${role.field}：${current.trim()} → ${v}`
}

/* ============================== 主面板 ============================== */

export default function FontPanel({ profile, api: apiProp, onChanged }: FontPanelProps) {
  const api = useMemo<FontsApi | null>(() => apiProp ?? globalApi(), [apiProp])

  const [read, setRead] = useState<FontsReadResult | null>(null)
  const [fonts, setFonts] = useState<SystemFontsResult | null>(null)
  const [draft, setDraft] = useState<FontFamilyValues>({ text: '', code: '', terminal: '' })
  const [loaded, setLoaded] = useState(false)
  const [busy, setBusy] = useState<string | null>(null)
  const [note, setNote] = useState<string | null>(null)
  const [armed, setArmed] = useState(false)

  const timerRef = useRef<number | null>(null)
  useEffect(() => () => { if (timerRef.current !== null) window.clearTimeout(timerRef.current) }, [])

  /** 读磁盘真相，并把草稿对齐到它 —— 免得出现「界面显示 A、DSH 设置里是 B」 */
  const load = useCallback(
    async (silent = false, keepDraft = false) => {
      if (!api) {
        setNote('拿不到字体引擎：window.dsh 里没有 readFonts / writeFonts，请检查 preload 是否注入了这两个接口。')
        setLoaded(true)
        return
      }
      setBusy('read')
      try {
        const r = await api.readFonts(profile)
        setRead(r)
        /* keepDraft：并发冲突时只刷新 mtime 给下一次写入用，不能把用户刚选好的字体冲掉
           （否则提示语说「请再点一次」，而再点一次其实无事可做） */
        if (!keepDraft) setDraft(r.values)
        if (!silent) setNote(r.ok ? null : r.error ?? '读取失败')
      } catch (e) {
        setNote(`读取失败：${msg(e)}`)
      } finally {
        setBusy(null)
        setLoaded(true)
      }
    },
    [api, profile],
  )

  useEffect(() => { void load() }, [load])

  useEffect(() => {
    if (!api) return
    let alive = true
    try {
      api
        .listSystemFonts()
        .then((r) => { if (alive) setFonts(r) })
        .catch(() => { /* 字体列表拿不到不算致命，选手动输入 */ })
    } catch {
      /* 这里不 try 的话，接口名字对不上会当场抛在调用前 —— 异常冒到 React 渲染树，
         整个界面直接白屏，而白屏时 DOM 是空的，排查成本极高（踩过一次）。 */
    }
    return () => { alive = false }
  }, [api])

  useEffect(() => {
    if (!armed) return
    timerRef.current = window.setTimeout(() => setArmed(false), RESET_ARM_MS)
    return () => { if (timerRef.current !== null) window.clearTimeout(timerRef.current) }
  }, [armed])

  const dirty = read ? !sameValues(draft, read.values) : false

  const preview = useMemo(() => {
    if (!read) return []
    return ROLES.map((role) => describeWrite(role, draft[role.key], read.values[role.key]))
  }, [read, draft])

  const execute = useCallback(
    async (input: FontsWriteInput, what: string) => {
      if (!api) return
      setBusy(what)
      setNote(null)
      try {
        const r = await api.writeFonts(profile, input, read?.mtimeMs)
        if (r.conflict) setNote('DSH 刚刚改过这个文件，插件台没有硬写。已重新读取文件，你选的字体还在，再点一次「应用」就会写进去。')
        else if (!r.ok) setNote(`写入失败：${r.error ?? '未知原因'}`)
        else {
          const bits: string[] = []
          if (r.changed.length > 0) bits.push(`已写入 ${r.changed.join(' / ')}`)
          if (r.createdPatch) bits.push('新建了 cordis.patch.yml')
          if (r.createdEntry) bits.push('补了 ui-theme 条目')
          if (r.createdConfig) bits.push('补了 config 段')
          if (r.removedConfigLine) bits.push('顺手收掉了空的 config 段')
          if (r.backup) bits.push(`备份：${r.backup}`)
          if (r.note) bits.push(r.note)
          for (const s of r.skipped) bits.push(`跳过 ${s.role}：${s.reason}`)
          if (bits.length === 0) bits.push('没有改动')
          setNote(bits.join('；'))
          if (r.changed.length > 0 || r.createdPatch || r.createdEntry || r.createdConfig) onChanged?.()
        }
        await load(true, r.conflict === true)
      } catch (e) {
        setNote(`写入失败：${msg(e)}`)
      } finally {
        setBusy(null)
      }
    },
    [api, load, onChanged, profile, read],
  )

  const onApply = () => {
    if (!read) return
    void execute(
      { text: forWrite(draft.text), code: forWrite(draft.code), terminal: forWrite(draft.terminal) },
      'apply',
    )
  }

  const onReset = () => {
    if (!armed) {
      setArmed(true)
      setNote(`再点一次「确认恢复默认」就会把 ${ROLES.map((r) => r.field).join(' / ')} 三个键从 patch 里删掉（会先备份）。`)
      return
    }
    setArmed(false)
    void execute({ text: null, code: null, terminal: null }, 'reset')
  }

  /* ------------------------------- 渲染 ------------------------------- */

  const fontsLabel = fonts
    ? fonts.source === 'registry'
      ? `已读到 ${fonts.count} 个字体家族（注册表 + 字体文件）`
      : fonts.source === 'fontdir'
        ? `已读到 ${fonts.count} 个字体（字体目录）`
        : '没能读到系统字体列表，可直接手输字体名'
    : '正在读系统字体列表…'

  return (
    <div className="fp">
      <div className="settings__group">
        <div className="section-title">DSH 本体字体</div>
        <p className="fp__lead">
          这里改的是 <b>DSH 界面自己</b>的字体（正文 / 代码 / 终端），写入目标 profile 的补丁文件：
          <span className="mono selectable fp__path">{read?.patchPath ?? '（未知，正在读）'}</span>
          DSH 有文件监听，改完通常几秒内热生效；没变化就刷新一下 DSH 窗口（或重启 DSH）。
          留空 = 交回 DSH 内置字体栈（等于把这个键删掉）。
        </p>
        <div className="fp__meta">
          <span className="muted">{fontsLabel}</span>
          {busy ? <span className="muted">处理中…</span> : null}
        </div>
      </div>

      {read?.homePatchSetsFonts ? (
        <div className="fp__banner fp__banner--warn">
          <b>注意：全 profile 补丁里也设了字体。</b>
          机器级的 <span className="mono selectable">{read.homePatchPath}</span> 优先级高于 profile 自己的补丁，
          它会把这里的值压住（DSH 会照 home patch 里的值渲染）。要真正生效，得先把那边的
          <span className="mono"> textFontFamily / codeFontFamily / terminalFontFamily </span>
          清掉。
        </div>
      ) : null}

      {read && !read.patchExists ? (
        <div className="fp__banner">
          这个 profile 还没有 <span className="mono">cordis.patch.yml</span>，应用时插件台会新建一份（先备份，不会动别的文件）。
        </div>
      ) : null}

      {read && read.patchExists && !read.entryFound ? (
        <div className="fp__banner">
          文件里还没有 <span className="mono">- id: ui-theme</span> 这一条，应用时会在文件末尾追加一条（原有内容一个字节都不动）。
        </div>
      ) : null}

      <div className="settings__group">
        <div className="section-title">选择字体</div>
        {ROLES.map((role) => {
          const st = read?.keys[role.key]
          return (
            <div className="fp__row" key={role.key}>
              <div className="fp__rowlabel">
                {role.label}
                <span className="fp__hint">{role.hint}</span>
              </div>
              <div className="fp__rowside">
                <FontPicker
                  value={draft[role.key]}
                  fonts={fonts}
                  disabled={!loaded || busy !== null}
                  onChange={(next) => setDraft((d) => ({ ...d, [role.key]: next }))}
                />
                <span className="fp__state">
                  {!read ? '…' : st?.present ? `补丁里已有（第 ${st.line} 行）` : '补丁里没有'}
                </span>
              </div>
            </div>
          )
        })}
      </div>

      <div className="settings__group">
        <div className="section-title">要写入的内容</div>
        <ul className="fp__preview">
          {preview.length === 0 ? <li className="muted">正在读取…</li> : preview.map((line, i) => (
            <li key={ROLES[i]?.field ?? i} className={line.includes('（没变）') ? 'muted' : undefined}>{line}</li>
          ))}
        </ul>
        <div className="fp__actions">
          <button
            type="button"
            className="btn btn--primary"
            disabled={!dirty || busy !== null || !read}
            onClick={onApply}
          >
            {busy === 'apply' ? '写入中…' : '应用'}
          </button>
          <button
            type="button"
            className={armed ? 'btn btn--danger' : 'btn btn--ghost'}
            disabled={busy !== null || !read}
            onClick={onReset}
          >
            {busy === 'reset' ? '恢复中…' : armed ? '确认恢复默认' : '恢复默认'}
          </button>
          <button type="button" className="btn btn--ghost" disabled={busy !== null} onClick={() => void load()}>
            重新读取
          </button>
        </div>
        <div className="fp__foot">
          {dirty ? '有未应用的改动。' : '草稿和磁盘上的值一致。'}
          写入前会自动备份到 <span className="mono">.dsh-console/backup/</span>，
          并且只碰 ui-theme 这一个条目下的这三个键。
        </div>
      </div>

      {note ? <div className={busy === null && /失败|不能|跳/.test(note) ? 'fp__note fp__note--warn' : 'fp__note'}>{note}</div> : null}
    </div>
  )
}

/* ============================ 可搜索选择器 ============================ */

interface FontPickerProps {
  value: string
  fonts: SystemFontsResult | null
  disabled: boolean
  onChange: (next: string) => void
}

function FontPicker({ value, fonts, disabled, onChange }: FontPickerProps) {
  const [open, setOpen] = useState(false)
  const [q, setQ] = useState('')
  const boxRef = useRef<HTMLDivElement | null>(null)
  const inputRef = useRef<HTMLInputElement | null>(null)

  // 点外面就关掉；不用遮罩，免得在设置面板里又糊一层
  useEffect(() => {
    if (!open) return
    const onDoc = (e: MouseEvent) => {
      if (boxRef.current && !boxRef.current.contains(e.target as Node)) setOpen(false)
    }
    document.addEventListener('mousedown', onDoc)
    return () => document.removeEventListener('mousedown', onDoc)
  }, [open])

  useEffect(() => {
    if (!open) return
    setQ('')
    inputRef.current?.focus()
  }, [open])

  const list = useMemo(() => {
    const all = fonts?.fonts ?? []
    const key = q.trim().toLowerCase()
    const hit = key === '' ? all : all.filter((f) => f.toLowerCase().includes(key))
    return { shown: hit.slice(0, LIST_LIMIT), total: hit.length }
  }, [fonts, q])

  const pick = (next: string) => {
    onChange(next)
    setOpen(false)
  }

  return (
    <div className="fpick" ref={boxRef}>
      <button
        type="button"
        className={open ? 'fpick__trigger is-open' : 'fpick__trigger'}
        disabled={disabled}
        onClick={() => setOpen((o) => !o)}
        title={value || '默认（跟随 DSH 内置字体栈）'}
      >
        <span className={value ? 'fpick__value' : 'fpick__value fpick__value--empty'}>
          {value || '默认（跟随 DSH 内置栈）'}
        </span>
        <span className="fpick__caret">▾</span>
      </button>

      {open ? (
        <div className="fpick__pop" onKeyDown={(e) => { if (e.key === 'Escape') setOpen(false) }}>
          <input
            ref={inputRef}
            className="input fpick__search"
            value={q}
            placeholder="打字筛字体；也可以直接输入字体名（逗号分隔可写多个）"
            spellCheck={false}
            onChange={(e) => setQ(e.target.value)}
          />
          <div className="fpick__quick">
            {q.trim() !== '' ? (
              <button type="button" className="fpick__quickbtn" onClick={() => pick(q.trim())}>
                用「{q.trim()}」
              </button>
            ) : null}
            <button type="button" className="fpick__quickbtn" onClick={() => pick('')}>
              默认（清掉这一项）
            </button>
          </div>
          <div className="fpick__list">
            {list.shown.length === 0 ? (
              <div className="fpick__empty muted">
                {fonts ? '没匹配到字体，可以直接按上面的「用这段文本」' : '还在读系统字体…'}
              </div>
            ) : (
              list.shown.map((f) => (
                <button
                  key={f}
                  type="button"
                  className={f === value ? 'fpick__item is-on' : 'fpick__item'}
                  onClick={() => pick(f)}
                  title={f}
                >
                  <span className="fpick__itemname">{f}</span>
                </button>
              ))
            )}
          </div>
          <div className="fpick__count muted">
            {list.total > list.shown.length
              ? `显示前 ${list.shown.length} / 匹配 ${list.total} 个，继续输入缩小范围`
              : `匹配 ${list.total} 个`}
            {fonts ? `（本机共 ${fonts.count} 个家族）` : ''}
          </div>
        </div>
      ) : null}
    </div>
  )
}
