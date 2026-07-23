import { describe, it, expect } from 'vitest'
import {
  attachmentName,
  buildWorkspaceRunBody,
  deriveProjectStatus,
  formatCost,
  formatTokens,
  quotaBars,
  quotaPercent,
  quotaTint,
  threadToMessages,
  type WorkspaceQuota,
} from './workspaces'

/**
 * Pure-mapper unit tests for the workspace domain model (M5b.1 / P1.10.T6).
 *
 * These target the domain logic that turns gateway rows into the view model —
 * no network, no React, no DB. Keeping them pure (and in vitest's node
 * environment, matching agents-catalog.test.ts) means they run in milliseconds
 * and pin the quota / status / thread derivation the view depends on.
 */

// Pin `now` and the run timestamps so day-separator math is deterministic
// regardless of the host timezone: runs land on the local calendar dates
// 2026-07-09 (run-1, run-2) and "now" is 2026-07-11 local → both runs are
// "2 天前" relative to now. Uses UTC instants whose local (Asia/Shanghai)
// dates are stable; the assertions below name those dates explicitly so a TZ
// change surfaces as a test failure rather than a silent drift.
const fixedNow = new Date('2026-07-10T16:00:00.000Z')

describe('deriveProjectStatus', () => {
  it('archived → done', () => {
    expect(deriveProjectStatus('archived', null, fixedNow)).toBe('done')
  })
  it('active with no thread → idle', () => {
    expect(deriveProjectStatus('active', null, fixedNow)).toBe('idle')
  })
  it('active with a thread turn in the last day → running', () => {
    expect(deriveProjectStatus('active', '2026-07-10T07:00:00.000Z', fixedNow)).toBe('running')
  })
  it('active with an older thread → idle', () => {
    expect(deriveProjectStatus('active', '2026-07-01T00:00:00.000Z', fixedNow)).toBe('idle')
  })
})

describe('quotaPercent + quotaTint', () => {
  it('is 0 when the cap is missing or 0', () => {
    expect(quotaPercent(undefined)).toBe(0)
    expect(quotaPercent({ used: 5, cap: 0 })).toBe(0)
  })
  it('rounds the used/cap ratio, capped at 100', () => {
    expect(quotaPercent({ used: 250, cap: 500 })).toBe(50)
    expect(quotaPercent({ used: 1820, cap: 5000 })).toBe(36)
    expect(quotaPercent({ used: 6000, cap: 5000 })).toBe(100)
  })
  it('tints danger at/over 100% and warn at/over 80%', () => {
    expect(quotaTint(100)).toBe('danger')
    expect(quotaTint(120)).toBe('danger')
    expect(quotaTint(95)).toBe('warn')
    expect(quotaTint(80)).toBe('warn')
    expect(quotaTint(50)).toBe('')
  })
})

describe('quotaBars', () => {
  const quota: WorkspaceQuota = {
    cost: { used: 1820, cap: 5000, unit: 'USD' },
    runs: { used: 412, cap: 2000 },
    tokens: { used: 18_400_000, cap: 80_000_000 },
  }
  const bars = quotaBars(quota)
  it('renders three bars (cost / runs / tokens)', () => {
    expect(bars.map((b) => b.key)).toEqual(['cost', 'runs', 'tokens'])
  })
  it('formats cost with the unit and tokens compactly', () => {
    const cost = bars.find((b) => b.key === 'cost')!
    expect(cost.value).toBe('$1,820 / $5,000')
    const tokens = bars.find((b) => b.key === 'tokens')!
    expect(tokens.value).toBe('18.4M / 80M')
    const runs = bars.find((b) => b.key === 'runs')!
    expect(runs.value).toBe('412 / 2000')
  })
  it('emits an empty bar for a missing facet', () => {
    const empty = quotaBars({})
    expect(empty.find((b) => b.key === 'cost')!.value).toBe('— / —')
    expect(empty.find((b) => b.key === 'cost')!.percent).toBe(0)
  })
})

describe('formatTokens / formatCost', () => {
  it('formatTokens uses K / M', () => {
    expect(formatTokens(999)).toBe('999')
    expect(formatTokens(1_000)).toBe('1K')
    expect(formatTokens(1_500_000)).toBe('1.5M')
  })
  it('formatCost maps USD to $', () => {
    expect(formatCost(1820, 'USD')).toBe('$1,820')
    expect(formatCost(60)).toBe('60')
  })
})

describe('attachmentName', () => {
  it('pulls the basename out of an S3 URI', () => {
    expect(attachmentName('s3://mil/runs/R-8821/results_skip.csv')).toBe('results_skip.csv')
  })
  it('drops a query string before splitting', () => {
    expect(attachmentName('s3://mil/runs/r1/report.md?version=1')).toBe('report.md')
  })
  it('returns null for empty / no-basename uris', () => {
    expect(attachmentName(null)).toBeNull()
    expect(attachmentName('')).toBeNull()
    expect(attachmentName('s3://mil/runs/r1/')).toBeNull()
  })
})

describe('buildWorkspaceRunBody', () => {
  it('builds a single-input fan-out body scoped to the workspace', () => {
    const body = buildWorkspaceRunBody({
      flowId: 'flow_repro_01',
      question: '复现这批论文',
      workspaceId: 'ws-1',
      runId: '11111111-1111-4111-8111-111111111111',
      identifier: 'ws-turn-11111111',
    })
    // scheduler fanOutBodySchema shape: flowId + pipelineId + identifier +
    // inputs (1 item) + workspaceId
    expect(body.flowId).toBe('flow_repro_01')
    expect(body.pipelineId).toBe('flow_repro_01')
    expect(body.identifier).toBe('ws-turn-11111111')
    expect(body.workspaceId).toBe('ws-1')
    expect(body.inputs).toHaveLength(1)
  })

  it('ships the Flowise prediction body (question + streaming:false + sessionId)', () => {
    const runId = '22222222-2222-4222-8222-222222222222'
    const body = buildWorkspaceRunBody({
      flowId: 'f',
      question: '下一批换成 offline RL',
      workspaceId: 'ws-2',
      runId,
      identifier: 'ws-turn-2',
    })
    expect(body.inputs[0]!.body).toEqual({
      question: '下一批换成 offline RL',
      streaming: false,
      overrideConfig: { sessionId: runId },
    })
  })

  it('uses the caller-supplied sessionId when provided (continue a conversation)', () => {
    const body = buildWorkspaceRunBody({
      flowId: 'f',
      question: '加一组对照',
      workspaceId: 'ws-3',
      runId: '33333333-3333-4333-8333-333333333333',
      identifier: 'ws-turn-3',
      sessionId: 'flowise-session-abc',
    })
    expect(body.inputs[0]!.body.overrideConfig.sessionId).toBe('flowise-session-abc')
  })
})

describe('threadToMessages', () => {
  const rows = [
    {
      id: 'run-1',
      identifier: 'R-8821',
      pipelineId: 'flow_repro_01',
      status: 'completed',
      input: { question: '复现这批论文' },
      output: { text: '已派发。预算 $18。' },
      artifactUri: 's3://mil/runs/R-8821/results_skip.csv',
      createdByUserId: 'u_rz',
      traceId: 'trace-1',
      createdAt: '2026-07-09T14:20:00.000Z',
      startedAt: '2026-07-09T14:20:00.000Z',
      finishedAt: '2026-07-09T14:21:00.000Z',
    },
    {
      id: 'run-2',
      identifier: 'R-8801',
      pipelineId: 'flow_repro_01',
      status: 'completed',
      input: { question: '下一批换成 offline RL' },
      output: { text: '已更新 batch 配置。' },
      artifactUri: null,
      createdByUserId: 'u_rz',
      traceId: 'trace-2',
      createdAt: '2026-07-08T17:02:00.000Z',
      startedAt: '2026-07-08T17:02:00.000Z',
      finishedAt: '2026-07-08T17:05:00.000Z',
    },
  ]

  it('splits each run into a user + bot message, oldest-first', () => {
    const msgs = threadToMessages(rows, '饶哲', 'RZ', fixedNow)
    // rows are newest-first; the view renders oldest-first (standard chat
    // order, auto-scroll to bottom = newest). So run-2 (older) comes before
    // run-1. 2 runs × 2 messages = 4.
    expect(msgs).toHaveLength(4)
    expect(msgs[0]!.role).toBe('human')
    expect(msgs[0]!.body).toBe('下一批换成 offline RL')
    expect(msgs[1]!.role).toBe('bot')
    expect(msgs[1]!.body).toBe('已更新 batch 配置。')
    expect(msgs[2]!.role).toBe('human')
    expect(msgs[2]!.body).toBe('复现这批论文')
    expect(msgs[3]!.body).toBe('已派发。预算 $18。')
  })

  it('attaches the run id (identifier) to both messages of a turn', () => {
    const msgs = threadToMessages(rows, '饶哲', 'RZ', fixedNow)
    // oldest-first: run-2 (R-8801) then run-1 (R-8821)
    expect(msgs[0]!.runId).toBe('R-8801')
    expect(msgs[1]!.runId).toBe('R-8801')
    expect(msgs[2]!.runId).toBe('R-8821')
    expect(msgs[3]!.runId).toBe('R-8821')
  })

  it('surfaces the artifact basename on the bot message', () => {
    const msgs = threadToMessages(rows, '饶哲', 'RZ', fixedNow)
    // run-2 has no artifact (oldest-first → msgs[1]); run-1 has results_skip.csv (msgs[3])
    expect(msgs[1]!.attachments).toEqual([])
    expect(msgs[3]!.attachments).toEqual(['results_skip.csv'])
  })

  it('emits a day separator on the first message of a new day', () => {
    const msgs = threadToMessages(rows, '饶哲', 'RZ', fixedNow)
    // Both runs share the same local calendar date (2026-07-09), so only the
    // FIRST message of the thread carries a day separator; the second turn's
    // user message has no separator (same day). The label is "2 天前" relative
    // to fixedNow (2026-07-11 local) — see the `fixedNow` comment above.
    expect(msgs[0]!.day).toBe('2 天前')
    // the bot reply is the same day → no separator
    expect(msgs[1]!.day).toBeUndefined()
    // run-1 is the same local day as run-2 → no new separator on its turn
    expect(msgs[2]!.day).toBeUndefined()
  })

  it('skips an empty question or answer', () => {
    const msgs = threadToMessages(
      [
        {
          ...rows[0]!,
          input: {},
          output: { text: '只有回答没有问题' },
        },
      ],
      '饶哲',
      'RZ',
      fixedNow,
    )
    // run-1 is "2 天前" relative to fixedNow → the sole bot message carries
    // the day separator (the user turn was dropped for an empty question).
    expect(msgs).toHaveLength(1)
    expect(msgs[0]!.role).toBe('bot')
    expect(msgs[0]!.body).toBe('只有回答没有问题')
    expect(msgs[0]!.day).toBe('2 天前')
  })
})
