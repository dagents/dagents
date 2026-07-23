/**
 * Launcher (index/overview) view (M6.1).
 *
 * The root route's body. A faithful port of design/index.html's page body
 * (lines 106-181): the hero (eyebrow + title + sub + two CTA links + four KPI
 * stats) and the platform arch-strip. design/index.html ships the full launcher
 * (hero + module-grid + arch-strip); this view renders the two pieces the issue
 * names — hero CTA (delta 5.1) and arch-strip (delta 5.2). The module-grid (six
 * module cards) is out of scope for M6.1 and is not rendered; the sidebar
 * (app-shell.tsx) already links to every page the module-grid would point at,
 * so the launcher's two CTAs (进入资源看板 → /dashboard, 查看 AgentFlows →
 * /flows) are the primary navigation.
 *
 * CTAs use next/link so client-side routing keeps the shell mounted. The hero
 * stats + arch-strip layers are static model data from `lib/launcher.ts` (ported
 * from design/index.html); the launcher is an overview, so unlike the dashboard
 * it does not fetch live fleet numbers — it shows the same placeholder KPIs the
 * design shipped as product copy.
 *
 * Rendered inside the AppShell's `.app-main` via a `.page` wrapper, matching how
 * every other route composes its body (see dashboard/agents/flows). No
 * PageShell: the launcher is full-bleed (the hero spans the page), so it owns
 * its own `.page`-padding wrapper.
 */

import Link from 'next/link'
import '@/styles/launcher.css'
import { ARCH_STEPS, HERO_STATS } from '@/lib/launcher'

export function LauncherView(): React.ReactElement {
  return (
    <div className="page" style={{ padding: 'var(--space-8) var(--space-8) var(--space-16)', maxWidth: 1480, marginInline: 'auto' }}>
      <section className="hero" aria-label="平台概览">
        <div>
          <div className="hero-eyebrow">百万智能体编排平台</div>
          <h1 className="hero-title">
            编排 <em>一百万</em> 个 agent，
            <br />
            像运营一座城市。
          </h1>
          <p className="hero-sub">
            基于 Flowise 单引擎 + 自研调度/版本/可复现层。把论文复现、批量推理、异构 CLI agent 协作统一成可视化 DAG 与可追溯 Run。
          </p>
          {/* hero CTA (design 5.1): 进入资源看板 → /dashboard, 查看 AgentFlows → /flows */}
          <div className="hero-cta">
            <Link className="btn btn-accent" href="/dashboard" title="进入资源看板">
              进入资源看板
            </Link>
            <Link className="btn btn-secondary" href="/flows" title="查看 AgentFlows">
              查看 AgentFlows
            </Link>
          </div>
        </div>
        {/* 4 hero KPI stats (design 5.1). Static product copy, not a live fetch. */}
        <div className="hero-stats" aria-label="平台核心指标">
          {HERO_STATS.map((s) => (
            <div className="hero-stat" key={s.id}>
              <div className="v">{s.value}</div>
              <div className="l">{s.label}</div>
              <div className={`d ${s.deltaKind}`}>{s.delta}</div>
            </div>
          ))}
        </div>
      </section>

      <div className="section-label">平台分层</div>
      {/* arch-strip (design 5.2): 7 platform layers from architecture-v0.2 §3.1.
          Rendered as a labeled <section> (not the design's bare <div>) so the
          aria-label exposes a real `region` landmark to assistive tech — a div
          with aria-label alone has no implicit role. */}
      <section className="arch-strip" aria-label="平台分层架构">
        {ARCH_STEPS.map((step) => (
          <div className="arch-step" key={step.id}>
            <div className="n">{step.ordinal}</div>
            <div className="t">{step.title}</div>
            <div className="d">{step.detail}</div>
          </div>
        ))}
      </section>
    </div>
  )
}

export default LauncherView
