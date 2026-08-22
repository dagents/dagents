import { describe, it, expect } from 'vitest'
import { parseWorkflowSuccessMessage } from '@/components/flow-preview-card'

/**
 * parseWorkflowSuccessMessage 单测 — 识别 gateway routeWorkflowCommand
 * （apps/gateway/src/routes/chat-execute.ts）成功时 persistComplete 落库的
 * markdown 消息。fixture 逐行对照 gateway 的 lines.join('\n') 输出，防止
 * 任一侧格式漂移导致卡片静默失效。
 */

const UUID = '0192c0de-aaaa-bbbb-cccc-ddddeeeeffff'

const SUCCESS_MESSAGE = [
  '✅ 工作流已创建（已通过结构校验）！',
  '',
  '**名称**: 代码审查工作流',
  '**节点数**: 4',
  '**引擎**: cli',
  '',
  `👉 [打开画布编辑](/workflows/${UUID}/canvas)`,
  '',
  '你可以在画布中调整节点参数，然后点击"发布"来运行它。',
].join('\n')

describe('parseWorkflowSuccessMessage', () => {
  it('parses a standard success message into card fields', () => {
    const info = parseWorkflowSuccessMessage(SUCCESS_MESSAGE)
    expect(info).not.toBeNull()
    expect(info?.flowId).toBe(UUID)
    expect(info?.flowName).toBe('代码审查工作流')
    expect(info?.nodeCount).toBe(4)
    expect(info?.engine).toBe('cli')
    expect(info?.repairRounds).toBeNull()
    expect(info?.warnings).toEqual([])
  })

  it('splits the repair-round suffix off the engine line and collects ⚠️ warnings', () => {
    const message = [
      '✅ 工作流已创建（已通过结构校验）！',
      '',
      '**名称**: 批量翻译',
      '**节点数**: 3',
      '**引擎**: cli-then-http（自动修复 1 轮后通过）',
      '',
      `👉 [打开画布编辑](/workflows/${UUID}/canvas)`,
      '',
      '⚠️ 生成结果中有 2 个无法识别的节点被丢弃（foo, bar），建议在画布中检查补齐。',
      '⚠️ node "llm_2" is not connected to any edge and will not execute',
    ].join('\n')
    const info = parseWorkflowSuccessMessage(message)
    expect(info?.engine).toBe('cli-then-http')
    expect(info?.repairRounds).toBe(1)
    expect(info?.warnings).toEqual([
      '生成结果中有 2 个无法识别的节点被丢弃（foo, bar），建议在画布中检查补齐。',
      'node "llm_2" is not connected to any edge and will not execute',
    ])
  })

  it('returns null for the explicit failure message (❌)', () => {
    const message = [
      '❌ 工作流生成失败，本次没有创建任何流程。',
      '',
      '生成的内容未通过结构校验（已自动修复一轮）。可以直接重试一次，或换一个更具体的描述。',
      `👉 [打开画布编辑](/workflows/${UUID}/canvas)`,
    ].join('\n')
    expect(parseWorkflowSuccessMessage(message)).toBeNull()
  })

  it('returns null for an ordinary assistant reply containing a canvas link', () => {
    // 只有链接、没有成功标记 —— 普通回复里引用画布路径不应命中。
    const message = `我已画好了，看这里 [打开画布编辑](/workflows/${UUID}/canvas)`
    expect(parseWorkflowSuccessMessage(message)).toBeNull()
  })

  it('returns null when the canvas link is missing (success marker alone)', () => {
    expect(parseWorkflowSuccessMessage('✅ 工作流已创建（已通过结构校验）！\n\n**名称**: x')).toBeNull()
  })

  it('returns null for empty input', () => {
    expect(parseWorkflowSuccessMessage('')).toBeNull()
  })

  it('tolerates a minimal message: marker + link only, meta lines absent', () => {
    const message = `✅ 工作流已创建\n\n👉 [打开画布编辑](/workflows/${UUID}/canvas)`
    const info = parseWorkflowSuccessMessage(message)
    expect(info?.flowId).toBe(UUID)
    expect(info?.flowName).toBeNull()
    expect(info?.nodeCount).toBeNull()
    expect(info?.engine).toBeNull()
  })

  it('keeps the flow id even when it is not a uuid (defensive: gateway id shape may change)', () => {
    const message = `✅ 工作流已创建\n\n👉 [打开画布编辑](/workflows/abc123/canvas)`
    expect(parseWorkflowSuccessMessage(message)?.flowId).toBe('abc123')
  })
})
