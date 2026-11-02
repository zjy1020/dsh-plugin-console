import { BrowserWindow, ipcMain, shell, dialog } from 'electron'
import { existsSync, statSync } from 'node:fs'
import { dirname } from 'node:path'
import { CH, EV } from '../shared/ipc'
import type {
  AppSettings,
  DshStatus,
  OpLogLine,
  OpRequest,
  ProvisionProgress,
  RuntimeInfo,
  RuntimePayloadPart,
  UpdateCheckProgress,
  WindowState
} from '../shared/types'

import * as env from './engine/env'
import * as inventory from './engine/inventory'
import * as updates from './engine/updates'
import * as spec from './engine/spec'
import * as ops from './engine/ops'
import * as net from './engine/net'
import * as settingsStore from './engine/settings'
import * as dsh from './engine/dsh'
import * as icon from './engine/icon'
import * as versions from './engine/versions'
import * as proxy from './engine/proxy'
import * as dshproc from './engine/dshproc'
import * as manifest from './engine/manifest'
import * as market from './engine/market'
import { diag } from './diagnostics'
import * as gallery from './engine/gallery'
import * as wallpaper from './engine/wallpaper'
import * as themes from './engine/themes'
import * as dshpm from './engine/dshpm'
import * as provision from './engine/provision'

let opSeq = 0

export function broadcast(channel: string, payload: unknown): void {
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.isDestroyed()) win.webContents.send(channel, payload)
  }
}

/**
 * 环境变好了 → 主动告诉界面。
 *
 * 这个函数存在的原因是一整条「静默失败」：新电脑上同步路由一条都不中，界面弹出引导卡；
 * 主进程随后异步跑注册表 / 进程 / 快捷方式 / 磁盘扫描，**命中了**，写进缓存，
 * 然后什么也不发生 —— 界面还停在「找不到 DSH」，用户以为这软件没救。
 * 明明两秒后就已经知道 DSH 在哪了，却要用户自己点「自动检测一遍」才看得到。
 *
 * 只在「这次真的比上次更好」时推（node/pnpm 从无到有，或安装根从无到有），
 * 否则启动时那一串探测会把同一个状态推好几遍，界面白重渲染。
 *
 * ★ 判据不能是「installRoot 非空就推、空就 return」。
 *   装插件只需要 node/pnpm，安装根只喂「启动 / 退出 DSH」—— 一台机器可能
 *   永远探不到安装根（绿色版 / 装在别的用户目录下），但 node/pnpm 是齐的。
 *   按旧判据那种机器一次都不会推，界面永远停在「找不到」。
 *   现在两种「变好」都推，去重交给下面记的上一版快照。
 */
let lastPushedEnv: { node: string | null; pnpm: string | null; root: string | null } | null = null

async function pushEnvChanged(reason: string): Promise<void> {
  try {
    const info: RuntimeInfo = await env.getRuntimeInfo()
    const next = {
      node: info.nodePath ?? null,
      pnpm: info.pnpmPath ?? null,
      root: info.installRoot ?? null
    }
    /* 什么都没变就不推：这条事件会让渲染层重拉一遍插件列表，
     * 启动时那几轮补探如果每轮都推，观感就是界面一直在闪。 */
    if (
      lastPushedEnv &&
      lastPushedEnv.node === next.node &&
      lastPushedEnv.pnpm === next.pnpm &&
      lastPushedEnv.root === next.root
    ) {
      return
    }
    /* 三样全空才是真的什么都没探到 —— 那种情况推过去只会让界面重渲染，
     * 用户看到的还是同一张引导卡。 */
    if (!next.node && !next.pnpm && !next.root) return
    lastPushedEnv = next
    diag(
      'env-push',
      `${reason}：installRoot=${next.root ?? '(未找到)'}（${info.installRootFrom ?? '?'}）；node=${next.node ?? '(未找到)'}；pnpm=${next.pnpm ?? '(未找到)'}`
    )
    broadcast(EV.envChanged, info)
  } catch (err) {
    diag('env-push', `${reason} 推送失败：${err instanceof Error ? err.message : String(err)}`)
  }
}

function stateOf(win: BrowserWindow): WindowState {
  return {
    maximized: win.isMaximized(),
    fullscreen: win.isFullScreen(),
    focused: win.isFocused()
  }
}

export function registerIpc(): void {
  /* ---------------- 环境 / 清单 ---------------- */

  ipcMain.handle(CH.runtimeInfo, async () => env.getRuntimeInfo())

  /**
   * 重新探测：带 async 深挖（注册表 / 运行中的进程 / WScript）重跑一遍，返回完整 RuntimeInfo。
   * 用户手动指定目录、或者「先开插件台后装 DSH」之后点「重新检测」都走这里。
   */
  ipcMain.handle(CH.envRedetect, async () => env.getRuntimeInfo({ deep: true }))

  /** 只读诊断：每条路由试了什么、成没成 —— 探测失败时让用户截一张图就能说清现场 */
  ipcMain.handle(CH.envDiagnose, async () => env.getDiscoverySteps())

  /**
   * 系统原生的「选择文件夹」。
   *
   * 为什么必须有：自动探测再全也覆盖不到「用户把整个目录拷到别的盘、还改了名」这种情况，
   * 而让用户手打路径是这道题里最差的一种交互。取消 → null，渲染层据此不作任何改动。
   */
  ipcMain.handle(CH.pickDirectory, async (e, title: string, defaultPath?: string) => {
    const opts: Electron.OpenDialogOptions = {
      properties: ['openDirectory'],
      title: typeof title === 'string' && title.trim() !== '' ? title : '选择文件夹'
    }
    if (typeof defaultPath === 'string' && defaultPath.trim() !== '') opts.defaultPath = defaultPath
    const win = BrowserWindow.fromWebContents(e.sender)
    const res = win ? await dialog.showOpenDialog(win, opts) : await dialog.showOpenDialog(opts)
    if (res.canceled || res.filePaths.length === 0) return null
    return res.filePaths[0] ?? null
  })

  /**
   * 「选程序文件」—— 安装根这条路的终极防呆版（只认 .exe）。
   *
   * 为什么光有 pickDirectory 不够：让用户「选一个里面应该有 resources 和 exe 的目录」
   * 是在要求用户理解插件台的内部结构；用户永远知道的是「程序本身在哪」。
   * 选到 exe 的那一刻，dirname 就一定是安装根 —— 没有「选错一层」的可能，
   * 也不依赖目录结构标准（绿色版 / 整目录拷贝都行，exe 在就能启动）。
   */
  ipcMain.handle(CH.pickDshExe, async (e) => {
    const opts: Electron.OpenDialogOptions = {
      properties: ['openFile'],
      title: '选择 DeepSeek Harness 的程序文件（DeepSeek Harness.exe）',
      filters: [{ name: '程序', extensions: ['exe'] }]
    }
    const win = BrowserWindow.fromWebContents(e.sender)
    const res = win ? await dialog.showOpenDialog(win, opts) : await dialog.showOpenDialog(opts)
    const exe = res.canceled ? null : res.filePaths[0] ?? null
    if (!exe) return null
    return { exe, dir: dirname(exe) }
  })

  /**
   * 随包运行时载荷：能不能补、从哪补、要拷多少。
   *
   * 为什么要有这个查询而不直接让界面点「补全」：新电脑上「缺 pnpm」有两种完全不同的处境 ——
   *   ① DSH 桌面端装着，只是 dsh-runtimes 还没展开 → 我们手边有载荷，一键就能补
   *   ② 压根没装桌面端（或装在别的用户下探不到）→ 我们没有任何东西可拷，只能让用户指路
   * 这两种在界面上必须是两句话，所以按钮出现之前先问一次。
   */
  ipcMain.handle(CH.runtimeSource, async () => provision.inspectRuntimeSource({ deep: true }))

  /**
   * 真的把运行时拷进 <DSH_HOME>/dsh-runtimes。
   *
   * 进度走 EV.provisionProgress 广播（拷 111 MB / 六千多个文件，实测十几秒 ——
   * 没有进度的按钮和卡死没有区别）。结束之后再推一次 envChanged，
   * 界面据此自己从「装不了插件」变成可用，不需要用户重启或手点重检测。
   */
  ipcMain.handle(CH.runtimeProvision, async (_e, parts?: RuntimePayloadPart[]) => {
    const result = await provision.provisionRuntime({
      parts,
      onProgress: (p: ProvisionProgress) => broadcast(EV.provisionProgress, p)
    })
    diag('provision', `结束：ok=${result.ok} copied=${result.copied} ${result.ms}ms ${result.message}`)
    if (result.ok) {
      await pushEnvChanged('补全运行时之后')
      broadcast(EV.provisionProgress, {
        phase: 'done',
        copiedBytes: result.bytes,
        totalBytes: result.bytes,
        copiedFiles: result.files,
        totalFiles: result.files,
        current: null,
        message: result.message
      } satisfies ProvisionProgress)
    }
    return result
  })

  ipcMain.handle(CH.profiles, async () => inventory.listProfiles())


  ipcMain.handle(CH.plugins, async (_e, profile: string, opts?: { deep?: boolean }) =>
    inventory.listPlugins(profile, opts)
  )

  /* ---------------- 更新检查 ---------------- */

  ipcMain.handle(CH.checkUpdates, async (_e, profile: string, names?: string[]) =>
    updates.checkUpdates(profile, names, (p: UpdateCheckProgress) => broadcast(EV.updateProgress, p))
  )

  ipcMain.handle(CH.registryLookup, async (_e, _profile: string, name: string) =>
    net.registryPackument(name)
  )

  ipcMain.handle(CH.registrySearch, async (_e, query: string, limit?: number) =>
    net.npmSearch(query, limit ?? 25)
  )

  /* ---------------- 来源解析 ---------------- */

  ipcMain.handle(CH.parseSpec, async (_e, input: string) => spec.parseSpec(input))

  ipcMain.handle(CH.installPreview, async (_e, profile: string, input: string) =>
    ops.installPreview(profile, input)
  )

  /* ---------------- 操作 ---------------- */

  ipcMain.handle(CH.runOp, async (_e, req: OpRequest) => {
    const opId = `op-${Date.now()}-${++opSeq}`
    const hooks = {
      opId,
      onLog: (line: OpLogLine) => broadcast(EV.opLog, line)
    }
    const result = await ops.runOp(req, hooks)
    broadcast(EV.opDone, result)
    return result
  })

  ipcMain.handle(CH.cancelOp, async (_e, opId: string) => ops.cancelOp(opId))

  /* ---------------- 杂项 ---------------- */

  ipcMain.handle(CH.revealPath, async (_e, target: string) => {
    if (!target) return false
    try {
      if (existsSync(target) && statSync(target).isFile()) {
        shell.showItemInFolder(target)
      } else if (existsSync(target)) {
        await shell.openPath(target)
      } else {
        return false
      }
      return true
    } catch {
      return false
    }
  })

  ipcMain.handle(CH.openExternal, async (_e, url: string) => {
    if (!/^https?:\/\//i.test(url)) return false
    await shell.openExternal(url)
    return true
  })

  ipcMain.handle(CH.restartDsh, async () => dsh.restartDsh())

  ipcMain.handle(CH.settingsGet, async () => settingsStore.get())

  ipcMain.handle(CH.settingsSet, async (_e, patch: Partial<AppSettings>) => {
    /*
     * 记一笔「谁在什么时候改了哪些键」。
     * 用途不是审计，是排障：用户反馈过「点保存应用就退出了」，而我们当时的现场
     * 什么都没有（没有崩溃转储、没有异常、没有退出轨迹）。写这一行之后，
     * 下次再出现就能立刻分清「保存本身有问题」还是「应用是被别的动作带走的」——
     * 顺序是：最后一次保存的键 → 然后没有任何后续日志 = 被杀在这一步之后。
     */
    diag('settings-set', `keys=${Object.keys(patch ?? {}).join(',') || '(空)'}`)
    const next = settingsStore.set(patch)
    // 设置面板里「选壁纸」走的是这条通用通道（先留在草稿里，点保存才落盘），
    // 不是 wallpaperSet。所以「跟随壁纸自动调整」开着的时候，这里也得补一次自动适配 ——
    // 否则「点缩略图直接换」和「选完点保存」两条路得到的材质参数会不一样。
    // 判断用 patch.wallpaper !== undefined：undefined 表示这次保存根本没碰壁纸，
    // 不该因为顺手改了个别的设置就重算一遍材质。
    if (patch.wallpaper !== undefined && next.wallpaper && next.wallpaperAuto) {
      try {
        wallpaper.applyAutoFit(next.wallpaper.id)
      } catch {
        // 适配失败不该让「保存设置」失败 —— 壁纸已经写进去了，参数保持原样即可
      }
    }
    env.invalidate()
    /*
     * 官方通道的路径缓存也要一起作废。
     * 原来它只在进程启动时算一次（且连「算不出来」这个结果也一起记死），于是：
     * 新电脑启动时安装根还没探到 → 官方通道判定为不可用并记死 → 用户在引导卡里手动
     * 选对了目录、界面也显示好了 → 但本进程内装插件仍然走退化路径，必须重启才生效。
     * 缓存本身也已经改成按安装根键控，这里再显式清一次，覆盖「安装根没变但官方包被动过」。
     */
    dshpm.invalidateOfficialPaths()
    /*
     * ★ 用户手填的安装根如果是对的，还得顺手把 node / pnpm 一起重探出来。
     *
     * 为什么非补这一步不可：node 的查找路径里有一段是「<安装根>/resources/... 下找
     * dsh-runtimes」，而这段只在安装根已知时才可能命中。启动那一刻安装根还是空的，
     * 所以 nodePath 探成 null 并被缓存；用户随后在引导卡里选对目录，invalidate() 只是
     * 把缓存清掉，**没有任何东西会再去探一次** —— 要等到下一次 getRuntimeInfo 被调用。
     * 结果就是：界面从「缺安装目录」变成「缺随包 node」，用户以为还差一步，
     * 再选一次目录也还是同一句。现场表现正是「我都选择了还是这样」。
     *
     * 这里只做「清缓存 + 同步重探」，不落盘、不改 settings —— 写盘是渲染层的决定。
     * 放 setImmediate 里是因为 set 本身要同步返回给 IPC；重探会 stat 几十个路径，
     * 不该挡在返回路径上。
     */
    if (patch.installRoot !== undefined || patch.dshHome !== undefined) {
      setImmediate(() => {
        void (async () => {
          try {
            env.invalidate()
            const info = await env.getRuntimeInfo()
            diag(
              'settings-set',
              `环境重探：installRoot=${info.installRoot ?? 'null'}（${info.installRootFrom ?? '?'}）node=${info.nodePath ? 'ok' : 'null'} pnpm=${info.pnpmPath ? 'ok' : 'null'}`
            )
            /* 用户改完路径、环境真的好起来了 → 推给界面。
             * 少了这一条，用户在设置里选对目录、点保存，界面上的引导卡还在原地说
             * 「缺安装目录」，他只能再点一次「自动检测一遍」才看得到效果 ——
             * 现场反馈「我都选择了还是这样」有一半是这么来的。
             * 走 pushEnvChanged 而不是直接 broadcast：它会比快照去重，
             * 用户点保存但什么都没变时不该白推一次。 */
            await pushEnvChanged('设置里改了路径')
          } catch (err) {
            diag('settings-set', `环境重探失败：${err instanceof Error ? err.message : String(err)}`)
          }
        })()
      })
    }
    // 回读一次：applyAutoFit 会再写一遍设置，直接返回 next 会漏掉它算出来的值
    return settingsStore.get()
  })

  ipcMain.handle(CH.probeDir, async (_e, dir: string) => {
    try {
      const exists = existsSync(dir)
      const isDir = exists ? statSync(dir).isDirectory() : false
      return { ok: exists && isDir, exists, isDir, note: exists ? (isDir ? '目录存在' : '这是一个文件，不是目录') : '路径不存在' }
    } catch (err) {
      return { ok: false, exists: false, isDir: false, note: String(err) }
    }
  })

  /* ---------------- 版本列表 ---------------- */

  ipcMain.handle(
    CH.versions,
    async (_e, input: string, opts?: { profile?: string; current?: string | null }) =>
      versions.listVersions(input, opts ?? {})
  )

  /* ---------------- 插件图标 ---------------- */

  ipcMain.handle(CH.pluginIcon, async (_e, profile: string, name: string) =>
    icon.pluginIcon(profile, name)
  )

  /* ---------------- 插件市场（dshmarket 目录） ---------------- */

  ipcMain.handle(CH.marketList, async (_e, opts?: { force?: boolean }) => market.marketList(opts))

  /* ---------------- 插件图集（README 截图） ---------------- */

  ipcMain.handle(CH.pluginGallery, async (_e, profile: string, name: string) =>
    gallery.pluginGallery(profile, name)
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

  /* ---------------- 壁纸 ---------------- */
  // 说明：壁纸相关全部要弹系统对话框，所以都得拿到发起请求的那个窗口 ——
  // 拿不到窗口时降级成「无父窗口的对话框」，而不是直接失败。

  ipcMain.handle(CH.wallpaperImport, async (e) =>
    wallpaper.importViaDialog(BrowserWindow.fromWebContents(e.sender))
  )

  ipcMain.handle(CH.wallpaperFromPath, async (_e, filePath: string) =>
    wallpaper.importFromPath(filePath)
  )

  ipcMain.handle(CH.wallpaperList, async () => wallpaper.list())

  ipcMain.handle(CH.wallpaperSet, async (_e, id: string | null) => {
    const ref = id ? wallpaper.getRef(id) : null
    // id 给了但找不到（比如文件被删）→ 只清掉当前选择，不动 wallpaperAuto，
    // 用户的「导入后自动适配」偏好不该因为删了一张图被重置
    const next = settingsStore.set({ wallpaper: ref })
    // 「跟随壁纸自动调整」开着的时候，换壁纸顺带把材质参数一起调好。
    // 这一步必须放在 set 之后：applyAutoFit 要读 settings.wallpaper 才知道算的是哪张图。
    if (ref && next.wallpaperAuto) {
      try {
        wallpaper.applyAutoFit(ref.id)
        return settingsStore.get()
      } catch {
        // 适配失败不该让「换壁纸」这个动作失败 —— 壁纸已经换上了，参数保持原样
        return next
      }
    }
    return next
  })

  ipcMain.handle(CH.wallpaperRemove, async (_e, id: string) => {
    const wasActive = settingsStore.get().wallpaper?.id === id
    const ok = wallpaper.remove(id)
    if (ok && wasActive) settingsStore.set({ wallpaper: null })
    return ok
  })

  ipcMain.handle(CH.wallpaperPin, async (_e, id: string, pinned: boolean) =>
    wallpaper.pin(id, pinned)
  )

  ipcMain.handle(CH.wallpaperAutoFit, async (_e, id?: string | null, apply?: boolean) => {
    const target = id ?? settingsStore.get().wallpaper?.id ?? null
    if (!target) {
      // 没有壁纸可分析：直接给一套中性值，不抛异常（UI 侧按「没壁纸」文案处理）
      return wallpaper.autoFit(null)
    }
    // apply=true 时把算出来的值真写回设置（手动点「自动适配」按钮就走这条）；
    // 只算不写的时候 UI 拿 reasons 解释它为什么这么调。
    return apply ? wallpaper.applyAutoFit(target) : wallpaper.autoFit(target)
  })

  /* ---------------- 主题 ---------------- */

  ipcMain.handle(CH.themesList, async () => themes.list())

  ipcMain.handle(CH.themeApply, async (_e, id: string) => themes.apply(id))

  ipcMain.handle(CH.themeSave, async (_e, spec: Parameters<typeof themes.save>[0]) =>
    themes.save(spec)
  )

  ipcMain.handle(CH.themeDelete, async (_e, id: string) => themes.remove(id))

  ipcMain.handle(CH.themeExport, async (e, id: string) =>
    themes.exportTheme(BrowserWindow.fromWebContents(e.sender), id)
  )

  ipcMain.handle(CH.themeImport, async (_e, text: string) => themes.importTheme(text))

  /**
   * 外观一键还原。
   * 只还原外观字段（见 settings.resetAppearance 的清单），不碰代理 / 并发 / 安装目录 /
   * 托盘这些会改变安装行为或需要重启的东西；壁纸文件保留，只是取消选中。
   */
  ipcMain.handle(CH.appearanceReset, async () => {
    const next = settingsStore.resetAppearance()
    env.invalidate()
    return next
  })

  /* ---------------- 窗口控制 ---------------- */

  const withWin = <T>(e: Electron.IpcMainInvokeEvent, fn: (w: BrowserWindow) => T): T | null => {
    const win = BrowserWindow.fromWebContents(e.sender)
    if (!win) return null
    return fn(win)
  }

  ipcMain.handle(CH.windowMinimize, async (e) => {
    withWin(e, (w) => w.minimize())
  })

  ipcMain.handle(CH.windowToggleMaximize, async (e) => {
    return withWin(e, (w) => {
      if (w.isMaximized()) w.unmaximize()
      else w.maximize()
      return w.isMaximized()
    })
  })

  ipcMain.handle(CH.windowClose, async (e) => {
    withWin(e, (w) => w.close())
  })

  ipcMain.handle(CH.windowState, async (e) => withWin(e, stateOf) ?? { maximized: false, fullscreen: false, focused: true })

  /* ---------------- 启动后的异步补刀 ---------------- */

  /*
   * 为什么要在注册完 handler 之后补这一刀：同步路由全靠「猜名字」（设置 / 环境变量 /
   * 提示文件 / 几个常见目录名），而新电脑上真正可靠的两个来源 —— 注册表里的卸载项、
   * 正在运行的进程 —— 都必须起子进程，几百毫秒起步，塞进同步的 getRuntimeInfo 会把首屏拖慢。
   * 所以顺序是：同步的先保证应用能起来（大部分机器这就够了），异步的随后补一刀；
   * 补到了就落盘，下次开箱即用。
   *
   * 只在 settings.installRoot 原本为空时才写 —— 用户手填的值永远优先，自动探测不许覆盖它。
   *
   * ★ 命中之后必须 pushEnvChanged：光写缓存等于没找到。
   *   新电脑上用户看到的是引导卡「找不到 DSH」，而两秒后我们其实已经知道在哪了。
   *   没有这条推送，界面就一直停在「找不到」，只能靠用户手点「自动检测一遍」——
   *   而用户根本不知道该点。这是「新环境下不能自动匹配」的最后一环。
   */
  void (async () => {
    try {
      /* 同步路由已经拿到根，也不代表就没事了：node / pnpm 可能因为安装根当时还没
       * 定下来而探成 null（node 的查找路径里有一段依赖安装根）。这时仍然要跑一次
       * enrich + 推送，让界面从「缺随包 node」自己好起来。 */
      const { root, from } = await env.enrichInstallRoot()
      if (root) {
        if (!settingsStore.get().installRoot) settingsStore.set({ installRoot: root })
        env.invalidate()
        diag('env-enrich', `异步探测命中安装根（来源：${from ?? '未知'}）：${root}`)
      }
      /* 无条件推一次，让去重逻辑决定要不要真发：什么都不缺的机器会被快照挡掉，
       * 缺任何一样的机器才需要这一次更新。 */
      await pushEnvChanged('异步探测完成')
    } catch (err) {
      diag('env-enrich', `异步探测安装根失败：${err instanceof Error ? err.message : String(err)}`)
    }
  })()

  /*
   * ★ 没找到就再试几轮 —— 一次不成就永远放弃，是「新环境装不了」的另一半。
   *
   * 现实里的两种时序，启动那一刻都还没就绪：
   *   1) 用户先开插件台、再开 DSH —— DSH 启动时才在 DSH_HOME 下展开 dsh-runtimes，
   *      安装根也可能是那一刻才写进注册表/进程表；
   *   2) 用户刚装完 DSH，安装程序还没把注册表项写完。
   * 这两种情况下，第 0 秒探一次没中就放弃，界面会一直停在「找不到」，
   * 而其实十几秒后环境就齐了。
   *
   * 节奏取 4s / 10s / 25s / 60s：前两次覆盖「DSH 正在启动」，后两次覆盖
   * 「用户刚装完、手还没离开键盘」。四次之后就不再打扰 —— 再往后要么是真没装，
   * 要么是装在非常规位置，那时候该由用户点「手动选择安装目录…」，
   * 而不是让程序每 10 秒起一次 PowerShell 去扫盘。
   */
  const RETRY_DELAYS = [4_000, 10_000, 25_000, 60_000]
  /* 「还缺东西吗」要分两问：装插件看 node/pnpm，启动 DSH 看安装根。
   * 只用 checkRuntime() 会让「node/pnpm 齐、安装根没探到」的机器第一轮就退出，
   * 于是「启动 DSH」永远灰着 —— 那台机器其实只要再扫一次就能找到。 */
  const stillMissing = (): boolean => !env.checkRuntime().ok || !env.getInstallRoot()
  void (async () => {
    for (let i = 0; i < RETRY_DELAYS.length; i += 1) {
      if (!stillMissing()) return
      await new Promise((resolve) => setTimeout(resolve, RETRY_DELAYS[i]))
      /* 等待期间用户可能自己选好了目录，也可能上一轮已经探到了 */
      if (!stillMissing()) return
      try {
        env.invalidate()
        const { root } = await env.enrichInstallRoot()
        if (root && !settingsStore.get().installRoot) settingsStore.set({ installRoot: root })
        env.invalidate()
        if (root) {
          diag('env-retry', `第 ${i + 1} 轮补探命中：${root}`)
        } else {
          diag('env-retry', `第 ${i + 1} 轮补探仍未命中`)
        }
        /* 不管这轮有没有命中安装根，都要推一次：node/pnpm 可能在别的时机才齐
         * （DSH 启动时才展开 dsh-runtimes），那也是一种「变好了」。
         * 重复状态由 pushEnvChanged 里的快照去重挡掉。 */
        await pushEnvChanged(`第 ${i + 1} 轮补探`)
      } catch (err) {
        diag('env-retry', `第 ${i + 1} 轮补探异常：${err instanceof Error ? err.message : String(err)}`)
      }
    }
  })()
}

/** 窗口状态变化 → 通知渲染进程（titlebar 用） */
export function wireWindowState(win: BrowserWindow): void {
  const push = (): void => {
    if (!win.isDestroyed()) win.webContents.send(EV.windowState, stateOf(win))
  }
  // Electron 的 on/once 是逐字面量重载，联合类型事件名过不去，这里显式收窄一次。
  const onState = win.on.bind(win) as (event: string, listener: () => void) => BrowserWindow
  for (const evt of ['maximize', 'unmaximize', 'enter-full-screen', 'leave-full-screen', 'focus', 'blur']) {
    onState(evt, push)
  }
  win.webContents.on('did-finish-load', push)
}

export { dialog }
