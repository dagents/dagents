/**
 * BackendFactory — maps an AgentType to its concrete adapter.
 *
 * Mirrors multica `agent.New()`: given an agent type string and a config,
 * return the corresponding `AgentBackend` implementation. Unknown types
 * throw (fail-loudly, not silently) so the caller gets an actionable error.
 *
 * All 18 agent types from multica are supported:
 *
 *   Stream-JSON / NDJSON (spawnStreamAgent):
 *     claude, codex, qwen, copilot, opencode, codebuddy, cursor, deveco,
 *     antigravity, openclaw, pi
 *
 *   ACP (Agent Client Protocol, JSON-RPC over stdin/stdout):
 *     hermes, kimi, kiro, grok, qoder, traecli
 */
import type { AgentType, BackendConfig, BackendFactory } from '@dagents/contracts'
import { claudeBackend } from './claude.js'
import { codexBackend } from './codex.js'
import { qwenBackend } from './qwen.js'
import { copilotBackend } from './copilot.js'
import { opencodeBackend } from './opencode.js'
import { codebuddyBackend } from './codebuddy.js'
import { cursorBackend } from './cursor.js'
import { devecoBackend } from './deveco.js'
import { antigravityBackend } from './antigravity.js'
import { openclawBackend } from './openclaw.js'
import { piBackend } from './pi.js'
import { hermesBackend } from './hermes.js'
import { kimiBackend } from './kimi.js'
import { kiroBackend } from './kiro.js'
import { grokBackend } from './grok.js'
import { qoderBackend } from './qoder.js'
import { traecliBackend } from './traecli.js'

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
    case 'codebuddy':
      return codebuddyBackend(cfg)
    case 'cursor':
      return cursorBackend(cfg)
    case 'deveco':
      return devecoBackend(cfg)
    case 'antigravity':
      return antigravityBackend(cfg)
    case 'openclaw':
      return openclawBackend(cfg)
    case 'pi':
      return piBackend(cfg)
    case 'hermes':
      return hermesBackend(cfg)
    case 'kimi':
      return kimiBackend(cfg)
    case 'kiro':
      return kiroBackend(cfg)
    case 'grok':
      return grokBackend(cfg)
    case 'qoder':
      return qoderBackend(cfg)
    case 'traecli':
      return traecliBackend(cfg)
    default:
      throw new Error(
        `unsupported agent type '${agentType}': no adapter implemented. ` +
          'All 18 multica agents are supported: claude, codex, qwen, copilot, opencode, ' +
          'codebuddy, cursor, deveco, antigravity, openclaw, pi, hermes, kimi, kiro, grok, qoder, traecli.',
      )
  }
}
