/* 验证「运行中的进程」路由免结构校验：
 * 屏蔽设置 / tip 文件 / 结构校验（rename package.json）之后，
 * 唯一能给出安装根的就是正在运行的 DeepSeek Harness.exe 进程本身。
 * 预期：installRoot = 进程所在目录，installRootFrom = '运行中的进程'，
 * 且诊断轨迹里能看到「直接采纳」那条说明。 */
;(() => {
  const w = window
  const d = w.dsh
  if (!d) return JSON.stringify({ error: 'no window.dsh' })
  return (async () => {
    const rt = await d.runtimeInfo()
    const steps = await d.envDiagnose().catch((e) => ({ error: String(e) }))
    const stepList = Array.isArray(steps) ? steps : steps?.steps ?? []
    const procSteps = stepList.filter(
      (s) => (s?.name ?? s?.label ?? '').includes('进程') || (s?.detail ?? '').includes('进程')
    )
    return JSON.stringify(
      {
        installRoot: rt.installRoot,
        installRootFrom: rt.installRootFrom,
        warnings: rt.warnings,
        procSteps,
        pass:
          rt.installRoot === 'D:\\Dowloads\\DeepSeekHarness' &&
          rt.installRootFrom === '运行中的进程',
      },
      null,
      2
    )
  })()
})()
