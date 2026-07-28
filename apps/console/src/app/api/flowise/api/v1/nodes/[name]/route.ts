import { NextResponse } from 'next/server'
import { CANVAS_NODES, type CanvasNodeMeta } from '@dagents/workflow'

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

function convertNodeToFlowiseSchema(node: CanvasNodeMeta) {
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
    inputs: node.inputs.map((input) => ({
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
    })),
  }
}

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ name: string }> },
) {
  const { name } = await params
  const nodeMeta = CANVAS_NODES.find((n) => n.name === name)
  if (!nodeMeta) {
    return NextResponse.json({ error: 'Node not found' }, { status: 404 })
  }

  return NextResponse.json(convertNodeToFlowiseSchema(nodeMeta))
}
