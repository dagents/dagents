/**
 * Cancellation tests (execution-cancellation spec D1/D2): an aborted
 * `ExecOptions.signal` must kill the child and resolve
 * `AgentResult.status = 'cancelled'` — across the shared spawn stack and
 * claude's standalone copy.
 *
 * Harness: a real `node` subprocess that emits one line then sleeps forever,
 * so the abort fires mid-run (not before spawn). Unix-only, mirroring
 * claude.lifecycle.test.ts's platform split.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { spawnStreamAgent, wireCancellation } from './stream-backend.js'
import { claudeBackend } from './claude.js'
import type { AgentEvent } from '@dagents/contracts'

const isWindows = process.platform === 'win32'
const describeUnix = isWindows ? describe.skip : describe

/** A child that prints one JSON-ish line, then hangs until killed. */
let chattySleeperPath = ''

beforeAll(async () => {
  if (isWindows) return
  const path = await import('node:path')
  const os = await import('node:os')
  const fs = await import('node:fs/promises')
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'mil-cancel-'))
  chattySleeperPath = path.join(dir, 'sleeper.mjs')
  await fs.writeFile(
    chattySleeperPath,
    `import { setTimeout as sleep } from 'node:timers/promises'
process.stdout.write(JSON.stringify({ type: 'status', status: 'working' }) + '\\n')
await sleep(60_000)
`,
  )
})

afterAll(async () => {
  if (isWindows) return
  const fs = await import('node:fs/promises')
  await fs.rm(chattySleeperPath, { force: true }).catch(() => {})
})

const passthroughParse = (line: string) => {
  try {
    return [{ type: 'log', content: line } as AgentEvent]
  } catch {
    return []
  }
}

describeUnix('spawnStreamAgent cancellation', () => {
  it('abort mid-run kills the child and resolves status=cancelled', async () => {
    const controller = new AbortController()
    const { events, result } = spawnStreamAgent({
      execPath: process.execPath,
      args: [chattySleeperPath],
      opts: { signal: controller.signal },
      cfg: { executablePath: process.execPath },
      agentName: 'cancel-test',
      parseLine: passthroughParse,
      inputMethod: 'argv',
    })

    // Wait for first output (proves the child is alive), then cancel.
    for await (const _evt of events) {
      void _evt
      controller.abort(new Error('user cancelled'))
      break
    }
    const res = await result

    expect(res.status).toBe('cancelled')
    expect(res.error).toContain('cancelled by caller')
  }, 20_000)

  it('pre-aborted signal still yields status=cancelled', async () => {
    const controller = new AbortController()
    controller.abort()
    const { result } = spawnStreamAgent({
      execPath: process.execPath,
      args: [chattySleeperPath],
      opts: { signal: controller.signal },
      cfg: { executablePath: process.execPath },
      agentName: 'cancel-test',
      parseLine: passthroughParse,
      inputMethod: 'argv',
    })
    const res = await result
    expect(res.status).toBe('cancelled')
  }, 20_000)

  it('no signal → normal completion path unaffected', async () => {
    // A child that exits immediately on its own after one line.
    const { result } = spawnStreamAgent({
      execPath: process.execPath,
      args: ['-e', 'process.stdout.write("hi\\n")'],
      opts: {},
      cfg: { executablePath: process.execPath },
      agentName: 'cancel-test',
      parseLine: passthroughParse,
      inputMethod: 'argv',
    })
    const res = await result
    expect(res.status).toBe('completed')
  }, 20_000)
})

describeUnix('claude backend cancellation', () => {
  it('abort resolves status=cancelled (standalone stack)', async () => {
    const controller = new AbortController()
    // The signal listener is registered synchronously inside execute(), so an
    // immediate abort deterministically drives the kill path — whether the
    // real `claude` binary exists or not (ENOENT also lands under cancelled).
    const backend = claudeBackend({ executablePath: process.execPath })
    const session = backend.execute('test', {
      signal: controller.signal,
      timeoutMs: 30_000,
    })
    controller.abort(new Error('user cancelled'))
    const res = await session.result
    expect(res.status).toBe('cancelled')
    expect(res.error).toContain('cancelled by caller')
  }, 20_000)
})

describe('wireCancellation', () => {
  it('fires kill on abort and reports cancelled', () => {
    const controller = new AbortController()
    let killed = 0
    const handle = wireCancellation(controller.signal, () => {
      killed += 1
    })
    expect(handle.cancelled()).toBe(false)
    controller.abort()
    expect(killed).toBe(1)
    expect(handle.cancelled()).toBe(true)
    // dispose is safe post-abort
    handle.dispose()
  })

  it('pre-aborted signal kills immediately', () => {
    const controller = new AbortController()
    controller.abort()
    let killed = 0
    const handle = wireCancellation(controller.signal, () => {
      killed += 1
    })
    expect(killed).toBe(1)
    expect(handle.cancelled()).toBe(true)
  })

  it('no signal is a no-op', () => {
    const handle = wireCancellation(undefined, () => {})
    expect(handle.cancelled()).toBe(false)
    handle.dispose()
  })

  it('dispose removes the listener (no kill after dispose)', () => {
    const controller = new AbortController()
    let killed = 0
    const handle = wireCancellation(controller.signal, () => {
      killed += 1
    })
    handle.dispose()
    controller.abort()
    expect(killed).toBe(0)
    // cancelled() reflects the signal's own state, not the listener
    expect(handle.cancelled()).toBe(true)
  })
})
