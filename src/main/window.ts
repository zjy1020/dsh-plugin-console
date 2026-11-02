import { BrowserWindow, Notification, nativeImage, shell, app } from 'electron'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { wireWindowState } from './ipc'
import { assetPath, isQuitting } from './tray'
import * as settings from './engine/settings'

export const RENDERER_URL = process.env['ELECTRON_RENDERER_URL']

/** 「程序还在托盘里」的提示只弹一次（模块级，进程内有效） */
let trayHintShown = false

/**
 * 解析窗口 / 标题栏 / 任务栏图标（返回 nativeImage）。
 *
 * 为什么优先 .ico：Windows 的任务栏按钮图标走 ICON_BIG 通道，系统只会从
 * .ico 里按尺寸挑帧（16/24/32/48/256…）；只给 PNG 时 Electron 虽然不报错，
 * 但 Windows 常常直接忽略，结果任务栏退回 electron.exe 的默认图标。
 * 所以 .ico 是主路径，PNG 只在 .ico 缺失/解析为空时兜底（macOS/Linux 够用）。
 */
function resolveWindowIcon(): Electron.NativeImage | undefined {
  for (const rel of ['icon.ico', 'icon.png']) {
    const p = assetPath(rel)
    if (!existsSync(p)) {
      console.warn('[窗口] 窗口图标文件不存在，跳过：', p)
      continue
    }
    const img = nativeImage.createFromPath(p)
    if (img.isEmpty()) {
      console.warn('[窗口] 窗口图标解析为空（文件损坏或格式不支持），跳过：', p)
      continue
    }
    console.log('[窗口] 已加载窗口图标：', p, img.getSize())
    return img
  }
  console.warn('[窗口] 找不到任何可用的窗口图标，回退 Electron 默认图标')
  return undefined
}

export function createWindow(): BrowserWindow {
  // 窗口 / 任务栏图标：跟托盘共用同一套 resources 解析（.ico 优先，见 resolveWindowIcon）
  const icon = resolveWindowIcon()

  const win = new BrowserWindow({
    width: 1320,
    height: 880,
    minWidth: 1000,
    minHeight: 660,
    show: false,
    icon,
    backgroundColor: '#0a0c11',
    autoHideMenuBar: true,
    titleBarStyle: 'hidden',
    titleBarOverlay: false,
    frame: false,
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      sandbox: false,
      contextIsolation: true,
      nodeIntegration: false,
      webSecurity: true,
      spellcheck: false
    }
  })

  /**
   * 窗口显示后再补一次 setIcon：
   * Windows 创建窗口时用 exe 的嵌入图标填任务栏按钮，构造参数里的 icon
   * 有时只作用到标题栏/Alt-Tab；等窗口真正显示出来再 setIcon 一次，
   * 任务栏那一格才会刷新成我们的 logo。
   */
  /**
   * 渲染进程被杀掉时自动重建界面。
   *
   * 现场（2026-11-02 17:10）：点「退出 DSH」之后渲染进程以 `0xC000013A`
   * （STATUS_CONTROL_C_EXIT，一个控制台控制事件的退出码）消失，主进程随后也没了 ——
   * 用户看到的就是「插件台退出了」，而日志里连一条退出轨迹都没有。
   * 只要主进程还活着，就不该让一次渲染进程死亡变成「应用消失」：
   * 这里直接 reload 一次，界面会自己回来；真要是主进程被带走，这条也帮不上。
   */
  win.webContents.on('render-process-gone', (_e, details) => {
    console.warn('[窗口] 渲染进程消失：', details)
    if (isQuitting()) return
    if (win.isDestroyed()) return
    setTimeout(() => {
      try {
        if (!win.isDestroyed()) win.webContents.reload()
      } catch (err) {
        console.warn('[窗口] 重建渲染进程失败：', err)
      }
    }, 300)
  })

  win.once('ready-to-show', () => {
    win.show()
    if (!icon) return
    try {
      win.setIcon(icon)
    } catch (err) {
      console.warn('[窗口] 显示后刷新窗口图标失败（不影响使用）：', err)
    }
  })

  /**
   * 关闭行为：
   * - frame:false，用户点的是渲染层自绘的关闭按钮（IPC windowClose → win.close()），
   *   所以这个 close 监听是唯一入口。
   * - 正在真退出（托盘「退出」/ Ctrl+Q / before-quit）→ 放行。
   * - 否则看设置 minimizeToTray：为真就拦下来收进托盘（第一次顺手提示一句）。
   *   设置里显式 false 才算关；读到 undefined（老设置文件缺字段）时按默认 true 处理。
   */
  win.on('close', (e) => {
    if (isQuitting()) return

    let minimizeToTray = true
    try {
      minimizeToTray = settings.get().minimizeToTray !== false
    } catch (err) {
      console.warn('[窗口] 读取 minimizeToTray 设置失败，按默认「收进托盘」处理：', err)
    }
    if (!minimizeToTray) return

    e.preventDefault()
    win.hide()

    if (trayHintShown) return
    trayHintShown = true
    const body = '程序还在托盘里运行，右键托盘图标可以退出。'
    console.log('[窗口]', body)
    try {
      if (Notification.isSupported()) {
        new Notification({ title: 'DSH 插件台', body }).show()
      }
    } catch (err) {
      console.warn('[窗口] 托盘提示通知不可用：', err)
    }
  })

  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//i.test(url)) shell.openExternal(url)
    return { action: 'deny' }
  })

  wireWindowState(win)

  if (RENDERER_URL) {
    win.loadURL(RENDERER_URL)
  } else {
    win.loadFile(join(__dirname, '../renderer/index.html'))
  }

  return win
}

export function installAppMenu(): void {
  // 无边框窗口靠渲染层的 titlebar 控制；这里只保留快捷键
  app.on('web-contents-created', (_e, contents) => {
    contents.on('before-input-event', (_ev, input) => {
      if (!input.control && !input.meta) return
      if (input.key === 'r' || input.key === 'R') contents.reload()
      if (input.key === 'F12') contents.toggleDevTools()
      if (input.key === 'q') app.quit()
    })
  })
}
