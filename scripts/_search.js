;(async () => {
  const d = window.dsh
  const res = await d.registrySearch('dsh-', { limit: 12 })
  return JSON.stringify(res, null, 2)
})()
