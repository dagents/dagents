/**
 * db-init-retry —— 启动期依赖重试（稳定性专项 2026-10-04）。
 *
 * 背景：gateway 入口 `await initDb()` 一次性调用——docker compose 竞态 /
 * 机器重启顺序里 Postgres 慢半拍，网关就当场退出，只能人工跑
 * restart-gateway.sh。启动期重试与运行期重试语义不同：deadline 有限、
 * 退避封顶、超窗仍失败则如实抛出（带着最后一次错误退出，不静默吞）。
 *
 * 独立成纯函数模块是为了可单测（index.ts 起服即 serve，无法进测试）。
 */

export interface RetryUntilDeadlineOptions {
  /** 总预算（ms）。默认 DB_INIT_RETRY_MS（60s）。 */
  deadlineMs?: number
  baseDelayMs?: number
  maxDelayMs?: number
  onRetry?: (info: { attempt: number; delayMs: number; error: unknown }) => void
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

const numEnv = (name: string, fallback: number): number => {
  const raw = Number(process.env[name])
  return Number.isFinite(raw) && raw > 0 ? raw : fallback
}

export const DB_INIT_RETRY_MS = (): number => numEnv('DB_INIT_RETRY_MS', 60_000)

/**
 * 在预算内重试 fn 直到成功；预算耗尽抛最后一次错误。
 * 至少尝试一次（首次失败也会重试，只要还有预算剩余）。
 */
export async function retryUntilDeadline<T>(
  fn: () => Promise<T>,
  opts: RetryUntilDeadlineOptions = {},
): Promise<T> {
  const deadline = Date.now() + (opts.deadlineMs ?? DB_INIT_RETRY_MS())
  const base = opts.baseDelayMs ?? 1_000
  const max = opts.maxDelayMs ?? 8_000
  let attempt = 0

  for (;;) {
    try {
      return await fn()
    } catch (error) {
      attempt += 1
      const remaining = deadline - Date.now()
      if (remaining <= 0) throw error
      const delayMs = Math.min(Math.min(base * 2 ** Math.min(attempt - 1, 3), max), remaining)
      opts.onRetry?.({ attempt, delayMs, error })
      await sleep(delayMs)
    }
  }
}
