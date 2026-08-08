/**
 * `mil-daemon` CLI entrypoint (plan M2.3 Step 4).
 *
 * Usage:
 *   mil-daemon <serverUrl> <label> <agentType>
 *
 * Example:
 *   mil-daemon http://localhost:8080 dev-laptop claude
 *
 * The daemon runs until SIGINT/SIGTERM. It logs to stdout (pino) and exits 0
 * on a graceful drain, 1 on a fatal register failure or unexpected crash.
 */
import { runDaemon } from './main.js'
import type { AgentType } from '@dagents/contracts'
import { createLogger } from '@dagents/shared'
import { startTracing } from '@dagents/shared/otel'

// Start OTel BEFORE the daemon loop so the auto-instrumentations patch
// `fetch` (undici) + `http` before the first dispatch call — W3C `traceparent`
// then propagates daemon→dispatch→gateway→LLM without per-call-site header
// plumbing (plan M6.1). The handle is awaited on drain to flush the
// BatchSpanProcessor so a SIGINT/SIGTERM doesn't drop the last in-flight batch.
const tracing = startTracing('daemon')

const log = createLogger({ svc: 'daemon:cli' })

/** Canonical MVP agent-type whitelist (mirrors @dagents/contracts AgentType). */
const AGENT_TYPES: readonly string[] = [
  'claude', 'codex', 'copilot', 'opencode', 'openclaw',
  'hermes', 'gemini', 'pi', 'cursor', 'kimi', 'kiro',
  'antigravity', 'codebuddy', 'qoder',
] as const

function usage(): string {
  return [
    'usage: mil-daemon <serverUrl> <label> <agentType>',
    '',
    '  serverUrl   dispatch server base URL (e.g. http://localhost:8080)',
    '  label       human-readable daemon label (e.g. dev-laptop)',
    `  agentType   one of: ${AGENT_TYPES.join(', ')}`,
    '',
    'example:',
    '  mil-daemon http://localhost:8080 dev-laptop claude',
  ].join('\n')
}

function parseArgs(argv: string[]): { serverUrl: string; label: string; agentType: AgentType } {
  const [serverUrl, label, agentType] = argv
  if (!serverUrl || !label || !agentType) {
    console.error(usage())
    console.error('\nerror: missing required argument(s)')
    process.exit(2)
  }
  if (!AGENT_TYPES.includes(agentType)) {
    console.error(usage())
    console.error(`\nerror: unknown agentType '${agentType}'`)
    process.exit(2)
  }
  return { serverUrl, label, agentType: agentType as AgentType }
}

export function main(argv: string[] = process.argv.slice(2)): void {
  const { serverUrl, label, agentType } = parseArgs(argv)

  const { done, stop } = runDaemon({ serverUrl, label, agentType })

  // Graceful drain on SIGINT/SIGTERM: stop claiming new tasks, let the
  // in-flight task finish, then exit. A second signal forces an immediate exit.
  let signaled = false
  const onSignal = (sig: NodeJS.Signals): void => {
    if (signaled) {
      log.warn('second signal received, forcing exit', { signal: sig })
      process.exit(1)
    }
    signaled = true
    log.info('signal received, draining', { signal: sig })
    stop()
  }
  process.on('SIGINT', onSignal)
  process.on('SIGTERM', onSignal)

  done
    .then(async () => {
      await tracing.shutdown().catch((err) => log.warn('tracing shutdown failed', { error: String(err) }))
      log.info('daemon exited cleanly')
      process.exit(0)
    })
    .catch(async (err) => {
      await tracing.shutdown().catch(() => undefined)
      log.error('daemon exited with error', { error: String(err) })
      process.exit(1)
    })
}

// Run when invoked directly as `node dist/cli.js` / `tsx src/cli.ts`, not when
// imported (tests import `main` to drive arg parsing without auto-run).
const invokedDirectly =
  process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href
if (invokedDirectly) {
  main()
}
