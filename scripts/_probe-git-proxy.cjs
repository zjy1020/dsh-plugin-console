/* 受控实验：pnpm 装一个新的 github 仓库时，git 到底有没有拿到代理？
 * 三种 env 依次跑，看哪一种能让 pnpm 的 git 解析成功。 */
const { spawnSync } = require('node:child_process')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

const NODE = 'C:\\Users\\YBY\\.dsh\\dsh-runtimes\\dsh-primary-runtime\\dependencies\\node\\bin\\node.exe'
const PNPM = 'C:\\Users\\YBY\\.dsh\\dsh-runtimes\\dsh-primary-runtime\\dependencies\\pnpm\\bin\\pnpm.cjs'
const PROXY = 'http://127.0.0.1:65535'
const REPO = process.argv[2] || 'github:zjy1020/dsh-plugin-console'

const base = { ...process.env }
delete base.ELECTRON_RUN_AS_NODE
delete base.HTTP_PROXY
delete base.HTTPS_PROXY
delete base.http_proxy
delete base.https_proxy
delete base.npm_config_proxy
delete base.npm_config_https_proxy

const scenarios = {
  无代理: {},
  大写代理: { HTTP_PROXY: PROXY, HTTPS_PROXY: PROXY },
  '小写+npm_config 代理': { http_proxy: PROXY, https_proxy: PROXY, npm_config_proxy: PROXY, npm_config_https_proxy: PROXY },
  '小写+大写+GIT_CONFIG': {
    HTTP_PROXY: PROXY,
    HTTPS_PROXY: PROXY,
    http_proxy: PROXY,
    https_proxy: PROXY,
    npm_config_proxy: PROXY,
    npm_config_https_proxy: PROXY,
    GIT_CONFIG_COUNT: '1',
    GIT_CONFIG_KEY_0: 'http.proxy',
    GIT_CONFIG_VALUE_0: PROXY
  }
}

for (const [label, extra] of Object.entries(scenarios)) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pnpm-git-probe-'))
  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name: 'probe', private: true, version: '1.0.0' }, null, 2))
  const started = Date.now()
  const res = spawnSync(NODE, [PNPM, 'add', REPO, '--reporter', 'append-only', '--config.confirmModulesPurge=false'], {
    cwd: dir,
    env: { ...base, ...extra, CI: '1', NO_COLOR: '1' },
    encoding: 'utf8',
    timeout: 120000,
    windowsHide: true
  })
  const out = `${res.stdout ?? ''}${res.stderr ?? ''}`.trim()
  const ok = fs.existsSync(path.join(dir, 'node_modules', REPO.split('/').pop().replace('#', '-')))
  const marker = /Repository not found|not found|could not read|Connection was reset|ECONNRESET|ERR_PNPM_GIT/.test(out)
    ? out.match(/Repository not found|Connection was reset|ECONNRESET|ERR_PNPM_GIT[A-Z_]*/g).slice(0, 3)
    : []
  console.log(`\n===== ${label} =====  ${((Date.now() - started) / 1000).toFixed(1)}s  exit=${res.status}`)
  console.log('  标记:', marker.join(' | ') || '（无网络错误特征）')
  console.log('  尾部:', out.split('\n').filter(Boolean).slice(-3).join(' ⏎ ').slice(0, 400))
  console.log('  node_modules 有包:', ok)
  try {
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 500 })
  } catch {
    console.log('  （临时目录没删掉，无所谓）')
  }
}
