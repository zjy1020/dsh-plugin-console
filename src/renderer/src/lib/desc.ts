/**
 * 简介取字：**中文优先**。
 *
 * 为什么不是直接用 rec.description：
 * 插件列表 / 搜索结果里的简介来自包自己的 package.json 或 npm registry 搜索接口，
 * 社区插件的 description 十有八九是英文；而插件市场目录（catalog.json）里每条都带一版
 * 中文（实测 9111/9111 条全有）。用户看不懂英文，那一行就等于没写。
 *
 * 数据是「目录抓过才有」的：没进过市场页时 descZh 全是 null，这里自动退回原文，
 * 界面不会因为缺中文而空出一行 —— 少一句中文是遗憾，空一行是 bug。
 */

import type { PluginRecord, SearchHit } from '../../../shared/types'

/** 已装插件的简介：目录中文 > 包自己的 description */
export function pluginDesc(rec: Pick<PluginRecord, 'description' | 'descZh'>): string | null {
  return rec.descZh ?? rec.description
}

/** npm 搜索命中的简介：目录中文 > registry 给的英文 */
export function hitDesc(hit: Pick<SearchHit, 'description' | 'descZh'>): string | null {
  return hit.descZh ?? hit.description
}

/**
 * 这行中文是不是目录补的（而不是包自己就是中文）。
 * 详情面板用它决定要不要额外标一句出处 —— 用户看到「这行不是作者写的」是有价值的。
 */
export function descFromCatalog(rec: Pick<PluginRecord, 'description' | 'descZh'>): boolean {
  return rec.descZh !== null && rec.descZh !== rec.description
}
