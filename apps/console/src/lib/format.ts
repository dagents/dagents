/**
 * Shared formatting utilities — single source for time / token / byte / id
 * formatting across the console. Before this module each view carried its own
 * copy (three timeAgo ladders, two formatTokens casings, raw UTC slice bugs);
 * new code must import from here instead of redefining local helpers.
 *
 * All time helpers parse ISO strings and render in the *user's local
 * timezone* — never slice raw ISO strings (that shows UTC and drifts by the
 * UTC offset).
 */

type TFn = (key: string, params?: Record<string, string | number>) => string

/** Local HH:MM for message meta lines. */
export function formatClock(dateStr: string): string {
  return new Date(dateStr).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
}

/** Local HH:MM:SS for log lines. */
export function formatClockSeconds(dateStr: string): string {
  return new Date(dateStr).toLocaleTimeString([], {
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  })
}

/** Local date + HH:MM for run/log tables (date omitted same-day is NOT
 * desired here — run history spans days, keep the date). */
export function formatDateTime(dateStr: string): string {
  const d = new Date(dateStr)
  if (Number.isNaN(d.getTime())) return dateStr
  // hourCycle h23（PRD FR-10）：空 locale 数组会回落浏览器默认，实测解析成
  // 12 小时制 —— 中文界面出现「09:04 PM」。统一 24 小时制。
  return `${d.toLocaleDateString([], { month: '2-digit', day: '2-digit' })} ${d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hourCycle: 'h23' })}`
}

/** Absolute ISO + local string for hover titles on relative times. */
export function timeTitle(iso: string): string {
  return `${new Date(iso).toLocaleString()}`
}

/**
 * Unified relative-time ladder: 刚刚 → n 分钟前 → n 小时前 → n 天前 (≤7d) →
 * absolute MM-DD HH:MM. Older-than-a-week falls back to an absolute stamp
 * because "30 天前" carries no actionable information.
 */
export function timeAgo(dateStr: string | null, t: TFn): string {
  if (!dateStr) return '—'
  const d = new Date(dateStr)
  if (Number.isNaN(d.getTime())) return '—'
  const diff = Date.now() - d.getTime()
  if (diff < 60_000) return t('刚刚')
  if (diff < 3_600_000) return t('{n} 分钟前', { n: Math.floor(diff / 60_000) })
  if (diff < 86_400_000) return t('{n} 小时前', { n: Math.floor(diff / 3_600_000) })
  if (diff < 7 * 86_400_000) return t('{n} 天前', { n: Math.floor(diff / 86_400_000) })
  return d.toLocaleString([], {
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  })
}

/** Compact relative time for space-constrained rows (sidebar chat list). */
export function formatRelativeCompact(dateStr: string, t: TFn): string {
  const then = new Date(dateStr).getTime()
  const diff = Math.max(0, Date.now() - then)
  const MIN = 60_000
  const HOUR = 3_600_000
  const DAY = 86_400_000
  if (diff < MIN) return t('刚刚')
  if (diff < HOUR) return t('{n}分', { n: Math.floor(diff / MIN) })
  if (diff < DAY) return t('{n}时', { n: Math.floor(diff / HOUR) })
  if (diff < 30 * DAY) return t('{n}天', { n: Math.floor(diff / DAY) })
  if (diff < 365 * DAY) return t('{n}月', { n: Math.floor(diff / (30 * DAY)) })
  return t('{n}年', { n: Math.floor(diff / (365 * DAY)) })
}

/** Token counts with a single canonical casing (`1.2K`). */
export function formatTokens(n: number): string {
  if (n >= 1000) return `${(n / 1000).toFixed(1)}K`
  return String(n)
}

/** Token counts with the unit suffix for usage footers (`1.2k tokens`). */
export function formatTokensLabel(n: number): string {
  if (n >= 1000) return `${(n / 1000).toFixed(1)}k tokens`
  return `${n} tokens`
}

/** Durations: sub-second in ms, seconds to 1m, then minutes with one decimal. */
export function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`
  return `${(ms / 60_000).toFixed(1)}m`
}

/** Byte sizes with KB/MB tiers. */
export function formatBytes(n: number): string {
  if (n >= 1024 * 1024) return `${(n / (1024 * 1024)).toFixed(1)} MB`
  if (n >= 1024) return `${Math.round(n / 1024)} KB`
  return `${n} B`
}

/** Middle-truncate long ids so head and tail stay identifiable. */
export function truncateMiddle(id: string, head = 8, tail = 4): string {
  if (id.length <= head + tail + 1) return id
  return `${id.slice(0, head)}…${id.slice(-tail)}`
}

/** Clamp a chat/run title to a single display width. */
export function truncateTitle(raw: string | null | undefined, max: number): string {
  const s = (raw ?? '').trim()
  if (!s) return ''
  return s.length <= max ? s : `${s.slice(0, max)}…`
}
