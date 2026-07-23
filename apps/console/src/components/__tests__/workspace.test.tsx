/**
 * Workspace view fidelity tests (v0.3-M7.1).
 *
 * Pins the two surfaces the redesign moves `workspace-view.tsx` onto, both
 * flagged as gaps by the §6 audit (`docs/v0.3-fidelity-audit.md`):
 *
 *   §6.1 — the ws-chat-head filter chips (全部 / @我 / 未读 / 含 run). The
 *          audit marked 3 of 4 `disabled` no-ops with no onClick. M7.1 wires
 *          all four as single-select toggle chips (`aria-pressed`) that
 *          actually filter the rendered thread (design/workspace.html:106-109
 *          + the toggle at L263-266).
 *
 *   §6.2 — the ws-meta 关联 flow card. The audit marked this ✅ already, but
 *          M7.1 pins the card's DOM (flow name + status + note + open-link)
 *          so the data the gateway's `GET /api/workspaces/:id` returns (the
 *          `flows[]` enriched with live Flowise name/status, per
 *          `apps/gateway/src/routes/workspaces.ts`) renders faithfully and a
 *          regression is caught.
 *
 * The three console routes the view fetches are stubbed via `global.fetch` so
 * the suite runs without a gateway: the project list, the project detail
 * (members + linked flows + quota + artifacts), and the thread (runs). The
 * thread fixture is what drives the filter-chip assertions — it carries a
 * fully-answered turn (user + bot, run id), a still-running turn (user only,
 * no answer → exercises `未读`), and a turn missing its run id (→ exercises
 * `含 run`).
 *
 * `next/link` is stubbed to a plain `<a>` (the meta card's "在 AgentFlows 打开
 * →" link renders without a router context), matching the app-shell test's
 * approach.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import type { ReactNode } from 'react'

// `next/link` renders an `<a>` only inside a Next router context; stub it to a
// plain anchor so the meta card's "在 AgentFlows 打开 →" link mounts under
// jsdom. (Mirrors apps-shell.test.tsx's stub.)
vi.mock('next/link', () => ({
  default: ({ href, children, ...props }: { href: string; children: ReactNode } & Record<string, unknown>) => (
    <a href={href} {...props}>
      {children}
    </a>
  ),
}))

// ─── fixtures ───────────────────────────────────────────────────────────────

const WS_LIST = [
  {
    id: 'ws-rl',
    name: '论文复现 · RL',
    glyph: 'R',
    description: 'RL 复现工作区',
    status: 'active',
    memberCount: 24,
    flowCount: 1,
    createdAt: '2026-07-09T14:20:00.000Z',
  },
] as const

const WS_DETAIL = {
  workspace: {
    id: 'ws-rl',
    name: '论文复现 · RL',
    glyph: 'R',
    description: 'RL 复现工作区',
    ownerUserId: 'u-rz',
    status: 'active',
    quota: {
      cost: { used: 1820, cap: 5000, unit: 'USD' },
      runs: { used: 412, cap: 2000 },
      tokens: { used: 18_400_000, cap: 80_000_000 },
    },
    createdAt: '2026-07-01T08:00:00.000Z',
    updatedAt: '2026-07-14T03:00:00.000Z',
  },
  members: [
    { id: 'm1', memberId: 'u-rz', displayName: '饶哲', initial: 'RZ', role: 'owner' },
  ],
  // Gateway enriches a linked flow's status from Flowise `deployed` only:
  // `idle` (deployed), `paused` (deployed === false), or `unknown` on a
  // fetch miss (apps/gateway/src/routes/workspaces.ts:211,215,416). `running`
  // is never returned, so the fixture uses a real value (`idle`) and the
  // paused/unknown cases are covered by a second detail fixture below.
  flows: [
    {
      id: 'wf-1',
      pipelineId: 'flow_repro_01',
      name: 'flow_repro_01',
      status: 'idle',
      note: '论文批量复现流水线 · v2.3.1',
      updatedAt: '2026-07-14T02:00:00.000Z',
    },
  ],
  artifacts: { reports: 3, datasets: 7, patches: 12 },
} as const

/**
 * The thread fixture. Newest-first (the gateway's order — runs are returned
 * `ORDER BY created_at DESC, id DESC` at
 * apps/gateway/src/routes/workspaces.ts:494, so a faithful fixture descends in
 * time). Three turns:
 *   - run-a (R-8821, today 14:20): user question + bot answer → answered.
 *   - run-b (R-8701, yesterday 11:30): user question + bot answer → answered.
 *   - run-c (R-8600, today 03:00): user question only (run still running, no
 *     output) → the `未读` filter keeps this one (no sibling bot message shares
 *     its runId).
 * `threadToMessages` renders these oldest-first.
 */
const WS_THREAD = [
  {
    id: 'run-a',
    identifier: 'R-8821',
    pipelineId: 'flow_repro_01',
    status: 'completed',
    input: { question: '这批 128 篇 RL 论文按计划复现。' },
    output: { text: '已派发。reader-04 抽取消融描述。' },
    artifactUri: 's3://mil/runs/R-8821/results_skip.csv',
    createdByUserId: 'u-rz',
    traceId: 'trace-a',
    createdAt: '2026-07-14T14:20:00.000Z',
    startedAt: '2026-07-14T14:20:00.000Z',
    finishedAt: '2026-07-14T14:21:00.000Z',
  },
  {
    id: 'run-c',
    identifier: 'R-8600',
    pipelineId: 'flow_repro_01',
    status: 'running',
    input: { question: '这批论文的消融跑完了吗？' },
    output: {},
    artifactUri: null,
    createdByUserId: 'u-rz',
    traceId: 'trace-c',
    createdAt: '2026-07-14T03:00:00.000Z',
    startedAt: '2026-07-14T03:00:00.000Z',
    finishedAt: null,
  },
  {
    id: 'run-b',
    identifier: 'R-8701',
    pipelineId: 'flow_repro_01',
    status: 'completed',
    input: { question: '验证对齐损失对噪声标签的鲁棒性。' },
    output: { text: '10% 噪声下对齐损失下降 4%。' },
    artifactUri: null,
    createdByUserId: 'u-rz',
    traceId: 'trace-b',
    createdAt: '2026-07-13T11:30:00.000Z',
    startedAt: '2026-07-13T11:30:00.000Z',
    finishedAt: '2026-07-13T11:48:00.000Z',
  },
] as const

// ─── fetch stub ──────────────────────────────────────────────────────────────

function jsonResponse(body: unknown, init?: ResponseInit): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json', ...(init?.headers ?? {}) },
  })
}

let originalFetch: typeof globalThis.fetch

beforeEach(() => {
  originalFetch = globalThis.fetch
  const BASE = 'http://localhost'
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = new URL(typeof input === 'string' ? input : input.toString(), BASE)
    const path = url.pathname
    if (path === '/api/workspaces') {
      return jsonResponse({ success: true, data: { items: WS_LIST } })
    }
    if (path === '/api/workspaces/ws-rl/threads') {
      return jsonResponse({ success: true, data: { items: WS_THREAD, nextBefore: null, nextBeforeId: null } })
    }
    if (path.startsWith('/api/workspaces/')) {
      return jsonResponse({ success: true, data: WS_DETAIL })
    }
    return jsonResponse({ success: false, error: 'not found' }, { status: 404 })
  }) as typeof globalThis.fetch
})

afterEach(() => {
  globalThis.fetch = originalFetch
})

// Imported lazily so the `next/link` mock above takes effect first.
async function renderView(): Promise<void> {
  const { WorkspaceView } = await import('@/components/workspace-view')
  render(<WorkspaceView />)
}

// ─── §6.1 ws-chat filter chips ──────────────────────────────────────────────

describe('WorkspaceView — ws-chat filter chips (M7.1)', () => {
  it('renders the four filter chips, 全部 pressed by default', async () => {
    await renderView()
    const all = await screen.findByRole('button', { name: '全部' })
    const mine = screen.getByRole('button', { name: '@我' })
    const unread = screen.getByRole('button', { name: '未读' })
    const hasRun = screen.getByRole('button', { name: '含 run' })
    for (const chip of [all, mine, unread, hasRun]) {
      expect(chip).toHaveAttribute('data-f', 'chat')
    }
    expect(all).toHaveAttribute('data-v', 'all')
    expect(mine).toHaveAttribute('data-v', 'mine')
    expect(unread).toHaveAttribute('data-v', 'unread')
    expect(hasRun).toHaveAttribute('data-v', 'hasRun')
    // 全部 is pressed by default (design/workspace.html:106 aria-pressed=true)
    expect(all).toHaveAttribute('aria-pressed', 'true')
    expect(mine).toHaveAttribute('aria-pressed', 'false')
    expect(unread).toHaveAttribute('aria-pressed', 'false')
    expect(hasRun).toHaveAttribute('aria-pressed', 'false')
    // None are disabled — the audit's "3 of 4 disabled no-op" gap is closed.
    for (const chip of [mine, unread, hasRun]) {
      expect(chip).not.toBeDisabled()
    }
    // @我 carries a tooltip flagging the owner-proxy MVP limit so users don't
    // mistake "all human messages" for "messages mentioning me".
    expect(mine).toHaveAttribute('title', '当前显示所有人类消息（按作者过滤待 post-MVP）')
  })

  it('toggles a chip to pressed and releases the others (single-select)', async () => {
    const user = userEvent.setup()
    await renderView()
    const all = await screen.findByRole('button', { name: '全部' })
    const mine = screen.getByRole('button', { name: '@我' })

    // Click @我 → it becomes pressed, 全部 releases.
    await user.click(mine)
    expect(mine).toHaveAttribute('aria-pressed', 'true')
    expect(all).toHaveAttribute('aria-pressed', 'false')

    // Click 全部 → it becomes pressed, @我 releases.
    await user.click(all)
    expect(all).toHaveAttribute('aria-pressed', 'true')
    expect(mine).toHaveAttribute('aria-pressed', 'false')

    // Re-clicking the active chip is a no-op (stays pressed — the group never
    // allows zero pressed, matching design/workspace.html:263-266).
    await user.click(all)
    expect(all).toHaveAttribute('aria-pressed', 'true')
  })

  it('含 run filters out a turn whose runId is missing, keeps the rest', async () => {
    const user = userEvent.setup()
    // Two of the three fixture turns carry run ids (R-8821, R-8701, R-8600);
    // splice in a fourth turn whose `identifier` is empty so
    // `threadToMessages` drops its runId (it falls back to `row.id` only when
    // `identifier` is truthy — see lib/workspaces.ts `runId: row.identifier ||
    // row.id`). That makes the `含 run` branch actually discriminate.
    const threadWithMissingRunId = [
      ...WS_THREAD,
      {
        id: 'run-d',
        identifier: '',
        pipelineId: 'flow_repro_01',
        status: 'completed',
        input: { question: '第四条问题，无 run 标识。' },
        output: { text: '回答四' },
        artifactUri: null,
        createdByUserId: 'u-rz',
        traceId: 'trace-d',
        createdAt: '2026-07-14T15:00:00.000Z',
        startedAt: '2026-07-14T15:00:00.000Z',
        finishedAt: '2026-07-14T15:01:00.000Z',
      },
    ]
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      const url = new URL(typeof input === 'string' ? input : input.toString(), 'http://localhost')
      const path = url.pathname
      if (path === '/api/workspaces') {
        return jsonResponse({ success: true, data: { items: WS_LIST } })
      }
      if (path === '/api/workspaces/ws-rl/threads') {
        return jsonResponse({ success: true, data: { items: threadWithMissingRunId, nextBefore: null, nextBeforeId: null } })
      }
      if (path.startsWith('/api/workspaces/')) {
        return jsonResponse({ success: true, data: WS_DETAIL })
      }
      return jsonResponse({ success: false, error: 'not found' }, { status: 404 })
    }) as typeof globalThis.fetch

    await renderView()
    // Under 全部, all four user questions are visible — including the
    // runId-less one.
    expect(await screen.findByText('这批 128 篇 RL 论文按计划复现。')).toBeInTheDocument()
    expect(screen.getByText('验证对齐损失对噪声标签的鲁棒性。')).toBeInTheDocument()
    expect(screen.getByText('这批论文的消融跑完了吗？')).toBeInTheDocument()
    expect(screen.getByText('第四条问题，无 run 标识。')).toBeInTheDocument()

    await user.click(screen.getByRole('button', { name: '含 run' }))
    // The runId-less turn is filtered out; the three carrying run ids stay.
    expect(screen.getByText('这批 128 篇 RL 论文按计划复现。')).toBeInTheDocument()
    expect(screen.getByText('验证对齐损失对噪声标签的鲁棒性。')).toBeInTheDocument()
    expect(screen.getByText('这批论文的消融跑完了吗？')).toBeInTheDocument()
    expect(screen.queryByText('第四条问题，无 run 标识。')).not.toBeInTheDocument()
  })

  it('未读 keeps only turns with no bot answer yet (run still running)', async () => {
    const user = userEvent.setup()
    await renderView()
    await user.click(await screen.findByRole('button', { name: '未读' }))
    // Only run-c (R-8600) has no bot answer; the other two turns are answered.
    expect(screen.getByText('这批论文的消融跑完了吗？')).toBeInTheDocument()
    expect(screen.queryByText('这批 128 篇 RL 论文按计划复现。')).not.toBeInTheDocument()
    expect(screen.queryByText('验证对齐损失对噪声标签的鲁棒性。')).not.toBeInTheDocument()
  })

  it('@我 keeps the human turns (project owner proxy)', async () => {
    const user = userEvent.setup()
    await renderView()
    await user.click(await screen.findByRole('button', { name: '@我' }))
    // All three user questions are human turns (the owner's); the bot answers
    // are dropped.
    expect(screen.getByText('这批 128 篇 RL 论文按计划复现。')).toBeInTheDocument()
    expect(screen.getByText('验证对齐损失对噪声标签的鲁棒性。')).toBeInTheDocument()
    expect(screen.getByText('这批论文的消融跑完了吗？')).toBeInTheDocument()
    // A bot answer is present under 全部 but not under @我.
    expect(screen.queryByText('已派发。reader-04 抽取消融描述。')).not.toBeInTheDocument()
  })
})

// ─── §6.2 ws-meta 关联 flow card ─────────────────────────────────────────────

describe('WorkspaceView — ws-meta 关联 flow 卡 (M7.1)', () => {
  it('renders the linked-flow card with name, idle status, note, and open-link', async () => {
    await renderView()
    // The 关联 flow section renders the enriched flow name (Flowise live name
    // = flow_repro_01 here) and the idle status chip (a real gateway value —
    // gateway only ever returns idle/paused/unknown).
    const flowSection = await screen.findByText('关联 flow')
    const card = flowSection.closest('.meta-section')!.querySelector('.card-flat') as HTMLElement
    expect(card).not.toBeNull()
    expect(card.textContent).toContain('flow_repro_01')
    const status = card.querySelector('.status') as HTMLElement
    expect(status).not.toBeNull()
    expect(status.classList.contains('idle')).toBe(true)
    expect(status.textContent).toContain('idle')
    // The note (论文批量复现流水线 · v2.3.1) renders.
    expect(card.textContent).toContain('论文批量复现流水线 · v2.3.1')
    // The "在 AgentFlows 打开 →" link renders (stubbed next/link → <a>).
    const openLink = within(card).getByRole('link', { name: /在 AgentFlows 打开/ })
    expect(openLink).toHaveAttribute('href', '/flows')
  })

  it('renders the paused and unknown flow statuses the gateway can return', async () => {
    // Gateway enriches each linked flow from Flowise `deployed`: `idle`
    // (deployed), `paused` (deployed === false), or `unknown` on a fetch miss
    // (apps/gateway/src/routes/workspaces.ts:211,215,416). Two flows here so
    // both non-idle values render.
    const mixedDetail = {
      ...WS_DETAIL,
      workspace: { ...WS_DETAIL.workspace, id: 'ws-mixed' },
      flows: [
        { id: 'wf-1', pipelineId: 'flow_repro_01', name: 'flow_repro_01', status: 'paused', note: null, updatedAt: null },
        { id: 'wf-2', pipelineId: 'flow_align_02', name: 'flow_align_02', status: 'unknown', note: null, updatedAt: null },
      ],
    }
    const mixedList = [{ ...WS_LIST[0]!, id: 'ws-mixed', name: '混合状态项目', flowCount: 2 }]
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      const url = new URL(typeof input === 'string' ? input : input.toString(), 'http://localhost')
      const path = url.pathname
      if (path === '/api/workspaces') return jsonResponse({ success: true, data: { items: mixedList } })
      if (path.endsWith('/threads')) {
        return jsonResponse({ success: true, data: { items: [], nextBefore: null, nextBeforeId: null } })
      }
      return jsonResponse({ success: true, data: mixedDetail })
    }) as typeof globalThis.fetch
    await renderView()
    // Both status chips render their class + text from the gateway payload.
    const paused = await screen.findByText('flow_repro_01')
    const card1 = paused.closest('.card-flat')!
    const s1 = card1.querySelector('.status') as HTMLElement
    expect(s1.classList.contains('paused')).toBe(true)
    expect(s1.textContent).toContain('paused')
    const unknown = screen.getByText('flow_align_02')
    const card2 = unknown.closest('.card-flat')!
    const s2 = card2.querySelector('.status') as HTMLElement
    expect(s2.classList.contains('unknown')).toBe(true)
    expect(s2.textContent).toContain('unknown')
  })

  it('renders the empty-state copy when a workspace has no linked flow', async () => {
    // Swap the detail fixture to one with no flows.
    const noFlowDetail = {
      ...WS_DETAIL,
      flows: [],
      workspace: { ...WS_DETAIL.workspace, id: 'ws-empty' },
    }
    const emptyList = [{ ...WS_LIST[0]!, id: 'ws-empty', name: '空项目', flowCount: 0 }]
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      const url = new URL(typeof input === 'string' ? input : input.toString(), 'http://localhost')
      const path = url.pathname
      if (path === '/api/workspaces') return jsonResponse({ success: true, data: { items: emptyList } })
      if (path.endsWith('/threads')) {
        return jsonResponse({ success: true, data: { items: [], nextBefore: null, nextBeforeId: null } })
      }
      return jsonResponse({ success: true, data: noFlowDetail })
    }) as typeof globalThis.fetch
    await renderView()
    expect(await screen.findByText('无关联 flow。')).toBeInTheDocument()
  })
})
