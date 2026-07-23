/**
 * Launcher (root /) page tests (M6.1).
 *
 * 验收（issue 描述）：CTA links（进入资源看板 → /dashboard，查看 AgentFlows →
 * /flows）+ arch-strip 渲染测试绿。覆盖 audit §5.1/§5.2 两个 delta。
 *
 * Renders the root route's default export (`Home` → `<LauncherView />`) and
 * asserts the two hero CTAs are real anchors pointing at /dashboard and /flows,
 * and the arch-strip renders the platform's seven layers (architecture-v0.2
 * §3.1). `next/link` is stubbed to a plain `<a>` so the links render without a
 * router context, matching app-shell.test.tsx's stub.
 */
import { describe, it, expect, vi } from 'vitest'
import { render, screen, within } from '@testing-library/react'
import Home from '@/app/page'
import { ARCH_STEPS, HERO_STATS } from '@/lib/launcher'

vi.mock('next/link', () => ({
  default: ({ href, children, ...props }: any) => (
    <a href={href} {...props}>
      {children}
    </a>
  ),
}))

describe('launcher root page (M6.1 — audit §5.1 hero CTA + §5.2 arch-strip)', () => {
  it('renders the hero eyebrow/title/sub', () => {
    render(<Home />)

    expect(screen.getByText('百万智能体编排平台')).toBeInTheDocument()
    // title renders with the emphasized「一百万」
    expect(screen.getByText('一百万')).toBeInTheDocument()
    expect(
      screen.getByText(/基于 Flowise 单引擎 \+ 自研调度\/版本\/可复现层/),
    ).toBeInTheDocument()
  })

  it('renders the 进入资源看板 CTA linking to /dashboard', () => {
    render(<Home />)

    const cta = screen.getByRole('link', { name: '进入资源看板' })
    expect(cta.getAttribute('href')).toBe('/dashboard')
    expect(cta.className).toContain('btn-accent')
  })

  it('renders the 查看 AgentFlows CTA linking to /flows', () => {
    render(<Home />)

    const cta = screen.getByRole('link', { name: '查看 AgentFlows' })
    expect(cta.getAttribute('href')).toBe('/flows')
    expect(cta.className).toContain('btn-secondary')
  })

  it('renders the four hero KPI stats', () => {
    render(<Home />)

    for (const s of HERO_STATS) {
      expect(screen.getByText(s.value)).toBeInTheDocument()
      expect(screen.getByText(s.label)).toBeInTheDocument()
    }
  })

  it('renders the arch-strip with all seven platform layers', () => {
    render(<Home />)

    const strip = document.querySelector('.arch-strip')
    expect(strip).not.toBeNull()
    const steps = strip!.querySelectorAll('.arch-step')
    // 验收：arch-strip 渲染 — seven layers from architecture-v0.2 §3.1
    expect(steps).toHaveLength(ARCH_STEPS.length)
    expect(steps).toHaveLength(7)

    // each layer's ordinal + title + detail renders
    for (const step of ARCH_STEPS) {
      expect(within(strip! as HTMLElement).getByText(step.ordinal)).toBeInTheDocument()
      expect(within(strip! as HTMLElement).getByText(step.title)).toBeInTheDocument()
      expect(within(strip! as HTMLElement).getByText(step.detail)).toBeInTheDocument()
    }
  })

  it('labels the hero + arch-strip regions for screen readers', () => {
    render(<Home />)

    expect(screen.getByRole('region', { name: '平台概览' })).toBeInTheDocument()
    expect(screen.getByRole('region', { name: '平台分层架构' })).toBeInTheDocument()
  })
})
