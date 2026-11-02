/**
 * tray.ts —— 系统托盘（主进程）。
 *
 * 职责：
 * - 建 / 销毁托盘图标与右键菜单：显示主窗口 / 启停 DSH / 真正退出。
 * - 托管 isQuitting 标志：window.ts 的 close 处理器靠它区分「真退出」与「收进托盘」。
 * - 菜单里的「运行状态 / 启动 DSH / 退出 DSH」三项永远反映 dshproc 的真实状态：
 *   状态变化靠 dshproc.watch 订阅后重建菜单，而不是等菜单弹出时再重建
 *   （Electron 的托盘菜单在弹出瞬间重建，体验很差）。
 *
 * 约定：托盘只是锦上添花 —— 本模块里所有 dshproc / Electron 调用都包了 try/catch，
 * 任何引擎异常都不允许把应用搞崩。
 */

import { app, BrowserWindow, Menu, Notification, Tray, dialog } from 'electron'
import { existsSync } from 'node:fs'
import { join } from 'node:path'

import { EV } from '../shared/ipc'
import type { DshStatus } from '../shared/types'
import * as dshproc from './engine/dshproc'
import { broadcast } from './ipc'

/* ------------------------------------------------------------------ *
 * 资源路径
 * ------------------------------------------------------------------ */

/**
 * 解析 resources/ 下资源的绝对路径。
 * - 打包后：electron-builder 的 extraResources 把 resources/ 整个拷到
 *   <process.resourcesPath>/resources/
 * - 开发时：工程根目录下的 resources/
 */
export function assetPath(rel: string): string {
  const base = app.isPackaged
    ? join(process.resourcesPath, 'resources')
    : join(app.getAppPath(), 'resources')
  return join(base, rel)
}

/* ------------------------------------------------------------------ *
 * 模块状态
 * ------------------------------------------------------------------ */

let tray: Tray | null = null
/** 托盘要操作的主窗口；窗口重建后由 createTray() 更新 */
let targetWin: BrowserWindow | null = null
/** dshproc.watch 返回的退订函数 */
let unsubscribe: (() => void) | null = null
/** 是否正在真正退出（window.ts 的 close 处理器读它） */
let quitting = false
/** 刷新序号：异步 status() 回来时若已被更新的一次刷新取代，直接丢弃结果 */
let refreshSeq = 0

/* ------------------------------------------------------------------ *
 * 小工具
 * ------------------------------------------------------------------ */

/** 拿当前可用的主窗口（缓存的窗口被销毁了就重新找） */
function liveWin(): BrowserWindow | null {
  if (targetWin && !targetWin.isDestroyed()) return targetWin
  const win = BrowserWindow.getAllWindows().find((w) => !w.isDestroyed()) ?? null
  targetWin = win
  return win
}

/** 显示并聚焦主窗口（被 hide 进托盘 / 最小化都拉得回来） */
function showMainWindow(): void {
  const win = liveWin()
  if (!win) return
  try {
    if (win.isMinimized()) win.restore()
    if (!win.isVisible()) win.show()
    win.focus()
  } catch (err) {
    console.warn('[托盘] 显示主窗口失败：', err)
  }
}

/** 系统通知：不支持 / 抛错就只留控制台一行，绝不影响功能 */
function notify(body: string): void {
  console.log('[托盘]', body)
  try {
    if (!Notification.isSupported()) return
    new Notification({ title: 'DSH 插件台', body }).show()
  } catch (err) {
    console.warn('[托盘] 系统通知不可用，已改用控制台提示：', err)
  }
}

/** 托盘里启停了 DSH，顺手把状态推给界面，省得等下一次轮询 */
function pushStatus(status: DshStatus): void {
  try {
    broadcast(EV.dshStatus, status)
  } catch (err) {
    console.warn('[托盘] 推送 DSH 状态失败：', err)
  }
}

/* ------------------------------------------------------------------ *
 * 菜单
 * ------------------------------------------------------------------ */

/** status 为 null 表示还没拿到状态（首帧），此时两个启停项都置灰 */
function buildMenu(status: DshStatus | null): Menu {
  const known = status !== null
  const running = status?.running === true
  const statusLabel = !known ? 'DSH 状态检测中…' : running ? 'DSH 运行中' : 'DSH 未运行'

  return Menu.buildFromTemplate([
    { label: '显示主窗口', click: () => showMainWindow() },
    { type: 'separator' },
    { label: statusLabel, enabled: false },
    { label: '启动 DSH', enabled: known && !running, click: () => void startDsh() },
    { label: '退出 DSH', enabled: known && running, click: () => void stopDsh() },
    { type: 'separator' },
    { label: '退出', click: () => quitForReal() }
  ])
}

/** 异步查一次状态并重建菜单；重复调用只认最后一次 */
export function refreshTrayMenu(): void {
  const seq = ++refreshSeq
  void (async () => {
    let status: DshStatus | null = null
    try {
      status = await dshproc.status()
    } catch (err) {
      console.warn('[托盘] 读取 DSH 状态失败：', err)
    }
    if (seq !== refreshSeq) return
    if (!tray || tray.isDestroyed()) return
    try {
      tray.setContextMenu(buildMenu(status))
    } catch (err) {
      console.warn('[托盘] 刷新托盘菜单失败：', err)
    }
  })()
}

/* ------------------------------------------------------------------ *
 * 菜单动作
 * ------------------------------------------------------------------ */

async function startDsh(): Promise<void> {
  let message = ''
  try {
    const result = await dshproc.start()
    message = result.message || (result.status.running ? 'DSH 已启动' : 'DSH 启动结束')
    pushStatus(result.status)
  } catch (err) {
    console.warn('[托盘] 启动 DSH 失败：', err)
    message = '启动 DSH 失败，详情见控制台'
  }
  notify(message)
  refreshTrayMenu()
}

async function stopDsh(): Promise<void> {
  const win = liveWin()
  const options: Electron.MessageBoxOptions = {
    type: 'warning',
    buttons: ['退出 DSH', '取消'],
    defaultId: 1,
    cancelId: 1,
    title: '退出 DSH？',
    message: '正在运行的 DSH 会关闭。',
    detail: '未保存的会话可能丢失。插件装完本来也要重启 DSH 才会加载。'
  }

  let confirmed = false
  try {
    const res = win ? await dialog.showMessageBox(win, options) : await dialog.showMessageBox(options)
    confirmed = res.response === 0
  } catch (err) {
    console.warn('[托盘] 退出确认弹窗失败，本次不执行：', err)
    return
  }
  if (!confirmed) return

  let message = ''
  try {
    const result = await dshproc.stop()
    message = result.message || (result.status.running ? 'DSH 仍在运行' : 'DSH 已退出')
    pushStatus(result.status)
  } catch (err) {
    console.warn('[托盘] 退出 DSH 失败：', err)
    message = '退出 DSH 失败，详情见控制台'
  }
  notify(message)
  refreshTrayMenu()
}

/* ------------------------------------------------------------------ *
 * 生命周期
 * ------------------------------------------------------------------ */

/**
 * 建托盘。可重复调用（窗口重建后拿新的 win 进来，不会重复建图标）。
 * 图标不存在 / Tray 构造失败一律只告警不抛错 —— 调用方按 hasTray() 决定退出策略。
 */
export function createTray(win: BrowserWindow): void {
  targetWin = win

  if (tray && !tray.isDestroyed()) {
    refreshTrayMenu()
    return
  }

  const iconPath = assetPath('tray.ico')
  if (!existsSync(iconPath)) {
    console.warn('[托盘] 找不到托盘图标，已跳过托盘创建：', iconPath)
    return
  }

  try {
    tray = new Tray(iconPath)
  } catch (err) {
    tray = null
    console.warn('[托盘] 创建托盘失败，已跳过（关窗口将直接退出）：', err)
    return
  }

  console.log('[托盘] 已创建系统托盘：', iconPath)

  try {
    tray.setToolTip('DSH 插件台')
  } catch (err) {
    console.warn('[托盘] 设置托盘提示文字失败：', err)
  }

  // 先挂一份「检测中」的菜单，右键点开不会是空的；随后异步换成真实状态
  try {
    tray.setContextMenu(buildMenu(null))
  } catch (err) {
    console.warn('[托盘] 初始化托盘菜单失败：', err)
  }

  // 双击：无条件唤回主窗口
  tray.on('double-click', () => showMainWindow())

  // 单击：只在窗口不可见（收进托盘 / 最小化）时才唤回，免得随手一点就弹窗
  tray.on('click', () => {
    const w = liveWin()
    if (!w) return
    if (w.isVisible() && !w.isMinimized()) return
    showMainWindow()
  })

  // 状态变化 → 重建菜单（菜单弹出时不重建）
  try {
    const off = dshproc.watch(() => refreshTrayMenu(), 4000)
    unsubscribe = typeof off === 'function' ? off : null
  } catch (err) {
    console.warn('[托盘] 订阅 DSH 状态失败，菜单只在操作后刷新：', err)
  }

  refreshTrayMenu()
}

/** 销毁托盘与订阅；幂等，重复调用安全 */
export function destroyTray(): void {
  if (unsubscribe) {
    try {
      unsubscribe()
    } catch (err) {
      console.warn('[托盘] 退订 DSH 状态失败：', err)
    }
    unsubscribe = null
  }

  if (tray) {
    try {
      if (!tray.isDestroyed()) tray.destroy()
    } catch (err) {
      console.warn('[托盘] 销毁托盘失败：', err)
    }
    tray = null
  }

  targetWin = null
}

/** 托盘是否还活着（window-all-closed 用它决定要不要退出应用） */
export function hasTray(): boolean {
  return tray !== null && !tray.isDestroyed()
}

/** 置「正在真退出」标志 */
export function setQuitting(v: boolean): void {
  quitting = v === true
}

/** 读「正在真退出」标志 */
export function isQuitting(): boolean {
  return quitting
}

/** 真正退出应用：先置标志，再 app.quit() */
export function quitForReal(): void {
  quitting = true
  app.quit()
}
