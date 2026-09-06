import { DirectReplyNode } from './direct-reply/direct-reply.node.js'
import { IterationNode } from './iteration/iteration.node.js'
import { CustomFunctionNode } from './custom-function/custom-function.node.js'
import { HttpNode } from './http/http.node.js'
import { ConditionNode } from './condition/condition.node.js'
import { HumanInputNode } from './human-input/human-input.node.js'
import { StartNode } from './start/start.node.js'
import { LLMNode } from './llm/llm.node.js'
import { PlatformAgentNode } from './platform-agent/platform-agent.node.js'
import type { INode } from '../types/index.js'

// Re-export node classes for direct import
export { DirectReplyNode } from './direct-reply/direct-reply.node.js'
export { IterationNode } from './iteration/iteration.node.js'
export { CustomFunctionNode } from './custom-function/custom-function.node.js'
export { HttpNode } from './http/http.node.js'
export { ConditionNode } from './condition/condition.node.js'
export { HumanInputNode } from './human-input/human-input.node.js'
export { StartNode } from './start/start.node.js'
export { LLMNode } from './llm/llm.node.js'
export { PlatformAgentNode } from './platform-agent/platform-agent.node.js'

// Canvas node registry (metadata for the frontend editor)
export { CANVAS_NODES, NODE_CATEGORIES, getNodeMeta, getNodesByCategory } from './node-registry-canvas.js'
export type { CanvasNodeMeta } from './node-registry-canvas.js'

/**
 * All workflow nodes — register these with a NodeRegistry at startup.
 *
 *   const registry = new NodeRegistry()
 *   registry.registerMany(allNodes())
 */
export function allNodes(): INode[] {
  return [
    new StartNode(),
    new LLMNode(),
    new PlatformAgentNode(),
    new DirectReplyNode(),
    new IterationNode(),
    new CustomFunctionNode(),
    new HttpNode(),
    new ConditionNode(),
    new HumanInputNode(),
  ]
}
