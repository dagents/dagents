/** Hermes adapter — `hermes acp` (ACP JSON-RPC). Thin wrapper over acp-backend. */
import { createAcpBackend } from './acp-backend.js'

export const HERMES_BLOCKED_ARGS: Record<string, 'value' | 'standalone'> = {
  'acp': 'standalone',
}

export const hermesBackend = createAcpBackend({
  agentName: 'hermes',
  defaultBinary: 'hermes',
  subcommand: ['acp'],
  blockedArgs: HERMES_BLOCKED_ARGS,
})
