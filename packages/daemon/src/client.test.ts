import { describe, it, expect, vi } from 'vitest'
import { DispatchClient, DispatchHttpError } from './client.js'
import type {
  AgentEvent,
  ClaimTaskResponse,
  RegisterResponse,
} from '@mil/contracts'

/**
 * Unit tests for `DispatchClient` (M2.3).
 *
 * The client is a thin HTTP layer over the dispatch envelope `{ success, data }`.
 * These tests stub `fetch` (via the client's `fetchImpl` injection point) so
 * they run without a live dispatch server and assert:
 *   - register/claim unwrap the envelope into bare DTOs
 *   - terminal endpoints (start/messages/complete/fail) accept 204 and don't
 *     try to parse a JSON body
 *   - the auth header is absent before register and present after
 *   - non-success statuses raise DispatchHttpError carrying status + body
 *
 * No network, no DB — pure transport-shape coverage.
 */

interface StubCall {
  url: string
  init: RequestInit
}

function makeResponse(status: number, body: unknown, headers: Record<string, string> = {}): Response {
  // 204/304 must not carry a body (the Response constructor throws otherwise);
  // dispatch's terminal endpoints return 204 No Content.
  if (body === null || body === undefined) {
    return new Response(null, { status, headers })
  }
  const text = typeof body === 'string' ? body : JSON.stringify(body)
  return new Response(text, {
    status,
    headers: { 'content-type': 'application/json', ...headers },
  })
}

/** Build a stub fetch that records calls and replays scripted responses by path. */
function stubFetch(
  routes: Record<string, (call: StubCall) => Response>,
): { fetchImpl: typeof fetch; calls: StubCall[] } {
  const calls: StubCall[] = []
  const fetchImpl = vi.fn(async (url: string, init?: RequestInit) => {
    const call: StubCall = { url, init: init ?? {} }
    calls.push(call)
    for (const [path, handler] of Object.entries(routes)) {
      if (url.includes(path)) return handler(call)
    }
    return makeResponse(404, { success: false, error: 'no route' })
  }) as unknown as typeof fetch
  return { fetchImpl, calls }
}

describe('DispatchClient — auth header', () => {
  it('omits authorization before register and sets it after', async () => {
    const { fetchImpl, calls } = stubFetch({
      '/register': () => makeResponse(200, { success: true, data: { daemonId: 'd1', token: 'tok-1' } }),
      '/heartbeat': () => makeResponse(204, null),
    })

    const c = new DispatchClient({ baseUrl: 'http://x', fetchImpl, timeoutMs: 0 })
    const reg = await c.register({ daemonLabel: 'l', capabilities: [{ agentType: 'claude' }] })
    expect(calls[0]!.init.headers).not.toHaveProperty('authorization')

    // The main loop calls setToken immediately after register; mirror that here.
    c.setToken(reg.token)
    await c.heartbeat({ daemonId: 'd1', status: 'online', activeTasks: 0 })
    const hbHeaders = calls[1]!.init.headers as Record<string, string>
    expect(hbHeaders.authorization).toBe('Bearer tok-1')
  })
})

describe('DispatchClient — register', () => {
  it('unwraps the envelope and returns daemonId + token', async () => {
    const reg: RegisterResponse = { daemonId: 'd-abc', token: 't-xyz' }
    const { fetchImpl } = stubFetch({
      '/register': (call) => {
        const body = JSON.parse(String(call.init.body)) as { daemonLabel: string; capabilities: unknown[] }
        expect(body.daemonLabel).toBe('dev-laptop')
        expect(body.capabilities).toHaveLength(1)
        return makeResponse(200, { success: true, data: reg })
      },
    })
    const c = new DispatchClient({ baseUrl: 'http://x/', fetchImpl, timeoutMs: 0 })
    const res = await c.register({ daemonLabel: 'dev-laptop', capabilities: [{ agentType: 'claude' }] })
    expect(res).toEqual(reg)
  })

  it('raises DispatchHttpError on a non-success status', async () => {
    const { fetchImpl } = stubFetch({
      '/register': () => makeResponse(422, { success: false, error: 'register failed', detail: 'dup label' }),
    })
    const c = new DispatchClient({ baseUrl: 'http://x', fetchImpl, timeoutMs: 0 })
    await expect(
      c.register({ daemonLabel: 'l', capabilities: [] }),
    ).rejects.toBeInstanceOf(DispatchHttpError)
    try {
      await c.register({ daemonLabel: 'l', capabilities: [] })
    } catch (e) {
      const err = e as DispatchHttpError
      expect(err.status).toBe(422)
      expect(err.body).toContain('register failed')
    }
  })

  it('raises when the envelope lacks success/data', async () => {
    const { fetchImpl } = stubFetch({
      '/register': () => makeResponse(200, { success: false, error: 'internal' }),
    })
    const c = new DispatchClient({ baseUrl: 'http://x', fetchImpl, timeoutMs: 0 })
    await expect(
      c.register({ daemonLabel: 'l', capabilities: [] }),
    ).rejects.toBeInstanceOf(DispatchHttpError)
  })
})

describe('DispatchClient — claim', () => {
  it('returns the task when one is queued', async () => {
    const claimed: ClaimTaskResponse = {
      task: { id: 't1', agentDaemonId: 'ad1', runId: 'R-1', prompt: 'hi', execOptions: {} },
    }
    const { fetchImpl, calls } = stubFetch({
      '/tasks/claim': (call) => {
        // claim sends no body (null → undefined)
        expect(call.init.body).toBeUndefined()
        return makeResponse(200, { success: true, data: claimed })
      },
    })
    const c = new DispatchClient({ baseUrl: 'http://x', fetchImpl, timeoutMs: 0, token: 'tok' })
    const res = await c.claimTask('daemon-1')
    expect(res).toEqual(claimed)
    expect(calls[0]!.url).toContain('/daemons/daemon-1/tasks/claim')
  })

  it('returns { task: null } on an idle poll', async () => {
    const { fetchImpl } = stubFetch({
      '/tasks/claim': () => makeResponse(200, { success: true, data: { task: null } }),
    })
    const c = new DispatchClient({ baseUrl: 'http://x', fetchImpl, timeoutMs: 0, token: 'tok' })
    const res = await c.claimTask('d1')
    expect(res.task).toBeNull()
  })
})

describe('DispatchClient — terminal endpoints (204)', () => {
  it('startTask / reportMessages / completeTask / failTask accept 204 and return void', async () => {
    const { fetchImpl, calls } = stubFetch({
      '/start': () => makeResponse(204, null),
      '/messages': () => makeResponse(204, null),
      '/complete': () => makeResponse(204, null),
      '/fail': () => makeResponse(204, null),
    })
    const c = new DispatchClient({ baseUrl: 'http://x', fetchImpl, timeoutMs: 0, token: 'tok' })

    await expect(c.startTask('t1')).resolves.toBeUndefined()
    const events: AgentEvent[] = [{ type: 'text', content: 'hello' }]
    await expect(c.reportMessages('t1', events)).resolves.toBeUndefined()
    await expect(
      c.completeTask('t1', { output: 'done', usage: {}, durationMs: 42 }),
    ).resolves.toBeUndefined()
    await expect(
      c.failTask('t1', { error: 'boom', failureReason: 'failed' }),
    ).resolves.toBeUndefined()

    // messages body is { messages: [...] }
    const msgBody = JSON.parse(String(calls.find((x) => x.url.includes('/messages'))!.init.body)) as {
      messages: AgentEvent[]
    }
    expect(msgBody.messages).toHaveLength(1)
    expect(msgBody.messages[0]).toEqual(events[0])

    // complete body carries usage + durationMs verbatim
    const compBody = JSON.parse(String(calls.find((x) => x.url.includes('/complete'))!.init.body))
    expect(compBody).toEqual({ output: 'done', usage: {}, durationMs: 42 })
  })

  it('raises DispatchHttpError on a 409 terminal conflict', async () => {
    const { fetchImpl } = stubFetch({
      '/complete': () => makeResponse(409, { success: false, error: 'task already terminal', status: 'completed' }),
    })
    const c = new DispatchClient({ baseUrl: 'http://x', fetchImpl, timeoutMs: 0, token: 'tok' })
    await expect(
      c.completeTask('t1', { output: 'x', usage: {}, durationMs: 1 }),
    ).rejects.toBeInstanceOf(DispatchHttpError)
  })
})

describe('DispatchClient — URL normalization', () => {
  it('strips trailing slashes from baseUrl', async () => {
    const { fetchImpl, calls } = stubFetch({
      '/register': () => makeResponse(200, { success: true, data: { daemonId: 'd', token: 't' } }),
    })
    const c = new DispatchClient({ baseUrl: 'http://x///', fetchImpl, timeoutMs: 0 })
    await c.register({ daemonLabel: 'l', capabilities: [] })
    expect(calls[0]!.url).toBe('http://x/api/v1/dispatch/daemons/register')
  })
})

describe('DispatchClient — timeout', () => {
  it('aborts and raises DispatchHttpError(status=0) when the server is slow', async () => {
    // A fetch that never resolves on its own; the AbortController fires at
    // timeoutMs and the client converts the AbortError into DispatchHttpError.
    // No fake timers — the client's real setTimeout drives the abort, and we
    // use a small timeout so the test stays fast.
    const fetchImpl = vi.fn((_url: string, init?: RequestInit) => {
      return new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => {
          const e = new Error('aborted')
          e.name = 'AbortError'
          reject(e)
        })
      })
    }) as unknown as typeof fetch

    const c = new DispatchClient({ baseUrl: 'http://x', fetchImpl, timeoutMs: 30 })
    await expect(c.register({ daemonLabel: 'l', capabilities: [] })).rejects.toMatchObject({
      name: 'DispatchHttpError',
      status: 0,
    })
  })
})
