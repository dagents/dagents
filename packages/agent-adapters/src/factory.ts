/**
 * BackendFactory — maps an AgentType to its concrete adapter.
 *
 * Mirrors multica `agent.New()`: given an agent type string and a config,
 * return the corresponding `AgentBackend` implementation. Unknown types
 * throw (fail-loudly, not silently) so the caller gets an actionable error.
 *
 * Currently supported:
 *   - claude    → claudeBackend  (claude.ts, stream-json)
 *   - codex     → codexBackend   (codex.ts, NDJSON --json mode)
 *   - qwen      → qwenBackend    (qwen.ts, stream-json)
 *   - copilot   → copilotBackend (copilot.ts, JSONL dotted events)
 *   - opencode  → opencodeBackend (opencode.ts, JSON)
 *
 * Unsupported (ACP / special protocol — not yet ported):
 *   hermes, gemini/pi, cursor, kimi, kiro, antigravity, codebuddy, qoder,
 *   openclaw
 */
import type { AgentType, BackendConfig, BackendFactory } from '@dagents/contracts'
import { claudeBackend } from './claude.js'
import { codexBackend } from './codex.js'
import { qwenBackend } from './qwen.js'
import { copilotBackend } from './copilot.js'
import { opencodeBackend } from './opencode.js'

export const createBackend: BackendFactory = (
  agentType: AgentType,
  cfg: BackendConfig,
) => {
  switch (agentType) {
    case 'claude':
      return claudeBackend(cfg)
    case 'codex':
      return codexBackend(cfg)
    case 'qwen':
      return qwenBackend(cfg)
    case 'copilot':
      return copilotBackend(cfg)
    case 'opencode':
      return opencodeBackend(cfg)
    default:
      throw new Error(
        `unsupported agent type '${agentType}': no adapter implemented. ` +
          'Supported: claude, codex, qwen, copilot, opencode. ' +
          'ACP-based agents (hermes, kimi, etc.) are not yet ported.',
      )
  }
}
