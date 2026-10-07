import { spawn } from 'node:child_process'
import { existsSync, readFileSync, rmSync } from 'node:fs'
import { createRequire } from 'node:module'
import { join } from 'node:path'
import { clampLine, createDiskSink, createRingLog } from './orchestrator/log-tail'
import { probePort } from './orchestrator/ports'
import { resolveCommand } from './orchestrator/resolve'
import type { PgClient, PgDeps, RunOnceResult, RunOnceSpec } from './orchestrator/pg-service'
import type { SpawnHandle } from './orchestrator/supervisor'
import type { DesktopConfig, ServiceId } from './orchestrator/types'
import { treeKill } from './orchestrator/tree-kill'

// 真实 SupervisorDeps/PgDeps 接线（Electron 主进程侧唯一知道「真世界」的地方）：
// 子进程 spawn（win32 .cmd shim 经 resolveCommand）/ fetch 健康探测 / 端口探测 /
// treeKill / 真定时器 / 日志（环形缓冲 + userData/logs/<svc>.log 落盘 10MB 轮转）；
// pg 通道（M5）：runOnce 一次性子进程（initdb/pg_ctl/migrate）、connectPg 动态加载
// pg 驱动建库、isProcessAlive（stale postmaster.pid 判定）。
// 编排器本身保持纯逻辑（purity.test.ts 守护），本文件不进单测——真链路由 M2/M5
// 验收的「本机拉起/停净」覆盖。

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
  /** pg 驱动解析根（repoRoot/packages/db——建库用，pg-service 传入）。 */
  pgRequireRoot: string
}

export function createRuntimeDeps(config: DesktopConfig, opts: RuntimeDepsOptions): PgDeps {
  const rings: Record<ServiceId, ReturnType<typeof createRingLog>> = {
    gateway: createRingLog(config.logTailLines),
    console: createRingLog(config.logTailLines),
    pg: createRingLog(config.logTailLines),
  }
  const sinks: Record<ServiceId, { append: (line: string) => void }> = {
    gateway: createDiskSink(opts.logDir, 'gateway'),
    console: createDiskSink(opts.logDir, 'console'),
    pg: createDiskSink(opts.logDir, 'pg'),
  }

  const log = (id: ServiceId, line: string) => {
    const clamped = clampLine(line)
    rings[id].push(clamped)
    sinks[id].append(`${new Date().toISOString()} ${clamped}`)
  }

  /** 一次性子进程（initdb/pg_ctl stop/migrate）：收集输出、等退出、超时树终止。 */
  const runOnce = (spec: RunOnceSpec): Promise<RunOnceResult> =>
    new Promise((resolve) => {
      const resolved = resolveCommand(spec.command)
      const child = spawn(resolved.path, spec.args, {
        cwd: spec.cwd,
        shell: resolved.viaShell,
        env: { ...process.env, ...spec.env },
        windowsHide: true,
      })
      let stdout = ''
      let stderr = ''
      let settled = false
      const finish = (code: number | null) => {
        if (settled) return
        settled = true
        resolve({ code, stdout: stdout.slice(0, 64 * 1024), stderr: stderr.slice(0, 64 * 1024) })
      }
      child.stdout?.setEncoding('utf-8')
      child.stdout?.on('data', (c: string) => (stdout += c))
      child.stderr?.setEncoding('utf-8')
      child.stderr?.on('data', (c: string) => (stderr += c))
      child.once('error', (e) => {
        stderr += String(e)
        finish(null)
      })
      child.once('exit', (code) => finish(code))
      if (spec.timeoutMs) {
        const guard = setTimeout(() => {
          if (!settled && child.pid !== undefined) treeKill(child.pid)
          finish(null)
        }, spec.timeoutMs)
        guard.unref?.()
      }
    })

  /** 建库客户端：从 pgRequireRoot 解析 pg（dev=packages/db 直依赖；packaged M6=deploy 树）。 */
  const connectPg = async (maintenanceDsn: string): Promise<PgClient> => {
    const requireFromRoot = createRequire(join(opts.pgRequireRoot, 'package.json'))
    // 坑（win 真机首跑实证）：desktop dist 是 CJS（tsc module:CommonJS），dynamic
    // import(x) 被 TS 降级为 require——而 require 不认 file:// URL。pg 本就是 CJS
    // 包，直接以解析出的绝对路径 require。
    const pgEntry = requireFromRoot.resolve('pg')
    const mod = requireFromRoot(pgEntry) as {
      default?: { Client: new (o: { connectionString: string }) => PgClientRuntime }
      Client: new (o: { connectionString: string }) => PgClientRuntime
    }
    const ClientCtor = mod.default?.Client ?? mod.Client
    const client = new ClientCtor({ connectionString: maintenanceDsn })
    await client.connect()
    return {
      async query(sql: string) {
        const res = await client.query(sql)
        return { rows: (res.rows ?? []) as Record<string, unknown>[] }
      },
      async end() {
        await client.end()
      },
    }
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
    // ---- PgExtraDeps（M5）----
    existsSync,
    readFileUtf8: (p) => {
      try {
        return readFileSync(p, 'utf-8')
      } catch {
        return null
      }
    },
    removeFile: (p) => {
      try {
        rmSync(p, { force: true })
      } catch {
        // 尽力而为（启动路径不因清理失败中断）
      }
    },
    runOnce,
    connectPg,
    isProcessAlive: (pid) => {
      try {
        process.kill(pid, 0)
        return true
      } catch (e) {
        // EPERM = 进程存在但无权限（仍视为活）；ESRCH = 不存在
        return (e as NodeJS.ErrnoException).code === 'EPERM'
      }
    },
  }
}

/** pg 原生 Client 的最小运行时面（@types/pg 不进 desktop 依赖，手写结构面）。 */
interface PgClientRuntime {
  connect(): Promise<void>
  query(sql: string): Promise<{ rows?: Record<string, unknown>[] }>
  end(): Promise<void>
}
