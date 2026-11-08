/**
 * controlled-exec —— R4 customFunction 受控命令执行通道的宿主侧
 * （docs/zcode-borrow/design-permission.md §3.2.3）。
 *
 * 架构：用户代码（worker 内）→ 引擎白名单裁决（user-code-exec.ts 父侧，
 * 白名单来自节点 data 非 worker 消息）→ 本模块受控 spawn。用户代码永不
 * 直连 child_process。
 *
 * 五层缓解（requirements.md R4 风险「新增攻击面」的逐项落实）：
 *   1. no-shell spawn（shell:false）——无注入面，argv 原样透传；
 *   2. 白名单二次复核（引擎已裁，gateway 再裁——防引擎侧回归）；
 *   3. CLI spawn 闸（acquireCliSlot，DAGENTS_MAX_CLI_PROCESSES 总量护栏）；
 *   4. 超时强杀（SIGTERM → 1s 宽限 → SIGKILL / win32 taskkill 树终止）
 *      + AbortSignal 级联（worker settle → 子进程同死）；
 *   5. viaShell（win32 npm .cmd/.bat shim）一概拒绝——shell spawn + 用户
 *      可控 args 是命令注入面（cmd.exe 引号语义不可靠），fail-closed 宁拒不裸奔。
 */

import { spawn, type ChildProcess } from 'node:child_process'
import { resolveCliExecutable } from '@dagents/agent-adapters'
import type { ControlledExecRequest, ControlledExecResult } from '@dagents/workflow'
import { createLogger } from '@dagents/shared'
import { acquireCliSlot } from './cli-spawn-gate.js'
import { customExecTotal } from './metrics.js'

const log = createLogger({ svc: 'gateway:controlled-exec' })

/**
 * win32 进程树终止 —— 镜像 agent-adapters win-spawn.ts 的 treeKill 语义
 * （taskkill /T /F；POSIX 无操作——kill 信号天然送进程组外进程本身）。
 * 该函数未从 @dagents/agent-adapters barrel 导出（exports 只有 "."），本方向
 * 无权动那个 barrel——此处按同款语义本地实现（fire-and-forget，永不抛）。
 */
function taskkillTree(pid: number): void {
  if (process.platform !== 'win32') return
  try {
    const tk = spawn('taskkill', ['/pid', String(pid), '/T', '/F'], {
      stdio: 'ignore',
      windowsHide: true,
    })
    tk.on('error', () => {})
    tk.on('exit', () => {})
  } catch {
    // never throw from a kill path
  }
}

/** 单次受控执行超时上限（硬顶；请求体携带更高值会被钳到此处）。 */
export const MAX_CONTROLLED_EXEC_TIMEOUT_MS = 60_000

/** 超时缺省（DAGENTS_CUSTOM_EXEC_TIMEOUT_MS 可调；上限 60s、禁 0）。 */
export function controlledExecDefaultTimeoutMs(): number {
  const raw = Number(process.env.DAGENTS_CUSTOM_EXEC_TIMEOUT_MS)
  if (!Number.isFinite(raw) || raw <= 0) return 15_000
  return Math.min(Math.trunc(raw), MAX_CONTROLLED_EXEC_TIMEOUT_MS)
}

/** stdout/stderr 各自的截断上限（与 http 节点响应截断同款哲学）。 */
const MAX_OUTPUT_BYTES = 32 * 1024

/** 保头 60% + 对账标记 + 保尾 40%（判决常在末尾，纯保头会切掉）。 */
function truncateOutput(text: string): { text: string; truncated: boolean } {
  if (text.length <= MAX_OUTPUT_BYTES) return { text, truncated: false }
  return {
    text:
      text.slice(0, Math.floor(MAX_OUTPUT_BYTES * 0.6)) +
      `\n[输出截断：全文 ${text.length} 字符，上限 ${MAX_OUTPUT_BYTES}——中间省略]\n` +
      text.slice(text.length - Math.floor(MAX_OUTPUT_BYTES * 0.4)),
    truncated: true,
  }
}

/** 钳制请求超时：缺省 env 默认，上限硬顶，下限 1ms。 */
function clampTimeoutMs(raw: number | undefined): number {
  const base =
    raw != null && Number.isFinite(raw) && raw > 0 ? raw : controlledExecDefaultTimeoutMs()
  return Math.min(Math.max(1, Math.trunc(base)), MAX_CONTROLLED_EXEC_TIMEOUT_MS)
}

export interface RunControlledExecOptions {
  /** run 级项目目录（与 CLI 节点同源 runCwd；缺省网关进程 cwd）。 */
  cwd?: string
}

/**
 * 受控执行一次白名单命令。拒绝路径（白名单复核失败 / viaShell shim）抛
 * 结构化 Error（错误文案回流 worker → 用户代码 catch / 节点失败 span）。
 */
export async function runControlledExec(
  req: ControlledExecRequest,
  opts: RunControlledExecOptions = {},
): Promise<ControlledExecResult> {
  // ① 白名单二次复核（纵深防御：引擎侧已裁过，这里再裁一遍）
  if (!Array.isArray(req.allowedCommands) || !req.allowedCommands.includes(req.command)) {
    customExecTotal.inc(1, { result: 'denied' })
    // 「节点被拒绝：」首词（R9d 对照表「节点拒绝」档，集成裁决 2026-10-08）：
    // 文案回流 worker → 用户代码不 catch 时 custom-function 节点按该首词
    // 恢复 NodeRejectedError → span 'rejected'，与引擎侧拒绝同档。
    throw new Error(
      `节点被拒绝：命令 ${req.command} 未在 allowedCommands 声明（已声明：${(req.allowedCommands ?? []).join(', ')}）` +
        `——在节点配置「命令白名单」补充后重试`,
    )
  }

  // ② 目标解析（三平台单源：win32 PATH 探测 .exe 优先 / POSIX 恒等）
  const resolved = resolveCliExecutable(req.command)

  // ③ viaShell（.cmd/.bat npm shim）拒绝：shell spawn + 用户可控 args =
  // 命令注入面。有意平台不对称：Windows 请安装原生二进制（.exe）或改用 POSIX。
  if (resolved.viaShell) {
    customExecTotal.inc(1, { result: 'shell_rejected' })
    throw new Error(
      `命令 ${req.command} 解析到 shell shim（${resolved.path}）——受控通道只接受可直启的可执行文件；` +
        `Windows 请安装原生二进制（.exe）或改用 POSIX 环境`,
    )
  }

  const timeoutMs = clampTimeoutMs(req.timeoutMs)
  // args 白名单形状：argv 只接受字符串（worker 侧已验，宿主侧再验——闭集）
  const args = (Array.isArray(req.args) ? req.args : []).map((a) => String(a))

  // ④ CLI spawn 闸（FIFO 排队，DAGENTS_MAX_CLI_PROCESSES 总量护栏——
  // R4 需求 7「受控 exec 通道继承 CLI spawn 闸」的字面落实）
  const release = await acquireCliSlot('custom-exec')
  try {
    return await spawnCollected(resolved.path, args, {
      cwd: opts.cwd,
      timeoutMs,
      signal: req.signal,
    })
  } finally {
    release()
  }
}

interface SpawnCollectedOptions {
  cwd?: string
  timeoutMs: number
  signal?: AbortSignal
}

/** no-shell spawn + 输出采集 + 超时两段强杀 + 取消级联。 */
function spawnCollected(
  file: string,
  args: string[],
  opts: SpawnCollectedOptions,
): Promise<ControlledExecResult> {
  return new Promise<ControlledExecResult>((resolve, reject) => {
    let child: ChildProcess
    try {
      // ⑤ no-shell spawn：无注入面；env 继承网关进程（与 CLI 后端 spawn 同
      // 姿态，claude.ts；用户代码不可指定 cwd/env——请求体闭集，cwd 来自
      // run 级注入）。windowsHide 不弹窗。
      child = spawn(file, args, {
        shell: false,
        cwd: opts.cwd,
        env: process.env,
        windowsHide: true,
      })
    } catch (err) {
      reject(new Error(`受控命令 ${file} spawn 失败：${String(err)}`))
      return
    }

    const stdoutChunks: Buffer[] = []
    const stderrChunks: Buffer[] = []
    let settled = false
    const killTimer: NodeJS.Timeout | undefined = setTimeout(() => {
      customExecTotal.inc(1, { result: 'timeout' })
      killTree()
    }, opts.timeoutMs)
    killTimer.unref?.()
    let hardKillTimer: NodeJS.Timeout | undefined

    const total = (chunks: Buffer[]): string => Buffer.concat(chunks).toString('utf8')

    const finish = (fn: () => void): void => {
      if (settled) return
      settled = true
      clearTimeout(killTimer)
      clearTimeout(hardKillTimer)
      opts.signal?.removeEventListener('abort', onAbort)
      fn()
    }

    /** 两段强杀：SIGTERM（优雅 flush）→ 1s 宽限 → SIGKILL / win32 树终止。 */
    const killTree = (): void => {
      if (child.pid == null || child.exitCode != null || child.signalCode != null) return
      try {
        if (process.platform === 'win32') {
          taskkillTree(child.pid)
          hardKillTimer = setTimeout(() => taskkillTree(child.pid!), 1_000)
          hardKillTimer.unref?.()
          return
        }
        child.kill('SIGTERM')
        hardKillTimer = setTimeout(() => {
          try {
            child.kill('SIGKILL')
          } catch {
            /* 已死 */
          }
        }, 1_000)
        hardKillTimer.unref?.()
      } catch {
        /* 已死 */
      }
    }

    const onAbort = (): void => {
      killTree()
      // 实际 exit 事件统一收口 settle；abort 不直接 resolve（拿不到退出码）
    }
    opts.signal?.addEventListener('abort', onAbort, { once: true })

    child.stdout?.on('data', (chunk: Buffer) => stdoutChunks.push(chunk))
    child.stderr?.on('data', (chunk: Buffer) => stderrChunks.push(chunk))

    child.on('error', (err) => {
      finish(() => reject(new Error(`受控命令 ${file} 执行失败：${err.message}`)))
    })

    child.on('close', (code) => {
      if (settled) return
      customExecTotal.inc(1, { result: 'allowed' })
      const out = truncateOutput(total(stdoutChunks))
      const errOut = truncateOutput(total(stderrChunks))
      finish(() =>
        resolve({
          code,
          stdout: out.text,
          stderr: errOut.text,
          truncated: out.truncated || errOut.truncated,
        }),
      )
    })

    // spawn 后外部已取消（worker 先死一步的竞态）：直接走强杀
    if (opts.signal?.aborted) killTree()

    log.debug('controlled exec spawned', { file, args: args.length, timeoutMs: opts.timeoutMs })
  })
}
