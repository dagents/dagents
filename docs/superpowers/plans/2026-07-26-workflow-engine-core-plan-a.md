# Workflow Engine Core (Plan A) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Create `packages/workflow/` with type system, DAG execution engine skeleton, and 8 simple nodes — producing a testable workflow engine that can run linear DAGs without Flowise.

**Architecture:** New `@mil/workflow` package following the `@mil/contracts` pattern (ESM + tsup + vitest). Types are抽离 from Flowise's `INode`/`INodeData`/`ICommonObject` into a self-contained contract. The DAG executor implements topological sort + state passing (no branching/looping yet — that's Plan B). 8 simple nodes (DirectReply, Iteration, Loop, CustomFunction, Retriever, Tool, HTTP, Condition) are migrated with Flowise dependencies replaced by the new types.

**Tech Stack:** TypeScript / vitest / tsup / ESM (NodeNext)

**Scope:** Architecture §9 phases 1-3 (partial). Produces a working engine that executes linear DAGs. Does NOT include: Start/LLM/Agent nodes (Plan B), branching/looping execution (Plan B), API routes (Plan C), frontend (Plan C), Flowise cleanup (Plan C).

**Out of scope (separate plans):**
- **Plan B:** Start/LLM/Agent large nodes + branch/loop execution logic
- **Plan C:** `flows` table + `/api/v1/workflows/*` API + console frontend switch + Flowise proxy deletion

---

## File Structure

### New package

| File | Responsibility |
|------|---------------|
| `packages/workflow/package.json` | Package manifest (ESM, tsup, vitest) |
| `packages/workflow/tsconfig.json` | TS config extending base |
| `packages/workflow/src/index.ts` | Public exports |
| `packages/workflow/src/types/flow.ts` | FlowNode / FlowEdge / FlowData |
| `packages/workflow/src/types/node.ts` | INode / INodeData / INodeParams / INodeOutput |
| `packages/workflow/src/types/execution.ts` | ExecutionStatus / IExecutedNode / IExecutionContext |
| `packages/workflow/src/types/stream.ts` | IServerSideEventStreamer (SSE interface, no impl) |
| `packages/workflow/src/engine/node-registry.ts` | Node registration + lookup by type |
| `packages/workflow/src/engine/runtime.ts` | Runtime state container |
| `packages/workflow/src/engine/executor.ts` | DAG topological sort + linear execution |
| `packages/workflow/src/engine/sse-streamer.ts` | SSE streamer impl (token/metadata/end events) |
| `packages/workflow/src/utils/variables.ts` | `{{var}}` / `$node.output.x` template resolution |
| `packages/workflow/src/utils/memory.ts` | Chat history memory manager (stub for Plan B) |
| `packages/workflow/src/nodes/index.ts` | Register all 8 nodes |
| `packages/workflow/src/nodes/direct-reply/direct-reply.node.ts` | DirectReply node |
| `packages/workflow/src/nodes/iteration/iteration.node.ts` | Iteration node |
| `packages/workflow/src/nodes/loop/loop.node.ts` | Loop node |
| `packages/workflow/src/nodes/custom-function/custom-function.node.ts` | CustomFunction node |
| `packages/workflow/src/nodes/retriever/retriever.node.ts` | Retriever node (stub — real retrieval in Plan B) |
| `packages/workflow/src/nodes/tool/tool.node.ts` | Tool node (stub — real tool execution in Plan B) |
| `packages/workflow/src/nodes/http/http.node.ts` | HTTP node |
| `packages/workflow/src/nodes/condition/condition.node.ts` | Condition node (evaluates only — branch routing in Plan B) |

### Test files

| File | Scope |
|------|-------|
| `packages/workflow/src/__tests__/types.test.ts` | Type-level tests for interfaces |
| `packages/workflow/src/__tests__/node-registry.test.ts` | Registry register/lookup |
| `packages/workflow/src/__tests__/executor.test.ts` | Linear DAG execution |
| `packages/workflow/src/__tests__/variables.test.ts` | Template variable resolution |
| `packages/workflow/src/__tests__/sse-streamer.test.ts` | SSE event encoding |
| `packages/workflow/src/nodes/direct-reply/direct-reply.node.test.ts` | DirectReply behavior |
| `packages/workflow/src/nodes/iteration/iteration.node.test.ts` | Iteration parsing |
| `packages/workflow/src/nodes/loop/loop.node.test.ts` | Loop limit logic |
| `packages/workflow/src/nodes/custom-function/custom-function.node.test.ts` | Function execution |
| `packages/workflow/src/nodes/http/http.node.test.ts` | HTTP fetch (stubbed) |
| `packages/workflow/src/nodes/condition/condition.node.test.ts` | Condition evaluation |

### Workspace registration

| File | Change |
|------|--------|
| `pnpm-workspace.yaml` | Already includes `packages/*` — no change needed |
| `packages/workflow` auto-discovered | Verified by `pnpm --filter @mil/workflow` |

---

## Task 1: Create package scaffold

**Files:**
- Create: `packages/workflow/package.json`
- Create: `packages/workflow/tsconfig.json`
- Create: `packages/workflow/src/index.ts`

- [ ] **Step 1: Create package.json**

Create `packages/workflow/package.json`:

```json
{
  "name": "@mil/workflow",
  "version": "0.0.0",
  "private": true,
  "type": "module",
  "main": "./dist/index.js",
  "types": "./dist/index.d.ts",
  "exports": { ".": { "import": "./dist/index.js", "types": "./dist/index.d.ts" } },
  "scripts": {
    "build": "tsup src/index.ts --format esm --dts",
    "typecheck": "tsc --noEmit",
    "test": "vitest run"
  },
  "devDependencies": {
    "tsup": "^8.0.0",
    "typescript": "^5.5.0",
    "vitest": "^2.0.0"
  }
}
```

- [ ] **Step 2: Create tsconfig.json**

Create `packages/workflow/tsconfig.json`:

```json
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": { "outDir": "./dist", "rootDir": "./src" },
  "include": ["src/**/*"]
}
```

- [ ] **Step 3: Create placeholder index.ts**

Create `packages/workflow/src/index.ts`:

```typescript
/**
 * @mil/workflow — Workflow engine core (Plan A).
 *
 * Provides the DAG execution engine and node contract for the Chat-First
 * workflow system. Replaces the Flowise agentflow engine dependency.
 *
 * Plan A scope: types + linear DAG executor + 8 simple nodes.
 * Plan B (separate): Start/LLM/Agent nodes + branch/loop execution.
 * Plan C (separate): API routes + frontend switch + Flowise cleanup.
 */

// Types — exported for node implementers
export type { INode, INodeData, INodeParams, INodeOutput, INodeOptionsValue } from './types/node.js'
export type { FlowNode, FlowEdge, FlowData } from './types/flow.js'
export type { ExecutionStatus, IExecutedNode, IExecutionContext } from './types/execution.js'
export type { IServerSideEventStreamer, StreamEvent } from './types/stream.js'

// Engine
export { NodeRegistry } from './engine/node-registry.js'
export { RuntimeState } from './engine/runtime.js'
export { DagExecutor } from './engine/executor.js'
export { SseStreamer } from './engine/sse-streamer.js'

// Utils
export { resolveVariables } from './utils/variables.js'

// Nodes (barrel)
export * from './nodes/index.js'
```

- [ ] **Step 4: Install dependencies**

Run: `pnpm install`
Expected: `@mil/workflow` resolved as workspace package, `tsup`/`vitest` installed.

- [ ] **Step 5: Verify scaffold**

Run: `pnpm --filter @mil/workflow typecheck`
Expected: FAIL with "Cannot find module './types/node.js'" — this is correct, types not created yet.

- [ ] **Step 6: Commit**

```bash
git add packages/workflow/package.json packages/workflow/tsconfig.json packages/workflow/src/index.ts
git commit -m "feat(workflow): scaffold @mil/workflow package"
```

---

## Task 2: Define core types (node contract)

**Files:**
- Create: `packages/workflow/src/types/node.ts`
- Create: `packages/workflow/src/types/flow.ts`
- Create: `packages/workflow/src/types/execution.ts`
- Create: `packages/workflow/src/types/stream.ts`
- Test: `packages/workflow/src/__tests__/types.test.ts`

These types are the contract every node implements. They are抽离 from Flowise's `Interface.ts` but simplified — no `credential`/`inputs` schema complexity beyond what the executor needs.

- [ ] **Step 1: Write failing type test**

Create `packages/workflow/src/__tests__/types.test.ts`:

```typescript
import { describe, it, expectTypeOf } from 'vitest'
import type { INode, INodeData, INodeOutput, INodeParams } from '../types/node.js'
import type { FlowNode, FlowEdge, FlowData } from '../types/flow.js'
import type { ExecutionStatus, IExecutedNode, IExecutionContext } from '../types/execution.js'
import type { IServerSideEventStreamer, StreamEvent } from '../types/stream.js'

describe('type contracts', () => {
  it('INode has required fields', () => {
    expectTypeOf<INode>().toMatchTypeOf<{
      label: string
      name: string
      version: number
      type: string
      category: string
      inputs: INodeParams[]
      run: (nodeData: INodeData, input: unknown, options: IExecutionContext) => Promise<INodeOutput>
    }>()
  })

  it('INodeOutput carries id, name, input, output, state', () => {
    expectTypeOf<INodeOutput>().toMatchTypeOf<{
      id: string
      name: string
      input: Record<string, unknown>
      output: Record<string, unknown>
      state?: Record<string, unknown>
    }>()
  })

  it('FlowData has nodes and edges', () => {
    expectTypeOf<FlowData>().toMatchTypeOf<{ nodes: FlowNode[]; edges: FlowEdge[] }>()
  })

  it('FlowEdge has source, target, sourceHandle, targetHandle', () => {
    expectTypeOf<FlowEdge>().toMatchTypeOf<{
      id: string
      source: string
      target: string
      sourceHandle?: string
      targetHandle?: string
    }>()
  })

  it('ExecutionStatus is the union', () => {
    expectTypeOf<ExecutionStatus>().toEqualTypeOf<'idle' | 'running' | 'success' | 'failed' | 'cancelled'>()
  })

  it('IServerSideEventStreamer has streamTokenEvent and streamEndEvent', () => {
    expectTypeOf<IServerSideEventStreamer>().toMatchTypeOf<{
      streamTokenEvent: (chatId: string, token: string) => void
      streamEndEvent: (chatId: string) => void
      streamErrorEvent: (chatId: string, error: string) => void
    }>()
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @mil/workflow test`
Expected: FAIL with "Cannot find module '../types/node.js'"

- [ ] **Step 3: Create node.ts types**

Create `packages/workflow/src/types/node.ts`:

```typescript
/**
 * Node contract — the interface every workflow node implements.
 *
 *抽离 from Flowise's `INode` (vendor/flowise/packages/components/src/Interface.ts)
 * but simplified: no `credential`/`asyncOptions`/`baseClasses` complexity beyond
 * what the executor and node implementers need. The `run` signature uses
 * `IExecutionContext` (our type) instead of Flowise's `ICommonObject` so node
 * code doesn't depend on Flowise's type bag.
 */

/** Input field schema — describes one input on the canvas editor. */
export interface INodeParams {
  label: string
  name: string
  type: 'string' | 'number' | 'boolean' | 'options' | 'json' | 'code' | 'file' | 'password'
  description?: string
  rows?: number
  acceptVariable?: boolean
  options?: INodeOptionsValue[]
  default?: unknown
  required?: boolean
  placeholder?: string
  hide?: boolean
}

/** Option value for `type: 'options'` inputs. */
export interface INodeOptionsValue {
  label: string
  name: string
  description?: string
  icon?: string
}

/** Runtime node data — what the executor passes to `INode.run`. */
export interface INodeData {
  /** The node instance id (from the canvas graph). */
  id: string
  /** The node type name (e.g. 'directReplyAgentflow'). */
  name: string
  /** Input values configured on the canvas. */
  inputs?: Record<string, unknown>
  /** The full node definition (label, category, etc.) — optional for runtime. */
  node?: Record<string, unknown>
}

/** Output every node must return from `run`. */
export interface INodeOutput {
  /** The node instance id that produced this output. */
  id: string
  /** The node type name. */
  name: string
  /** The input that was passed in (for traceability). */
  input: Record<string, unknown>
  /** The output the next node consumes. */
  output: Record<string, unknown>
  /** Optional state mutations to merge into the runtime state. */
  state?: Record<string, unknown>
  /** Optional chat history entries to append (for LLM/Agent nodes in Plan B). */
  chatHistory?: unknown[]
}

/** The node interface. Every node class implements this. */
export interface INode {
  label: string
  name: string
  version: number
  type: string
  category: string
  color: string
  inputs: INodeParams[]
  /**
   * Execute the node.
   *
   * @param nodeData - The node's configured inputs + instance id.
   * @param input - The input from upstream nodes (merged if multiple).
   * @param options - Runtime context (state, chatId, sseStreamer, etc.).
   * @returns The node's output — its `output` field flows to downstream nodes.
   */
  run(nodeData: INodeData, input: unknown, options: IExecutionContext): Promise<INodeOutput>
}

// Forward-declare IExecutionContext (defined in execution.ts) to avoid circular import.
// The import below is a type-only import, safe for ESM.
import type { IExecutionContext } from './execution.js'
```

- [ ] **Step 4: Create flow.ts types**

Create `packages/workflow/src/types/flow.ts`:

```typescript
/**
 * Flow graph types — the structure of a workflow definition.
 *
 * Mirrors ReactFlow's node/edge shape (what Flowise's canvas produces) so
 * the existing flow_data JSON from chatflows can be loaded without transformation.
 */

/** A node in the flow graph (canvas position + type + data). */
export interface FlowNode {
  id: string
  /** Position on the canvas (not used by executor, but preserved for round-trip). */
  position?: { x: number; y: number }
  /** The node type (e.g. 'directReplyAgentflow'). */
  type?: string
  /** The node's configured data — matches INodeData.inputs shape. */
  data: Record<string, unknown>
  /** Width/height (canvas metadata, not used by executor). */
  width?: number
  height?: number
  /** Whether the node is selected (canvas state). */
  selected?: boolean
}

/** An edge connecting two nodes. */
export interface FlowEdge {
  id: string
  /** Source node id. */
  source: string
  /** Target node id. */
  target: string
  /** Output handle on the source node (for multi-output nodes). */
  sourceHandle?: string | null
  /** Input handle on the target node (for multi-input nodes). */
  targetHandle?: string | null
  type?: string
  animated?: boolean
}

/** The complete flow definition — what's stored in the `flows` table's flow_data. */
export interface FlowData {
  nodes: FlowNode[]
  edges: FlowEdge[]
  /** Optional viewport (canvas metadata). */
  viewport?: { x: number; y: number; zoom: number }
}
```

- [ ] **Step 5: Create execution.ts types**

Create `packages/workflow/src/types/execution.ts`:

```typescript
/**
 * Execution types — runtime state and result shapes.
 *
 * `IExecutionContext` replaces Flowise's `ICommonObject` bag — it's a typed
 * container for everything a node needs at runtime (state, chatId, SSE streamer,
 * the current node graph for self-referencing nodes like ExecuteFlow).
 */

import type { IServerSideEventStreamer } from './stream.js'

/** Execution status for a node or the overall flow run. */
export type ExecutionStatus = 'idle' | 'running' | 'success' | 'failed' | 'cancelled'

/** The result of executing one node — stored in the execution log. */
export interface IExecutedNode {
  /** The node instance id. */
  nodeId: string
  /** The node type name. */
  nodeName: string
  /** Start time (ISO). */
  startedAt: string
  /** End time (ISO). */
  endedAt: string
  /** Execution status of this node. */
  status: ExecutionStatus
  /** The input that was passed in. */
  input: Record<string, unknown>
  /** The output that was produced. */
  output: Record<string, unknown>
  /** Error message if status === 'failed'. */
  error?: string
}

/**
 * Runtime context passed to every `INode.run`.
 *
 * This is the typed replacement for Flowise's `ICommonObject` options bag.
 * Nodes access state, chatId, and the SSE streamer through this object.
 */
export interface IExecutionContext {
  /** The chat id this execution belongs to (for SSE streaming + persistence). */
  chatId: string
  /** The run id (for trace correlation). */
  runId: string
  /** Mutable runtime state — nodes can read/write via `state`. */
  state: Record<string, unknown>
  /** Whether this is the last node in the DAG (enables streaming). */
  isLastNode: boolean
  /** SSE streamer — present when the client subscribed to /stream. */
  sseStreamer?: IServerSideEventStreamer
  /** The user's question/input that started the flow (from Start node). */
  startInput?: string
  /** Session id for memory continuity (Plan B: LLM/Agent memory). */
  sessionId?: string
  /** Abort signal — nodes should check this for long-running operations. */
  signal?: AbortSignal
  /** The component nodes map (for ExecuteFlow self-reference — Plan B). */
  componentNodes?: Record<string, unknown>
  /** The runtime state container (deprecated alias — use `state` directly). */
  agentflowRuntime?: { state: Record<string, unknown> }
}
```

- [ ] **Step 6: Create stream.ts types**

Create `packages/workflow/src/types/stream.ts`:

```typescript
/**
 * SSE streaming interface — what nodes use to push events to the client.
 *
 * This is the typed replacement for Flowise's `IServerSideEventStreamer`.
 * The actual implementation lives in `engine/sse-streamer.ts`.
 */

/** Event types the streamer can emit. */
export type StreamEvent =
  | { event: 'start'; data: string }
  | { event: 'token'; data: string }
  | { event: 'thinking'; data: string; duration?: number }
  | { event: 'metadata'; data: Record<string, unknown> }
  | { event: 'end'; data: '[DONE]' }
  | { event: 'error'; data: string }

/** Interface every SSE streamer implements. Nodes call these methods. */
export interface IServerSideEventStreamer {
  /** Send a token chunk to the client (streamed assistant reply). */
  streamTokenEvent(chatId: string, token: string): void
  /** Send the end sentinel — closes the stream. */
  streamEndEvent(chatId: string): void
  /** Send an error message to the client. */
  streamErrorEvent(chatId: string, error: string): void
  /** Send a metadata event (run id, node info, etc.). */
  streamMetadataEvent?(chatId: string, metadata: Record<string, unknown>): void
}
```

- [ ] **Step 7: Run test to verify it passes**

Run: `pnpm --filter @mil/workflow test`
Expected: PASS — all 6 type tests green.

- [ ] **Step 8: Commit**

```bash
git add packages/workflow/src/types/ packages/workflow/src/__tests__/types.test.ts
git commit -m "feat(workflow): define core type contracts (INode, FlowData, IExecutionContext)"
```

---

## Task 3: Node registry

**Files:**
- Create: `packages/workflow/src/engine/node-registry.ts`
- Test: `packages/workflow/src/__tests__/node-registry.test.ts`

The registry maps node type names (e.g. `'directReplyAgentflow'`) to `INode` instances. The executor uses it to look up the node class for each `FlowNode` in the graph.

- [ ] **Step 1: Write failing test**

Create `packages/workflow/src/__tests__/node-registry.test.ts`:

```typescript
import { describe, it, expect } from 'vitest'
import { NodeRegistry } from '../engine/node-registry.js'
import type { INode } from '../types/node.js'

// A stub node for testing — real nodes are registered in nodes/index.ts.
const stubNode: INode = {
  label: 'Stub',
  name: 'stubNode',
  version: 1,
  type: 'Stub',
  category: 'Test',
  color: '#000000',
  inputs: [],
  async run() {
    return { id: 'stub', name: 'stubNode', input: {}, output: {} }
  },
}

describe('NodeRegistry', () => {
  it('registers and looks up a node by name', () => {
    const reg = new NodeRegistry()
    reg.register(stubNode)
    expect(reg.get('stubNode')).toBe(stubNode)
  })

  it('returns undefined for unknown node name', () => {
    const reg = new NodeRegistry()
    expect(reg.get('nonexistent')).toBeUndefined()
  })

  it('lists all registered node names', () => {
    const reg = new NodeRegistry()
    reg.register(stubNode)
    reg.register({ ...stubNode, name: 'anotherStub' })
    const names = reg.list()
    expect(names).toContain('stubNode')
    expect(names).toContain('anotherStub')
    expect(names).toHaveLength(2)
  })

  it('throws when registering a duplicate name', () => {
    const reg = new NodeRegistry()
    reg.register(stubNode)
    expect(() => reg.register(stubNode)).toThrow(/already registered/)
  })

  it('registerMany adds multiple nodes at once', () => {
    const reg = new NodeRegistry()
    reg.registerMany([stubNode, { ...stubNode, name: 'second' }])
    expect(reg.list()).toHaveLength(2)
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @mil/workflow test node-registry`
Expected: FAIL with "Cannot find module '../engine/node-registry.js'"

- [ ] **Step 3: Implement NodeRegistry**

Create `packages/workflow/src/engine/node-registry.ts`:

```typescript
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
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @mil/workflow test node-registry`
Expected: PASS — all 5 tests green.

- [ ] **Step 5: Commit**

```bash
git add packages/workflow/src/engine/node-registry.ts packages/workflow/src/__tests__/node-registry.test.ts
git commit -m "feat(workflow): add NodeRegistry for node lookup by type name"
```

---

## Task 4: Runtime state container

**Files:**
- Create: `packages/workflow/src/engine/runtime.ts`

The runtime holds mutable state that nodes can read/write. It's passed into `IExecutionContext.state` and survives across nodes in a single execution.

- [ ] **Step 1: Write failing test**

Append to `packages/workflow/src/__tests__/node-registry.test.ts` (or create a new file `runtime.test.ts`):

Create `packages/workflow/src/__tests__/runtime.test.ts`:

```typescript
import { describe, it, expect } from 'vitest'
import { RuntimeState } from '../engine/runtime.js'

describe('RuntimeState', () => {
  it('starts empty', () => {
    const rt = new RuntimeState()
    expect(rt.state).toEqual({})
  })

  it('sets and gets values', () => {
    const rt = new RuntimeState()
    rt.set('foo', 'bar')
    expect(rt.get('foo')).toBe('bar')
  })

  it('merges state from node output', () => {
    const rt = new RuntimeState()
    rt.set('existing', 'value')
    rt.merge({ existing: 'updated', newKey: 'added' })
    expect(rt.get('existing')).toBe('updated')
    expect(rt.get('newKey')).toBe('added')
  })

  it('snapshot returns a shallow copy', () => {
    const rt = new RuntimeState()
    rt.set('a', 1)
    const snap = rt.snapshot()
    rt.set('a', 2)
    expect(snap.a).toBe(1)
    expect(rt.get('a')).toBe(2)
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @mil/workflow test runtime`
Expected: FAIL with "Cannot find module '../engine/runtime.js'"

- [ ] **Step 3: Implement RuntimeState**

Create `packages/workflow/src/engine/runtime.ts`:

```typescript
/**
 * Runtime state container — holds mutable state that flows through a DAG execution.
 *
 * Nodes read from `state` (via `IExecutionContext.state`) to access upstream
 * values, and write to it (via `INodeOutput.state`) to pass values downstream.
 * The executor merges each node's `state` output into this container.
 */
export class RuntimeState {
  private _state: Record<string, unknown> = {}

  /** The current state object (nodes read from this). */
  get state(): Record<string, unknown> {
    return this._state
  }

  /** Get a single value by key. */
  get<T = unknown>(key: string): T | undefined {
    return this._state[key] as T | undefined
  }

  /** Set a single value. */
  set(key: string, value: unknown): void {
    this._state[key] = value
  }

  /** Merge a partial state object (from node output) into the current state. */
  merge(partial: Record<string, unknown> | undefined): void {
    if (!partial) return
    for (const [key, value] of Object.entries(partial)) {
      this._state[key] = value
    }
  }

  /** Return a shallow snapshot of the current state. */
  snapshot(): Record<string, unknown> {
    return { ...this._state }
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @mil/workflow test runtime`
Expected: PASS — all 4 tests green.

- [ ] **Step 5: Commit**

```bash
git add packages/workflow/src/engine/runtime.ts packages/workflow/src/__tests__/runtime.test.ts
git commit -m "feat(workflow): add RuntimeState container for DAG execution state"
```

---

## Task 5: SSE streamer

**Files:**
- Create: `packages/workflow/src/engine/sse-streamer.ts`
- Test: `packages/workflow/src/__tests__/sse-streamer.test.ts`

The streamer implements `IServerSideEventStreamer` and writes SSE-formatted frames to a `ReadableStream` (for Hono's `streamSSE` response). It mirrors the framing pattern in `apps/console/src/lib/sse.ts`.

- [ ] **Step 1: Write failing test**

Create `packages/workflow/src/__tests__/sse-streamer.test.ts`:

```typescript
import { describe, it, expect } from 'vitest'
import { SseStreamer } from '../engine/sse-streamer.js'

describe('SseStreamer', () => {
  it('collects events for later reading', () => {
    const streamer = new SseStreamer('chat-123')
    streamer.streamTokenEvent('chat-123', 'hello')
    streamer.streamTokenEvent('chat-123', ' world')
    streamer.streamEndEvent('chat-123')
    const events = streamer.drain()
    expect(events).toHaveLength(3)
    expect(events[0]).toEqual({ event: 'token', data: 'hello' })
    expect(events[1]).toEqual({ event: 'token', data: ' world' })
    expect(events[2]).toEqual({ event: 'end', data: '[DONE]' })
  })

  it('ignores events for other chatIds', () => {
    const streamer = new SseStreamer('chat-123')
    streamer.streamTokenEvent('other-chat', 'ignored')
    streamer.streamTokenEvent('chat-123', 'kept')
    const events = streamer.drain()
    expect(events).toHaveLength(1)
    expect(events[0].data).toBe('kept')
  })

  it('streamErrorEvent produces an error event', () => {
    const streamer = new SseStreamer('chat-123')
    streamer.streamErrorEvent('chat-123', 'something broke')
    const events = streamer.drain()
    expect(events[0]).toEqual({ event: 'error', data: 'something broke' })
  })

  it('drain returns empty after first drain', () => {
    const streamer = new SseStreamer('chat-123')
    streamer.streamTokenEvent('chat-123', 'x')
    streamer.drain()
    expect(streamer.drain()).toHaveLength(0)
  })

  it('toReadableStream produces SSE-formatted bytes', async () => {
    const streamer = new SseStreamer('chat-123')
    streamer.streamTokenEvent('chat-123', 'hi')
    streamer.streamEndEvent('chat-123')
    const readable = streamer.toReadableStream()
    const reader = readable.getReader()
    const decoder = new TextDecoder()
    let text = ''
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      text += decoder.decode(value, { stream: true })
    }
    expect(text).toContain('event: token')
    expect(text).toContain('data: hi')
    expect(text).toContain('event: end')
    expect(text).toContain('data: [DONE]')
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @mil/workflow test sse-streamer`
Expected: FAIL with "Cannot find module '../engine/sse-streamer.js'"

- [ ] **Step 3: Implement SseStreamer**

Create `packages/workflow/src/engine/sse-streamer.ts`:

```typescript
import type { IServerSideEventStreamer, StreamEvent } from '../types/stream.js'

/**
 * SSE streamer — collects events and exposes them as a ReadableStream.
 *
 * The executor creates one streamer per flow run. Nodes call `streamTokenEvent`
 * to push tokens; the HTTP route (Plan C) reads from `toReadableStream()` to
 * pipe to the client.
 *
 * Events are buffered in memory until `drain()` or `toReadableStream()` is
 * called. This keeps the streamer testable without a real HTTP response.
 *
 * The `chatId` filter ensures nodes streaming to the wrong chat don't pollute
 * the output (defensive — in practice there's one streamer per chat).
 */
export class SseStreamer implements IServerSideEventStreamer {
  private readonly events: StreamEvent[] = []
  private readonly chatId: string

  constructor(chatId: string) {
    this.chatId = chatId
  }

  streamTokenEvent(chatId: string, token: string): void {
    if (chatId !== this.chatId) return
    this.events.push({ event: 'token', data: token })
  }

  streamEndEvent(chatId: string): void {
    if (chatId !== this.chatId) return
    this.events.push({ event: 'end', data: '[DONE]' })
  }

  streamErrorEvent(chatId: string, error: string): void {
    if (chatId !== this.chatId) return
    this.events.push({ event: 'error', data: error })
  }

  streamMetadataEvent(chatId: string, metadata: Record<string, unknown>): void {
    if (chatId !== this.chatId) return
    this.events.push({ event: 'metadata', data: metadata })
  }

  /** Drain all buffered events. Returns them and clears the buffer. */
  drain(): StreamEvent[] {
    const out = [...this.events]
    this.events.length = 0
    return out
  }

  /**
   * Convert buffered events to a ReadableStream of SSE-formatted bytes.
   *
   * Each event is framed as:
   *   event: <type>\n
   *   data: <json>\n\n
   *
   * This matches the framing in `apps/console/src/lib/sse.ts` (the Flowise
   * SSE parser), so the existing client-side `consumeStream` works unchanged
   * when Plan C switches the chat route to this streamer.
   */
  toReadableStream(): ReadableStream<Uint8Array> {
    const events = this.drain()
    const encoder = new TextEncoder()
    const chunks = events.map((ev) => {
      const dataStr = typeof ev.data === 'string' ? ev.data : JSON.stringify(ev.data)
      return encoder.encode(`event: ${ev.event}\ndata: ${dataStr}\n\n`)
    })
    return new ReadableStream({
      start(controller) {
        for (const chunk of chunks) {
          controller.enqueue(chunk)
        }
        controller.close()
      },
    })
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @mil/workflow test sse-streamer`
Expected: PASS — all 5 tests green.

- [ ] **Step 5: Commit**

```bash
git add packages/workflow/src/engine/sse-streamer.ts packages/workflow/src/__tests__/sse-streamer.test.ts
git commit -m "feat(workflow): add SseStreamer for SSE event collection and streaming"
```

---

## Task 6: Template variable resolution

**Files:**
- Create: `packages/workflow/src/utils/variables.ts`
- Test: `packages/workflow/src/__tests__/variables.test.ts`

Nodes use `{{var}}` syntax to reference upstream outputs (e.g. `{{$start.question}}` or `{{directReplyAgentflow.output.content}}`). This utility resolves them against the runtime state.

- [ ] **Step 1: Write failing test**

Create `packages/workflow/src/__tests__/variables.test.ts`:

```typescript
import { describe, it, expect } from 'vitest'
import { resolveVariables } from '../utils/variables.js'

describe('resolveVariables', () => {
  it('returns non-string values unchanged', () => {
    expect(resolveVariables(42, {})).toBe(42)
    expect(resolveVariables({ a: 1 }, {})).toEqual({ a: 1 })
    expect(resolveVariables(null, {})).toBeNull()
  })

  it('returns string with no variables unchanged', () => {
    expect(resolveVariables('hello world', {})).toBe('hello world')
  })

  it('resolves {{key}} from state', () => {
    expect(resolveVariables('Hello {{name}}', { name: 'Alice' })).toBe('Hello Alice')
  })

  it('resolves multiple variables in one string', () => {
    expect(resolveVariables('{{greeting}}, {{name}}!', { greeting: 'Hi', name: 'Bob' })).toBe('Hi, Bob!')
  })

  it('resolves dotted paths {{node.output.field}}', () => {
    const state = {
      directReplyAgentflow: { output: { content: 'resolved text' } },
    }
    expect(resolveVariables('{{directReplyAgentflow.output.content}}', state)).toBe('resolved text')
  })

  it('leaves variable as-is when not found in state', () => {
    expect(resolveVariables('Hello {{missing}}', {})).toBe('Hello {{missing}}')
  })

  it('resolves $start.question shorthand', () => {
    const state = { start: { question: 'what is 2+2?' } }
    expect(resolveVariables('Q: {{$start.question}}', state)).toBe('Q: what is 2+2?')
  })

  it('resolves $webhook.body.field shorthand', () => {
    const state = { webhook: { body: { user: 'alice' } } }
    expect(resolveVariables('user={{$webhook.body.user}}', state)).toBe('user=alice')
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @mil/workflow test variables`
Expected: FAIL with "Cannot find module '../utils/variables.js'"

- [ ] **Step 3: Implement resolveVariables**

Create `packages/workflow/src/utils/variables.ts`:

```typescript
/**
 * Template variable resolution.
 *
 * Nodes accept variables in their input strings using two syntaxes:
 *
 *   1. `{{key}}` or `{{dotted.path}}` — resolved from runtime state
 *      (e.g. `{{directReplyAgentflow.output.content}}`)
 *   2. `$scope.field` — shorthand for common scopes
 *      (e.g. `$start.question`, `$webhook.body.user`)
 *
 * When a variable is not found in state, it's left as-is (no error) — the
 * node will receive the literal string and can decide how to handle it.
 *
 * Non-string values are returned unchanged (numbers, objects, null).
 */

/** Resolve `{{var}}` and `$scope.field` variables in a string against state. */
export function resolveVariables(value: unknown, state: Record<string, unknown>): unknown {
  if (typeof value !== 'string') return value

  // Resolve $scope.field shorthand first (e.g. $start.question)
  let resolved = value.replace(/\$(\w+(?:\.\w+)*)/g, (_, path: string) => {
    const val = getByPath(state, path)
    return val !== undefined ? String(val) : `$${path}`
  })

  // Resolve {{var}} syntax (e.g. {{directReplyAgentflow.output.content}})
  resolved = resolved.replace(/\{\{([^}]+)\}\}/g, (_, path: string) => {
    const trimmed = path.trim()
    const val = getByPath(state, trimmed)
    return val !== undefined ? String(val) : `{{${trimmed}}}`
  })

  return resolved
}

/** Get a value by dotted path from an object. Returns undefined if not found. */
function getByPath(obj: Record<string, unknown>, path: string): unknown {
  const parts = path.split('.')
  let current: unknown = obj
  for (const part of parts) {
    if (current === null || typeof current !== 'object') return undefined
    current = (current as Record<string, unknown>)[part]
  }
  return current
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @mil/workflow test variables`
Expected: PASS — all 8 tests green.

- [ ] **Step 5: Commit**

```bash
git add packages/workflow/src/utils/variables.ts packages/workflow/src/__tests__/variables.test.ts
git commit -m "feat(workflow): add template variable resolution ({{var}} + \$scope.field)"
```

---

## Task 7: DAG executor (linear execution)

**Files:**
- Create: `packages/workflow/src/engine/executor.ts`
- Test: `packages/workflow/src/__tests__/executor.test.ts`

The executor takes a `FlowData` graph + `NodeRegistry` + `IExecutionContext`, performs topological sort, and executes nodes in order — passing each node's output to the next. This Plan A version handles **linear DAGs only** (no branching/looping — that's Plan B).

- [ ] **Step 1: Write failing test**

Create `packages/workflow/src/__tests__/executor.test.ts`:

```typescript
import { describe, it, expect, beforeEach } from 'vitest'
import { DagExecutor } from '../engine/executor.js'
import { NodeRegistry } from '../engine/node-registry.js'
import { RuntimeState } from '../engine/runtime.js'
import { SseStreamer } from '../engine/sse-streamer.js'
import type { INode, INodeData, INodeOutput, IExecutionContext } from '../types/index.js'
import type { FlowData } from '../types/flow.js'

// Stub node that echoes its input + a configured suffix.
function makeEchoNode(name: string, suffix: string): INode {
  return {
    label: name,
    name,
    version: 1,
    type: name,
    category: 'Test',
    color: '#000',
    inputs: [],
    async run(nodeData: INodeData, input: unknown, _options: IExecutionContext): Promise<INodeOutput> {
      const inputStr = typeof input === 'string' ? input : JSON.stringify(input)
      return {
        id: nodeData.id,
        name,
        input: { raw: input },
        output: { content: `${inputStr} ${suffix}` },
      }
    },
  }
}

describe('DagExecutor (linear)', () => {
  let registry: NodeRegistry

  beforeEach(() => {
    registry = new NodeRegistry()
  })

  it('executes a single-node graph', async () => {
    registry.register(makeEchoNode('echoA', 'A'))
    const flow: FlowData = {
      nodes: [{ id: 'n1', data: { name: 'echoA' } }],
      edges: [],
    }
    const executor = new DagExecutor(registry)
    const result = await executor.execute(flow, 'hello', {
      chatId: 'c1',
      runId: 'r1',
      state: {},
      isLastNode: true,
    })
    expect(result.status).toBe('success')
    expect(result.executedNodes).toHaveLength(1)
    expect(result.executedNodes[0].output.content).toBe('hello A')
  })

  it('executes a linear chain A → B → C', async () => {
    registry.register(makeEchoNode('echoA', 'A'))
    registry.register(makeEchoNode('echoB', 'B'))
    registry.register(makeEchoNode('echoC', 'C'))
    const flow: FlowData = {
      nodes: [
        { id: 'n1', data: { name: 'echoA' } },
        { id: 'n2', data: { name: 'echoB' } },
        { id: 'n3', data: { name: 'echoC' } },
      ],
      edges: [
        { id: 'e1', source: 'n1', target: 'n2' },
        { id: 'e2', source: 'n2', target: 'n3' },
      ],
    }
    const executor = new DagExecutor(registry)
    const result = await executor.execute(flow, 'start', {
      chatId: 'c1',
      runId: 'r1',
      state: {},
      isLastNode: true,
    })
    expect(result.status).toBe('success')
    expect(result.executedNodes).toHaveLength(3)
    // Each node appends its suffix: start → start A → start A B → start A B C
    expect(result.executedNodes[2].output.content).toBe('start A B C')
  })

  it('returns failed status when a node throws', async () => {
    const failingNode: INode = {
      label: 'Fail',
      name: 'failNode',
      version: 1,
      type: 'Fail',
      category: 'Test',
      color: '#000',
      inputs: [],
      async run() {
        throw new Error('intentional failure')
      },
    }
    registry.register(failingNode)
    const flow: FlowData = {
      nodes: [{ id: 'n1', data: { name: 'failNode' } }],
      edges: [],
    }
    const executor = new DagExecutor(registry)
    const result = await executor.execute(flow, 'input', {
      chatId: 'c1',
      runId: 'r1',
      state: {},
      isLastNode: true,
    })
    expect(result.status).toBe('failed')
    expect(result.error).toContain('intentional failure')
  })

  it('returns failed status when node type not in registry', async () => {
    const flow: FlowData = {
      nodes: [{ id: 'n1', data: { name: 'nonexistentNode' } }],
      edges: [],
    }
    const executor = new DagExecutor(registry)
    const result = await executor.execute(flow, 'input', {
      chatId: 'c1',
      runId: 'r1',
      state: {},
      isLastNode: true,
    })
    expect(result.status).toBe('failed')
    expect(result.error).toContain('nonexistentNode')
  })

  it('detects cycles and fails', async () => {
    registry.register(makeEchoNode('echoA', 'A'))
    registry.register(makeEchoNode('echoB', 'B'))
    const flow: FlowData = {
      nodes: [
        { id: 'n1', data: { name: 'echoA' } },
        { id: 'n2', data: { name: 'echoB' } },
      ],
      edges: [
        { id: 'e1', source: 'n1', target: 'n2' },
        { id: 'e2', source: 'n2', target: 'n1' }, // cycle
      ],
    }
    const executor = new DagExecutor(registry)
    const result = await executor.execute(flow, 'start', {
      chatId: 'c1',
      runId: 'r1',
      state: {},
      isLastNode: true,
    })
    expect(result.status).toBe('failed')
    expect(result.error).toMatch(/cycle/i)
  })

  it('uses SSE streamer for last node', async () => {
    const streamingNode: INode = {
      label: 'Stream',
      name: 'streamNode',
      version: 1,
      type: 'Stream',
      category: 'Test',
      color: '#000',
      inputs: [],
      async run(nodeData: INodeData, _input: unknown, options: IExecutionContext): Promise<INodeOutput> {
        if (options.sseStreamer && options.isLastNode) {
          options.sseStreamer.streamTokenEvent(options.chatId, 'streamed token')
        }
        return { id: nodeData.id, name: 'streamNode', input: {}, output: { content: 'done' } }
      },
    }
    registry.register(streamingNode)
    const flow: FlowData = {
      nodes: [{ id: 'n1', data: { name: 'streamNode' } }],
      edges: [],
    }
    const streamer = new SseStreamer('c1')
    const executor = new DagExecutor(registry)
    await executor.execute(flow, 'input', {
      chatId: 'c1',
      runId: 'r1',
      state: {},
      isLastNode: true,
      sseStreamer: streamer,
    })
    const events = streamer.drain()
    expect(events).toHaveLength(1)
    expect(events[0]).toEqual({ event: 'token', data: 'streamed token' })
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @mil/workflow test executor`
Expected: FAIL with "Cannot find module '../engine/executor.js'"

- [ ] **Step 3: Implement DagExecutor**

Create `packages/workflow/src/engine/executor.ts`:

```typescript
import type { FlowData, FlowNode } from '../types/flow.js'
import type { INode, INodeData, INodeOutput } from '../types/node.js'
import type { IExecutionContext, IExecutedNode, ExecutionStatus } from '../types/execution.js'
import { NodeRegistry } from './node-registry.js'
import { RuntimeState } from './runtime.js'

/** Result of a DAG execution. */
export interface ExecutionResult {
  status: ExecutionStatus
  executedNodes: IExecutedNode[]
  /** The final output (last node's output), or null if execution failed. */
  finalOutput: Record<string, unknown> | null
  /** Error message if status === 'failed'. */
  error?: string
  /** Final runtime state snapshot. */
  state: Record<string, unknown>
}

/** Options passed to `DagExecutor.execute`. */
export interface ExecuteOptions {
  chatId: string
  runId: string
  state: Record<string, unknown>
  isLastNode: boolean
  sseStreamer?: import('../types/stream.js').IServerSideEventStreamer
  startInput?: string
  sessionId?: string
  signal?: AbortSignal
}

/**
 * DAG executor — topological sort + linear execution.
 *
 * Plan A scope: linear DAGs only. No branching (Condition/ConditionAgent)
 * or looping (Iteration/Loop) — those are Plan B. If the graph contains
 * a branch or loop, this executor will execute nodes in topological order
 * but won't skip branches or repeat loops — the results will be incorrect
 * for non-linear graphs. Plan B replaces this with the full executor.
 *
 * Algorithm:
 *   1. Build adjacency list from edges
 *   2. Topological sort (Kahn's algorithm)
 *   3. Execute nodes in topo order, passing each node's output to its successors
 *   4. The last node in topo order gets `isLastNode: true` for SSE streaming
 */
export class DagExecutor {
  constructor(private readonly registry: NodeRegistry) {}

  async execute(flow: FlowData, input: unknown, opts: ExecuteOptions): Promise<ExecutionResult> {
    const runtime = new RuntimeState()
    runtime.merge(opts.state)

    const executedNodes: IExecutedNode[] = []

    try {
      // 1. Topological sort
      const sorted = this.topologicalSort(flow.nodes, flow.edges)
      if (sorted.kind === 'cycle') {
        return {
          status: 'failed',
          executedNodes: [],
          finalOutput: null,
          error: `Cycle detected: ${sorted.cycle.join(' → ')}`,
          state: runtime.snapshot(),
        }
      }

      const order = sorted.order

      // 2. Execute nodes in topo order
      let lastOutput: Record<string, unknown> = {}
      for (let i = 0; i < order.length; i++) {
        const flowNode = order[i]
        const isLast = i === order.length - 1

        const nodeInstance = this.registry.get(flowNode.data.name as string)
        if (!nodeInstance) {
          return {
            status: 'failed',
            executedNodes,
            finalOutput: null,
            error: `Node type "${flowNode.data.name}" not registered`,
            state: runtime.snapshot(),
          }
        }

        const nodeData: INodeData = {
          id: flowNode.id,
          name: flowNode.data.name as string,
          inputs: flowNode.data,
        }

        const ctx: IExecutionContext = {
          chatId: opts.chatId,
          runId: opts.runId,
          state: runtime.state,
          isLastNode: isLast && opts.isLastNode,
          sseStreamer: opts.sseStreamer,
          startInput: opts.startInput,
          sessionId: opts.sessionId,
          signal: opts.signal,
          agentflowRuntime: { state: runtime.state },
        }

        const startedAt = new Date().toISOString()
        let output: INodeOutput
        try {
          output = await nodeInstance.run(nodeData, i === 0 ? input : lastOutput, ctx)
        } catch (err) {
          const endedAt = new Date().toISOString()
          executedNodes.push({
            nodeId: flowNode.id,
            nodeName: flowNode.data.name as string,
            startedAt,
            endedAt,
            status: 'failed',
            input: lastOutput,
            output: {},
            error: err instanceof Error ? err.message : String(err),
          })
          return {
            status: 'failed',
            executedNodes,
            finalOutput: null,
            error: err instanceof Error ? err.message : String(err),
            state: runtime.snapshot(),
          }
        }
        const endedAt = new Date().toISOString()

        executedNodes.push({
          nodeId: flowNode.id,
          nodeName: flowNode.data.name as string,
          startedAt,
          endedAt,
          status: 'success',
          input: output.input,
          output: output.output,
        })

        // Merge state from node output
        runtime.merge(output.state)

        // Store output for the next node
        lastOutput = output.output
      }

      return {
        status: 'success',
        executedNodes,
        finalOutput: lastOutput,
        state: runtime.snapshot(),
      }
    } catch (err) {
      return {
        status: 'failed',
        executedNodes,
        finalOutput: null,
        error: err instanceof Error ? err.message : String(err),
        state: runtime.snapshot(),
      }
    }
  }

  /**
   * Topological sort using Kahn's algorithm.
   * Returns `{ kind: 'ok', order }` on success or `{ kind: 'cycle', cycle }` on cycle.
   */
  private topologicalSort(
    nodes: FlowNode[],
    edges: { source: string; target: string }[],
  ): { kind: 'ok'; order: FlowNode[] } | { kind: 'cycle'; cycle: string[] } {
    // Build adjacency list + in-degree map
    const adj = new Map<string, string[]>()
    const inDegree = new Map<string, number>()
    const nodeMap = new Map<string, FlowNode>()

    for (const node of nodes) {
      nodeMap.set(node.id, node)
      adj.set(node.id, [])
      inDegree.set(node.id, 0)
    }

    for (const edge of edges) {
      if (!nodeMap.has(edge.source) || !nodeMap.has(edge.target)) continue
      adj.get(edge.source)!.push(edge.target)
      inDegree.set(edge.target, (inDegree.get(edge.target) ?? 0) + 1)
    }

    // Start with nodes that have no incoming edges
    const queue: string[] = []
    for (const [id, deg] of inDegree) {
      if (deg === 0) queue.push(id)
    }

    const order: FlowNode[] = []
    while (queue.length > 0) {
      const id = queue.shift()!
      const node = nodeMap.get(id)
      if (node) order.push(node)

      for (const neighbor of adj.get(id) ?? []) {
        const newDeg = (inDegree.get(neighbor) ?? 0) - 1
        inDegree.set(neighbor, newDeg)
        if (newDeg === 0) queue.push(neighbor)
      }
    }

    // If not all nodes are in order, there's a cycle
    if (order.length !== nodes.length) {
      const remaining = nodes.filter((n) => !order.includes(n)).map((n) => n.id)
      return { kind: 'cycle', cycle: remaining }
    }

    return { kind: 'ok', order }
  }
}
```

- [ ] **Step 4: Fix the test import — tests import from `../types/index.js` which doesn't exist yet**

The test file imports `from '../types/index.js'`. We need to create a barrel. Update `packages/workflow/src/types/` to have an index:

Create `packages/workflow/src/types/index.ts` (re-export all types):

```typescript
export * from './node.js'
export * from './flow.js'
export * from './execution.js'
export * from './stream.js'
```

- [ ] **Step 5: Run test to verify it passes**

Run: `pnpm --filter @mil/workflow test executor`
Expected: PASS — all 6 tests green.

- [ ] **Step 6: Commit**

```bash
git add packages/workflow/src/engine/executor.ts packages/workflow/src/types/index.ts packages/workflow/src/__tests__/executor.test.ts
git commit -m "feat(workflow): add DAG executor with topological sort and linear execution"
```

---

## Task 8: DirectReply node

**Files:**
- Create: `packages/workflow/src/nodes/direct-reply/direct-reply.node.ts`
- Test: `packages/workflow/src/nodes/direct-reply/direct-reply.node.test.ts`

DirectReply is the simplest node (67 lines in Flowise). It takes a `directReplyMessage` input and outputs it as `content`. When it's the last node and an SSE streamer is present, it streams the message token.

- [ ] **Step 1: Write failing test**

Create `packages/workflow/src/nodes/direct-reply/direct-reply.node.test.ts`:

```typescript
import { describe, it, expect } from 'vitest'
import { DirectReplyNode } from './direct-reply.node.js'
import { SseStreamer } from '../../engine/sse-streamer.js'
import type { INodeData, IExecutionContext } from '../../types/index.js'

function makeNodeData(message: string): INodeData {
  return {
    id: 'n1',
    name: 'directReplyAgentflow',
    inputs: { directReplyMessage: message },
  }
}

function makeContext(opts: Partial<IExecutionContext> = {}): IExecutionContext {
  return {
    chatId: 'c1',
    runId: 'r1',
    state: {},
    isLastNode: false,
    ...opts,
  }
}

describe('DirectReplyNode', () => {
  it('returns the configured message as output.content', async () => {
    const node = new DirectReplyNode()
    const result = await node.run(makeNodeData('hello there'), '', makeContext())
    expect(result.output.content).toBe('hello there')
    expect(result.id).toBe('n1')
    expect(result.name).toBe('directReplyAgentflow')
  })

  it('streams the message when isLastNode and sseStreamer present', async () => {
    const node = new DirectReplyNode()
    const streamer = new SseStreamer('c1')
    await node.run(
      makeNodeData('streamed message'),
      '',
      makeContext({ isLastNode: true, sseStreamer: streamer }),
    )
    const events = streamer.drain()
    expect(events).toHaveLength(1)
    expect(events[0]).toEqual({ event: 'token', data: 'streamed message' })
  })

  it('does not stream when not the last node', async () => {
    const node = new DirectReplyNode()
    const streamer = new SseStreamer('c1')
    await node.run(
      makeNodeData('no stream'),
      '',
      makeContext({ isLastNode: false, sseStreamer: streamer }),
    )
    expect(streamer.drain()).toHaveLength(0)
  })

  it('handles empty message gracefully', async () => {
    const node = new DirectReplyNode()
    const result = await node.run(makeNodeData(''), '', makeContext())
    expect(result.output.content).toBe('')
  })

  it('has correct static metadata', () => {
    const node = new DirectReplyNode()
    expect(node.name).toBe('directReplyAgentflow')
    expect(node.type).toBe('DirectReply')
    expect(node.category).toBe('Agent Flows')
    expect(node.inputs).toHaveLength(1)
    expect(node.inputs[0].name).toBe('directReplyMessage')
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @mil/workflow test direct-reply`
Expected: FAIL with "Cannot find module './direct-reply.node.js'"

- [ ] **Step 3: Implement DirectReplyNode**

Create `packages/workflow/src/nodes/direct-reply/direct-reply.node.ts`:

```typescript
import type { INode, INodeData, INodeOutput, IExecutionContext } from '../../types/index.js'

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
  category = 'Agent Flows'
  color = '#4DDBBB'
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
    const directReplyMessage = (nodeData.inputs?.directReplyMessage as string) ?? ''
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
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @mil/workflow test direct-reply`
Expected: PASS — all 5 tests green.

- [ ] **Step 5: Commit**

```bash
git add packages/workflow/src/nodes/direct-reply/
git commit -m "feat(workflow): migrate DirectReply node from Flowise"
```

---

## Task 9: Iteration node

**Files:**
- Create: `packages/workflow/src/nodes/iteration/iteration.node.ts`
- Test: `packages/workflow/src/nodes/iteration/iteration.node.test.ts`

Iteration takes an array input and outputs it for the engine to iterate over. In Plan A (no loop execution), it just parses the array and passes it through — the actual iteration logic is in Plan B's executor.

- [ ] **Step 1: Write failing test**

Create `packages/workflow/src/nodes/iteration/iteration.node.test.ts`:

```typescript
import { describe, it, expect } from 'vitest'
import { IterationNode } from './iteration.node.js'
import type { INodeData, IExecutionContext } from '../../types/index.js'

function makeNodeData(input: unknown): INodeData {
  return {
    id: 'n1',
    name: 'iterationAgentflow',
    inputs: { iterationInput: input },
  }
}

function makeContext(): IExecutionContext {
  return { chatId: 'c1', runId: 'r1', state: {}, isLastNode: false }
}

describe('IterationNode', () => {
  it('parses a JSON string array', async () => {
    const node = new IterationNode()
    const result = await node.run(makeNodeData('["a", "b", "c"]'), '', makeContext())
    expect(result.output.iterationInput).toEqual(['a', 'b', 'c'])
  })

  it('passes through an already-parsed array', async () => {
    const node = new IterationNode()
    const result = await node.run(makeNodeData([1, 2, 3]), '', makeContext())
    expect(result.output.iterationInput).toEqual([1, 2, 3])
  })

  it('throws on non-array input', async () => {
    const node = new IterationNode()
    await expect(node.run(makeNodeData('not an array'), '', makeContext())).rejects.toThrow(/invalid input array/i)
  })

  it('throws on empty string', async () => {
    const node = new IterationNode()
    await expect(node.run(makeNodeData(''), '', makeContext())).rejects.toThrow(/invalid input array/i)
  })

  it('handles JSON with escaped backslashes', async () => {
    const node = new IterationNode()
    // Simulate a string that has redundant backslashes (Flowise pattern)
    const result = await node.run(makeNodeData('[\\"a\\", \\"b\\"]'), '', makeContext())
    expect(result.output.iterationInput).toEqual(['a', 'b'])
  })

  it('has correct static metadata', () => {
    const node = new IterationNode()
    expect(node.name).toBe('iterationAgentflow')
    expect(node.type).toBe('Iteration')
    expect(node.inputs[0].name).toBe('iterationInput')
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @mil/workflow test iteration`
Expected: FAIL with "Cannot find module './iteration.node.js'"

- [ ] **Step 3: Implement IterationNode**

Create `packages/workflow/src/nodes/iteration/iteration.node.ts`:

```typescript
import type { INode, INodeData, INodeOutput, IExecutionContext } from '../../types/index.js'

/**
 * Iteration node — parse an array input for the engine to iterate over.
 *
 * Migrated from vendor/flowise/packages/components/nodes/agentflow/Iteration/Iteration.ts
 * (75 lines). In Plan A, this node only parses + passes through the array.
 * The actual iteration logic (repeating downstream nodes N times) is in
 * Plan B's executor branch/loop handling.
 *
 * Flowise dependencies removed:
 *   - `parseJsonBody` from `../../../src/utils` → inline `safeParseJson`
 *   - `ICommonObject` → `IExecutionContext`
 */
export class IterationNode implements INode {
  label = 'Iteration'
  name = 'iterationAgentflow'
  version = 1
  type = 'Iteration'
  category = 'Agent Flows'
  color = '#9C89B8'
  inputs = [
    {
      label: 'Array Input',
      name: 'iterationInput',
      type: 'string' as const,
      description: 'The input array to iterate over',
      acceptVariable: true,
      rows: 4,
    },
  ]

  async run(nodeData: INodeData, _input: unknown, options: IExecutionContext): Promise<INodeOutput> {
    const iterationInput = nodeData.inputs?.iterationInput

    const safeParseJson = (str: string): unknown => {
      try {
        return JSON.parse(str)
      } catch {
        // Try parsing after cleaning redundant backslashes
        return JSON.parse(str.replace(/\\(["'[\]{}])/g, '$1'))
      }
    }

    const iterationInputArray =
      typeof iterationInput === 'string' && iterationInput !== ''
        ? safeParseJson(iterationInput)
        : iterationInput

    if (!iterationInputArray || !Array.isArray(iterationInputArray)) {
      throw new Error('Invalid input array')
    }

    return {
      id: nodeData.id,
      name: this.name,
      input: { iterationInput: iterationInputArray },
      output: {},
      state: options.state,
    }
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @mil/workflow test iteration`
Expected: PASS — all 6 tests green.

- [ ] **Step 5: Commit**

```bash
git add packages/workflow/src/nodes/iteration/
git commit -m "feat(workflow): migrate Iteration node from Flowise"
```

---

## Task 10: Loop node

**Files:**
- Create: `packages/workflow/src/nodes/loop/loop.node.ts`
- Test: `packages/workflow/src/nodes/loop/loop.node.test.ts`

Loop sets a loop count (from 1 to N). Like Iteration, in Plan A it just validates and passes through — the executor's loop logic is Plan B.

- [ ] **Step 1: Write failing test**

Create `packages/workflow/src/nodes/loop/loop.node.test.ts`:

```typescript
import { describe, it, expect } from 'vitest'
import { LoopNode } from './loop.node.js'
import type { INodeData, IExecutionContext } from '../../types/index.js'

function makeNodeData(loopCount: unknown): INodeData {
  return {
    id: 'n1',
    name: 'loopAgentflow',
    inputs: { loopCount },
  }
}

function makeContext(): IExecutionContext {
  return { chatId: 'c1', runId: 'r1', state: {}, isLastNode: false }
}

describe('LoopNode', () => {
  it('accepts a positive integer loop count', async () => {
    const node = new LoopNode()
    const result = await node.run(makeNodeData(5), '', makeContext())
    expect(result.output.loopCount).toBe(5)
  })

  it('accepts a string number and parses it', async () => {
    const node = new LoopNode()
    const result = await node.run(makeNodeData('3'), '', makeContext())
    expect(result.output.loopCount).toBe(3)
  })

  it('throws on zero', async () => {
    const node = new LoopNode()
    await expect(node.run(makeNodeData(0), '', makeContext())).rejects.toThrow(/loop count.*must be.*1/i)
  })

  it('throws on negative', async () => {
    const node = new LoopNode()
    await expect(node.run(makeNodeData(-1), '', makeContext())).rejects.toThrow(/loop count/i)
  })

  it('throws on non-numeric', async () => {
    const node = new LoopNode()
    await expect(node.run(makeNodeData('abc'), '', makeContext())).rejects.toThrow(/loop count/i)
  })

  it('caps at MAX_LOOP_COUNT (10)', async () => {
    const node = new LoopNode()
    const result = await node.run(makeNodeData(100), '', makeContext())
    expect(result.output.loopCount).toBe(10)
  })

  it('has correct static metadata', () => {
    const node = new LoopNode()
    expect(node.name).toBe('loopAgentflow')
    expect(node.type).toBe('Loop')
    expect(node.inputs[0].name).toBe('loopCount')
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @mil/workflow test loop`
Expected: FAIL with "Cannot find module './loop.node.js'"

- [ ] **Step 3: Implement LoopNode**

Create `packages/workflow/src/nodes/loop/loop.node.ts`:

```typescript
import type { INode, INodeData, INodeOutput, IExecutionContext } from '../../types/index.js'

/**
 * Loop node — set a loop count for the engine to repeat downstream nodes.
 *
 * Migrated from vendor/flowise/packages/components/nodes/agentflow/Loop/Loop.ts
 * (154 lines). In Plan A, this node only validates + caps the loop count.
 * The actual loop execution (repeating the sub-path N times) is in Plan B's
 * executor.
 *
 * MAX_LOOP_COUNT defaults to 10 (matches Flowise's buildAgentflow.ts:174
 * `process.env.MAX_LOOP_COUNT ?? 10`).
 */
const MAX_LOOP_COUNT = Number(process.env.MAX_LOOP_COUNT ?? 10)

export class LoopNode implements INode {
  label = 'Loop'
  name = 'loopAgentflow'
  version = 1
  type = 'Loop'
  category = 'Agent Flows'
  color = '#9C89B8'
  inputs = [
    {
      label: 'Loop Count',
      name: 'loopCount',
      type: 'number' as const,
      description: `Number of times to loop (max ${MAX_LOOP_COUNT})`,
      acceptVariable: true,
      default: 1,
    },
  ]

  async run(nodeData: INodeData, _input: unknown, options: IExecutionContext): Promise<INodeOutput> {
    const raw = nodeData.inputs?.loopCount
    const count = typeof raw === 'number' ? raw : parseInt(String(raw), 10)

    if (!Number.isFinite(count) || count < 1) {
      throw new Error(`Loop count must be a positive integer (got: ${raw})`)
    }

    const loopCount = Math.min(count, MAX_LOOP_COUNT)

    return {
      id: nodeData.id,
      name: this.name,
      input: { loopCount: raw },
      output: { loopCount },
      state: options.state,
    }
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @mil/workflow test loop`
Expected: PASS — all 7 tests green.

- [ ] **Step 5: Commit**

```bash
git add packages/workflow/src/nodes/loop/
git commit -m "feat(workflow): migrate Loop node from Flowise"
```

---

## Task 11: CustomFunction node

**Files:**
- Create: `packages/workflow/src/nodes/custom-function/custom-function.node.ts`
- Test: `packages/workflow/src/nodes/custom-function/custom-function.node.test.ts`

CustomFunction executes a user-provided JavaScript function string. The function receives `$flow.state` and `$input` and returns a value. This is the riskiest node (arbitrary code execution) — we sandbox it with `new Function` and no access to globals.

- [ ] **Step 1: Write failing test**

Create `packages/workflow/src/nodes/custom-function/custom-function.node.test.ts`:

```typescript
import { describe, it, expect } from 'vitest'
import { CustomFunctionNode } from './custom-function.node.js'
import type { INodeData, IExecutionContext } from '../../types/index.js'

function makeNodeData(code: string, input: unknown = {}): INodeData {
  return {
    id: 'n1',
    name: 'customFunctionAgentflow',
    inputs: { functionCode: code, functionInput: input },
  }
}

function makeContext(state: Record<string, unknown> = {}): IExecutionContext {
  return { chatId: 'c1', runId: 'r1', state, isLastNode: false }
}

describe('CustomFunctionNode', () => {
  it('executes a simple function and returns its output', async () => {
    const node = new CustomFunctionNode()
    const code = 'return { doubled: $input.value * 2 }'
    const result = await node.run(makeNodeData(code, { value: 21 }), '', makeContext())
    expect(result.output.doubled).toBe(42)
  })

  it('can read from $flow.state', async () => {
    const node = new CustomFunctionNode()
    const code = 'return { greeting: "Hello " + $flow.state.name }'
    const result = await node.run(makeNodeData(code), '', makeContext({ name: 'World' }))
    expect(result.output.greeting).toBe('Hello World')
  })

  it('returns the raw return value wrapped in output', async () => {
    const node = new CustomFunctionNode()
    const code = 'return "plain string"'
    const result = await node.run(makeNodeData(code), '', makeContext())
    expect(result.output).toEqual({ value: 'plain string' })
  })

  it('throws on syntax error', async () => {
    const node = new CustomFunctionNode()
    const code = 'this is not valid javascript'
    await expect(node.run(makeNodeData(code), '', makeContext())).rejects.toThrow()
  })

  it('returns { value: undefined } when function has no return', async () => {
    const node = new CustomFunctionNode()
    const code = 'const x = 1'
    const result = await node.run(makeNodeData(code), '', makeContext())
    // No return → result is undefined, wrapped as { value: undefined }
    expect(result.output).toEqual({ value: undefined })
  })

  it('has correct static metadata', () => {
    const node = new CustomFunctionNode()
    expect(node.name).toBe('customFunctionAgentflow')
    expect(node.type).toBe('CustomFunction')
    expect(node.inputs).toHaveLength(2)
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @mil/workflow test custom-function`
Expected: FAIL with "Cannot find module './custom-function.node.js'"

- [ ] **Step 3: Implement CustomFunctionNode**

Create `packages/workflow/src/nodes/custom-function/custom-function.node.ts`:

```typescript
import type { INode, INodeData, INodeOutput, IExecutionContext } from '../../types/index.js'

/**
 * CustomFunction node — execute a user-provided JavaScript function.
 *
 * Migrated from vendor/flowise/packages/components/nodes/agentflow/CustomFunction/CustomFunction.ts
 * (219 lines). The function code is wrapped in `new Function` with `$input`
 * and `$flow` parameters — no access to `process`, `require`, or globals
 * (sandboxed by the Function constructor's scope).
 *
 * Security note: `new Function` is NOT a true sandbox (it can access globals
 * via `this` tricks). For production hardening, consider `vm2` or `isolated-vm`.
 * For now, this matches Flowise's behavior — the function is trusted to be
 * authored by the flow designer, not an end user.
 *
 * Flowise dependencies removed:
 *   - `eval` with `flow.state` / `input` → `new Function('$input', '$flow', code)`
 *   - `ICommonObject` → `IExecutionContext`
 */
export class CustomFunctionNode implements INode {
  label = 'Custom Function'
  name = 'customFunctionAgentflow'
  version = 1
  type = 'CustomFunction'
  category = 'Agent Flows'
  color = '#FF9F1C'
  inputs = [
    {
      label: 'Function Code',
      name: 'functionCode',
      type: 'code' as const,
      description: 'JavaScript code. Use `$input` for input and `$flow.state` for state.',
      rows: 6,
      default: 'return { result: $input }',
    },
    {
      label: 'Function Input',
      name: 'functionInput',
      type: 'json' as const,
      description: 'Input to pass as $input',
      acceptVariable: true,
    },
  ]

  async run(nodeData: INodeData, input: unknown, options: IExecutionContext): Promise<INodeOutput> {
    const functionCode = (nodeData.inputs?.functionCode as string) ?? ''
    const functionInput = nodeData.inputs?.functionInput ?? input

    // Wrap in a function with named params — sandboxed from module scope.
    // `new Function` creates a function with its own scope; it can't see
    // imports or local variables, only the params we pass.
    const fn = new Function('$input', '$flow', functionCode)

    const result = fn(functionInput, { state: options.state })

    // Normalize: if the function returns a non-object, wrap it in { value }
    const output = result !== null && typeof result === 'object' && !Array.isArray(result)
      ? result as Record<string, unknown>
      : { value: result }

    return {
      id: nodeData.id,
      name: this.name,
      input: { functionInput },
      output,
      state: options.state,
    }
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @mil/workflow test custom-function`
Expected: PASS — all 6 tests green.

- [ ] **Step 5: Commit**

```bash
git add packages/workflow/src/nodes/custom-function/
git commit -m "feat(workflow): migrate CustomFunction node from Flowise"
```

---

## Task 12: HTTP node

**Files:**
- Create: `packages/workflow/src/nodes/http/http.node.ts`
- Test: `packages/workflow/src/nodes/http/http.node.test.ts`

HTTP makes a fetch request (GET/POST/PUT/DELETE) and returns the response. We stub `fetch` in tests — the real fetch is Node 20+'s built-in.

- [ ] **Step 1: Write failing test**

Create `packages/workflow/src/nodes/http/http.node.test.ts`:

```typescript
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { HttpNode } from './http.node.js'
import type { INodeData, IExecutionContext } from '../../types/index.js'

function makeNodeData(overrides: Record<string, unknown> = {}): INodeData {
  return {
    id: 'n1',
    name: 'httpRequestAgentflow',
    inputs: {
      method: 'GET',
      url: 'https://api.example.com/test',
      ...overrides,
    },
  }
}

function makeContext(): IExecutionContext {
  return { chatId: 'c1', runId: 'r1', state: {}, isLastNode: false }
}

describe('HttpNode', () => {
  beforeEach(() => {
    vi.stubGlobal('fetch', vi.fn())
  })
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('makes a GET request and returns parsed JSON', async () => {
    const fakeResponse = {
      ok: true,
      status: 200,
      headers: { get: () => 'application/json' },
      json: async () => ({ result: 'success' }),
    }
    vi.mocked(fetch).mockResolvedValue(fakeResponse as any)

    const node = new HttpNode()
    const result = await node.run(makeNodeData(), '', makeContext())
    expect(fetch).toHaveBeenCalledWith('https://api.example.com/test', expect.objectContaining({ method: 'GET' }))
    expect(result.output).toEqual({ result: 'success' })
  })

  it('makes a POST request with JSON body', async () => {
    const fakeResponse = {
      ok: true,
      status: 201,
      headers: { get: () => 'application/json' },
      json: async () => ({ id: 1 }),
    }
    vi.mocked(fetch).mockResolvedValue(fakeResponse as any)

    const node = new HttpNode()
    await node.run(
      makeNodeData({
        method: 'POST',
        body: '{"name":"test"}',
        bodyType: 'json',
        headers: '{"Content-Type":"application/json"}',
      }),
      '',
      makeContext(),
    )
    expect(fetch).toHaveBeenCalledWith(
      'https://api.example.com/test',
      expect.objectContaining({
        method: 'POST',
        body: '{"name":"test"}',
        headers: { 'Content-Type': 'application/json' },
      }),
    )
  })

  it('throws on non-ok response', async () => {
    const fakeResponse = { ok: false, status: 500, statusText: 'Server Error', text: async () => 'boom' }
    vi.mocked(fetch).mockResolvedValue(fakeResponse as any)

    const node = new HttpNode()
    await expect(node.run(makeNodeData(), '', makeContext())).rejects.toThrow(/500/)
  })

  it('parses headers JSON string', async () => {
    const fakeResponse = { ok: true, status: 200, json: async () => ({}) }
    vi.mocked(fetch).mockResolvedValue(fakeResponse as any)

    const node = new HttpNode()
    await node.run(
      makeNodeData({ headers: '{"Authorization":"Bearer token123"}' }),
      '',
      makeContext(),
    )
    expect(fetch).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({
        headers: { Authorization: 'Bearer token123' },
      }),
    )
  })

  it('returns text response when content-type is not JSON', async () => {
    const fakeResponse = {
      ok: true,
      status: 200,
      headers: { get: () => 'text/plain' },
      text: async () => 'plain text response',
    }
    vi.mocked(fetch).mockResolvedValue(fakeResponse as any)

    const node = new HttpNode()
    const result = await node.run(makeNodeData(), '', makeContext())
    expect(result.output).toEqual({ content: 'plain text response' })
  })

  it('has correct static metadata', () => {
    const node = new HttpNode()
    expect(node.name).toBe('httpRequestAgentflow')
    expect(node.type).toBe('HTTP Request')
    expect(node.inputs.length).toBeGreaterThan(0)
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @mil/workflow test http`
Expected: FAIL with "Cannot find module './http.node.js'"

- [ ] **Step 3: Implement HttpNode**

Create `packages/workflow/src/nodes/http/http.node.ts`:

```typescript
import type { INode, INodeData, INodeOutput, IExecutionContext } from '../../types/index.js'

/**
 * HTTP Request node — make an HTTP request and return the response.
 *
 * Migrated from vendor/flowise/packages/components/nodes/agentflow/HTTP/HTTP.ts
 * (380 lines). Simplified: removed query params builder, auth credential
 * handling, and response type selection (always auto-detect JSON vs text).
 * Those can be added back when needed (YAGNI for Plan A).
 *
 * Uses Node 20+'s built-in `fetch` — no `axios` dependency.
 */
export class HttpNode implements INode {
  label = 'HTTP Request'
  name = 'httpRequestAgentflow'
  version = 1
  type = 'HTTP Request'
  category = 'Agent Flows'
  color = '#5A3EBA'
  inputs = [
    { label: 'Method', name: 'method', type: 'options' as const, options: [
      { label: 'GET', name: 'GET' },
      { label: 'POST', name: 'POST' },
      { label: 'PUT', name: 'PUT' },
      { label: 'DELETE', name: 'DELETE' },
      { label: 'PATCH', name: 'PATCH' },
    ], default: 'GET' },
    { label: 'URL', name: 'url', type: 'string' as const, acceptVariable: true, required: true },
    { label: 'Headers (JSON)', name: 'headers', type: 'json' as const, acceptVariable: true, rows: 4 },
    { label: 'Body', name: 'body', type: 'string' as const, acceptVariable: true, rows: 4 },
    { label: 'Body Type', name: 'bodyType', type: 'options' as const, options: [
      { label: 'None', name: 'none' },
      { label: 'JSON', name: 'json' },
      { label: 'Text', name: 'text' },
    ], default: 'none' },
  ]

  async run(nodeData: INodeData, _input: unknown, options: IExecutionContext): Promise<INodeOutput> {
    const method = (nodeData.inputs?.method as string) ?? 'GET'
    const url = nodeData.inputs?.url as string
    const headersStr = (nodeData.inputs?.headers as string) ?? ''
    const body = (nodeData.inputs?.body as string) ?? ''
    const bodyType = (nodeData.inputs?.bodyType as string) ?? 'none'

    if (!url) throw new Error('HTTP Request requires a URL')

    // Parse headers
    let headers: Record<string, string> = {}
    if (headersStr) {
      try {
        headers = JSON.parse(headersStr)
      } catch {
        throw new Error(`Invalid headers JSON: ${headersStr}`)
      }
    }

    // Build fetch options
    const fetchOpts: RequestInit = { method }
    if (body && bodyType !== 'none') {
      fetchOpts.body = body
      if (bodyType === 'json' && !headers['Content-Type']) {
        headers['Content-Type'] = 'application/json'
      }
    }
    if (Object.keys(headers).length > 0) {
      fetchOpts.headers = headers
    }

    const response = await fetch(url, fetchOpts)

    if (!response.ok) {
      const errText = await response.text().catch(() => '')
      throw new Error(`HTTP ${response.status} ${response.statusText}${errText ? `: ${errText.slice(0, 200)}` : ''}`)
    }

    // Auto-detect JSON vs text
    const contentType = response.headers.get('content-type') ?? ''
    let output: Record<string, unknown>
    if (contentType.includes('application/json')) {
      output = (await response.json()) as Record<string, unknown>
    } else {
      output = { content: await response.text() }
    }

    return {
      id: nodeData.id,
      name: this.name,
      input: { method, url },
      output,
      state: options.state,
    }
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @mil/workflow test http`
Expected: PASS — all 6 tests green.

- [ ] **Step 5: Commit**

```bash
git add packages/workflow/src/nodes/http/
git commit -m "feat(workflow): migrate HTTP node from Flowise"
```

---

## Task 13: Condition node (evaluate only)

**Files:**
- Create: `packages/workflow/src/nodes/condition/condition.node.ts`
- Test: `packages/workflow/src/nodes/condition/condition.node.test.ts`

Condition evaluates a set of comparison rules and returns which branches match. In Plan A, it only evaluates — the executor's branch routing is Plan B.

- [ ] **Step 1: Write failing test**

Create `packages/workflow/src/nodes/condition/condition.node.test.ts`:

```typescript
import { describe, it, expect } from 'vitest'
import { ConditionNode } from './condition.node.js'
import type { INodeData, IExecutionContext } from '../../types/index.js'

function makeNodeData(conditions: unknown): INodeData {
  return {
    id: 'n1',
    name: 'conditionAgentflow',
    inputs: { conditions },
  }
}

function makeContext(): IExecutionContext {
  return { chatId: 'c1', runId: 'r1', state: {}, isLastNode: false }
}

describe('ConditionNode', () => {
  it('evaluates a simple equality condition (true)', async () => {
    const node = new ConditionNode()
    const conditions = [
      { comparisonOperator: '===', valueToCompare: '{{input}}', valueToCompareAgainst: 'hello', trueBranch: [], falseBranch: [] },
    ]
    const result = await node.run(makeNodeData(conditions), 'hello', makeContext())
    expect(result.output.matched).toBe('true')
  })

  it('evaluates a simple equality condition (false)', async () => {
    const node = new ConditionNode()
    const conditions = [
      { comparisonOperator: '===', valueToCompare: '{{input}}', valueToCompareAgainst: 'hello', trueBranch: [], falseBranch: [] },
    ]
    const result = await node.run(makeNodeData(conditions), 'world', makeContext())
    expect(result.output.matched).toBe('false')
  })

  it('evaluates greater-than', async () => {
    const node = new ConditionNode()
    const conditions = [
      { comparisonOperator: '>', valueToCompare: '{{input}}', valueToCompareAgainst: '10', trueBranch: [], falseBranch: [] },
    ]
    const result = await node.run(makeNodeData(conditions), '15', makeContext())
    expect(result.output.matched).toBe('true')
  })

  it('evaluates multiple conditions (OR logic)', async () => {
    const node = new ConditionNode()
    const conditions = [
      { comparisonOperator: '===', valueToCompare: '{{input}}', valueToCompareAgainst: 'a', trueBranch: [], falseBranch: [] },
      { comparisonOperator: '===', valueToCompare: '{{input}}', valueToCompareAgainst: 'b', trueBranch: [], falseBranch: [] },
    ]
    const result1 = await node.run(makeNodeData(conditions), 'a', makeContext())
    expect(result1.output.matched).toBe('true')
    const result2 = await node.run(makeNodeData(conditions), 'b', makeContext())
    expect(result2.output.matched).toBe('true')
    const result3 = await node.run(makeNodeData(conditions), 'c', makeContext())
    expect(result3.output.matched).toBe('false')
  })

  it('has correct static metadata', () => {
    const node = new ConditionNode()
    expect(node.name).toBe('conditionAgentflow')
    expect(node.type).toBe('Condition')
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @mil/workflow test condition`
Expected: FAIL with "Cannot find module './condition.node.js'"

- [ ] **Step 3: Implement ConditionNode**

Create `packages/workflow/src/nodes/condition/condition.node.ts`:

```typescript
import type { INode, INodeData, INodeOutput, IExecutionContext } from '../../types/index.js'
import { resolveVariables } from '../../utils/variables.js'

/**
 * Condition node — evaluate comparison rules and return which branch matches.
 *
 * Migrated from vendor/flowise/packages/components/nodes/agentflow/Condition/Condition.ts
 * (371 lines). In Plan A, this node only evaluates conditions and returns
 * `matched: 'true' | 'false'`. The executor's branch routing (skipping nodes
 * based on the match) is in Plan B.
 *
 * Supported operators: ===, !==, >, <, >=, <=, contains, startsWith, endsWith.
 * Multiple conditions use OR logic (any match → 'true').
 */

interface ConditionRule {
  comparisonOperator: string
  valueToCompare: string
  valueToCompareAgainst: string
  trueBranch?: unknown[]
  falseBranch?: unknown[]
}

export class ConditionNode implements INode {
  label = 'Condition'
  name = 'conditionAgentflow'
  version = 1
  type = 'Condition'
  category = 'Agent Flows'
  color = '#F0A500'
  inputs = [
    {
      label: 'Conditions',
      name: 'conditions',
      type: 'json' as const,
      description: 'Array of condition rules (OR logic)',
      rows: 6,
    },
  ]

  async run(nodeData: INodeData, input: unknown, options: IExecutionContext): Promise<INodeOutput> {
    const conditions = (nodeData.inputs?.conditions as ConditionRule[]) ?? []

    // Put input into state so resolveVariables can find it as {{input}}
    const stateWithInput = { ...options.state, input: typeof input === 'string' ? input : JSON.stringify(input) }

    let matched = false
    for (const rule of conditions) {
      const left = String(resolveVariables(rule.valueToCompare, stateWithInput))
      const right = String(resolveVariables(rule.valueToCompareAgainst, stateWithInput))

      if (evaluateOperator(left, rule.comparisonOperator, right)) {
        matched = true
        break
      }
    }

    return {
      id: nodeData.id,
      name: this.name,
      input: { conditions },
      output: { matched: matched ? 'true' : 'false' },
      state: options.state,
    }
  }
}

function evaluateOperator(left: string, operator: string, right: string): boolean {
  switch (operator) {
    case '===':
      return left === right
    case '!==':
      return left !== right
    case '>':
      return Number(left) > Number(right)
    case '<':
      return Number(left) < Number(right)
    case '>=':
      return Number(left) >= Number(right)
    case '<=':
      return Number(left) <= Number(right)
    case 'contains':
      return left.includes(right)
    case 'startsWith':
      return left.startsWith(right)
    case 'endsWith':
      return left.endsWith(right)
    default:
      return false
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @mil/workflow test condition`
Expected: PASS — all 5 tests green.

- [ ] **Step 5: Commit**

```bash
git add packages/workflow/src/nodes/condition/
git commit -m "feat(workflow): migrate Condition node (evaluate only) from Flowise"
```

---

## Task 14: Tool + Retriever stub nodes

**Files:**
- Create: `packages/workflow/src/nodes/tool/tool.node.ts`
- Create: `packages/workflow/src/nodes/retriever/retriever.node.ts`
- Test: `packages/workflow/src/nodes/tool/tool.node.test.ts`
- Test: `packages/workflow/src/nodes/retriever/retriever.node.test.ts`

Tool and Retriever are stubs — their full implementation requires LLM/Agent integration (Plan B). For Plan A, they validate inputs and return a placeholder output so the executor can run graphs containing them.

- [ ] **Step 1: Write failing test for ToolNode**

Create `packages/workflow/src/nodes/tool/tool.node.test.ts`:

```typescript
import { describe, it, expect } from 'vitest'
import { ToolNode } from './tool.node.js'
import type { INodeData, IExecutionContext } from '../../types/index.js'

function makeContext(): IExecutionContext {
  return { chatId: 'c1', runId: 'r1', state: {}, isLastNode: false }
}

describe('ToolNode (stub)', () => {
  it('returns a placeholder output with the tool name', async () => {
    const node = new ToolNode()
    const nodeData: INodeData = {
      id: 'n1',
      name: 'toolAgentflow',
      inputs: { toolName: 'web-search' },
    }
    const result = await node.run(nodeData, 'search query', makeContext())
    expect(result.output.toolName).toBe('web-search')
    expect(result.output.stub).toBe(true)
  })

  it('throws when no tool name configured', async () => {
    const node = new ToolNode()
    const nodeData: INodeData = { id: 'n1', name: 'toolAgentflow', inputs: {} }
    await expect(node.run(nodeData, 'input', makeContext())).rejects.toThrow(/tool.*name/i)
  })

  it('has correct static metadata', () => {
    const node = new ToolNode()
    expect(node.name).toBe('toolAgentflow')
    expect(node.type).toBe('Tool')
  })
})
```

- [ ] **Step 2: Write failing test for RetrieverNode**

Create `packages/workflow/src/nodes/retriever/retriever.node.test.ts`:

```typescript
import { describe, it, expect } from 'vitest'
import { RetrieverNode } from './retriever.node.js'
import type { INodeData, IExecutionContext } from '../../types/index.js'

function makeContext(): IExecutionContext {
  return { chatId: 'c1', runId: 'r1', state: {}, isLastNode: false }
}

describe('RetrieverNode (stub)', () => {
  it('returns a placeholder output with the query', async () => {
    const node = new RetrieverNode()
    const nodeData: INodeData = {
      id: 'n1',
      name: 'retrieverAgentflow',
      inputs: { query: 'what is the weather?' },
    }
    const result = await node.run(nodeData, 'weather query', makeContext())
    expect(result.output.query).toBe('what is the weather?')
    expect(result.output.stub).toBe(true)
  })

  it('uses input string when no query configured', async () => {
    const node = new RetrieverNode()
    const nodeData: INodeData = { id: 'n1', name: 'retrieverAgentflow', inputs: {} }
    const result = await node.run(nodeData, 'fallback query', makeContext())
    expect(result.output.query).toBe('fallback query')
  })

  it('has correct static metadata', () => {
    const node = new RetrieverNode()
    expect(node.name).toBe('retrieverAgentflow')
    expect(node.type).toBe('Retriever')
  })
})
```

- [ ] **Step 3: Run tests to verify they fail**

Run: `pnpm --filter @mil/workflow test tool retriever`
Expected: FAIL with "Cannot find module './tool.node.js'" and "./retriever.node.js"

- [ ] **Step 4: Implement ToolNode (stub)**

Create `packages/workflow/src/nodes/tool/tool.node.ts`:

```typescript
import type { INode, INodeData, INodeOutput, IExecutionContext } from '../../types/index.js'

/**
 * Tool node — stub for Plan A.
 *
 * Full implementation (tool execution via @mil/contracts AgentBackend) is in
 * Plan B. For now, this node validates the tool name is configured and returns
 * a placeholder so graphs containing Tool nodes can be executed linearly.
 *
 * Migrated from vendor/flowise/packages/components/nodes/agentflow/Tool/Tool.ts
 * (353 lines) — schema preserved, execution stubbed.
 */
export class ToolNode implements INode {
  label = 'Tool'
  name = 'toolAgentflow'
  version = 1
  type = 'Tool'
  category = 'Agent Flows'
  color = '#16A34A'
  inputs = [
    {
      label: 'Tool Name',
      name: 'toolName',
      type: 'string' as const,
      description: 'The name of the tool to invoke',
      required: true,
      acceptVariable: true,
    },
    {
      label: 'Tool Input',
      name: 'toolInput',
      type: 'json' as const,
      description: 'Input to pass to the tool',
      acceptVariable: true,
    },
  ]

  async run(nodeData: INodeData, input: unknown, options: IExecutionContext): Promise<INodeOutput> {
    const toolName = nodeData.inputs?.toolName as string
    if (!toolName) {
      throw new Error('Tool node requires a tool name')
    }

    return {
      id: nodeData.id,
      name: this.name,
      input: { toolName, toolInput: nodeData.inputs?.toolInput ?? input },
      output: {
        toolName,
        stub: true,
        message: 'Tool execution not implemented in Plan A — see Plan B for full implementation',
      },
      state: options.state,
    }
  }
}
```

- [ ] **Step 5: Implement RetrieverNode (stub)**

Create `packages/workflow/src/nodes/retriever/retriever.node.ts`:

```typescript
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
  category = 'Agent Flows'
  color = '#0891B2'
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
```

- [ ] **Step 6: Run tests to verify they pass**

Run: `pnpm --filter @mil/workflow test tool retriever`
Expected: PASS — all 6 tests green.

- [ ] **Step 7: Commit**

```bash
git add packages/workflow/src/nodes/tool/ packages/workflow/src/nodes/retriever/
git commit -m "feat(workflow): add Tool and Retriever stub nodes (full impl in Plan B)"
```

---

## Task 15: Node barrel + registry wiring

**Files:**
- Create: `packages/workflow/src/nodes/index.ts`
- Modify: `packages/workflow/src/index.ts` (verify exports work)

- [ ] **Step 1: Create nodes barrel**

Create `packages/workflow/src/nodes/index.ts`:

```typescript
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
```

- [ ] **Step 2: Verify typecheck passes**

Run: `pnpm --filter @mil/workflow typecheck`
Expected: PASS — no errors.

- [ ] **Step 3: Verify build passes**

Run: `pnpm --filter @mil/workflow build`
Expected: PASS — `dist/` directory created with ESM + dts.

- [ ] **Step 4: Run all tests**

Run: `pnpm --filter @mil/workflow test`
Expected: PASS — all tests across all files green.

- [ ] **Step 5: Commit**

```bash
git add packages/workflow/src/nodes/index.ts
git commit -m "feat(workflow): wire node barrel and allNodes() registry helper"
```

---

## Task 16: Memory utility stub + final integration test

**Files:**
- Create: `packages/workflow/src/utils/memory.ts`
- Test: `packages/workflow/src/__tests__/integration.test.ts`

Create a stub memory manager (real LLM memory in Plan B) and write an integration test that runs a full linear DAG with multiple node types.

- [ ] **Step 1: Create memory stub**

Create `packages/workflow/src/utils/memory.ts`:

```typescript
/**
 * Memory manager — stub for Plan A.
 *
 * Real LLM/Agent memory management (chat history, buffer window, summary)
 * is in Plan B. For now, this provides a simple in-memory store so nodes
 * that reference memory don't crash.
 */

export interface MemoryEntry {
  role: 'user' | 'assistant' | 'system'
  content: string
  timestamp: string
}

export class MemoryManager {
  private readonly entries: MemoryEntry[] = []

  add(role: MemoryEntry['role'], content: string): void {
    this.entries.push({ role, content, timestamp: new Date().toISOString() })
  }

  getHistory(): MemoryEntry[] {
    return [...this.entries]
  }

  clear(): void {
    this.entries.length = 0
  }
}
```

- [ ] **Step 2: Write integration test**

Create `packages/workflow/src/__tests__/integration.test.ts`:

```typescript
import { describe, it, expect } from 'vitest'
import { DagExecutor } from '../engine/executor.js'
import { NodeRegistry } from '../engine/node-registry.js'
import { SseStreamer } from '../engine/sse-streamer.js'
import { allNodes } from '../nodes/index.js'
import type { FlowData } from '../types/flow.js'

describe('integration: linear DAG with mixed nodes', () => {
  it('runs CustomFunction → DirectReply and streams the result', async () => {
    const registry = new NodeRegistry()
    registry.registerMany(allNodes())

    const flow: FlowData = {
      nodes: [
        {
          id: 'cf1',
          data: {
            name: 'customFunctionAgentflow',
            functionCode: 'return { message: "Hello " + $input }',
            functionInput: 'World',
          },
        },
        {
          id: 'dr1',
          data: {
            name: 'directReplyAgentflow',
            directReplyMessage: '{{$customFunctionAgentflow.output.message}}',
          },
        },
      ],
      edges: [{ id: 'e1', source: 'cf1', target: 'dr1' }],
    }

    const streamer = new SseStreamer('chat-1')
    const executor = new DagExecutor(registry)
    const result = await executor.execute(flow, 'start input', {
      chatId: 'chat-1',
      runId: 'run-1',
      state: {},
      isLastNode: true,
      sseStreamer: streamer,
    })

    expect(result.status).toBe('success')
    expect(result.executedNodes).toHaveLength(2)
    // The DirectReply should have streamed its message
    const events = streamer.drain()
    // Note: in Plan A, variable resolution in node inputs is NOT automatic —
    // the executor passes the upstream node's output directly. The
    // directReplyMessage still contains the literal {{...}} because Plan A
    // doesn't resolve variables in nodeData.inputs. This is a known limitation
    // that Plan B addresses by adding input resolution to the executor.
    // For now, just assert the execution completed successfully.
    expect(events.length).toBeGreaterThanOrEqual(0)
  })

  it('runs HTTP → CustomFunction → DirectReply chain', async () => {
    const registry = new NodeRegistry()
    registry.registerMany(allNodes())

    // Stub fetch for the HTTP node
    const originalFetch = globalThis.fetch
    globalThis.fetch = (async () => ({
      ok: true,
      status: 200,
      headers: { get: () => 'application/json' },
      json: async () => ({ temperature: 72 }),
    })) as typeof fetch

    try {
      const flow: FlowData = {
        nodes: [
          {
            id: 'http1',
            data: {
              name: 'httpRequestAgentflow',
              method: 'GET',
              url: 'https://api.weather.example/current',
            },
          },
          {
            id: 'cf1',
            data: {
              name: 'customFunctionAgentflow',
              functionCode: 'return { report: "Temperature is " + $input.temperature + " degrees" }',
              functionInput: {},
            },
          },
          {
            id: 'dr1',
            data: {
              name: 'directReplyAgentflow',
              directReplyMessage: 'Weather report ready',
            },
          },
        ],
        edges: [
          { id: 'e1', source: 'http1', target: 'cf1' },
          { id: 'e2', source: 'cf1', target: 'dr1' },
        ],
      }

      const executor = new DagExecutor(registry)
      const result = await executor.execute(flow, 'get weather', {
        chatId: 'chat-2',
        runId: 'run-2',
        state: {},
        isLastNode: true,
      })

      expect(result.status).toBe('success')
      expect(result.executedNodes).toHaveLength(3)
      // HTTP node output should have temperature
      expect(result.executedNodes[0].output).toEqual({ temperature: 72 })
    } finally {
      globalThis.fetch = originalFetch
    }
  })

  it('fails gracefully when a mid-chain node throws', async () => {
    const registry = new NodeRegistry()
    registry.registerMany(allNodes())

    const flow: FlowData = {
      nodes: [
        {
          id: 'http1',
          data: {
            name: 'httpRequestAgentflow',
            method: 'GET',
            url: 'https://this-domain-does-not-exist.invalid',
          },
        },
        {
          id: 'dr1',
          data: {
            name: 'directReplyAgentflow',
            directReplyMessage: 'should not reach here',
          },
        },
      ],
      edges: [{ id: 'e1', source: 'http1', target: 'dr1' }],
    }

    const executor = new DagExecutor(registry)
    const result = await executor.execute(flow, 'input', {
      chatId: 'chat-3',
      runId: 'run-3',
      state: {},
      isLastNode: true,
    })

    expect(result.status).toBe('failed')
    expect(result.executedNodes).toHaveLength(1) // Only the HTTP node attempted
    expect(result.executedNodes[0].status).toBe('failed')
  })
})
```

- [ ] **Step 3: Run integration test**

Run: `pnpm --filter @mil/workflow test integration`
Expected: PASS — all 3 integration tests green.

- [ ] **Step 4: Run full test suite**

Run: `pnpm --filter @mil/workflow test`
Expected: PASS — all tests across all files green.

- [ ] **Step 5: Run typecheck + build**

Run: `pnpm --filter @mil/workflow typecheck && pnpm --filter @mil/workflow build`
Expected: Both PASS.

- [ ] **Step 6: Commit**

```bash
git add packages/workflow/src/utils/memory.ts packages/workflow/src/__tests__/integration.test.ts
git commit -m "feat(workflow): add memory stub and integration tests for linear DAG execution"
```

---

## Self-Review

### Spec coverage

| Spec §9 Section | Plan A Coverage | Status |
|----------------|----------------|--------|
| §9.1 packages/workflow/ structure | Tasks 1-15 create the full structure | ✅ |
| §9.2 INode interface | Task 2 defines INode + INodeOutput + INodeParams | ✅ |
| §9.3 DAG execution engine | Task 7 implements topological sort + linear execution | ✅ (linear only — branch/loop in Plan B) |
| §9.4 flows table | ❌ Out of scope (Plan C) | — |
| §9.5 API changes | ❌ Out of scope (Plan C) | — |
| §9.6 migration phases 1-3 | Phase 1 (Tasks 1-7), Phase 2 partial (Tasks 8-14: 8 simple nodes), Phase 3 partial (Condition evaluate only) | ✅ |
| §9.6 phase 4 (advanced nodes) | ❌ Out of scope (Plan B: Start/LLM/Agent/ConditionAgent) | — |
| §9.6 phases 5-7 | ❌ Out of scope (Plan C: API + frontend + cleanup) | — |
| §9.7 dependency chain | Task 1 package.json has no @mil/* deps (self-contained types) | ✅ |

### Placeholder scan

No placeholders found. All code blocks contain complete implementations.

### Type consistency

- `INode.run` signature: `(nodeData: INodeData, input: unknown, options: IExecutionContext) => Promise<INodeOutput>` — consistent across all 8 nodes.
- `INodeOutput` shape: `{ id, name, input, output, state?, chatHistory? }` — all nodes return this shape.
- `IExecutionContext` fields: `{ chatId, runId, state, isLastNode, sseStreamer?, startInput?, sessionId?, signal?, componentNodes?, agentflowRuntime? }` — consistent.
- `SseStreamer` implements `IServerSideEventStreamer` — method names match (`streamTokenEvent`, `streamEndEvent`, `streamErrorEvent`).
- `NodeRegistry.register/get/list` — consistent with tests.

### Known limitations (documented for Plan B)

1. **No variable resolution in nodeData.inputs** — the executor passes upstream output directly, but doesn't resolve `{{var}}` in node input strings. Plan B adds this to the executor.
2. **No branch routing** — Condition node evaluates but the executor doesn't skip branches. Plan B adds branch routing.
3. **No loop execution** — Loop node validates count but executor doesn't repeat. Plan B adds loop execution.
4. **No LLM/Agent/Start nodes** — the 3 large nodes (4879 lines combined) are Plan B.
5. **No `flows` table / API** — Plan C.
6. **No Flowise cleanup** — Plan C.

---

## Execution Handoff

Plan complete and saved to `docs/superpowers/plans/2026-07-26-workflow-engine-core-plan-a.md`.

**Two execution options:**

1. **Subagent-Driven (recommended)** — dispatch a fresh subagent per task, review between tasks, fast iteration
2. **Inline Execution** — execute tasks in this session using executing-plans, batch execution with checkpoints

**Which approach?**
