/** Qoder adapter — `qodercli --yolo --acp` (ACP JSON-RPC). */
import { createAcpBackend } from './acp-backend.js'

export const QODER_BLOCKED_ARGS: Record<string, 'value' | 'standalone'> = {
  '--acp': 'standalone',
  'acp': 'standalone',
  '--yolo': 'standalone',
}

export const qoderBackend = createAcpBackend({
  agentName: 'qoder',
  defaultBinary: 'qodercli',
  subcommand: ['--yolo', '--acp'],
  blockedArgs: QODER_BLOCKED_ARGS,
})
