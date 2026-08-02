/**
 * Convert @dagents/workflow CanvasNodeMeta into the Flowise Agentflow schema
 * consumed by the vendored canvas editor.
 */

import type { CanvasNodeMeta } from '../nodes/node-registry-canvas.js'
import type { INodeParams } from '../types/node.js'

export interface AgentOption {
  name: string
  label: string
}

function mapNodeTypeToFlowise(type: string): string {
  const map: Record<string, string> = {
    string: 'string',
    number: 'number',
    boolean: 'boolean',
    options: 'options',
    code: 'code',
    json: 'json',
  }
  return map[type] ?? 'string'
}

function convertInput(
  input: INodeParams,
  agentOptions: AgentOption[],
  nodeName: string,
): Record<string, unknown> {
  if (
    nodeName === 'platformAgentAgentflow' &&
    input.name === 'agentId' &&
    agentOptions.length > 0
  ) {
    return {
      id: input.name,
      name: input.name,
      label: input.label,
      type: 'options',
      default: input.default,
      optional: !input.required,
      options: agentOptions,
      placeholder: input.placeholder,
      rows: input.rows,
      description: input.description,
      acceptVariable: input.acceptVariable,
      codeLanguage: input.type === 'code' ? 'javascript' : undefined,
    }
  }

  return {
    id: input.name,
    name: input.name,
    label: input.label,
    type: mapNodeTypeToFlowise(input.type),
    default: input.default,
    optional: !input.required,
    options: input.options,
    placeholder: input.placeholder,
    rows: input.rows,
    description: input.description,
    acceptVariable: input.acceptVariable,
    codeLanguage: input.type === 'code' ? 'javascript' : undefined,
  }
}

export function convertNodeToFlowiseSchema(
  node: CanvasNodeMeta,
  agentOptions: AgentOption[] = [],
): Record<string, unknown> {
  return {
    name: node.name,
    label: node.label,
    type: 'agentflow',
    category: 'Agent Flows',
    description: node.description,
    version: 1,
    baseClasses: ['agentflow'],
    color: node.color,
    icon: node.icon?.toLowerCase(),
    hideInput: false,
    outputs: (node.outputs ?? []).map((o) => ({
      name: o.name,
      label: o.label,
      type: 'string',
    })),
    inputs: node.inputs.map((input) => convertInput(input, agentOptions, node.name)),
  }
}
