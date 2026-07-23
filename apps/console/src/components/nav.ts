/**
 * Navigation model (M5a.1, M1.1).
 *
 * Ported from design/js/app.js `NAV` — the six top-level pages grouped into
 * sections, with the same ids/labels/href/badge the design sidebar rendered.
 * `href` is the app-router path; `id` selects the active icon; `badge` is the
 * optional mono counter on the right.
 *
 * `CRUMBS` (M1.1) is the per-route breadcrumb trail mirroring each design
 * screen's `.crumbs` markup in design/*.html — a section label, a slash
 * separator, and the current leaf (plus an optional link back to the parent
 * page, e.g. agent-detail's `编排 / Agents / 详情` where `Agents` links to
 * the agents list). The shell resolves the trail for the active route so the
 * topbar reads identically to the design.
 */

import type { IconName } from './icon'

export interface NavItem {
  id: string
  label: string
  href: string
  icon: IconName
  badge?: string
}

export interface NavSection {
  section: string
  items: NavItem[]
}

export const NAV: readonly NavSection[] = [
  {
    section: '运维',
    items: [{ id: 'dashboard', label: '资源看板', href: '/dashboard', icon: 'dashboard', badge: '1.04M' }],
  },
  {
    section: '编排',
    items: [
      { id: 'chat', label: '对话', href: '/chat', icon: 'agents' },
      { id: 'agents', label: 'Agents', href: '/agents', icon: 'agents', badge: '1.04M' },
      { id: 'flows', label: 'AgentFlows', href: '/flows', icon: 'flows', badge: '328' },
      { id: 'lab', label: 'Lab', href: '/lab', icon: 'lab' },
    ],
  },
  { section: '协作', items: [{ id: 'workspace', label: 'Workspace', href: '/workspace', icon: 'workspace' }] },
  { section: '系统', items: [{ id: 'settings', label: '设置', href: '/settings', icon: 'settings' }] },
] as const

/** A single breadcrumb segment. `href` (optional) renders a link, otherwise plain text. */
export interface CrumbSegment {
  label: string
  href?: string
}

/**
 * Per-route breadcrumb trails, sourced from each design screen's `.crumbs`
 * markup (design/*.html). Each entry is `[section, leaf]` except agent-detail,
 * which is `[section, <Agents link>, leaf]` — matching design's
 * `编排 / Agents / 详情`. Resolve via `crumbsFor(pathname)`.
 */
const CRUMBS: readonly { match: string; segments: readonly CrumbSegment[] }[] = [
  { match: '/dashboard', segments: [{ label: '运维' }, { label: '资源看板' }] },
  { match: '/agents/', segments: [{ label: '编排' }, { label: 'Agents', href: '/agents' }, { label: '详情' }] },
  { match: '/agents', segments: [{ label: '编排' }, { label: 'Agents' }] },
  { match: '/flows', segments: [{ label: '编排' }, { label: 'AgentFlows' }] },
  { match: '/lab', segments: [{ label: '编排' }, { label: 'Lab' }] },
  // new-task lives under 协作 (the sidebar's 「新增 Task」plus button is in
  // the Workspace section head, design app.js:69-76). The design's
  // new-task.html crumbs read `协作 / Workspace / 新增 Task` (the leaf links
  // back to workspace). Listed BEFORE `/workspace` so crumbsFor's longest-
  // prefix match picks it for `/tasks/new` over the bare `/workspace` trail.
  { match: '/tasks/new', segments: [{ label: '协作' }, { label: 'Workspace', href: '/workspace' }, { label: '新增 Task' }] },
  { match: '/workspace', segments: [{ label: '协作' }, { label: 'Workspace' }] },
  { match: '/settings', segments: [{ label: '系统' }, { label: '设置' }] },
  // The chat moved to /chat (M6.1); the root is now the design launcher, so
  // the launcher root crumbs read `概览` (design index.html:93 `.crumb-current`
  // is 「概览」), and /chat keeps the编排/对话 trail.
  { match: '/chat', segments: [{ label: '编排' }, { label: '对话' }] },
  { match: '/', segments: [{ label: '概览' }] },
]

/**
 * Resolve the breadcrumb trail for a pathname. Longest-prefix match so
 * `/agents/:id` hits the `/agents/` detail trail before the `/agents` list
 * trail. Falls back to the root trail (概览) when nothing matches — matching
 * design's index crumbs fallback.
 */
export function crumbsFor(pathname: string): readonly CrumbSegment[] {
  const path = pathname || '/'
  // Exact match first (so `/agents` lands on the list trail, not the detail).
  const exact = CRUMBS.find((c) => c.match === path)
  if (exact) return exact.segments
  // Then prefix match (detail pages: /agents/<id>, /flows/<id>…). `/agents/`
  // matches a path like `/agents/agent_01` — longest-prefix wins over `/`.
  const prefixed = CRUMBS.filter((c) => c.match !== '/' && path.startsWith(c.match)).sort(
    (a, b) => b.match.length - a.match.length,
  )[0]
  return prefixed?.segments ?? [{ label: '概览' }]
}
