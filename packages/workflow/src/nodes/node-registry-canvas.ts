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
  flow: {
    label: 'Flow Control',
    color: '#ec4899',
  },
} as const

/**
 * Canvas node metadata — 10 nodes, CLI-agent-centric (D8 精简 2026-09-05；
 * 2026-10-04 复活 executeFlow 子流程节点——引擎侧 DB-free，宿主注入执行器).
 *
 * platformAgent is the hero node (a real CLI agent from the agents table);
 * everything else is minimal orchestration scaffolding. Removed types:
 * agent / tool / conditionAgent / loop / executeFlow / retriever — see
 * docs/canvas-replacement-architecture.md §D8.
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
    name: 'platformAgentAgentflow',
    label: 'Agent (CLI)',
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
      {
        label: '失败隔离',
        name: 'isolateFailure',
        type: 'boolean',
        default: false,
        description:
          '开启后本节点失败只剪枝其下游分支，run 以 partial_success 收尾——不拖垮其他分支',
      },
      {
        label: '指定为最终输出',
        name: 'finalOutput',
        type: 'boolean',
        default: false,
        description: '开启后本节点输出压过「拓扑最深节点」默认，成为 run 的最终输出',
      },
    ],
    defaultData: {
      agentId: '',
      systemPrompt: '',
      maxIterations: 10,
      isolateFailure: false,
      finalOutput: false,
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
      {
        label: 'Output Schema (JSON)',
        name: 'outputSchema',
        type: 'json',
        rows: 6,
        default: '',
        description:
          '可选 JSON Schema：要求只输出符合结构的 JSON（输出带 json 字段；做一轮格式修复重试；禁用流式）',
      },
      {
        label: '注入会话历史',
        name: 'includeChatHistory',
        type: 'number',
        default: 0,
        description: '注入最近 N 条会话消息 + 滚动会话摘要（0=不注入；chat 触发的运行生效）',
      },
      {
        label: '上下文预算（字符）',
        name: 'contextCap',
        type: 'number',
        default: 0,
        description:
          '本节点上下文总预算（字符，0=默认 131072）——常驻不裁，超限依次丢历史、截上游输入（对账进 span）',
      },
      {
        label: '失败隔离',
        name: 'isolateFailure',
        type: 'boolean',
        default: false,
        description:
          '开启后本节点失败只剪枝其下游分支，run 以 partial_success 收尾——不拖垮其他分支',
      },
      {
        label: '指定为最终输出',
        name: 'finalOutput',
        type: 'boolean',
        default: false,
        description: '开启后本节点输出压过「拓扑最深节点」默认，成为 run 的最终输出',
      },
    ],
    defaultData: {
      model: '',
      systemPrompt: '',
      prompt: '',
      temperature: 0.7,
      outputSchema: '',
      includeChatHistory: 0,
      isolateFailure: false,
      finalOutput: false,
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
      {
        label: 'Concurrency',
        name: 'concurrency',
        type: 'number',
        default: 1,
        description: '逐项并行度（默认 1 = 串行；2-8 各项独立并行，体内嵌套迭代自动回退串行）',
      },
      {
        label: 'While Condition',
        name: 'whileCondition',
        type: 'code',
        rows: 2,
        default: '',
        description:
          '可选 JS 表达式（如 $input.approved === true）——每项完成后求值，真值即停止剩余项（「循环直到 X」，仍受上限保护）',
      },
    ],
    outputs: [
      { name: 'iteration', label: 'Iteration Body' },
      { name: 'result', label: 'Result' },
    ],
    defaultData: {
      items: '',
      concurrency: 1,
      whileCondition: '',
    },
  },
  {
    name: 'executeFlowAgentflow',
    label: 'Subflow',
    category: 'flow',
    color: '#ec4899',
    icon: 'GitBranch',
    description: 'Run another flow as a subflow — shares this run’s agents and tools',
    inputs: [
      {
        label: 'Flow ID',
        name: 'targetFlowId',
        type: 'string',
        acceptVariable: true,
        required: true,
        description: '目标流程 id（打开目标画布，URL /workflows/<id>/canvas 中的 id）',
      },
      {
        label: 'Input',
        name: 'input',
        type: 'code',
        rows: 3,
        default: '',
        description: '传给子流程的输入（支持模板变量）；留空透传上游输出',
      },
    ],
    outputs: [{ name: 'output', label: 'Subflow Output' }],
    defaultData: {
      targetFlowId: '',
      input: '',
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
    outputs: [{ name: 'response', label: 'Response' }],
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
    outputs: [{ name: 'text', label: 'Text' }],
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
    outputs: [{ name: 'result', label: 'Result' }],
    defaultData: {
      code: '',
      parameters: {},
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
