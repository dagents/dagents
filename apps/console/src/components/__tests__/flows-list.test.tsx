/**
 * Flows list-page fidelity tests (v0.3-M2.1).
 *
 * These pin the design/agentflows.html list-page DOM + interactions the
 * redesign moves `flows-view.tsx` onto — scope tabs, status filter chips, the
 * expandable flow-card with its run history, and the per-card edit/run action
 * buttons. The fetch to `/api/flows` is stubbed so the suite runs without a
 * gateway; `next/navigation`'s `useRouter` is mocked so the edit button's
 * `router.push('/flows/'+fid+'/edit')` wiring can be asserted (the route
 * itself lands in M2.3).
 *
 * Scope: list-page surface only. The DAG canvas (`FlowDag`) mounts under a
 * ResizeObserver stub (vitest.setup.ts) but its internals aren't asserted
 * here — that's the detail page's job (M2.2).
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import type { ReactElement } from 'react'

// `next/navigation` is a server-context module the jsdom env can't resolve;
// mock it before importing the view. The edit button calls
// `router.push('/flows/'+fid+'/edit')` — we capture the path so the test can
// assert it without the M2.3 route existing.
const pushMock = vi.fn()
vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: pushMock, replace: vi.fn(), prefetch: vi.fn() }),
  usePathname: () => '/flows',
}))

// Stub `/api/flows` (list) + `/api/flows/:id` (detail) + node-spans so the
// component's mount effects resolve without a gateway. The list fixture is
// the surface under test; the detail fixture is only there so the run-button
// → showDetail path doesn't 404 mid-click.
const FLOWS_FIXTURE = [
  {
    id: 'flow_repro_01',
    name: '论文批量复现流水线',
    type: 'AGENTFLOW',
    status: 'running',
    nodeCount: 9,
    updatedAt: '2026-07-13T14:20:00.000Z',
    versionHash: '7a3f9c',
    owner: null,
    archived: false,
    runCount: 3,
    latestRunId: 'R-8821',
  },
  {
    id: 'flow_gate_03',
    name: '发布门控（HITL）',
    type: 'AGENTFLOW',
    status: 'done',
    nodeCount: 6,
    updatedAt: '2026-07-13T14:06:00.000Z',
    versionHash: 'c9014d',
    owner: null,
    archived: false,
    runCount: 1,
    latestRunId: 'R-8819',
  },
] as const

const FLOW_DETAIL_FIXTURE = {
  id: 'flow_repro_01',
  name: '论文批量复现流水线',
  type: 'AGENTFLOW',
  versionHash: '7a3f9c',
  status: 'running',
  latestExecutionId: 'R-8821',
  latestRunId: 'R-8821',
  nodes: [
    { id: 'n1', label: '开始', type: 'Start', position: { x: 0, y: 0 }, status: 'done' },
    { id: 'n2', label: 'reader-04', type: 'Agent', position: { x: 200, y: 0 }, status: 'running' },
  ],
  edges: [{ id: 'e1', source: 'n1', target: 'n2' }],
  nodeMetrics: {},
  updatedAt: '2026-07-13T14:20:00.000Z',
}

describe('FlowsView list-page (M2.1 fidelity)', () => {
  let originalFetch: typeof globalThis.fetch

  beforeEach(() => {
    originalFetch = globalThis.fetch
    pushMock.mockReset()
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      const url = typeof input === 'string' ? input : input.toString()
      if (url.startsWith('/api/flows/runs/')) {
        return new Response(JSON.stringify({ success: true, data: { runId: 'R-8821', spans: [] } }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        })
      }
      if (/^\/api\/flows\/[^/]+$/.test(url)) {
        return new Response(JSON.stringify({ success: true, data: FLOW_DETAIL_FIXTURE }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        })
      }
      // /api/flows (list)
      return new Response(JSON.stringify({ success: true, data: FLOWS_FIXTURE }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })
    }) as typeof globalThis.fetch
  })

  // Restore the real fetch so other suites aren't poisoned.
  afterEach(() => {
    globalThis.fetch = originalFetch
  })

  // Imported lazily so the `next/navigation` mock above takes effect first.
  async function renderView(): Promise<{ rerender: (ui: ReactElement) => void }> {
    const { FlowsView } = await import('@/components/flows-view')
    const result = render(<FlowsView />)
    return { rerender: result.rerender }
  }

  it('renders the scope tabs (mine / all / archived) with counts', async () => {
    await renderView()
    // The three scope tabs exist, with their data-scope + count spans.
    const mine = await screen.findByRole('tab', { name: /我的/ })
    const all = await screen.findByRole('tab', { name: /全部/ })
    const archived = await screen.findByRole('tab', { name: /已归档/ })
    expect(mine).toHaveAttribute('data-scope', 'mine')
    expect(all).toHaveAttribute('data-scope', 'all')
    expect(archived).toHaveAttribute('data-scope', 'archived')
    // `all` is selected by default (matches design agentflows.html:159).
    expect(all).toHaveAttribute('aria-selected', 'true')
    expect(mine).toHaveAttribute('aria-selected', 'false')
  })

  it('renders the four status filter chips with aria-pressed toggling', async () => {
    await renderView()
    const running = await screen.findByRole('button', { name: '运行中' })
    expect(running).toHaveAttribute('data-f', 'status')
    expect(running).toHaveAttribute('data-v', 'running')
    expect(running).toHaveAttribute('aria-pressed', 'false')

    await userEvent.click(running)
    expect(running).toHaveAttribute('aria-pressed', 'true')

    // Toggling again turns it back off.
    await userEvent.click(running)
    expect(running).toHaveAttribute('aria-pressed', 'false')

    // The other three chips are present too.
    expect(screen.getByRole('button', { name: '已完成' })).toHaveAttribute('data-v', 'done')
    expect(screen.getByRole('button', { name: '已暂停' })).toHaveAttribute('data-v', 'paused')
    expect(screen.getByRole('button', { name: '失败' })).toHaveAttribute('data-v', 'failed')
  })

  it('renders a flow-card per visible flow with the design sub-meta', async () => {
    await renderView()
    // The running flow's card is visible under the default `all` scope.
    const card = await screen.findByText('论文批量复现流水线')
    const head = card.closest('.flow-card')!.querySelector('.flow-card-head') as HTMLElement
    expect(head).toHaveAttribute('data-toggle')
    expect(head).toHaveAttribute('aria-expanded', 'false')
    // The card surfaces the run count + current run chip (design .sub + .chip).
    expect(head.textContent).toContain('次运行')
    expect(head.textContent).toContain('R-8821')
  })

  it('expands a flow-card to reveal its run history rows', async () => {
    await renderView()
    const head = (await screen.findByText('论文批量复现流水线'))
      .closest('.flow-card')!.querySelector('.flow-card-head') as HTMLElement
    await userEvent.click(head)
    expect(head).toHaveAttribute('aria-expanded', 'true')
    // The expanded card surfaces at least one run-row carrying the latest run id.
    const card = head.closest('.flow-card')!
    const runs = card.querySelector('.flow-runs')
    expect(runs).not.toBeNull()
    expect(runs!.textContent).toContain('R-8821')
  })

  it('filters flows by status when a chip is pressed (paused → archived flow)', async () => {
    await renderView()
    // Both flows are visible under `all` initially (await the async fetch).
    expect(await screen.findByText('论文批量复现流水线')).toBeInTheDocument()
    expect(await screen.findByText('发布门控（HITL）')).toBeInTheDocument()

    // Press `失败` (failed) — neither fixture flow is failed, so the list empties.
    const failed = screen.getByRole('button', { name: '失败' })
    await userEvent.click(failed)
    expect(failed).toHaveAttribute('aria-pressed', 'true')
    expect(screen.queryByText('论文批量复现流水线')).not.toBeInTheDocument()
    expect(screen.queryByText('发布门控（HITL）')).not.toBeInTheDocument()

    // The empty-state copy the design renders when no flow matches.
    expect(screen.getByText(/没有匹配的 flow/)).toBeInTheDocument()
  })

  it('the edit button routes to /flows/:id/edit (M2.3 route wiring)', async () => {
    await renderView()
    const card = (await screen.findByText('论文批量复现流水线')).closest('.flow-card') as HTMLElement
    const editBtn = within(card).getByRole('button', { name: /编辑画布/ })
    expect(editBtn).toHaveAttribute('data-action', 'edit')
    expect(editBtn).toHaveAttribute('data-flow-id', 'flow_repro_01')
    await userEvent.click(editBtn)
    expect(pushMock).toHaveBeenCalledWith('/flows/flow_repro_01/edit')
  })

  it('the run button has data-action=run and data-flow-id (showDetail wiring)', async () => {
    await renderView()
    const card = (await screen.findByText('论文批量复现流水线')).closest('.flow-card') as HTMLElement
    // The card's run button — `▶ 运行` (the ▶ prefix makes the accessible
    // name distinct from the run-row's "运行" status badge text).
    const runBtn = within(card).getByRole('button', { name: /▶ 运行/ })
    expect(runBtn).toHaveAttribute('data-action', 'run')
    expect(runBtn).toHaveAttribute('data-flow-id', 'flow_repro_01')
  })
})
