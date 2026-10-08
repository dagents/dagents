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

/**
 * SeedHashMismatchError —— resume 种子哈希对账失败（2026-10-07 可恢复性地基，
 * design-recover §3.1(c)1 / AC-R1-3）。
 *
 * 种子携带 expected input_hash（journal decision 行）时，引擎跳过前用当前
 * runtime 状态对该节点做 mergeInputs + resolveVariables 预演重算指纹；不一致
 * 说明「输入世界线已漂移」（上游输出或节点配置变了），静默重放旧产出会制造
 * 不一致的 run——错误冒泡为 run 终态 failed，message 含 nodeId + 双 hash。
 * 无 hash 的老种子（checkpoint 快照兜底路径）跳过校验照旧种子化（PRD R1.7）。
 */
export class SeedHashMismatchError extends Error {
  readonly nodeId: string
  readonly expectedHash: string
  readonly gotHash: string

  constructor(nodeId: string, expectedHash: string, gotHash: string) {
    super(
      `种子哈希不一致：节点「${nodeId}」期望 ${expectedHash}，实际重算 ${gotHash}` +
        '（输入世界线已漂移——上游输出或节点配置已变化，拒绝静默重放旧产出）',
    )
    this.name = 'SeedHashMismatchError'
    this.nodeId = nodeId
    this.expectedHash = expectedHash
    this.gotHash = gotHash
  }
}

/**
 * NodeRejectedError —— 声明型超限的节点拒绝信号（2026-10-07 R9 9d，
 * design-sharp §2.4）。
 *
 * 语义 = **节点在开始实质执行前被声明/配置层拒绝**（迭代项超上限 / 子流程
 * 嵌套超深 / 声明了 retries≥1 的重试耗尽）：该节点可调整后重试，不属于执行
 * 崩溃。executor 的 runWaves catch 按错误类型分类（不读节点 isolateFailure
 * 声明）：rejected 失败视为 isolated，并入既有失败分支隔离管道 → run 终态
 * partial_success（不整体翻红），span 状态落 'rejected'（可重试黄警档）。
 *
 * 词汇一致性（AC-R9-5）：R4 白名单拒绝、R5 裁决失败落地时同抛本类型——
 * 「节点拒绝」档的错误文案首词统一「节点被拒绝：」。
 */
export class NodeRejectedError extends Error {
  /** 分类标记（instanceof 之外的结构信号——跨包边界的错误对象仍可判别）。 */
  readonly nodeRejected = true

  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options)
    this.name = 'NodeRejectedError'
  }
}
