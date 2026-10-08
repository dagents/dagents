/**
 * controlled-exec 单测（R4 声明式权限闭环，2026-10-07）：
 * 白名单二次复核 / spawn 闸 / viaShell 拒绝 / 超时强杀 / 输出截断 / 指标。
 *
 * 超时与截断用真 spawn（node -e）——受控通道的本质是进程生命周期管理，
 * mock 不了；均为亚秒级短命进程。resolveCliExecutable 用模块级 mock 驱动
 * viaShell 分支（win32 .cmd shim 语义，见 win-spawn.ts:44-58）。
 */

import { describe, it, expect, beforeEach, vi } from 'vitest'
import { resetCliSpawnGateForTest, cliSpawnGateStats } from '../lib/cli-spawn-gate.js'
import { renderMetrics } from '../lib/metrics.js'

/** 驱动 viaShell 分支的开关（mock 工厂闭包读它——hoisted 后仍可变）。 */
const resolverState = { viaShell: false }
vi.mock('@dagents/agent-adapters', () => ({
  resolveCliExecutable: (name: string) => ({
    path: resolverState.viaShell ? `C:\\npm\\${name}.cmd` : name,
    viaShell: resolverState.viaShell,
  }),
}))
import { runControlledExec } from '../lib/controlled-exec.js'

describe('runControlledExec（受控命令通道）', () => {
  beforeEach(() => {
    // 只重置闸，不 resetMetricsForTest：模块作用域 counter handle 指向注册表
    // 内对象，reset 会把它摘出渲染表（cli-spawn-gate.test.ts 同款取舍）。
    // 计数断言用「存在非零值行」正则，容忍跨用例累计。
    resetCliSpawnGateForTest()
    resolverState.viaShell = false
  })

  it('白名单二次复核：命令 ∉ allowedCommands → denied 且不 spawn', async () => {
    await expect(
      runControlledExec({ command: 'curl', args: [], allowedCommands: ['node'] }),
    ).rejects.toThrow(/curl 未在 allowedCommands 声明（已声明：node）/)
    expect(renderMetrics()).toMatch(/dagents_custom_exec_total\{result="denied"\} [1-9]/)
  })

  it('真执行：node -e 输出回传 + exit code + 指标 allowed', async () => {
    const result = await runControlledExec({
      command: 'node',
      args: ['-e', 'console.log("hello-exec")'],
      allowedCommands: ['node'],
    })
    expect(result.code).toBe(0)
    expect(result.stdout).toContain('hello-exec')
    expect(result.truncated).toBe(false)
    expect(renderMetrics()).toMatch(/dagents_custom_exec_total\{result="allowed"\} [1-9]/)
    expect(cliSpawnGateStats().active).toBe(0) // release 收口
  })

  it('非零退出码如实回传（stderr 不吞）', async () => {
    const result = await runControlledExec({
      command: 'node',
      args: ['-e', 'console.error("boom-err"); process.exit(3)'],
      allowedCommands: ['node'],
    })
    expect(result.code).toBe(3)
    expect(result.stderr).toContain('boom-err')
  })

  it('超时强杀：请求级 timeoutMs 短超时 → SIGTERM 收敛 + timeout 指标', async () => {
    const startedAt = Date.now()
    const result = await runControlledExec({
      command: 'node',
      args: ['-e', 'setInterval(() => {}, 1000)'],
      allowedCommands: ['node'],
      timeoutMs: 300,
    })
    expect(Date.now() - startedAt).toBeLessThan(5_000)
    expect(result.code).not.toBe(0) // 被 SIGTERM 终止
    expect(renderMetrics()).toMatch(/dagents_custom_exec_total\{result="timeout"\} [1-9]/)
  }, 15_000)

  it('AbortSignal 取消 → 子进程被杀（worker settle 级联）', async () => {
    const ac = new AbortController()
    const promise = runControlledExec({
      command: 'node',
      args: ['-e', 'setInterval(() => {}, 1000)'],
      allowedCommands: ['node'],
      timeoutMs: 30_000,
      signal: ac.signal,
    })
    setTimeout(() => ac.abort(new Error('worker settled')), 200)
    const result = await promise
    expect(result.code).not.toBe(0)
  }, 15_000)

  it('输出 32KB 截断：保头 60% + 标记 + 保尾 40%', async () => {
    const result = await runControlledExec({
      command: 'node',
      args: ['-e', 'process.stdout.write("x".repeat(64 * 1024))'],
      allowedCommands: ['node'],
    })
    expect(result.truncated).toBe(true)
    expect(result.stdout).toContain('输出截断')
    expect(result.stdout.length).toBeGreaterThan(32 * 1024 * 0.9)
    expect(result.stdout.length).toBeLessThan(64 * 1024)
  }, 15_000)

  it('spawn 闸：执行期间占用 CLI 槽位、结束即释放', async () => {
    const promise = runControlledExec({
      command: 'node',
      args: ['-e', 'setTimeout(() => console.log("gated"), 400)'],
      allowedCommands: ['node'],
    })
    await new Promise((resolve) => setTimeout(resolve, 200))
    expect(cliSpawnGateStats().active).toBe(1) // 在途占用 DAGENTS_MAX_CLI_PROCESSES 总闸
    await promise
    expect(cliSpawnGateStats().active).toBe(0)
  })

  it('viaShell（win32 .cmd shim）→ 一概拒绝（fail-closed，无注入面）', async () => {
    resolverState.viaShell = true
    await expect(
      runControlledExec({ command: 'claude', args: ['--version'], allowedCommands: ['claude'] }),
    ).rejects.toThrow(/shell shim.*受控通道只接受可直启的可执行文件/)
    expect(renderMetrics()).toMatch(/dagents_custom_exec_total\{result="shell_rejected"\} [1-9]/)
  })

  it('DAGENTS_CUSTOM_EXEC_TIMEOUT_MS 环境默认：非法值回落 15s 语义（不炸）', async () => {
    vi.stubEnv('DAGENTS_CUSTOM_EXEC_TIMEOUT_MS', 'not-a-number')
    const result = await runControlledExec({
      command: 'node',
      args: ['-e', 'console.log("env-ok")'],
      allowedCommands: ['node'],
    })
    expect(result.stdout).toContain('env-ok')
  })
})
