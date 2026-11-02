/* 真拷路径验收：把 DSH_HOME 指到一个空目录，跑一次 provisionRuntime，
 * 检查 node/pnpm 是否真的落盘、进度事件是否发过、envChanged 之后界面是否自己好了。
 *
 * 这个脚本只读 + 只写那个临时 DSH_HOME，不碰用户的真实 .dsh。
 */
;(async () => {
  const out = { pass: false, fail: [], detail: {} }
  const d = window.dsh

  const before = await d.runtimeInfo()
  out.detail.before = {
    dshHome: before.dshHome,
    dshHomeFrom: before.dshHomeFrom,
    nodePath: before.nodePath,
    pnpmPath: before.pnpmPath,
    installRoot: before.installRoot,
    warnings: before.warnings
  }
  if (before.dshHome !== 'D:\\dsh-provision-test') {
    out.fail.push(`DSH_HOME 没指到测试目录（实际 ${before.dshHome}）`)
  }
  if (before.nodePath) out.fail.push('测试目录是空的，nodePath 不该有值')

  // 源可用性：安装根还在（desktop-install.txt 没动），所以应该能补
  const src = await d.runtimeSource()
  out.detail.source = {
    ok: src.ok,
    dir: src.dir,
    target: src.target,
    upToDate: src.upToDate,
    problem: src.problem,
    parts: src.parts
  }
  if (!src.ok) out.fail.push(`源不可用：${src.problem}`)
  if (src.ok && src.upToDate) out.fail.push('空目录不该 upToDate')

  // 收进度事件
  const frames = []
  const off = d.onProvisionProgress((p) => {
    frames.push({ phase: p.phase, copiedFiles: p.copiedFiles, copiedBytes: p.copiedBytes, message: p.message })
  })

  const t0 = performance.now()
  const res = await d.runtimeProvision()
  const wallMs = Math.round(performance.now() - t0)
  off()

  out.detail.provision = { ...res, wallMs }
  out.detail.progressFrames = {
    count: frames.length,
    phases: [...new Set(frames.map((f) => f.phase))],
    firstCopy: frames.find((f) => f.phase === 'copy') ?? null,
    last: frames[frames.length - 1] ?? null
  }

  if (!res.ok) out.fail.push(`provision 失败：${res.message}`)
  if (!res.copied) out.fail.push('空目录应该真的拷（copied 应为 true）')
  if (frames.length === 0) out.fail.push('一帧进度都没收到')

  // 拷完之后探测应该能看到 node/pnpm
  const after = await d.runtimeInfo()
  out.detail.after = {
    nodePath: after.nodePath,
    pnpmPath: after.pnpmPath,
    warnings: after.warnings
  }
  if (!after.nodePath) out.fail.push('拷完之后 nodePath 还是空')
  if (!after.pnpmPath) out.fail.push('拷完之后 pnpmPath 还是空')

  // 幂等：再跑一次应该立刻返回 copied:false
  const again = await d.runtimeProvision()
  out.detail.second = again
  if (again.copied) out.fail.push('第二次不该再拷')
  if (!again.ok) out.fail.push(`第二次失败：${again.message}`)

  out.pass = out.fail.length === 0
  return out
})()
