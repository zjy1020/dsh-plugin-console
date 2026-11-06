/* 目录条目怎么才能对上「已安装的包名」：按 name / npm 字段 / #后段 / 去 scope 建索引再试。 */
const fs = require('fs')
const path = require('path')

const cat = JSON.parse(fs.readFileSync(path.join(process.env.APPDATA, 'DSH 插件台', 'catalog.json'), 'utf8'))
const list = cat.plugins || []

const idx = new Map()
const put = (key, entry) => {
  if (!key) return
  const k = String(key).toLowerCase().trim()
  if (!k) return
  if (!idx.has(k)) idx.set(k, entry)
}
for (const p of list) put(p.name, p)
for (const p of list) put(p.npm, p)
for (const p of list) {
  if (typeof p.name === 'string' && p.name.includes('#')) put(p.name.split('#').pop(), p)
}
for (const p of list) {
  const base = String(p.name || '').split('#').pop()
  if (base && base.includes('/')) put(base.split('/').pop(), p)
}

const deps = Object.keys(JSON.parse(fs.readFileSync(path.join(process.env.USERPROFILE, '.dsh', 'profiles', 'desktop', 'package.json'), 'utf8')).dependencies || {})
const rows = deps.map((d) => {
  const base = d.includes('/') ? d.split('/').pop() : d
  const hit = idx.get(d.toLowerCase()) || idx.get(base.toLowerCase()) || null
  return { dep: d, hit: hit ? hit.name : null, zh: hit && hit.description && hit.description.zh ? hit.description.zh.slice(0, 34) : null }
})
console.log(JSON.stringify(rows, null, 1))
console.log('覆盖:', rows.filter((r) => r.zh).length, '/', rows.length)

/* 反向：目录里有多少条 npm 字段非空 */
console.log('npm 字段非空:', list.filter((p) => p.npm).length, '/', list.length)
const notInCatalog = deps.filter((d) => !idx.get(d.toLowerCase()) && !idx.get((d.includes('/') ? d.split('/').pop() : d).toLowerCase()))
console.log('目录里完全找不到的已装包:', notInCatalog.join(', '))
console.log('\n目录里名字含 better-sidebar 的:', list.filter((p) => /better-sidebar/i.test(String(p.name))).map((p) => p.name).join(' | '))
console.log('目录里名字含 modsearch 的:', list.filter((p) => /modsearch/i.test(String(p.name))).map((p) => p.name).join(' | '))
