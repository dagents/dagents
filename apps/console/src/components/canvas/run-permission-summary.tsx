'use client'

/**
 * 运行前权限确认区（R4 声明式权限闭环，2026-10-07）——运行输入面板内、
 * HumanInput 预答区之后的只读信息面板。
 *
 * 数据源是与执行层同一投影函数（@dagents/workflow extractFlowPermissions，
 * AC-R4-4 同源常量）：UI 说的和守卫放的是同一集合。零新增交互负担——
 * 确认面是知情面不是二次授权面（声明的裁决权在执行层），「开始运行」
 * 按钮不新增勾选步骤。
 */

import { useI18n } from '@/i18n'
import type { FlowPermissionProjection } from '@dagents/workflow'
import './run-permission-summary.css'

/** URL 是否含模板变量（{{…}}）——静态比对不适用，运行时守卫裁决。 */
function hasTemplateVar(url: string): boolean {
  return /\{\{[^}]+\}\}/.test(url)
}

/** 静态解析 URL 的 hostname（解析失败返回 null——非法 URL 有别的校验提示）。 */
function staticHostname(url: string): string | null {
  try {
    return new URL(url).hostname.toLowerCase()
  } catch {
    return null
  }
}

function normalizeHost(h: string): string {
  return h.toLowerCase().replace(/^\[|\]$/g, '')
}

export function RunPermissionSummary({
  projection,
}: {
  projection: FlowPermissionProjection
}): React.ReactElement | null {
  const { t } = useI18n()
  const { commandNodes, domainNodes, undeclaredHttp, invalid, hasSubflow } = projection
  if (
    commandNodes.length === 0 &&
    domainNodes.length === 0 &&
    undeclaredHttp.length === 0 &&
    invalid.length === 0
  ) {
    return null // 图内无任何权限面：不渲染空标题（最小惊讶）
  }

  return (
    <div className="run-perm-summary" data-testid="run-permission-summary">
      <div className="run-perm-summary-title">{t('权限确认')}</div>
      <ul className="run-perm-summary-list">
        {commandNodes.map((n) => (
          <li key={`cmd-${n.nodeId}`} className="run-perm-row">
            <span className="run-perm-node">{n.label || n.nodeId}</span>
            <span className="run-perm-scope">
              {t('$exec 命令白名单')}
              {n.commands.length > 0 ? (
                n.commands.map((c) => (
                  <code key={c} className="run-perm-chip">
                    {c}
                  </code>
                ))
              ) : (
                <span className="run-perm-note">∅</span>
              )}
            </span>
          </li>
        ))}
        {commandNodes.length > 0 ? (
          <li className="run-perm-hint">{t('$exec 实际调用在白名单内即放行——运行时裁决')}</li>
        ) : null}
        {domainNodes.map((n) => {
          const url = n.url ?? ''
          const variable = hasTemplateVar(url)
          const host = variable ? null : staticHostname(url)
          const mismatch =
            host != null && !n.domains.some((d) => normalizeHost(d) === normalizeHost(host))
          return (
            <li key={`dom-${n.nodeId}`} className="run-perm-row">
              <span className="run-perm-node">{n.label || n.nodeId}</span>
              <span className="run-perm-scope">
                {t('允许域名')}
                {n.domains.length > 0 ? (
                  n.domains.map((d) => (
                    <code key={d} className="run-perm-chip">
                      {d}
                    </code>
                  ))
                ) : (
                  <span className="run-perm-note">∅</span>
                )}
                {variable ? (
                  <span className="run-perm-note">（{t('URL 含变量——运行时守卫裁决')}）</span>
                ) : mismatch && host ? (
                  <span
                    className="run-perm-warn-inline"
                    title={t('URL 域名不在清单中——运行时将拒绝')}
                  >
                    ⚠ {host}
                  </span>
                ) : null}
              </span>
            </li>
          )
        })}
      </ul>
      {undeclaredHttp.length > 0 ? (
        <div className="run-perm-warn" data-testid="run-perm-undeclared">
          {t('{n} 个 HTTP 节点未声明域名清单——当前过渡期放行，网关 enforce 后将拒绝运行', {
            n: String(undeclaredHttp.length),
          })}
          <span className="run-perm-warn-nodes">（{undeclaredHttp.join('、')}）</span>
        </div>
      ) : null}
      {invalid.length > 0 ? (
        <ul className="run-perm-invalid" data-testid="run-perm-invalid">
          {invalid.map((err, i) => (
            <li key={i}>
              {t('节点 {id} 的声明非法：{reason}', {
                id: err.node ?? '?',
                reason: err.message,
              })}
            </li>
          ))}
        </ul>
      ) : null}
      {hasSubflow ? (
        <div className="run-perm-hint">{t('子流程内的声明以子流程画布为准')}</div>
      ) : null}
    </div>
  )
}
