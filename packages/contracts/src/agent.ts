/**
 * Agent execution contracts.
 *
 * Translated from multica `server/pkg/agent/agent.go` (Go `Backend` interface)
 * to TypeScript, with the v0.2 漏字段补全 called out in
 * `docs/superpowers/specs/2026-07-08-mvp-execution-plan-design.md` §0.5:
 *   - `ExecOptions.extraArgs` / `customArgs` (multica 双层 CLI 透传)
 *   - `ExecOptions.inactivityTimeoutMs` (multica `SemanticInactivityTimeout`)
 *   - `AgentEvent` `log` variant (multica `MessageLog`)
 * This package is zero-dependency and is the Gate-1 产出物: every layer
 * (daemon, dispatch, db) depends on these types.
 */

/** Canonical MVP agent-type whitelist. Mirrors multica `SupportedTypes`. */
export type AgentType =
  | 'claude' | 'codex' | 'copilot' | 'opencode' | 'openclaw'
  | 'hermes' | 'gemini' | 'pi' | 'cursor' | 'kimi' | 'kiro'
  | 'antigravity' | 'codebuddy' | 'qoder' | 'qwen'

/**
 * Structured logger shape. Defined inline here so `@dagents/contracts` stays
 * zero-dependency (the concrete logger lives in `@dagents/shared`); `BackendConfig`
 * only needs the call surface.
 */
export interface Logger {
  debug(msg: string, ctx?: unknown): void
  info(msg: string, ctx?: unknown): void
  warn(msg: string, ctx?: unknown): void
  error(msg: string, ctx?: unknown): void
}

/** Per-backend configuration. Mirrors multica `agent.Config`. */
export interface BackendConfig {
  /** Path to the CLI binary (e.g. `claude`, `codex`). */
  executablePath: string
  /** Extra environment variables passed to the subprocess. */
  env?: Record<string, string>
  /** Structured logger; backends should fall back to a no-op logger when omitted. */
  logger?: Logger
}

/** Reasoning/effort level, unioned across runtimes that honour it. */
export type ThinkingLevel = 'low' | 'medium' | 'high' | 'xhigh' | 'max'

/**
 * Per-execution options. Mirrors multica `agent.ExecOptions`.
 * `extraArgs` / `customArgs` / `inactivityTimeoutMs` are the v0.2 补全 fields.
 */
export interface ExecOptions {
  cwd?: string
  model?: string
  /** Consumed only by backends that can pass developer/system instructions. */
  systemPrompt?: string
  maxTurns?: number
  /** Hard wall-clock deadline (multica `Timeout`). */
  timeoutMs?: number
  /** Silent-period watchdog (multica `SemanticInactivityTimeout`). */
  inactivityTimeoutMs?: number
  /** Non-empty resumes a previous agent session (multica `ResumeSessionID`). */
  resumeSessionId?: string
  /** Daemon-wide default CLI args, appended before `customArgs` (multica `ExtraArgs`). */
  extraArgs?: string[]
  /** Per-agent CLI args, appended after `extraArgs` (multica `CustomArgs`). */
  customArgs?: string[]
  /** MCP server config passed via `--mcp-config` (multica `McpConfig`). */
  mcpConfig?: unknown
  /** Runtime-native reasoning/effort value; empty/undefined = runtime default. */
  thinkingLevel?: ThinkingLevel
}

/** A running agent execution: streaming events + a single final result. */
export interface AgentSession {
  /** Streamed events; the iterable ends when the agent finishes. */
  events: AsyncIterable<AgentEvent>
  /** Resolves exactly once with the final outcome. */
  result: Promise<AgentResult>
}

/**
 * Unified event emitted by an agent during execution.
 * Mirrors multica `agent.Message` (discriminated by `MessageType`).
 */
export type AgentEvent =
  | { type: 'text'; content: string }
  | { type: 'thinking'; content: string }
  | { type: 'tool-use'; tool: string; callId: string; input: unknown }
  | { type: 'tool-result'; tool: string; callId: string; output: string }
  | { type: 'status'; status: string; sessionId?: string }
  | { type: 'log'; content: string }
  | { type: 'error'; content: string }

/** Final outcome of an agent session. Mirrors multica `agent.Result`. */
export interface AgentResult {
  status: 'completed' | 'failed' | 'aborted' | 'timeout' | 'cancelled'
  output: string
  error?: string
  durationMs: number
  /** Backend session id; pass back via `ExecOptions.resumeSessionId` to resume. */
  sessionId?: string
  /** Token usage keyed by model name. */
  usage: Record<string, TokenUsage>
}

/** Token consumption for a single model. Mirrors multica `agent.TokenUsage`. */
export interface TokenUsage {
  inputTokens: number
  outputTokens: number
  cacheReadTokens?: number
  /** Cache-write (creation) tokens. Mirrors multica `CacheWriteTokens`. */
  cacheWriteTokens?: number
}

/** Unified execution interface each agent adapter implements. */
export interface AgentBackend {
  execute(prompt: string, opts: ExecOptions): AgentSession
}

/** Constructs a backend for a given agent type. Mirrors multica `agent.New`. */
export type BackendFactory = (agentType: AgentType, cfg: BackendConfig) => AgentBackend
