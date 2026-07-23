/**
 * Page shell (M5a.1).
 *
 * Thin server-component wrapper around `.page > .page-head + children`, the
 * layout every design screen shares (design/css/shell.css). Routes pass their
 * title / subtitle / breadcrumb / actions; the shell renders the consistent
 * page head so each route body is just its domain content.
 */

import type { ReactNode } from 'react'

export interface PageShellProps {
  title: string
  subtitle?: string
  crumb?: string
  actions?: ReactNode
  children: ReactNode
  /** When true, drop the `.page` padding/max-width and render children raw
   * (for full-bleed layouts like the chat view that manage their own grid). */
  fullBleed?: boolean
}

export function PageShell({ title, subtitle, crumb, actions, children, fullBleed }: PageShellProps) {
  if (fullBleed) {
    return (
      <div className="page" style={{ padding: 'var(--space-4) var(--space-8) var(--space-8)', maxWidth: 'none' }}>
        <div className="page-head">
          <div className="page-head-title">
            <h1 className="page-title">{title}</h1>
            {subtitle ? <p className="page-subtitle">{subtitle}</p> : null}
          </div>
          {actions ? <div className="page-actions">{actions}</div> : null}
        </div>
        {children}
      </div>
    )
  }

  return (
    <div className="page">
      <div className="page-head">
        <div className="page-head-title">
          <h1 className="page-title">{title}</h1>
          {subtitle ? <p className="page-subtitle">{subtitle}</p> : null}
        </div>
        {actions ? <div className="page-actions">{actions}</div> : null}
      </div>
      {crumb ? <div className="hidden">{crumb}</div> : null}
      {children}
    </div>
  )
}
