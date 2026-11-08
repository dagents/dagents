/**
 * Run node-span client + types（span 载荷形状的唯一归属）。
 *
 * 2026-09-17 整改：此前「唯一归属」是自述 —— canvas-kit-page 的
 * CanvasSpanRow / workflow-run-card 的 SpanRow / run-terminal-format 的
 * TerminalSpanRow 各自抄了一份本地形状，本模块实际 0 引用。现在收敛为
 * 单源：RunNodeSpan 是规范 camelCase 形状；`nodeId`/`node_id` 双写容忍
 * 只在边界归一函数 normalizeRunNodeSpan 里做一次（网关实际只发
 * camelCase，snake_case 容忍留给历史/测试桩形状），三个消费方一律
 * import 本模块、删除本地重复定义。
 *
 * 数据路径：浏览器 → console 自有 BFF `/api/workflows/runs/:runId/node-spans`
 * （服务端）→ gateway `GET /api/v1/workflows/runs/:runId/node-spans`
 * （run_node_spans 表 + runs 行状态/耗时 + 插话能力位）。网关 URL 与
 * 网关行形状不进客户端 bundle。
 */

import type { DeliverableItem } from '@dagents/contracts'

/** 节点 span 的规范形状（normalizeRunNodeSpan 的输出；BFF 端点即此形）。 */
export interface RunNodeSpan {
  /** 规范 camelCase —— 消费方不再需要 `nodeId ?? node_id` 双读。 */
  nodeId: string
  nodeLabel: string | null
  nodeType: string | null
  /** per-node 执行实例序号（R8，§1.3）：stdin 行 nodeId[ordinal] 与插话
   *  寻址用；非迭代节点恒 0。旧网关缺省 0。 */
  ordinal: number
  /** 网关已归一的运行态（running/done/failed/paused…），原样透传。 */
  status: string | null
  error: string | null
  startedAt: string | null
  finishedAt: string | null
  durationMs: number | null
  /** Per-model token usage, when reported; null when none. */
  tokens: unknown
  /** Monetary cost (NUMERIC arrives via gateway as number); null when none. */
  cost: number | null
  /** OTel traceId for end-to-end trace correlation; null when none. */
  traceId: string | null
  /** 节点实际输入（JSONB — model, systemPrompt, userMessage 等）。 */
  input: Record<string, unknown> | string | null
  /** 节点实际输出（JSONB — text, content, activity, events 等）。 */
  output: Record<string, unknown> | string | null
}

/** BFF node-spans 端点的响应信封（data 内的字段集）。 */
export interface NodeSpansEnvelope {
  success: boolean
  data?: {
    runId: string
    spans: unknown[]
    /** runs 行的状态（completed/failed/cancelled 终态；running 或无行时
     *  null/undefined）—— 旁观端据此判断轮询何时收尾。 */
    runStatus?: string | null
    runDurationMs?: number | null
    /** run 级失败原因（2026-09-22）：零 span 的整体失败（拓扑成环 / 启动
     *  即挂）只有 checkpoint failedAt 知道 —— 没有它，前端只见「失败」。 */
    runError?: string | null
    /** 运行的项目目录锚（2026-09-19 P0 数据链）：失败入口「在项目目录打开
     *  终端」的数据源；老运行 / 无目录时 null。 */
    runDirectoryId?: string | null
    /** 运行中插话能力位（2026-09-08）：该 run 当前有活着的
     *  CLI 会话汇点。终端视图 stdin 行据此渲染禁用态。 */
    inputSupported?: boolean
    /** 触发来源（2026-10-07 R10）：'trial' = 试运行行——结果面板顶部
     *  常驻「⚡ 试运行」标记条；null = 旧网关（迁移前）。 */
    runSource?: string | null
    /** 中止/失败来源（2026-10-07 R3，design-recover §3.5(c)）：stopped/failed
     *  行的 stop_reason（interrupted/user/superseded/model/provider）——画布
     *  判「已中断（可恢复）」vs「已停止」的数据面；null = 非中止终态/旧网关。 */
    runStopReason?: string | null
    /** 谱系继承累计 token（R2.3 双口径）：resume/暖缓存 run 沿链前驱的
     *  usage_events SUM——结果面板「谱系继承 M · 本次新增 N」的继承侧；
     *  null = 根运行/旧网关（无双口径）。 */
    lineageTokens?: number | null
    /** 产出清单投影（R6 渐进产物，2026-10-07）：gateway journal 主路 +
     *  spans 兜底的单点投影，与 spans 同信封同节拍。缺席 = 旧网关 / 投影
     *  读失败 —— 聚合区整体不渲染（诚实降级，同 inputSupported 容忍模式）。 */
    deliverables?: DeliverableItem[]
  }
  error?: string
}

/** 从 unknown 里安全取字符串字段（null/undefined/非串都归 null）。 */
function str(v: unknown): string | null {
  return typeof v === 'string' ? v : null
}

/**
 * 边界归一（纯函数）：BFF 响应里的任意 span 行 → 规范 RunNodeSpan。
 * 容忍点集中在这一次：`nodeId`/`node_id` 双写（网关发 camelCase，
 * snake 容忍留给历史形状）、字段缺席、input/output 为对象或字符串。
 * 未知字段静默丢弃。
 */
export function normalizeRunNodeSpan(raw: unknown): RunNodeSpan {
  const r = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>
  const nodeId = typeof r.nodeId === 'string' && r.nodeId
    ? r.nodeId
    : typeof r.node_id === 'string' && r.node_id
      ? r.node_id
      : ''
  const payload = (v: unknown): RunNodeSpan['input'] => {
    if (v == null) return null
    if (typeof v === 'string') return v
    if (typeof v === 'object') return v as Record<string, unknown>
    return null
  }
  return {
    nodeId,
    nodeLabel: str(r.nodeLabel),
    nodeType: str(r.nodeType),
    ordinal: typeof r.ordinal === 'number' ? r.ordinal : 0,
    status: str(r.status),
    error: str(r.error),
    startedAt: str(r.startedAt),
    finishedAt: str(r.finishedAt),
    durationMs: typeof r.durationMs === 'number' ? r.durationMs : null,
    tokens: r.tokens ?? null,
    cost: typeof r.cost === 'number' ? r.cost : null,
    traceId: str(r.traceId),
    input: payload(r.input),
    output: payload(r.output),
  }
}

/** 一次 node-spans 读取的结果：spans + 轮询控制位。 */
export interface RunNodeSpansResult {
  /** HTTP 是否 2xx（非 2xx 时 spans 为空、runStatus 为 null）。 */
  ok: boolean
  /** 原始 HTTP 状态码（消费方拼错误文案用，如 `HTTP 404`）。 */
  httpStatus: number
  spans: RunNodeSpan[]
  /** 终态判断依据（见 NodeSpansEnvelope.runStatus）。 */
  runStatus: string | null
  /** run 级失败原因（见 NodeSpansEnvelope.runError）；成功 / 旧网关为 null。 */
  runError: string | null
  /** runs 行的总耗时（历史卡显示用）。 */
  runDurationMs: number | null
  /** 插话能力位（undefined = 旧网关，按支持处理，发送失败时由回执兜底）。 */
  inputSupported?: boolean
  /** 运行的项目目录锚（P0 数据链）；无目录 / 旧网关为 null。 */
  runDirectoryId: string | null
  /** 触发来源（R10）：'trial' = 试运行；null = 旧网关。 */
  runSource: string | null
  /** 中止来源（R3）：stopped/failed 行的 stop_reason；null = 无/旧网关。 */
  runStopReason: string | null
  /** 谱系继承累计 token（R2.3）；null = 根运行/旧网关。 */
  lineageTokens: number | null
  /** 产出清单（R6 渐进产物）：null = 字段缺席（旧网关 / 投影读失败）→
   *  聚合区整体不渲染；[] = 新网关但零产出（诚实空态）。 */
  deliverables: DeliverableItem[] | null
}

/**
 * Fetch a run's node spans through the console's own API route (server-side).
 * 不抛错：网络异常 / 非 2xx 都收敛为 `{ ok: false, httpStatus, spans: [] }`，
 * 由调用方决定静默重试（画布轮询）还是暴露错误（执行卡重试行）。
 */
export async function fetchRunNodeSpans(runId: string): Promise<RunNodeSpansResult> {
  try {
    const res = await fetch(`/api/workflows/runs/${encodeURIComponent(runId)}/node-spans`, {
      headers: { accept: 'application/json' },
      cache: 'no-store',
    })
    if (!res.ok)
      return {
        ok: false,
        httpStatus: res.status,
        spans: [],
        runStatus: null,
        runError: null,
        runDurationMs: null,
        runDirectoryId: null,
        runSource: null,
        runStopReason: null,
        lineageTokens: null,
        deliverables: null,
      }
    const json = (await res.json()) as NodeSpansEnvelope
    const rows = json.data?.spans ?? []
    return {
      ok: true,
      httpStatus: res.status,
      spans: rows.map(normalizeRunNodeSpan),
      runStatus: json.data?.runStatus ?? null,
      runError: json.data?.runError ?? null,
      runDurationMs: json.data?.runDurationMs ?? null,
      runDirectoryId: json.data?.runDirectoryId ?? null,
      runSource: json.data?.runSource ?? null,
      runStopReason: json.data?.runStopReason ?? null,
      lineageTokens: json.data?.lineageTokens ?? null,
      inputSupported: json.data?.inputSupported,
      deliverables: Array.isArray(json.data?.deliverables) ? json.data!.deliverables! : null,
    }
  } catch {
    return {
      ok: false,
      httpStatus: 0,
      spans: [],
      runStatus: null,
      runError: null,
      runDurationMs: null,
      runDirectoryId: null,
      runSource: null,
      runStopReason: null,
      lineageTokens: null,
      deliverables: null,
    }
  }
}
