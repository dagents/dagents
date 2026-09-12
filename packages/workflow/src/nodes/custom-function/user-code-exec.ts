import { Worker } from 'node:worker_threads'

/**
 * CustomFunction 的用户代码执行器（2026-09-06 单机还债）。
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
 */

/** eval 模式 worker 的内联源码（CJS）：收码执行、结构化克隆回传。 */
const WORKER_SOURCE = `
const { parentPort } = require('worker_threads')
parentPort.on('message', (m) => {
  try {
    // 危险全局以形参名 shadow 成 undefined —— 挡顺手访问，非逃逸边界
    const fn = new Function(
      'require', 'process', 'globalThis', 'Worker', 'fetch',
      '$input', '$inputText', '$flow', m.code)
    const result = fn(undefined, undefined, undefined, undefined, undefined,
      m.input, m.inputText, { state: m.state })
    parentPort.postMessage({ ok: true, result })
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
}

const DEFAULT_TIMEOUT_MS = Number(process.env.CUSTOM_FN_TIMEOUT_MS ?? 5_000)

/**
 * 在 worker 里执行用户函数体（`return ...` 形式），返回其返回值。
 * 约定与旧实现一致：函数体同步 return；非对象返回值由调用方包成 { value }。
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
    let worker: Worker
    try {
      worker = new Worker(WORKER_SOURCE, { eval: true })
    } catch (err) {
      reject(new Error(`custom function worker spawn failed: ${String(err)}`))
      return
    }

    let settled = false
    const settle = (fn: () => void): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      opts.signal?.removeEventListener('abort', onAbort)
      void worker.terminate().catch(() => {})
      fn()
    }
    const timer =
      timeoutMs > 0
        ? setTimeout(() => {
            settle(() => reject(new Error(`custom function timed out after ${timeoutMs}ms（死循环或过重计算）`)))
          }, timeoutMs)
        : undefined
    const onAbort = (): void => {
      settle(() => reject(new Error('custom function cancelled')))
    }
    opts.signal?.addEventListener('abort', onAbort, { once: true })
    timer?.unref?.()

    worker.on('message', (m: { ok: boolean; result?: unknown; error?: string }) => {
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
      worker.postMessage({ code, input, inputText, state })
    } catch (err) {
      settle(() => reject(new Error(`custom function input not cloneable: ${String(err)}`)))
    }
  })
}
