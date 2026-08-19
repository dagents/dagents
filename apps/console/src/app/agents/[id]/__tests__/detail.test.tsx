/**
 * Agent-detail page fidelity tests (v0.3-M4.1, audit §3).
 *
 * Pins the design/agent-detail.html DOM + interactions the redesign moves the
 * new `/agents/[id]` page onto:
 *   - 30-bucket activity sparkline: `AgentActivityBucket[]` → SVG with one
 *     `.act-chart-bar` per bucket + a stacked `.act-chart-bar.fail` overlay
 *     for failing buckets (ok/fail 双色, design agent-detail.html:227-245).
 *   - the pure derivations (`deriveActivityBuckets` / `sumBuckets` /
 *     `derivePageModel`) so the bar math is pinned without the DOM.
 *   - the left `.inspector` (identity head + live-presence availability +
 *     属性 rows + Skills chip rail + 当前任务) and the right `.overview`
 *     tablist (Activity/Instructions/Skills/Logs) with click + keyboard panel
 *     switching (design agent-detail.html:327-344).
 *
 * ## Fixtures
 *
 * `makeDetail()` returns an already-mapped camelCase `AgentDetail` for the
 * PURE derivation tests (deterministic — `agent.elapsedMs` is a fixed number,
 * `tasks[].createdAt` are fixed ISO strings, `nowMs` is pinned).
 *
 * The COMPONENT tests stub `globalThis.fetch` to return a RAW snake_case
 * `AgentDetailRow` (what `GET /api/agents/:id` actually returns from
 * dispatch), so `fetchAgentDetail`'s real row-mapping runs end-to-end — the
 * same shape `flows-list.test.tsx` uses. Activity buckets stay deterministic
 * because the raw `tasks[].created_at` are fixed ISO strings and the view's
 * `nowMs` prop fixes the 30-day window. (`agent.elapsedMs` is derived from
 * `Date.now()` by `deriveElapsedMs`, so it is NOT asserted in the component
 * tests — only in the pure `derivePageModel` test, where `makeDetail()` pins
 * it.) The 404 stub drives the not-found path (`fetchAgentDetail` throws
 * `agent detail failed (404)…` → the view's not-found card).
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import {
  ACTIVITY_BUCKET_COUNT,
  deriveActivityBuckets,
  derivePageModel,
  sumBuckets,
} from '@/lib/agent-detail'
import {
  sparklineBarGeometry,
  AgentActivitySparkline,
} from '@/components/agent-activity-sparkline'
import { AgentDetailView } from '@/components/agent-detail-view'
import type { AgentDetail, AgentLogLine } from '@/lib/agents-catalog'

// Mock next/navigation useRouter (used by AgentDetailView for delete redirect)
vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: () => {}, replace: () => {}, back: () => {} }),
}))

// A fixed "now" so the 30-day bucket window is deterministic. 2026-07-14 is
// the issue's active date; tasks land on today / 1d / 5d / 35d-ago to hit the
// in-window and out-of-window branches of deriveActivityBuckets.
const NOW_MS = Date.parse('2026-07-14T12:00:00Z')

/** Already-mapped camelCase AgentDetail — for the pure derivation tests.
 *  `agent.elapsedMs` is a fixed number so `derivePageModel`'s elapsed/progress
 *  are deterministic. Tasks carry camelCase `createdAt` ISO strings. */
function makeDetail(): AgentDetail {
  return {
    agent: {
      id: 'agent_01HFK',
      name: '论文阅读 · reader-04',
      kind: 'claude',
      roles: ['reader', 'analysis'],
      status: 'running',
      daemon: 'daemon-09',
      region: 'ap-northeast',
      run: 'R-8821',
      load: 78,
      cost: '$0.15',
      latestTaskId: 'task-1',
      latestTaskStatus: 'running',
      elapsedMs: 252_000, // 4m12s
      capability: {
        name: 'reader-04',
        summary: '阅读论文并抽取核心论点、方法、可复现实验清单。',
        inputSchema: '{pdf_uri, focus?}',
        outputSchema: '{summary, claims[], refs[]}',
        tags: ['reader', 'analysis'],
      },
      createdAt: '2026-05-12T03:20:00Z',
      daemonStatus: 'online',
      visibility: 'workspace',
    },
    tasks: [
      {
        id: 't-today-ok',
        runId: 'R-8821',
        status: 'running',
        usage: null,
        durationMs: null,
        createdAt: '2026-07-14T10:00:00Z', // today
        finishedAt: null,
      },
      {
        id: 't-today-fail',
        runId: 'R-8815',
        status: 'failed',
        usage: null,
        durationMs: null,
        createdAt: '2026-07-14T09:00:00Z', // today
        finishedAt: null,
      },
      {
        id: 't-5d-ago',
        runId: 'R-8800',
        status: 'completed',
        usage: null,
        durationMs: null,
        createdAt: '2026-07-09T09:00:00Z', // 5 days ago
        finishedAt: null,
      },
      {
        id: 't-35d-ago',
        runId: 'R-8700',
        status: 'completed',
        usage: null,
        durationMs: null,
        createdAt: '2026-06-09T09:00:00Z', // 35 days ago → out of 30-day window
        finishedAt: null,
      },
    ],
    runs: [{ id: 'R-8821', identifier: 'R-8821', status: 'running', cost: '$0.15' }],
  }
}

const LOGS: AgentLogLine[] = [
  { ts: '2026-07-14T14:31:00Z', level: 'ok', msg: 'claim extraction done · 14 claims' },
  { ts: '2026-07-14T14:30:00Z', level: 'info', msg: 'parse arxiv 2407.1842' },
]

/** Raw snake_case `AgentDetailRow` — what `GET /api/agents/:id` returns from
 *  dispatch (before `fetchAgentDetail` maps it). Used by the component fetch
 *  stub so the real row-mapping runs end-to-end. `created_at` are fixed ISO
 *  strings so activity-bucket derivation is deterministic given `nowMs`. */
function makeRawDetailRow(): unknown {
  return {
    agent: {
      id: 'agent_01HFK',
      name: '论文阅读 · reader-04',
      kind: 'claude',
      capability_descriptor: {
        name: 'reader-04',
        summary: '阅读论文并抽取核心论点、方法、可复现实验清单。',
        inputSchema: '{pdf_uri, focus?}',
        outputSchema: '{summary, claims[], refs[]}',
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
      task_created_at: '2026-07-14T10:00:00Z',
      finished_at: null,
    },
    tasks: [
      { id: 't-today-ok', run_id: 'R-8821', status: 'running', usage: null, duration_ms: null, created_at: '2026-07-14T10:00:00Z', finished_at: null },
      { id: 't-today-fail', run_id: 'R-8815', status: 'failed', usage: null, duration_ms: null, created_at: '2026-07-14T09:00:00Z', finished_at: null },
      { id: 't-5d-ago', run_id: 'R-8800', status: 'completed', usage: null, duration_ms: null, created_at: '2026-07-09T09:00:00Z', finished_at: null },
      { id: 't-35d-ago', run_id: 'R-8700', status: 'completed', usage: null, duration_ms: null, created_at: '2026-06-09T09:00:00Z', finished_at: null },
    ],
    runs: [{ id: 'R-8821', identifier: 'R-8821', status: 'running', cost: '$0.15' }],
  }
}

describe('deriveActivityBuckets (30-day window)', () => {
  it('always returns exactly 30 buckets', () => {
    expect(deriveActivityBuckets([], NOW_MS)).toHaveLength(ACTIVITY_BUCKET_COUNT)
    expect(deriveActivityBuckets(makeDetail().tasks, NOW_MS)).toHaveLength(ACTIVITY_BUCKET_COUNT)
  })

  it('drops today/5d-ago tasks into the right buckets and excludes >30d', () => {
    const buckets = deriveActivityBuckets(makeDetail().tasks, NOW_MS)
    // today (deltaDays=0) → bucket 29; 2 tasks today (1 ok, 1 fail)
    expect(buckets[29]).toEqual({ total: 2, ok: 1, fail: 1 })
    // 5d ago (deltaDays=5) → bucket 24; 1 ok task
    expect(buckets[24]).toEqual({ total: 1, ok: 1, fail: 0 })
    // 35d-ago task is out of window → no bucket sums it; today + 5d = 3 total
    const { total } = sumBuckets(buckets)
    expect(total).toBe(3)
  })

  it('counts failed tasks into bucket.fail and ok into bucket.ok', () => {
    const buckets = deriveActivityBuckets(
      [
        { status: 'failed', createdAt: new Date(NOW_MS).toISOString() },
        { status: 'completed', createdAt: new Date(NOW_MS - 86_400_000).toISOString() },
      ],
      NOW_MS,
    )
    expect(buckets[29]).toEqual({ total: 1, ok: 0, fail: 1 })
    expect(buckets[28]).toEqual({ total: 1, ok: 1, fail: 0 })
  })

  it('sumBuckets reports total/fail/successRate and — when empty', () => {
    expect(sumBuckets(deriveActivityBuckets([], NOW_MS))).toEqual({
      total: 0,
      ok: 0,
      fail: 0,
      successRate: '—',
    })
    const b = deriveActivityBuckets(makeDetail().tasks, NOW_MS)
    expect(sumBuckets(b)).toEqual({ total: 3, ok: 2, fail: 1, successRate: '66.7' })
  })
})

describe('AgentActivitySparkline (30-bar SVG, ok/fail 双色)', () => {
  const buckets = deriveActivityBuckets(makeDetail().tasks, NOW_MS)

  it('emits one geometry entry per bucket (30)', () => {
    const geo = sparklineBarGeometry(buckets)
    expect(geo).toHaveLength(ACTIVITY_BUCKET_COUNT)
    // every entry carries an ok rect
    expect(geo.every((g) => g.okRect != null)).toBe(true)
  })

  it('only failing buckets produce a fail overlay rect', () => {
    const geo = sparklineBarGeometry(buckets)
    // bucket 29 (today) has fail=1 → failRect present; bucket 24 has fail=0 → null
    expect(geo[29]!.failRect).not.toBeNull()
    expect(geo[24]!.failRect).toBeNull()
    const failCount = geo.filter((g) => g.failRect != null).length
    expect(failCount).toBe(1) // only today
  })

  it('renders an .act-chart svg with 30 .act-chart-bar (incl. fail overlays)', () => {
    const { container } = render(<AgentActivitySparkline buckets={buckets} />)
    const svg = container.querySelector('svg.act-chart')
    expect(svg).not.toBeNull()
    const bars = container.querySelectorAll('rect.act-chart-bar')
    // 30 ok bars + 1 fail overlay (today) = 31 total rects
    expect(bars.length).toBe(ACTIVITY_BUCKET_COUNT + 1)
    const failBars = container.querySelectorAll('rect.act-chart-bar.fail')
    expect(failBars.length).toBe(1)
  })

  it('bar height ∝ total/max and fail overlay height ∝ fail/total', () => {
    const geo = sparklineBarGeometry(buckets)
    const today = geo[29]!.okRect
    const fiveDay = geo[24]!.okRect
    // today has total=2 (the max), 5d-ago has total=1 → today bar is taller
    expect(today.height).toBeGreaterThan(fiveDay.height)
    // fail overlay is shorter than its ok bar (fail=1 of total=2 → half height)
    const fail = geo[29]!.failRect!
    expect(fail.height).toBeLessThan(today.height)
    expect(fail.height).toBeCloseTo(today.height / 2, 0)
  })

  it('carries an aria-label summarizing the totals', () => {
    const { container } = render(<AgentActivitySparkline buckets={buckets} />)
    const svg = container.querySelector('svg.act-chart')!
    expect(svg.getAttribute('aria-label')).toContain('3')
    expect(svg.getAttribute('aria-label')).toContain('1')
    expect(svg.getAttribute('role')).toBe('img')
  })
})

describe('AgentDetailView — inspector + tabs (M4.1 fidelity)', () => {
  let originalFetch: typeof globalThis.fetch
  /** PATCH 调用记录（Skills 导入保存断言用）。 */
  let patchCalls: Array<{ url: string; body: unknown }>

  beforeEach(() => {
    originalFetch = globalThis.fetch
    patchCalls = []
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input.toString()
      if (init?.method === 'PATCH') {
        patchCalls.push({ url, body: JSON.parse(String(init.body)) })
        return new Response(JSON.stringify({ success: true, data: { id: 'agent_01HFK', updated: true } }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        })
      }
      if (url.includes('/api/skills')) {
        // Skills tab 的本地技能目录（gateway 注册表摘要）
        return new Response(
          JSON.stringify({
            success: true,
            data: {
              skills: [
                { name: 'agent-reach', description: '全网信息检索', source: 'user-agents' },
                { name: 'gstack', description: '无头浏览器 QA', source: 'user-agents' },
              ],
              roots: [],
            },
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        )
      }
      if (url.endsWith('/logs')) {
        return new Response(
          JSON.stringify({ success: true, data: { logs: LOGS } }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        )
      }
      // /api/agents/:id
      return new Response(
        JSON.stringify({ success: true, data: makeRawDetailRow() }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      )
    }) as typeof globalThis.fetch
  })

  afterEach(() => {
    globalThis.fetch = originalFetch
  })

  it('renders the .detail-layout with .inspector (left) + .overview (right)', async () => {
    const { container } = render(<AgentDetailView id="agent_01HFK" nowMs={NOW_MS} />)
    // wait for the fetch + derive to settle
    await screen.findByText('论文阅读 · reader-04')

    const layout = container.querySelector('.detail-layout')
    expect(layout).not.toBeNull()
    expect(container.querySelector('.inspector')).not.toBeNull()
    expect(container.querySelector('.overview')).not.toBeNull()
  })

  it('inspector renders identity head, live-presence availability, 属性 rows, Skills chips, 当前任务', async () => {
    render(<AgentDetailView id="agent_01HFK" nowMs={NOW_MS} />)
    const ins = await screen.findByText('论文阅读 · reader-04')
    const inspector = ins.closest('.inspector')! as HTMLElement

    // identity name + summary
    expect(within(inspector).getByText('论文阅读 · reader-04')).toBeInTheDocument()
    expect(within(inspector).getByText(/阅读论文并抽取核心论点/)).toBeInTheDocument()
    // live presence: availability online (derived from daemonStatus='online')
    expect(within(inspector).getByText('在线')).toBeInTheDocument()
    // 属性 rows: Agent ID, 类型, 模型, 运行时, 可见性, …
    expect(within(inspector).getByText('Agent ID')).toBeInTheDocument()
    expect(within(inspector).getByText('类型')).toBeInTheDocument()
    expect(within(inspector).getByText('模型')).toBeInTheDocument()
    expect(within(inspector).getByText('运行时')).toBeInTheDocument()
    expect(within(inspector).getByText('可见性')).toBeInTheDocument()
    // visibility workspace → 工作区
    expect(within(inspector).getByText('工作区')).toBeInTheDocument()
    // Skills chip rail renders the capability tags
    expect(within(inspector).getByText('reader')).toBeInTheDocument()
    expect(within(inspector).getByText('analysis')).toBeInTheDocument()
    // 当前任务 surfaces the run id
    expect(within(inspector).getByText('R-8821')).toBeInTheDocument()
  })

  it('Activity tab is selected by default and renders the sparkline + KPI row', async () => {
    const { container } = render(<AgentDetailView id="agent_01HFK" nowMs={NOW_MS} />)
    await screen.findByText('论文阅读 · reader-04')

    const activityTab = screen.getByRole('tab', { name: '活动' })
    expect(activityTab).toHaveAttribute('aria-selected', 'true')
    // sparkline svg present
    expect(container.querySelector('svg.act-chart')).not.toBeNull()
    // KPI labels
    expect(screen.getByText('30 天总运行')).toBeInTheDocument()
    expect(screen.getByText('成功率')).toBeInTheDocument()
    expect(screen.getByText('失败次数')).toBeInTheDocument()
    // axis
    expect(screen.getByText('30 天前')).toBeInTheDocument()
    expect(screen.getByText('今天')).toBeInTheDocument()
  })

  it('clicking a tab swaps the panel (Activity → Instructions)', async () => {
    render(<AgentDetailView id="agent_01HFK" nowMs={NOW_MS} />)
    await screen.findByText('论文阅读 · reader-04')

    // Activity is active; Instructions is not
    const activity = screen.getByRole('tab', { name: '活动' })
    const instructions = screen.getByRole('tab', { name: '指令' })
    expect(activity).toHaveAttribute('aria-selected', 'true')
    expect(instructions).toHaveAttribute('aria-selected', 'false')

    await userEvent.click(instructions)
    expect(instructions).toHaveAttribute('aria-selected', 'true')
    expect(activity).toHaveAttribute('aria-selected', 'false')
    // Instructions panel surfaces the system prompt + 能力描述符 label
    expect(screen.getByText('系统提示词')).toBeInTheDocument()
    expect(screen.getByText('能力描述符')).toBeInTheDocument()
  })

  it('keyboard ArrowRight moves selection Activity → Instructions → Skills → Logs', async () => {
    render(<AgentDetailView id="agent_01HFK" nowMs={NOW_MS} />)
    await screen.findByText('论文阅读 · reader-04')

    const activity = screen.getByRole('tab', { name: '活动' })
    activity.focus()
    await userEvent.keyboard('{ArrowRight}')
    expect(screen.getByRole('tab', { name: '指令' })).toHaveAttribute('aria-selected', 'true')
    await userEvent.keyboard('{ArrowRight}')
    expect(screen.getByRole('tab', { name: '技能' })).toHaveAttribute('aria-selected', 'true')
    await userEvent.keyboard('{ArrowRight}')
    expect(screen.getByRole('tab', { name: '日志' })).toHaveAttribute('aria-selected', 'true')
    // wrap-around: Logs → Activity
    await userEvent.keyboard('{ArrowRight}')
    expect(screen.getByRole('tab', { name: '活动' })).toHaveAttribute('aria-selected', 'true')
  })

  it('ArrowLeft + Home + End navigate the tablist', async () => {
    render(<AgentDetailView id="agent_01HFK" nowMs={NOW_MS} />)
    await screen.findByText('论文阅读 · reader-04')

    const activity = screen.getByRole('tab', { name: '活动' })
    activity.focus()
    // ArrowLeft from Activity wraps to Logs
    await userEvent.keyboard('{ArrowLeft}')
    expect(screen.getByRole('tab', { name: '日志' })).toHaveAttribute('aria-selected', 'true')
    // Home → Activity (first)
    await userEvent.keyboard('{Home}')
    expect(screen.getByRole('tab', { name: '活动' })).toHaveAttribute('aria-selected', 'true')
    // End → Logs (last)
    await userEvent.keyboard('{End}')
    expect(screen.getByRole('tab', { name: '日志' })).toHaveAttribute('aria-selected', 'true')
  })

  it('renders the not-found card when the detail endpoint 404s', async () => {
    globalThis.fetch = (async () =>
      new Response('not found', { status: 404 })) as typeof globalThis.fetch
    render(<AgentDetailView id="agent_missing" nowMs={NOW_MS} />)
    expect(await screen.findByText('找不到这个 Agent')).toBeInTheDocument()
    expect(screen.getByText(/不存在，可能已被归档或删除/)).toBeInTheDocument()
  })

  it('Skills tab 可以从本地技能库导入并 PATCH 保存到 agent.skills', async () => {
    const user = userEvent.setup()
    render(<AgentDetailView id="agent_01HFK" nowMs={NOW_MS} />)
    await screen.findByText('论文阅读 · reader-04')

    // 切到 Skills tab（role=tab name=Skills）
    await user.click(screen.getByRole('tab', { name: '技能' }))

    // 本地技能库目录渲染（来自 /api/skills stub）
    expect(await screen.findByText('agent-reach')).toBeInTheDocument()
    expect(screen.getByText('gstack')).toBeInTheDocument()

    // 未修改时保存按钮禁用
    const saveBtn = screen.getByRole('button', { name: '保存挂载' })
    expect(saveBtn).toBeDisabled()

    // 勾选 agent-reach → 按钮启用 → 保存
    await user.click(screen.getByRole('button', { name: /agent-reach/ }))
    expect(saveBtn).toBeEnabled()
    await user.click(saveBtn)

    // PATCH /api/agents/:id — 在既有挂载（reader/analysis，来自 tags 回退）之上追加
    await screen.findByText('已保存')
    expect(patchCalls).toHaveLength(1)
    expect(patchCalls[0]!.url).toContain('/api/agents/agent_01HFK')
    expect(patchCalls[0]!.body).toEqual({ skills: ['reader', 'analysis', 'agent-reach'] })

    // 已挂载列表同步更新（卡片里出现技能名 + 目录描述）
    expect(screen.getByText('全网信息检索')).toBeInTheDocument()
  })
})


describe('derivePageModel (live payload → render model)', () => {
  it('derives availability from daemonStatus and runtime from kind+daemon', () => {
    const m = derivePageModel(makeDetail(), LOGS, NOW_MS)
    expect(m.availability).toBe('online')
    // runtime prefix is derived from the kind's default binary (claude → 'claude')
    expect(m.runtime).toBe('claude · daemon-09')
    expect(m.visibility).toBe('workspace')
    // current task surfaces the run id + elapsed formatted
    expect(m.currentRun).toBe('R-8821')
    expect(m.elapsed).toBe('4m12s')
    // activity derived from tasks (today: 1 ok + 1 fail; 5d ago: 1 ok)
    expect(m.runCount).toBe(3)
    expect(m.failCount).toBe(1)
  })

  it('availability maps draining → unstable and null → offline', () => {
    const base = makeDetail()
    const draining = derivePageModel(
      { ...base, agent: { ...base.agent, daemonStatus: 'draining' } },
      LOGS,
      NOW_MS,
    )
    expect(draining.availability).toBe('unstable')
    const noDaemon = derivePageModel(
      { ...base, agent: { ...base.agent, daemonStatus: null } },
      LOGS,
      NOW_MS,
    )
    expect(noDaemon.availability).toBe('offline')
  })

})
