/**
 * metrics 单测（稳定性专项）：注册表渲染格式 + label 转义 + collect gauge。
 */

import { describe, it, expect, beforeEach } from 'vitest'
import { declareCounter, declareGauge, renderMetrics, resetMetricsForTest } from '../lib/metrics.js'

beforeEach(() => {
  resetMetricsForTest()
})

describe('metrics', () => {
  it('counter 无 label 渲染 HELP/TYPE + 值', () => {
    const c = declareCounter('test_counter_total', 'a test counter')
    c.inc()
    c.inc(2)
    const out = renderMetrics()
    expect(out).toContain('# HELP test_counter_total a test counter')
    expect(out).toContain('# TYPE test_counter_total counter')
    expect(out).toContain('test_counter_total 3')
  })

  it('counter 带 label 按组分行', () => {
    const c = declareCounter('test_runs_total', 'runs', ['status'])
    c.inc(1, { status: 'completed' })
    c.inc(1, { status: 'failed' })
    c.inc(1, { status: 'completed' })
    const out = renderMetrics()
    expect(out).toContain('test_runs_total{status="completed"} 2')
    expect(out).toContain('test_runs_total{status="failed"} 1')
  })

  it('label 值转义引号与换行', () => {
    const c = declareCounter('test_esc_total', 'esc', ['name'])
    c.inc(1, { name: 'a"b\nc' })
    expect(renderMetrics()).toContain('test_esc_total{name="a\\"b\\nc"} 1')
  })

  it('gauge collect 在渲染时活值采集', () => {
    let v = 7
    declareGauge('test_live_gauge', 'live', { collect: () => v })
    expect(renderMetrics()).toContain('test_live_gauge 7')
    v = 42
    expect(renderMetrics()).toContain('test_live_gauge 42')
  })

  it('collect 抛错渲染为 0 而非 500', () => {
    declareGauge('test_boom_gauge', 'boom', {
      collect: () => {
        throw new Error('boom')
      },
    })
    expect(renderMetrics()).toContain('test_boom_gauge 0')
  })

  it('重复声明同名指标幂等（值累计共享）', () => {
    declareCounter('test_idem_total', 'idem').inc(1)
    declareCounter('test_idem_total', 'idem').inc(1)
    expect(renderMetrics()).toContain('test_idem_total 2')
  })

  it('进程基础指标始终在场', () => {
    const out = renderMetrics()
    expect(out).toContain('process_uptime_seconds')
    expect(out).toContain('process_resident_memory_bytes')
  })
})
