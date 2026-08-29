import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest'
import { render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import type React from 'react'
import type { FlowSummary, FlowDetailView } from '@/lib/flows'
import type { NodeSpansEnvelope } from '@/lib/node-spans'

// `next/navigation` is a server-context module the jsdom env can't resolve; mock
// it before importing the view. The M2.1 list-page wires an edit button that
// calls `router.push('/flows/'+fid+'/edit')` — the swap tests here don't drive
// that button, but the hook still runs on mount, so the mock must be in place.
const pushMock = vi.fn()
vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: pushMock, replace: vi.fn(), prefetch: vi.fn() }),
  usePathname: () => '/flows',
}))

// Imported lazily so the `next/navigation` mock above takes effect first.
async function renderView(): Promise<void> {
  const { FlowsView } = await import('@/components/flows-view')
  render(<FlowsView />)
}

/**
 * Component tests for the AgentFlows list↔detail swap (M2.2).
 *
 * Mirrors the design's `showDetail`/`hideDetail` contract (design/agentflows.html
 * L432-469): the list page renders a flow-card whose ▶ 运行 button (the run-row
 * was removed with the fabricated run history — the run button is now the list
 * page's entry into the detail) swaps the DOM into the detail page
 * (`.flow-detail-page.active`), mounting the DAG canvas + the inspector; the
 * 返回 AgentFlows button swaps back. The DAG itself (`FlowDag` → React Flow) is
 * exercised end-to-end in the e2e suite; here we assert the swap DOM contract +
 * the inspector's io-box sections the audit flagged (§1.x), keeping React
 * Flow's ResizeObserver dependency behind the setup-file polyfill so the canvas
 * mounts without erroring.
 *
 * The four console routes the view fetches are stubbed via `global.fetch`:
 *   GET  /api/workflows                        → flow list
 *   GET  /api/workflows/:id                    → flow detail (DAG)
 *   GET  /api/workflows/runs/:runId/node-spans → node-level spans (inspector)
 *   POST /api/workflows/:id/run                → run trigger (x-run-id header)
 */

const flows: FlowSummary[] = [
  {
    id: 'flow_repro_01',
    name: '论文复现流水线',
    type: 'AGENTFLOW',
    status: 'running',
    nodeCount: 2,
    updatedAt: '2026-07-09T14:20:00.000Z',
    versionHash: '7a3f9c',
    owner: null,
    archived: false,
    runCount: 1,
    latestRunId: 'run-flow_r',
  },
]

const detail: FlowDetailView = {
  id: 'flow_repro_01',
  name: '论文复现流水线',
  type: 'AGENTFLOW',
  versionHash: '7a3f9c',
  status: 'running',
  latestExecutionId: 'exec-1',
  latestRunId: 'run-flow_r',
  nodes: [
    { id: 'n1', label: '开始', type: 'Start', position: { x: 0, y: 0 }, status: 'done' },
    { id: 'n2', label: 'reader', type: 'Agent', position: { x: 200, y: 0 }, status: 'running' },
  ],
  edges: [{ id: 'e1', source: 'n1', target: 'n2' }],
  nodeMetrics: {
    n1: { nodeId: 'n1', status: 'done', executionId: 'exec-1', logs: [] },
    n2: { nodeId: 'n2', status: 'running', executionId: 'exec-1', logs: [{ ts: '2026-07-09T14:31:00.000Z', level: 'ok', msg: '14 claims extracted' }] },
  },
  updatedAt: '2026-07-09T14:31:00.000Z',
}

/** A 200 node-spans envelope carrying one persisted span for n1. */
const spansEnvelope: NodeSpansEnvelope = {
  success: true,
  data: {
    runId: 'run-flow_r',
    spans: [
      {
        nodeId: 'n1',
        nodeLabel: '开始',
        nodeType: 'Start',
        status: 'done',
        startedAt: null,
        finishedAt: '2026-07-09T14:31:00.000Z',
        durationMs: 100,
        tokens: { input_tokens: 10, output_tokens: 5 },
        cost: '0.012000',
        error: null,
        traceId: 'trace-abcdef0123456789',
      },
    ],
  },
}

function jsonResponse(body: unknown, init?: ResponseInit): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json', ...(init?.headers ?? {}) },
  })
}

/**
 * Stub `global.fetch` so the view's console routes resolve with the fixtures
 * above. The url-path matcher routes by pathname so a single stub answers all
 * the fetches the view makes on mount + on showDetail / runFlow.
 */
function stubFetch(): { calls: string[] } {
  const calls: string[] = []
  const BASE = 'http://localhost'
  vi.stubGlobal('fetch', async (input: string | URL | Request, init?: RequestInit) => {
    const req = input instanceof Request ? input : new Request(new URL(String(input), BASE), init)
    const path = new URL(req.url).pathname
    calls.push(path)
    if (path === '/api/workflows') return jsonResponse({ success: true, data: flows })
    if (path.startsWith('/api/workflows/') && path.endsWith('/node-spans')) {
      return jsonResponse(spansEnvelope)
    }
    if (path.startsWith('/api/workflows/') && path.endsWith('/run')) {
      // runFlow reads the run id from the x-run-id response header.
      return jsonResponse({ success: true }, { headers: { 'x-run-id': 'run-flow_r' } })
    }
    if (path.startsWith('/api/workflows/')) {
      return jsonResponse({ success: true, data: detail })
    }
    return jsonResponse({ success: false, error: 'not found' }, { status: 404 })
  })
  return { calls }
}

// jsdom has no location.hash in some vitest setups; ensure a stable window.
beforeEach(() => {
  pushMock.mockReset()
  if (typeof window !== 'undefined') {
    window.location.hash = ''
  }
})

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('FlowsView — list↔detail swap (M2.2)', () => {
  it('renders the list page on mount (flow-card + honest empty runs panel), detail page hidden', async () => {
    stubFetch()
    await renderView()

    // list page: the flow-card head is visible by name
    expect(await screen.findByText('论文复现流水线')).toBeInTheDocument()
    // detail page is present in the DOM but NOT active (display:none via the
    // `.flow-detail-page` (no `.active`) rule). The 返回 button is not focusable
    // to a sighted user until the swap; we assert its container has no active.
    const detailPage = document.querySelector('.flow-detail-page')
    expect(detailPage).not.toBeNull()
    expect(detailPage?.classList.contains('active')).toBe(false)
    // list page container IS active
    expect(document.querySelector('.flow-list-page')?.classList.contains('active')).toBe(true)
  })

  it('clicking the card\'s ▶ 运行 button swaps to the detail page', async () => {
    stubFetch()
    const user = userEvent.setup()
    await renderView()

    // the run button is the list page's entry into the detail page now that
    // the fabricated run-rows are gone
    const runBtn = await screen.findByRole('button', { name: /^运行$/ })
    expect(runBtn).toBeInTheDocument()

    // click 运行 → runFlow → showDetail → detail page becomes active
    await user.click(runBtn)
    const detailPage = document.querySelector('.flow-detail-page')
    expect(detailPage?.classList.contains('active')).toBe(true)
    expect(document.querySelector('.flow-list-page')?.classList.contains('active')).toBe(false)

    // the 返回 AgentFlows back button is now visible
    expect(await screen.findByRole('button', { name: '返回 AgentFlows 列表' })).toBeInTheDocument()
  })

  it('the 返回 button clears the selection and swaps back to the list page', async () => {
    stubFetch()
    const user = userEvent.setup()
    await renderView()

    // run → enter detail
    const runBtn = await screen.findByRole('button', { name: /^运行$/ })
    await user.click(runBtn)
    expect(document.querySelector('.flow-detail-page')?.classList.contains('active')).toBe(true)

    // back
    const back = await screen.findByRole('button', { name: '返回 AgentFlows 列表' })
    await user.click(back)
    expect(document.querySelector('.flow-detail-page')?.classList.contains('active')).toBe(false)
    expect(document.querySelector('.flow-list-page')?.classList.contains('active')).toBe(true)
  })

  it('renders the 6-status legend + the inspector with io-box sections in the detail page', async () => {
    stubFetch()
    const user = userEvent.setup()
    await renderView()

    // enter detail
    const runBtn = await screen.findByRole('button', { name: /^运行$/ })
    await user.click(runBtn)

    // legend: all 6 statuses present in the detail page
    const legend = await screen.findByText('运行', { selector: '.legend-flow .li' })
    const legendEl = legend.closest('.legend-flow') as HTMLElement
    for (const label of ['运行', '完成', '排队', '失败', '人工暂停', '未触发']) {
      expect(within(legendEl).getByText(label)).toBeInTheDocument()
    }

    // inspector: the io-box sections the audit flagged as missing (§1.x) now
    // render. Auto-selected first node (n1) drives the inspector. The run
    // button enters the detail via an async fetch chain (runFlow → showDetail
    // → detail fetch → auto-select), so poll until the NodeInspector sections
    // are present instead of asserting the intermediate FlowOverview.
    await waitFor(() => {
      const insp = document.querySelector('.flow-inspector')
      expect(insp).not.toBeNull()
      const labels = Array.from(insp!.querySelectorAll('.flow-insp-section .lbl')).map((el) => el.textContent)
      expect(labels).toContain('输入')
      expect(labels).toContain('输出')
      expect(labels).toContain('预算与计量')
    })
    const inspector = document.querySelector('.flow-inspector')
    // the n1 span carried input_tokens/output_tokens → the io-box is not "—"
    const ioBoxes = inspector!.querySelectorAll('.io-box')
    expect(ioBoxes.length).toBeGreaterThanOrEqual(2)
  })
})

// silence the unused-import lint for React (jsx-automatic); the import is
// retained for editor type info and is tree-shaken by esbuild.
export type _UnusedReactImport = typeof React