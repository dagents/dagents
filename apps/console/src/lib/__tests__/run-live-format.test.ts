import { describe, it, expect } from 'vitest'
import type { RunLiveFrame } from '@dagents/contracts'
import { createLiveSectionBuilder } from '@/lib/run-terminal-format'

/** live 帧流 → TerminalSection 增量构建测试（运行实时终端 2026-09）。
 *  语义对齐点：迭代重发合并 / 未知 kind 降级 log / 截断标记 / 懒建段。 */

const push = (b: ReturnType<typeof createLiveSectionBuilder>, frames: RunLiveFrame[]): void => {
  for (const f of frames) b.push(f)
}

describe('createLiveSectionBuilder', () => {
  it('完整生命周期：start → text/activity 增量 → end 终态', () => {
    const b = createLiveSectionBuilder()
    push(b, [
      { type: 'nodeStart', nodeId: 'n1', nodeName: '翻译', nodeType: 'llm' },
      { type: 'delta', nodeId: 'n1', nodeName: '翻译', delta: { type: 'text', text: '你好' } },
      { type: 'delta', nodeId: 'n1', nodeName: '翻译', delta: { type: 'text', text: '世界' } },
      {
        type: 'delta',
        nodeId: 'n1',
        nodeName: '翻译',
        delta: { type: 'activity', kind: 'thinking', label: '思考中' },
      },
      { type: 'nodeEnd', nodeId: 'n1', nodeName: '翻译', status: 'done', durationMs: 1200 },
    ])
    const [s] = b.sections()
    expect(s.title).toBe('翻译')
    expect(s.status).toBe('done')
    expect(s.durationMs).toBe(1200)
    expect(s.output).toBe('你好世界')
    expect(s.hasText).toBe(true)
    expect(s.nodeType).toBe('llm')
    expect(s.command).toBe('$ llm')
    expect(s.lines).toHaveLength(1)
    expect(s.lines[0]?.kind).toBe('thinking')
  })

  it('多节点按执行顺序排列（非拓扑猜测）', () => {
    const b = createLiveSectionBuilder()
    push(b, [
      { type: 'nodeStart', nodeId: 'a', nodeName: 'A' },
      { type: 'nodeStart', nodeId: 'b', nodeName: 'B' },
    ])
    expect(b.sections().map((s) => s.id)).toEqual(['a', 'b'])
  })

  it('迭代重发 start/end 合并同段：状态取最新，内容累积', () => {
    const b = createLiveSectionBuilder()
    push(b, [
      { type: 'nodeStart', nodeId: 'it', nodeName: '迭代' },
      { type: 'delta', nodeId: 'it', nodeName: '迭代', delta: { type: 'text', text: '第1项 ' } },
      { type: 'nodeEnd', nodeId: 'it', nodeName: '迭代', status: 'done', durationMs: 100 },
      // 控制器体内重发（executor 对迭代节点重发 start/end）
      { type: 'nodeStart', nodeId: 'it', nodeName: '迭代' },
      { type: 'delta', nodeId: 'it', nodeName: '迭代', delta: { type: 'text', text: '第2项' } },
    ])
    const sections = b.sections()
    expect(sections).toHaveLength(1)
    expect(sections[0]?.status).toBe('running')
    expect(sections[0]?.output).toBe('第1项 第2项')
  })

  it('失败 nodeEnd 携带 error；user_input 活动成高亮行', () => {
    const b = createLiveSectionBuilder()
    push(b, [
      { type: 'nodeStart', nodeId: 'n', nodeName: 'N' },
      {
        type: 'delta',
        nodeId: 'n',
        nodeName: 'N',
        delta: { type: 'activity', kind: 'user_input', label: '改用英文' },
      },
      { type: 'nodeEnd', nodeId: 'n', nodeName: 'N', status: 'failed', error: 'boom' },
    ])
    const [s] = b.sections()
    expect(s.error).toBe('boom')
    expect(s.status).toBe('failed')
    expect(s.lines[0]?.kind).toBe('user_input')
    expect(s.lines[0]?.label).toBe('改用英文')
  })

  it('未知活动 kind 降级为 log 行（不丢内容）', () => {
    const b = createLiveSectionBuilder()
    push(b, [
      { type: 'nodeStart', nodeId: 'n', nodeName: 'N' },
      {
        type: 'delta',
        nodeId: 'n',
        nodeName: 'N',
        delta: { type: 'activity', kind: 'future_kind', label: '新事件', detail: '全文' },
      },
    ])
    const [s] = b.sections()
    expect(s.lines[0]?.kind).toBe('log')
    expect(s.lines[0]?.detail).toBe('全文')
  })

  it('delta 早于 nodeStart（截断/竞态）→ 懒建段', () => {
    const b = createLiveSectionBuilder()
    push(b, [
      { type: 'delta', nodeId: 'x', nodeName: 'X', delta: { type: 'text', text: '先到' } },
    ])
    const [s] = b.sections()
    expect(s.id).toBe('x')
    expect(s.output).toBe('先到')
  })

  it('truncated 标记插到首段段首（早于任何段到达时挂起到首段）', () => {
    const b = createLiveSectionBuilder()
    push(b, [
      { type: 'truncated', dropped: 7 },
      { type: 'nodeStart', nodeId: 'n', nodeName: 'N' },
    ])
    const [s] = b.sections()
    expect(s.lines[0]?.kind).toBe('status')
    expect(s.lines[0]?.label).toContain('7')
  })

  it('truncated 标记晚到 → 补进现有首段段首', () => {
    const b = createLiveSectionBuilder()
    push(b, [
      { type: 'nodeStart', nodeId: 'n', nodeName: 'N' },
      { type: 'truncated', dropped: 3 },
    ])
    const [s] = b.sections()
    expect(s.lines[0]?.label).toContain('3')
  })

  it('runEnd 不产出内容（状态机属于 useRunLive）', () => {
    const b = createLiveSectionBuilder()
    push(b, [
      { type: 'nodeStart', nodeId: 'n', nodeName: 'N' },
      { type: 'runEnd', status: 'completed' },
    ])
    const [s] = b.sections()
    expect(s.status).toBe('running')
    expect(b.sections()).toHaveLength(1)
  })

  it('nodeType 透传到 command（platformAgent → agent）', () => {
    const b = createLiveSectionBuilder()
    push(b, [{ type: 'nodeStart', nodeId: 'n', nodeName: 'N', nodeType: 'platformAgent' }])
    expect(b.sections()[0]?.command).toBe('$ agent')
  })
})
