import { describe, it, expect } from 'vitest'
import {
  deriveTeamFeed,
  deriveCompanyTimeline,
  deriveRoster,
  type TeamOverview,
  type TeamRun,
  type TeamNode,
} from '../team-overview'

/**
 * Team Room 纯投影层单测（无网络/无 React，node 环境直跑）：
 * 帧差分活动墙、公司时间线泳道聚合、值班卡。
 */

function node(p: Partial<TeamNode> & { nodeId: string }): TeamNode {
  return {
    label: p.label ?? p.nodeId,
    nodeType: 'platformAgentAgentflow',
    status: 'running',
    startedAt: '2026-11-10T14:00:00Z',
    endedAt: null,
    durationMs: null,
    cost: null,
    error: null,
    agentId: 'a-1',
    agentName: '前端工程师',
    ...p,
  }
}

function run(p: Partial<TeamRun> & { runId: string; nodes: TeamNode[] }): TeamRun {
  return {
    flowId: 'f-1',
    flowName: '落地页冲刺',
    status: 'running',
    startedAt: '2026-11-10T14:00:00Z',
    finishedAt: null,
    durationMs: null,
    cost: null,
    directoryId: null,
    chatId: null,
    goalId: null,
    ...p,
  }
}

function overview(runs: TeamRun[], roster: TeamOverview['roster'] = []): TeamOverview {
  return {
    generatedAt: '2026-11-10T14:01:00Z',
    windowHours: 24,
    kpis: {
      runningRuns: 0,
      activeAgents: 0,
      runsCompleted: 0,
      runsFailed: 0,
      goalsActive: 0,
      goalsAchievedToday: 0,
      cost: 0,
      tokens: 0,
      unpricedTokens: 0,
    },
    running: runs,
    recentRuns: [],
    roster,
    blackboard: null,
    blackboardDirectoryName: null,
  }
}

describe('deriveTeamFeed', () => {
  it('状态迁移产出事件：idle→running=started、running→done=finished', () => {
    const prev = overview([run({ runId: 'r1', nodes: [node({ nodeId: 'n1', status: 'running' })] })])
    const next = overview([
      run({
        runId: 'r1',
        nodes: [
          node({ nodeId: 'n1', status: 'done', endedAt: '2026-11-10T14:00:38Z', durationMs: 38000 }),
          node({ nodeId: 'n2', label: '回归验证', status: 'running', startedAt: '2026-11-10T14:00:40Z' }),
        ],
      }),
    ])
    const feed = deriveTeamFeed(prev, next)
    expect(feed).toHaveLength(2)
    // 最新在前：n2 started（14:00:40）在 n1 finished（14:00:38）之前
    expect(feed[0]).toMatchObject({ kind: 'started', nodeLabel: '回归验证' })
    expect(feed[1]).toMatchObject({ kind: 'finished', durationMs: 38000, agentName: '前端工程师' })
  })

  it('失败节点产出 failed 事件并带 error', () => {
    const prev = overview([run({ runId: 'r1', nodes: [node({ nodeId: 'n1', status: 'running' })] })])
    const next = overview([
      run({ runId: 'r1', nodes: [node({ nodeId: 'n1', status: 'failed', error: 'exit 1' })] }),
    ])
    const feed = deriveTeamFeed(prev, next)
    expect(feed).toHaveLength(1)
    expect(feed[0]).toMatchObject({ kind: 'failed', error: 'exit 1' })
  })

  it('无变化帧 → 空事件（不刷屏）', () => {
    const frame = overview([run({ runId: 'r1', nodes: [node({ nodeId: 'n1', status: 'running' })] })])
    expect(deriveTeamFeed(frame, frame)).toEqual([])
  })
})

describe('deriveCompanyTimeline', () => {
  const NOW = Date.parse('2026-11-10T14:05:00Z')

  it('同 agent 跨 run 共享泳道；running 段开着', () => {
    const runs = [
      run({
        runId: 'r1',
        startedAt: '2026-11-10T13:00:00Z',
        nodes: [
          node({ nodeId: 'n1', status: 'done', startedAt: '2026-11-10T13:00:00Z', endedAt: '2026-11-10T13:01:00Z' }),
        ],
      }),
      run({
        runId: 'r2',
        startedAt: '2026-11-10T14:00:00Z',
        nodes: [node({ nodeId: 'n9', label: '实现', status: 'running' })],
      }),
    ]
    const tl = deriveCompanyTimeline(runs, NOW)
    // 同一 agent（a-1）一条 lane，两段
    expect(tl.lanes).toHaveLength(1)
    expect(tl.lanes[0]!.agentId).toBe('a-1')
    expect(tl.lanes[0]!.segments).toHaveLength(2)
    const open = tl.lanes[0]!.segments.find((s) => s.status === 'running')
    expect(open?.endMs).toBeNull()
    // 时间窗覆盖到 now（running 段延伸）
    expect(tl.maxMs).toBe(NOW)
  })

  it('非 agent 节点各占泳道（按 run:node 键）', () => {
    const runs = [
      run({
        runId: 'r1',
        nodes: [
          node({ nodeId: 'n1', agentId: null, agentName: null, label: '条件判断', nodeType: 'conditionAgentflow' }),
        ],
      }),
    ]
    const tl = deriveCompanyTimeline(runs, NOW)
    expect(tl.lanes).toHaveLength(1)
    expect(tl.lanes[0]!.agentId).toBeNull()
    expect(tl.lanes[0]!.label).toBe('条件判断')
  })

  it('空 span → 空时间线', () => {
    expect(deriveCompanyTimeline([], NOW)).toEqual({ lanes: [], minMs: 0, maxMs: 0 })
  })
})

describe('deriveRoster', () => {
  it('running 节点点亮值班卡；todayNodes 统计 24h 参与', () => {
    const ov = overview(
      [
        run({
          runId: 'r1',
          nodes: [
            node({ nodeId: 'n1', status: 'done' }),
            node({ nodeId: 'n2', label: '实现', status: 'running' }),
          ],
        }),
      ],
      [
        { agentId: 'a-1', name: '前端工程师', kind: 'claude' },
        { agentId: 'a-2', name: '测试工程师', kind: 'claude' },
      ],
    )
    const cards = deriveRoster(ov)
    const busy = cards.find((c) => c.agentId === 'a-1')
    expect(busy).toMatchObject({ busy: true, currentTask: '实现', currentRunId: 'r1', todayNodes: 2 })
    const idle = cards.find((c) => c.agentId === 'a-2')
    expect(idle).toMatchObject({ busy: false, todayNodes: 0 })
    // busy 在前
    expect(cards[0]!.agentId).toBe('a-1')
  })
})
