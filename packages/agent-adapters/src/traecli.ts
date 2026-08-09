/** Trae CLI adapter — `traecli acp serve --yolo` (ACP JSON-RPC). */
import { createAcpBackend } from './acp-backend.js'

export const TRAECLI_BLOCKED_ARGS: Record<string, 'value' | 'standalone'> = {
  'acp': 'standalone',
  'serve': 'standalone',
  '-y': 'standalone',
  '--yolo': 'standalone',
  '-p': 'standalone',
  '--print': 'standalone',
  '--output-format': 'value',
}

export const traecliBackend = createAcpBackend({
  agentName: 'traecli',
  defaultBinary: 'traecli',
  subcommand: ['acp', 'serve', '--yolo'],
  blockedArgs: TRAECLI_BLOCKED_ARGS,
})
