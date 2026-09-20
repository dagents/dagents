/**
 * api.ts — console 数据获取单源（2026-09-17 评审「无数据获取库」的落地，
 * 不引新依赖：原生 fetch + 统一信封解包即可覆盖全部需求）。
 *
 * 【新代码一律走这里】—— 不再在各 lib 模块自写 unwrap/fetch 样板：
 *   - `apiFetch<T>(path, init?, label?)`：fetch + 信封解包一步到位，
 *     返回信封里的 `data`（T 是 data 的形状）；
 *   - `unwrapEnvelope<T>(res, label)`：只做信封解包（手里已持有 Response
 *     的调用方用，如需要先看 headers/status 的场景）；
 *   - 失败一律抛 `ApiError`（Error 子类，带 HTTP status），消费方可按
 *     `err.status` 分支（如 404 → not-found 卡），消息里保留 `(status)`
 *     字样 —— agent-detail-view 的 notFound 检测正则 `/\(404\)/` 依赖它。
 *
 * 错误文案契约（与原 chats/directories/agents-catalog/skills/fleet-stats
 * 五模块的既有格式逐字一致，测试与 UI 检测钉住）：
 *   - HTTP 非 2xx：`${label} failed (${status}): <body 前 200 字>`
 *   - 信封 success:false / 无 data：`${label} failed: <error | unknown error>`
 *
 * 默认 `cache: 'no-store'`（操作台数据一律新鲜），init 可覆盖。
 *
 * 例外（有意留在各自模块，勿强迁）：audit.ts / llm-providers-client.ts
 * 走 content-type 守卫变体（防代理层返回非 JSON 错误页），chat-stream.ts
 * 是 SSE 流式契约 —— 三者解包语义与标准信封不同。
 */

/** 网关统一响应信封 `{ success, data?, error? }`（CLAUDE.md API 约定）。 */
export interface ApiEnvelope<T> {
  success?: boolean
  data?: T
  error?: string
}

/** API 层错误：携带 HTTP 状态码（0 = 网络异常/非 HTTP 失败）。 */
export class ApiError extends Error {
  readonly status: number

  constructor(message: string, status: number) {
    super(message)
    this.name = 'ApiError'
    this.status = status
  }
}

/**
 * fetch + 信封解包一步到位（多数调用方的形态）：`{ success, data }` →
 * data，失败抛 ApiError（文案契约见模块头注释）。默认 `cache: 'no-store'`，
 * 其余 init（method/headers/body/signal…）原样透传。`label` 进错误文案
 * （如 'chat list'），缺省用 path 自描述。body 解析失败（非 JSON 错误页
 * 等）按信封失败处理，不炸调用方。
 */
export async function apiFetch<T>(path: string, init?: RequestInit, label?: string): Promise<T> {
  const res = await fetch(path, { cache: 'no-store', ...init })
  return unwrapEnvelope<T>(res, label ?? path)
}

/**
 * 信封解包（手里已持有 Response 的调用方用）。
 */
export async function unwrapEnvelope<T>(res: Response, label: string): Promise<T> {
  if (!res.ok) {
    const detail = await res.text().catch(() => '')
    throw new ApiError(
      `${label} failed (${res.status})${detail ? `: ${humanDetail(detail)}` : ''}`,
      res.status,
    )
  }
  const body = (await res.json().catch(() => null)) as ApiEnvelope<T> | null
  if (!body || !body.success || body.data === undefined) {
    throw new ApiError(`${label} failed: ${body?.error ?? 'unknown error'}`, res.status)
  }
  return body.data
}

/**
 * 错误正文的人类可读化（2026-09-19 设计走查五）：此前非 2xx 时把原始 body
 * 整段进消息，用户会看到 `{"success":false,"error":…}` 这样的 JSON 转储。
 * 现在信封是 JSON 就只取 `error` 字段；BFF transformError 把上游原因包在
 * `detail` 字符串里时递归解一层；非 JSON（代理层 HTML 错误页等）保留文本
 * 摘要供诊断。`(status)` 字样契约不变（agent-detail 的 404 检测依赖）。
 */
function humanDetail(text: string, depth = 0): string {
  const trimmed = text.trim().slice(0, 200)
  if (depth < 2 && trimmed.startsWith('{')) {
    try {
      const parsed = JSON.parse(trimmed) as { error?: unknown; detail?: unknown }
      // detail 优先：BFF transformError 把上游根因包在这里（error 此时只是
      // label 的重复）；纯网关信封只有 error，走下面的分支。
      if (parsed && typeof parsed.detail === 'string' && parsed.detail) return humanDetail(parsed.detail, depth + 1)
      if (parsed && typeof parsed.error === 'string' && parsed.error) return parsed.error.slice(0, 200)
    } catch {
      /* 非 JSON → 文本摘要 */
    }
  }
  return trimmed
}

