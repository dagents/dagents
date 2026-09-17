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
import type { AgentBackend, AgentType, BackendConfig, BackendFactory } from '@dagents/contracts'
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

// Record 映射替代 18 分支 switch：编译器的 exhaustiveness 检查接管
// 「新增 AgentType 忘了接工厂」这类错误（switch + 手写 default 错误消息
// 列举是会漂移的）。
const FACTORIES: Record<AgentType, (cfg: BackendConfig) => ReturnType<BackendFactory>> = {
  claude: claudeBackend,
  codex: codexBackend,
  qwen: qwenBackend,
  copilot: copilotBackend,
  opencode: opencodeBackend,
  codebuddy: codebuddyBackend,
  cursor: cursorBackend,
  deveco: devecoBackend,
  antigravity: antigravityBackend,
  openclaw: openclawBackend,
  pi: piBackend,
  hermes: hermesBackend,
  kimi: kimiBackend,
  kiro: kiroBackend,
  grok: grokBackend,
  qoder: qoderBackend,
  traecli: traecliBackend,
  // gemini：2026-08-16 审计删除了 gemini 模板（无适配器，建了也跑不了），
  // 但 AgentType 联合与 console 目录仍含该类型（存量数据兼容）。显式抛错
  // 而非从 Record 里缺席 —— 类型完备性由编译器保证，运行时如实失败。
  gemini: (): AgentBackend => {
    throw new Error(
      "agent type 'gemini' has no adapter — the gemini template was removed in the 2026-08-16 audit; pick another CLI kind",
    )
  },
}

export const createBackend: BackendFactory = (agentType: AgentType, cfg: BackendConfig) => {
  const factory = FACTORIES[agentType]
  if (!factory) {
    // 运行时兜底：agentType 来自数据库/HTTP，可能不在 AgentType 联合内
    throw new Error(
      `unsupported agent type '${String(agentType)}': no adapter implemented ` +
        `(supported: ${Object.keys(FACTORIES).join(', ')})`,
    )
  }
  return factory(cfg)
}
