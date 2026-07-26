/**
 * Console WebSocket frames (v0.3-M4.2, architecture §6.8).
 *
 * The console subscribes to a single platform WS hub and reacts to live-state
 * frames instead of polling. Frames are a closed discriminated union keyed by
 * `type`; each variant carries the minimal delta a client view needs to patch
 * its in-memory model. The union starts with the one frame this milestone
 * consumes — `agent-updated` (refresh agent-detail availability/status) — and
 * is open to grow (run-updated, fleet-tick, …) without breaking consumers
 * that default on unknown `type`s.
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
 */

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
  | { type: 'run-updated'; runId: string; status: string }
