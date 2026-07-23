/**
 * New-task picker modal tests (v0.3-M3.1 / audit §2.1).
 *
 * Pins the design/new-task.html picker behavior the NewTaskView ports to
 * React — the two `.nt-picker.open` popovers (#nt-picker-flow「选择 AgentFlow」
 * and #nt-picker-agent「选择 Agent」), their `[data-picker-backdrop]`, the
 * `.nt-flow-search` / `.nt-agent-search` inputs, and the option → setAssoc +
 * closePickers flow (design new-task.html:461-546).
 *
 * The fetches to `/api/flows` and `/api/agents` are stubbed so the suite runs
 * without a gateway/dispatch; `next/navigation`'s `useRouter` is mocked so the
 * send button's `router.push('/workspace?new=1&...')` wiring can be asserted
 * without the workspace route consuming the query string (audit §2 notes the
 * workspace `?new=1` consumer is a later task — here we only assert the handoff
 * URL is built correctly).
 *
 * Scope: open/close/pick + multi-select toggle + search filter + send handoff.
 * The directory card (audit §2.3) and ⏎⇧⏎ shortcuts (audit §2.2) are exercised
 * only where they intersect the picker send state.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'

// `next/navigation` is a server-context module jsdom can't resolve; mock it
// before importing the view. The send button builds a query string and pushes
// to `/workspace?new=1&...` — we capture the path so the test can assert the
// handoff without the workspace route existing/consuming `?new=1`.
const pushMock = vi.fn()
vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: pushMock, replace: vi.fn(), prefetch: vi.fn() }),
  usePathname: () => '/tasks/new',
}))

// Stub `/api/flows` (list) + `/api/agents` (list) so the component's mount
// effects resolve without a gateway/dispatch. The agents fixture carries the
// **real dispatch `AgentListRow` wire shape** (snake_case, `roles` derived from
// `capability_descriptor.tags` by the shared `fetchAgents()`/`mapRowToCatalogAgent`
// — see apps/console/src/lib/agents-catalog.ts). The view reads `CatalogAgent`
// fields, NOT raw row fields, so this fixture must match the raw row or the
// picker silently renders empty (the very bug M3.1's review caught).
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

// Real dispatch GET /agents envelope: { success, data: { agents: AgentListRow[], truncated } }.
// AgentListRow is snake_case from pg — `roles` is NOT a field; the catalogue
// derives it from `capability_descriptor.tags`. Any fixture that wrote
// `roles: [...]` at the row level would mask the real wire contract.
const AGENTS_FIXTURE = {
  success: true,
  data: {
    agents: [
      {
        id: 'agent_01HFK',
        name: '论文阅读 · reader-04',
        kind: 'claude',
        capability_descriptor: { name: 'reader-04', tags: ['reader', 'analysis'] },
        executable_path: null,
        visibility: null,
        created_at: '2026-05-12T03:20:00.000Z',
        daemon_label: 'daemon-09',
        daemon_status: 'online',
        last_heartbeat_at: '2026-07-13T14:10:00.000Z',
        daemon_capabilities: [{ tags: ['ap-northeast'] }],
        task_id: 'task-1',
        run_id: 'R-8821',
        task_status: 'running',
        usage: { claude: { inputTokens: 120000, outputTokens: 80000 } },
        duration_ms: 252000,
        task_created_at: '2026-07-13T14:06:00.000Z',
        finished_at: null,
      },
      {
        id: 'agent_02KDM',
        name: '代码复现 · coder-12',
        kind: 'claude',
        capability_descriptor: { name: 'coder-12', tags: ['coding', 'verify'] },
        executable_path: null,
        visibility: null,
        created_at: '2026-05-12T03:21:00.000Z',
        daemon_label: 'daemon-02',
        daemon_status: 'online',
        last_heartbeat_at: '2026-07-13T14:10:00.000Z',
        daemon_capabilities: [{ tags: ['us-east-1'] }],
        task_id: 'task-2',
        run_id: 'R-8822',
        task_status: 'running',
        usage: { claude: { inputTokens: 300000, outputTokens: 120000 } },
        duration_ms: 408000,
        task_created_at: '2026-07-13T14:00:00.000Z',
        finished_at: null,
      },
    ],
    truncated: false,
  },
} as const

describe('NewTaskView picker modals (M3.1 fidelity)', () => {
  let originalFetch: typeof globalThis.fetch

  beforeEach(() => {
    originalFetch = globalThis.fetch
    pushMock.mockReset()
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      const url = typeof input === 'string' ? input : input.toString()
      if (url.startsWith('/api/agents')) {
        return new Response(JSON.stringify(AGENTS_FIXTURE), {
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
  async function renderView(): Promise<void> {
    const { NewTaskView } = await import('@/components/new-task-view')
    render(<NewTaskView />)
  }

  // ── open ───────────────────────────────────────────────────────────

  it('clicking 关联 Flow opens the flow picker + backdrop and sets aria-expanded', async () => {
    await renderView()
    const addFlow = await screen.findByRole('button', { name: /关联 Flow/ })
    expect(addFlow).toHaveAttribute('aria-expanded', 'false')

    await userEvent.click(addFlow)

    // The flow picker is now open and labeled as a dialog.
    const picker = await screen.findByRole('dialog', { name: '选择 AgentFlow' })
    expect(picker).toHaveClass('nt-picker', 'open')
    expect(addFlow).toHaveAttribute('aria-expanded', 'true')
    // The shared backdrop is shown (design new-task.html:377,527-528). The base
    // `.drawer-backdrop` is opacity:0; the `.open` class flips it visible —
    // assert the class so the visual mask isn't silently regressed.
    const backdrop = document.querySelector('[data-picker-backdrop]') as HTMLElement
    expect(backdrop).not.toBeNull()
    expect(backdrop.hasAttribute('hidden')).toBe(false)
    expect(backdrop).toHaveClass('open')
  })

  it('clicking 关联 Agent opens the agent picker + backdrop', async () => {
    await renderView()
    const addAgent = await screen.findByRole('button', { name: /关联 Agent/ })
    await userEvent.click(addAgent)

    const picker = await screen.findByRole('dialog', { name: '选择 Agent' })
    expect(picker).toHaveClass('nt-picker', 'open')
    expect(addAgent).toHaveAttribute('aria-expanded', 'true')
  })

  it('opening one picker closes the other (only one open at a time)', async () => {
    await renderView()
    const addFlow = await screen.findByRole('button', { name: /关联 Flow/ })
    const addAgent = await screen.findByRole('button', { name: /关联 Agent/ })

    await userEvent.click(addFlow)
    const flowPicker = await screen.findByRole('dialog', { name: '选择 AgentFlow' })
    expect(flowPicker).toHaveClass('open')

    await userEvent.click(addAgent)
    const agentPicker = await screen.findByRole('dialog', { name: '选择 Agent' })
    expect(agentPicker).toHaveClass('open')
    // The flow picker is closed again — only the agent picker is open.
    expect(flowPicker).not.toHaveClass('open')
    expect(addFlow).toHaveAttribute('aria-expanded', 'false')
  })

  // ── close ──────────────────────────────────────────────────────────

  it('Escape closes the open picker and hides the backdrop', async () => {
    await renderView()
    const addFlow = await screen.findByRole('button', { name: /关联 Flow/ })
    await userEvent.click(addFlow)
    const picker = await screen.findByRole('dialog', { name: '选择 AgentFlow' })
    expect(picker).toHaveClass('open')

    await userEvent.keyboard('{Escape}')

    expect(picker).not.toHaveClass('open')
    expect(addFlow).toHaveAttribute('aria-expanded', 'false')
    const backdrop = document.querySelector('[data-picker-backdrop]') as HTMLElement
    expect(backdrop.hasAttribute('hidden')).toBe(true)
    expect(backdrop).not.toHaveClass('open')
  })

  it('clicking the backdrop closes the open picker', async () => {
    await renderView()
    const addFlow = await screen.findByRole('button', { name: /关联 Flow/ })
    await userEvent.click(addFlow)
    const picker = await screen.findByRole('dialog', { name: '选择 AgentFlow' })
    expect(picker).toHaveClass('open')

    const backdrop = document.querySelector('[data-picker-backdrop]') as HTMLElement
    await userEvent.click(backdrop)

    expect(picker).not.toHaveClass('open')
  })

  it('clicking outside the picker and its trigger closes the open picker', async () => {
    await renderView()
    const addFlow = await screen.findByRole('button', { name: /关联 Flow/ })
    await userEvent.click(addFlow)
    const picker = await screen.findByRole('dialog', { name: '选择 AgentFlow' })
    expect(picker).toHaveClass('open')

    // A click on the page body (outside picker + trigger) closes it.
    await userEvent.click(document.body)

    expect(picker).not.toHaveClass('open')
    expect(addFlow).toHaveAttribute('aria-expanded', 'false')
  })

  // ── pick ───────────────────────────────────────────────────────────

  it('picking a flow option adds an assoc-chip to the composer rail and closes the picker', async () => {
    await renderView()
    const addFlow = await screen.findByRole('button', { name: /关联 Flow/ })
    await userEvent.click(addFlow)

    // The flow list rendered both fixture flows as options.
    const flowOpt = await screen.findByRole('button', { name: /论文批量复现流水线/ })
    expect(flowOpt).toHaveAttribute('data-kind', 'flow')
    expect(flowOpt).toHaveAttribute('data-id', 'flow_repro_01')
    await userEvent.click(flowOpt)

    // The picker closed.
    const picker = screen.queryByRole('dialog', { name: '选择 AgentFlow' })
    expect(picker).not.toHaveClass('open')
    expect(addFlow).toHaveAttribute('aria-expanded', 'false')

    // A chip now sits in the composer assoc rail carrying the flow name.
    const rail = document.getElementById('nt-assoc') as HTMLElement
    expect(rail).not.toBeNull()
    const chip = rail.querySelector('.assoc-chip') as HTMLElement
    expect(chip).not.toBeNull()
    expect(chip.textContent).toContain('论文批量复现流水线')
    expect(chip.textContent).toContain('Flow')
  })

  it('picking an agent option adds an assoc-chip labeled Agent', async () => {
    await renderView()
    const addAgent = await screen.findByRole('button', { name: /关联 Agent/ })
    await userEvent.click(addAgent)

    const agentOpt = await screen.findByRole('button', { name: /论文阅读 · reader-04/ })
    expect(agentOpt).toHaveAttribute('data-kind', 'agent')
    await userEvent.click(agentOpt)

    const rail = document.getElementById('nt-assoc') as HTMLElement
    const chips = rail.querySelectorAll('.assoc-chip')
    expect(chips).toHaveLength(1)
    expect(chips[0]!.textContent).toContain('Agent')
    expect(chips[0]!.textContent).toContain('论文阅读 · reader-04')
  })

  it('the agent option meta surfaces roles derived from capability_descriptor.tags', async () => {
    // Guards the wire contract: roles come from capability_descriptor.tags via
    // fetchAgents()/mapRowToCatalogAgent, NOT from a top-level `roles` field.
    // A regression that re-reads a raw row's `roles` would render this empty.
    await renderView()
    const addAgent = await screen.findByRole('button', { name: /关联 Agent/ })
    await userEvent.click(addAgent)

    const coderOpt = await screen.findByRole('button', { name: /代码复现 · coder-12/ })
    // meta line: `${kind} · ${roles.join('/')}` → "claude · coding/verify"
    expect(coderOpt.textContent).toContain('claude · coding/verify')
  })

  it('picking the same option again toggles it off (multi-select toggle)', async () => {
    await renderView()
    const addFlow = await screen.findByRole('button', { name: /关联 Flow/ })
    await userEvent.click(addFlow)

    const flowOpt = await screen.findByRole('button', { name: /论文批量复现流水线/ })
    await userEvent.click(flowOpt)
    let rail = document.getElementById('nt-assoc') as HTMLElement
    expect(rail.querySelectorAll('.assoc-chip')).toHaveLength(1)

    // Re-open and click the same option — it should be removed.
    await userEvent.click(addFlow)
    const flowOptAgain = await screen.findByRole('button', { name: /论文批量复现流水线/ })
    await userEvent.click(flowOptAgain)
    rail = document.getElementById('nt-assoc') as HTMLElement
    expect(rail.querySelectorAll('.assoc-chip')).toHaveLength(0)
  })

  it('the chip remove button toggles the assoc off too', async () => {
    await renderView()
    const addAgent = await screen.findByRole('button', { name: /关联 Agent/ })
    await userEvent.click(addAgent)
    const agentOpt = await screen.findByRole('button', { name: /论文阅读 · reader-04/ })
    await userEvent.click(agentOpt)

    const rail = document.getElementById('nt-assoc') as HTMLElement
    const removeBtn = within(rail).getByRole('button', { name: '移除' })
    await userEvent.click(removeBtn)
    expect(rail.querySelectorAll('.assoc-chip')).toHaveLength(0)
  })

  // ── search ────────────────────────────────────────────────────────

  it('typing in the flow search filters the flow options', async () => {
    await renderView()
    const addFlow = await screen.findByRole('button', { name: /关联 Flow/ })
    await userEvent.click(addFlow)

    const search = await screen.findByPlaceholderText('搜索 AgentFlow…')
    await userEvent.type(search, '门控')

    // Only the matching flow is offered; the non-match is gone.
    expect(screen.getByRole('button', { name: /发布门控/ })).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /论文批量复现流水线/ })).not.toBeInTheDocument()
  })

  // ── send handoff ───────────────────────────────────────────────────

  it('send builds the /workspace?new=1 handoff carrying task + picked flows/agents', async () => {
    await renderView()
    // Type a task into the composer textarea.
    const ta = await screen.findByPlaceholderText(/描述你要完成的任务/)
    await userEvent.type(ta, '复现 attention 消融')

    // Pick a flow + an agent so their ids land in the handoff query string.
    const addFlow = await screen.findByRole('button', { name: /关联 Flow/ })
    await userEvent.click(addFlow)
    const flowOpt = await screen.findByRole('button', { name: /论文批量复现流水线/ })
    await userEvent.click(flowOpt)

    const addAgent = await screen.findByRole('button', { name: /关联 Agent/ })
    await userEvent.click(addAgent)
    const agentOpt = await screen.findByRole('button', { name: /论文阅读 · reader-04/ })
    await userEvent.click(agentOpt)

    const send = screen.getByRole('button', { name: /创建并派发/ })
    expect(send).not.toBeDisabled()
    await userEvent.click(send)

    expect(pushMock).toHaveBeenCalledTimes(1)
    const target = pushMock.mock.calls[0]![0] as string
    expect(target.startsWith('/workspace?new=1&')).toBe(true)
    expect(target).toContain('task=')
    expect(target).toContain('flows=flow_repro_01')
    expect(target).toContain('agents=agent_01HFK')
  })
})
