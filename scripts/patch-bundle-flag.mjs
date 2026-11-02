import { readFileSync, writeFileSync } from 'node:fs'

const root = 'D:/项目/DSH/deepseekharness插件台/src/'
const read = (p) => readFileSync(root + p, 'utf8')
const write = (p, s) => writeFileSync(root + p, s, 'utf8')

function must(cond, msg) {
  if (!cond) throw new Error(msg)
}

/* ── 1. net.ts：packument 里顺手读出「有没有 dsh.bundle.patch」 ── */
{
  const p = 'main/engine/net.ts'
  let s = read(p)

  const before = `export async function registryPackument(name: string): Promise<RegistryPackument> {`
  must(s.includes(before), 'net.ts: 找不到 registryPackument')

  s = s.replace(
    before,
    `/**
 * 「这个包是不是加载层」的答案。
 *
 * packument 的 versions[latest] 就是完整的 package.json，所以读 dsh.bundle.patch
 * 不需要第二个请求。null = 没查到（网络失败 / 没这个包），false 才是「确实没声明」。
 */
const bundleFlags = new Map<string, boolean | null>()

export function packumentBundleFlag(name: string): boolean | null {
  return bundleFlags.get(normName(name)) ?? null
}

export async function registryPackument(name: string): Promise<RegistryPackument> {`
  )

  const anchor = `  const out: RegistryPackument = {`
  must(s.includes(anchor), 'net.ts: 找不到 out 声明')

  s = s.replace(
    anchor,
    `  bundleFlags.set(clean, declaresBundlePatch(ver ?? {}))

  const out: RegistryPackument = {`
  )

  /* 缓存命中的那条路也要回填，否则第二次预检会拿到 null */
  const cachedLine = `  const cached = readCache<RegistryPackument>(key)
  if (cached) return { ...cached }`
  must(s.includes(cachedLine), 'net.ts: 找不到缓存命中分支')
  s = s.replace(
    cachedLine,
    `  const cached = readCache<RegistryPackument>(key)
  if (cached) {
    if (!bundleFlags.has(clean)) bundleFlags.set(clean, null)
    return { ...cached }
  }`
  )

  write(p, s)
  console.log('net.ts ok')
}

/* ── 2. ops.ts：npm 分支也用同一个判据 ── */
{
  const p = 'main/engine/ops.ts'
  let s = read(p)

  const anchor = `      } else {
        warnings.push('registry 没有返回可用元数据，安装时会以 pnpm 的结果为准')
      }`
  must(s.includes(anchor), 'ops.ts: 找不到 npm 分支 else')

  s = s.replace(
    anchor,
    `        const bundleFlag = net.packumentBundleFlag(parsed.packageName)
        if (bundleFlag === true) {
          isDshPlugin = true
        } else if (bundleFlag === false) {
          warnings.push('这个包的最新版本没有声明 dsh.bundle.patch —— 装了是普通依赖，不会进加载列表')
        }
      } else {
        warnings.push('registry 没有返回可用元数据，安装时会以 pnpm 的结果为准')
      }`
  )

  write(p, s)
  console.log('ops.ts ok')
}

/* ── 3. InstallPanel：只有「确实读到过 manifest」才亮那条硬警告 ── */
{
  const p = 'renderer/src/components/InstallPanel.tsx'
  let s = read(p)

  const anchor = `          {preview.isDshPlugin === false ? (
            <div className="banner banner--warn install__warn" role="status">
              <span aria-hidden="true">▲</span>
              <span>这个包没声明 DSH 插件字段，装完不会加载。</span>
            </div>
          ) : null}`
  must(s.includes(anchor), 'InstallPanel.tsx: 找不到警告块')

  s = s.replace(
    anchor,
    `          {preview.isDshPlugin === false && preview.resolvedVersion ? (
            <div className="banner banner--warn install__warn" role="status">
              <span aria-hidden="true">▲</span>
              <span>这个版本的 package.json 里没有 dsh.bundle.patch —— 装了不会进加载列表。</span>
            </div>
          ) : null}`
  )

  write(p, s)
  console.log('InstallPanel.tsx ok')
}