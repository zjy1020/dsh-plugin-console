/* 统计目录里 description.zh 的覆盖率，以及已安装插件里能靠目录拿到中文简介的有多少。 */
const fs = require('fs')
const path = require('path')

const cat = JSON.parse(fs.readFileSync(path.join(process.env.APPDATA, 'DSH 插件台', 'catalog.json'), 'utf8'))
const list = cat.plugins || []
let zh = 0
let en = 0
let none = 0
const samples = []
const zhNames = new Set()
for (const p of list) {
  const d = p.description || {}
  const hasZh = typeof d.zh === 'string' && d.zh.trim().length > 0
  const hasEn = typeof d.en === 'string' && d.en.trim().length > 0
  if (hasZh) {
    zh++
    zhNames.add(p.name)
  } else if (hasEn) en++
  else none++
  if (hasZh && samples.length < 5) samples.push([p.name, d.zh.slice(0, 40)])
}
console.log(JSON.stringify({ total: list.length, zh, enOnly: en, none, zhRate: ((zh / list.length) * 100).toFixed(1) + '%', samples }, null, 2))

/* 已安装插件 */
const pkgPath = path.join(process.env.USERPROFILE, '.dsh', 'profiles', 'desktop', 'package.json')
const deps = JSON.parse(fs.readFileSync(pkgPath, 'utf8')).dependencies || {}
const names = Object.keys(deps)
const covered = names.filter((n) => zhNames.has(n))
console.log('installed deps:', names.length, '| 目录里有中文简介的:', covered.length)
console.log('缺中文的:', names.filter((n) => !zhNames.has(n)).join(', '))

/* zh 存在时的样例全文 */
for (const n of ['@vectorize-io/hindsight-coding-agents', 'dsh-plugin-wallpaper-engine', 'billion-context']) {
  const hit = list.find((p) => p.name === n)
  if (hit) console.log('\n=== ' + n + ' ===\n' + JSON.stringify(hit.description) + '\ninstall=' + String(hit.install).slice(0, 80))
}
