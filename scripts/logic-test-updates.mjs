/* 从 src/renderer/src/lib/store.ts:344-437 原样抽出的四个纯函数（只去掉 TS 类型标注），
 * 用来在没有运行实例的情况下验证「刷新保留结论 / 版本变了作废 / 卸载不留幽灵更新」
 * 这几条边界行为。断言失败会抛错并以非零退出。 */

function snapshotOf(rec) {
  if (rec.checkedAt === null) return null
  return {
    atVersion: rec.version,
    latestVersion: rec.latestVersion,
    updateAvailable: rec.updateAvailable,
    updateKind: rec.updateKind,
    updateError: rec.updateError,
    checkedAt: rec.checkedAt
  }
}

function withSnapshot(rec, snap) {
  return {
    ...rec,
    latestVersion: snap.latestVersion,
    updateAvailable: snap.updateAvailable,
    updateKind: snap.updateKind,
    updateError: snap.updateError,
    checkedAt: snap.checkedAt
  }
}

function weaveUpdates(list, updates, profile) {
  if (list.length === 0) return { plugins: list, updates }
  const next = {}
  const belongsToMe = profile !== null ? (id) => id.startsWith(`${profile}::`) : () => false
  for (const [id, snap] of Object.entries(updates)) {
    if (!belongsToMe(id)) next[id] = snap
  }
  const plugins = list.map((rec) => {
    const fresh = snapshotOf(rec)
    if (fresh) {
      next[rec.id] = fresh
      return rec
    }
    const snap = updates[rec.id]
    if (!snap) return rec
    if (snap.atVersion !== rec.version) return rec
    next[rec.id] = snap
    return withSnapshot(rec, snap)
  })
  return { plugins, updates: next }
}

function dropChangedUpdates(updates, changes) {
  const changed = changes.filter((c) => c.action === 'added' || c.action === 'removed' || c.action === 'updated')
  if (changed.length === 0) return updates
  const next = { ...updates }
  for (const c of changed) {
    const suffix = `::${c.name}`
    for (const id of Object.keys(next)) {
      if (id.endsWith(suffix)) delete next[id]
    }
  }
  return next
}

/* ---------------- 造数据 ---------------- */
const P = 'npm-global'
const blank = (name, version) => ({
  id: `${P}::${name}`,
  profile: P,
  name,
  version,
  latestVersion: null,
  updateAvailable: false,
  updateKind: 'none',
  updateError: null,
  checkedAt: null
})
const snap = (name, version, latest, at, err = null) => ({
  [`${P}::${name}`]: {
    atVersion: version,
    latestVersion: latest,
    updateAvailable: latest !== null && latest !== version,
    updateKind: err ? 'npm' : 'npm',
    updateError: err,
    checkedAt: at
  }
})
const results = []
const check = (label, cond, extra) => {
  results.push({ label, ok: !!cond, extra: extra === undefined ? null : extra })
  if (!cond) throw new Error('FAIL: ' + label + ' :: ' + JSON.stringify(extra))
}

/* 场景 1：12 个有结论、6 个可更新；刷新（主进程把结论全写成 null）后必须原样长回来 */
{
  const names = Array.from({ length: 22 }, (_, i) => `p${i}`)
  const before = names.map((n) => ({ ...blank(n, '1.0.0') }))
  let updates = {}
  for (let i = 0; i < 12; i += 1) {
    const n = names[i]
    const latest = i < 6 ? '1.0.1' : '1.0.0'
    updates = { ...updates, ...snap(n, '1.0.0', latest, 111) }
  }
  const freshList = names.map((n) => blank(n, '1.0.0')) // 主进程重读：结论全是 null
  const w = weaveUpdates(freshList, updates, P)
  const withConclusion = w.plugins.filter((r) => r.checkedAt !== null).length
  const updatable = w.plugins.filter((r) => r.updateAvailable).length
  check('刷新后仍带结论的行数 = 12', withConclusion === 12, withConclusion)
  check('刷新后可更新数 = 6', updatable === 6, updatable)
  check('快照条数保持 12', Object.keys(w.updates).length === 12, Object.keys(w.updates).length)
  check('刷新是幂等的（再来一次不增殖）', Object.keys(weaveUpdates(w.plugins.map((r) => blank(r.name, r.version)), w.updates, P).updates).length === 12)

  /* 场景 2：版本变了（升级/重装）→ 该包结论作废，别显示可能错的答案 */
  const bumped = w.plugins.map((r) => (r.name === 'p0' ? blank('p0', '1.0.1') : blank(r.name, r.version)))
  const w2 = weaveUpdates(bumped, w.updates, P)
  const p0 = w2.plugins.find((r) => r.name === 'p0')
  check('版本变了 → 结论作废', p0.checkedAt === null && p0.updateAvailable === false, p0)
  check('同名的其他包不受影响', w2.plugins.find((r) => r.name === 'p1').checkedAt !== null)
  check('被作废的快照已从 updates 里剔除', !w2.updates[`${P}::p0`])

  /* 场景 3：卸载一个包 → 幽灵更新必须消失 */
  const removed = w.plugins.filter((r) => r.name !== 'p2').map((r) => blank(r.name, r.version))
  const w3 = weaveUpdates(removed, w.updates, P)
  check('卸载后不再出现该包', !w3.plugins.some((r) => r.name === 'p2'))
  check('卸载后 updates 里也没有它的快照', !w3.updates[`${P}::p2`], Object.keys(w3.updates).length)
  check('可更新数随之减 1 或 0（p2 本身不可更新则不变）', w3.plugins.filter((r) => r.updateAvailable).length === w.plugins.filter((r) => r.name !== 'p2' && r.updateAvailable).length)

  /* 场景 4：空清单 = 还没拿到清单，不许剪 */
  const w4 = weaveUpdates([], w.updates, P)
  check('空清单不剪结论', Object.keys(w4.updates).length === 12, Object.keys(w4.updates).length)

  /* 场景 5：别的 profile 的结论原样留着 */
  const other = { 'other::x': { atVersion: '9.9.9', latestVersion: '9.9.8', updateAvailable: true, updateKind: 'npm', updateError: null, checkedAt: 5 } }
  const w5 = weaveUpdates(freshList, { ...updates, ...other }, P)
  check('别的 profile 的结论保留', !!w5.updates['other::x'] && Object.keys(w5.updates).length === 13, Object.keys(w5.updates).length)
  check('别的 profile 的结论不会被缝到当前清单上', w5.plugins.every((r) => r.id !== 'other::x'))

  /* 场景 6：主进程这次自己带了结论（刚查完的那次刷新）→ 以主进程为准 */
  const freshWith = freshList.map((r) => (r.name === 'p3' ? { ...r, checkedAt: 999, latestVersion: '2.0.0', updateAvailable: true } : r))
  const w6 = weaveUpdates(freshWith, updates, P)
  const p3 = w6.plugins.find((r) => r.name === 'p3')
  check('主进程的结论优先（checkedAt=999 不被快照覆盖）', p3.checkedAt === 999 && p3.latestVersion === '2.0.0', p3)
  check('主进程结论顺手进快照', w6.updates[`${P}::p3`].checkedAt === 999)
}

/* 场景 7：操作结束后按 changes 作废 */
{
  const u = {
    [`${P}::a`]: { atVersion: '1', latestVersion: '2', updateAvailable: true, updateKind: 'npm', updateError: null, checkedAt: 1 },
    [`${P}::b`]: { atVersion: '1', latestVersion: '2', updateAvailable: true, updateKind: 'npm', updateError: null, checkedAt: 1 },
    [`${P}::foo`]: { atVersion: '1', latestVersion: '2', updateAvailable: true, updateKind: 'npm', updateError: null, checkedAt: 1 },
    [`${P}::xfoo`]: { atVersion: '1', latestVersion: '2', updateAvailable: true, updateKind: 'npm', updateError: null, checkedAt: 1 }
  }
  const afterAdded = dropChangedUpdates(u, [{ action: 'added', name: 'a' }])
  check('added 作废该包结论', afterAdded[`${P}::a`] === undefined && !!afterAdded[`${P}::b`])
  check('只动被点名的包', afterAdded[`${P}::foo`] !== undefined && afterAdded[`${P}::xfoo`] !== undefined)
  /* id 形如 `profile::name`，直接 endsWith(name) 会让 foo 命中 xfoo，所以带 :: 前缀 */
  const afterFoo = dropChangedUpdates(u, [{ action: 'updated', name: 'foo' }])
  check('通过 :: 后缀删准了 foo', afterFoo[`${P}::foo`] === undefined)
  check('包名只按 :: 后缀匹配（foo 不误伤 xfoo）', afterFoo[`${P}::xfoo`] !== undefined, Object.keys(afterFoo))
  const afterBundled = dropChangedUpdates(u, [{ action: 'bundled', name: 'a' }, { action: 'unbundled', name: 'b' }, { action: 'unchanged', name: 'foo' }])
  check('bundled/unbundled/unchanged 不作废', Object.keys(afterBundled).length === 4, Object.keys(afterBundled).length)
  check('无命中时返回同一个对象（免无谓渲染）', dropChangedUpdates(u, []) === u)
  check('作废不改原对象', Object.keys(u).length === 4)
}

console.log(JSON.stringify({ allPassed: results.every((r) => r.ok), count: results.length, results }, null, 2))