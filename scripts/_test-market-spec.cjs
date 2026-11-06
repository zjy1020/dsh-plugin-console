/* 拿真实目录跑一遍 marketSpecOf：解析不出来 / 解析出带空格的串，都算失败 */
const fs = require('node:fs')
const path = require('node:path')
const { marketSpecOf, specFromInstallField } = require('../.tmp-spec/renderer/src/lib/marketSpec.js')

const catalogPath = path.join(process.env.APPDATA, 'DSH 插件台', 'catalog.json')
const catalog = JSON.parse(fs.readFileSync(catalogPath, 'utf8'))
const plugins = catalog.plugins ?? []
console.log('目录条数', plugins.length, 'count=', catalog.count)

let empty = 0
let withSpace = 0
let installWasCommand = 0
const bad = []
const byKind = { npm: 0, github: 0, other: 0 }

const map = (raw) => ({
  name: String(raw.name ?? ''),
  url: String(raw.url ?? ''),
  owner: String(raw.owner ?? ''),
  categories: [],
  description: {},
  npm: raw.npm ?? null,
  icon: raw.icon ?? null,
  version: null,
  stars: null,
  downloads: null,
  install: String(raw.install ?? ''),
  added: '',
  deprecated: false,
  replacement: null,
  capabilities: [],
  capabilityCheckedAt: null,
  installed: false
})

for (const raw of plugins) {
  const entry = map(raw)
  const spec = marketSpecOf(entry)
  if (!spec) {
    empty += 1
    if (bad.length < 15) bad.push({ name: entry.name, raw: entry.install, spec })
    continue
  }
  if (/\s/.test(spec)) {
    withSpace += 1
    if (bad.length < 15) bad.push({ name: entry.name, raw: entry.install, spec, why: '含空格' })
  }
  if (/\s/.test(entry.install)) installWasCommand += 1
  if (/^github:/.test(spec)) byKind.github += 1
  else if (/^(file|link|workspace):/i.test(spec)) byKind.other += 1
  else byKind.npm += 1
}

console.log('结果为空:', empty, '| 结果仍含空格:', withSpace, '| install 字段是命令行的条数:', installWasCommand)
console.log('解析形态:', JSON.stringify(byKind))
if (bad.length) console.log('样例:', JSON.stringify(bad, null, 1))

/* 定向用例：Master 报错截图里那三条 + 各种边角 */
const cases = [
  'dsh plugin --profile web add dsh-dream-skin',
  'dsh plugin --profile web add github:0xyxy/dsh-maid-atelier-tod',
  'dsh plugin --profile web add @smalltailqwq/dsh-client-ui-skin-maid-atelier',
  'dsh plugin --profile desktop add "@tt-a1i/archify"',
  'pnpm add some-pkg',
  'dsh plugin --profile web install dsh-x',
  'plain-pkg@1.2.3',
  'bad spec with spaces',
  '',
  null
]
console.log('\n-- specFromInstallField --')
for (const c of cases) console.log(JSON.stringify(c), '=>', JSON.stringify(specFromInstallField(c)))

console.log('\n-- marketSpecOf 四级降级 --')
const mk = (o) => ({ ...map({ name: '', url: '', owner: '', install: '' }), ...o })
const probes = [
  mk({ name: 'dsh-dream-skin', url: 'https://github.com/RevolutionLA/dsh-dream-skin', owner: 'RevolutionLA', install: 'dsh plugin --profile web add dsh-dream-skin' }),
  mk({ name: 'archify#integrations/deepseek-harness', url: 'https://github.com/tt-a1i/archify', owner: 'tt-a1i', install: 'dsh plugin --profile web add @tt-a1i/archify' }),
  mk({ name: 'x', url: 'https://github.com/tt-a1i/archify/tree/main/integrations/deepseek-harness', owner: 'tt-a1i', npm: '@tt-a1i/archify', install: '' }),
  mk({ name: 'y', url: 'https://github.com/foo/bar', owner: 'foo', install: 'dsh plugin --profile web add' }),
  mk({ name: 'z#sub/dir', url: 'not-a-url', owner: 'me', install: '' })
]
for (const p of probes) console.log(p.name, '=>', JSON.stringify(marketSpecOf(p)))

/* owner 提取（头像兜底要用） */
const ownerOfSrc = fs.readFileSync('src/renderer/src/components/MarketTab.tsx', 'utf8')
const m = /function ownerOf\([\s\S]*?\n\}/.exec(ownerOfSrc)
console.log('\nownerOf 已在 MarketTab 定义:', Boolean(m))
const ownersMissing = new Set()
for (const raw of plugins.slice(0, 500)) {
  if (!raw.owner) ownersMissing.add(raw.name)
}
console.log('前 500 条里 owner 字段为空的:', ownersMissing.size)
