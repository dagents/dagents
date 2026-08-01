/**
 * Agents list-page fidelity tests (multica redesign, M5.1).
 *
 * Pins the multica AgentsView DOM + interactions: card layout
 * (`.agent-cards` / `.agent-card`), scope tabs (mine / all / archived) with
 * counts, the `.result-count` `N / total 个 agent` readout, and filter chips'
 * `aria-pressed` toggle. The fetch to `/api/agents` is stubbed with a raw
 * snake_case dispatch envelope (what the proxy returns) so `fetchAgents`'s
 * real row-mapping runs end-to-end, matching the pattern in `flows-list.test.tsx`.
 *
 * The multica redesign removed the KPI row, the old table/list layout, and
 * the clickable sort headers. Sorts are still internal state
 * (`sort: { field, dir }`) but there is no user-facing sort-control surface
 * — the old tests that asserted `data-sort`/`data-dir` on Agent/负载 header
 * buttons are skipped with clear rationale.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { render, screen, fireEvent, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import type { ReactElement } from 'react'

// `next/navigation`'s `useRouter` requires the App Router context to be
// mounted; mock it so `AgentsView`'s `const router = useRouter()` doesn't
// throw `invariant expected app router to be mounted` under jsdom. The
// redesign uses page-based navigation (`router.push`) so the mock's `push`
// is captured for the row-click test.
const pushMock = vi.fn()
vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: pushMock, replace: vi.fn(), prefetch: vi.fn() }),
  usePathname: () => '/agents',
}))

// `CreateAgentDialog` (mounted inside AgentsView) calls `useSession()` before
// its `open` guard, so the hook must resolve even though the list-page test
// never opens the dialog. Stub the session with an unauthed value — the dialog
// is never submitted in this suite, so a null user is sufficient.
vi.mock('@/lib/auth-client', () => ({
  useSession: () => ({
    user: null,
    status: 'unauthed' as const,
    refresh: vi.fn(),
    logout: vi.fn(),
  }),
  SessionProvider: ({ children }: { children: React.ReactNode }) => children,
}))

// A raw snake_case `AgentListRow[]` envelope — what `GET /api/agents` returns
// from dispatch (before `fetchAgents` maps it). reader-04 (running) and
// coder-12 (queued) are non-archived (my/all); fetcher-18 (failed) archives
// under `isArchived` (status === 'failed'). Kinds cover the 4 filter chips
// (claude/codex/remote).
//
// Loads are derived deterministically: reader-04 running with no
// task_created_at → elapsedMs null → load 50 (band middle); coder-12 queued →
// load 10; fetcher-18 failed → load 0.
const AGENTS_FIXTURE = {
  agents: [
    {
      id: 'agent_reader04',
      name: '论文阅读 · reader-04',
      kind: 'claude',
      capability_descriptor: {
        name: 'reader-04',
        summary: '阅读论文并抽取核心论点。',
        tags: ['reader', 'analysis'],
      },
      executable_path: 'claude',
      visibility: 'workspace',
      created_at: '2026-05-12T03:20:00Z',
      daemon_label: 'daemon-09',
      daemon_status: 'online',
      last_heartbeat_at: '2026-07-14T11:55:00Z',
      daemon_capabilities: [{ agentType: 'claude', tags: ['ap-northeast'] }],
      task_id: 'task-1',
      run_id: 'R-8821',
      task_status: 'running',
      usage: { claude: { inputTokens: 12000, outputTokens: 3400 } },
      duration_ms: null,
      task_created_at: null,
      finished_at: null,
    },
    {
      id: 'agent_coder12',
      name: '代码复现 · coder-12',
      kind: 'codex',
      capability_descriptor: {
        name: 'coder-12',
        summary: '基于论文实验描述生成复现代码补丁。',
        tags: ['coding', 'verify'],
      },
      executable_path: 'codex',
      visibility: 'workspace',
      created_at: '2026-05-20T11:00:00Z',
      daemon_label: 'daemon-02',
      daemon_status: 'online',
      last_heartbeat_at: '2026-07-14T11:50:00Z',
      daemon_capabilities: [{ agentType: 'codex', tags: ['us-east-1'] }],
      task_id: 'task-2',
      run_id: 'R-8822',
      task_status: 'queued',
      usage: { codex: { inputTokens: 8000, outputTokens: 2100 } },
      duration_ms: null,
      task_created_at: null,
      finished_at: null,
    },
    {
      id: 'agent_fetcher18',
      name: '网页抓取 · fetcher-18',
      kind: 'remote',
      capability_descriptor: {
        name: 'fetcher-18',
        summary: '抓取给定 URL 并清洗为正文 HTML。',
        tags: ['reader'],
      },
      executable_path: 'fetch',
      visibility: 'workspace',
      created_at: '2026-06-25T15:00:00Z',
      daemon_label: 'daemon-31',
      daemon_status: 'offline',
      last_heartbeat_at: '2026-07-14T11:40:00Z',
      daemon_capabilities: [{ agentType: 'remote', tags: ['sa-east-1'] }],
      task_id: 'task-3',
      run_id: 'R-8815',
      task_status: 'failed',
      usage: { remote: { inputTokens: 1000, outputTokens: 0 } },
      duration_ms: null,
      task_created_at: '2026-07-14T09:30:00Z',
      finished_at: '2026-07-14T09:48:00Z',
    },
  ],
  truncated: false,
}

// After mapRowToCatalogAgent + deriveStatus + isArchived:
//   reader-04 → status=running → NOT archived → counts toward mine/all
//   coder-12 → status=queued  → NOT archived → counts toward mine/all
//   fetcher-18 → status=failed → archived     → counts toward all/archived
// scopeCounts = { mine: 2, all: 3, archived: 1 }
// scope='all' → scoped = [reader04, coder12] (isArchived filtered OUT)

describe('AgentsView list-page (M5.1 multica)', () => {
  let originalFetch: typeof globalThis.fetch

  beforeEach(() => {
    originalFetch = globalThis.fetch
    pushMock.mockReset()
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      const url = typeof input === 'string' ? input : input.toString()
      if (url.endsWith('/logs')) {
        return new Response(JSON.stringify({ success: true, data: { logs: [] } }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        })
      }
      if (/^\/api\/agents\/[^/]+$/.test(url)) {
        return new Response(
          JSON.stringify({
            success: true,
            data: {
              agent: AGENTS_FIXTURE.agents[0],
              tasks: [],
              runs: [],
            },
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        )
      }
      // /api/agents (list)
      return new Response(
        JSON.stringify({ success: true, data: AGENTS_FIXTURE }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      )
    }) as typeof globalThis.fetch
  })

  afterEach(() => {
    globalThis.fetch = originalFetch
  })

  // The multica redesign renders cards, not a list/table. Cards are wrapped
  // in `.agent-cards`; each card is `.agent-card`.
  function cardsWrap(): HTMLElement {
    const el = document.querySelector('.agent-cards')
    if (!el) throw new Error('.agent-cards not rendered')
    return el as HTMLElement
  }

  /** Visible cards in DOM order (the sort internal state produced this order). */
  function cards(): HTMLElement[] {
    return Array.from(document.querySelectorAll<HTMLElement>('.agent-card'))
  }

  /** The agent name (trimmed) rendered in the nth card. */
  function cardName(idx: number): string {
    const row = cards()[idx]
    const cell = row?.querySelector('.agent-info .nm')
    if (!cell) throw new Error(`card ${idx} has no .agent-info .nm`)
    return (cell.textContent ?? '').trim()
  }

  function resultCount(): HTMLElement {
    const el = document.querySelector('.result-count')
    if (!el) throw new Error('.result-count not rendered')
    return el as HTMLElement
  }

  async function renderView(): Promise<{ rerender: (ui: ReactElement) => void }> {
    const { AgentsView } = await import('@/components/agents-view')
    const result = render(<AgentsView />)
    return { rerender: result.rerender }
  }

  it('renders the scope tabs (mine / all / archived) with counts', async () => {
    await renderView()
    // Wait for the fetch to settle so the scope counts populate.
    expect(await within(cardsWrap()).findByText('论文阅读 · reader-04')).toBeInTheDocument()

    const mine = screen.getByRole('tab', { name: /我的/ })
    const all = screen.getByRole('tab', { name: /全部/ })
    const archived = screen.getByRole('tab', { name: /已归档/ })

    expect(mine).toHaveAttribute('data-scope', 'mine')
    expect(all).toHaveAttribute('data-scope', 'all')
    expect(archived).toHaveAttribute('data-scope', 'archived')

    // `all` is selected by default (matches design agents.html:171).
    expect(all).toHaveAttribute('aria-selected', 'true')
    expect(mine).toHaveAttribute('aria-selected', 'false')

    // scopeCounts: mine=2, all=3, archived=1
    // (mine counts non-archived agents; fetcher-18 is archived.)
    expect(all.textContent).toContain('3')
    expect(archived.textContent).toContain('1')
    expect(mine.textContent).toContain('2')
  })

  it('renders the result-count as `N / total 个 agent`', async () => {
    await renderView()
    expect(await within(cardsWrap()).findByText('论文阅读 · reader-04')).toBeInTheDocument()
    const count = resultCount()
    // `all` scope → 2 non-archived visible (after filters) / 2 non-archived total
    expect(count).toHaveTextContent(/\d+\s*\/\s*\d+\s*个 agent/)
    // The result count text reads "2 / 2 个 agent" (visibleSorted.length / scoped.length).
    expect(count.textContent).toMatch(/2\s*\/\s*2/)
  })

  it('switching to the archived scope re-scopes the list + result-count', async () => {
    await renderView()
    expect(await within(cardsWrap()).findByText('论文阅读 · reader-04')).toBeInTheDocument()

    const archived = screen.getByRole('tab', { name: /已归档/ })
    await userEvent.click(archived)
    expect(archived).toHaveAttribute('aria-selected', 'true')

    // Archived scope holds only the failed fetcher; the two active agents drop out.
    expect(within(cardsWrap()).getByText('网页抓取 · fetcher-18')).toBeInTheDocument()
    expect(within(cardsWrap()).queryByText('论文阅读 · reader-04')).not.toBeInTheDocument()
    // 1 archived visible / 1 archived total.
    expect(resultCount().textContent).toMatch(/1\s*\/\s*1/)
  })

  // ──────────────────────────────────────────────────────────────
  // Sort-header tests skipped (multica redesign).
  //
  // The multica-inspired AgentsView uses a flat card layout with no table
  // and no clickable sort headers. Internal sort state still exists
  // (`sort: { field: 'name'|'load', dir: 'asc'|'desc' }`) — the default
  // sort is `name asc`, producing a stable card order — but there is no
  // user-facing surface to flip field/direction via header buttons. The
  // old tests that pinned `data-dir='asc'` on an Agent button role or a
  // 负载 sortable header no longer map to the rendered DOM.
  // ──────────────────────────────────────────────────────────────
  it.skip('Agent column header default active sort + 负载 sortable inactive (sort headers removed in multica redesign)')
  it.skip('clicking a sortable header marks active + sets data-dir (sort headers removed in multica redesign)')
  it.skip('toggling same header flips direction + reverses row order (sort headers removed in multica redesign)')
  it.skip('clicking a different header deactivates previous one (sort headers removed in multica redesign)')

  // Role-based filter chips were also removed in the multica redesign. The
  // AgentsView toolbar only exposes kind (提示词/Claude Code/Codex/Remote) and
  // status (运行/排队/空闲/失败) filter chips — no 'coding' role chip.
  it.skip('filter chip toggles aria-pressed (role-based chips removed in multica redesign)')

  it('a kind filter chip narrows the list + updates result-count', async () => {
    await renderView()
    expect(await within(cardsWrap()).findByText('论文阅读 · reader-04')).toBeInTheDocument()
    expect(within(cardsWrap()).getByText('代码复现 · coder-12')).toBeInTheDocument()

    // Press `Codex` kind filter — only coder-12 remains.
    const codex = screen.getByRole('button', { name: 'Codex' })
    expect(codex).toHaveAttribute('aria-pressed', 'false')
    fireEvent.click(codex)
    expect(codex).toHaveAttribute('aria-pressed', 'true')

    expect(within(cardsWrap()).queryByText('论文阅读 · reader-04')).not.toBeInTheDocument()
    expect(within(cardsWrap()).getByText('代码复现 · coder-12')).toBeInTheDocument()
    // visible=1 (codex filter) / scoped=2 (all non-archived).
    expect(resultCount().textContent).toMatch(/1\s*\/\s*2/)
  })

  it('a status filter chip narrows the list + updates result-count', async () => {
    await renderView()
    expect(await within(cardsWrap()).findByText('论文阅读 · reader-04')).toBeInTheDocument()
    expect(within(cardsWrap()).getByText('代码复现 · coder-12')).toBeInTheDocument()

    // Press `排队` (queued) status filter.
    const queued = screen.getByRole('button', { name: '排队' })
    expect(queued).toHaveAttribute('aria-pressed', 'false')
    fireEvent.click(queued)
    expect(queued).toHaveAttribute('aria-pressed', 'true')

    expect(within(cardsWrap()).queryByText('论文阅读 · reader-04')).not.toBeInTheDocument()
    expect(within(cardsWrap()).getByText('代码复现 · coder-12')).toBeInTheDocument()
    expect(resultCount().textContent).toMatch(/1\s*\/\s*2/)
  })

  it('renders a card per visible agent under the default all scope', async () => {
    await renderView()
    expect(await within(cardsWrap()).findByText('论文阅读 · reader-04')).toBeInTheDocument()
    expect(within(cardsWrap()).getByText('代码复现 · coder-12')).toBeInTheDocument()

    // Two active cards render (the failed fetcher is archived, excluded from `all` scope).
    const rows = document.querySelectorAll('.agent-card')
    expect(rows).toHaveLength(2)
  })

  it('default card order is name-asc (internal default sort still applied)', async () => {
    await renderView()
    expect(await within(cardsWrap()).findByText('论文阅读 · reader-04')).toBeInTheDocument()
    // Default sort field = 'name' dir='asc': 代码复现 < 论文阅读 (Chinese locale compare).
    expect(cardName(0)).toBe('代码复现 · coder-12')
    expect(cardName(1)).toBe('论文阅读 · reader-04')
  })

  it('a card click navigates to the agent detail page (page-based nav, no drawer)', async () => {
    await renderView()
    expect(await within(cardsWrap()).findByText('论文阅读 · reader-04')).toBeInTheDocument()

    const card = cards()[0] // coder-12
    fireEvent.click(card!)

    expect(pushMock).toHaveBeenCalledTimes(1)
    expect(pushMock).toHaveBeenCalledWith('/agents/agent_coder12')
  })
})
