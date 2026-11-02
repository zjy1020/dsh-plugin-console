import type { DshConsoleApi } from '../shared/ipc'

declare global {
  interface Window {
    dsh: DshConsoleApi
  }
}

export {}
