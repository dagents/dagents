import { describe, it, expect, vi, afterEach } from 'vitest'
import {
  listTokens,
  getToken,
  createToken,
  updateToken,
  deleteToken,
} from './tokens-client'

/**
 * Unit tests for the browser-side token CRUD client (P1.10.T8, review #2).
 *
 * `tokens-client.ts` is a thin fetch wrapper, but it owns the envelope
 * unwrapping that the route-level integration tests (`route.test.ts`) don't
 * exercise — the routes only assert the body is piped through verbatim. The
 * CRITICAL regression these guard against: `listTokens` once read
 * `payload.data?.items` after `unwrap` had already lifted `body.data`, so
 * the list rendered permanently empty. These tests feed the real
 * `{ success, data: { items, total } }` shape to a mocked fetch and assert
 * the projected tokens come back non-empty.
 *
 * `global.fetch` is stubbed per-test; `tokens.ts`'s `toApiToken` /
 * `deriveTokenStatus` are exercised for real (they have their own suite).
 */

const TOKEN_RECORD = {
  id: 11,
  name: 'tok-a',
  key: 'AAAA**********aaaa',
  group: 'default',
  status: 1,
  remain_quota: 1000,
  used_quota: 200,
  unlimited_quota: false,
  expired_time: -1,
}

/** Build a fetch Response with the gateway/new-api envelope shape. */
function jsonRes(body: unknown, init?: { status?: number }): Response {
  return new Response(JSON.stringify(body), {
    status: init?.status ?? 200,
    headers: { 'content-type': 'application/json' },
  })
}

/** Capture the request the client made (method/url/body) for assertions. */
function mockFetch(handler: (req: Request) => Response): {
  calls: { method: string; url: string; body: string | undefined }[]
} {
  const calls: { method: string; url: string; body: string | undefined }[] = []
  // The client uses relative URLs (`/api/tokens`); under node there's no
  // document base, so resolve them against an origin before constructing a
  // Request. We only assert on the path, never the origin.
  const BASE = 'http://localhost'
  vi.stubGlobal('fetch', async (input: string | URL | Request, init?: RequestInit) => {
    const resolved = input instanceof Request ? input : new Request(new URL(String(input), BASE), init)
    const body = init?.body !== undefined ? String(init.body) : undefined
    calls.push({ method: resolved.method, url: new URL(resolved.url).pathname, body })
    return handler(resolved)
  })
  return { calls }
}

afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe('listTokens', () => {
  it('projects the inner { items, total } page into ApiTokens (non-empty)', async () => {
    // Real gateway/new-api shape: { success, data: { items, total, … } }.
    // `unwrap` lifts `data`, so `payload` IS { items, total } — reading
    // `payload.data.items` would return [] (the CRITICAL regression).
    mockFetch(() =>
      jsonRes({
        success: true,
        data: {
          items: [TOKEN_RECORD, { ...TOKEN_RECORD, id: 22, name: 'tok-b' }],
          total: 2,
          page: 1,
          page_size: 10,
        },
      }),
    )

    const result = await listTokens()
    expect(result.tokens).toHaveLength(2)
    expect(result.total).toBe(2)
    expect(result.tokens[0].id).toBe(11)
    expect(result.tokens[0].name).toBe('tok-a')
    expect(result.tokens[1].id).toBe(22)
  })

  it('returns an empty list (not a throw) when items is absent', async () => {
    mockFetch(() => jsonRes({ success: true, data: { total: 0 } }))
    const result = await listTokens()
    expect(result.tokens).toEqual([])
    expect(result.total).toBe(0)
  })

  it('falls back to items.length when total is missing', async () => {
    mockFetch(() =>
      jsonRes({ success: true, data: { items: [TOKEN_RECORD] } }),
    )
    const result = await listTokens()
    expect(result.total).toBe(1)
  })
})

describe('getToken', () => {
  it('unwraps the bare record (no second data layer)', async () => {
    // `unwrap` lifts body.data, so payload is the token record directly.
    mockFetch(() => jsonRes({ success: true, data: TOKEN_RECORD }))
    const t = await getToken(11)
    expect(t.id).toBe(11)
    expect(t.name).toBe('tok-a')
    expect(t.key).toBe('AAAA**********aaaa')
  })
})

describe('unwrap error path', () => {
  it('throws the gateway error string on a non-success envelope', async () => {
    mockFetch(() => jsonRes({ success: false, error: 'upstream error' }, { status: 502 }))
    await expect(listTokens()).rejects.toThrow('upstream error')
  })

  it('throws a generic fallback when success=false has no error field', async () => {
    mockFetch(() => jsonRes({ success: false }, { status: 502 }))
    await expect(getToken(11)).rejects.toThrow(/token request failed/)
  })

  it('throws when the response is not JSON', async () => {
    mockFetch(
      () =>
        new Response('plain text', {
          status: 502,
          headers: { 'content-type': 'text/plain' },
        }),
    )
    await expect(listTokens()).rejects.toThrow(/token request failed/)
  })
})

describe('createToken / updateToken / deleteToken', () => {
  it('POSTs the new-api payload (meta rides along) and resolves on success', async () => {
    const { calls } = mockFetch(() => jsonRes({ success: true }))
    await createToken({
      name: 'new-tok',
      group: 'prod',
      remainQuota: 5000,
      unlimitedQuota: false,
      meta: { remark: 'local', visibility: 'workspace' },
    })
    expect(calls).toHaveLength(1)
    expect(calls[0].method).toBe('POST')
    expect(calls[0].url).toBe('/api/tokens')
    const body = JSON.parse(calls[0].body!) as Record<string, unknown>
    expect(body).toMatchObject({ name: 'new-tok', group: 'prod', remain_quota: 5000, unlimited_quota: false })
    expect(body.meta).toEqual({ remark: 'local', visibility: 'workspace' })
  })

  it('PUTs to /api/tokens/:id with the payload and resolves on success', async () => {
    const { calls } = mockFetch(() => jsonRes({ success: true }))
    await updateToken(7, { name: 'renamed', status: 2 })
    expect(calls[0].method).toBe('PUT')
    expect(calls[0].url).toBe('/api/tokens/7')
    const body = JSON.parse(calls[0].body!) as Record<string, unknown>
    expect(body).toMatchObject({ name: 'renamed', status: 2 })
  })

  it('omits remain_quota when remainQuota is null (leave unchanged on edit)', async () => {
    const { calls } = mockFetch(() => jsonRes({ success: true }))
    await updateToken(7, { name: 'renamed', remainQuota: null, unlimitedQuota: false })
    const body = JSON.parse(calls[0].body!) as Record<string, unknown>
    expect(body).not.toHaveProperty('remain_quota')
    expect(body).not.toHaveProperty('unlimited_quota')
  })

  it('sends remain_quota: 0 + unlimited_quota: true when unlimited', async () => {
    const { calls } = mockFetch(() => jsonRes({ success: true }))
    await createToken({ name: 'unlim', unlimitedQuota: true, remainQuota: null })
    const body = JSON.parse(calls[0].body!) as Record<string, unknown>
    expect(body).toMatchObject({ unlimited_quota: true, remain_quota: 0 })
  })

  it('DELETEs /api/tokens/:id and resolves on success', async () => {
    const { calls } = mockFetch(() => jsonRes({ success: true }))
    await deleteToken(9)
    expect(calls[0].method).toBe('DELETE')
    expect(calls[0].url).toBe('/api/tokens/9')
  })

  it('rejects when the create envelope is a failure', async () => {
    mockFetch(() => jsonRes({ success: false, error: 'name too long' }, { status: 400 }))
    await expect(createToken({ name: 'x'.repeat(100) })).rejects.toThrow('name too long')
  })
})
