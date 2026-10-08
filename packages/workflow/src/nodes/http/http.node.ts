import type { INode, INodeData, INodeOutput, IExecutionContext } from '../../types/index.js'
import { assertPublicHttpUrl } from './ssrf-guard.js'
import {
  parsePermissionValue,
  assertAllowedHttpDomain,
  PERMISSION_FIELDS,
} from '../../utils/flow-permissions.js'

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
    {
      label: 'Method',
      name: 'method',
      type: 'options' as const,
      options: [
        { label: 'GET', name: 'GET' },
        { label: 'POST', name: 'POST' },
        { label: 'PUT', name: 'PUT' },
        { label: 'DELETE', name: 'DELETE' },
        { label: 'PATCH', name: 'PATCH' },
      ],
      default: 'GET',
    },
    { label: 'URL', name: 'url', type: 'string' as const, acceptVariable: true, required: true },
    {
      label: 'Headers (JSON)',
      name: 'headers',
      type: 'json' as const,
      acceptVariable: true,
      rows: 4,
    },
    { label: 'Body', name: 'body', type: 'string' as const, acceptVariable: true, rows: 4 },
    {
      label: 'Body Type',
      name: 'bodyType',
      type: 'options' as const,
      options: [
        { label: 'None', name: 'none' },
        { label: 'JSON', name: 'json' },
        { label: 'Text', name: 'text' },
      ],
      default: 'none',
    },
    {
      label: '域名清单',
      name: 'allowedDomains',
      type: 'json' as const,
      rows: 3,
      description:
        'JSON 字符串数组（如 ["api.github.com"]）——请求与重定向的每个目标域名必须在列；留空 = 未声明（过渡期放行，网关 enforce 后拒绝）',
    },
  ]

  async run(
    nodeData: INodeData,
    _input: unknown,
    options: IExecutionContext,
  ): Promise<INodeOutput> {
    const method = (nodeData.inputs?.method as string) ?? 'GET'
    const url = nodeData.inputs?.url as string
    // headers 兼容两种形态：字符串 JSON（AI 生成的平铺 flow）或对象
    // （画布 defaultData.headers = {}）。空对象 / 空串都视为无自定义头。
    const headersInput = nodeData.inputs?.headers
    const body = nodeData.inputs?.body as string
    const bodyType = nodeData.inputs?.bodyType as string | undefined

    if (!url) throw new Error('HTTP Request requires a URL')

    // 域名清单声明（R4）：executor 已把双形态 merge 进 nodeData.inputs，
    // 这里直接读 merged 值——与 flow-permissions.readNodePermission 同一
    // 阶梯（absent / declared / invalid）。
    const domainPerm = parsePermissionValue(
      nodeData.inputs?.[PERMISSION_FIELDS.domain],
      PERMISSION_FIELDS.domain,
    )
    /** 域名守卫（协议 → SSRF → 域名，首跳与每跳重定向同款）。 */
    const guardDomain = (target: URL): void =>
      assertAllowedHttpDomain(target, domainPerm, `HTTP 节点 ${nodeData.id}`, {
        onWarn: (message) =>
          options.onNodeDelta?.({ type: 'activity', kind: 'log', label: message }),
      })

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

    // SSRF 防线二：私网/环回/链路本地目标阻断（含云元数据段）。
    // 逃生门 DAGENTS_HTTP_ALLOW_PRIVATE=1，见 ssrf-guard.ts。
    assertPublicHttpUrl(parsedUrl)

    // R4 域名守卫（协议 → SSRF → 域名 → fetch；declared-but-violated 是
    // 静态配置错误，须在 fetch 前抛、零网络副作用）。
    guardDomain(parsedUrl)

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

    // 试运行跳过（R10，design-sharp §3.4-③）：定序 = 协议白名单 → SSRF →
    // R4 域名守卫 → **本分支** → fetch——skip 路径同样先过全部静态校验再
    // 短路：试运行是验证场，declared-but-violated 的静态配置错误（URL 协议
    // 非法/私网目标/域名未声明/headers 非法 JSON）必须在试运行中原样暴露
    // （守卫在 fetch 前抛、零网络副作用），skip 只对通过静态校验的请求生效；
    // 被守卫拒绝的错误照常走节点失败呈现，不被 skip 吞掉。
    if (options.trialMode?.http === 'skip') {
      const output = {
        content: `[试运行] 未执行真实请求（url=${parsedUrl.toString()}）——勾选「真实发送请求」后重试`,
        trialSkipped: true,
      }
      return {
        id: nodeData.id,
        name: this.name,
        input: { method, url },
        output,
        state: options.state,
      }
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

    // 手动跟随重定向：每一跳都重新过 SSRF 校验，防止公网 URL 302 跳内网。
    // 303 一律转 GET（语义约定）；307/308 保留原 method/body。
    fetchOpts.redirect = 'manual'
    let response = await fetch(parsedUrl.toString(), fetchOpts)
    let hops = 0
    while ([301, 302, 303, 307, 308].includes(response.status) && hops < 5) {
      const location = response.headers.get('location')
      if (!location) break
      let nextUrl: URL
      try {
        nextUrl = new URL(location, response.url || parsedUrl.toString())
      } catch {
        throw new Error(`HTTP Request redirect target is not absolute: ${location}`)
      }
      if (nextUrl.protocol !== 'http:' && nextUrl.protocol !== 'https:') {
        throw new Error(`HTTP Request redirect only allows http(s), got: ${nextUrl.protocol}`)
      }
      assertPublicHttpUrl(nextUrl)
      // R4：重定向逐跳复检同清单（302 公网跳「已声明域名的兄弟站」也被拒）
      guardDomain(nextUrl)
      if (response.status === 303 && method !== 'GET' && method !== 'HEAD') {
        fetchOpts.method = 'GET'
        delete fetchOpts.body
      }
      response = await fetch(nextUrl.toString(), fetchOpts)
      hops += 1
    }

    const rawText = await response.text().catch(() => '')
    const MAX_RESPONSE_BYTES = 32 * 1024
    const truncated = rawText.length > MAX_RESPONSE_BYTES
    // 保尾截断（2026-10-04 P1a）：JSON 错误/构建输出的判决常在末尾，
    // 纯保头会切掉——保头 60% + 对账标记 + 保尾 40%（openworker 洞察）。
    const text = truncated
      ? rawText.slice(0, Math.floor(MAX_RESPONSE_BYTES * 0.6)) +
        `\n[响应截断：全文 ${rawText.length} 字符，上限 ${MAX_RESPONSE_BYTES}——中间省略]\n` +
        rawText.slice(rawText.length - Math.floor(MAX_RESPONSE_BYTES * 0.4))
      : rawText

    if (!response.ok) {
      throw new Error(
        `HTTP ${response.status} ${response.statusText}${text ? `: ${text.slice(0, 200)}` : ''}`,
      )
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
