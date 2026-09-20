/**
 * Page shell (M5a.1).
 *
 * Thin server-component wrapper around `.page > .page-actions + children`, the
 * layout every design screen shares (design/css/shell.css). Routes pass their
 * breadcrumb / actions; the shell renders the consistent page actions slot so
 * each route body is just its domain content.
 */

import type { ReactNode } from 'react'

export interface PageShellProps {
  crumb?: string
  actions?: ReactNode
  children: ReactNode
  /** When true, drop the `.page` padding/max-width and render children raw
   * (for full-bleed layouts like the chat view that manage their own grid). */
  fullBleed?: boolean
  /** fullBleed + flush：连呼吸边距也归零 —— 无限画布这类「内容即整个视口」
   * 的沉浸页用（2026-09-19 画布无限化）。默认 fullBleed 保留 16/32/32 呼吸边。 */
  flush?: boolean
}

export function PageShell({ crumb, actions, children, fullBleed, flush }: PageShellProps) {
  if (fullBleed) {
    return (
      <div className="page" style={{ padding: flush ? 0 : 'var(--space-4) var(--space-8) var(--space-8)', maxWidth: 'none', marginInline: 0, width: '100%', height: '100%', display: 'flex', flexDirection: 'column', minHeight: 0 }}>
        {actions ? (
          <div className="page-head" style={{ flexShrink: 0 }}>
            <div className="page-actions">{actions}</div>
          </div>
        ) : null}
        {/* Inner wrapper is a flex column so children can use `flex: 1` to
         * fill the viewport (full-bleed pages like Daemons/Canvas own their
         * scroll). `height: 100%` on children also resolves correctly here
         * because this div is both a flex item (definite height from the
         * outer flex column) and a flex container. */}
        <div style={{ flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column' }}>
          {children}
        </div>
      </div>
    )
  }

  return (
    <div className="page">
      {actions ? (
        <div className="page-head">
          <div className="page-actions">{actions}</div>
        </div>
      ) : null}
      {crumb ? <div className="hidden">{crumb}</div> : null}
      {children}
    </div>
  )
}
