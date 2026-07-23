/**
 * Lab view fidelity tests (v0.3-M7.2).
 *
 * Pins the three surfaces the redesign task moves `lab-view.tsx` onto, all
 * flagged as the gaps the plan closes (design/lab.html + design/js/lab-data.js):
 *
 *   §7.1 sessions — the left list. `.session-item` rows render name + desc +
 *     status chip + agents count, the first is `aria-selected` on load, and
 *     clicking another session swaps the chat title + thread (real fetch, not
 *     the design's visual-only swap — a保真增强 the audit already credited).
 *
 *   §7.2 threaded messages — the center stream. Each `.msg` renders the
 *     avatar/role-tag/time/bubble exactly like `renderMessages()`, a message
 *     carrying `thinking` shows the `💭` block, and a message carrying a
 *     `toolCall` shows the `🛠 name / input / output` tool card. @mentions in
 *     a bubble are colored as chips (console's enhancement over the design's
 *     raw-HTML body).
 *
 *   §7.3 @mention — the composer. The four `.mention` chips (`@orchestrator` /
 *     `@reader` / `@coder` / `@verifier`) insert their token into the textarea
 *     on click, and the textarea auto-grows to fit its content (the design's
 *     `input` listener: `height = min(scrollHeight, 120)`).
 *
 * The console `/api/lab/*` proxy routes are stubbed via `globalThis.fetch` so
 * the suite runs without a gateway. The fixtures mirror `lab-data.js`: the
 * session list + one session detail whose `messages` carry a thinking block
 * (the reader turn) and a tool call (the coder turn), plus an inline @mention
 * in the orchestrator's body.
 *
 * `crypto.randomUUID()` is available under jsdom (the optimistic human turn
 * generates one before the POST), so it needs no stub.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'

// ─── fixtures (mirror design/js/lab-data.js shapes) ─────────────────────────

/** The left session list (`window.OD_LAB_SESSIONS` → `/api/lab/sessions`). */
const LAB_SESSIONS = [
  {
    id: 'sess-rl',
    name: 'RL 论文复现 · skip-connect 替代 attention',
    description: '对比 skip-connection 与 baseline attention 在 PPO 上的收敛差异',
    status: 'running',
    workspaceId: null,
    mode: 'auto',
    agentsCount: 4,
    messageCount: 9,
    createdAt: '2026-07-14T06:20:00.000Z',
    updatedAt: '2026-07-14T06:42:00.000Z',
  },
  {
    id: 'sess-align',
    name: '多模态对齐假设验证',
    description: '验证 image-text 对齐损失是否对噪声标签鲁棒',
    status: 'paused',
    workspaceId: null,
    mode: 'auto',
    agentsCount: 3,
    messageCount: 2,
    createdAt: '2026-07-13T09:00:00.000Z',
    updatedAt: '2026-07-13T09:30:00.000Z',
  },
] as const

/**
 * The selected session's detail + thread (`window.OD_LAB_MESSAGES` →
 * `/api/lab/sessions/:id`). Oldest-first (the gateway's order). The fixture
 * carries every surface the view renders:
 *   - a human turn (avatar `H`, roleTag 人工介入, aligned right as `.user`)
 *   - an orchestrator turn with an inline @reader @coder @verifier mention in
 *     the body + a `thinking` block
 *   - a coder turn carrying a `toolCall` (the 🛠 card)
 *   - a verifier turn carrying both a `thinking` block AND a `toolCall`
 *     (the design has several such overlaps — pin both render on one bubble).
 */
const LAB_DETAIL = {
  session: {
    id: 'sess-rl',
    name: 'RL 论文复现 · skip-connect 替代 attention',
    description: '对比 skip-connection 与 baseline attention 在 PPO 上的收敛差异',
    status: 'running',
    workspaceId: null,
    mode: 'auto',
    agentsCount: 4,
    createdAt: '2026-07-14T06:20:00.000Z',
    updatedAt: '2026-07-14T06:42:00.000Z',
  },
  messages: [
    {
      id: 'm1',
      sessionId: 'sess-rl',
      parentId: null,
      role: 'human',
      agentId: null,
      runId: null,
      body: '复现 arxiv 2407.1842 的 PPO 实验。重点：attention 层能否被 skip-connection 替代而不掉点。',
      thinking: null,
      toolCall: null,
      createdAt: '2026-07-14T06:20:00.000Z',
    },
    {
      id: 'm2',
      sessionId: 'sess-rl',
      parentId: 'm1',
      role: 'orchestrator',
      agentId: 'orchestrator-01',
      runId: 'run-8821-aaaa-bbbb',
      // Inline @mentions in the body — the view colors these as chips via
      // splitBodyMentions. The bare handles parse to reader/coder/verifier.
      body: '已拆解为 3 个子任务并分派：1) 派 @reader 抽取论文实验描述 2) @coder 实现 skip-connect 变体 3) @verifier 设计对照',
      thinking: '用户要的是「能否替代」，需要对照实验而非单点复现。先读再改再验。',
      toolCall: null,
      createdAt: '2026-07-14T06:21:00.000Z',
    },
    {
      id: 'm3',
      sessionId: 'sess-rl',
      parentId: 'm1',
      role: 'coder',
      agentId: 'coder-12',
      runId: 'run-8821-aaaa-bbbb',
      body: '已实现 SkipConnectBlock 替换 AttentionLayer，保持参数量一致。沙箱跑通前向。',
      thinking: null,
      // The 🛠 tool card: name + input + output all render.
      toolCall: { name: 'run_sandbox', input: 'ppo_skip.py --epochs 3', output: 'forward ok · loss=2.14 · 1.2s/step' },
      createdAt: '2026-07-14T06:31:00.000Z',
    },
    {
      id: 'm4',
      sessionId: 'sess-rl',
      parentId: 'm1',
      role: 'verifier',
      agentId: 'verifier-07',
      runId: 'run-8821-aaaa-bbbb',
      body: '提出对照矩阵：4 层 vs 8 层 × baseline vs skip。',
      // A message may carry BOTH a thinking block and a tool card — pin both.
      thinking: '论文只说深层更重要，没说替换后等效——这是 H1 的来源。',
      toolCall: { name: 'eval_compare', input: '4 runs · 128 episodes each', output: 'skip_4: 41.2 | base_4: 44.4' },
      createdAt: '2026-07-14T06:32:00.000Z',
    },
  ],
} as const

// ─── fetch stub ──────────────────────────────────────────────────────────────

function jsonResponse(body: unknown, init?: ResponseInit): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json', ...(init?.headers ?? {}) },
  })
}

let originalFetch: typeof globalThis.fetch

/**
 * The stub simulates the gateway's append-then-read semantics: a POST to
 * `…/messages` appends a row to an in-memory `appended` list, and the next GET
 * of the session detail returns the base thread PLUS every appended row — so
 * the view's optimistic turn reconciles to a real row carrying the same body
 * (exactly what the production gateway does). Reset per-test in `beforeEach`.
 */
const appended: Array<{ id: string; body: string; runId: string | null }> = []

beforeEach(() => {
  appended.length = 0
  originalFetch = globalThis.fetch
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(typeof input === 'string' ? input : input.toString(), 'http://localhost')
    const path = url.pathname
    // GET /api/lab/sessions — the left list.
    if (path === '/api/lab/sessions' && (!init || init.method === undefined || init.method === 'GET')) {
      return jsonResponse({ success: true, data: { items: LAB_SESSIONS } })
    }
    // GET /api/lab/sessions/:id — one session's detail + thread. The base
    // thread is the fixture; any POST-appended rows are tacked on the end so
    // the optimistic turn reconciles to a row carrying the same body.
    if (path === '/api/lab/sessions/sess-rl') {
      const messages = [
        ...LAB_DETAIL.messages,
        ...appended.map((a, i) => ({
          id: a.id,
          sessionId: 'sess-rl',
          parentId: null,
          role: 'human' as const,
          agentId: null,
          runId: a.runId,
          body: a.body,
          thinking: null,
          toolCall: null,
          createdAt: `2026-07-14T07:0${i}:00.000Z`,
        })),
      ]
      return jsonResponse({ success: true, data: { ...LAB_DETAIL, messages } })
    }
    // Second session has no messages (exercises the empty thread state).
    if (path === '/api/lab/sessions/sess-align') {
      return jsonResponse({
        success: true,
        data: { session: { ...LAB_DETAIL.session, id: 'sess-align', name: '多模态对齐假设验证', agentsCount: 3, messageCount: 0 }, messages: [] },
      })
    }
    // POST /api/lab/sessions/:id/messages — append a human turn. Echo the body
    // back as a synthesized row AND record it so the next GET includes it.
    if (path === '/api/lab/sessions/sess-rl/messages' && init?.method === 'POST') {
      const sent = init.body ? (JSON.parse(init.body.toString()) as { body?: string; runId?: string }) : {}
      const id = `m-local-${appended.length}`
      appended.push({ id, body: sent.body ?? '(empty)', runId: sent.runId ?? null })
      return jsonResponse({
        success: true,
        data: {
          message: {
            id,
            sessionId: 'sess-rl',
            parentId: null,
            role: 'human',
            agentId: null,
            runId: sent.runId ?? null,
            body: sent.body ?? '(empty)',
            thinking: null,
            toolCall: null,
            createdAt: '2026-07-14T07:00:00.000Z',
          },
        },
      })
    }
    return jsonResponse({ success: false, error: 'not found' }, { status: 404 })
  }) as typeof globalThis.fetch
})

afterEach(() => {
  globalThis.fetch = originalFetch
})

// Imported lazily so nothing above the import races a module-level fetch.
async function renderView(): Promise<void> {
  const { LabView } = await import('@/components/lab-view')
  render(<LabView />)
}

// ─── §7.1 sessions list + selection ──────────────────────────────────────────

describe('LabView — sessions list + selection (M7.2)', () => {
  it('renders the session list with name, desc, status chip, and agents count', async () => {
    await renderView()
    // First session: name + desc + status (进行) + agents count. The name also
    // renders as the chat-head title, so scope to the left session list.
    const sessionsBody = (await screen.findByText('实验会话 · 2')).closest('.sessions') as HTMLElement
    const first = within(sessionsBody).getByText('RL 论文复现 · skip-connect 替代 attention')
    const item = first.closest('.session-item') as HTMLElement
    expect(item).not.toBeNull()
    expect(item.textContent).toContain('对比 skip-connection 与 baseline attention 在 PPO 上的收敛差异')
    // Status chip carries the running class + 进行 label (sessionStatusLabel).
    const status = item.querySelector('.status') as HTMLElement
    expect(status.classList.contains('running')).toBe(true)
    expect(status.textContent).toContain('进行')
    expect(item.textContent).toContain('4 agents')

    // Second session: a paused session (暂停 label + paused class).
    const second = within(sessionsBody).getByText('多模态对齐假设验证')
    const item2 = second.closest('.session-item') as HTMLElement
    const status2 = item2.querySelector('.status') as HTMLElement
    expect(status2.classList.contains('paused')).toBe(true)
    expect(status2.textContent).toContain('暂停')
  })

  it('selects the first session on load (aria-selected) and shows its chat title', async () => {
    await renderView()
    // The session name renders in BOTH the left list and the chat-head title;
    // scope to the left list so the session-item assertion is unambiguous.
    const sessionsBody = (await screen.findByText('实验会话 · 2')).closest('.sessions') as HTMLElement
    const first = within(sessionsBody).getByText('RL 论文复现 · skip-connect 替代 attention')
    const item = first.closest('.session-item') as HTMLElement
    // The first session is selected on load (the useEffect auto-selects it).
    expect(item).toHaveAttribute('aria-selected', 'true')
    // The chat head title mirrors the selected session's name (the selected
    // session's name ALSO appears in the list, so assert against the chat head
    // title node specifically — `.chat-head .title`).
    const chatTitle = document.querySelector('.chat-head .title') as HTMLElement
    expect(chatTitle.textContent).toBe('RL 论文复现 · skip-connect 替代 attention')
  })
  it('switches the chat title + thread when another session is clicked', async () => {
    const user = userEvent.setup()
    await renderView()
    // Wait for the first session's thread to render.
    expect(await screen.findByText('复现 arxiv 2407.1842 的 PPO 实验。重点：attention 层能否被 skip-connection 替代而不掉点。')).toBeInTheDocument()

    // Click the second (paused, empty) session — scope to the left list since
    // the name also appears in the chat-head title after the switch.
    const sessionsBody = screen.getByText('实验会话 · 2').closest('.sessions') as HTMLElement
    const second = within(sessionsBody).getByText('多模态对齐假设验证')
    await user.click(second.closest('.session-item') as HTMLElement)

    // The second session is now selected; the first is not.
    expect(second.closest('.session-item')).toHaveAttribute('aria-selected', 'true')
    expect(within(sessionsBody).getByText('RL 论文复现 · skip-connect 替代 attention').closest('.session-item')).toHaveAttribute('aria-selected', 'false')
    // The chat head title swapped to the second session (the title node, since
    // the name also remains in the left list).
    const chatTitle = document.querySelector('.chat-head .title') as HTMLElement
    expect(chatTitle.textContent).toBe('多模态对齐假设验证')
    // The first session's thread is gone; the empty-thread copy shows.
    expect(screen.queryByText('复现 arxiv 2407.1842 的 PPO 实验。重点：attention 层能否被 skip-connection 替代而不掉点。')).not.toBeInTheDocument()
  })
})

// ─── §7.2 threaded messages: avatar / role-tag / time / bubble ───────────────

describe('LabView — threaded messages (M7.2)', () => {
  it('renders each message with avatar initial, name, role tag, and body', async () => {
    await renderView()
    // Human turn: avatar `H`, name 你, role tag 人工介入, aligned right (.user).
    const human = await screen.findByText('复现 arxiv 2407.1842 的 PPO 实验。重点：attention 层能否被 skip-connection 替代而不掉点。')
    const humanMsg = human.closest('.msg') as HTMLElement
    expect(humanMsg.classList.contains('user')).toBe(true)
    const humanAvatar = humanMsg.querySelector('.msg-avatar') as HTMLElement
    expect(humanAvatar.classList.contains('human')).toBe(true)
    expect(humanAvatar.textContent).toBe('H')
    expect(humanMsg.textContent).toContain('你')
    expect(humanMsg.textContent).toContain('人工介入')

    // Orchestrator turn: avatar `O`, agent id name, role tag @orchestrator.
    const orch = screen.getByText(/已拆解为 3 个子任务并分派/)
    const orchMsg = orch.closest('.msg') as HTMLElement
    const orchAvatar = orchMsg.querySelector('.msg-avatar') as HTMLElement
    expect(orchAvatar.classList.contains('orchestrator')).toBe(true)
    expect(orchAvatar.textContent).toBe('O')
    expect(orchMsg.textContent).toContain('orchestrator-01')
    expect(orchMsg.textContent).toContain('@orchestrator')
  })

  it('renders the 💭 thinking block under a message that carries one', async () => {
    await renderView()
    // The orchestrator's thinking block (用户要的是「能否替代」…).
    const thinking = await screen.findByText(/用户要的是「能否替代」/)
    const thinkingBlock = thinking.closest('.thinking') as HTMLElement
    expect(thinkingBlock).not.toBeNull()
    // The design prefixes the block with 💭.
    expect(thinkingBlock.textContent).toContain('💭')

    // The verifier's thinking block (论文只说深层更重要…).
    const vThinking = screen.getByText(/论文只说深层更重要/)
    const vThinkingBlock = vThinking.closest('.thinking') as HTMLElement
    expect(vThinkingBlock).not.toBeNull()
    expect(vThinkingBlock.textContent).toContain('💭')
  })

  it('renders the 🛠 tool card with name / input / output', async () => {
    await renderView()
    // Wait for the thread to land, then read the two tool cards by their
    // `.th` header. The JSX `<div className="th">🛠 {tool.name}</div>` puts the
    // 🛠 glyph and the name in adjacent text nodes, so assert on the card's
    // full textContent rather than a single getByText match.
    await screen.findByText('复现 arxiv 2407.1842 的 PPO 实验。重点：attention 层能否被 skip-connection 替代而不掉点。')
    const cards = document.querySelectorAll('.tool-card')
    expect(cards.length).toBe(2)

    const coderCard = cards[0]! as HTMLElement
    expect(coderCard.querySelector('.th')!.textContent).toContain('🛠')
    expect(coderCard.querySelector('.th')!.textContent).toContain('run_sandbox')
    expect(coderCard.textContent).toContain('ppo_skip.py --epochs 3')
    expect(coderCard.textContent).toContain('forward ok · loss=2.14 · 1.2s/step')

    const verifierCard = cards[1]! as HTMLElement
    expect(verifierCard.querySelector('.th')!.textContent).toContain('🛠')
    expect(verifierCard.querySelector('.th')!.textContent).toContain('eval_compare')
    expect(verifierCard.textContent).toContain('4 runs · 128 episodes each')
    expect(verifierCard.textContent).toContain('skip_4: 41.2 | base_4: 44.4')
  })

  it('colors inline @mentions in a bubble as chips', async () => {
    await renderView()
    // The orchestrator's body carries @reader / @coder / @verifier; each is
    // rendered as a `.msg-mention` chip (console's enhancement over the
    // design's raw-HTML body). @orchestrator (the role tag in the head) is NOT
    // a bubble mention — only the ones inside the body.
    const orchBubble = (await screen.findByText(/已拆解为 3 个子任务并分派/)).closest('.msg-bubble') as HTMLElement
    const mentions = within(orchBubble).getAllByText(/^@(reader|coder|verifier)$/)
    expect(mentions).toHaveLength(3)
    for (const m of mentions) {
      expect(m.classList.contains('msg-mention')).toBe(true)
    }
  })
})

// ─── §7.3 @mention chips + textarea auto-grow ────────────────────────────────

describe('LabView — @mention chips + textarea auto-grow (M7.2)', () => {
  it('renders the four mention chips and inserts a handle into the textarea on click', async () => {
    const user = userEvent.setup()
    await renderView()
    // The four composer chips (design/lab.html:148-151).
    const reader = await screen.findByRole('button', { name: /^@reader$/ })
    expect(screen.getByRole('button', { name: /^@orchestrator$/ })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /^@coder$/ })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /^@verifier$/ })).toBeInTheDocument()

    const textarea = screen.getByLabelText('实验消息') as HTMLTextAreaElement
    expect(textarea.value).toBe('')

    // Click @reader → the handle is inserted with a trailing space.
    await user.click(reader)
    expect(textarea.value).toBe('@reader ')
  })

  it('appends a second mention after an existing one (preserves prior text)', async () => {
    const user = userEvent.setup()
    await renderView()
    const reader = await screen.findByRole('button', { name: /^@reader$/ })
    const coder = screen.getByRole('button', { name: /^@coder$/ })
    const textarea = screen.getByLabelText('实验消息') as HTMLTextAreaElement

    await user.click(reader)
    await user.click(coder)
    // insertMention joins with a space between the existing text and the new
    // handle: "@reader @coder ".
    expect(textarea.value).toBe('@reader @coder ')
  })

  it('grows the textarea height to fit its content (auto-grow)', async () => {
    const user = userEvent.setup()
    await renderView()
    const textarea = screen.getByLabelText('实验消息') as HTMLTextAreaElement

    // The auto-grow listener resets height to 'auto' then sets it to the
    // scrollHeight (capped at the CSS max-height). jsdom reports a scrollHeight
    // of 0 for an empty/short textarea, so drive a multi-line body that the
    // listener responds to. Type enough to exceed the single row.
    const long = 'line one\nline two\nline three\nline four\nline five'
    await user.type(textarea, long)

    // The auto-grow callback fired on each input; the height is now driven by
    // scrollHeight (not the initial rows=1). Assert the listener set an
    // explicit inline height (the design's `ta.style.height = …`).
    expect(textarea.style.height).not.toBe('')
    // And it's a pixel value (the design sets `Math.min(...) + 'px'`; even a
    // 0px floor proves the listener wired, vs. the untouched '' default).
    expect(textarea.style.height).toMatch(/px$/)
  })

  it('sends a human turn on Enter (no shift) and clears the composer', async () => {
    const user = userEvent.setup()
    await renderView()
    // Wait for the thread to land so the composer is enabled.
    await screen.findByText('复现 arxiv 2407.1842 的 PPO 实验。重点：attention 层能否被 skip-connection 替代而不掉点。')

    const textarea = screen.getByLabelText('实验消息') as HTMLTextAreaElement
    await user.type(textarea, '这是刚发的新消息{Enter}')

    // The optimistic human turn appends immediately. The body renders inside a
    // `.msg.user` bubble; `renderBody` splits it into plain + mention segments,
    // so find the bubble node whose textContent contains the body, then walk
    // up to the `.msg.user` row.
    const bubble = await screen.findByText((content) => content.includes('这是刚发的新消息'))
    expect(bubble.closest('.msg.user')).not.toBeNull()
    expect(textarea.value).toBe('')
  })
})
