import { createLogger } from '@dagents/shared'

const log = createLogger({ svc: 'gateway:error-sink' })

/**
 * 错误上报出口（2026-09-17 评审搁置项补齐）。
 *
 * 单机本机产品不引入 Sentry 级依赖；但「gateway 未捕获异常无任何聚合
 * 出口、排障只能翻裸日志」不该是终态。出口形态取最朴素的一种：
 * `DAGENTS_ERROR_WEBHOOK` 指向一个 HTTP 端点（Slack/Discord/自建
 * 收集器均可）时，未捕获错误 POST 一条 JSON（含 message/stack/service
 * 时间戳）。未配置 = 显式 no-op（本机模式默认）。
 *
 * 投递语义：fire-and-forget + 单飞（in-flight 期间的新错误合并计数，
 * 不重试不打爆）——错误上报的故障绝不能反噬主进程。
 */

let inFlight = false
let droppedWhileInFlight = 0

export interface ErrorReport {
  service: string
  message: string
  stack?: string
  timestamp: string
  /** 合并计数：上报进行中到达的错误数（同一窗口的同类噪声不重发 N 次）。 */
  droppedWhileInFlight?: number
}

export function reportErrorToSink(err: unknown, service = 'gateway'): void {
  const url = process.env.DAGENTS_ERROR_WEBHOOK
  if (!url) return // 未配置出口 = 显式 no-op
  if (inFlight) {
    droppedWhileInFlight += 1
    return
  }

  const report: ErrorReport = {
    service,
    message: err instanceof Error ? err.message : String(err),
    stack: err instanceof Error ? err.stack : undefined,
    timestamp: new Date().toISOString(),
  }
  inFlight = true
  void fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(report),
    signal: AbortSignal.timeout(5_000),
  })
    .catch((fetchErr) => {
      // 上报失败只留本地日志 —— 出口故障不升级为主进程故障
      log.warn('error webhook delivery failed', { error: String(fetchErr) })
    })
    .finally(() => {
      const dropped = droppedWhileInFlight
      droppedWhileInFlight = 0
      inFlight = false
      if (dropped > 0) {
        // 窗口内被合并的错误数补报一次（不重发正文，只报量）
        reportErrorToSink(
          new Error(`[merged] ${dropped} more errors while a report was in flight`),
          service,
        )
      }
    })
}
