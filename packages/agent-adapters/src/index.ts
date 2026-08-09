// Agent adapter exports — each adapter implements AgentBackend from @dagents/contracts.
// The factory (`createBackend`) maps AgentType → adapter at runtime.

// Claude (stream-json, full-featured)
export { claudeBackend, buildClaudeArgs, parseEvent } from './claude.js'
export type { ClaudeStreamMessage } from './claude.js'

// Codex (NDJSON --json mode, MVP)
export { codexBackend, buildCodexArgs } from './codex.js'

// Qwen Code (stream-json, same SDK family as Claude)
export { qwenBackend, buildQwenArgs } from './qwen.js'

// GitHub Copilot CLI (JSONL dotted events)
export { copilotBackend, buildCopilotArgs } from './copilot.js'

// OpenCode (JSON run mode)
export { opencodeBackend, buildOpencodeArgs } from './opencode.js'

// CodeBuddy (Claude Code fork, stream-json — reuses claude parseEvent)
export { codebuddyBackend, buildCodebuddyArgs } from './codebuddy.js'

// Cursor Agent (stream-json, prompt via stdin)
export { cursorBackend, buildCursorArgs } from './cursor.js'

// DevEco Code (OpenCode engine NDJSON, paired tool_use events)
export { devecoBackend, buildDevecoArgs } from './deveco.js'

// Google Antigravity (plain-text stdout, no structured events)
export { antigravityBackend, buildAntigravityArgs } from './antigravity.js'

// OpenClaw (NDJSON events or single JSON blob with payloads+meta)
export { openclawBackend, buildOpenclawArgs } from './openclaw.js'

// Pi (JSON event stream with tool-call markup sanitization)
export { piBackend, buildPiArgs } from './pi.js'

// ACP agents (JSON-RPC 2.0 over stdin/stdout via shared acp-backend)
export { hermesBackend } from './hermes.js'
export { kimiBackend } from './kimi.js'
export { kiroBackend } from './kiro.js'
export { grokBackend } from './grok.js'
export { qoderBackend } from './qoder.js'
export { traecliBackend } from './traecli.js'
export { createAcpBackend, spawnAcpAgent } from './acp-backend.js'
export type { AcpAdapterConfig } from './acp-backend.js'

// Shared infrastructure (for building new adapters)
export { spawnStreamAgent, AsyncEventQueue, filterCustomArgs, buildChildEnv } from './stream-backend.js'
export type { StreamAgentRunState, StreamAgentConfig } from './stream-backend.js'

// BackendFactory — AgentType → AgentBackend
export { createBackend } from './factory.js'

// MCP config support
export { writeMcpConfigToTemp } from './mcp-config.js'
export type { McpConfigFile } from './mcp-config.js'
