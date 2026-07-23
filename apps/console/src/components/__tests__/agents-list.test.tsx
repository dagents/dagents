/**
 * Agents list-page fidelity tests (v0.3-M5.1).
 *
 * Pins the design/agents.html list-page DOM + interactions the redesign moves
 * `agents-view.tsx` onto — the scope tabs (mine / all / archived) with counts,
 * the `#result-count` `N / total` readout, the sortable list headers
 * (`data-sort` / `data-active` / `data-dir` + `aria-sort`), and the filter
 * chips' `aria-pressed` toggle (design agents.html:169-172, 228-239, 463-477).
 * The fetch to `/api/agents` is stubbed with a raw snake_case dispatch envelope
 * (what the proxy returns) so `fetchAgents`'s real row-mapping runs end-to-end,
 * matching the pattern in `flows-list.test.tsx` and the agent-detail suite.
 *
 * Scope: list-page surface only. The drawer (AgentDrawer) mounts under the
 * same fetch stub but its internals aren't asserted here — that's the detail
 * page's job (M4.1).
 *
 * NOTE: the kanban view is always mounted in the DOM (hidden by CSS when the
 * list view is active), so an agent name renders in BOTH the table row and the
 * kanban card. Text queries for a specific agent are therefore scoped to the
 * `.table-wrap` container so they don't collide with the kanban.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { render, screen, fireEvent, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import type { ReactElement } from 'react'

// A raw snake_case `AgentListRow[]` envelope — what `GET /api/agents` returns
// from dispatch (before `fetchAgents` maps it). Two active rows + one failed
// (archived) row so the `all` scope shows 2 and the `archived` scope shows 1;
// kinds/roles cover the filter chips the design renders.
//
// Loads are deliberately clock-independent so the sort-order test is stable at
// any runtime: reader-04 is `running` with no `task_created_at` (→ elapsedMs
// null → the 50 load band), coder-12 is `queued` (→ load 10). Different
// loads → the default load-desc order reverses cleanly under load-asc.
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

describe('AgentsView list-page (M5.1 fidelity)', () => {
  let originalFetch: typeof globalThis.fetch

  beforeEach(() => {
    originalFetch = globalThis.fetch
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      const url = typeof input === 'string' ? input : input.toString()
      // The drawer fires detail + logs fetches on row open; return minimal
      // envelopes so they resolve without 404-ing mid-interaction.
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

  // Restore the real fetch so other suites aren't poisoned.
  afterEach(() => {
    globalThis.fetch = originalFetch
  })

  // The list view container — scoped so agent-name text queries don't collide
  // with the always-mounted (CSS-hidden) kanban, which renders the same names.
  function listWrap(): HTMLElement {
    const el = document.querySelector('.table-wrap')
    if (!el) throw new Error('.table-wrap not rendered')
    return el as HTMLElement
  }

  /** The visible list rows in DOM order (the order `sort` produced). */
  function listRows(): HTMLElement[] {
    return Array.from(document.querySelectorAll<HTMLElement>('table.data tbody tr'))
  }

  /** The agent name (trimmed) rendered in the nth list row. */
  function rowName(idx: number): string {
    const rows = listRows()
    const cell = rows[idx]?.querySelector('.agent-name')
    if (!cell) throw new Error(`row ${idx} has no .agent-name`)
    return (cell.textContent ?? '').trim()
  }

  // Imported lazily so the fetch stub above is in place before the view's
  // mount effect fires.
  async function renderView(): Promise<{ rerender: (ui: ReactElement) => void }> {
    const { AgentsView } = await import('@/components/agents-view')
    const result = render(<AgentsView />)
    return { rerender: result.rerender }
  }

  it('renders the scope tabs (mine / all / archived) with counts', async () => {
    await renderView()
    const mine = await screen.findByRole('tab', { name: /我的/ })
    const all = await screen.findByRole('tab', { name: /全部/ })
    const archived = await screen.findByRole('tab', { name: /已归档/ })

    expect(mine).toHaveAttribute('data-scope', 'mine')
    expect(all).toHaveAttribute('data-scope', 'all')
    expect(archived).toHaveAttribute('data-scope', 'archived')

    // `all` is selected by default (matches design agents.html:171).
    expect(all).toHaveAttribute('aria-selected', 'true')
    expect(mine).toHaveAttribute('aria-selected', 'false')

    // Counts: 2 active (all) + 1 archived (the failed row); mine is 0 (no owner).
    expect(all.textContent).toContain('2')
    expect(archived.textContent).toContain('1')
    expect(mine.textContent).toContain('0')
  })

  it('renders the result-count as `N / total`', async () => {
    await renderView()
    // Wait for the fetch to settle, then the count reads `2 / 2` under `all`.
    const count = await screen.findByTestId('result-count')
    expect(count).toHaveTextContent(/\d+\s*\/\s*\d+/)
    expect(count.textContent).toMatch(/^2\s*\/\s*2$/)
  })

  it('switching to the archived scope re-scopes the list + result-count', async () => {
    await renderView()
    // Wait for the default `all` list to render both active agents.
    expect(await within(listWrap()).findByText('论文阅读 · reader-04')).toBeInTheDocument()

    const archived = screen.getByRole('tab', { name: /已归档/ })
    await userEvent.click(archived)
    expect(archived).toHaveAttribute('aria-selected', 'true')

    // The archived scope holds only the failed fetcher; the two active agents
    // drop out, and the result-count reads `1 / 1`.
    expect(within(listWrap()).getByText('网页抓取 · fetcher-18')).toBeInTheDocument()
    expect(within(listWrap()).queryByText('论文阅读 · reader-04')).not.toBeInTheDocument()
    expect(screen.getByTestId('result-count').textContent).toMatch(/^1\s*\/\s*1$/)
  })

  it('the 负载 column header sorts by load (data-sort=load), default active', async () => {
    await renderView()
    expect(await within(listWrap()).findByText('论文阅读 · reader-04')).toBeInTheDocument()

    // The 负载 header carries data-sort=load and is the default-active sort.
    const loadHead = screen.getByRole('button', { name: /负载/ })
    expect(loadHead).toHaveAttribute('data-sort', 'load')
    expect(loadHead).toHaveAttribute('data-active', 'true')
    // Default direction is desc (busiest first) — surfaced in DOM + a11y.
    expect(loadHead).toHaveAttribute('data-dir', 'desc')

    // The <th> mirrors the direction for assistive tech.
    const loadTh = loadHead.closest('th')
    expect(loadTh).toHaveAttribute('aria-sort', 'descending')
  })

  it('clicking a sortable header marks it active (data-active=true) and sets aria-sort', async () => {
    await renderView()
    expect(await within(listWrap()).findByText('论文阅读 · reader-04')).toBeInTheDocument()

    // The Agent column header carries data-sort=name and starts inactive.
    const nameHead = screen.getByRole('button', { name: /^Agent/ })
    expect(nameHead).toHaveAttribute('data-sort', 'name')
    expect(nameHead).toHaveAttribute('data-active', 'false')
    // Inactive headers report aria-sort=none on the <th>.
    expect(nameHead.closest('th')).toHaveAttribute('aria-sort', 'none')

    await userEvent.click(nameHead)
    expect(nameHead).toHaveAttribute('data-active', 'true')
    expect(nameHead).toHaveAttribute('data-dir', 'asc')
    expect(nameHead.closest('th')).toHaveAttribute('aria-sort', 'ascending')
  })

  it('toggling the same header flips the direction and reverses the row order', async () => {
    await renderView()
    expect(await within(listWrap()).findByText('论文阅读 · reader-04')).toBeInTheDocument()

    const loadHead = screen.getByRole('button', { name: /负载/ })
    expect(loadHead).toHaveAttribute('data-dir', 'desc')

    // Default sort is load desc (busiest first). reader-04's load (50) outranks
    // coder-12's (10), so desc puts reader-04 on top — capture that order first.
    expect(rowName(0)).toBe('论文阅读 · reader-04')
    expect(rowName(1)).toBe('代码复现 · coder-12')

    // First click flips the active column's direction desc → asc.
    await userEvent.click(loadHead)
    expect(loadHead).toHaveAttribute('data-active', 'true')
    expect(loadHead).toHaveAttribute('data-dir', 'asc')
    expect(loadHead.closest('th')).toHaveAttribute('aria-sort', 'ascending')

    // Ascending load → the lower-load coder-12 (load 10) lands first, the
    // higher-load reader-04 (load 50) second: the row order reversed from desc.
    expect(rowName(0)).toBe('代码复现 · coder-12')
    expect(rowName(1)).toBe('论文阅读 · reader-04')

    // Second click flips back to desc — rows reverse again.
    await userEvent.click(loadHead)
    expect(loadHead).toHaveAttribute('data-dir', 'desc')
    expect(loadHead.closest('th')).toHaveAttribute('aria-sort', 'descending')
    expect(rowName(0)).toBe('论文阅读 · reader-04')
    expect(rowName(1)).toBe('代码复现 · coder-12')
  })

  it('clicking a different header deactivates the previous one', async () => {
    await renderView()
    expect(await within(listWrap()).findByText('论文阅读 · reader-04')).toBeInTheDocument()

    const loadHead = screen.getByRole('button', { name: /负载/ })
    // load is the default-active sort.
    expect(loadHead).toHaveAttribute('data-active', 'true')

    const nameHead = screen.getByRole('button', { name: /^Agent/ })
    await userEvent.click(nameHead)
    expect(nameHead).toHaveAttribute('data-active', 'true')
    expect(loadHead).toHaveAttribute('data-active', 'false')
    // An inactive header reports aria-sort=none (its data-dir resets to asc).
    expect(loadHead).toHaveAttribute('data-dir', 'asc')
    expect(loadHead.closest('th')).toHaveAttribute('aria-sort', 'none')
  })

  it('filter chip toggles aria-pressed', async () => {
    await renderView()
    expect(await within(listWrap()).findByText('论文阅读 · reader-04')).toBeInTheDocument()

    // The `coding` role chip is unpressed initially.
    const chip = screen.getByRole('button', { name: 'coding' })
    expect(chip).toHaveAttribute('aria-pressed', 'false')
    expect(chip).toHaveAttribute('data-f', 'role')
    expect(chip).toHaveAttribute('data-v', 'coding')

    fireEvent.click(chip)
    expect(chip).toHaveAttribute('aria-pressed', 'true')

    // Toggling again turns it back off.
    fireEvent.click(chip)
    expect(chip).toHaveAttribute('aria-pressed', 'false')
  })

  it('a kind filter chip narrows the list + updates result-count', async () => {
    await renderView()
    expect(await within(listWrap()).findByText('论文阅读 · reader-04')).toBeInTheDocument()
    expect(within(listWrap()).getByText('代码复现 · coder-12')).toBeInTheDocument()

    // Press `Codex` — only coder-12 remains (2 active → 1).
    const codex = screen.getByRole('button', { name: 'Codex' })
    expect(codex).toHaveAttribute('data-f', 'kind')
    expect(codex).toHaveAttribute('data-v', 'codex')
    fireEvent.click(codex)
    expect(codex).toHaveAttribute('aria-pressed', 'true')

    expect(within(listWrap()).queryByText('论文阅读 · reader-04')).not.toBeInTheDocument()
    expect(within(listWrap()).getByText('代码复现 · coder-12')).toBeInTheDocument()
    expect(screen.getByTestId('result-count').textContent).toMatch(/^1\s*\/\s*2$/)
  })

  it('renders a row per visible agent under the default all scope', async () => {
    await renderView()
    expect(await within(listWrap()).findByText('论文阅读 · reader-04')).toBeInTheDocument()
    expect(within(listWrap()).getByText('代码复现 · coder-12')).toBeInTheDocument()

    // Two active rows render (the failed fetcher is archived, not under `all`).
    const rows = document.querySelectorAll('table.data tbody tr')
    expect(rows).toHaveLength(2)
  })

  it('a row click opens the drawer (detail fetch wired)', async () => {
    await renderView()
    const row = (await within(listWrap()).findByText('论文阅读 · reader-04')).closest('tr') as HTMLElement
    expect(row).not.toBeNull()
    await userEvent.click(row)
    // The drawer's head surfaces the agent name once the detail resolves.
    const drawer = document.querySelector('.drawer.open')
    expect(drawer).not.toBeNull()
    expect(within(drawer as HTMLElement).getByText('论文阅读 · reader-04')).toBeInTheDocument()
  })
})
