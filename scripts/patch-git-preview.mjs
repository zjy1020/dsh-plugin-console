import { readFileSync, writeFileSync } from 'node:fs'

const file = 'D:/项目/DSH/deepseekharness插件台/src/main/engine/ops.ts'
let src = readFileSync(file, 'utf8')

const startAnchor = '  /* git：问 GitHub API */'
const start = src.indexOf(startAnchor)
if (start < 0) throw new Error('找不到 git 分支起始锚点')

const ifStart = src.indexOf("if (parsed.kind === 'git') {", start)
if (ifStart < 0) throw new Error('找不到 if (parsed.kind === \'git\')')
const bodyStart = src.indexOf('{', ifStart)

let depth = 0
let end = -1
for (let i = bodyStart; i < src.length; i += 1) {
  const ch = src[i]
  if (ch === '{') depth += 1
  else if (ch === '}') {
    depth -= 1
    if (depth === 0) {
      end = i + 1
      break
    }
  }
}
if (end < 0) throw new Error('git 分支括号未闭合')

const replacement = `/* git：先读仓库里的 package.json —— raw 域名基本不限流，而且能直接
     拿到包名 / 版本 / 有没有 dsh.bundle.patch，这三样正好是预检要展示的。
     api.github.com 只用来补仓库元信息，403 限流时不再是致命伤。 */
  if (parsed.kind === 'git') {
    if (parsed.owner && parsed.repo) {
      let manifest: Awaited<ReturnType<typeof net.repoManifest>> | null = null
      try {
        manifest = await net.repoManifest(parsed.owner, parsed.repo, parsed.ref)
      } catch (err) {
        warnings.push(\`读取仓库 package.json 失败：\${err instanceof Error ? err.message : String(err)}\`)
      }

      if (manifest && manifest.ok) {
        if (manifest.name) resolvedName = manifest.name
        if (manifest.version) resolvedVersion = manifest.version
        if (manifest.description) resolvedDescription = manifest.description
        isDshPlugin = manifest.isBundle
        if (!manifest.isBundle) {
          warnings.push('这个仓库的 package.json 里没有 dsh.bundle.patch —— 装完是普通依赖，不会进加载列表')
        }
        if (manifest.ref && parsed.ref === null && manifest.ref !== 'HEAD') {
          warnings.push(\`默认分支：\${manifest.ref}\`)
        }
      } else if (manifest) {
        warnings.push(\`远端没读到 package.json（\${manifest.error ?? '未知原因'}）—— 包名和「会不会进加载列表」要等装完才知道\`)
      }

      try {
        const info = await net.githubRepo(parsed.owner, parsed.repo)
        if (info && info.ok) {
          resolvedDescription = resolvedDescription ?? info.description ?? null
          if (info.fullName) repoFullName = info.fullName
          if (info.defaultBranch && !(manifest && manifest.ok)) {
            warnings.push(\`默认分支：\${info.defaultBranch}（安装后以 pnpm 解析到的 commit 为准）\`)
          }
          if (info.stars !== null && info.stars >= 0) {
            warnings.push(\`GitHub 星标：\${info.stars}\`)
          }
          if (info.archived) warnings.push('这个仓库已归档，后续不会有新版本')
        }
      } catch {
        /* api 挂了不影响预检 —— raw 那条路已经把关键信息拿到了 */
      }
    } else {
      warnings.push('没解析出 owner/repo，安装时以 pnpm 的结果为准')
    }
    if (parsed.ref && /^[0-9a-f]{7,40}$/i.test(parsed.ref)) {
      warnings.push('已锁定 commit，后续不会自动更新')
    }
    if (parsed.subdir) {
      warnings.push(\`monorepo 子目录：\${parsed.subdir}\`)
    }
    if (!resolvedName) {
      warnings.push('仓库里没读到包名，安装后由系统读取 package.json 识别')
    }
    if (repoFullName) {
      warnings.push(\`仓库：\${repoFullName}\`)
    }
  }`

src = src.slice(0, start) + replacement + src.slice(end)
writeFileSync(file, src, 'utf8')
console.log('git 预检分支已替换')