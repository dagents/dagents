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
    section: '',
    items: [
      { id: 'agents', label: 'Agent', href: '/agents', icon: 'agents' },
      { id: 'skills', label: '技能', href: '/skills', icon: 'zap' },
      { id: 'flows', label: 'Flow', href: '/flows', icon: 'flows' },
      { id: 'daemons', label: 'Daemon', href: '/daemons', icon: 'daemons' },
    ],
  },
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
  { match: '/chats/', segments: [{ label: '对话' }] },
  { match: '/agents/', segments: [{ label: 'Agent', href: '/agents' }, { label: '详情' }] },
  { match: '/agents', segments: [{ label: 'Agent' }] },
  { match: '/skills', segments: [{ label: '技能' }] },
  { match: '/flows', segments: [{ label: 'Flow' }] },
  { match: '/daemons', segments: [{ label: 'Daemon' }] },
  { match: '/settings', segments: [{ label: '设置' }] },
  { match: '/', segments: [] },
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
