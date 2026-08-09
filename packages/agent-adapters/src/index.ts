// Agent adapter exports — each adapter implements AgentBackend from @dagents/contracts.
// The factory (`createBackend`) maps AgentType → adapter at runtime.

// Claude (stream-json, full-featured)
export { claudeBackend, buildClaudeArgs, parseEvent } from './claude.js'

// Codex (NDJSON --json mode, MVP)
export { codexBackend, buildCodexArgs } from './codex.js'

// Qwen Code (stream-json, same SDK family as Claude)
export { qwenBackend, buildQwenArgs } from './qwen.js'

// GitHub Copilot CLI (JSONL dotted events)
export { copilotBackend, buildCopilotArgs } from './copilot.js'

// OpenCode (JSON run mode)
export { opencodeBackend, buildOpencodeArgs } from './opencode.js'

// Shared infrastructure (for building new adapters)
export { spawnStreamAgent, AsyncEventQueue, filterCustomArgs, buildChildEnv } from './stream-backend.js'
export type { StreamAgentRunState, StreamAgentConfig } from './stream-backend.js'

// BackendFactory — AgentType → AgentBackend
export { createBackend } from './factory.js'

// MCP config support
export { writeMcpConfigToTemp } from './mcp-config.js'
export type { McpConfigFile } from './mcp-config.js'
