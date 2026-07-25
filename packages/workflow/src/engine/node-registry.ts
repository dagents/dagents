import type { INode } from '../types/node.js'

/**
 * Registry of node classes — maps node type names to their INode implementations.
 *
 * The executor looks up nodes by name (the `name` field on INode, which matches
 * the `FlowNode.data.name` or `FlowNode.type` in the graph). Register all nodes
 * at startup via `registerMany` (see `nodes/index.ts`).
 */
export class NodeRegistry {
  private readonly nodes = new Map<string, INode>()

  /** Register a single node. Throws if the name is already taken. */
  register(node: INode): void {
    if (this.nodes.has(node.name)) {
      throw new Error(`Node "${node.name}" is already registered`)
    }
    this.nodes.set(node.name, node)
  }

  /** Register multiple nodes at once. */
  registerMany(nodes: INode[]): void {
    for (const node of nodes) {
      this.register(node)
    }
  }

  /** Look up a node by its type name. Returns undefined if not found. */
  get(name: string): INode | undefined {
    return this.nodes.get(name)
  }

  /** List all registered node type names. */
  list(): string[] {
    return [...this.nodes.keys()]
  }
}
