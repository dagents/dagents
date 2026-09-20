/**
 * run-live-registry —— 运行实时终端的进程内帧注册表（live attach，2026-09）。
 *
 * 把引擎钩子（onNodeStart/onNodeEnd/onNodeDelta）旁路成 per-run 的帧序列：
 *  - 每个 run 一条环形缓冲（字节上限，头部截断 + truncated 标记），晚订阅者
 *    经 hello.replay 拿到完整前缀再追 live —— 与 shell-registry 的回放语义
 *    同构，这是「DB 快照 + 追尾」方案的根治替代（无合并乱序问题）。
 *  - run settle 时由执行路径显式 finish(status)；断点续跑/HumanInput 应答
 *    复用同一 runId 再执行时，新帧会**重开**已结束的条目（replay 里的
 *    runEnd 成为阶段边界，不是终点）。
 *  - 清扫器兜底：已结束条目过保留期回收；长时间无帧且无执行句柄的条目
 *    强制收敛为 runEnd('unknown')（覆盖 chat 流式等未显式 finish 的路径
 *    与异常退出）。持有执行句柄的静默 run（如 HumanInput 挂起后应答前）
 *    不误伤。
 *
 * 与 execution-registry 的分工：那边是**控制通道**（abort/sendToNode 的
 * 句柄真相源），这边是**镜像通道**（输出帧的缓冲与分发）；run 状态的
 * 真相源永远是 DB runs 行，本注册表重启即丢、不承担持久化语义。
 */

import type { RunLiveDelta, RunLiveFrame, RunLiveHello } from '@dagents/contracts'
import type { IExecutedNode, IStreamDelta } from '@dagents/workflow'
import { executionRegistry } from './execution-registry.js'

interface RunLiveEntry {
  runId: string
  flowId: string
  startedAt: number
  updatedAt: number
  /** 有序帧缓冲（头部可能带 truncated 标记）。 */
  frames: RunLiveFrame[]
  /** 近似字节量（JSON.stringify 逐帧长度），O(1) 维护。 */
  approxBytes: number
  /** 头部累计丢弃帧数（truncated 标记的载荷）。 */
  droppedCount: number
  ended: boolean
  finalStatus?: string
  subscribers: Set<(frame: RunLiveFrame) => void>
}

/** 引擎侧的发射入口（assembleWorkflowEngine 组合钩子时持有）。 */
export interface RunLiveTap {
  nodeStart: (node: { nodeId: string; nodeName: string }) => void
  nodeEnd: (node: IExecutedNode) => void
  delta: (node: { nodeId: string; nodeName: string }, chunk: IStreamDelta) => void
  /** run settle（终态写入 runs 行时调用；status 与 runs 行一致）。 */
  finish: (status: string) => void
}

const entries = new Map<string, RunLiveEntry>()

const numEnv = (name: string, fallback: number): number => {
  const raw = Number(process.env[name])
  return Number.isFinite(raw) && raw > 0 ? raw : fallback
}
/** 回放缓冲字节上限（默认 512KB —— 覆盖长跑节点的主要输出，超限头部截断）。 */
const bufferCapBytes = (): number => numEnv('DAGENTS_RUNLIVE_BUFFER_BYTES', 524_288)
/** 已结束条目的保留期（默认 10 分钟，之后清扫回收 → attach 404 → 客户端回退 DB）。 */
const retainMs = (): number => numEnv('DAGENTS_RUNLIVE_RETAIN_MS', 600_000)
/** 无帧 + 无执行句柄的强制收敛窗（默认 2 分钟）。 */
const idleEndMs = (): number => numEnv('DAGENTS_RUNLIVE_IDLE_END_MS', 120_000)
/** 清扫节拍（默认 60s）。 */
const sweepIntervalMs = (): number => numEnv('DAGENTS_RUNLIVE_SWEEP_MS', 60_000)
/** 条目总数上限（默认 64；超限时优先挤最旧已结束条目）。 */
const maxEntries = (): number => numEnv('DAGENTS_RUNLIVE_MAX_RUNS', 64)

const frameBytes = (frame: RunLiveFrame): number => JSON.stringify(frame).length

function helloOf(entry: RunLiveEntry): RunLiveHello {
  const hello: RunLiveHello = {
    replay: [...entry.frames],
    ended: entry.ended,
    flowId: entry.flowId,
    startedAt: new Date(entry.startedAt).toISOString(),
  }
  if (entry.finalStatus != null) hello.finalStatus = entry.finalStatus
  return hello
}

function trimToCap(entry: RunLiveEntry): void {
  const cap = bufferCapBytes()
  if (entry.approxBytes <= cap) return
  // 连同旧 truncated 标记一起丢，再压一枚携带累计数的新标记到头部。
  while (entry.approxBytes > cap * 0.75 && entry.frames.length > 0) {
    const head = entry.frames.shift()
    if (!head) break
    if (head.type === 'truncated') continue
    entry.droppedCount += 1
    entry.approxBytes -= frameBytes(head)
  }
  if (entry.droppedCount > 0) {
    const marker: RunLiveFrame = { type: 'truncated', dropped: entry.droppedCount }
    const existing = entry.frames[0]
    if (existing?.type === 'truncated') entry.frames.shift()
    entry.frames.unshift(marker)
  }
}

function emit(entry: RunLiveEntry, frame: RunLiveFrame): void {
  // 重开语义：runEnd 之外的任何帧都会唤醒已结束的条目（断点续跑同 runId）。
  if (entry.ended && frame.type !== 'runEnd' && frame.type !== 'truncated') {
    entry.ended = false
    entry.finalStatus = undefined
  }
  entry.frames.push(frame)
  entry.approxBytes += frameBytes(frame)
  entry.updatedAt = Date.now()
  trimToCap(entry)
  // 复制遍历：runEnd 送达时订阅方可能当场退订（路由关流）。
  for (const sub of [...entry.subscribers]) {
    try {
      sub(frame)
    } catch {
      /* 单个订阅方异常不波及其他 */
    }
  }
}

/** IStreamDelta → 契约帧（显式映射，杜绝 contracts 反向依赖 workflow）。 */
function toDeltaFrame(
  node: { nodeId: string; nodeName: string },
  chunk: IStreamDelta,
): RunLiveFrame {
  const delta: RunLiveDelta =
    chunk.type === 'text'
      ? { type: 'text', text: chunk.text }
      : chunk.detail != null
        ? { type: 'activity', kind: chunk.kind, label: chunk.label, detail: chunk.detail }
        : { type: 'activity', kind: chunk.kind, label: chunk.label }
  return { type: 'delta', nodeId: node.nodeId, nodeName: node.nodeName, delta }
}

/** 腾条目额度：优先最旧已结束；否则最旧无订阅者。全忙（都有订阅者）时放行。 */
function evictForSlot(): void {
  if (entries.size < maxEntries()) return
  const pickOldest = (pred: (e: RunLiveEntry) => boolean): RunLiveEntry | null => {
    let found: RunLiveEntry | null = null
    for (const e of entries.values()) {
      if (pred(e) && (!found || e.updatedAt < found.updatedAt)) found = e
    }
    return found
  }
  const victim = pickOldest((e) => e.ended) ?? pickOldest((e) => e.subscribers.size === 0)
  if (victim) entries.delete(victim.runId)
}

/** 取（或惰性创建）run 的发射入口。assembleWorkflowEngine 装配时调用一次。 */
export function forRunLive(
  runId: string,
  flowId: string,
  nodeTypeOf?: (nodeId: string) => string | null | undefined,
): RunLiveTap {
  startSweeper()
  let entry = entries.get(runId)
  if (!entry) {
    evictForSlot()
    entry = {
      runId,
      flowId,
      startedAt: Date.now(),
      updatedAt: Date.now(),
      frames: [],
      approxBytes: 0,
      droppedCount: 0,
      ended: false,
      subscribers: new Set(),
    }
    entries.set(runId, entry)
  }
  return {
    nodeStart: (n) => {
      emit(entry, { type: 'nodeStart', nodeId: n.nodeId, nodeName: n.nodeName, nodeType: nodeTypeOf?.(n.nodeId) ?? null })
    },
    nodeEnd: (en) => {
      const durationMs = Math.max(
        0,
        (Date.parse(en.endedAt) || Date.now()) - (Date.parse(en.startedAt) || Date.now()),
      )
      const frame: RunLiveFrame = {
        type: 'nodeEnd',
        nodeId: en.nodeId,
        nodeName: en.nodeName,
        status: en.status === 'failed' ? 'failed' : 'done',
      }
      if (en.error) frame.error = en.error
      if (Number.isFinite(durationMs)) frame.durationMs = durationMs
      emit(entry, frame)
    },
    delta: (n, chunk) => {
      // 与 span-writer 同款噪音闸：空文本 / 空 label 且无 detail 的活动不发射。
      if (chunk.type === 'text' && chunk.text.length === 0) return
      if (chunk.type === 'activity' && chunk.label.length === 0 && chunk.detail == null) return
      emit(entry, toDeltaFrame(n, chunk))
    },
    finish: (status) => {
      // 幂等：终态可能从多条路径收口（正常 settle + 异常 catch 兜底），
      // 已 ended 再 finish 直接吞掉，不重发 runEnd（重开由 emit 的非 runEnd 帧负责）。
      if (!entries.has(runId) || entry.ended) return
      entry.ended = true
      entry.finalStatus = status
      emit(entry, { type: 'runEnd', status })
    },
  }
}

export interface RunLiveAttachment {
  hello: RunLiveHello
  unsubscribe: () => void
}

/**
 * 订阅 run 的 live 帧。返回 null = 无条目（run 未知 / 网关重启过 / 保留期
 * 已过清扫回收）→ 调用方 404，客户端回退 node-spans 轮询渲染。
 *
 * 竞态安全（与 shell-registry attach 同构）：先挂缓冲订阅者再快照 replay，
 * 快照与正式订阅之间到达的帧进队列、快照后按序补投 —— 订阅瞬间结束的 run
 * 不会丢 runEnd（hello.ended 如实上报）。
 */
export function attachRunLive(
  runId: string,
  onFrame: (frame: RunLiveFrame) => void,
): RunLiveAttachment | null {
  const entry = entries.get(runId)
  if (!entry) return null
  if (entry.ended) {
    // 已结束：replay（含 runEnd）一次性交付，无需订阅。
    return { hello: helloOf(entry), unsubscribe: () => {} }
  }
  const queue: RunLiveFrame[] = []
  const buffering = (f: RunLiveFrame) => queue.push(f)
  entry.subscribers.add(buffering)
  const hello = helloOf(entry)
  entry.subscribers.delete(buffering)
  entry.subscribers.add(onFrame)
  for (const f of queue) onFrame(f)
  return {
    hello,
    unsubscribe: () => {
      entry.subscribers.delete(onFrame)
    },
  }
}

/** 清扫（导出供测试注入时钟与句柄谓词）。 */
export function sweepRunLive(
  now = Date.now(),
  hasExecution: (runId: string) => boolean = (runId) => executionRegistry.getByRun(runId) != null,
): void {
  for (const [runId, entry] of entries) {
    if (entry.ended) {
      if (now - entry.updatedAt > retainMs()) entries.delete(runId)
      continue
    }
    // 未结束但久无新帧且无执行句柄 → 强制收敛（chat 流式路径未显式 finish、
    // 异常退出的兜底）。有句柄的静默 run（HumanInput 挂起等应答）不碰。
    if (now - entry.updatedAt > idleEndMs() && !hasExecution(runId)) {
      const tap = forRunLive(runId, entry.flowId)
      tap.finish('unknown')
    }
  }
}

let sweeperStarted = false
function startSweeper(): void {
  if (sweeperStarted) return
  sweeperStarted = true
  const timer = setInterval(() => sweepRunLive(), sweepIntervalMs())
  timer.unref?.()
}

/** 测试隔离：清空全部条目并停清扫器（生产代码禁用）。 */
export function resetRunLiveForTest(): void {
  entries.clear()
}
