import { readFileSync, writeFileSync } from 'node:fs'

const fix = (path, pairs) => {
  let s = readFileSync(path, 'utf8')
  for (const [from, to] of pairs) {
    if (!s.includes(from)) {
      console.log(`MISS in ${path}: ${from.slice(0, 60)}`)
      continue
    }
    s = s.split(from).join(to)
  }
  writeFileSync(path, s, 'utf8')
}

fix('D:/项目/DSH/deepseekharness插件台/src/main/engine/net.ts', [
  [
    '      lastError = `仓库里没有 package.json（试过 ${candidate}）`',
    "      lastError = '这个仓库里没有 package.json'"
  ],
  [
    '      lastError = `读取 package.json 失败：`',
    "      lastError = `读取 package.json 失败：${res.error ?? '未知原因'}`"
  ],
  [
    "  let lastError = '没读到仓库里的 package.json'",
    "  let lastError = '远端没读到 package.json'"
  ]
])

fix('D:/项目/DSH/deepseekharness插件台/src/main/engine/ops.ts', [
  [
    "        warnings.push(`远端没读到 package.json（${manifest.error ?? '未知原因'}）—— 包名和「会不会进加载列表」要等装完才知道`)",
    "        warnings.push(manifest.error ?? '远端没读到 package.json')\n        warnings.push('包名和「会不会进加载列表」要等装完才知道')"
  ]
])

console.log('done')