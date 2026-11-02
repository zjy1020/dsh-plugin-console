/**
 * EnvDiagnostics —— 「环境探测到底试过什么」的共用展示层 + 三道环境通道的安全取用。
 *
 * 为什么两件事挤在一个文件里：
 *
 * 1) 展示必须共用。设置面板的「环境诊断」和首屏引导卡上的失败明细说的是同一件事
 *    （按路由分组、命中用成功色、没命中用中性色）。各写一份的话，两边迟早会在
 *    「哪一条算失败、失败是谁的原因」上给出不同说法 —— 而远程排障时，用户是拿着
 *    这两处的截图跟人对账的，说法不一致就等于没有证据。
 *
 * 2) 三道通道（选文件夹 / 重新探测 / 诊断）的**主进程实现在另一条线上**，preload
 *    此刻还没有把它们挂出来。api() 只在 window.dsh 整个缺失时才抛错，单个方法
 *    不存在时它照样返回对象，所以「有没有这个方法」只能在这一层判：调用方要么拿到
 *    可调用的函数，要么拿到 null（据此把按钮禁用掉，而不是让点击炸出一句内部错误）。
 */

import { useMemo } from 'react'
import type { DshConsoleApi } from '../../../shared/ipc'
import type { DiscoveryStep, RuntimeInfo } from '../../../shared/types'
import { api } from '../api'

/* ------------------------------------------------------------------ *
 * 一、环境缺了什么 —— 只看字段，不看告警文本
 * ------------------------------------------------------------------ */

export interface EnvGap {
  /** 短标签，直接拼进标题：「DSH 环境不完整：缺 安装目录、随包 node」 */
  short: string
  /** 这一项是干什么用的、缺了会怎样，给正文用的人话 */
  hint: string
}

/**
 * 环境是否残缺到「连插件都装不了」。
 *
 * ★ 判据只看**这一对 node/pnpm 能不能真跑起来**，而主进程报上来的 `nodePath` /
 *   `pnpmPath` 已经是「DSH 随包 → 插件台自带」两级降级之后的结果（见 env.ts 的
 *   `getRunnableRuntime()`）。所以这个函数在正常安装包上恒为空数组。
 *
 * 它现在唯一会命中的场合：安装包被手工删过文件（`resources/pnpm` 或 exe 没了）。
 * 那时候该说的话不是「去装个 DSH」，而是「重装插件台」—— 因为自带那份是本程序的
 * 一部分，用户没有任何别的办法把它补回来。
 *
 * 历史教训（两次都写错过，别再来第三次）：
 *   ① 把「安装目录」算进来 → 新电脑一进界面就被红卡拦整屏，而装插件不需要它；
 *   ② 只认「DSH 随包」→ 没装桌面端的机器上永远缺 pnpm，界面却没有任何一条路能补。
 */
export function missingEnvParts(runtime: RuntimeInfo | null | undefined): EnvGap[] {
  const gaps: EnvGap[] = []
  if (!runtime?.nodePath) {
    gaps.push({
      short: 'Node 运行时',
      hint: '连插件台自带的那一份都没找到（它就在安装目录里）—— 安装包可能被删过文件，重新安装一次插件台即可。'
    })
  }
  if (!runtime?.pnpmPath) {
    gaps.push({
      short: 'pnpm',
      hint: '连插件台自带的那一份都没找到（它就在安装目录里）—— 安装包可能被删过文件，重新安装一次插件台即可。'
    })
  }
  return gaps
}

/**
 * 安装目录缺不缺 —— 单独一个判据，给「启动 / 退出 DSH」那块用。
 *
 * 与 `missingEnvParts()` 分开，是因为两者的后果完全不同：缺 node/pnpm 是装不了插件，
 * 缺安装目录只是按不了「启动 DSH」那个按钮。混在一起就会把小事升级成整屏红卡。
 */
export function missingInstallRoot(runtime: RuntimeInfo | null | undefined): boolean {
  return !runtime?.installRoot
}

/* ------------------------------------------------------------------ *
 * 二、三道通道的安全取用
 * ------------------------------------------------------------------ */

/** 把「取一个方法」包起来：拿不到、或根本摸不到 window.dsh，都回 null */
function channel<T>(pick: (d: DshConsoleApi) => T): T | null {
  try {
    const value = pick(api())
    return typeof value === 'function' ? value : null
  } catch {
    return null
  }
}

/** 弹「选择文件夹」对话框；主进程还没接好时返回 null（调用方据此禁用按钮） */
export function pickDirectoryFn(): DshConsoleApi['pickDirectory'] | null {
  return channel((d) => d.pickDirectory)
}

/** 弹「选程序文件（.exe）」对话框 —— 安装根的终极防呆入口；没接好返回 null */
export function pickDshExeFn(): DshConsoleApi['pickDshExe'] | null {
  return channel((d) => d.pickDshExe)
}

/** 清缓存 + 完整重跑一遍探测；主进程还没接好时返回 null */
export function envRedetectFn(): DshConsoleApi['envRedetect'] | null {
  return channel((d) => d.envRedetect)
}

/** 只诊断不写盘；主进程还没接好时返回 null */
export function envDiagnoseFn(): DshConsoleApi['envDiagnose'] | null {
  return channel((d) => d.envDiagnose)
}

/**
 * 随包运行时载荷的可用性查询（能不能补、从哪补、要拷多少）。
 *
 * 为什么按钮出现之前必须先问一次：新电脑上「缺 pnpm」有两种完全不同的处境 ——
 *   ① DSH 桌面端装着，只是 dsh-runtimes 还没展开 → 我们手边就有载荷，一键能补
 *   ② 压根没装桌面端（或装在别的用户下探不到）→ 我们没有任何东西可拷
 * 这两种在界面上必须是两句不同的话；先问一次才不会让用户点了「补全」才发现无米下锅。
 */
export function runtimeSourceFn(): DshConsoleApi['runtimeSource'] | null {
  return channel((d) => d.runtimeSource)
}

/** 真的把运行时拷进 <DSH_HOME>/dsh-runtimes；主进程还没接好时返回 null */
export function runtimeProvisionFn(): DshConsoleApi['runtimeProvision'] | null {
  return channel((d) => d.runtimeProvision)
}

/** 订阅补全进度；主进程还没接好时返回 null */
export function onProvisionProgressFn(): DshConsoleApi['onProvisionProgress'] | null {
  return channel((d) => d.onProvisionProgress)
}

/**
 * 选完目录之后**别急着说「找到了」**。
 *
 * 现场事故（Master 新电脑）：「我都选择了还是这样」—— 点「手动选择…」，选了一个
 * 不对的目录，界面回一句「找到了：D:\xxx」，然后什么都没有变。原因是两处调用方都
 * 写成了 `setFound(info?.installRoot ?? picked)` —— 探测没认出这个目录时退回
 * 「你选的那个」，于是**把用户的输入当成结论**。
 *
 * ★ 判据是「主进程认下的 dshHome 就是你选的那个」。
 *
 *   不能再判 nodePath / pnpmPath 非空了 —— 运行时改成两级降级（DSH 随包 → 插件台自带）
 *   之后，那两个字段在任何机器上都非空，于是「选什么都算对」，又回到把用户输入当结论。
 *   现在这条判据重新变得有区分度：只有那个目录真被主进程认成 DSH_HOME 才算通过。
 */
export function pickedIsValid(picked: string, info: RuntimeInfo | null | undefined): boolean {
  const home = info?.dshHome
  if (!home || !picked) return false
  const norm = (p: string): string => p.replace(/[\\/]+$/, '').replace(/\//g, '\\').toLowerCase()
  return norm(home) === norm(picked)
}

/** 选错了给什么话：说清「选的是哪」+「要的是哪」，并给出下一步 */
export function wrongPickMessage(picked: string, info: RuntimeInfo | null | undefined): string {
  const where = info?.dshHome
  const tail = where
    ? `探测到的是 ${where}，直接用那个就好。`
    : '那个目录下没有 dsh-runtimes（里面应该有 profiles 和 dsh-runtimes 两个文件夹）。'
  return `这个目录不像 DSH_HOME：${picked}。${tail}要选的是「包含 profiles 和 dsh-runtimes 的那一层」，默认在 C:\\Users\\<你的用户名>\\.dsh。`
}

/**
 * 「去设置里指定安装目录」这个动作要跨组件传一次「打开之后把环境分组带到眼前」的意图。
 *
 * 为什么不用 `actions.openSettings({ focus: 'env' })`：openSettings 现在被直接当
 * onClick 处理器用（App.tsx 里几处 `onClick={actions.openSettings}`），React 会把事件
 * 对象当第一个实参塞进去；给它加可选参数会一并改掉类型签名，那些既有用法会全部编译不过。
 * 所以走一条一次性自定义事件：谁需要就在 store 里发一下，设置面板收到就滚过去。
 */
export const ENV_FOCUS_EVENT = 'dsh:env-focus'

export function requestEnvFocus(): void {
  if (typeof window === 'undefined') return
  window.dispatchEvent(new Event(ENV_FOCUS_EVENT))
}

export function onEnvFocus(cb: () => void): () => void {
  if (typeof window === 'undefined') return () => {}
  window.addEventListener(ENV_FOCUS_EVENT, cb)
  return () => window.removeEventListener(ENV_FOCUS_EVENT, cb)
}

/* ------------------------------------------------------------------ *
 * 三、分组
 * ------------------------------------------------------------------ */

export interface StepGroup {
  group: string
  /** 这一组里命中的条数，标题上显示成 3/40 这种比例 */
  hit: number
  steps: DiscoveryStep[]
}

/**
 * 按 group 聚合，并保持探测顺序。
 * 用 Map + 一个 order 数组而不是对象字面量：路由的先后本身就是信息
 * （「设置」先试、「磁盘扫描」最后试），排乱了用户会以为探测没有顺序。
 */
export function groupSteps(steps: DiscoveryStep[]): StepGroup[] {
  const order: string[] = []
  const buckets = new Map<string, DiscoveryStep[]>()

  for (const step of steps) {
    const key = step.group || '其他'
    const bucket = buckets.get(key)
    if (bucket) {
      bucket.push(step)
    } else {
      buckets.set(key, [step])
      order.push(key)
    }
  }

  return order.map((group) => {
    const list = buckets.get(group) ?? []
    return { group, hit: list.filter((s) => s.ok).length, steps: list }
  })
}

/* ------------------------------------------------------------------ *
 * 四、组件
 * ------------------------------------------------------------------ */

/** 诊断区顶部那句引导语（设置面板用的原句） */
export const DIAGNOSTICS_HINT =
  '下面是我们按顺序试过的每一条。如果你知道 DSH 装在哪，直接在上面点「浏览…」选它就行，比对着这个列表猜快。'

export interface EnvDiagnosticsProps {
  steps: DiscoveryStep[]
  /** 探测过程中攒下的告警，原样列出来（它常常是「为什么没找到」的唯一线索） */
  warnings?: string[]
  loading?: boolean
  /** 诊断通道本身报的错（跟探测没关系，是「拿不到探测过程」） */
  error?: string | null
  /** 顶部引导语；引导卡里的动作按钮不叫「浏览…」，所以要能换一句 */
  hint?: string
  /** 一条都没试过时的替代文案 */
  emptyText?: string
  /** 外部布局钩子（引导卡里要更紧的间距） */
  className?: string
  title?: string
}

export function EnvDiagnostics({
  steps,
  warnings,
  loading = false,
  error = null,
  hint = DIAGNOSTICS_HINT,
  emptyText = '这次探测一条路由都没有记录 —— 通常意味着探测本身没跑起来。',
  className,
  title = '环境诊断'
}: EnvDiagnosticsProps) {
  const groups = useMemo(() => groupSteps(steps), [steps])
  const missCount = steps.filter((s) => !s.ok).length
  const warnList = warnings ?? []

  return (
    <section className={`envdiag${className ? ` ${className}` : ''}`} aria-label={title}>
      <p className="envdiag__hint">{hint}</p>

      {warnList.length > 0 ? (
        <ul className="envdiag__warns">
          {warnList.map((w, i) => (
            <li key={`${i}-${w}`}>{w}</li>
          ))}
        </ul>
      ) : null}

      {loading ? (
        <p className="envdiag__state" role="status">
          <span className="spinner spinner--sm" />
          正在把试过的路由读出来…
        </p>
      ) : null}

      {error ? (
        <p className="envdiag__state envdiag__state--bad" role="alert">
          {error}
        </p>
      ) : null}

      {!loading && steps.length === 0 ? <p className="envdiag__empty">{emptyText}</p> : null}

      {steps.length > 0 ? (
        <p className="envdiag__count mono">
          共 {steps.length} 条 · 命中 {steps.length - missCount} 条 · 没命中 {missCount} 条
        </p>
      ) : null}

      {groups.map((group) => (
        <div className="envdiag__group" key={group.group}>
          <p className="envdiag__group-title">
            <span className="envdiag__group-name">{group.group}</span>
            <span className="envdiag__group-count mono">
              {group.hit}/{group.steps.length}
            </span>
          </p>
          <ul className="envdiag__list">
            {group.steps.map((step, i) => (
              <li className={`envdiag__item${step.ok ? ' is-ok' : ''}`} key={`${step.path}-${i}`}>
                <span className="envdiag__mark" aria-hidden="true">
                  {step.ok ? '✓' : '·'}
                </span>
                <span className="envdiag__path mono selectable" title={step.path}>
                  {step.path}
                </span>
                <span className="envdiag__detail">{step.detail}</span>
              </li>
            ))}
          </ul>
        </div>
      ))}
    </section>
  )
}
