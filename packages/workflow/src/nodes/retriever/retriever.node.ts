import type { INode, INodeData, INodeOutput, IExecutionContext } from '../../types/index.js'

/**
 * Retriever node — keyword retrieval over the host's document source.
 *
 * Migrated from vendor/flowise/packages/components/nodes/agentflow/Retriever/Retriever.ts.
 * The gateway injects a `historyRetriever` into the execution context (keyword
 * search over the chat's persisted messages today; any document store can be
 * wired the same way later) — the workflow package stays storage-free.
 *
 * Output: `{ query, docs, content }` where `content` is the docs joined as
 * text, so downstream LLM prompts consume it directly via the Flowise
 * content-string convention.
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
    {
      label: 'Top K',
      name: 'topK',
      type: 'number' as const,
      default: 4,
    },
  ]

  async run(nodeData: INodeData, input: unknown, options: IExecutionContext): Promise<INodeOutput> {
    const query = (nodeData.inputs?.query as string) ?? (typeof input === 'string' ? input : '')
    const rawTopK = Number(nodeData.inputs?.topK ?? 4)
    const topK = Number.isFinite(rawTopK) && rawTopK > 0 ? Math.min(Math.floor(rawTopK), 50) : 4

    if (!options.historyRetriever) {
      throw new Error(
        'Retriever node has no retrieval source — the execution host did not provide a historyRetriever',
      )
    }

    const docs = await options.historyRetriever(query, topK)
    const content = docs
      .map((d) => `[${d.role}] ${d.content}`)
      .join('\n')

    return {
      id: nodeData.id,
      name: this.name,
      input: { query, topK },
      output: { query, topK, docs, content },
      state: options.state,
    }
  }
}
