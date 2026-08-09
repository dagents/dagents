/**
 * Shared ACP (Agent Client Protocol) transport for JSON-RPC 2.0 over
 * stdin/stdout — used by hermes, kimi, kiro, grok, qoder, traecli.
 *
 * Translated from multica `hermesClient` (hermes.go, the shared ACP client
 * used by all ACP-family backends). The protocol:
 *
 *   1. Spawn CLI binary with ACP subcommand
 *   2. JSON-RPC `session/new` (or `session/load` for resume) → sessionId
 *   3. JSON-RPC `session/prompt` with the user message
 *   4. Read notifications: `session/update` (text deltas, tool calls, thoughts)
 *      and `session/request_permission` (auto-approve by selecting safe option)
 *   5. `session/prompt` response → stopReason + usage → done
 *
 * Each ACP adapter (hermes.ts, kimi.ts, etc.) is a thin wrapper that provides
 * the binary name, subcommand, blocked args, and optional extra launch args.
 */
import { spawn, type ChildProcess } from 'node:child_process'
import * as readline from 'node:readline'
import type {
  AgentBackend,
  AgentEvent,
  AgentResult,
  AgentSession,
  BackendConfig,
  ExecOptions,
  Logger,
  TokenUsage,
} from '@dagents/contracts'
import { createLogger } from '@dagents/shared'
import { filterCustomArgs, buildChildEnv, AsyncEventQueue, STDERR_TAIL_BYTES, SIGKILL_GRACE_MS } from './stream-backend.js'

// ────────────────────────────────────────────────────────────────────────────
// ACP JSON-RPC types
// ────────────────────────────────────────────────────────────────────────────

interface JsonRpcRequest {
  jsonrpc: '2.0'
  id: number
  method: string
  params?: unknown
}

interface JsonRpcResponse {
  jsonrpc: '2.0'
  id?: number
  result?: unknown
  error?: { code: number; message: string; data?: unknown }
  method?: string
  params?: unknown
}

interface PendingRpc {
  resolve: (result: unknown) => void
  reject: (err: Error) => void
  method: string
}

// ────────────────────────────────────────────────────────────────────────────
// ACP session/update event types
// ────────────────────────────────────────────────────────────────────────────

interface AcpUpdate {
  type: string
  // agent_message_chunk / agent_thought_chunk
  content?: string
  role?: string
  // tool_call
  toolCallId?: string
  toolName?: string
  // tool_call_update (cumulative args text)
  argsText?: string
  rawInput?: Record<string, unknown>
  // tool_call result
  status?: string
  content_text?: string
  isError?: boolean
}

// ────────────────────────────────────────────────────────────────────────────
// ACP adapter configuration
// ────────────────────────────────────────────────────────────────────────────

export interface AcpAdapterConfig {
  /** Agent name for logging (e.g. 'hermes', 'kimi'). */
  agentName: string
  /** Default binary name (e.g. 'hermes', 'kimi', 'kiro-cli'). */
  defaultBinary: string
  /** Subcommand + flags before customArgs (e.g. ['acp'], ['agent', '--always-approve', 'stdio']). */
  subcommand: string[]
  /** Blocked args table for filterCustomArgs. */
  blockedArgs: Record<string, 'value' | 'standalone'>
}

// ────────────────────────────────────────────────────────────────────────────
// ACP client — JSON-RPC 2.0 transport over stdin/stdout
// ────────────────────────────────────────────────────────────────────────────

class AcpClient {
  private nextId = 1
  private pending = new Map<number, PendingRpc>()
  private queue: AsyncEventQueue
  private log: Logger
  private proc: ChildProcess
  private sessionId: string | undefined
  private output = ''
  private usage: Record<string, TokenUsage> = {}
  private modelId: string | undefined
  private stopped = false

  constructor(
    proc: ChildProcess,
    queue: AsyncEventQueue,
    log: Logger,
    private agentName: string,
  ) {
    this.proc = proc
    this.queue = queue
    this.log = log
  }

  /** Send a JSON-RPC request and await the response. */
  request(method: string, params?: unknown): Promise<unknown> {
    const id = this.nextId++
    const msg: JsonRpcRequest = { jsonrpc: '2.0', id, method, params }
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject, method })
      const data = JSON.stringify(msg) + '\n'
      this.proc.stdin!.write(data, (err) => {
        if (err) {
          this.pending.delete(id)
          reject(new Error(`${this.agentName} write ${method}: ${err.message}`))
        }
      })
    })
  }

  /** Start reading stdout lines. Called once after spawn. */
  startReading(): void {
    const rl = readline.createInterface({ input: this.proc.stdout!, crlfDelay: Infinity })
    rl.on('line', (line) => this.handleLine(line.trim()))
    rl.on('close', () => {
      this.failAllPending(new Error(`${this.agentName} stdout closed`))
    })
  }

  /** Handle one JSON-RPC line. */
  private handleLine(line: string): void {
    if (!line) return
    let msg: JsonRpcResponse
    try {
      msg = JSON.parse(line) as JsonRpcResponse
    } catch {
      return // non-JSON line, ignore
    }

    // Response to our request
    if (msg.id != null && (msg.result != null || msg.error != null)) {
      const p = this.pending.get(msg.id)
      if (p) {
        this.pending.delete(msg.id)
        if (msg.error) {
          p.reject(new Error(`${this.agentName} ${p.method}: ${msg.error.message}`))
        } else {
          // If this is session/prompt response, extract results
          if (p.method === 'session/prompt') {
            this.extractPromptResult(msg.result)
          }
          p.resolve(msg.result)
        }
      }
      return
    }

    // Agent → client request (has id + method, no result/error)
    if (msg.id != null && msg.method) {
      this.handleAgentRequest(msg)
      return
    }

    // Notification (no id, has method)
    if (msg.method) {
      this.handleNotification(msg)
    }
  }

  /** Handle agent → client request (e.g. session/request_permission). */
  private handleAgentRequest(msg: JsonRpcResponse): void {
    if (msg.method === 'session/request_permission') {
      // Auto-approve by selecting the safest offered option
      const params = msg.params as { options?: Array<{ optionId: string }> } | undefined
      const options = params?.options ?? []
      // Prefer "allow"-style options
      const grant = options.find((o) => o.optionId.includes('allow') || o.optionId.includes('approve'))
      const selected = grant ?? options[0]
      const resp = {
        jsonrpc: '2.0' as const,
        id: msg.id,
        result: { optionId: selected?.optionId ?? 'deny' },
      }
      this.proc.stdin!.write(JSON.stringify(resp) + '\n')
      return
    }
    // Unknown agent request — reply with empty result
    const resp = { jsonrpc: '2.0' as const, id: msg.id, result: {} }
    this.proc.stdin!.write(JSON.stringify(resp) + '\n')
  }

  /** Handle notification (session/update, session/notification). */
  private handleNotification(msg: JsonRpcResponse): void {
    if (msg.method !== 'session/update' && msg.method !== 'session/notification') return
    const params = msg.params as { update?: AcpUpdate; sessionId?: string } | undefined
    const update = params?.update
    if (!update) return

    if (params?.sessionId) this.sessionId = params.sessionId

    switch (update.type) {
      case 'agent_message_chunk':
      case 'agent_message': {
        const text = update.content ?? ''
        if (text) {
          this.output += text
          this.queue.push({ type: 'text', content: text })
        }
        break
      }
      case 'agent_thought_chunk':
      case 'agent_thought': {
        if (update.content) this.queue.push({ type: 'thinking', content: update.content })
        break
      }
      case 'tool_call': {
        if (update.toolName) {
          this.queue.push({
            type: 'tool-use',
            tool: update.toolName,
            callId: update.toolCallId ?? '',
            input: update.rawInput ?? {},
          })
        }
        break
      }
      case 'tool_call_update':
        // Cumulative args for streaming tool calls — buffer until completed
        break
      case 'tool_result': {
        this.queue.push({
          type: 'tool-result',
          tool: update.toolName ?? '',
          callId: update.toolCallId ?? '',
          output: update.content_text ?? '',
        })
        break
      }
      case 'error': {
        const errMsg = update.content ?? `${this.agentName} error`
        this.queue.push({ type: 'error', content: errMsg })
        break
      }
      default:
        // Other update types (plan, progress) — surface as log
        if (update.content) {
          this.queue.push({ type: 'log', content: `[${update.type}] ${update.content}` })
        }
    }
  }

  /** Extract stopReason + usage from session/prompt response. */
  private extractPromptResult(result: unknown): void {
    if (!result || typeof result !== 'object') return
    const r = result as {
      stopReason?: string
      usage?: Record<string, number>
      _meta?: { modelId?: string; usage?: Record<string, number>; costUsdTicks?: number }
    }
    // Model ID
    const mid = r._meta?.modelId
    if (mid) this.modelId = mid
    // Usage — prefer top-level, fall back to _meta
    const u = r.usage ?? r._meta?.usage ?? {}
    const model = this.modelId ?? this.agentName
    const tu: TokenUsage = {
      inputTokens: u.inputTokens ?? u.input_tokens ?? u.input ?? 0,
      outputTokens: u.outputTokens ?? u.output_tokens ?? u.output ?? 0,
    }
    if (u.cacheReadTokens ?? u.cachedReadTokens ?? u.cache_read ?? u.cached_input_tokens) {
      tu.cacheReadTokens = u.cacheReadTokens ?? u.cachedReadTokens ?? u.cache_read ?? u.cached_input_tokens
    }
    if (u.cacheWriteTokens ?? u.cacheCreationInputTokens ?? u.cache_write ?? u.cache_creation_input_tokens) {
      tu.cacheWriteTokens = u.cacheWriteTokens ?? u.cacheCreationInputTokens ?? u.cache_write ?? u.cache_creation_input_tokens
    }
    if (tu.inputTokens > 0 || tu.outputTokens > 0) {
      this.usage[model] = tu
    }
  }

  /** Fail all pending RPCs (called when stdout closes or process exits). */
  failAllPending(err: Error): void {
    for (const [, p] of this.pending) {
      p.reject(err)
    }
    this.pending.clear()
  }

  /** Get accumulated output. */
  getOutput(): string { return this.output }
  getSessionId(): string | undefined { return this.sessionId }
  getUsage(): Record<string, TokenUsage> { return this.usage }
  isStopped(): boolean { return this.stopped }
  setStopped(): void { this.stopped = true }
}

// ────────────────────────────────────────────────────────────────────────────
// spawnAcpAgent — the full ACP lifecycle
// ────────────────────────────────────────────────────────────────────────────

export interface AcpSpawnConfig {
  acpCfg: AcpAdapterConfig
  backendCfg: BackendConfig
  opts: ExecOptions
  prompt: string
}

export function spawnAcpAgent(config: AcpSpawnConfig): AgentSession {
  const { acpCfg, backendCfg, opts, prompt } = config
  const log: Logger = backendCfg.logger ?? createLogger({ svc: `${acpCfg.agentName}-adapter` })
  const execPath = backendCfg.executablePath || acpCfg.defaultBinary
  const startedAt = Date.now()

  const queue = new AsyncEventQueue()

  // Build argv: subcommand + filtered customArgs
  const args = [
    ...acpCfg.subcommand,
    ...filterCustomArgs(opts.extraArgs, acpCfg.blockedArgs, log),
    ...filterCustomArgs(opts.customArgs, acpCfg.blockedArgs, log),
  ]

  let finalStatus: AgentResult['status'] = 'completed'
  let finalError: string | undefined

  const done = (async (): Promise<AgentResult> => {
    const proc = spawn(execPath, args, {
      cwd: opts.cwd,
      env: buildChildEnv(backendCfg.env),
      stdio: ['pipe', 'pipe', 'pipe'],
    })

    log.info(`${acpCfg.agentName} spawn`, { exec: execPath, args: acpCfg.subcommand })

    let stderrTail = ''
    proc.on('error', (err) => {
      finalStatus = 'failed'
      finalError = `${acpCfg.agentName} spawn failed: ${err.message}`
    })
    proc.stdin?.on('error', () => {})
    proc.stdout?.on('error', () => {})
    proc.stderr!.on('data', (d: Buffer) => {
      const s = d.toString()
      log.warn(`${acpCfg.agentName} stderr`, { chunk: s.slice(-512) })
      stderrTail = (stderrTail + s).slice(-STDERR_TAIL_BYTES)
    })

    const exitCode = new Promise<number | null>((resolve) => {
      proc.once('close', resolve)
      proc.once('error', () => resolve(null))
    })

    // Create ACP client and start reading
    const client = new AcpClient(proc, queue, log, acpCfg.agentName)
    client.startReading()

    // Timeout
    let timer: NodeJS.Timeout | undefined
    if (opts.timeoutMs && opts.timeoutMs > 0) {
      timer = setTimeout(() => {
        proc.kill('SIGTERM')
        setTimeout(() => proc.kill('SIGKILL'), SIGKILL_GRACE_MS)
        finalStatus = 'timeout'
        finalError = `${acpCfg.agentName} timed out after ${opts.timeoutMs}ms`
      }, opts.timeoutMs)
    }

    try {
      // session/new or session/load
      let sessionResult: unknown
      try {
        const sessionParams: Record<string, unknown> = {}
        if (opts.cwd) sessionParams.cwd = opts.cwd
        if (opts.model) sessionParams.model = opts.model
        if (opts.mcpConfig) sessionParams.mcpServers = opts.mcpConfig

        if (opts.resumeSessionId) {
          sessionResult = await client.request('session/load', {
            sessionId: opts.resumeSessionId,
            ...sessionParams,
          })
        } else {
          sessionResult = await client.request('session/new', sessionParams)
        }
      } catch (err) {
        // session/new might not be needed for some agents
        log.debug(`${acpCfg.agentName} session setup`, { error: (err as Error).message })
      }

      // session/prompt
      await client.request('session/prompt', {
        prompt: [{ type: 'text', content: prompt }],
      })

      // Try session/end (best-effort)
      try {
        await client.request('session/end')
      } catch {
        // ignore
      }
    } catch (err) {
      finalStatus = 'failed'
      finalError = `${acpCfg.agentName}: ${(err as Error).message}`
    }

    // Cleanup
    if (timer) clearTimeout(timer)
    try { proc.stdin!.end() } catch {}
    client.failAllPending(new Error('session ended'))

    const code = await exitCode
    if (finalStatus === 'completed' && code !== 0 && code !== null) {
      finalStatus = 'failed'
      finalError = `${acpCfg.agentName} exited with code ${code}`
    }
    if (finalError && stderrTail) {
      finalError = `${finalError}\n--- ${acpCfg.agentName} stderr (tail) ---\n${stderrTail}`
    }

    return {
      status: finalStatus,
      output: client.getOutput() || finalError || '',
      error: finalError,
      durationMs: Date.now() - startedAt,
      sessionId: client.getSessionId(),
      usage: client.getUsage(),
    }
  })()

  void done.then(() => queue.close(), () => queue.close())

  return { events: queue, result: done }
}

// ────────────────────────────────────────────────────────────────────────────
// createAcpBackend — factory for ACP agent backends
// ────────────────────────────────────────────────────────────────────────────

export function createAcpBackend(acpCfg: AcpAdapterConfig): (cfg: BackendConfig) => AgentBackend {
  return (cfg: BackendConfig): AgentBackend => ({
    execute(prompt: string, opts: ExecOptions): AgentSession {
      return spawnAcpAgent({ acpCfg, backendCfg: cfg, opts, prompt })
    },
  })
}
