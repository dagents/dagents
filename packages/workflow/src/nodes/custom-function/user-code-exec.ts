import { Worker } from 'node:worker_threads'
import type { ControlledExecRequest, ControlledExecResult } from '../../types/execution.js'

/**
 * CustomFunction 的用户代码执行器（2026-09-06 单机还债；2026-10-07 R4 增补
 * $exec 受控命令通道）。
 *
 * 此前 `new Function(...)` 同步跑在 gateway 事件循环上 —— 一个 `while(true)`
 * 就冻住整个网关（含所有进行中的 run/WS），这是比「沙箱」更疼的实际问题。
 * 现在用户代码在 worker_threads 里执行：
 *   - 超时强杀（默认 5s，CUSTOM_FN_TIMEOUT_MS 可调）：死循环只死自己节点；
 *   - AbortSignal 贯穿（run 取消时 worker 一并终止）；
 *   - 危险全局遮蔽（require/process/globalThis/Worker 以参数名 shadow 成
 *     undefined）：挡住「顺手」访问宿主 —— 不是安全边界。
 *
 * ⚠️ 如实声明：这是**隔离不是沙箱**。worker_threads 共享 Node 运行时，
 * 刻意逃逸（constructor 链、import() 动态加载）拦不住；真正的沙箱需要
 * isolated-vm/子进程级隔离。单机个人工具下它解决的是「自己写的函数搞
 * 挂网关」+「外部模板里的函数顺手摸宿主」两类现实风险。多用户之前必须
 * 换真沙箱（见 docs/workflow-engine.md 现状与限制）。
 *
 * $exec 受控命令通道（R4，docs/zcode-borrow/design-permission.md §3.2）：
 *   - 用户代码永不直连 child_process —— `$exec(cmd, args)` 经 postMessage
 *     RPC 到父侧，父侧持**可信白名单**（来自节点 data，绝不由 worker 消息
 *     携带）裁决后转发宿主 execRunner 受控 spawn；
 *   - 通道缺席（节点未声明 allowedCommands / 宿主未注入 execRunner）时
 *     `$exec` 是 undefined —— 调用即 TypeError，节点层翻译成结构化指引；
 *   - settle（超时/取消/正常返回）时 terminate worker 并 abort 全部在途
 *     exec（AbortSignal 级联），杜绝「worker 死了子进程还在跑」。
 */

/** eval 模式 worker 的内联源码（CJS）：收码执行、$exec RPC、结构化克隆回传。 */
const WORKER_SOURCE = `
const { parentPort } = require('worker_threads')
// $exec RPC 的 worker 侧对账表：id → { resolve, reject }
const pendingExecs = new Map()
let execSeq = 0

parentPort.on('message', (m) => {
  // 父侧回执：resolve/reject 对应 $exec 调用
  if (m && m.__execResult) {
    const p = pendingExecs.get(m.__execResult.id)
    if (p) {
      pendingExecs.delete(m.__execResult.id)
      if (m.__execResult.ok) p.resolve(m.__execResult.result)
      else p.reject(new Error(m.__execResult.error))
    }
    return
  }

  try {
    // 通道缺席时 $exec 是 undefined —— 用户代码调用即 TypeError（节点层
    // 翻译成「未声明 allowedCommands」的结构化指引）
    const $exec = m.execAvailable
      ? (cmd, args, opts) => {
          if (typeof cmd !== 'string' || cmd.length === 0) {
            return Promise.reject(new Error('$exec 的第一个参数必须是非空命令名字符串'))
          }
          if (args !== undefined && !Array.isArray(args)) {
            return Promise.reject(new Error('$exec 的第二个参数必须是字符串数组（argv）'))
          }
          for (const a of args ?? []) {
            if (typeof a !== 'string') {
              return Promise.reject(new Error('$exec 的参数数组只接受字符串（防注入，argv 原样透传）'))
            }
          }
          const id = ++execSeq
          const promise = new Promise((resolve, reject) => {
            pendingExecs.set(id, { resolve, reject })
          })
          parentPort.postMessage({
            __exec: { id, cmd, args: args ?? [], timeoutMs: opts && typeof opts.timeoutMs === 'number' ? opts.timeoutMs : undefined },
          })
          return promise
        }
      : undefined
    // 危险全局以形参名 shadow 成 undefined —— 挡顺手访问，非逃逸边界
    const fn = new Function(
      'require', 'process', 'globalThis', 'Worker', 'fetch',
      '$input', '$inputText', '$flow', '$exec', m.code)
    // 异步支持（R4 向后兼容契约扩展）：同步 return 或 return Promise
    Promise.resolve(fn(undefined, undefined, undefined, undefined, undefined,
      m.input, m.inputText, { state: m.state }, $exec))
      .then((result) => parentPort.postMessage({ ok: true, result }))
      .catch((err) => parentPort.postMessage({ ok: false, error: String(err && err.stack ? err.stack : err) }))
  } catch (err) {
    parentPort.postMessage({ ok: false, error: String(err && err.stack ? err.stack : err) })
  }
})
`

export interface RunUserCodeOptions {
  /** 超时（ms）。默认 5000，CUSTOM_FN_TIMEOUT_MS 可调；0 = 不限（不建议）。 */
  timeoutMs?: number
  /** 执行取消信号（run 取消 → terminate worker）。 */
  signal?: AbortSignal
  /**
   * R4 受控命令白名单（**可信来源：节点 data，非 worker 消息**）。
   * 缺席 = 通道不存在：worker 侧 $exec 注入 undefined。
   */
  allowedCommands?: string[]
  /** R4 宿主受控执行器（引擎 options.execRunner 透传）；未注入 = 通道全拒。 */
  execRunner?: (req: ControlledExecRequest) => Promise<ControlledExecResult>
  /**
   * R4 过程活动回写（节点层接 onNodeDelta）：每次 $exec 起止各发一行
   * （phase 'start'/'end'），终端/轨迹/摘要三视图零改动即可见。
   */
  onExecActivity?: (event: {
    phase: 'start' | 'end'
    command: string
    args: string[]
    result?: ControlledExecResult
    error?: string
  }) => void
}

const DEFAULT_TIMEOUT_MS = Number(process.env.CUSTOM_FN_TIMEOUT_MS ?? 5_000)

/** 单次受控执行超时上限（与 gateway controlled-exec.ts 的硬顶一致）。 */
const MAX_EXEC_TIMEOUT_MS = 60_000

/** worker RPC 消息（父侧 → worker 的 exec 回执）。 */
interface WorkerExecResultMessage {
  __execResult: { id: number; ok: boolean; result?: unknown; error?: string }
}

/** worker 消息联合：exec 请求或函数结果。 */
type WorkerMessage =
  | WorkerExecResultMessage
  | { ok: boolean; result?: unknown; error?: string }
  | { __exec: { id: number; cmd: string; args: string[]; timeoutMs?: number } }

/**
 * 在 worker 里执行用户函数体（`return ...` 形式），返回其返回值。
 * 约定（2026-10-07 R4 起扩展）：函数体同步 return **或** return Promise
 * （`$exec` 的结果在 Promise 里回流）——旧同步代码零影响；非对象返回值
 * 由调用方包成 { value }。
 */
export function runUserCode(
  code: string,
  input: unknown,
  inputText: string,
  state: Record<string, unknown>,
  opts: RunUserCodeOptions = {},
): Promise<unknown> {
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS
  return new Promise<unknown>((resolve, reject) => {
    const allowed = opts.allowedCommands ?? []
    // 通道 armed = 节点显式声明了白名单（含 declared-empty `[]`——通道在、
    // 但任何命令都 ∉ 空集，逐条拒绝并带「已声明：」空清单文案）
    const execAvailable = opts.allowedCommands !== undefined
    // worker 在途 exec 的取消控制器：settle 时全部 abort（宿主 spawn 级联）
    const inflightExecs = new Map<number, AbortController>()

    let worker: Worker
    try {
      worker = new Worker(WORKER_SOURCE, { eval: true })
    } catch (err) {
      reject(new Error(`custom function worker spawn failed: ${String(err)}`))
      return
    }

    const abortInflightExecs = (): void => {
      for (const ac of inflightExecs.values()) ac.abort(new Error('worker settled'))
      inflightExecs.clear()
    }

    let settled = false
    const settle = (fn: () => void): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      opts.signal?.removeEventListener('abort', onAbort)
      abortInflightExecs()
      void worker.terminate().catch(() => {})
      fn()
    }
    const timer =
      timeoutMs > 0
        ? setTimeout(() => {
            settle(() =>
              reject(
                new Error(`custom function timed out after ${timeoutMs}ms（死循环或过重计算）`),
              ),
            )
          }, timeoutMs)
        : undefined
    const onAbort = (): void => {
      settle(() => reject(new Error('custom function cancelled')))
    }
    opts.signal?.addEventListener('abort', onAbort, { once: true })
    timer?.unref?.()

    const postToWorker = (m: unknown): void => {
      if (settled) return // worker 已 terminate，迟到回执丢弃
      try {
        worker.postMessage(m)
      } catch {
        /* worker 已死 — settle 路径会收敛 */
      }
    }

    /** $exec 请求的父侧裁决（白名单持有方 = 本侧，绝不信任 worker 消息）。 */
    const handleExecRequest = (req: {
      id: number
      cmd: string
      args: string[]
      timeoutMs?: number
    }): void => {
      if (!execAvailable) {
        // 防御性：execAvailable=false 时 worker 不该发 __exec（$exec undefined）
        postToWorker({
          __execResult: {
            id: req.id,
            ok: false,
            error: '节点被拒绝：$exec 不可用——本节点未声明 allowedCommands',
          },
        })
        return
      }
      if (!allowed.includes(req.cmd)) {
        postToWorker({
          __execResult: {
            id: req.id,
            ok: false,
            error: `节点被拒绝：命令 ${req.cmd} 未在 allowedCommands 声明（已声明：${allowed.join(', ')}）——在节点配置「命令白名单」补充后重试`,
          },
        })
        return
      }
      if (!opts.execRunner) {
        postToWorker({
          __execResult: {
            id: req.id,
            ok: false,
            error: '节点被拒绝：$exec 不可用——宿主未提供受控执行通道（gateway 未注入 execRunner）',
          },
        })
        return
      }
      const ac = new AbortController()
      inflightExecs.set(req.id, ac)
      opts.onExecActivity?.({ phase: 'start', command: req.cmd, args: req.args })
      const timeout = Math.min(
        Math.max(1, Math.trunc(req.timeoutMs ?? 15_000)),
        MAX_EXEC_TIMEOUT_MS,
      )
      opts
        .execRunner({
          command: req.cmd,
          args: req.args,
          allowedCommands: allowed,
          timeoutMs: timeout,
          signal: ac.signal,
        })
        .then((result) => {
          if (inflightExecs.delete(req.id)) {
            opts.onExecActivity?.({ phase: 'end', command: req.cmd, args: req.args, result })
            postToWorker({ __execResult: { id: req.id, ok: true, result } })
          }
        })
        .catch((err: unknown) => {
          if (inflightExecs.delete(req.id)) {
            const message = err instanceof Error ? err.message : String(err)
            opts.onExecActivity?.({
              phase: 'end',
              command: req.cmd,
              args: req.args,
              error: message,
            })
            postToWorker({ __execResult: { id: req.id, ok: false, error: message } })
          }
        })
    }

    worker.on('message', (m: WorkerMessage) => {
      if ('__exec' in m) {
        handleExecRequest(m.__exec)
        return
      }
      if ('__execResult' in m) return // worker 不发回执给父侧（防御性忽略）
      settle(() => {
        if (m.ok) resolve(m.result)
        else reject(new Error(`custom function threw: ${m.error ?? 'unknown error'}`))
      })
    })
    worker.on('error', (err) => {
      settle(() => reject(new Error(`custom function worker crashed: ${err.message}`)))
    })
    worker.on('exit', (code) => {
      // 正常路径 exit 在 message 之后被 settle 吞掉；走到这里说明没回传就退了
      settle(() => reject(new Error(`custom function worker exited unexpectedly (code ${code})`)))
    })

    try {
      worker.postMessage({
        code,
        input,
        inputText,
        state,
        execAvailable,
      })
    } catch (err) {
      settle(() => reject(new Error(`custom function input not cloneable: ${String(err)}`)))
    }
  })
}
