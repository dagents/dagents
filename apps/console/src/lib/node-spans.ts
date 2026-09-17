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

/** 节点 span 的规范形状（normalizeRunNodeSpan 的输出；BFF 端点即此形）。 */
export interface RunNodeSpan {
  /** 规范 camelCase —— 消费方不再需要 `nodeId ?? node_id` 双读。 */
  nodeId: string
  nodeLabel: string | null
  nodeType: string | null
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
    /** 运行中插话能力位（2026-09-08 可操作终端）：该 run 当前有活着的
     *  CLI 会话汇点。终端视图 stdin 行据此渲染禁用态。 */
    inputSupported?: boolean
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
  /** runs 行的总耗时（历史卡显示用）。 */
  runDurationMs: number | null
  /** 插话能力位（undefined = 旧网关，按支持处理，发送失败时由回执兜底）。 */
  inputSupported?: boolean
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
    if (!res.ok) return { ok: false, httpStatus: res.status, spans: [], runStatus: null, runDurationMs: null }
    const json = (await res.json()) as NodeSpansEnvelope
    const rows = json.data?.spans ?? []
    return {
      ok: true,
      httpStatus: res.status,
      spans: rows.map(normalizeRunNodeSpan),
      runStatus: json.data?.runStatus ?? null,
      runDurationMs: json.data?.runDurationMs ?? null,
      inputSupported: json.data?.inputSupported,
    }
  } catch {
    return { ok: false, httpStatus: 0, spans: [], runStatus: null, runDurationMs: null }
  }
}
