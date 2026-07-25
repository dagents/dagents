import { DirectReplyNode } from './direct-reply/direct-reply.node.js'
import { IterationNode } from './iteration/iteration.node.js'
import { LoopNode } from './loop/loop.node.js'
import { CustomFunctionNode } from './custom-function/custom-function.node.js'
import { HttpNode } from './http/http.node.js'
import { ConditionNode } from './condition/condition.node.js'
import { ToolNode } from './tool/tool.node.js'
import { RetrieverNode } from './retriever/retriever.node.js'
import type { INode } from '../types/index.js'

// Re-export node classes for direct import
export { DirectReplyNode } from './direct-reply/direct-reply.node.js'
export { IterationNode } from './iteration/iteration.node.js'
export { LoopNode } from './loop/loop.node.js'
export { CustomFunctionNode } from './custom-function/custom-function.node.js'
export { HttpNode } from './http/http.node.js'
export { ConditionNode } from './condition/condition.node.js'
export { ToolNode } from './tool/tool.node.js'
export { RetrieverNode } from './retriever/retriever.node.js'

/**
 * All Plan A nodes — register these with a NodeRegistry at startup.
 *
 *   const registry = new NodeRegistry()
 *   registry.registerMany(allNodes())
 *
 * Plan B will add: StartNode, LlmNode, AgentNode, ConditionAgentNode.
 */
export function allNodes(): INode[] {
  return [
    new DirectReplyNode(),
    new IterationNode(),
    new LoopNode(),
    new CustomFunctionNode(),
    new HttpNode(),
    new ConditionNode(),
    new ToolNode(),
    new RetrieverNode(),
  ]
}
