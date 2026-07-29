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
    const rawMessage = (nodeData.inputs?.directReplyMessage as string) ?? ''
    const directReplyMessage = resolveVariables(rawMessage, options.state) as string
    const isStreamable = options.isLastNode && options.sseStreamer !== undefined

    if (isStreamable) {
      options.sseStreamer!.streamTokenEvent(options.chatId, directReplyMessage)
    }

    return {
      id: nodeData.id,
      name: this.name,
      input: {},
      output: { content: directReplyMessage },
      state: options.state,
    }
  }
}
