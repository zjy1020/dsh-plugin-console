import { app, BrowserWindow } from 'electron'
import { createWindow, installAppMenu } from './window'
import { registerIpc } from './ipc'
import { createTray, destroyTray, hasTray, setQuitting } from './tray'
import { installWallpaperProtocol, registerWallpaperScheme } from './wallpaperProtocol'
import { syncActiveTheme } from './engine/themes'
import { installDiagnostics } from './diagnostics'

/**
 * 诊断日志要最早装：它要记的第一件事就是「本进程是谁的子进程」——
 * 这决定了别人 taskkill /T 的时候会不会顺手把插件台一起带走。
 * 放在 app.setName 之后、任何窗口创建之前。
 */
installDiagnostics()

/**
 * 应用名与 AppUserModelID：必须在任何 BrowserWindow 创建之前设好。
 * Windows 靠 AppUserModelID 给任务栏按钮分组、并从 exe 读取图标与跳转列表；
 * 窗口一旦创建再改这个 ID，任务栏分组的图标不会跟着刷新，只能重启进程才生效。
 * 所以放在模块顶层（app.whenReady() 之前执行），不要挪进 whenReady 回调里。
 */
app.setName('DSH 插件台')
if (process.platform === 'win32') app.setAppUserModelId('com.yg.dsh-plugin-console')

/**
 * 壁纸协议必须在 app ready **之前**声明权限（标准协议 + 安全上下文 + 可流式读），
 * ready 之后再调就已经晚了 —— Chromium 只在协议注册表初始化时读这一份声明。
 */
registerWallpaperScheme()

/** 建窗口 + 建托盘（窗口重建时这里也会把托盘指到新窗口） */
function ensureWindow(): BrowserWindow {
  const win = createWindow()
  createTray(win)
  return win
}

/** 把窗口从「最小化 / 收进托盘」拉回前台 */
function revealWindow(): void {
  const win = BrowserWindow.getAllWindows().find((w) => !w.isDestroyed())
  if (!win) return
  if (win.isMinimized()) win.restore()
  if (!win.isVisible()) win.show()
  win.focus()
}

// 只允许一个实例
const gotLock = app.requestSingleInstanceLock()
if (!gotLock) {
  app.quit()
} else {
  app.on('second-instance', () => {
    // 窗口可能已经被收进托盘（hide），这里要能重新显示出来
    revealWindow()
  })

  app.whenReady().then(() => {
    // 先把「当前主题」的强调色/环境色补进设置，再建窗口 —— 否则第一帧会闪一下默认蓝
    try {
      syncActiveTheme()
    } catch (err) {
      // 主题文件坏了不该让应用起不来，落回默认观感即可
      console.warn('[主题] 启动时同步当前主题失败：', err)
    }
    registerIpc()
    installWallpaperProtocol()
    installAppMenu()
    ensureWindow()

    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) {
        ensureWindow()
        return
      }
      revealWindow()
    })
  })

  // 真正退出：先置标志，window.ts 的 close 处理器才会放行
  app.on('before-quit', () => setQuitting(true))

  app.on('will-quit', () => destroyTray())

  app.on('window-all-closed', () => {
    // 托盘还活着说明用户可能只是把窗口收进去了，此时不能退出
    if (hasTray()) return
    app.quit()
  })
}
