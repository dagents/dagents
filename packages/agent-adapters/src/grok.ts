/** Grok adapter — `grok --no-auto-update agent --always-approve stdio` (ACP JSON-RPC). */
import { createAcpBackend } from './acp-backend.js'

export const GROK_BLOCKED_ARGS: Record<string, 'value' | 'standalone'> = {
  'agent': 'standalone',
  'stdio': 'standalone',
  '--always-approve': 'standalone',
  '--yolo': 'standalone',
  '-p': 'standalone',
  '--print': 'standalone',
  '--model': 'value',
  '-m': 'value',
  '--effort': 'value',
}

export const grokBackend = createAcpBackend({
  agentName: 'grok',
  defaultBinary: 'grok',
  subcommand: ['--no-auto-update', 'agent', '--always-approve', 'stdio'],
  blockedArgs: GROK_BLOCKED_ARGS,
})
