/**
 * metrics —— 手写 Prometheus 文本格式指标注册表（稳定性专项 2026-10-04）。
 *
 * 设计约束：
 *  - 零依赖：不引 prom-client，注册表就是一个 Map + 渲染函数；本机产品
 *    的指标面就是「出问题时能 curl /metrics 看一眼」，抓取端缺失不报错。
 *  - 单进程内存态：与 execution-registry 同一红线，重启清零 —— 计数器是
 *    「自进程启动以来」语义，Prometheus rate() 天然容忍重启断点。
 *  - 反向依赖纪律：metrics 不 import 任何业务模块；业务模块单向 import
 *    metrics 并在自己的模块作用域里注册 gauge collector —— 杜绝环。
 *
 * 文本格式（version=0.0.4）：每个指标输出 `# HELP` / `# TYPE` 头 + 每组
 * label 值一行。label 值转义反斜杠/引号/换行。
 */

export type MetricLabels = Record<string, string>

interface MetricBase {
  name: string
  help: string
  labelNames: string[]
}

interface CounterMetric extends MetricBase {
  kind: 'counter'
  values: Map<string, number>
}

interface GaugeMetric extends MetricBase {
  kind: 'gauge'
  values: Map<string, number>
  /** 无 label gauge 的活值采集器 —— 渲染时调用（水位类指标用）。 */
  collect?: () => number
}

const counters = new Map<string, CounterMetric>()
const gauges = new Map<string, GaugeMetric>()

export interface CounterHandle {
  inc(value?: number, labels?: MetricLabels): void
}

export interface GaugeHandle {
  set(value: number, labels?: MetricLabels): void
}

const labelKey = (labelNames: string[], labels?: MetricLabels): string => {
  if (labelNames.length === 0) return ''
  return labelNames.map((n) => `${n}="${escapeLabel(labels?.[n] ?? '')}"`).join(',')
}

const escapeLabel = (v: string): string =>
  v.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n')

const fmtNum = (v: number): string => (Number.isFinite(v) ? String(v) : 'NaN')

export function declareCounter(
  name: string,
  help: string,
  labelNames: string[] = [],
): CounterHandle {
  let metric = counters.get(name)
  if (!metric) {
    metric = { kind: 'counter', name, help, labelNames, values: new Map() }
    counters.set(name, metric)
  }
  return {
    inc(value = 1, labels) {
      const key = labelKey(metric!.labelNames, labels)
      metric!.values.set(key, (metric!.values.get(key) ?? 0) + value)
    },
  }
}

export function declareGauge(
  name: string,
  help: string,
  opts: { labelNames?: string[]; collect?: () => number } = {},
): GaugeHandle {
  let metric = gauges.get(name)
  if (!metric) {
    metric = {
      kind: 'gauge',
      name,
      help,
      labelNames: opts.labelNames ?? [],
      values: new Map(),
      collect: opts.collect,
    }
    gauges.set(name, metric)
  } else if (opts.collect && !metric.collect) {
    metric.collect = opts.collect
  }
  return {
    set(value, labels) {
      metric!.values.set(labelKey(metric!.labelNames, labels), value)
    },
  }
}

/** 渲染全部指标为 Prometheus 文本格式（含进程基础指标）。 */
export function renderMetrics(): string {
  const lines: string[] = []
  const renderMetric = (m: CounterMetric | GaugeMetric): void => {
    lines.push(`# HELP ${m.name} ${m.help}`)
    lines.push(`# TYPE ${m.name} ${m.kind}`)
    if (m.kind === 'gauge' && m.collect && m.labelNames.length === 0) {
      lines.push(`${m.name} ${fmtNum(safeCollect(m))}`)
      return
    }
    for (const [key, value] of m.values) {
      lines.push(`${m.name}${key ? `{${key}}` : ''} ${fmtNum(value)}`)
    }
  }
  for (const m of counters.values()) renderMetric(m)
  for (const m of gauges.values()) renderMetric(m)

  const mem = process.memoryUsage()
  lines.push(`# HELP process_uptime_seconds Process uptime in seconds`)
  lines.push(`# TYPE process_uptime_seconds gauge`)
  lines.push(`process_uptime_seconds ${fmtNum(process.uptime())}`)
  lines.push(`# HELP process_resident_memory_bytes Resident memory size in bytes`)
  lines.push(`# TYPE process_resident_memory_bytes gauge`)
  lines.push(`process_resident_memory_bytes ${fmtNum(mem.rss)}`)
  return lines.join('\n') + '\n'
}

const safeCollect = (m: GaugeMetric): number => {
  try {
    return m.collect?.() ?? 0
  } catch {
    return 0
  }
}

/** 测试隔离：清空全部注册（生产代码禁用）。 */
export function resetMetricsForTest(): void {
  counters.clear()
  gauges.clear()
}
