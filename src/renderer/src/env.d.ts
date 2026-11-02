/// <reference types="vite/client" />

/**
 * env.d.ts —— 渲染进程的全局类型补充。
 *
 * preload 通过 contextBridge 把 DshConsoleApi 挂到 window.dsh 上；
 * 这里显式声明（比 references preload/index.d.ts 更稳，dev/build 都不会丢）。
 */

import type { DshConsoleApi } from '../../shared/ipc'

declare global {
  interface Window {
    dsh: DshConsoleApi
  }
}

export {}
