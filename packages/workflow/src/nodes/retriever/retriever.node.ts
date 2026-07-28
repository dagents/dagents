import type { INode, INodeData, INodeOutput, IExecutionContext } from '../../types/index.js'

/**
 * Retriever node — stub for Plan A.
 *
 * Full implementation (RAG retrieval via vector store) is in Plan B. For now,
 * this node accepts a query and returns a placeholder so graphs containing
 * Retriever nodes can be executed linearly.
 *
 * Migrated from vendor/flowise/packages/components/nodes/agentflow/Retriever/Retriever.ts
 * (221 lines) — schema preserved, retrieval stubbed.
 */
export class RetrieverNode implements INode {
  label = 'Retriever'
  name = 'retrieverAgentflow'
  version = 1
  type = 'Retriever'
  category = 'data'
  color = '#06b6d4'
  inputs = [
    {
      label: 'Query',
      name: 'query',
      type: 'string' as const,
      description: 'The search query',
      acceptVariable: true,
      rows: 3,
    },
  ]

  async run(nodeData: INodeData, input: unknown, options: IExecutionContext): Promise<INodeOutput> {
    const query = (nodeData.inputs?.query as string) ?? (typeof input === 'string' ? input : '')

    return {
      id: nodeData.id,
      name: this.name,
      input: { query },
      output: {
        query,
        stub: true,
        message: 'Retriever not implemented in Plan A — see Plan B for full implementation',
      },
      state: options.state,
    }
  }
}
