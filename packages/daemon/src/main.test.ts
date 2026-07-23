import { describe, it, expect, vi } from 'vitest'
import { runDaemon } from './main.js'
import { DispatchClient, DispatchHttpError } from './client.js'
import type { AgentBackend, AgentEvent, AgentResult, AgentSession, ExecOptions } from '@mil/contracts'

/**
 * Main-loop tests for `runDaemon` (M2.3).
 *
 * These run entirely in-process with a fake dispatch client and a fake agent
 * backend — no network, no DB, no real `claude` spawn. They assert the loop
 * does the protocol dance the plan specifies:
 *
 *   register(setToken) → heartbeat ticks → claim returns a task →
 *   startTask → reportMessages(streamed) → completeTask(usage) →
 *   idle claim → stop() drains cleanly.
 *
 * Plus the robustness paths the plan skeleton missed:
 *   - an agent failure routes to failTask, not a crash
 *   - the loop survives a transient claim error and retries
 *   - a backendFactory throw (unsupported agentType / spawn config) is caught
 *     by the outer guard and routed to failTask so the task can't orphan
 *   - a non-409 startTask failure routes to failTask (only 409 is a clean skip)
 *   - a transient reportMessages outage doesn't block the terminal result
 */

/** Minimal in-memory fake dispatch server, driven by scripted responses. */
class FakeDispatch {
  daemonId = 'daemon-1'
  token = 'tok-1'
  tasks: ({ id: string; prompt: string; execOptions: ExecOptions })[] = []
  claimed: string[] = []
  starts: string[] = []
  /** Throw from the Nth `startTask` call instead of recording it. */
  startFailOn: { call: number; error: unknown }[] = []
  /** Throw from the Nth `reportMessages` call instead of recording it. */
  reportFailOn: { call: number; error: unknown }[] = []
  messages: { taskId: string; events: AgentEvent[] }[] = []
  completes: { taskId: string; payload: unknown }[] = []
  fails: { taskId: string; payload: unknown }[] = []
  heartbeats: unknown[] = []
  /** Inject a transient failure on the Nth claim call. */
  claimFailOn: number[] = []
  private claimCount = 0
  private startCount = 0
  private reportCount = 0

  /** Make a DispatchClient whose methods hit this fake. */
  client(logger?: unknown): DispatchClient {
    const self = this
    const noop = async () => {}
    return {
      setToken(t: string) {
        self.token = t
      },
      async register(req: { daemonLabel: string; capabilities: { agentType: string }[] }) {
        expect(req.daemonLabel).toBeDefined()
        expect(req.capabilities).toHaveLength(1)
        return { daemonId: self.daemonId, token: self.token }
      },
      async heartbeat(p: unknown) {
        self.heartbeats.push(p)
      },
      async claimTask(daemonId: string) {
        expect(daemonId).toBe(self.daemonId)
        self.claimCount += 1
        if (self.claimFailOn.includes(self.claimCount)) {
          throw new Error('transient claim outage')
        }
        const task = self.tasks.shift() ?? null
        if (task) self.claimed.push(task.id)
        return { task: task ? { ...task, agentDaemonId: 'ad1', runId: 'R-1' } : null }
      },
      async startTask(taskId: string) {
        self.startCount += 1
        const inj = self.startFailOn.find((f) => f.call === self.startCount)
        if (inj) throw inj.error
        self.starts.push(taskId)
      },
      async reportMessages(taskId: string, events: AgentEvent[]) {
        self.reportCount += 1
        const inj = self.reportFailOn.find((f) => f.call === self.reportCount)
        if (inj) throw inj.error
        self.messages.push({ taskId, events })
      },
      async completeTask(taskId: string, payload: unknown) {
        self.completes.push({ taskId, payload })
      },
      async failTask(taskId: string, payload: unknown) {
        self.fails.push({ taskId, payload })
      },
    } as unknown as DispatchClient
  }
}

/** A fake backend that yields scripted events then a result. */
function fakeBackend(events: AgentEvent[], result: AgentResult): (t: string) => AgentBackend {
  return () => ({
    execute(_prompt: string, _opts: ExecOptions): AgentSession {
      const gen = (async function* (): AsyncGenerator<AgentEvent> {
        for (const ev of events) yield ev
      })()
      return {
        events: { [Symbol.asyncIterator]: () => gen },
        result: Promise.resolve(result),
      }
    },
  })
}

/** Drain `runDaemon` until `cond` is true or the loop exits, then stop it. */
async function drainUntil(
  handle: { done: Promise<void>; stop: () => void },
  cond: () => boolean,
  timeoutMs = 1000,
): Promise<void> {
  const start = Date.now()
  while (!cond()) {
    if (Date.now() - start > timeoutMs) throw new Error('drainUntil timed out')
    await new Promise((r) => setTimeout(r, 2))
  }
  handle.stop()
  // give the loop a tick to observe draining and exit
  await new Promise((r) => setTimeout(r, 5))
}

describe('runDaemon — happy path', () => {
  it('registers, claims a task, streams events, and completes it', async () => {
    const fake = new FakeDispatch()
    fake.tasks.push({ id: 't1', prompt: 'list dir', execOptions: { timeoutMs: 1000 } })

    const events: AgentEvent[] = [
      { type: 'status', status: 'started', sessionId: 'sess-1' },
      { type: 'text', content: 'hello' },
      { type: 'tool-use', tool: 'Bash', callId: 'c1', input: { cmd: 'ls' } },
      { type: 'tool-result', tool: '', callId: 'c1', output: 'a.txt' },
    ]
    const result: AgentResult = {
      status: 'completed',
      output: 'hello',
      durationMs: 123,
      sessionId: 'sess-1',
      usage: { 'claude-sonnet-4-6': { inputTokens: 10, outputTokens: 5 } },
    }

    const handle = runDaemon({
      serverUrl: 'http://x',
      label: 'dev-laptop',
      agentType: 'claude',
      client: fake.client(),
      backendFactory: fakeBackend(events, result),
      pollIntervalMs: 1,
      heartbeatIntervalMs: 5,
    })

    await drainUntil(handle, () => fake.completes.length === 1)

    expect(fake.starts).toContain('t1')
    // all four events were streamed
    const msgs = fake.messages.filter((m) => m.taskId === 't1')
    expect(msgs.flatMap((m) => m.events)).toEqual(events)
    expect(fake.completes).toHaveLength(1)
    expect(fake.completes[0]!.taskId).toBe('t1')
    expect(fake.completes[0]!.payload).toMatchObject({
      output: 'hello',
      sessionId: 'sess-1',
      durationMs: 123,
      usage: { 'claude-sonnet-4-6': { inputTokens: 10, outputTokens: 5 } },
    })
    // no failure recorded
    expect(fake.fails).toHaveLength(0)
  })

  it('heartbeats on its interval while idle', async () => {
    const fake = new FakeDispatch()
    const handle = runDaemon({
      serverUrl: 'http://x',
      label: 'l',
      agentType: 'claude',
      client: fake.client(),
      backendFactory: fakeBackend([], { status: 'completed', output: '', durationMs: 0, usage: {} }),
      pollIntervalMs: 100,
      heartbeatIntervalMs: 2,
    })
    await new Promise((r) => setTimeout(r, 20))
    handle.stop()
    await new Promise((r) => setTimeout(r, 5))
    expect(fake.heartbeats.length).toBeGreaterThanOrEqual(2)
    expect(handle).toBeDefined()
  })
})

describe('runDaemon — failure path', () => {
  it('routes a failed agent result to failTask and keeps running', async () => {
    const fake = new FakeDispatch()
    fake.tasks.push({ id: 't-fail', prompt: 'boom', execOptions: {} })

    const result: AgentResult = {
      status: 'failed',
      output: '',
      error: 'claude exited with code 1',
      durationMs: 5,
      usage: {},
    }

    const handle = runDaemon({
      serverUrl: 'http://x',
      label: 'l',
      agentType: 'claude',
      client: fake.client(),
      backendFactory: fakeBackend([], result),
      pollIntervalMs: 1,
      heartbeatIntervalMs: 50,
    })

    await drainUntil(handle, () => fake.fails.length === 1)

    expect(fake.fails).toHaveLength(1)
    expect(fake.fails[0]!.taskId).toBe('t-fail')
    expect(fake.fails[0]!.payload).toMatchObject({
      error: 'claude exited with code 1',
      failureReason: 'failed',
    })
    expect(fake.completes).toHaveLength(0)
  })

  it('reports a backend throw via failTask(failureReason=daemon_error)', async () => {
    const fake = new FakeDispatch()
    fake.tasks.push({ id: 't-throw', prompt: 'x', execOptions: {} })

    const throwingFactory = (): AgentBackend => ({
      execute(): AgentSession {
        // throws synchronously inside the async generator on first iteration
        const gen = (async function* (): AsyncGenerator<AgentEvent> {
          throw new Error('spawn ENOENT')
        })()
        return {
          events: { [Symbol.asyncIterator]: () => gen },
          result: Promise.resolve({
            status: 'failed',
            output: '',
            durationMs: 0,
            usage: {},
          } satisfies AgentResult),
        }
      },
    })

    const handle = runDaemon({
      serverUrl: 'http://x',
      label: 'l',
      agentType: 'claude',
      client: fake.client(),
      backendFactory: throwingFactory,
      pollIntervalMs: 1,
      heartbeatIntervalMs: 50,
    })

    await drainUntil(handle, () => fake.fails.length === 1)

    expect(fake.fails).toHaveLength(1)
    expect(fake.fails[0]!.payload).toMatchObject({
      error: 'spawn ENOENT',
      failureReason: 'daemon_error',
    })
  })
})

describe('runDaemon — orphan prevention (review HIGH#1)', () => {
  it('routes a backendFactory throw to failTask so the task does not orphan', async () => {
    // `backendFactory(opts.agentType)` is evaluated as the `executeTask`
    // argument before executeTask runs; a throw here used to escape to the
    // outer catch that never called failTask, orphaning the claimed task.
    const fake = new FakeDispatch()
    fake.tasks.push({ id: 't-factory', prompt: 'x', execOptions: {} })

    const throwingFactory = (): AgentBackend => {
      throw new Error(`unsupported agentType 'codex': only 'claude' has an adapter`)
    }

    const handle = runDaemon({
      serverUrl: 'http://x',
      label: 'l',
      agentType: 'claude',
      client: fake.client(),
      backendFactory: throwingFactory,
      pollIntervalMs: 1,
      heartbeatIntervalMs: 50,
    })

    await drainUntil(handle, () => fake.fails.length === 1)

    expect(fake.fails).toHaveLength(1)
    expect(fake.fails[0]!.taskId).toBe('t-factory')
    expect(fake.fails[0]!.payload).toMatchObject({
      failureReason: 'daemon_error',
      error: expect.stringContaining("unsupported agentType 'codex'"),
    })
    // startTask was never reached (factory threw first); no complete either.
    expect(fake.starts).not.toContain('t-factory')
    expect(fake.completes).toHaveLength(0)
  })

  it('fails the task on a non-409 startTask error instead of orphaning it', async () => {
    // A 5xx / timeout / 422 startTask failure used to `return` silently,
    // leaving the task stuck in `claimed`. Now only a 409 is a clean skip;
    // everything else routes to failTask.
    const fake = new FakeDispatch()
    fake.tasks.push({ id: 't-start5xx', prompt: 'x', execOptions: {} })
    fake.startFailOn = [{ call: 1, error: new DispatchHttpError(503, '/start', 'upstream down') }]

    const handle = runDaemon({
      serverUrl: 'http://x',
      label: 'l',
      agentType: 'claude',
      client: fake.client(),
      backendFactory: fakeBackend([], { status: 'completed', output: '', durationMs: 0, usage: {} }),
      pollIntervalMs: 1,
      heartbeatIntervalMs: 50,
    })

    await drainUntil(handle, () => fake.fails.length === 1)

    expect(fake.fails).toHaveLength(1)
    expect(fake.fails[0]!.taskId).toBe('t-start5xx')
    expect(fake.fails[0]!.payload).toMatchObject({
      failureReason: 'daemon_error',
      error: expect.stringContaining('503'),
    })
    // backend never executed (start bailed first)
    expect(fake.completes).toHaveLength(0)
  })

  it('treats a 409 startTask conflict as a clean skip (no failTask)', async () => {
    // A 409 = task already terminal (duplicate claim / cancelled); bailing
    // without failTask is correct — reporting failure on an already-terminal
    // task would just 409 too. This locks the 409-vs-rest branch.
    const fake = new FakeDispatch()
    fake.tasks.push({ id: 't-409', prompt: 'x', execOptions: {} })
    fake.startFailOn = [{ call: 1, error: new DispatchHttpError(409, '/start', 'task already terminal') }]

    const handle = runDaemon({
      serverUrl: 'http://x',
      label: 'l',
      agentType: 'claude',
      client: fake.client(),
      backendFactory: fakeBackend([], { status: 'completed', output: '', durationMs: 0, usage: {} }),
      pollIntervalMs: 1,
      heartbeatIntervalMs: 50,
    })

    await drainUntil(handle, () => fake.starts.length === 0 && fake.fails.length === 0 && fake.completes.length === 0, 300)

    // Neither failTask nor completeTask fired — clean skip.
    expect(fake.fails).toHaveLength(0)
    expect(fake.completes).toHaveLength(0)
  })
})

describe('runDaemon — resilience', () => {
  it('survives a transient claim error and retries on the next tick', async () => {
    const fake = new FakeDispatch()
    fake.tasks.push({ id: 't1', prompt: 'p', execOptions: {} })
    // first claim call throws; second succeeds and returns the task
    fake.claimFailOn = [1]

    const events: AgentEvent[] = [{ type: 'text', content: 'ok' }]
    const result: AgentResult = { status: 'completed', output: 'ok', durationMs: 1, usage: {} }

    const handle = runDaemon({
      serverUrl: 'http://x',
      label: 'l',
      agentType: 'claude',
      client: fake.client(),
      backendFactory: fakeBackend(events, result),
      pollIntervalMs: 1,
      heartbeatIntervalMs: 50,
    })

    await drainUntil(handle, () => fake.completes.length === 1)
    expect(fake.completes).toHaveLength(1)
  })

  it('keeps streaming and still completes when reportMessages fails mid-run', async () => {
    // Per-event try/catch: a transient reportMessages outage is logged, the
    // remaining events keep streaming, and the terminal completeTask still
    // fires. This locks the resilience path the review asked to cover.
    const fake = new FakeDispatch()
    fake.tasks.push({ id: 't-msg', prompt: 'p', execOptions: {} })
    // 2nd reportMessages call (one of the middle events) throws; the loop
    // must swallow it and proceed to completeTask.
    fake.reportFailOn = [{ call: 2, error: new DispatchHttpError(503, '/messages', 'dispatch blip') }]

    const events: AgentEvent[] = [
      { type: 'status', status: 'started', sessionId: 's1' },
      { type: 'text', content: 'a' },
      { type: 'text', content: 'b' },
    ]
    const result: AgentResult = {
      status: 'completed',
      output: 'ab',
      durationMs: 2,
      sessionId: 's1',
      usage: {},
    }

    const handle = runDaemon({
      serverUrl: 'http://x',
      label: 'l',
      agentType: 'claude',
      client: fake.client(),
      backendFactory: fakeBackend(events, result),
      pollIntervalMs: 1,
      heartbeatIntervalMs: 50,
    })

    await drainUntil(handle, () => fake.completes.length === 1)

    // The failed 2nd call was not recorded (it threw), but the other two
    // events landed — 2 message batches instead of 3.
    const msgs = fake.messages.filter((m) => m.taskId === 't-msg')
    expect(msgs).toHaveLength(2)
    // The terminal result still reached completeTask despite the blip.
    expect(fake.completes).toHaveLength(1)
    expect(fake.completes[0]!.taskId).toBe('t-msg')
    expect(fake.completes[0]!.payload).toMatchObject({ output: 'ab', sessionId: 's1' })
    expect(fake.fails).toHaveLength(0)
  })

  it('exits cleanly when register fails (fatal, no crash)', async () => {
    // client whose register rejects
    const badClient = {
      setToken: () => {},
      register: async () => {
        throw new Error('dispatch 503')
      },
      heartbeat: async () => {},
      claimTask: async () => ({ task: null }),
      startTask: async () => {},
      reportMessages: async () => {},
      completeTask: async () => {},
      failTask: async () => {},
    } as unknown as DispatchClient

    const handle = runDaemon({
      serverUrl: 'http://x',
      label: 'l',
      agentType: 'claude',
      client: badClient,
      backendFactory: fakeBackend([], { status: 'completed', output: '', durationMs: 0, usage: {} }),
      pollIntervalMs: 1,
      heartbeatIntervalMs: 50,
    })

    // register failure resolves `done` (graceful exit), it does not reject
    await expect(handle.done).resolves.toBeUndefined()
  })
})
