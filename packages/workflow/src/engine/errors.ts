/**
 * HumanInputPendingError —— 持久挂起信号（2026-09-18 断点续跑设计 §6.3）。
 *
 * 挂起语义从「resolver 内部 await 内存 Promise」升级为「resolver reject 本
 * 错误」：引擎捕获后把 run 以 awaiting 状态收敛（不判失败），挂起载荷
 * （prompt/inputType/options）由宿主落库；应答到达时以 resume 语义续跑
 * （答案经 seedRuntime.humanInputs 预供）。重启不再丢挂起。
 */
export class HumanInputPendingError extends Error {
  readonly prompt: string
  readonly inputType: string
  readonly options: unknown[]

  constructor(prompt: string, inputType = 'text', options: unknown[] = []) {
    super(`HumanInput awaiting answer: ${prompt.slice(0, 100)}`)
    this.name = 'HumanInputPendingError'
    this.prompt = prompt
    this.inputType = inputType
    this.options = options
  }
}
