/**
 * main.tsx —— 渲染进程入口。
 * 顺序：tokens（变量） → base（reset + 原子类） → components（区块样式） → glass（v3 玻璃层，最后加载，能覆盖旧实色）
 */

import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'

import { App } from './App'

import './styles/tokens.css'
import './styles/base.css'
import './styles/components.css'
import './styles/glass.css'

const container = document.getElementById('root')

if (!container) {
  throw new Error('#root 不存在：index.html 被改坏了。')
}

createRoot(container).render(
  <StrictMode>
    <App />
  </StrictMode>
)
