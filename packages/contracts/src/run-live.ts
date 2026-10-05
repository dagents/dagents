/**
 * Run live stream wire contract (运行实时终端, 2026-09).
 *
 * One source of truth for the run-live protocol shared by the gateway
 * (`apps/gateway/src/routes/execution-live.ts` + `run-live-registry.ts`) and
 * the browser client (`apps/console` — lib/run-live-protocol.ts +
 * lib/use-run-live.ts). Same rationale as shell.ts: hand-written shapes on
 * both sides have produced real drift bugs; this file is the cure.
 *
 * Transport: SSE over `GET /api/v1/workflows/runs/:runId/live`
 * (browser → console BFF streaming proxy → gateway). The gateway taps the
 * engine hooks (onNodeStart/onNodeEnd/onNodeDelta, composed in
 * workflow-engine-service.ts) and mirrors every event into an in-process
 * per-run frame buffer; late subscribers get the whole buffered prefix as
 * replay, then live frames. This is a mirror of the structured event stream
 * (text/activity deltas, no raw terminal bytes, no ANSI) — terminal *look*
 * is a client rendering concern. Every non-marker frame carries `at` (server
 * append time) so trace timelines position live and replayed events on the
 * same wall clock.
 *
 * Frame order contract:
 *   1. `hello` — exactly once, first frame. Replay snapshot (full frame
 *      prefix, possibly empty) + run state AFTER subscribing (a run that
 *      ended racing the subscribe reports `ended: true` here, not lost).
 *   2. `frame` — zero or more, live frames (same shapes as replay entries).
 *   3. Stream closes shortly after the `runEnd` frame is delivered. A
 *      resumed run (断点续跑/HumanInput 应答) reuses the same runId and
 *      REOPENS the entry: replay then contains the earlier `runEnd` as a
 *      mid-stream phase boundary, followed by the resumed phase's frames.
 *   `: ping` comment lines may interleave as keepalive.
 *
 * Availability ladder: 404 = no in-process entry (run unknown, gateway
 * restarted mid-run, or the entry was swept after retention). The client
 * falls back to node-spans polling rendering — the DB path is always there.
 *
 * Control surface: stdin (插话) is NOT part of this stream; it keeps using
 * `POST /api/v1/workflows/runs/:runId/message` (queued-turn semantics), whose
 * `user_input` receipt echoes back INTO this stream as an activity delta.
 */

/** One structured delta, mirroring the engine's IStreamDelta (structural twin —
 *  contracts must not depend on @dagents/workflow; keep the shapes in sync). */
export type RunLiveDelta =
  | { type: 'text'; text: string }
  | { type: 'activity'; kind: string; label: string; detail?: string }

/** Server-side stamp moment (ISO) — set by the registry at buffer-append time
 *  (2026-10-01 trace timeline). Optional so old gateways / buffered frames
 *  stay readable; clients fall back to receive time when absent. NOT set on
 *  `truncated` (a replay-only marker, not a real event). */
export interface RunLiveAt {
  at?: string
}

/** Buffered / streamed frame. `nodeStart` carries `nodeType` (canvas lookup
 *  table enrichment) so the client can render the `$ command` hint line. */
export type RunLiveFrame =
  | ({ type: 'nodeStart'; nodeId: string; nodeName: string; nodeType?: string | null } & RunLiveAt)
  | {
      type: 'nodeEnd'
      nodeId: string
      nodeName: string
      status: 'done' | 'failed'
      error?: string
      durationMs?: number
    } & RunLiveAt
  | { type: 'delta'; nodeId: string; nodeName: string; delta: RunLiveDelta } & RunLiveAt
  /** Run settled (status as written to the runs row, e.g. completed / failed /
   *  cancelled / awaiting_input). Sweeper-forced ends use 'unknown'. */
  | ({ type: 'runEnd'; status: string } & RunLiveAt)
  /** Buffer head was trimmed (replay-only marker, never streamed live): the
   *  oldest `dropped` frames are gone from the replay prefix. */
  | { type: 'truncated'; dropped: number }

/** `event: hello` — subscribe acknowledgement + replay snapshot. */
export interface RunLiveHello {
  /** Buffered frame prefix, in order (may start with a `truncated` marker). */
  replay: RunLiveFrame[]
  /** Run state as of AFTER subscribing — an end racing the subscribe
   *  surfaces here instead of being lost. */
  ended: boolean
  /** Final run status when `ended` is true (runs-row status string). */
  finalStatus?: string
  flowId: string
  /** ISO timestamp of the first frame (entry creation). */
  startedAt: string
}
