import { describe, it, expect } from 'vitest'
import {
  LAB_MENTION_HANDLES,
  messagesToThread,
  normalizeToolCall,
  parseMentions,
  roleAvatarClass,
  roleInitial,
  roleName,
  roleTag,
  sessionStatusLabel,
  splitBodyMentions,
  type LabMessage,
} from './lab'

/**
 * Pure-mapper unit tests for the lab domain model (M5b.2 / P1.10.T7).
 *
 * These target the domain logic that turns gateway rows into the view model —
 * no network, no React, no DB. Keeping them pure (and in vitest's node
 * environment, matching workspaces.test.ts) means they run in milliseconds and
 * pin the role / mention / tool / thread derivation the view depends on.
 */

// Pin `now` so the day-separator math is deterministic regardless of host TZ.
// Host is UTC+8: "now" 2026-07-10T16:00Z → local 2026-07-11; m1/m2 on
// 2026-07-10T06:20Z → local 2026-07-10 ("昨天" rel to now); m3 on
// 2026-07-09T06:24Z → local 2026-07-09 ("2 天前"). The thread is oldest-first,
// so m3 renders first with "2 天前", then m1/m2 with "昨天".
const fixedNow = new Date('2026-07-10T16:00:00.000Z')

describe('sessionStatusLabel', () => {
  it('maps each status to the design label', () => {
    expect(sessionStatusLabel('running')).toBe('进行')
    expect(sessionStatusLabel('paused')).toBe('暂停')
    expect(sessionStatusLabel('done')).toBe('完成')
  })
})

describe('roleAvatarClass + roleInitial', () => {
  it('maps each role to its avatar class (system → orchestrator tint)', () => {
    expect(roleAvatarClass('human')).toBe('human')
    expect(roleAvatarClass('orchestrator')).toBe('orchestrator')
    expect(roleAvatarClass('reader')).toBe('reader')
    expect(roleAvatarClass('coder')).toBe('coder')
    expect(roleAvatarClass('verifier')).toBe('verifier')
    expect(roleAvatarClass('system')).toBe('orchestrator')
  })
  it('maps each role to its avatar initial', () => {
    expect(roleInitial('human')).toBe('H')
    expect(roleInitial('orchestrator')).toBe('O')
    expect(roleInitial('reader')).toBe('R')
    expect(roleInitial('coder')).toBe('C')
    expect(roleInitial('verifier')).toBe('V')
    expect(roleInitial('system')).toBe('S')
  })
})

describe('roleName', () => {
  it('human is always 你', () => {
    expect(roleName('human', null)).toBe('你')
    expect(roleName('human', 'someone')).toBe('你')
  })
  it('uses agentId when present', () => {
    expect(roleName('reader', 'reader-04')).toBe('reader-04')
  })
  it('falls back to the role default name when no agentId', () => {
    expect(roleName('orchestrator', null)).toBe('orchestrator-01')
    expect(roleName('reader', null)).toBe('reader-04')
    expect(roleName('coder', null)).toBe('coder-12')
    expect(roleName('verifier', null)).toBe('verifier-07')
    expect(roleName('system', null)).toBe('system')
  })
})

describe('roleTag', () => {
  it('human is 人工介入', () => {
    expect(roleTag('human', null)).toBe('人工介入')
  })
  it('each agent role has its @handle tag', () => {
    expect(roleTag('orchestrator', 'orchestrator-01')).toBe('@orchestrator')
    expect(roleTag('reader', 'reader-04')).toBe('@reader · reader')
    expect(roleTag('coder', 'coder-12')).toBe('@coder · coding')
    expect(roleTag('verifier', 'verifier-07')).toBe('@verifier · verify')
  })
  it('system uses the agentId', () => {
    expect(roleTag('system', 'gateway')).toBe('gateway')
    expect(roleTag('system', null)).toBe('system')
  })
})

describe('parseMentions', () => {
  it('extracts @handle tokens, de-duplicated, order-preserving', () => {
    expect(parseMentions('hi @orchestrator and @reader then @orchestrator again')).toEqual([
      { handle: 'orchestrator' },
      { handle: 'reader' },
    ])
  })
  it('returns empty for a body with no mentions', () => {
    expect(parseMentions('just a plain message')).toEqual([])
  })
  it('does not match an @ not followed by a letter (e.g. email-ish)', () => {
    expect(parseMentions('reach me at user@host')).toEqual([])
  })
  it('the composer chip handles are the canonical set', () => {
    expect([...LAB_MENTION_HANDLES]).toEqual(['orchestrator', 'reader', 'coder', 'verifier'])
  })
})

describe('splitBodyMentions (render path shares the parse regex)', () => {
  it('splits a body into plain + colored mention segments in source order', () => {
    expect(splitBodyMentions('派 @reader 抽取')).toEqual([
      { text: '派 ', mention: false },
      { text: '@reader', mention: true },
      { text: ' 抽取', mention: false },
    ])
  })
  it('does NOT color an email-ish @host (same lookbehind as parseMentions)', () => {
    // This is the regression the review caught: renderBody previously used a
    // regex without the lookbehind, so `user@host` was split into a colored
    // `@host`. The shared MENTION_RE excludes it — pin that here.
    const segs = splitBodyMentions('reach me at user@host')
    expect(segs.every((s) => s.mention === false)).toBe(true)
    expect(segs.map((s) => s.text).join('')).toBe('reach me at user@host')
  })
  it('colors a leading @handle at the start of the string', () => {
    expect(splitBodyMentions('@orchestrator 安排')).toEqual([
      { text: '@orchestrator', mention: true },
      { text: ' 安排', mention: false },
    ])
  })
  it('a body with no mentions is one plain segment', () => {
    expect(splitBodyMentions('plain text only')).toEqual([{ text: 'plain text only', mention: false }])
  })
})

describe('normalizeToolCall', () => {
  it('passes through an already-shaped { name, input, output }', () => {
    expect(normalizeToolCall({ name: 'read_paper', input: '§3.2', output: 'claims:[14]' })).toEqual({
      name: 'read_paper',
      input: '§3.2',
      output: 'claims:[14]',
    })
  })
  it('stringifies non-string input/output into the card shape', () => {
    expect(normalizeToolCall({ name: 'eval', input: { a: 1 }, output: [1, 2] })).toEqual({
      name: 'eval',
      input: '{"a":1}',
      output: '[1,2]',
    })
  })
  it('tolerates a Flowise usedTools element { tool: { name }, input, output }', () => {
    expect(
      normalizeToolCall({ tool: { name: 'run_sandbox' }, input: 'ppo_skip.py', output: 'forward ok' }),
    ).toEqual({ name: 'run_sandbox', input: 'ppo_skip.py', output: 'forward ok' })
  })
  it('returns null when there is no usable name', () => {
    expect(normalizeToolCall(null)).toBeNull()
    expect(normalizeToolCall({})).toBeNull()
    expect(normalizeToolCall({ input: 'x' })).toBeNull()
    expect(normalizeToolCall({ tool: {} })).toBeNull()
  })
  it('drops input/output when undefined (not stringified to "undefined")', () => {
    expect(normalizeToolCall({ name: 'noop' })).toEqual({ name: 'noop' })
  })
})

function msg(partial: Partial<LabMessage> & { id: string; role: LabMessage['role']; createdAt: string }): LabMessage {
  return {
    sessionId: 's1',
    parentId: null,
    agentId: null,
    runId: null,
    body: '',
    thinking: null,
    toolCall: null,
    ...partial,
  }
}

describe('messagesToThread', () => {
  it('keeps oldest-first order and tags the first message of each day', () => {
    // Gateway returns oldest-first; the test data below is in that order
    // (m3 Jul-9, then m1/m2 Jul-10). Host is UTC+8, so:
    //   m3 2026-07-09T06:24Z → local Jul-9 → "2 天前" rel to now (local Jul-11)
    //   m1 2026-07-10T06:20Z → local Jul-10 → "昨天"
    //   m2 2026-07-10T06:21Z → local Jul-10 → same day as m1, no separator
    const rows: LabMessage[] = [
      msg({ id: 'm3', role: 'reader', agentId: 'reader-04', createdAt: '2026-07-09T06:24:00.000Z', body: '论文 §3.2 用 8 层 attention' }),
      msg({ id: 'm1', role: 'human', createdAt: '2026-07-10T06:20:00.000Z', body: '复现 PPO 实验' }),
      msg({ id: 'm2', role: 'orchestrator', agentId: 'orchestrator-01', createdAt: '2026-07-10T06:21:00.000Z', body: '已拆解为 3 个子任务' }),
    ]
    const out = messagesToThread(rows, fixedNow)
    expect(out.map((m) => m.key)).toEqual(['m3', 'm1', 'm2'])
    expect(out[0]!.day).toBe('2 天前')
    expect(out[1]!.day).toBe('昨天')
    expect(out[2]!.day).toBeUndefined()
  })

  it('threads thinking + toolCall + runId through to the view model', () => {
    const rows: LabMessage[] = [
      msg({
        id: 'm1',
        role: 'reader',
        agentId: 'reader-04',
        runId: 'run-abc-123',
        createdAt: '2026-07-09T06:24:00.000Z',
        body: '已抽取',
        thinking: '先读再改再验',
        toolCall: { name: 'read_paper', input: '§3.2', output: 'claims:[14]' },
      }),
    ]
    const out = messagesToThread(rows, fixedNow)
    expect(out[0]).toMatchObject({
      role: 'reader',
      avatarClass: 'reader',
      initial: 'R',
      name: 'reader-04',
      roleTag: '@reader · reader',
      runId: 'run-abc-123',
      thinking: '先读再改再验',
      toolCall: { name: 'read_paper', input: '§3.2', output: 'claims:[14]' },
    })
  })

  it('parses @mentions out of the body for chip-coloring', () => {
    const rows: LabMessage[] = [
      msg({
        id: 'm1',
        role: 'orchestrator',
        agentId: 'orchestrator-01',
        createdAt: '2026-07-09T06:21:00.000Z',
        body: '派 @reader 抽取，@coder 实现，@verifier 验证',
      }),
    ]
    const out = messagesToThread(rows, fixedNow)
    expect(out[0]!.mentions.map((m) => m.handle)).toEqual(['reader', 'coder', 'verifier'])
  })

  it('normalizes a Flowise-shaped tool_call into the card shape', () => {
    const rows: LabMessage[] = [
      msg({
        id: 'm1',
        role: 'coder',
        agentId: 'coder-12',
        createdAt: '2026-07-09T06:31:00.000Z',
        body: '已实现',
        toolCall: { tool: { name: 'run_sandbox' }, input: 'ppo_skip.py', output: 'forward ok' } as never,
      }),
    ]
    const out = messagesToThread(rows, fixedNow)
    expect(out[0]!.toolCall).toEqual({ name: 'run_sandbox', input: 'ppo_skip.py', output: 'forward ok' })
  })

  it('returns an empty array for an empty thread', () => {
    expect(messagesToThread([], fixedNow)).toEqual([])
  })
})
