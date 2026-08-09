/** Kiro adapter — `kiro-cli acp --trust-all-tools` (ACP JSON-RPC). */
import { createAcpBackend } from './acp-backend.js'

export const KIRO_BLOCKED_ARGS: Record<string, 'value' | 'standalone'> = {
  'acp': 'standalone',
  '-a': 'standalone',
  '--trust-all-tools': 'standalone',
  '--trust-tools': 'value',
}

export const kiroBackend = createAcpBackend({
  agentName: 'kiro',
  defaultBinary: 'kiro-cli',
  subcommand: ['acp', '--trust-all-tools'],
  blockedArgs: KIRO_BLOCKED_ARGS,
})
