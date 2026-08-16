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
  label = 'HTTP'
  name = 'httpAgentflow'
  version = 1
  type = 'HTTP'
  category = 'tools'
  color = '#3b82f6'
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
    // headers 兼容两种形态：字符串 JSON（AI 生成的平铺 flow）或对象
    // （画布 defaultData.headers = {}）。空对象 / 空串都视为无自定义头。
    const headersInput = nodeData.inputs?.headers
    const body = nodeData.inputs?.body as string
    const bodyType = nodeData.inputs?.bodyType as string | undefined

    if (!url) throw new Error('HTTP Request requires a URL')

    // SSRF 防线：只允许 http(s) 绝对 URL。fetch 原生拒绝 file: 等协议，
    // 但自定义 scheme + 重定向组合仍是逃逸面，这里显式白名单。
    let parsedUrl: URL
    try {
      parsedUrl = new URL(url)
    } catch {
      throw new Error(`HTTP Request URL is not absolute: ${url}`)
    }
    if (parsedUrl.protocol !== 'http:' && parsedUrl.protocol !== 'https:') {
      throw new Error(`HTTP Request only allows http(s) URLs, got: ${parsedUrl.protocol}`)
    }

    // Parse headers
    let headers: Record<string, string> = {}
    if (typeof headersInput === 'string' && headersInput.trim() !== '') {
      try {
        headers = JSON.parse(headersInput) as Record<string, string>
      } catch {
        throw new Error(`Invalid headers JSON: ${headersInput}`)
      }
    } else if (headersInput && typeof headersInput === 'object' && !Array.isArray(headersInput)) {
      headers = headersInput as Record<string, string>
    }

    // Build fetch options. 画布没有暴露 bodyType 输入 —— body 非空且
    // bodyType 未显式设为 'none' 时照常发送，避免画布上配了 body 却永远发不出去。
    const fetchOpts: RequestInit = { method }
    if (body && bodyType !== 'none') {
      fetchOpts.body = body
      if ((bodyType ?? 'json') === 'json' && !headers['Content-Type']) {
        headers['Content-Type'] = 'application/json'
      }
    }
    if (Object.keys(headers).length > 0) {
      fetchOpts.headers = headers
    }

    // 15s 超时 + 响应 32KB 截断（对齐 gateway 内置 http_request 工具的防护）。
    // 有执行级 signal 时合并（AbortSignal.any 需 Node ≥20.3）。
    const timeoutSignal = AbortSignal.timeout(15_000)
    fetchOpts.signal = options.signal
      ? AbortSignal.any([options.signal, timeoutSignal])
      : timeoutSignal

    const response = await fetch(parsedUrl.toString(), fetchOpts)

    const rawText = await response.text().catch(() => '')
    const MAX_RESPONSE_BYTES = 32 * 1024
    const truncated = rawText.length > MAX_RESPONSE_BYTES
    const text = truncated ? rawText.slice(0, MAX_RESPONSE_BYTES) : rawText

    if (!response.ok) {
      throw new Error(`HTTP ${response.status} ${response.statusText}${text ? `: ${text.slice(0, 200)}` : ''}`)
    }

    // Auto-detect JSON vs text
    const contentType = response.headers.get('content-type') ?? ''
    let output: Record<string, unknown>
    if (contentType.includes('application/json') && !truncated) {
      try {
        output = JSON.parse(text) as Record<string, unknown>
      } catch {
        output = { content: text }
      }
    } else {
      output = truncated ? { content: text, truncated: true } : { content: text }
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
