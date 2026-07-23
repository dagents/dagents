/**
 * dispatch ↔ daemon protocol DTOs.
 *
 * Translated from multica's daemon HTTP/WS surface into transport-agnostic
 * TypeScript types. These are the on-the-wire shapes for daemon registration,
 * heartbeats, task claim/dispatch, and task lifecycle reporting.
 */

import type { AgentEvent, AgentType, ExecOptions, TokenUsage } from './agent.js'

/** A daemon advertises which agent types (and optional tags) it can serve. */
export interface DaemonCapability {
  agentType: AgentType
  /** Free-form capability tags (repo access, gpu, region, …). */
  tags?: string[]
}

export type DaemonStatus = 'online' | 'offline' | 'draining'

/** Daemon → dispatch: register and receive a daemon id + auth token. */
export interface RegisterRequest {
  daemonLabel: string
  capabilities: DaemonCapability[]
  /** WebSocket address (optional; MVP uses HTTP pull). */
  endpoint?: string
}

export interface RegisterResponse {
  daemonId: string
  token: string
}

/** Daemon → dispatch: periodic liveness + load signal. */
export interface HeartbeatPayload {
  daemonId: string
  status: DaemonStatus
  activeTasks: number
}

/** dispatch → daemon: a task to run. Mirrors the multica claim/ack payload. */
export interface DispatchTask {
  id: string
  agentDaemonId: string
  runId: string
  prompt: string
  execOptions: ExecOptions
}

/** dispatch → daemon: claim response (`null` task = nothing to claim). */
export interface ClaimTaskResponse {
  task: DispatchTask | null
}

/** Daemon → dispatch: batched event upload (cuts HTTP chatter). */
export interface TaskMessageBatch {
  messages: AgentEvent[]
}

/** Daemon → dispatch: coarse progress hint for UI. */
export interface TaskProgress {
  summary: string
  step: number
  total: number
}

/** Daemon → dispatch: terminal success. */
export interface TaskComplete {
  output: string
  sessionId?: string
  usage: Record<string, TokenUsage>
  durationMs: number
}

/** Daemon → dispatch: terminal failure. `failureReason` is the classified bucket. */
export interface TaskFail {
  error: string
  failureReason: string
  sessionId?: string
}
