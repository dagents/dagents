import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { HttpNode } from './http.node.js'
import type { INodeData, IExecutionContext } from '../../types/index.js'
import { NodeRejectedError } from '../../engine/errors.js'

function makeNodeData(overrides: Record<string, unknown> = {}): INodeData {
  return {
    id: 'n1',
    name: 'httpAgentflow',
    inputs: {
      method: 'GET',
      url: 'https://api.example.com/test',
      ...overrides,
    },
  }
}

function makeContext(): IExecutionContext {
  return { chatId: 'c1', runId: 'r1', state: {}, isLastNode: false }
}

describe('HttpNode', () => {
  beforeEach(() => {
    vi.stubGlobal('fetch', vi.fn())
  })
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('makes a GET request and returns parsed JSON', async () => {
    const fakeResponse = {
      ok: true,
      status: 200,
      headers: { get: () => 'application/json' },
      text: async () => JSON.stringify({ result: 'success' }),
    }
    vi.mocked(fetch).mockResolvedValue(fakeResponse as any)

    const node = new HttpNode()
    const result = await node.run(makeNodeData(), '', makeContext())
    expect(fetch).toHaveBeenCalledWith(
      'https://api.example.com/test',
      expect.objectContaining({ method: 'GET' }),
    )
    expect(result.output).toEqual({ result: 'success' })
  })

  it('makes a POST request with JSON body', async () => {
    const fakeResponse = {
      ok: true,
      status: 201,
      headers: { get: () => 'application/json' },
      text: async () => JSON.stringify({ id: 1 }),
    }
    vi.mocked(fetch).mockResolvedValue(fakeResponse as any)

    const node = new HttpNode()
    await node.run(
      makeNodeData({
        method: 'POST',
        body: '{"name":"test"}',
        bodyType: 'json',
        headers: '{"Content-Type":"application/json"}',
      }),
      '',
      makeContext(),
    )
    expect(fetch).toHaveBeenCalledWith(
      'https://api.example.com/test',
      expect.objectContaining({
        method: 'POST',
        body: '{"name":"test"}',
        headers: { 'Content-Type': 'application/json' },
      }),
    )
  })

  it('throws on non-ok response', async () => {
    const fakeResponse = {
      ok: false,
      status: 500,
      statusText: 'Server Error',
      text: async () => 'boom',
    }
    vi.mocked(fetch).mockResolvedValue(fakeResponse as any)

    const node = new HttpNode()
    await expect(node.run(makeNodeData(), '', makeContext())).rejects.toThrow(/500/)
  })

  it('parses headers JSON string', async () => {
    const fakeResponse = {
      ok: true,
      status: 200,
      headers: { get: () => 'application/json' },
      text: async () => JSON.stringify({}),
    }
    vi.mocked(fetch).mockResolvedValue(fakeResponse as any)

    const node = new HttpNode()
    await node.run(
      makeNodeData({ headers: '{"Authorization":"Bearer token123"}' }),
      '',
      makeContext(),
    )
    expect(fetch).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({
        headers: { Authorization: 'Bearer token123' },
      }),
    )
  })

  it('returns text response when content-type is not JSON', async () => {
    const fakeResponse = {
      ok: true,
      status: 200,
      headers: { get: () => 'text/plain' },
      text: async () => 'plain text response',
    }
    vi.mocked(fetch).mockResolvedValue(fakeResponse as any)

    const node = new HttpNode()
    const result = await node.run(makeNodeData(), '', makeContext())
    expect(result.output).toEqual({ content: 'plain text response' })
  })

  it('rejects non-http(s) schemes (SSRF guard)', async () => {
    const node = new HttpNode()
    await expect(
      node.run(makeNodeData({ url: 'file:///etc/passwd' }), '', makeContext()),
    ).rejects.toThrow(/only allows http\(s\)/)
    await expect(node.run(makeNodeData({ url: 'not-a-url' }), '', makeContext())).rejects.toThrow(
      /not absolute/,
    )
    expect(fetch).not.toHaveBeenCalled()
  })

  it('truncates oversized response bodies', async () => {
    const huge = 'x'.repeat(64 * 1024)
    const fakeResponse = {
      ok: true,
      status: 200,
      headers: { get: () => 'text/plain' },
      text: async () => huge,
    }
    vi.mocked(fetch).mockResolvedValue(fakeResponse as any)

    const node = new HttpNode()
    const result = await node.run(makeNodeData(), '', makeContext())
    // 保尾截断（2026-10-04 P1a）：头 60% + 对账标记 + 尾 40%——判决在末尾
    const out = result.output.content as string
    expect(result.output.truncated).toBe(true)
    expect(out).toContain('响应截断')
    expect(out.length).toBeGreaterThan(32 * 1024 * 0.9) // 头尾都在
    expect(out.length).toBeLessThan(huge.length)
  })

  it('accepts headers as an object (canvas defaultData shape)', async () => {
    const fakeResponse = {
      ok: true,
      status: 200,
      headers: { get: () => 'application/json' },
      text: async () => JSON.stringify({ ok: 1 }),
    }
    vi.mocked(fetch).mockResolvedValue(fakeResponse as any)

    const node = new HttpNode()
    await node.run(makeNodeData({ headers: { Authorization: 'Bearer t' } }), '', makeContext())
    expect(fetch).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ headers: { Authorization: 'Bearer t' } }),
    )
  })

  it('has correct static metadata', () => {
    const node = new HttpNode()
    expect(node.name).toBe('httpAgentflow')
    expect(node.type).toBe('HTTP')
    expect(node.inputs.length).toBeGreaterThan(0)
  })

  // ── R4 域名守卫（2026-10-07，AC-R4-1）─────────────────────────────────
  // declared-but-violated 在任何策略下都拒绝——用例不依赖策略 env 配置。

  it('declared allowedDomains + 请求域名 ∉ 清单 → 拒绝（错误含节点 id + 未声明域名 + 已声明清单）', async () => {
    const node = new HttpNode()
    const invocation = node.run(
      makeNodeData({ url: 'https://api.gitlab.com/x', allowedDomains: ['api.github.com'] }),
      '',
      makeContext(),
    )
    // 集成裁决钉子（2026-10-08，R9d 对照表「节点拒绝」档）：白名单拒绝 =
    // NodeRejectedError + 文案首词「节点被拒绝：」——executor 管道据此落
    // span 'rejected' + isolated → run partial_success（勿回退 Error/failed）。
    await expect(invocation).rejects.toThrow(
      /n1.*api\.gitlab\.com 未在 allowedDomains 声明（已声明：api\.github\.com）/,
    )
    await expect(invocation).rejects.toBeInstanceOf(NodeRejectedError)
    await expect(invocation).rejects.toThrow(/^节点被拒绝：/)
    expect(fetch).not.toHaveBeenCalled()
  })

  it('重定向 302 跳未声明域名 → 同样拒绝（逐跳复检）', async () => {
    const redirectResponse = {
      ok: false,
      status: 302,
      headers: { get: (k: string) => (k === 'location' ? 'https://other.test/y' : null) },
      text: async () => '',
    }
    vi.mocked(fetch).mockResolvedValue(redirectResponse as any)
    const node = new HttpNode()
    await expect(
      node.run(
        makeNodeData({ url: 'https://api.github.com/x', allowedDomains: ['api.github.com'] }),
        '',
        makeContext(),
      ),
    ).rejects.toThrow(/other\.test 未在 allowedDomains 声明/)
  })

  it('declared-empty [] → 拒绝（显式空集 = 全拒）', async () => {
    const node = new HttpNode()
    await expect(
      node.run(
        makeNodeData({ url: 'https://api.github.com/x', allowedDomains: [] }),
        '',
        makeContext(),
      ),
    ).rejects.toThrow(/未在 allowedDomains 声明（已声明：）/)
  })

  it('invalid 声明 → deny-all（合法域名也拒，与策略无关）', async () => {
    const node = new HttpNode()
    await expect(
      node.run(
        makeNodeData({ url: 'https://api.github.com/x', allowedDomains: 'not-an-array' }),
        '',
        makeContext(),
      ),
    ).rejects.toThrow(/allowedDomains 声明非法/)
    expect(fetch).not.toHaveBeenCalled()
  })

  it('enforce 策略 + 缺席 → 拒绝并带「如何声明」指引', async () => {
    const prev = process.env.DAGENTS_HTTP_DOMAIN_POLICY
    process.env.DAGENTS_HTTP_DOMAIN_POLICY = 'enforce'
    try {
      const node = new HttpNode()
      await expect(node.run(makeNodeData(), '', makeContext())).rejects.toThrow(
        /未声明 allowedDomains（网关已启用 enforce 策略）.*\["api\.github\.com"\]/s,
      )
      expect(fetch).not.toHaveBeenCalled()
    } finally {
      if (prev === undefined) delete process.env.DAGENTS_HTTP_DOMAIN_POLICY
      else process.env.DAGENTS_HTTP_DOMAIN_POLICY = prev
    }
  })

  it('warn（默认）+ 缺席 → 放行且 onNodeDelta 收到留痕活动行', async () => {
    const prev = process.env.DAGENTS_HTTP_DOMAIN_POLICY
    delete process.env.DAGENTS_HTTP_DOMAIN_POLICY
    try {
      const fakeResponse = {
        ok: true,
        status: 200,
        headers: { get: () => 'application/json' },
        text: async () => JSON.stringify({ ok: 1 }),
      }
      vi.mocked(fetch).mockResolvedValue(fakeResponse as any)
      const ctx = makeContext()
      const deltas: unknown[] = []
      ctx.onNodeDelta = (chunk) => deltas.push(chunk)
      const node = new HttpNode()
      const result = await node.run(makeNodeData(), '', ctx)
      expect(result.output).toEqual({ ok: 1 })
      expect(fetch).toHaveBeenCalled()
      expect(deltas).toEqual([
        { type: 'activity', kind: 'log', label: '域名清单未声明（过渡期放行）: api.example.com' },
      ])
    } finally {
      if (prev !== undefined) process.env.DAGENTS_HTTP_DOMAIN_POLICY = prev
    }
  })

  it('off 策略 → 跳过域名守卫（declared-but-violated 也放行；SSRF 仍生效）', async () => {
    const prev = process.env.DAGENTS_HTTP_DOMAIN_POLICY
    process.env.DAGENTS_HTTP_DOMAIN_POLICY = 'off'
    try {
      const fakeResponse = {
        ok: true,
        status: 200,
        headers: { get: () => 'text/plain' },
        text: async () => 'fine',
      }
      vi.mocked(fetch).mockResolvedValue(fakeResponse as any)
      const node = new HttpNode()
      const result = await node.run(
        makeNodeData({ url: 'https://api.example.com/test', allowedDomains: ['other.test'] }),
        '',
        makeContext(),
      )
      expect(result.output).toEqual({ content: 'fine' })
      // SSRF 不受 off 影响
      await expect(
        node.run(
          makeNodeData({ url: 'http://10.0.0.5/x', allowedDomains: ['other.test'] }),
          '',
          makeContext(),
        ),
      ).rejects.toThrow(/SSRF|private/)
    } finally {
      if (prev === undefined) delete process.env.DAGENTS_HTTP_DOMAIN_POLICY
      else process.env.DAGENTS_HTTP_DOMAIN_POLICY = prev
    }
  })
})
