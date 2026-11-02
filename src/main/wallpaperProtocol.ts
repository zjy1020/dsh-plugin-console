/**
 * wallpaperProtocol.ts —— 用自定义协议把壁纸图片喂给渲染进程。
 *
 * 为什么不用 `file://`：
 * 1. dev 下渲染页是 `http://localhost`，`file://` 图片会被直接拦掉；
 * 2. 打包后是 `file://` 页面，但 CSP 里 `'self'` 对任意目录的 `file://` 也没有可靠语义；
 * 3. 壁纸可能几十兆，走 IPC 转 data URL 会把内存和消息体都撑爆。
 *
 * 因此注册一个 `dshwp://` 协议：主进程按 http 语义直接返回文件字节，
 * 渲染层 `<img src="dshwp://current">` 就能用，浏览器负责流式解码与缓存。
 *
 * 渲染层**不需要知道壁纸的文件名**（扩展名在主进程那边才知道），所以协议只暴露三个入口：
 *   dshwp://current        —— 当前激活的壁纸原图
 *   dshwp://thumb/<id>     —— 某张壁纸的缩略图（没有就回退原图）
 *   dshwp://files/<rel>    —— 壁纸目录内的相对路径（给设置中心里的壁纸库用）
 *
 * 安全边界（重要）：只允许读**壁纸目录内**的文件。所有路径都先 resolve 再校验前缀，
 * 越界一律 404 —— 这个协议挂在渲染进程上，必须当成不可信输入处理。
 */

import { protocol, net } from 'electron'
import { existsSync, realpathSync } from 'node:fs'
import { isAbsolute, join, relative, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

import * as settings from './engine/settings'
import * as wallpaper from './engine/wallpaper'

export const WALLPAPER_SCHEME = 'dshwp'

/** 必须在 app ready 之前调用：声明这个 scheme 是「像 http 一样」的协议 */
export function registerWallpaperScheme(): void {
  protocol.registerSchemesAsPrivileged([
    {
      scheme: WALLPAPER_SCHEME,
      privileges: {
        standard: true,
        secure: true,
        supportFetchAPI: true,
        stream: true,
        bypassCSP: false
      }
    }
  ])
}

const MIME: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
  '.bmp': 'image/bmp',
  '.avif': 'image/avif'
}

/**
 * 把真实文件路径落成一条响应。
 * 双层校验：先比 resolve 后的前缀，再比 realpathSync 后的前缀（防 symlink 逃逸）。
 */
async function respondWithFile(file: string | null): Promise<Response> {
  if (!file || !existsSync(file)) {
    //「越界」与「不存在」都返 404：不区分二者，避免把这个协议当成目录探测面
    return new Response('not found', { status: 404 })
  }

  const root = wallpaper.getWallpaperDir()
  const inRoot = (p: string): boolean => {
    const r = relative(root, p)
    return r !== '' && !r.startsWith('..') && !isAbsolute(r)
  }

  let real = file
  try {
    real = realpathSync(file)
  } catch {
    return new Response('not found', { status: 404 })
  }
  if (!inRoot(resolve(real))) return new Response('not found', { status: 404 })

  try {
    const res = await net.fetch(pathToFileURL(real).toString())
    const ext = real.slice(real.lastIndexOf('.')).toLowerCase()
    const mime = MIME[ext]
    // net.fetch 对 file:// 一般不给 Content-Type，图片没类型解码器会犹豫 —— 补上
    if (mime && !res.headers.get('content-type')) {
      const headers = new Headers(res.headers)
      headers.set('content-type', mime)
      headers.set('cache-control', 'no-cache')
      return new Response(res.body, { status: res.status, headers })
    }
    return res
  } catch (err) {
    console.warn('[壁纸协议] 读取失败：', err instanceof Error ? err.message : err)
    return new Response('read failed', { status: 500 })
  }
}

/** 当前激活壁纸的原图绝对路径 */
function currentFile(): string | null {
  const id = settings.get().wallpaper?.id
  if (!id) return null
  const ref = wallpaper.getRef(id)
  return ref?.path ?? null
}

/** app ready 之后调用，真正挂上 handler */
export function installWallpaperProtocol(): void {
  protocol.handle(WALLPAPER_SCHEME, async (request) => {
    let host = ''
    let pathname = ''
    try {
      const u = new URL(request.url)
      host = u.hostname.toLowerCase()
      pathname = decodeURIComponent(u.pathname || '')
    } catch {
      return new Response('bad request', { status: 400 })
    }

    if (host === 'current') {
      return respondWithFile(currentFile())
    }

    if (host === 'thumb') {
      const id = pathname.replace(/^\/+/, '').replace(/\/+$/, '')
      if (!id || id.includes('\0') || id.includes('/') || id.includes('\\')) {
        return new Response('bad request', { status: 400 })
      }
      const root = wallpaper.getWallpaperDir()
      const thumb = join(root, 'thumbs', `${id}.png`)
      return respondWithFile(existsSync(thumb) ? thumb : (wallpaper.getRef(id)?.path ?? null))
    }

    if (host === 'files') {
      const rel = pathname.replace(/^[\\/]+/, '')
      if (!rel || rel.includes('\0') || isAbsolute(rel)) {
        return new Response('bad request', { status: 400 })
      }
      return respondWithFile(resolve(wallpaper.getWallpaperDir(), rel))
    }

    return new Response('not found', { status: 404 })
  })
}

/* ------------------------ 渲染层用的 URL 构造 ------------------------ */

/** 当前壁纸。`bust` 传 `wallpaper.addedAt` 之类的值，换壁纸时能强制重新解码 */
export function currentWallpaperUrl(bust?: number | string | null): string {
  const q = bust === undefined || bust === null ? '' : `?v=${encodeURIComponent(String(bust))}`
  return `${WALLPAPER_SCHEME}://current/${q}`
}

export function thumbUrl(id: string, bust?: number | string | null): string {
  const q = bust === undefined || bust === null ? '' : `?v=${encodeURIComponent(String(bust))}`
  return `${WALLPAPER_SCHEME}://thumb/${encodeURIComponent(id)}${q}`
}

/** 壁纸目录内的相对路径（`\` 统一成 `/`，并逐段编码） */
export function fileUrl(rel: string, bust?: number | string | null): string {
  const q = bust === undefined || bust === null ? '' : `?v=${encodeURIComponent(String(bust))}`
  const parts = rel.split(/[\\/]+/).filter(Boolean).map(encodeURIComponent)
  return `${WALLPAPER_SCHEME}://files/${parts.join('/')}${q}`
}
