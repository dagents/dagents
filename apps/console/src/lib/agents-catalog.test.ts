import { describe, it, expect } from 'vitest'
import {
  type AgentFilters,
  NO_FILTERS,
  deriveStatus,
  deriveLoad,
  deriveCost,
  deriveKpis,
  filterAgents,
  mapRowToCatalogAgent,
  normalizeKind,
  parseCapability,
  sumUsageTokens,
  eventToLogLine,
} from './agents-catalog'

/**
 * Pure-mapper unit tests for the agents catalogue (M5a.2 / P1.10.T4).
 *
 * These target the domain logic that turns raw dispatch rows into the catalogue
 * model — no network, no React, no DB. Keeping them pure (and in vitest's node
 * environment, matching sse.test.ts) means they run in milliseconds and pin
 * the status/load/cost derivation the view depends on.
 */

const baseRow = {
  id: 'agent-1',
  name: 'reader-04',
  kind: 'claude',
  capability_descriptor: {
    name: 'reader-04',
    summary: '阅读论文并抽取核心论点。',
    inputSchema: '{pdf_uri}',
    outputSchema: '{summary}',
    tags: ['reader', 'analysis'],
  },
  executable_path: 'claude',
  visibility: 'private',
  created_at: '2026-07-09T10:00:00Z',
  daemon_label: 'daemon-09',
  daemon_status: 'online',
  last_heartbeat_at: '2026-07-09T10:00:00Z',
  daemon_capabilities: [{ agentType: 'claude', tags: ['gpu', 'ap-northeast'] }],
  task_id: 'task-1',
  run_id: 'R-8821',
  task_status: 'running',
  usage: { claude: { inputTokens: 12000, outputTokens: 3400 } },
  duration_ms: null,
  task_created_at: '2026-07-09T09:55:00Z',
  finished_at: null,
} as const

describe('normalizeKind', () => {
  it('passes through known kinds', () => {
    expect(normalizeKind('prompt')).toBe('prompt')
    expect(normalizeKind('claude')).toBe('claude')
    expect(normalizeKind('codex')).toBe('codex')
    expect(normalizeKind('remote')).toBe('remote')
  })

  it('lowercases and maps unknown kinds to remote', () => {
    expect(normalizeKind('Gemini')).toBe('remote')
    expect(normalizeKind('copilot')).toBe('remote')
    expect(normalizeKind('something-new')).toBe('remote')
  })
})

describe('parseCapability', () => {
  it('returns the object as-is when already parsed', () => {
    const cap = { name: 'x', tags: ['reader'] }
    expect(parseCapability(cap)).toBe(cap)
  })

  it('parses a JSON string descriptor', () => {
    const cap = parseCapability('{"name":"x","tags":["reader"]}')
    expect(cap).toEqual({ name: 'x', tags: ['reader'] })
  })

  it('returns {} for invalid JSON / non-objects', () => {
    expect(parseCapability('not json')).toEqual({})
    expect(parseCapability(null)).toEqual({})
    expect(parseCapability(42)).toEqual({})
  })
})

describe('deriveStatus', () => {
  it('maps running task → running', () => {
    expect(deriveStatus('running', 'online')).toBe('running')
  })

  it('maps queued and claimed → queued', () => {
    expect(deriveStatus('queued', 'online')).toBe('queued')
    expect(deriveStatus('claimed', 'online')).toBe('queued')
  })

  it('maps failed → failed', () => {
    expect(deriveStatus('failed', 'online')).toBe('failed')
  })

  it('maps completed → idle (finished, awaiting work)', () => {
    expect(deriveStatus('completed', 'online')).toBe('idle')
    expect(deriveStatus('done', 'online')).toBe('idle')
  })

  it('maps no task → idle', () => {
    expect(deriveStatus(null, 'online')).toBe('idle')
    expect(deriveStatus(null, null)).toBe('idle')
  })
})

describe('deriveLoad', () => {
  it('returns 0 for idle/terminal tasks', () => {
    expect(deriveLoad(null, null)).toBe(0)
    expect(deriveLoad('completed', 1000)).toBe(0)
    expect(deriveLoad('failed', 1000)).toBe(0)
  })

  it('returns 10 for queued/claimed', () => {
    expect(deriveLoad('queued', null)).toBe(10)
    expect(deriveLoad('claimed', null)).toBe(10)
  })

  it('ramps with elapsed time for running, capped past 10min', () => {
    expect(deriveLoad('running', 0)).toBe(30) // 0 min → 30
    expect(deriveLoad('running', 60_000)).toBe(37) // 1 min → ~37
    expect(deriveLoad('running', 600_000)).toBeGreaterThanOrEqual(90) // 10 min → ~95
    // Past 10min the min(·,10) clamp holds the ramp at 95 — it never reaches 99
    // from elapsed alone (99 is reserved for the no-elapsed default + extra).
    expect(deriveLoad('running', 60_000 * 60)).toBe(95) // 1h → clamped 95
  })

  it('returns 50 for running with no elapsed', () => {
    expect(deriveLoad('running', null)).toBe(50)
  })
})

describe('deriveCost', () => {
  it('returns — when there is no usage', () => {
    expect(deriveCost(null)).toBe('—')
    expect(deriveCost({})).toBe('—')
    expect(deriveCost({ claude: {} })).toBe('—')
  })

  it('derives cost from token usage at $0.01/1k', () => {
    // 15400 tokens → $0.154 → $0.15
    expect(deriveCost({ claude: { inputTokens: 12000, outputTokens: 3400 } })).toBe('$0.15')
  })

  it('sums across models', () => {
    expect(deriveCost({ claude: { inputTokens: 1000 }, codex: { inputTokens: 1000 } })).toBe('$0.02')
  })
})

describe('sumUsageTokens', () => {
  it('sums input + output across all model entries', () => {
    expect(
      sumUsageTokens({ claude: { inputTokens: 100, outputTokens: 50 }, codex: { inputTokens: 10 } }),
    ).toBe(160)
  })

  it('returns 0 for non-objects', () => {
    expect(sumUsageTokens(null)).toBe(0)
    expect(sumUsageTokens('x')).toBe(0)
    expect(sumUsageTokens(42)).toBe(0)
  })
})

describe('mapRowToCatalogAgent', () => {
  it('maps a full running row', () => {
    const a = mapRowToCatalogAgent({ ...baseRow })
    expect(a.id).toBe('agent-1')
    expect(a.kind).toBe('claude')
    expect(a.roles).toEqual(['reader', 'analysis'])
    expect(a.status).toBe('running')
    expect(a.daemon).toBe('daemon-09')
    expect(a.region).toBe('ap-northeast')
    expect(a.run).toBe('R-8821')
    expect(a.cost).toBe('$0.15')
    expect(a.latestTaskId).toBe('task-1')
    expect(a.capability.summary).toBe('阅读论文并抽取核心论点。')
  })

  it('defaults daemon/region to — for an agent with no daemon', () => {
    const a = mapRowToCatalogAgent({
      ...baseRow,
      daemon_label: null,
      daemon_capabilities: [],
      daemon_status: null,
      last_heartbeat_at: null,
    })
    expect(a.daemon).toBe('—')
    expect(a.region).toBe('—')
  })

  it('maps an agent with no task to idle and null run', () => {
    const a = mapRowToCatalogAgent({
      ...baseRow,
      task_id: null,
      run_id: null,
      task_status: null,
      usage: null,
      duration_ms: null,
      task_created_at: null,
      finished_at: null,
    })
    expect(a.status).toBe('idle')
    expect(a.run).toBeNull()
    expect(a.cost).toBe('—')
    expect(a.load).toBe(0)
  })

  it('extracts region from a capabilities tag matching a region prefix', () => {
    const a = mapRowToCatalogAgent({
      ...baseRow,
      daemon_capabilities: [{ agentType: 'claude', tags: ['us-east-1', 'gpu'] }],
    })
    expect(a.region).toBe('us-east-1')
  })
})

describe('filterAgents', () => {
  const agents = [
    { id: '1', name: 'a', kind: 'claude' as const, roles: ['reader'], status: 'running' as const, load: 50, run: 'R1', cost: '$1', daemon: 'd', region: 'ap', latestTaskId: null, latestTaskStatus: null, elapsedMs: null, capability: {}, createdAt: '', daemonStatus: null, visibility: null },
    { id: '2', name: 'b', kind: 'codex' as const, roles: ['coding'], status: 'idle' as const, load: 0, run: null, cost: '—', daemon: 'd', region: 'us', latestTaskId: null, latestTaskStatus: null, elapsedMs: null, capability: {}, createdAt: '', daemonStatus: null, visibility: null },
    { id: '3', name: 'c', kind: 'prompt' as const, roles: ['verify'], status: 'failed' as const, load: 0, run: 'R3', cost: '$2', daemon: '—', region: '—', latestTaskId: null, latestTaskStatus: null, elapsedMs: null, capability: {}, createdAt: '', daemonStatus: null, visibility: null },
  ]

  it('returns all when no filters set', () => {
    expect(filterAgents(agents, NO_FILTERS)).toHaveLength(3)
  })

  it('filters by kind (single-select)', () => {
    const f: AgentFilters = { ...NO_FILTERS, kind: 'claude' }
    expect(filterAgents(agents, f)).toEqual([agents[0]])
  })

  it('filters by status', () => {
    const f: AgentFilters = { ...NO_FILTERS, status: 'failed' }
    expect(filterAgents(agents, f)).toEqual([agents[2]])
  })

  it('filters by role', () => {
    const f: AgentFilters = { ...NO_FILTERS, role: 'coding' }
    expect(filterAgents(agents, f)).toEqual([agents[1]])
  })

  it('filters by free-text over name/id/kind', () => {
    const f: AgentFilters = { ...NO_FILTERS, q: 'codex' }
    expect(filterAgents(agents, f)).toEqual([agents[1]])
    const f2: AgentFilters = { ...NO_FILTERS, q: 'b' }
    expect(filterAgents(agents, f2)).toEqual([agents[1]])
  })

  it('combines filters with AND', () => {
    const f: AgentFilters = { ...NO_FILTERS, kind: 'prompt', status: 'failed' }
    expect(filterAgents(agents, f)).toEqual([agents[2]])
    const none: AgentFilters = { ...NO_FILTERS, kind: 'claude', status: 'failed' }
    expect(filterAgents(agents, none)).toEqual([])
  })
})

describe('deriveKpis', () => {
  it('returns zeros for an empty list', () => {
    expect(deriveKpis([])).toEqual({ total: 0, running: 0, avgLoad: 0, failedRate: 0 })
  })

  it('counts running, averages load, and computes failed rate', () => {
    const agents = [
      { id: '1', name: 'a', kind: 'claude' as const, roles: [], status: 'running' as const, load: 80, run: null, cost: '—', daemon: 'd', region: '—', latestTaskId: null, latestTaskStatus: null, elapsedMs: null, capability: {}, createdAt: '', daemonStatus: null, visibility: null },
      { id: '2', name: 'b', kind: 'claude' as const, roles: [], status: 'running' as const, load: 40, run: null, cost: '—', daemon: 'd', region: '—', latestTaskId: null, latestTaskStatus: null, elapsedMs: null, capability: {}, createdAt: '', daemonStatus: null, visibility: null },
      { id: '3', name: 'c', kind: 'claude' as const, roles: [], status: 'idle' as const, load: 0, run: null, cost: '—', daemon: 'd', region: '—', latestTaskId: null, latestTaskStatus: null, elapsedMs: null, capability: {}, createdAt: '', daemonStatus: null, visibility: null },
      { id: '4', name: 'd', kind: 'claude' as const, roles: [], status: 'failed' as const, load: 0, run: null, cost: '—', daemon: 'd', region: '—', latestTaskId: null, latestTaskStatus: null, elapsedMs: null, capability: {}, createdAt: '', daemonStatus: null, visibility: null },
    ]
    const k = deriveKpis(agents)
    expect(k.total).toBe(4)
    expect(k.running).toBe(2)
    expect(k.avgLoad).toBe(30) // (80+40+0+0)/4
    expect(k.failedRate).toBe(25) // 1/4 = 25%
  })
})

describe('eventToLogLine', () => {
  const ts = new Date('2026-07-09T14:31:00Z')

  it('maps text → info with content', () => {
    expect(eventToLogLine({ type: 'text', content: 'hi' }, ts)).toEqual({
      ts: '2026-07-09T14:31:00.000Z',
      level: 'info',
      msg: 'hi',
    })
  })

  it('maps error → err', () => {
    expect(eventToLogLine({ type: 'error', content: 'boom' }, ts).level).toBe('err')
  })

  it('maps status → ok', () => {
    expect(eventToLogLine({ type: 'status', status: 'started' }, ts).level).toBe('ok')
    expect(eventToLogLine({ type: 'status', status: 'started' }, ts).msg).toBe('started')
  })

  it('maps tool-result → info with output', () => {
    const l = eventToLogLine({ type: 'tool-result', tool: 't', callId: 'c', output: 'done' }, ts)
    expect(l.level).toBe('info')
    expect(l.msg).toBe('done')
  })

  it('falls back to [type] when no message field', () => {
    expect(eventToLogLine({ type: 'thinking' }, ts).msg).toBe('[thinking]')
  })

  it('accepts an ISO string timestamp', () => {
    const l = eventToLogLine({ type: 'log', content: 'x' }, '2026-07-09T14:31:00Z')
    expect(l.ts).toBe('2026-07-09T14:31:00.000Z')
  })
})
