/**
 * GitHub Copilot CLI adapter — spawn `copilot -p <prompt> --output-format json`
 * and parse its JSONL event stream.
 *
 * Copilot CLI emits events with dotted type names and a `data` field:
 *   - `session.start` → { selectedModel, sessionId }
 *   - `assistant.message_delta` → { deltaContent }
 *   - `assistant.message` → { content, reasoningText, outputTokens }
 *   - `tool.call` → { toolName, toolCallId, input }
 *   - `tool.result` → { toolCallId, content }
 *   - `result` → { usage: { inputTokens, outputTokens } }
 *
 * Translated from multica `copilot.go`.
 */
import type {
  AgentBackend,
  AgentEvent,
  AgentSession,
  BackendConfig,
  ExecOptions,
} from '@dagents/contracts'
import { filterCustomArgs, spawnStreamAgent } from './stream-backend.js'
import type { StreamAgentRunState } from './stream-backend.js'

// ────────────────────────────────────────────────────────────────────────────
// argv construction
// ────────────────────────────────────────────────────────────────────────────

const COPILOT_BLOCKED_ARGS: Record<string, 'value' | 'standalone'> = {
  '-p': 'value',
  '--prompt': 'value',
  '-o': 'value',
  '--output-format': 'value',
  '--model': 'value',
}

export function buildCopilotArgs(prompt: string, opts: ExecOptions): string[] {
  // 2026-08-16：加 --allow-all-tools —— 无头模式没有权限交互 UI，缺自主
  // flag 时运行会卡在权限请求上直到 inactivity/timeout watchdog 杀进程。
  const args = ['-p', prompt, '--output-format', 'json', '--allow-all-tools']
  if (opts.model) args.push('--model', opts.model)
  if (opts.maxTurns && opts.maxTurns > 0) args.push('--max-turns', String(opts.maxTurns))
  args.push(...filterCustomArgs(opts.extraArgs, COPILOT_BLOCKED_ARGS))
  args.push(...filterCustomArgs(opts.customArgs, COPILOT_BLOCKED_ARGS))
  return args
}

// ────────────────────────────────────────────────────────────────────────────
// stream-json message types
// ────────────────────────────────────────────────────────────────────────────

interface CopilotEvent {
  type: string
  data: unknown
}

interface CopilotSessionStart {
  selectedModel?: string
  sessionId?: string
}

interface CopilotMessageDelta {
  deltaContent?: string
}

interface CopilotAssistantMessage {
  content?: string
  reasoningText?: string
  outputTokens?: number
}

interface CopilotToolCall {
  toolName?: string
  toolCallId?: string
  input?: unknown
}

interface CopilotToolResult {
  toolCallId?: string
  content?: string
}

interface CopilotResult {
  usage?: { inputTokens?: number; outputTokens?: number }
}

// ────────────────────────────────────────────────────────────────────────────
// parseLine — pure: one JSONL line → AgentEvent[]
// ────────────────────────────────────────────────────────────────────────────

function parseData<T = unknown>(raw: unknown): T | null {
  if (raw == null) return null
  if (typeof raw === 'string') {
    try { return JSON.parse(raw) as T } catch { return null }
  }
  return raw as T
}

export function parseCopilotLine(line: string, state: StreamAgentRunState): AgentEvent[] {
  const out: AgentEvent[] = []
  let evt: CopilotEvent
  try {
    evt = JSON.parse(line) as CopilotEvent
  } catch {
    out.push({ type: 'log', content: line })
    return out
  }

  switch (evt.type) {
    case 'session.start': {
      const d = parseData<CopilotSessionStart>(evt.data)
      if (d?.sessionId) {
        state.sessionId = d.sessionId
        out.push({ type: 'status', status: 'started', sessionId: d.sessionId })
      }
      break
    }
    case 'assistant.message_delta': {
      const d = parseData<CopilotMessageDelta>(evt.data)
      if (d?.deltaContent) {
        state.output += d.deltaContent
        out.push({ type: 'text', content: d.deltaContent })
      }
      break
    }
    case 'assistant.message': {
      const d = parseData<CopilotAssistantMessage>(evt.data)
      if (d?.content) {
        // Authoritative full-turn content — reset accumulated deltas
        state.output = d.content
        out.push({ type: 'text', content: d.content })
      }
      if (d?.reasoningText) {
        out.push({ type: 'thinking', content: d.reasoningText })
      }
      if (d?.outputTokens && d.outputTokens > 0) {
        const model = 'copilot'
        const u = state.usage[model] ?? { inputTokens: 0, outputTokens: 0 }
        u.outputTokens += d.outputTokens
        state.usage[model] = u
      }
      break
    }
    case 'tool.call': {
      const d = parseData<CopilotToolCall>(evt.data)
      out.push({
        type: 'tool-use',
        tool: d?.toolName ?? '',
        callId: d?.toolCallId ?? '',
        input: d?.input,
      })
      break
    }
    case 'tool.result': {
      const d = parseData<CopilotToolResult>(evt.data)
      out.push({
        type: 'tool-result',
        tool: '',
        callId: d?.toolCallId ?? '',
        output: d?.content ?? '',
      })
      break
    }
    case 'result': {
      const d = parseData<CopilotResult>(evt.data)
      if (d?.usage) {
        const model = 'copilot'
        const u = state.usage[model] ?? { inputTokens: 0, outputTokens: 0 }
        u.inputTokens += d.usage.inputTokens ?? 0
        u.outputTokens += d.usage.outputTokens ?? 0
        state.usage[model] = u
      }
      if (state.sessionId) {
        out.push({ type: 'status', status: 'completed', sessionId: state.sessionId })
      }
      break
    }
    default:
      // Unknown event — surface as log for debuggability
      out.push({ type: 'log', content: `copilot event: ${evt.type}` })
  }
  return out
}

// ────────────────────────────────────────────────────────────────────────────
// backend
// ────────────────────────────────────────────────────────────────────────────

export function copilotBackend(cfg: BackendConfig): AgentBackend {
  return {
    execute(prompt: string, opts: ExecOptions): AgentSession {
      const execPath = cfg.executablePath || 'copilot'
      const args = buildCopilotArgs(prompt, opts)
      return spawnStreamAgent({
        execPath,
        args,
        opts,
        cfg,
        agentName: 'copilot',
        parseLine: parseCopilotLine,
        inputMethod: 'argv', // prompt is already in args
      })
    },
  }
}
