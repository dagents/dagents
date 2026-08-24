import type { INode, INodeData, INodeOutput, IExecutionContext } from '../../types/index.js'
import { resolveVariables } from '../../utils/variables.js'

/**
 * DirectReply node — directly reply to the user with a message.
 *
 * Migrated from vendor/flowise/packages/components/nodes/agentflow/DirectReply/DirectReply.ts
 * (67 lines). Behavior preserved: take `directReplyMessage` input, output as
 * `content`, and stream when last node + SSE present.
 *
 * Flowise dependencies removed:
 *   - `ICommonObject` → `IExecutionContext` (typed)
 *   - `IServerSideEventStreamer` → our `IServerSideEventStreamer` (same shape)
 *   - `options.agentflowRuntime?.state` → `options.state`
 */
/** 变量解析（resolveVariables）把上游 output 对象替换进模板时会
 *  stringify 成 JSON —— 回复文案要的是内层 text/content，不是 JSON 壳
 * （聊天里显示一坨 {"text":…} 看起来像工作流没生效）。 */
function unwrapJsonText(s: string): string {
  const t = s.trimStart()
  if (!t.startsWith('{')) return s
  try {
    const inner = JSON.parse(t) as Record<string, unknown>
    if (typeof inner.text === 'string' && inner.text) return inner.text
    if (typeof inner.content === 'string' && inner.content) return inner.content
  } catch {
    // 不是合法 JSON —— 按原文返回
  }
  return s
}

export class DirectReplyNode implements INode {
  label = 'Direct Reply'
  name = 'directReplyAgentflow'
  version = 1
  type = 'DirectReply'
  category = 'agent'
  color = '#8b5cf6'
  inputs = [
    {
      label: 'Message',
      name: 'directReplyMessage',
      type: 'string' as const,
      rows: 4,
      acceptVariable: true,
    },
  ]

  async run(nodeData: INodeData, _input: unknown, options: IExecutionContext): Promise<INodeOutput> {
    // Read the configured message. Prefer the canonical `directReplyMessage`
    // input name; fall back to `text`（画布元数据用的字段名）and `content`
    // （更老的 flow 数据）。三条名字都指向同一个配置。
    const rawMessage =
      (nodeData.inputs?.directReplyMessage as string) ??
      (nodeData.inputs?.text as string) ??
      (nodeData.inputs?.content as string) ??
      ''
    const directReplyMessage = unwrapJsonText(resolveVariables(rawMessage, options.state) as string)
    const isStreamable = options.isLastNode && options.sseStreamer !== undefined

    if (isStreamable) {
      options.sseStreamer!.streamTokenEvent(options.chatId, directReplyMessage)
    }

    return {
      id: nodeData.id,
      name: this.name,
      input: { message: rawMessage },
      output: { content: directReplyMessage },
      state: options.state,
    }
  }
}
