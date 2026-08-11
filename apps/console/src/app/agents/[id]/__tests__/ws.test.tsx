/**
 * agent-detail WS live-status tests (v0.3-M4.2, architecture §6.8).
 *
 * Pins the WS `agent-updated` → availability/status refresh on the
 * agent-detail view, plus the WS-down polling fallback:
 *
 *   - a matching `agent-updated` frame patches the live-presence pill without
 *     a refetch (online → unstable → offline round-trip).
 *   - a frame for a *different* agentId is ignored (no cross-talk).
 *   - while the WS socket is disconnected, the view re-fetches the detail
 *     endpoint on an interval and merges the new availability.
 *
 * The WS client (`@/lib/ws-client`) is driven through its `__testing` seam
 * rather than a real socket: jsdom has no `WebSocket`, and the architecture
 * says the disconnected path must work anyway (that is the fallback under
 * test). `globalThis.fetch` is stubbed the same way `detail.test.tsx` stubs
 * it — returning a raw snake_case `AgentDetailRow` so the real
 * `fetchAgentDetail` row-mapping runs end-to-end.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { render, screen, act } from '@testing-library/react'
import { AgentDetailView } from '@/components/agent-detail-view'
import { __testing as wsTesting } from '@/lib/ws-client'
import type { AgentLogLine } from '@/lib/agents-catalog'

// Mock next/navigation useRouter (used by AgentDetailView for delete redirect)
vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: () => {}, replace: () => {}, back: () => {} }),
}))

// Fixed "now" so the 30-day activity window is deterministic (mirrors
// detail.test.tsx). 2026-07-14 is the issue's active date.
const NOW_MS = Date.parse('2026-07-14T12:00:00Z')

const LOGS: AgentLogLine[] = [
  { ts: '2026-07-14T14:31:00Z', level: 'ok', msg: 'claim extraction done · 14 claims' },
]

/** Raw snake_case `AgentDetailRow` — what `GET /api/agents/:id` returns. The
 *  `daemon_status` field is parameterized so each test can stage a starting
 *  availability (online / draining / offline) the way the live dispatch
 *  payload would. */
function makeRawDetailRow(opts: { daemonStatus?: string; taskStatus?: string } = {}): unknown {
  const daemonStatus = opts.daemonStatus ?? 'online'
  const taskStatus = opts.taskStatus ?? 'running'
  return {
    agent: {
      id: 'agent_01HFK',
      name: '论文阅读 · reader-04',
      kind: 'claude',
      capability_descriptor: {
        name: 'reader-04',
        summary: '阅读论文并抽取核心论点。',
        inputSchema: '{pdf_uri, focus?}',
        outputSchema: '{summary, claims[], refs[]}',
        tags: ['reader', 'analysis'],
      },
      executable_path: 'claude',
      visibility: 'workspace',
      created_at: '2026-05-12T03:20:00Z',
      daemon_label: 'daemon-09',
      daemon_status: daemonStatus,
      last_heartbeat_at: '2026-07-14T11:55:00Z',
      daemon_capabilities: [{ agentType: 'claude', tags: ['ap-northeast'] }],
      task_id: 'task-1',
      run_id: 'R-8821',
      task_status: taskStatus,
      usage: { claude: { inputTokens: 12000, outputTokens: 3400 } },
      duration_ms: null,
      task_created_at: '2026-07-14T10:00:00Z',
      finished_at: null,
    },
    tasks: [
      { id: 't-today-ok', run_id: 'R-8821', status: taskStatus, usage: null, duration_ms: null, created_at: '2026-07-14T10:00:00Z', finished_at: null },
    ],
    runs: [{ id: 'R-8821', identifier: 'R-8821', status: 'running', cost: '$0.15' }],
  }
}

/** Build a fetch stub that returns the given raw row for the detail endpoint
 *  and `LOGS` for the logs endpoint. Optionally defers the *next* detail call
 *  to a supplied value (used by the polling test). */
function makeFetch(stub: {
  row?: unknown
  nextRow?: unknown
  status?: number
}): typeof globalThis.fetch {
  const { row = makeRawDetailRow(), status = 200 } = stub
  let calls = 0
  return (async (input: RequestInfo | URL) => {
    const url = typeof input === 'string' ? input : input.toString()
    if (url.endsWith('/logs')) {
      return new Response(JSON.stringify({ success: true, data: { logs: LOGS } }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })
    }
    // /api/agents/:id
    if (status !== 200) {
      return new Response('not found', { status })
    }
    calls += 1
    const payload = calls > 1 && stub.nextRow ? stub.nextRow : row
    return new Response(JSON.stringify({ success: true, data: payload }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    })
  }) as typeof globalThis.fetch
}

describe('AgentDetailView — WS live status (M4.2)', () => {
  let originalFetch: typeof globalThis.fetch
  let originalWebSocket: typeof WebSocket

  beforeEach(() => {
    originalFetch = globalThis.fetch
    // jsdom provides WebSocket, so ensureSocket() would create a real socket
    // that connects to the gateway. A leaked socket from a previous test can
    // fire onopen during the next test, flipping `connected` to true and
    // disabling the polling-fallback path under test. Delete it so
    // ensureSocket() returns early (its "SSR / jsdom without a stub" guard);
    // tests drive frames + connected via the __testing seam instead.
    originalWebSocket = globalThis.WebSocket
    delete (globalThis as { WebSocket?: typeof WebSocket }).WebSocket
    // WS starts disconnected (no real socket under jsdom) — frame tests flip
    // it connected before emitting.
    wsTesting.reset()
  })

  afterEach(() => {
    globalThis.fetch = originalFetch
    globalThis.WebSocket = originalWebSocket
    wsTesting.reset()
    vi.useRealTimers()
  })

  it('an agent-updated WS frame refreshes the availability pill without a refetch', async () => {
    // Start offline (daemon_status null → offline), then a frame flips it online.
    globalThis.fetch = makeFetch({ row: makeRawDetailRow({ daemonStatus: 'offline' }) })
    render(<AgentDetailView id="agent_01HFK" nowMs={NOW_MS} />)

    // initial render: availability derived from daemon_status='offline' → 离线
    expect(await screen.findByText('离线')).toBeInTheDocument()

    // connect the socket + deliver the live frame
    act(() => {
      wsTesting.setConnected(true)
      wsTesting.emitFrame({
        type: 'agent-updated',
        agentId: 'agent_01HFK',
        availability: 'online',
        status: 'running',
      })
    })

    // pill now reads 在线 (online) — frame patched the in-memory model
    expect(await screen.findByText('在线')).toBeInTheDocument()
    expect(screen.queryByText('离线')).not.toBeInTheDocument()
  })

  it('cycles online → unstable → offline as frames arrive', async () => {
    globalThis.fetch = makeFetch({ row: makeRawDetailRow({ daemonStatus: 'online' }) })
    render(<AgentDetailView id="agent_01HFK" nowMs={NOW_MS} />)
    expect(await screen.findByText('在线')).toBeInTheDocument()

    act(() => {
      wsTesting.setConnected(true)
      wsTesting.emitFrame({
        type: 'agent-updated',
        agentId: 'agent_01HFK',
        availability: 'unstable',
        status: 'queued',
      })
    })
    expect(await screen.findByText('不稳定')).toBeInTheDocument()

    act(() => {
      wsTesting.emitFrame({
        type: 'agent-updated',
        agentId: 'agent_01HFK',
        availability: 'offline',
        status: 'idle',
      })
    })
    expect(await screen.findByText('离线')).toBeInTheDocument()
  })

  it('ignores a frame for a different agentId', async () => {
    globalThis.fetch = makeFetch({ row: makeRawDetailRow({ daemonStatus: 'online' }) })
    render(<AgentDetailView id="agent_01HFK" nowMs={NOW_MS} />)
    expect(await screen.findByText('在线')).toBeInTheDocument()

    act(() => {
      wsTesting.setConnected(true)
      wsTesting.emitFrame({
        type: 'agent-updated',
        agentId: 'agent_OTHER',
        availability: 'offline',
        status: 'idle',
      })
    })
    // unchanged — the frame was for a different agent
    expect(screen.getByText('在线')).toBeInTheDocument()
    expect(screen.queryByText('离线')).not.toBeInTheDocument()
  })

  it('ignores non-agent-updated frames', async () => {
    globalThis.fetch = makeFetch({ row: makeRawDetailRow({ daemonStatus: 'online' }) })
    render(<AgentDetailView id="agent_01HFK" nowMs={NOW_MS} />)
    expect(await screen.findByText('在线')).toBeInTheDocument()

    act(() => {
      wsTesting.setConnected(true)
      wsTesting.emitFrame({ type: 'run-updated', runId: 'R-8821', status: 'completed' })
    })
    expect(screen.getByText('在线')).toBeInTheDocument()
  })

  it('a frame does not patch a view that has not loaded its detail yet', async () => {
    // detail still loading (fetch deferred) — frame arrives first; the view
    // must not crash and must still settle to the fetched value.
    let resolveDetail!: (v: unknown) => void
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      const url = typeof input === 'string' ? input : input.toString()
      if (url.endsWith('/logs')) {
        return new Response(JSON.stringify({ success: true, data: { logs: LOGS } }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        })
      }
      const row = await new Promise<unknown>((r) => {
        resolveDetail = r
      })
      return new Response(JSON.stringify({ success: true, data: row }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })
    }) as typeof globalThis.fetch

    render(<AgentDetailView id="agent_01HFK" nowMs={NOW_MS} />)

    act(() => {
      wsTesting.setConnected(true)
      wsTesting.emitFrame({
        type: 'agent-updated',
        agentId: 'agent_01HFK',
        availability: 'online',
        status: 'running',
      })
    })

    // now resolve the fetch — view renders the fetched (online) value
    act(() => resolveDetail(makeRawDetailRow({ daemonStatus: 'online' })))
    expect(await screen.findByText('在线')).toBeInTheDocument()
  })

  it('falls back to polling fetch while the WS socket is disconnected', async () => {
    // shouldAdvanceTime keeps real timers running so findByText can poll the
    // DOM while fake timers control the poll interval.
    vi.useFakeTimers({ shouldAdvanceTime: true })

    // initial fetch returns offline; the next poll returns online.
    globalThis.fetch = makeFetch({
      row: makeRawDetailRow({ daemonStatus: 'offline' }),
      nextRow: makeRawDetailRow({ daemonStatus: 'online' }),
    })

    render(<AgentDetailView id="agent_01HFK" nowMs={NOW_MS} />)
    expect(await screen.findByText('离线')).toBeInTheDocument()

    // WS stays disconnected (no setConnected) → the polling effect is armed.
    // Advance past one poll interval (5s); the second fetch (nextRow=online)
    // lands and setDetail updates the availability pill.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(6_000)
    })
    expect(await screen.findByText('在线')).toBeInTheDocument()
    expect(screen.queryByText('离线')).not.toBeInTheDocument()
  })

  it('does not poll while the WS socket is connected', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true })

    const fetchStub = vi.fn(makeFetch({
      row: makeRawDetailRow({ daemonStatus: 'offline' }),
      nextRow: makeRawDetailRow({ daemonStatus: 'online' }),
    }))
    globalThis.fetch = fetchStub as unknown as typeof globalThis.fetch

    render(<AgentDetailView id="agent_01HFK" nowMs={NOW_MS} />)
    expect(await screen.findByText('离线')).toBeInTheDocument()
    const callsAfterMount = fetchStub.mock.calls.length

    // connect the socket — polling effect tears down its interval.
    act(() => wsTesting.setConnected(true))

    await act(async () => {
      vi.advanceTimersByTimeAsync(20_000)
    })

    // no extra detail fetches while connected (the live socket owns refresh)
    expect(fetchStub.mock.calls.length).toBe(callsAfterMount)
    // still showing the initial offline (no frame delivered, no poll)
    expect(screen.getByText('离线')).toBeInTheDocument()
  })
})
