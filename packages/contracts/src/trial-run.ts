/**
 * 画布试运行（R10）wire contract（2026-10-07，design-sharp §3.2）。
 *
 * gateway（routes/workflow-trial.ts）与 console（trial-run-panel / BFF /
 * 证据面板）双端单一事实源——立项理由与 run-live.ts / shell.ts 相同：双端
 * 手写形状产生过真实漂移 bug，本文件是解。
 *
 * 部署形态（PRD R10.1 定稿）：fake llmClient 代码级注入（不建
 * llm_providers 行、不起独立进程）——规则脚本引擎与 e2e :4010 mock server
 * 是同一内核的两份宿主（谓词集逐字段对齐，内核纯函数源码级移植，不共享
 * 运行时进程）。
 */

/**
 * 一条 mock 规则：`match` 全部谓词满足才命中（对 messages 逐条扫描），
 * 命中即按 `respond` 应答。谓词集与 e2e server.mjs 一致：
 * systemContains / userContains / assistantContains / toolResultContains /
 * messagesContain / hasToolResult / modelIs；未知谓词一律不命中（脚本写错
 * 时快速失败）。
 */
export interface TrialMockRespond {
  /** ok=正常文本；error=注入 HTTP 错误；malformed=非 JSON 响应体；empty=空文本；toolLoop=持续索要工具。 */
  mode?: 'ok' | 'error' | 'malformed' | 'empty' | 'toolLoop'
  text?: string
  toolCalls?: unknown[]
  usage?: unknown
  delayMs?: number
  streamChunkSize?: number
  streamIntervalMs?: number
}

export interface TrialMockRule {
  match?: Record<string, unknown>
  /** 命中标注（证据面板的 matchedRule）。 */
  label?: string
  respond?: TrialMockRespond
}

export interface TrialMockScript {
  rules: TrialMockRule[]
  /** 无规则命中时的应答（缺省 = 恒 'mock:unmatched' 文本）。 */
  fallback?: TrialMockRespond
}

/** 节点级脚本编排：按 `params.nodeId` 选 byNode[id]，无则 default，再无则空规则。 */
export interface TrialMockScriptSet {
  byNode?: Record<string, TrialMockScript>
  default?: TrialMockScript
}

/** POST /api/v1/workflows/:id/trial 请求体。 */
export interface TrialRunRequest {
  input?: string
  /** 选中子图；缺省/null = 全图。P0 = 单值/全图，P1 = 多值。 */
  scope?: { nodeIds: string[] }
  mockScript?: TrialMockScript | TrialMockScriptSet
  /** http 节点口径：skip（缺省）= 不发真实请求、输出带标注；real = 真发（SSRF/重定向守卫照常）。 */
  httpMode?: 'skip' | 'real'
  /** 外部上游节点输出手填（面板预填最近一次正式 run 同 nodeId 输出）。 */
  seedInputs?: Record<string, string>
  /** HumanInput 预供答案（与直跑 state.humanInputs 同契约，键 = prompt）。 */
  humanInputs?: Record<string, string>
  /** customFunction 的项目语境（可选）。 */
  directoryId?: string
}

/** POST /api/v1/workflows/:id/trial 成功响应。 */
export interface TrialRunResponse {
  runId: string
  async: true
}

/**
 * GET /api/v1/runs/:runId/trial-calls 响应条目——每次 mock chat 一条
 * （AC-R10-7 动态实证层：`unresolvedPlaceholders` 是对最终 messages 复扫
 * `{{…}}` 的启发式计数，与 llm.node.ts 运行时同口径）。
 *
 * 诚实边界：记录存 gateway 进程内 registry，run 终态后 10 分钟清理、
 * 重启即丢——404 时证据面板回退 spans 投影（span.input 已持久）。
 */
export interface TrialMockCall {
  seq: number
  nodeId?: string
  model?: string
  messages: unknown[]
  matchedRule?: string
  unresolvedPlaceholders?: string[]
  ts: string
}
