/**
 * Console WebSocket frames (v0.3-M4.2, architecture §6.8).
 *
 * The console subscribes to a single platform WS hub and reacts to live-state
 * frames instead of polling. Frames are a closed discriminated union keyed by
 * `type`; each variant carries the minimal delta a client view needs to patch
 * its in-memory model. Clients must default on unknown `type`s so the union
 * can grow without breaking consumers.
 *
 * ⚠️ Production status (2026-08-16 audit): the gateway's ws-hub currently
 * broadcasts ONLY `chat:*` frames. `agent-updated` / `run-updated` are
 * RESERVED shapes —— no producer exists in `apps/gateway` yet. The console's
 * agent-detail listener is forward-compat code that never fires against
 * today's gateway; the view relies on its REST polling fallback until a
 * producer lands. Do not treat these variants as a working feature.
 * （2026-10-07 更新：`run-updated` 已由 R9b 激活——gateway `lib/run-notify.ts`
 * 在画布直跑/resume 路径终态收口发射，ws-hub 扩 runId 订阅维度；`agent-updated`
 * 仍是 reserved shape。）
 *
 * This lives in `@dagents/contracts` (zero-dependency, built first) so the browser
 * client (`apps/console/src/lib/ws-client.ts`) and any future server-side
 * emitter share one source of truth for the on-the-wire shape.
 *
 * The `agent-updated` variant intentionally carries the agent-detail view's
 * presence vocabulary (`online` / `unstable` / `offline`) rather than the raw
 * `daemon_status` (`online` / `offline` / `draining`): the hub is the place
 * that maps daemon heartbeat state to presence, and the client should not
 * re-derive it. The view still keeps its existing `deriveAvailability` for the
 * initial REST fetch (where the payload carries `daemon_status`); the WS delta
 * is applied on top.
 *
 * The `chat:done` variant carries the run's final `usage` / `durationMs` /
 * `cost` so the console can render a usage footer without a follow-up REST
 * fetch. The gateway's `persistComplete` already broadcasts these fields on
 * its `ChatEvent`; the type just declares them so the client can read them.
 */
import type { TokenUsage } from './agent.js'

/** Presence vocabulary the agent-detail live-presence pill renders.
 *  Mirrors `apps/console/src/lib/agent-detail.ts:AgentAvailability`. */
export type AgentPresence = 'online' | 'unstable' | 'offline'

/** Lifecycle status the agent-detail inspector surfaces. Kept narrower than
 *  the catalogue `AgentStatus` union: the hub only pushes statuses a live run
 *  can transition through. */
export type AgentLifecycleStatus = 'running' | 'queued' | 'idle' | 'failed' | 'paused'

/** One frame on the console WS hub. Add a variant here + a consumer branch —
 *  clients must ignore unknown `type`s (forward-compat). */
export type ConsoleWsFrame =
  | { type: 'agent-updated'; agentId: string; availability: AgentPresence; status: AgentLifecycleStatus }
  /**
   * Run lifecycle delta（2026-10-07 R9b 激活，design-sharp §2.2）：producer =
   * gateway `lib/run-notify.ts` 单点（进程内 Set 幂等 claim，superseded 抑制）。
   * `status` 进终态词表（completed/failed/partial_success/budget_exceeded/
   * stopped/awaiting_input…）即「run 完成」信号；`awaiting_input` 不算完成、
   * 不触发通知。`flowId` 供 console 路由跳转；`stopReason` 与 R3 runEnd 帧
   * 同词表（user/interrupted/superseded/model/provider），客户端据此过滤
   * superseded 等不该产生用户可见通知的终态——R3 落库路径未合入前本方向
   * 保证不发射 undefined 以外的值。
   */
  | {
      type: 'run-updated'
      runId: string
      flowId?: string
      status: string
      stopReason?: string
    }
  | ChatWsFrame

/** Chat realtime frame variants. Emitted by the gateway's InlineAgentExecutor
 *  and broadcast to clients subscribed (via WS `subscribe` message or
 *  `?chat=<id>` query) to the corresponding chatId. Clients accumulate
 *  `chat:message` chunks into the active assistant bubble, then seal it on
 *  `chat:done` (or surface an error on `chat:error`). `chat:cancelled`
 *  (execution-cancellation spec D6) seals the bubble after a user-initiated
 *  cancel — the backend process/fetch was actually stopped, unlike the old
 *  UI-only stop which left the run going. */
export type ChatWsFrame =
  | { type: 'chat:message'; chatId: string; runId?: string; role: 'assistant'; content: string; streaming: true }
  | { type: 'chat:done'; chatId: string; runId?: string; role: 'assistant'; content: string; streaming: false; status?: string; usage?: TokenUsage; durationMs?: number; cost?: number }
  | { type: 'chat:error'; chatId: string; runId?: string; role: 'assistant'; content: string; streaming: false; error?: string }
  /** stopReason（2026-10-07 R3.5 最小实现，design-recover §3.3(e)）：中止来源
   *  （user/superseded，gateway classifyAbortReason 判定）——客户端据此过滤
   *  superseded 等不该产生用户可见通知的取消终态。 */
  | { type: 'chat:cancelled'; chatId: string; runId?: string; role: 'assistant'; content: string; streaming: false; reason?: string; stopReason?: string }

/** Type guard: any chat:* frame. Useful for filters that want to demux chat
 * traffic from agent-updated / run-updated frames. */
export function isChatFrame(f: ConsoleWsFrame): f is ChatWsFrame {
  return f.type === 'chat:message' || f.type === 'chat:done' || f.type === 'chat:error' || f.type === 'chat:cancelled'
}
