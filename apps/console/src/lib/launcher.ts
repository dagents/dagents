/**
 * Launcher (index) page static model (M6.1).
 *
 * The hero KPI stats and the platform arch-strip layers, ported verbatim from
 * design/index.html (hero `.hero-stat` rows at lines 118-131; arch-strip steps
 * at lines 175-180). Both are static display data here — the launcher is a
 * landing/overview page, so unlike the dashboard it does not fetch live fleet
 * numbers; it shows the same placeholder KPIs the design shipped (1.04M agents,
 * 82.4K runs, $4,182 cost, 318 daemons) as product copy, and the arch-strip
 * renders the platform's seven layers (architecture-v0.2 §3.1).
 *
 * Extracted from the component so the test (and any future redesign) can
 * assert against the same constant array the view renders.
 */

export interface HeroStat {
  /** Stable key for React + test selectors. */
  id: string
  /** Big mono number (e.g. `1,040,328`, `82.4K`). */
  value: string
  /** Short label under the number (e.g. `注册 agents`). */
  label: string
  /** Delta / sub line (e.g. `+3.2% / 24h`). */
  delta: string
  /** Delta tone — maps to the design's `.d` / `.d.down` / `.d.flat` classes. */
  deltaKind: 'up' | 'down' | 'flat'
}

export interface ArchStep {
  /** Stable key (the layer's ordinal id, e.g. `access`). */
  id: string
  /** Mono ordinal + layer name, e.g. `01 · 接入`. */
  ordinal: string
  /** Layer title, e.g. `轻量 Chat + Flowise 画布`. */
  title: string
  /** One-line detail, e.g. `Next.js 精简 · OpenAPI · Webhook`. */
  detail: string
}

/**
 * Hero KPI stats — ported from design/index.html:118-131. Static product copy
 * (the launcher is an overview; live numbers live on /dashboard).
 */
export const HERO_STATS: readonly HeroStat[] = [
  { id: 'agents', value: '1,040,328', label: '注册 agents', delta: '+3.2% / 24h', deltaKind: 'up' },
  { id: 'throughput', value: '82.4K', label: '今日 runs', delta: '+12.1% / 24h', deltaKind: 'up' },
  { id: 'cost', value: '$4,182', label: '今日成本', delta: '▼ 4.6% / 24h', deltaKind: 'down' },
  { id: 'daemons', value: '318', label: '在线 Agent Daemon', delta: '5 draining', deltaKind: 'flat' },
] as const

/**
 * Platform arch-strip — the seven self-built + reused layers from
 * architecture-v0.2 §3.1 (接入 / 网关 / 编排 / 适配 / 调度 / 版本 / 存储 / 观测).
 *
 * design/index.html shipped only the first four (接入/网关/编排/适配, lines
 * 175-180); the issue brief (MZW-300) and architecture-v0.2 §3.1 call for the
 * full seven-layer platform model, so this port renders all seven. The design's
 * first four map 1:1 to the architecture's top four; the remaining three
 * (调度/版本/存储/观测) are added from §3.1.
 */
export const ARCH_STEPS: readonly ArchStep[] = [
  { id: 'access', ordinal: '01 · 接入', title: '轻量 Chat + Flowise 画布', detail: 'Next.js 精简 · OpenAPI · Webhook' },
  { id: 'gateway', ordinal: '02 · 网关', title: '鉴权 · 限流 · new-api 令牌', detail: 'Trace 注入 run_id 全链路透传' },
  { id: 'orchestration', ordinal: '03 · 编排', title: 'Agentflow V2 状态机引擎', detail: '14 类节点 · HITL · 子流程' },
  { id: 'adapter', ordinal: '04 · 适配', title: '中央 dispatch + 本地 Daemon', detail: 'pull-based claim · 心跳保活' },
  { id: 'scheduler', ordinal: '05 · 调度', title: '异步队列 · 并发闸 · fan-out', detail: '成本熔断 · 断点续跑 · 长任务' },
  { id: 'repro', ordinal: '06 · 版本', title: '快照 · 哈希锁定 · run 绑版本', detail: 'artifact 归档 · 可复现' },
  { id: 'storage', ordinal: '07 · 存储/观测', title: 'PostgreSQL · Redis · MinIO', detail: 'Langfuse trace/cost + OTel · 审计' },
] as const
