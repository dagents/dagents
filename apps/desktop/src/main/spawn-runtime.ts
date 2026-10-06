import { spawn } from 'node:child_process'
import { clampLine, createDiskSink, createRingLog } from './orchestrator/log-tail'
import { probePort } from './orchestrator/ports'
import { resolveCommand } from './orchestrator/resolve'
import type { SpawnHandle, SupervisorDeps } from './orchestrator/supervisor'
import type { DesktopConfig, ServiceId } from './orchestrator/types'
import { treeKill } from './orchestrator/tree-kill'

// 真实 SupervisorDeps 接线（Electron 主进程侧唯一知道「真世界」的地方）：
// 子进程 spawn（win32 .cmd shim 经 resolveCommand）/ fetch 健康探测 / 端口探测 /
// treeKill / 真定时器 / 日志（环形缓冲 + userData/logs/<svc>.log 落盘 10MB 轮转）。
// 编排器本身保持纯逻辑（purity.test.ts 守护），本文件不进单测——真链路由 M2 验收
// 的「本机 dev 拉起/停净真实 gateway+console」覆盖。

function attachLineSplitter(
  stream: NodeJS.ReadableStream | null,
  cb: (chunk: string) => void
): void {
  if (!stream) return
  let buf = ''
  stream.setEncoding('utf-8')
  stream.on('data', (chunk: string) => {
    buf += chunk
    const lines = buf.split(/\r?\n/)
    buf = lines.pop() ?? ''
    for (const line of lines) cb(line)
  })
}

export interface RuntimeDepsOptions {
  /** userData/logs —— 落盘日志目录。 */
  logDir: string
}

export function createRuntimeDeps(config: DesktopConfig, opts: RuntimeDepsOptions): SupervisorDeps {
  const rings: Record<ServiceId, ReturnType<typeof createRingLog>> = {
    gateway: createRingLog(config.logTailLines),
    console: createRingLog(config.logTailLines),
  }
  const sinks: Record<ServiceId, { append: (line: string) => void }> = {
    gateway: createDiskSink(opts.logDir, 'gateway'),
    console: createDiskSink(opts.logDir, 'console'),
  }

  const log = (id: ServiceId, line: string) => {
    const clamped = clampLine(line)
    rings[id].push(clamped)
    sinks[id].append(`${new Date().toISOString()} ${clamped}`)
  }

  return {
    spawnService(_id, spec) {
      // win32：pnpm 是 .cmd shim → resolveCommand 解析 PATH 并标记 shell:true
      // （蓝本 commit 038e12f；Node 对 .cmd 直启强制 EINVAL）。
      const resolved = resolveCommand(spec.command)
      const child = spawn(resolved.path, spec.args, {
        cwd: spec.cwd,
        shell: resolved.viaShell,
        env: { ...process.env, ...spec.env },
        windowsHide: true,
        // POSIX 建新进程组（detached）便于 kill(-pid) 组终止；win32 用 taskkill /T。
        detached: process.platform !== 'win32',
      })
      const handle: SpawnHandle = {
        pid: child.pid,
        onExit: (cb) => {
          child.once('exit', (code) => cb(code))
        },
        onStdout: (cb) => attachLineSplitter(child.stdout, cb),
        onStderr: (cb) => attachLineSplitter(child.stderr, cb),
      }
      return handle
    },
    async httpGet(url, timeoutMs) {
      try {
        const res = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) })
        return { status: res.status, body: await res.text() }
      } catch (e) {
        return { error: e instanceof Error ? e.message : String(e) }
      }
    },
    isPortOpen: (port) => probePort(port),
    killTree: (pid) => treeKill(pid),
    now: () => Date.now(),
    setTimer: (cb, ms) => setTimeout(cb, ms),
    clearTimer: (h) => clearTimeout(h as NodeJS.Timeout),
    log,
    getLogTail: (id, n) => rings[id].tail(n),
  }
}
