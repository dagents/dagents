/**
 * Find Platform Agent node references inside a flow.
 *
 * Used by the gateway before deleting an agent: any flow whose Platform Agent
 * node points to the agent blocks deletion.
 */

/**
 * Return the canvas node instance ids of Platform Agent nodes that reference
 * `agentId`. Both `data.inputs.agentId` and flattened `data.agentId` are checked
 * because Flowise serialisations differ.
 */
export function findAgentReferences(flowData: unknown, agentId: string): string[] {
  if (!flowData || typeof flowData !== 'object') return []
  const nodes = (flowData as { nodes?: unknown }).nodes
  if (!Array.isArray(nodes)) return []

  const matched: string[] = []
  for (const n of nodes) {
    if (!n || typeof n !== 'object') continue
    const node = n as {
      id?: unknown
      type?: unknown
      name?: unknown
      data?: unknown
    }
    if (node.type !== 'platformAgentAgentflow' && node.name !== 'platformAgentAgentflow') {
      continue
    }
    const data = node.data
    if (!data || typeof data !== 'object') continue
    const d = data as Record<string, unknown>
    const inputs = d.inputs
    const fromInputs =
      inputs && typeof inputs === 'object'
        ? (inputs as Record<string, unknown>).agentId
        : undefined
    const fromFlat = d.agentId
    const candidate = fromInputs ?? fromFlat
    if (candidate === agentId && typeof node.id === 'string') {
      matched.push(node.id)
    }
  }
  return matched
}
