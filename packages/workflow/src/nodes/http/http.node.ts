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
