import type { INodeParams } from '../types/node.js'

/**
 * Canvas node metadata — describes a node for the frontend editor.
 *
 * Used by the node panel, properties panel, and drag-and-drop canvas.
 * Separate from the runtime `INode` interface so the frontend can import
 * metadata without pulling in execution code.
 */
export interface CanvasNodeMeta {
  name: string
  label: string
  category: string
  color: string
  icon: string
  description?: string
  inputs: INodeParams[]
  outputs?: { name: string; label: string }[]
  defaultData: Record<string, unknown>
}

/**
 * Node category definitions — shared between metadata and the UI.
 */
export const NODE_CATEGORIES = {
  start: {
    label: 'Start',
    color: '#10b981',
  },
  agent: {
    label: 'Agent',
    color: '#8b5cf6',
  },
  logic: {
    label: 'Logic',
    color: '#f59e0b',
  },
  tools: {
    label: 'Tools',
    color: '#3b82f6',
  },
  data: {
    label: 'Data',
    color: '#06b6d4',
  },
  flow: {
    label: 'Flow Control',
    color: '#ec4899',
  },
} as const

/**
 * V2 Agent Flow canvas node metadata — 14 nodes for the canvas editor.
 */
export const CANVAS_NODES: CanvasNodeMeta[] = [
  {
    name: 'startAgentflow',
    label: 'Start',
    category: 'start',
    color: '#10b981',
    icon: 'Play',
    description: 'Entry point of an agent flow',
    inputs: [
      {
        label: 'Variables',
        name: 'variables',
        type: 'json',
        description: 'Initial variables for the flow',
        default: {},
        rows: 4,
      },
    ],
    defaultData: {
      variables: {},
    },
  },
  {
    name: 'agentAgentflow',
    label: 'Agent',
    category: 'agent',
    color: '#8b5cf6',
    icon: 'Bot',
    description: 'Autonomous agent with tools and reasoning',
    inputs: [
      {
        label: 'Model',
        name: 'model',
        type: 'options',
        required: true,
        options: [],
      },
      {
        label: 'System Prompt',
        name: 'systemPrompt',
        type: 'code',
        rows: 4,
        acceptVariable: true,
      },
      {
        label: 'Tools',
        name: 'tools',
        type: 'options',
        options: [],
      },
      {
        label: 'Max Iterations',
        name: 'maxIterations',
        type: 'number',
        default: 10,
      },
    ],
    defaultData: {
      model: '',
      systemPrompt: '',
      tools: [],
      maxIterations: 10,
    },
  },
  {
    name: 'platformAgentAgentflow',
    label: 'Platform Agent',
    category: 'agent',
    color: '#8b5cf6',
    icon: 'Bot',
    description: '引用平台上的 Agent，使用其指令和模型配置进行推理',
    inputs: [
      {
        label: 'Agent',
        name: 'agentId',
        type: 'string',
        required: true,
        description: '平台 Agent ID（UUID）',
      },
      {
        label: '任务指令',
        name: 'systemPrompt',
        type: 'code',
        rows: 4,
        acceptVariable: true,
        description: '节点级任务指令，追加在 Agent 自身 instructions 之后',
      },
      {
        label: 'Max Iterations',
        name: 'maxIterations',
        type: 'number',
        default: 10,
      },
    ],
    defaultData: {
      agentId: '',
      systemPrompt: '',
      maxIterations: 10,
    },
  },
  {
    name: 'llmAgentflow',
    label: 'LLM',
    category: 'agent',
    color: '#8b5cf6',
    icon: 'Brain',
    description: 'Large language model call',
    inputs: [
      {
        label: 'Model',
        name: 'model',
        type: 'options',
        required: true,
        options: [],
      },
      {
        label: 'System Prompt',
        name: 'systemPrompt',
        type: 'code',
        rows: 4,
        acceptVariable: true,
      },
      {
        label: 'Prompt',
        name: 'prompt',
        type: 'code',
        rows: 4,
        required: true,
        acceptVariable: true,
      },
      {
        label: 'Temperature',
        name: 'temperature',
        type: 'number',
        default: 0.7,
      },
    ],
    defaultData: {
      model: '',
      systemPrompt: '',
      prompt: '',
      temperature: 0.7,
    },
  },
  {
    name: 'toolAgentflow',
    label: 'Tool',
    category: 'tools',
    color: '#3b82f6',
    icon: 'Wrench',
    description: 'Custom tool definition with handler code',
    inputs: [
      {
        label: 'Tool Name',
        name: 'toolName',
        type: 'string',
        required: true,
      },
      {
        label: 'Tool Description',
        name: 'toolDescription',
        type: 'string',
      },
      {
        label: 'Parameters',
        name: 'parameters',
        type: 'json',
        rows: 4,
      },
      {
        label: 'Handler',
        name: 'handler',
        type: 'code',
        rows: 8,
      },
    ],
    defaultData: {
      toolName: '',
      toolDescription: '',
      parameters: {},
      handler: '',
    },
  },
  {
    name: 'httpAgentflow',
    label: 'HTTP',
    category: 'tools',
    color: '#3b82f6',
    icon: 'Globe',
    description: 'Make an HTTP request',
    inputs: [
      {
        label: 'Method',
        name: 'method',
        type: 'options',
        options: [
          { label: 'GET', name: 'GET' },
          { label: 'POST', name: 'POST' },
          { label: 'PUT', name: 'PUT' },
          { label: 'DELETE', name: 'DELETE' },
        ],
        default: 'GET',
      },
      {
        label: 'URL',
        name: 'url',
        type: 'string',
        required: true,
        acceptVariable: true,
      },
      {
        label: 'Headers',
        name: 'headers',
        type: 'json',
        rows: 4,
        acceptVariable: true,
      },
      {
        label: 'Body',
        name: 'body',
        type: 'json',
        rows: 4,
        acceptVariable: true,
      },
    ],
    outputs: [
      { name: 'data', label: 'Data' },
      { name: 'status', label: 'Status' },
    ],
    defaultData: {
      method: 'GET',
      url: '',
      headers: {},
      body: {},
    },
  },
  {
    name: 'conditionAgentflow',
    label: 'Condition',
    category: 'logic',
    color: '#f59e0b',
    icon: 'GitBranch',
    description: 'Branch based on conditions',
    inputs: [
      {
        label: 'Conditions',
        name: 'conditions',
        type: 'json',
        rows: 6,
        description: 'Array of condition rules (OR logic)',
      },
      {
        label: 'Default Output',
        name: 'defaultOutput',
        type: 'string',
        default: 'false',
      },
    ],
    outputs: [
      { name: 'true', label: 'True' },
      { name: 'false', label: 'False' },
    ],
    defaultData: {
      conditions: [],
      defaultOutput: 'false',
    },
  },
  {
    name: 'conditionAgentAgentflow',
    label: 'Condition Agent',
    category: 'logic',
    color: '#f59e0b',
    icon: 'Split',
    description: 'LLM-based scenario routing',
    inputs: [
      {
        label: 'Model',
        name: 'model',
        type: 'options',
        options: [],
      },
      {
        label: 'System Prompt',
        name: 'systemPrompt',
        type: 'code',
        rows: 4,
        acceptVariable: true,
      },
      {
        label: 'Scenarios',
        name: 'scenarios',
        type: 'json',
        rows: 6,
      },
    ],
    defaultData: {
      model: '',
      systemPrompt: '',
      scenarios: [],
    },
  },
  {
    name: 'iterationAgentflow',
    label: 'Iteration',
    category: 'flow',
    color: '#ec4899',
    icon: 'Repeat',
    description: 'Run the loop body once per item of a JSON array',
    inputs: [
      {
        label: 'Items',
        name: 'items',
        type: 'string',
        acceptVariable: true,
        description: 'JSON array — the body connected to the Iteration anchor runs once per item',
      },
    ],
    outputs: [
      { name: 'iteration', label: 'Iteration Body' },
      { name: 'result', label: 'Result' },
    ],
    defaultData: {
      items: '',
    },
  },
  {
    name: 'loopAgentflow',
    label: 'Loop',
    category: 'flow',
    color: '#ec4899',
    icon: 'RefreshCw',
    description: 'Repeat the loop body N times (or until the break condition holds)',
    inputs: [
      {
        label: 'Max Iterations',
        name: 'maxIterations',
        type: 'number',
        default: 10,
      },
      {
        label: 'Break Condition',
        name: 'condition',
        type: 'string',
        acceptVariable: true,
        description: 'JS expression over $flow.state — truthy breaks before the next iteration',
      },
    ],
    outputs: [
      { name: 'loop', label: 'Loop Body' },
      { name: 'result', label: 'Result' },
    ],
    defaultData: {
      maxIterations: 10,
      condition: '',
    },
  },
  {
    name: 'humanInputAgentflow',
    label: 'Human Input',
    category: 'flow',
    color: '#ec4899',
    icon: 'User',
    description: 'Pause the flow and wait for the user to answer in the chat',
    inputs: [
      {
        label: 'Prompt',
        name: 'prompt',
        type: 'string',
        acceptVariable: true,
      },
      {
        label: 'Input Type',
        name: 'inputType',
        type: 'options',
        options: [
          { label: 'Text', name: 'text' },
          { label: 'Select', name: 'select' },
          { label: 'Confirm', name: 'confirm' },
        ],
        default: 'text',
      },
      {
        label: 'Options',
        name: 'options',
        type: 'json',
        description: 'Choices for inputType=select',
      },
    ],
    outputs: [
      { name: 'response', label: 'Response' },
    ],
    defaultData: {
      prompt: '',
      inputType: 'text',
      options: [],
    },
  },
  {
    name: 'directReplyAgentflow',
    label: 'Direct Reply',
    category: 'agent',
    color: '#8b5cf6',
    icon: 'MessageSquare',
    description: 'Send a direct reply to the user',
    inputs: [
      {
        label: 'Text',
        name: 'text',
        type: 'code',
        rows: 4,
        acceptVariable: true,
      },
    ],
    outputs: [
      { name: 'text', label: 'Text' },
    ],
    defaultData: {
      text: '',
    },
  },
  {
    name: 'customFunctionAgentflow',
    label: 'Custom Function',
    category: 'tools',
    color: '#3b82f6',
    icon: 'Code',
    description: 'Execute custom JavaScript code',
    inputs: [
      {
        label: 'Code',
        name: 'code',
        type: 'code',
        rows: 10,
      },
      {
        label: 'Parameters',
        name: 'parameters',
        type: 'json',
        rows: 4,
      },
    ],
    outputs: [
      { name: 'result', label: 'Result' },
    ],
    defaultData: {
      code: '',
      parameters: {},
    },
  },
  {
    name: 'executeFlowAgentflow',
    label: 'Execute Flow',
    category: 'flow',
    color: '#ec4899',
    icon: 'PlayCircle',
    description: 'Execute a sub-flow',
    inputs: [
      {
        label: 'Flow ID',
        name: 'flowId',
        type: 'string',
      },
      {
        label: 'Input',
        name: 'input',
        type: 'json',
        rows: 4,
      },
    ],
    outputs: [
      { name: 'output', label: 'Output' },
    ],
    defaultData: {
      flowId: '',
      input: {},
    },
  },
  {
    name: 'retrieverAgentflow',
    label: 'Retriever',
    category: 'data',
    color: '#06b6d4',
    icon: 'Search',
    description: 'Retrieve documents from vector store',
    inputs: [
      {
        label: 'Vector Store',
        name: 'vectorStore',
        type: 'string',
      },
      {
        label: 'Query',
        name: 'query',
        type: 'string',
        acceptVariable: true,
      },
      {
        label: 'Top K',
        name: 'topK',
        type: 'number',
        default: 4,
      },
    ],
    outputs: [
      { name: 'docs', label: 'Docs' },
    ],
    defaultData: {
      vectorStore: '',
      query: '',
      topK: 4,
    },
  },
]

/**
 * Look up a canvas node's metadata by its type name.
 *
 * @param name - The node type name (e.g. 'startAgentflow')
 * @returns The node metadata, or undefined if not found
 */
export function getNodeMeta(name: string): CanvasNodeMeta | undefined {
  return CANVAS_NODES.find((node) => node.name === name)
}

/**
 * Group canvas nodes by category.
 *
 * @returns A record mapping category keys to arrays of node metadata
 */
export function getNodesByCategory(): Record<string, CanvasNodeMeta[]> {
  const grouped: Record<string, CanvasNodeMeta[]> = {}
  for (const node of CANVAS_NODES) {
    if (!grouped[node.category]) {
      grouped[node.category] = []
    }
    grouped[node.category].push(node)
  }
  return grouped
}
