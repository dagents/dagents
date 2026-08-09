/** Kimi adapter — `kimi acp` (ACP JSON-RPC). Thin wrapper over acp-backend. */
import { createAcpBackend } from './acp-backend.js'

export const KIMI_BLOCKED_ARGS: Record<string, 'value' | 'standalone'> = {
  'acp': 'standalone',
}

export const kimiBackend = createAcpBackend({
  agentName: 'kimi',
  defaultBinary: 'kimi',
  subcommand: ['acp'],
  blockedArgs: KIMI_BLOCKED_ARGS,
})
