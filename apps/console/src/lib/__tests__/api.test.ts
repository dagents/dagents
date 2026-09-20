import { describe, it, expect, vi, afterEach } from 'vitest'
import { apiFetch, unwrapEnvelope, ApiError } from '@/lib/api'

/**
 * api.ts 单源的契约测试（2026-09-17 数据获取收敛）：
 *  - 错误文案格式是 load-bearing 的 —— agent-detail-view 用 `/\(404\)/`
 *    检测 not-found，fleet-stats.test 断言 /fleet stats failed/，钉住不许漂移；
 *  - ApiError 携带 HTTP status（消费方按状态码分支）；
 *  - 非 JSON 错误页（代理层 502 HTML）按信封失败处理，不炸调用方。
 */

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  })
}

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('unwrapEnvelope', () => {
  it('信封 success → 解出 data', async () => {
    const data = await unwrapEnvelope<{ items: number[] }>(jsonResponse({ success: true, data: { items: [1] } }), 'chat list')
    expect(data).toEqual({ items: [1] })
  })

  it('HTTP 非 2xx：消息含 `(status)` + body 摘要，ApiError.status 可分支', async () => {
    const err = await unwrapEnvelope(jsonResponse({ success: false, error: 'agent not found' }, 404), 'agent detail').catch((e: unknown) => e)
    expect(err).toBeInstanceOf(ApiError)
    const apiErr = err as ApiError
    expect(apiErr.status).toBe(404)
    // load-bearing：agent-detail-view 的 notFound 检测正则 /\(404\)/
    expect(apiErr.message).toMatch(/\(404\)/)
    expect(apiErr.message).toContain('agent detail failed')
    expect(apiErr.message).toContain('agent not found')
  })

  it('信封 success:false（HTTP 200）：消息携带信封 error', async () => {
    const err = await unwrapEnvelope(jsonResponse({ success: false, error: 'upstream error' }), 'fleet stats').catch((e: unknown) => e)
    expect((err as Error).message).toBe('fleet stats failed: upstream error')
  })

  it('非 2xx 信封：只取 error 字段，不再泄漏原始 JSON 转储（走查五）', async () => {
    const err = await unwrapEnvelope(jsonResponse({ success: false, error: 'mock gateway failure' }, 500), 'agents list').catch((e: unknown) => e)
    const message = (err as Error).message
    expect(message).toBe('agents list failed (500): mock gateway failure')
    expect(message).not.toContain('{"success"')
  })

  it('BFF transformError 包裹：detail 里的上游信封递归解一层', async () => {
    const bffBody = { success: false, error: 'agents list failed', status: 500, detail: '{"success":false,"error":"inner gateway reason"}' }
    const err = await unwrapEnvelope(jsonResponse(bffBody, 500), 'agents list').catch((e: unknown) => e)
    expect((err as Error).message).toBe('agents list failed (500): inner gateway reason')
  })

  it('非 JSON 的非 2xx：文本 detail 进消息（比丢掉更有诊断价值）', async () => {
    const html = new Response('<html>502 Bad Gateway</html>', { status: 502, headers: { 'content-type': 'text/html' } })
    const err = await unwrapEnvelope(html, 'skills list').catch((e: unknown) => e)
    expect((err as ApiError).status).toBe(502)
    expect((err as Error).message).toContain('(502)')
    expect((err as Error).message).toContain('502 Bad Gateway')
  })

  it('HTTP 200 但 body 非 JSON：按信封失败处理（unknown error），不抛解析异常', async () => {
    const html = new Response('not json', { status: 200, headers: { 'content-type': 'text/plain' } })
    const err = await unwrapEnvelope(html, 'skills list').catch((e: unknown) => e)
    expect((err as Error).message).toBe('skills list failed: unknown error')
  })
})

describe('apiFetch', () => {
  it('默认 no-store + 解包一步到位；init 透传（method/body/signal）', async () => {
    const fetchMock = vi.fn(async () => jsonResponse({ success: true, data: { ok: true } }))
    vi.stubGlobal('fetch', fetchMock)
    const data = await apiFetch<{ ok: boolean }>('/api/chats', { method: 'POST', body: '{}' }, 'chat list')
    expect(data).toEqual({ ok: true })
    const [path, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit]
    expect(path).toBe('/api/chats')
    expect(init.cache).toBe('no-store')
    expect(init.method).toBe('POST')
    expect(init.body).toBe('{}')
  })

  it('label 缺省用 path 自描述', async () => {
    vi.stubGlobal('fetch', async () => jsonResponse({ success: false, error: 'boom' }))
    const err = await apiFetch('/api/daemons').catch((e: unknown) => e)
    expect((err as Error).message).toBe('/api/daemons failed: boom')
  })
})
