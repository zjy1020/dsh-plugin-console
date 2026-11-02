/**
 * InstallPanel —— 五个 tab：智能输入（预检）/ 搜索 npm / 手动 spec / 导入清单 / 插件市场。
 *
 * 数据：installPreview(profile, input)（400ms 防抖）、registrySearch(query, 25)、
 *       importManifest(profile, text)（只解析不安装，500ms 防抖）
 * 动作：runOp({kind:'install', profile, spec})、runOp({kind:'install-manifest', profile, spec})（日志进 LogDrawer）
 */

import { useEffect, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from 'react'
import type { InstallPreview, ManifestPreview, SearchHit, VersionOption } from '../../../shared/types'
import { api, toMessage, useDebouncedValue } from '../api'
import { useConsole, type InstallConfirmHint } from '../lib/store'
import { EmptyState } from './EmptyState'
import { envRedetectFn, pickDirectoryFn, pickedIsValid, wrongPickMessage } from './EnvDiagnostics'
import { MarketTab } from './MarketTab'
import { RuntimeProvision } from './RuntimeProvision'
import VersionPicker from './VersionPicker'

type Tab = 'auto' | 'search' | 'manual' | 'manifest' | 'market'

/**
 * 找这个包在 profile 里**真实已装**的版本。
 *
 * 为什么要它：installPreview 的 resolvedVersion 是远端最新版（对 dsh-context 是 0.79.0），
 * 拿它当「当前」会让版本面板把 0.79.0 标成「当前」并把真正已装的 0.78.1 标成「降级」——方向全反。
 * 找不到就返回 undefined，让 VersionPicker 自己去 listPlugins 兜底（传 null 会被当成「确实没有」）。
 */
function installedVersionOf(
  plugins: { profile: string; name: string; version: string | null; installed: boolean }[],
  profile: string,
  name: string | null | undefined
): string | undefined {
  if (!name) return undefined
  return plugins.find((p) => p.profile === profile && p.name === name && p.installed)?.version ?? undefined
}

const TABS: { key: Tab; label: string; hint: string }[] = [
  { key: 'auto', label: '智能输入', hint: 'GitHub URL / owner/repo / npm 包名，装之前先预检' },
  { key: 'search', label: '搜索 npm', hint: '按关键词搜 registry，命中直接装' },
  { key: 'manual', label: '手动 spec', hint: '任意 pnpm spec，跳过预检' },
  { key: 'manifest', label: '导入清单', hint: '选一份导出的清单 JSON，批量装回来（装之前给预览和确认）' },
  { key: 'market', label: '插件市场', hint: 'dshmarket 的插件目录，3000+ 条；按分类 / 星标 / 下载量挑，点安装直接装' }
]

export function InstallPanel() {
  const { state, actions } = useConsole()
  const [tab, setTab] = useState<Tab>('auto')
  const tabRefs = useRef<(HTMLButtonElement | null)[]>([])

  const profile = state.activeProfile
  const busy = state.op !== null

  /** 左右方向键在 tab 之间挪焦点并激活（WAI-ARIA tabs 的常规键盘行为） */
  const onTabKey = (e: ReactKeyboardEvent<HTMLButtonElement>, index: number) => {
    const dir = e.key === 'ArrowRight' ? 1 : e.key === 'ArrowLeft' ? -1 : e.key === 'Home' ? -99 : e.key === 'End' ? 99 : 0
    if (dir === 0) return
    e.preventDefault()
    const n = TABS.length
    const next = dir === -99 ? 0 : dir === 99 ? n - 1 : (index + dir + n) % n
    setTab(TABS[next].key)
    tabRefs.current[next]?.focus()
  }

  if (!profile) {
    /*
     * 新电脑上最容易撞到的一屏。
     *
     * 原来的空态只有一个「打开设置」—— 用户点进去，设置里两个路径框是空的，
     * 他还得自己猜该填什么。等于把「找不到环境」这道题从主界面挪到了设置里，
     * 一道题没解决，只是换了个地方卡住。
     *
     * 现在三条路都摆在脸上，优先级从「最省事」到「最兜底」：
     *   1) 自动检测一遍：清缓存重跑完整探测，成了直接把界面救回来；
     *   2) 手动指定 .dsh 目录：系统原生选择框，选完直接落盘 + 重探；
     *   3) 打开设置：前面两条都不成，或者用户想改别的东西时才走这条。
     *
     * ★ 判据是 node/pnpm（.dsh 里那套运行时），不是「DSH 装在哪」。
     *   插件装进 `<DSH_HOME>/profiles/<名>`，跑的是 `<DSH_HOME>/dsh-runtimes` 里的
     *   node 与 pnpm —— 跟 DSH 桌面端安装在哪个盘毫无关系。安装目录只影响
     *   「启动 / 退出 DSH」两个按钮，不该在这里拦人。
     *
     * 「新建 profile」不在这里做 —— profile 是 DSH 自己的概念（~/.dsh/profiles/<名>），
     * 插件台凭空造一个只会造出一个 DSH 不认识、也加载不了的空目录。
     * 真正缺 profile 时该由 DSH 自己首次启动去建，这里只负责把 DSH 找回来。
     */
    const autoFn = envRedetectFn()
    const pickFn = pickDirectoryFn()

    const doAuto = async () => {
      if (!autoFn) return
      try {
        const info = await autoFn()
        actions.applyRuntime(info)
        await actions.reloadAll({ silent: true })
        if (info.nodePath && info.pnpmPath) {
          actions.toast('success', '找到运行时了', info.dshHome ?? '')
        } else {
          actions.toast('warn', '还是没找到', '可以点「手动指定 .dsh 目录…」直接指给它。')
        }
      } catch (e: unknown) {
        actions.toast('error', '检测失败', toMessage(e))
      }
    }

    const doPick = async () => {
      if (!pickFn) return
      try {
        const picked = await pickFn(
          '选择 .dsh 目录（里面应该有 profiles 和 dsh-runtimes；默认在 C:\\Users\\<你的用户名>\\.dsh）'
        )
        if (!picked) return
        await api().settingsSet({ dshHome: picked })
        /* 与首屏引导卡同一条规矩：选完必须让探测复核一遍再报结果。
         * 原来这里只 toast 一句「已记下安装目录」就完事 —— 选错了也是这句，
         * 用户以为好了，回头一看还是装不了。 */
        const info = autoFn ? await autoFn() : null
        await actions.reloadAll({ silent: true })
        if (pickedIsValid(picked, info)) {
          actions.toast('success', '找到 DSH 了', info?.dshHome ?? picked)
        } else {
          actions.toast('error', '这个目录不对', wrongPickMessage(picked, info))
        }
      } catch (e: unknown) {
        actions.toast('error', '选择失败', toMessage(e))
      }
    }

    return (
      <section className="install" aria-label="安装插件">
        <EmptyState
          icon="◍"
          title="还没准备好，装不了"
          hint={
            <>
              安装需要一个目标 profile，而 profile 在 .dsh 目录里。现在还没找到能用的
              Node / pnpm 运行时（或者 .dsh 下还没有 profile）。
              <br />
              下面两个按钮随便点一个就能自己解决，不用手打路径。
            </>
          }
          action={{
            label: '自动检测一遍',
            onClick: () => void doAuto(),
            primary: true,
            disabled: !autoFn
          }}
          secondaryAction={
            pickFn
              ? { label: '手动指定 .dsh 目录…', onClick: () => void doPick() }
              : { label: '打开设置', onClick: actions.openSettings }
          }
          footnote={
            pickFn
              ? undefined
              : '主进程还没接上「选择文件夹」通道，只能先去设置里填。'
          }
        />
        {pickFn ? (
          <p className="install__fallback">
            两个都不成，就去
            <button type="button" className="linkbtn" onClick={actions.openSettings}>
              设置
            </button>
            里手动填路径。
          </p>
        ) : null}

        {/* 一键补全：装了 DSH 桌面端、只是 dsh-runtimes 还没展开时，上面两颗按钮
            都救不了（探测再全也变不出 node.exe）。这一块能直接把随包载荷拷进 .dsh。
            源不可用时它自己只留一句原因，不占位、不留死按钮。 */}
        <RuntimeProvision className="install__provision" onDone={() => void actions.reloadAll({ silent: true })} />
      </section>
    )
  }

  return (
    <section className="install" aria-label="安装插件">
      <div className="install__tabs" role="tablist" aria-label="安装方式">
        {TABS.map((t, i) => (
          <button
            key={t.key}
            ref={(el) => {
              tabRefs.current[i] = el
            }}
            type="button"
            role="tab"
            aria-selected={tab === t.key}
            tabIndex={tab === t.key ? 0 : -1}
            className={`install__tab${tab === t.key ? ' is-active' : ''}`}
            onClick={() => setTab(t.key)}
            onKeyDown={(e) => onTabKey(e, i)}
            title={t.hint}
          >
            {t.label}
          </button>
        ))}
      </div>

      <div className="install__body">
        {tab === 'auto' ? <AutoTab profile={profile} busy={busy} /> : null}
        {tab === 'search' ? <SearchTab profile={profile} busy={busy} /> : null}
        {tab === 'manual' ? <ManualTab profile={profile} busy={busy} /> : null}
        {tab === 'manifest' ? <ImportTab profile={profile} busy={busy} /> : null}
        {tab === 'market' ? <MarketTab profile={profile} /> : null}
      </div>
    </section>
  )
}

/* ---------------------------------------------------------------- 智能输入 */

function AutoTab({ profile, busy }: { profile: string; busy: boolean }) {
  const { state, actions } = useConsole()
  const [input, setInput] = useState('')
  const debounced = useDebouncedValue(input.trim(), 400)

  const [preview, setPreview] = useState<InstallPreview | null>(null)
  const [loading, setLoading] = useState(false)
  const [err, setErr] = useState<string | null>(null)
  /** 版本面板是否展开（选特定版本 / 降级都走它） */
  const [pickOpen, setPickOpen] = useState(false)

  useEffect(() => {
    if (!debounced) {
      setPreview(null)
      setErr(null)
      setLoading(false)
      return
    }
    let alive = true
    setLoading(true)
    api()
      .installPreview(profile, debounced)
      .then((r) => {
        if (!alive) return
        setPreview(r)
        setErr(null)
      })
      .catch((e: unknown) => {
        if (!alive) return
        setPreview(null)
        setErr(toMessage(e))
      })
      .finally(() => {
        if (alive) setLoading(false)
      })
    return () => {
      alive = false
    }
  }, [debounced, profile])

  const parsedOk = preview ? preview.parsed.ok : true
  const canInstall = !!input.trim() && !busy && !loading && parsedOk

  const onInstall = async () => {
    const spec = input.trim()
    if (!spec) return
    // 把预检结果一起交给确认弹窗，用户在弹窗里就能看到「来源 / 装到 / 会改什么」
    const hint: InstallConfirmHint | undefined = preview
      ? {
          normalized: preview.parsed.normalized,
          name: preview.resolvedName,
          version: preview.resolvedVersion,
          isDshPlugin: preview.isDshPlugin,
          alreadyInstalled: preview.alreadyInstalled
        }
      : undefined
    const res = await actions.installSpec(spec, profile, hint)
    if (res?.ok) {
      setInput('')
      setPreview(null)
      setPickOpen(false)
    }
  }

  /** 从版本面板选中一条：直接拿 option.spec 去装（installSpec 里还会过一次确认弹窗） */
  const onPickVersion = (option: VersionOption) => {
    setPickOpen(false)
    void actions.installSpec(option.spec, profile, {
      normalized: option.spec,
      name: preview?.resolvedName ?? null,
      version: option.value,
      isDshPlugin: preview?.isDshPlugin ?? null,
      alreadyInstalled: preview?.alreadyInstalled ?? null
    })
  }

  return (
    <div className="install__pane">
      <label className="field">
        <span className="field__label">仓库地址 / 包名</span>
        <div className="field__row">
          <input
            className="input input--mono input--lg"
            placeholder="https://github.com/owner/repo  或  owner/repo"
            value={input}
            onChange={(e) => setInput(e.target.value)}
            spellCheck={false}
            autoComplete="off"
            aria-label="插件来源"
          />
          <button
            type="button"
            className="btn btn--ghost"
            onClick={() => setPickOpen((v) => !v)}
            disabled={!input.trim() || busy}
            aria-expanded={pickOpen}
            title="列出这个包的所有版本 / 标签 / 分支，选一个装"
          >
            选版本
          </button>
          <button
            type="button"
            className="btn btn--primary"
            onClick={() => void onInstall()}
            disabled={!canInstall}
            title={parsedOk ? '调用 pnpm add 安装' : '预检没通过，先修输入'}
          >
            {busy ? <span className="spinner spinner--sm" /> : null}
            安装
          </button>
        </div>
        <span className="field__hint">
          还认 <code>owner/repo</code>、<code>github:owner/repo#分支</code>、npm 包名、
          <code>包名@版本</code>、tarball 直链、<code>link:相对路径</code>。
          安装会写进当前 profile（{profile}）的 package.json 依赖，并跑 pnpm。日志在下方日志抽屉。
        </span>
      </label>

      {pickOpen && input.trim() ? (
        <div className="install__picker">
          <VersionPicker
            profile={profile}
            input={input.trim()}
            current={installedVersionOf(state.plugins, profile, preview?.resolvedName)}
            onPick={onPickVersion}
            onCancel={() => setPickOpen(false)}
          />
        </div>
      ) : null}

      {loading ? (
        <div className="install__preview" role="status">
          <div className="install__row">
            <span className="spinner spinner--sm" />
            <span className="muted">正在预检…</span>
          </div>
        </div>
      ) : null}

      {err ? (
        <div className="install__preview install__preview--err" role="alert">
          <div className="install__line install__err">预检失败：{err}</div>
        </div>
      ) : null}

      {preview && !loading ? (
        <div className="install__preview">
          <div className={`install__line${preview.parsed.ok ? '' : ' install__err'}`}>
            {preview.parsed.ok ? preview.parsed.reason : `识别失败：${preview.parsed.error ?? '未知原因'}`}
          </div>

          {preview.parsed.ok ? (
            <div className="kv">
              <span className="kv__k">normalized</span>
              <span className="kv__v mono selectable">{preview.parsed.normalized}</span>

              <span className="kv__k">包名</span>
              <span className="kv__v mono">{preview.resolvedName ?? '—'}</span>

              <span className="kv__k">版本</span>
              <span className="kv__v mono">{preview.resolvedVersion ?? '—'}</span>

              {preview.resolvedDescription ? (
                <>
                  <span className="kv__k">描述</span>
                  <span className="kv__v">{preview.resolvedDescription}</span>
                </>
              ) : null}
            </div>
          ) : null}

          {preview.isDshPlugin === false && preview.resolvedVersion ? (
            <div className="banner banner--warn install__warn" role="status">
              <span aria-hidden="true">▲</span>
              <span>这个版本的 package.json 里没有 dsh.bundle.patch —— 装了不会进加载列表。</span>
            </div>
          ) : null}

          {preview.alreadyInstalled ? (
            <div className="banner banner--info install__warn" role="status">
              <span aria-hidden="true">ⓘ</span>
              <span>已安装 {preview.alreadyInstalled}，继续安装会覆盖。</span>
            </div>
          ) : null}

          {preview.warnings.length > 0 ? (
            <ul className="install__warns">
              {preview.warnings.map((w, i) => (
                <li key={i} className="install__warnline">
                  {w}
                </li>
              ))}
            </ul>
          ) : null}

          {preview.error ? <div className="install__line install__err">{preview.error}</div> : null}
        </div>
      ) : null}

      {!input.trim() ? (
        <EmptyState
          compact
          icon="⇢"
          title="输入点什么开始"
          hint="支持 GitHub 仓库 URL、owner/repo、github:owner/repo#branch、npm 包名、包名@版本、tarball 直链、link:相对路径。"
        />
      ) : null}
    </div>
  )
}

/* ---------------------------------------------------------------- 搜索 npm */

function SearchTab({ profile, busy }: { profile: string; busy: boolean }) {
  const { state, actions } = useConsole()
  const [query, setQuery] = useState('')
  const debounced = useDebouncedValue(query.trim(), 400)

  const [hits, setHits] = useState<SearchHit[] | null>(null)
  const [loading, setLoading] = useState(false)
  const [err, setErr] = useState<string | null>(null)
  /** 正在给它挑版本的那条搜索结果（包名）；null = 面板收着 */
  const [pickFor, setPickFor] = useState<string | null>(null)

  useEffect(() => {
    if (!debounced) {
      setHits(null)
      setErr(null)
      setLoading(false)
      return
    }
    let alive = true
    setLoading(true)
    api()
      .registrySearch(debounced, 25)
      .then((r) => {
        if (!alive) return
        setHits(r)
        setErr(null)
      })
      .catch((e: unknown) => {
        if (!alive) return
        setHits(null)
        setErr(toMessage(e))
      })
      .finally(() => {
        if (alive) setLoading(false)
      })
    return () => {
      alive = false
    }
  }, [debounced])

  return (
    <div className="install__pane">
      <label className="field">
        <span className="field__label">npm 关键词</span>
        <div className="field__row">
          <input
            className="input input--lg"
            placeholder="例如 dsh / deepseek / cordis"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            spellCheck={false}
            aria-label="搜索 npm"
          />
        </div>
        <span className="field__hint">走 registrySearch(query, 25)，最多 25 条。</span>
      </label>

      {err ? <div className="banner banner--danger" role="alert">搜索失败：{err}</div> : null}

      {loading ? (
        <div className="install__hits" aria-hidden="true">
          {Array.from({ length: 5 }).map((_, i) => (
            <div className="hit" key={i}>
              <div className="hit__main">
                <span className="skeleton skeleton--line" style={{ width: `${30 + i * 6}%` }} />
                <span className="skeleton skeleton--line skeleton--sm" style={{ width: '60%' }} />
              </div>
            </div>
          ))}
        </div>
      ) : null}

      {!loading && hits && hits.length === 0 ? (
        <EmptyState
          compact
          icon="⌕"
          title={`没有搜到「${debounced}」`}
          hint="换个关键词，或直接用「智能输入」贴 GitHub 仓库地址。"
        />
      ) : null}

      {!loading && hits && hits.length > 0 ? (
        <ul className="install__hits">
          {hits.map((hit) => (
            <li className="hit" key={hit.name}>
              <div className="hit__main">
                <div className="hit__name">
                  <span className="mono truncate">{hit.name}</span>
                  <span className="badge badge--muted mono">{hit.version}</span>
                  {hit.links.repository ? <span className="badge badge--muted">repo</span> : null}
                </div>
                <div className="hit__desc clamp-2">{hit.description || '—'}</div>
                <div className="hit__meta mono">
                  {hit.publisher ? <span>by {hit.publisher}</span> : null}
                  {hit.updatedAt ? <span>更新于 {hit.updatedAt}</span> : null}
                  {typeof hit.score === 'number' ? <span>score {hit.score.toFixed(3)}</span> : null}
                </div>
              </div>
              <div className="hit__act">
                <button
                  type="button"
                  className="btn btn--sm btn--ghost"
                  disabled={busy}
                  onClick={() => setPickFor((cur) => (cur === hit.name ? null : hit.name))}
                  aria-expanded={pickFor === hit.name}
                  title={`挑 ${hit.name} 的版本 / 标签`}
                >
                  选版本
                </button>
                <button
                  type="button"
                  className="btn btn--sm btn--primary"
                  disabled={busy}
                  onClick={() =>
                    void actions.installSpec(hit.name, profile, {
                      normalized: hit.name,
                      name: hit.name,
                      version: hit.version
                    })
                  }
                  title={`pnpm add ${hit.name}`}
                >
                  安装
                </button>
              </div>
            </li>
          ))}
        </ul>
      ) : null}

      {pickFor ? (
        <div className="install__picker">
          <VersionPicker
            profile={profile}
            input={pickFor}
            current={installedVersionOf(state.plugins, profile, pickFor)}
            onPick={(option: VersionOption) => {
              const name = pickFor
              setPickFor(null)
              void actions.installSpec(option.spec, profile, {
                normalized: option.spec,
                name,
                version: option.value
              })
            }}
            onCancel={() => setPickFor(null)}
          />
        </div>
      ) : null}

      {!query.trim() ? (
        <EmptyState
          compact
          icon="⌕"
          title="输入关键词开始搜索"
          hint="只搜 npm registry。GitHub 上的仓库用「智能输入」贴 URL。"
        />
      ) : null}
    </div>
  )
}

/* ---------------------------------------------------------------- 手动 spec */

function ManualTab({ profile, busy }: { profile: string; busy: boolean }) {
  const { state, actions } = useConsole()
  const [spec, setSpec] = useState('')
  const [pickOpen, setPickOpen] = useState(false)

  const onInstall = async () => {
    const s = spec.trim()
    if (!s) return
    const res = await actions.installSpec(s, profile)
    if (res?.ok) {
      setSpec('')
      setPickOpen(false)
    }
  }

  return (
    <div className="install__pane">
      <label className="field">
        <span className="field__label">pnpm spec（原样传下去）</span>
        <div className="field__row">
          <input
            className="input input--mono input--lg"
            placeholder="link:../my-plugin  ·  file:D:/work/plugin  ·  https://…/pkg.tgz  ·  github:owner/repo#v1"
            value={spec}
            onChange={(e) => setSpec(e.target.value)}
            spellCheck={false}
            autoComplete="off"
            aria-label="pnpm spec"
          />
          <button
            type="button"
            className="btn btn--ghost"
            onClick={() => setPickOpen((v) => !v)}
            disabled={!spec.trim() || busy}
            aria-expanded={pickOpen}
            title="列出这个包的所有版本 / 标签 / 分支，选一个装"
          >
            选版本
          </button>
          <button
            type="button"
            className="btn btn--primary"
            onClick={() => void onInstall()}
            disabled={!spec.trim() || busy}
          >
            {busy ? <span className="spinner spinner--sm" /> : null}
            安装
          </button>
        </div>
        <span className="field__hint">
          跳过 installPreview，直接把字符串交给 pnpm add。左边包名认不出来就用这里。
        </span>
      </label>

      {pickOpen && spec.trim() ? (
        <div className="install__picker">
          <VersionPicker
            profile={profile}
            input={spec.trim()}
            current={null}
            onPick={(option: VersionOption) => {
              setPickOpen(false)
              void actions.installSpec(option.spec, profile, { normalized: option.spec, version: option.value })
            }}
            onCancel={() => setPickOpen(false)}
          />
        </div>
      ) : null}

      <div className="banner banner--info install__warn">
        <span aria-hidden="true">ⓘ</span>
        <span>
          当前目标 profile：<span className="mono">{profile}</span>
          {state.profiles.find((p) => p.name === profile)?.hasNodeModules === false
            ? '（未初始化，pnpm 会自动建 node_modules）'
            : ''}
        </span>
      </div>
    </div>
  )
}

/* ---------------------------------------------------------------- 导入清单 */

/** 预览里列几个包名，多的折成「…等 N 个」 */
const PRESENT_PREVIEW_MAX = 6
const MISSING_PREVIEW_MAX = 12

function ImportTab({ profile, busy }: { profile: string; busy: boolean }) {
  const { actions } = useConsole()
  const [text, setText] = useState('')
  const [fileName, setFileName] = useState<string | null>(null)
  const [preview, setPreview] = useState<ManifestPreview | null>(null)
  const [loading, setLoading] = useState(false)
  const [err, setErr] = useState<string | null>(null)
  const [readErr, setReadErr] = useState<string | null>(null)

  const debounced = useDebouncedValue(text, 500)

  // 解析只在主进程做；读文件是本地读，不走 IPC
  useEffect(() => {
    if (!debounced.trim()) {
      setPreview(null)
      setErr(null)
      setLoading(false)
      return
    }
    let alive = true
    setLoading(true)
    api()
      .importManifest(profile, debounced)
      .then((r) => {
        if (!alive) return
        setPreview(r)
        setErr(null)
      })
      .catch((e: unknown) => {
        if (!alive) return
        setPreview(null)
        setErr(toMessage(e))
      })
      .finally(() => {
        if (alive) setLoading(false)
      })
    return () => {
      alive = false
    }
  }, [debounced, profile])

  const onPickFile = async (file: File | null) => {
    if (!file) return
    setFileName(file.name)
    setReadErr(null)
    try {
      setText(await file.text())
    } catch (e: unknown) {
      setReadErr(`读不了这个文件：${toMessage(e)}`)
    }
  }

  const onClear = () => {
    setText('')
    setFileName(null)
    setPreview(null)
    setErr(null)
    setReadErr(null)
  }

  const onInstall = async () => {
    const body = text.trim()
    if (!body || !preview) return
    const res = await actions.installManifest(profile, body, preview)
    if (res?.ok) {
      setText('')
      setFileName(null)
      setPreview(null)
    }
  }

  const ok = preview?.ok === true ? preview : null
  const present = ok?.present ?? []
  const missing = ok?.missing ?? []
  const count = missing.length

  return (
    <div className="install__pane">
      <div className="field">
        <span className="field__label">清单文件</span>
        <div className="field__row">
          <label className="mfst__file" title="选择本程序导出的清单 JSON">
            <input
              type="file"
              accept=".json,application/json"
              className="mfst__file-input"
              onChange={(e) => {
                void onPickFile(e.target.files?.[0] ?? null)
                // 清掉 value，不然再选同一个文件不触发 change
                e.target.value = ''
              }}
              disabled={busy}
              aria-label="选择清单 JSON 文件"
            />
            <span className="btn btn--sm mfst__file-btn">选择 JSON 文件</span>
          </label>
          {fileName ? <span className="mfst__fname mono truncate">{fileName}</span> : null}
          {text.trim() ? (
            <button
              type="button"
              className="btn btn--sm btn--ghost"
              onClick={onClear}
              disabled={busy}
              title="清空当前清单，重新选一份"
            >
              清空
            </button>
          ) : null}
        </div>
        <span className="field__hint">
          文件只在本地读成文本，解析和安装都在主进程做。也可以用下面的框直接粘贴。
        </span>
      </div>

      <label className="field">
        <span className="field__label">清单内容</span>
        <textarea
          className="textarea input--mono mfst__text"
          rows={6}
          value={text}
          onChange={(e) => setText(e.target.value)}
          spellCheck={false}
          placeholder='{"kind":"dsh-plugin-console/manifest","version":1,…}'
          aria-label="清单 JSON 文本"
        />
      </label>

      {readErr ? (
        <div className="banner banner--danger" role="alert">
          <span aria-hidden="true">✕</span>
          <span>{readErr}</span>
        </div>
      ) : null}

      {loading ? (
        <div className="install__preview" role="status">
          <div className="install__row">
            <span className="spinner spinner--sm" />
            <span className="muted">正在解析清单…</span>
          </div>
        </div>
      ) : null}

      {!loading && err ? (
        <div className="install__preview install__preview--err" role="alert">
          <div className="install__line install__err">解析清单失败：{err}</div>
          <div className="install__line">清单应该是本程序导出的 JSON 文件。</div>
        </div>
      ) : null}

      {!loading && !err && preview && !preview.ok ? (
        <div className="install__preview install__preview--err" role="alert">
          <div className="install__line install__err">
            {preview.error ?? '这份清单读不出来。'}
          </div>
          <div className="install__line">清单应该是本程序导出的 JSON 文件。</div>
        </div>
      ) : null}

      {!loading && !err && ok ? (
        <div className="install__preview">
          <div className="install__line">
            清单里有 {ok.total} 个插件
            {ok.profile && ok.profile !== profile ? `（导出时用的是 profile「${ok.profile}」）` : ''}
          </div>

          <div className="kv">
            <span className="kv__k">已经在当前 profile</span>
            <span className="kv__v">
              {present.length} 个
              {present.length > 0
                ? ` · ${present.slice(0, PRESENT_PREVIEW_MAX).join('、')}${
                    present.length > PRESENT_PREVIEW_MAX ? '…' : ''
                  }`
                : ''}
            </span>

            <span className="kv__k">需要安装</span>
            <span className="kv__v">{count} 个</span>
          </div>

          {count > 0 ? (
            <ul className="mfst__list">
              {missing.slice(0, MISSING_PREVIEW_MAX).map((e) => (
                <li className="mfst__item" key={e.name}>
                  <span className="mono truncate mfst__item-name">{e.name}</span>
                  {e.version ? <span className="badge badge--muted mono">{e.version}</span> : null}
                  {e.inBundles ? <span className="badge badge--muted">bundles</span> : null}
                  {e.disabled ? <span className="badge badge--warn">导出时已停用</span> : null}
                </li>
              ))}
              {count > MISSING_PREVIEW_MAX ? (
                <li className="mfst__more muted">…等 {count} 个</li>
              ) : null}
            </ul>
          ) : null}

          {ok.warnings.map((w, i) => (
            <div className="banner banner--warn install__warn" key={i} role="status">
              <span aria-hidden="true">▲</span>
              <span>{w}</span>
            </div>
          ))}

          {count === 0 ? (
            <EmptyState
              compact
              icon="✓"
              title="清单里的插件都已经装过了，没有需要安装的。"
              hint="要装新东西就用「智能输入」贴仓库地址，或换个 profile 再导。"
            />
          ) : (
            <div className="install__row">
              <button
                type="button"
                className="btn btn--primary"
                onClick={() => void onInstall()}
                disabled={busy}
                title={`把缺的 ${count} 个包装进 ${profile}（会先弹确认）`}
              >
                {busy ? <span className="spinner spinner--sm" /> : null}
                安装 {count} 个
              </button>
              <span className="muted">装完自动重拉插件列表。</span>
            </div>
          )}
        </div>
      ) : null}

      {!text.trim() && !loading ? (
        <EmptyState
          compact
          icon="⇩"
          title="还没有清单"
          hint="选一份本程序导出的清单 JSON，或把清单内容粘到上面的框里；解析完先给你预览，确认后才装。"
        />
      ) : null}
    </div>
  )
}