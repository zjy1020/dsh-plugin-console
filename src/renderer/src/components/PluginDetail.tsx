/**
 * PluginDetail —— 右侧详情面板，展示 PluginRecord 的全部可用字段。
 *
 * 数据：state.plugins 里按 selectedId 取（来源 plugins(profile,{deep:false})）
 * sizeBytes 为 null 时给「计算大小」→ actions.computeSize（再拉 deep:true）
 */

import { useState, type ReactNode } from 'react'
import type { PluginRecord, VersionOption } from '../../../shared/types'
import { describeSource, describeUpdateKind, formatBytes, formatDateTime, formatRelativeTime, orDash } from '../lib/format'
import { hasUpdateError, useConsole } from '../lib/store'
import { PluginIcon } from './PluginIcon'
import { PluginGallery } from './PluginGallery'
import VersionPicker from './VersionPicker'

/*
 * 面板**内部**排版（躲圆角的内边距 / 谁滚谁不滚 / 衬底上的文字对比度）放在组件自己的
 * 样式表里，跟 TitleBar→titlebar.css、VersionPicker→version-picker.css 一个惯例。
 * 面板外壳（悬浮衬底、圆角、1px 边、overflow:hidden）在 glass.css 的
 * `.app__body > .detail` 里，那一条不属于本组件。
 */
import '../styles/detail.css'

function Row({ k, children }: { k: string; children: ReactNode }) {
  return (
    <div className="detail__row">
      <span className="detail__k">{k}</span>
      <span className="detail__v">{children}</span>
    </div>
  )
}

function Link({ url, label }: { url: string | null; label?: string }) {
  const { actions } = useConsole()
  if (!url) return <span className="dim">—</span>
  return (
    <button
      type="button"
      className="link-btn truncate"
      onClick={() => void actions.openExternal(url)}
      title={url}
    >
      {label ?? url}
    </button>
  )
}

export function PluginDetail() {
  const { state, actions } = useConsole()
  /** 版本面板是否展开：换版本 / 降级 / 钉回旧版都从这里走 */
  const [pickOpen, setPickOpen] = useState(false)
  const rec: PluginRecord | null =
    state.plugins.find((p) => p.id === state.selectedId) ?? null

  if (!rec) return null

  const source = describeSource(rec.sourceKind)
  const busy = state.op !== null
  const updatable = rec.updateAvailable && rec.installed

  /*
   * 「换版本」只对能从远端列举版本的来源有意义：
   * - npm：传**包名**。profile 里存的 spec 是 `^0.78.1` 这种纯版本约束，
   *   传给 spec 解析会得到「只有版本号、没有包名」，列不出东西。
   * - git / tarball：传原 spec（github:owner/repo#ref 才有标签可挑）。
   * - link / file / workspace：本地目录，没有版本列表，按钮直接不出现。
   */
  const canPickVersion = rec.sourceKind === 'npm' || rec.sourceKind === 'git' || rec.sourceKind === 'tarball'
  const pickerInput = rec.sourceKind === 'npm' ? rec.name : (rec.spec || rec.name)

  return (
    <aside className="detail" aria-label="插件详情">
      <div className="detail__head">
        <PluginIcon profile={rec.profile} name={rec.name} size={56} radius={10} />
        <div className="detail__title">
          <span className="detail__name mono truncate" title={rec.name}>
            {rec.name}
          </span>
          <span className={`badge badge--${source.tone}`}>{source.label}</span>
          {rec.builtin ? <span className="badge badge--muted">官方内置</span> : null}
          {rec.disabled ? <span className="badge badge--muted">已停用</span> : null}
          {!rec.installed ? <span className="badge badge--warn">未安装</span> : null}
        </div>
        <button
          type="button"
          className="icon-btn detail__close"
          onClick={() => actions.select(null)}
          aria-label="关闭详情"
          title="关闭详情 (Esc)"
        >
          ✕
        </button>
      </div>

      {/*
        正文是面板里**唯一**的滚动容器：头部、换版本面板、底部操作栏三块都是不滚的
        固定块（flex 0 0 auto），正文 flex:1 1 auto + min-height:0 吃掉剩下的高度。
        面板外壳是 overflow:hidden 的定高块（glass.css 那条），多一层滚动就会互相打架。
      */}
      <div className="detail__body">
        {/*
          简介放在正文第一块，而不是「滚动区外面、操作栏上面」那块通栏：
          README 摘出来的简介能到十几行，放在滚动区外会把正文的可用高度挤成 0，
          而 .detail 是 overflow:hidden —— 挤掉就再也滚不到了。
        */}
        {rec.description ? <p className="detail__desc">{rec.description}</p> : null}

        <div className="detail__section">
          <div className="section-title">版本</div>
          <Row k="当前版本">
            <span className="mono">{orDash(rec.version)}</span>
            {rec.specVersion && rec.specVersion !== rec.version ? (
              <span className="detail__aside mono">spec: {rec.specVersion}</span>
            ) : null}
          </Row>
          <Row k="最新版本">
            <span className={`mono${updatable ? ' detail__upd' : ''}`}>{orDash(rec.latestVersion)}</span>
            {updatable ? (
              <span className="badge badge--accent detail__aside">
                可更新 · {describeUpdateKind(rec.updateKind)}
              </span>
            ) : null}
            {hasUpdateError(rec) ? (
              <span className="detail__aside detail__err" title={rec.updateError ?? undefined}>
                {rec.updateError}
              </span>
            ) : null}
          </Row>
          <Row k="检查时间">
            {rec.checkedAt ? (
              <span className="mono" title={formatDateTime(rec.checkedAt)}>
                {formatRelativeTime(rec.checkedAt)}
              </span>
            ) : (
              <span className="dim">还没检查过</span>
            )}
          </Row>
        </div>

        <div className="detail__section">
          <div className="section-title">来源</div>
          <Row k="来源类型">
            <span className={`badge badge--${source.tone}`}>{source.label}</span>
            <span className="detail__aside mono dim">{rec.sourceKind}</span>
          </Row>
          <Row k="spec">
            <span className="mono detail__spec selectable">{orDash(rec.spec)}</span>
          </Row>
          {/*
            * 本地来源（下载下来的 tarball / 源码目录）界面上一眼看不出它其实来自 GitHub ——
            * 这一行把包里声明的远程出处摆出来。npm / git / tarball 来源不显示：
            * 它们的 spec 本身就是远程坐标，再列一遍是噪音。
            */}
          {rec.remoteGitUrl &&
          (rec.sourceKind === 'file' || rec.sourceKind === 'link' || rec.sourceKind === 'workspace') ? (
            <Row k="远程出处">
              <span className="mono detail__spec selectable">{rec.remoteGitUrl}</span>
              <span className="detail__aside dim">
                {rec.sourceKind === 'file' ? '检查更新时按这里的标签比版本' : '你现在装的是本地目录，不是这个远端'}
              </span>
            </Row>
          ) : null}
          <Row k="homepage">
            <Link url={rec.homepage} />
          </Row>
          <Row k="repository">
            <Link url={rec.repository} />
          </Row>
          <Row k="author">
            <span className="truncate">{orDash(rec.author)}</span>
          </Row>
          <Row k="license">
            <span className="mono">{orDash(rec.license)}</span>
          </Row>
          {rec.keywords.length > 0 ? (
            <div className="detail__chips">
              {rec.keywords.map((kw) => (
                <span className="detail__chip mono" key={kw}>
                  {kw}
                </span>
              ))}
            </div>
          ) : null}
        </div>

        <div className="detail__section">
          <div className="section-title">图片</div>
          <PluginGallery profile={rec.profile} name={rec.name} />
        </div>

        <div className="detail__section">
          <div className="section-title">安装信息</div>
          <Row k="依赖数">
            <span className="mono">{rec.depsCount}</span>
          </Row>
          <Row k="占用大小">
            {rec.sizeBytes !== null ? (
              <span className="mono">{formatBytes(rec.sizeBytes)}</span>
            ) : (
              <>
                <span className="mono dim">—</span>
                <button
                  type="button"
                  className="btn btn--sm btn--ghost detail__aside"
                  onClick={() => void actions.computeSize(rec)}
                  disabled={state.deepBusy !== null}
                  title="重新用 deep:true 拉一次列表，统计 node_modules 占用"
                >
                  {state.deepBusy ? <span className="spinner spinner--sm" /> : null}
                  计算大小
                </button>
              </>
            )}
          </Row>
          <Row k="安装时间">
            {rec.installedAt ? (
              <span className="mono" title={formatDateTime(rec.installedAt)}>
                {formatDateTime(rec.installedAt)}
              </span>
            ) : (
              <span className="dim">—</span>
            )}
          </Row>
          <Row k="安装路径">
            <span className="mono detail__path selectable" title={rec.path ?? undefined}>
              {orDash(rec.path)}
            </span>
          </Row>
        </div>

        <div className="detail__section">
          <div className="section-title">运行状态</div>
          <Row k="已安装">
            <span className={`badge ${rec.installed ? 'badge--ok' : 'badge--warn'}`}>
              {rec.installed ? '是' : '否'}
            </span>
          </Row>
          <Row k="可卸载">
            <span className={`badge ${rec.removable ? 'badge--ok' : 'badge--muted'}`}>
              {rec.removable ? '是' : '否'}
            </span>
          </Row>
          <Row k="在 bundles 中">
            <span className={`badge ${rec.inBundles ? 'badge--ok' : 'badge--muted'}`}>
              {rec.inBundles ? '是' : '否'}
            </span>
            {rec.bundleIndex !== null ? (
              <span className="detail__aside mono dim">下标 {rec.bundleIndex}</span>
            ) : null}
          </Row>
          <Row k="bundle 包">
            <span className="mono">{rec.isBundlePackage ? '是' : '否'}</span>
            <span className="detail__aside mono dim">
              client {rec.hasClient ? '✓' : '×'} · server {rec.hasServer ? '✓' : '×'}
            </span>
          </Row>
          {rec.disabledInPatch ? (
            <div className="banner banner--warn detail__note">
              <span aria-hidden="true">▲</span>
              <span>在 cordis.patch.yml 里被外部停用。要恢复得改那个文件，这里的「启用」按钮改不到它。</span>
            </div>
          ) : null}
        </div>
      </div>

      {/*
        换版本面板贴着底部操作栏展开 —— 它的开合按钮就在那排按钮里，眼睛不用来回跳。
        它也是固定块：正文仍然只有一层滚动，选择器自己的版本列表在 version-picker.css
        里有 max-height，不会把面板顶爆。
      */}
      {pickOpen && canPickVersion ? (
        <div className="detail__picker">
          <VersionPicker
            profile={rec.profile}
            input={pickerInput}
            current={rec.version}
            compact
            onPick={(option: VersionOption) => {
              setPickOpen(false)
              void actions.installSpec(option.spec, rec.profile, {
                normalized: option.spec,
                name: rec.name,
                version: option.value,
                isDshPlugin: rec.isBundlePackage
              })
            }}
            onCancel={() => setPickOpen(false)}
          />
        </div>
      ) : null}

      {/*
        操作栏从「标题下面那条」搬到面板底部当固定栏：正文滚到哪，更新 / 停用 / 卸载
        都还在视野里；它也就不再和正文抢同一段高度。分隔线跟着从上沿走（见 detail.css）。
      */}
      <div className="detail__actions">
        {updatable ? (
          <button
            type="button"
            className="btn btn--sm btn--primary"
            onClick={() => void actions.updateOne(rec)}
            disabled={busy}
            title={describeUpdateKind(rec.updateKind)}
          >
            更新到 {orDash(rec.latestVersion)}
          </button>
        ) : null}
        {canPickVersion ? (
          <button
            type="button"
            className="btn btn--sm btn--ghost"
            onClick={() => setPickOpen((v) => !v)}
            disabled={busy}
            aria-expanded={pickOpen}
            title="列出所有版本 / 标签 / 分支，换一个装（也可以降级）"
          >
            换版本
          </button>
        ) : null}
        {!rec.installed ? (
          <button
            type="button"
            className="btn btn--sm"
            onClick={() => void actions.reinstall(rec)}
            disabled={busy}
          >
            重新安装
          </button>
        ) : (
          <button
            type="button"
            className="btn btn--sm btn--ghost"
            onClick={() => void actions.toggleOne(rec)}
            disabled={busy}
          >
            {rec.disabled ? '启用' : '停用'}
          </button>
        )}
        <button
          type="button"
          className="btn btn--sm btn--ghost"
          onClick={() => void actions.revealPath(rec.path)}
          disabled={!rec.path}
        >
          打开目录
        </button>
        <button
          type="button"
          className="btn btn--sm btn--ghost prow__danger"
          onClick={() => void actions.uninstall(rec)}
          disabled={busy || !rec.removable}
          title={rec.removable ? '两步确认后卸载' : '不可卸载（内置或被依赖）'}
        >
          卸载
        </button>
      </div>
    </aside>
  )
}