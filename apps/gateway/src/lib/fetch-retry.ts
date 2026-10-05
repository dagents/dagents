/**
 * fetch-retry —— 瞬时故障的有限重试 + 指数退避（稳定性专项 2026-10-04）。
 *
 * 背景：LLM HTTP 调用此前只有超时（LLM_HTTP_TIMEOUT_MS），429/502/网络抖动
 * 一律直接升级为节点失败 —— 一次上游打嗝烧掉一个长跑 run。本模块把
 * 「可重试的瞬时故障」从「配置错误」里分离出来：
 *  - 可重试：429/500/502/503/504、fetch 网络错误（TypeError fetch failed
 *    及 ECONNRESET/ETIMEDOUT 等 cause）、本模块自带超时的触发。
 *  - 不可重试：其余 4xx（401/404 配置错误——重试无意义）、调用方外部
 *    signal 的 abort（用户取消必须立即生效，绝不借退避拖延）。
 *  - 429 尊重 Retry-After（秒数或 HTTP-Date），与退避取大者。
 *
 * 退避 = base * 2^attempt ± 30% jitter，封顶 max；sleep 期间外部 signal
 * 触发立即中断整条重试链。默认 3 次尝试（LLM_HTTP_RETRY_ATTEMPTS 可调，
 * 设 1 = 关闭重试）。
 */

export const RETRYABLE_STATUS = new Set([429, 500, 502, 503, 504])

export function isRetryableStatus(status: number): boolean {
  return RETRYABLE_STATUS.has(status)
}

/** 网络层瞬时错误：undici fetch 的 TypeError、以及 per-attempt 超时触发的
 *  TimeoutError/AbortError。调用方必须先排除外部 signal abort 再用本谓词。 */
export function isTransientFetchError(err: unknown): boolean {
  if (err instanceof TypeError) return true // fetch failed + cause 链
  if (err instanceof DOMException && (err.name === 'TimeoutError' || err.name === 'AbortError'))
    return true
  const cause = (err as { cause?: { code?: string } } | null)?.cause
  if (cause && typeof cause === 'object' && typeof cause.code === 'string') {
    return /^(ECONNRESET|ETIMEDOUT|ECONNREFUSED|EPIPE|EAI_AGAIN|ENOTFOUND|UND_ERR)/.test(cause.code)
  }
  return false
}

/** Retry-After：整数秒或 HTTP-Date；非法值返回 null（回退到退避）。 */
export function parseRetryAfterMs(header: string | null): number | null {
  if (!header) return null
  const trimmed = header.trim()
  if (/^\d+$/.test(trimmed)) return Number(trimmed) * 1000
  const asDate = Date.parse(trimmed)
  if (Number.isFinite(asDate)) return Math.max(0, asDate - Date.now())
  return null
}

/** 指数退避 + ±30% jitter。attempt 从 1 起（首次重试）。 */
export function backoffDelayMs(attempt: number, baseMs = 800, maxMs = 8_000): number {
  const exp = baseMs * 2 ** Math.min(attempt - 1, 5)
  const capped = Math.min(exp, maxMs)
  const jitter = capped * (0.7 + Math.random() * 0.6)
  return Math.round(Math.min(jitter, maxMs))
}

const numEnv = (name: string, fallback: number): number => {
  const raw = Number(process.env[name])
  return Number.isFinite(raw) && raw > 0 ? raw : fallback
}

export const DEFAULT_RETRY_ATTEMPTS = (): number => numEnv('LLM_HTTP_RETRY_ATTEMPTS', 3)

export interface FetchRetryOptions {
  /** 总尝试次数（含首次）。默认 LLM_HTTP_RETRY_ATTEMPTS（3）；1 = 不重试。 */
  attempts?: number
  baseDelayMs?: number
  maxDelayMs?: number
  /** 单次尝试的墙钟超时；省略则只受外部 signal 约束。 */
  timeoutMs?: number
  /** 调用方取消（用户取消 / 看门狗 controller）——触发即中断，绝不重试。 */
  signal?: AbortSignal
  onRetry?: (info: { attempt: number; delayMs: number; reason: string }) => void
}

/** 退避 sleep：外部 signal 触发立即 reject（取消不等退避）。 */
function abortableSleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(signal.reason instanceof Error ? signal.reason : new Error('aborted'))
      return
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort)
      resolve()
    }, ms)
    const onAbort = () => {
      clearTimeout(timer)
      reject(signal!.reason instanceof Error ? signal!.reason : new Error('aborted'))
    }
    signal?.addEventListener('abort', onAbort, { once: true })
  })
}

/**
 * 带重试的 fetch：瞬时故障退避重试，配置错误与外部取消直通。
 * 返回最后一次的 Response（含仍 5xx 的耗尽态——由调用方决定如何呈现）；
 * 最后一次尝试是网络错误时抛出该错误。
 */
export async function fetchWithRetry(
  url: string,
  init: RequestInit,
  opts: FetchRetryOptions = {},
): Promise<Response> {
  const attempts = Math.max(1, opts.attempts ?? DEFAULT_RETRY_ATTEMPTS())
  let lastErr: unknown

  for (let attempt = 1; attempt <= attempts; attempt++) {
    const signals: AbortSignal[] = []
    if (opts.signal) signals.push(opts.signal)
    if (opts.timeoutMs) signals.push(AbortSignal.timeout(opts.timeoutMs))
    const signal = signals.length > 1 ? AbortSignal.any(signals) : signals[0]

    let res: Response
    try {
      res = await fetch(url, { ...init, signal })
    } catch (err) {
      // 外部取消优先于一切重试语义 —— 用户取消了就取消到底。
      if (opts.signal?.aborted) throw err
      if (!isTransientFetchError(err) || attempt >= attempts) throw err
      lastErr = err
      const delayMs = backoffDelayMs(attempt, opts.baseDelayMs, opts.maxDelayMs)
      opts.onRetry?.({
        attempt,
        delayMs,
        reason: `network: ${err instanceof Error ? err.message : String(err)}`,
      })
      await abortableSleep(delayMs, opts.signal)
      continue
    }

    if (!isRetryableStatus(res.status) || attempt >= attempts) return res

    // 可重试状态：读 Retry-After、丢弃 body，再退避（sleep 期间外部取消
    // 直接以取消语义抛出——上一响应已消费，无须善后）
    const retryAfterMs = parseRetryAfterMs(res.headers.get('retry-after'))
    const delayMs = Math.max(
      backoffDelayMs(attempt, opts.baseDelayMs, opts.maxDelayMs),
      retryAfterMs ?? 0,
    )
    opts.onRetry?.({ attempt, delayMs, reason: `http ${res.status}` })
    await res.body?.cancel().catch(() => {})
    await abortableSleep(delayMs, opts.signal)
  }
  // 循环正常走完必然 return/throw 过；这里只是类型兜底
  throw lastErr instanceof Error ? lastErr : new Error('fetch retry exhausted')
}
