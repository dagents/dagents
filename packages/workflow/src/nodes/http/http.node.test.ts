import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { HttpNode } from './http.node.js'
import type { INodeData, IExecutionContext } from '../../types/index.js'

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
      json: async () => ({ result: 'success' }),
    }
    vi.mocked(fetch).mockResolvedValue(fakeResponse as any)

    const node = new HttpNode()
    const result = await node.run(makeNodeData(), '', makeContext())
    expect(fetch).toHaveBeenCalledWith('https://api.example.com/test', expect.objectContaining({ method: 'GET' }))
    expect(result.output).toEqual({ result: 'success' })
  })

  it('makes a POST request with JSON body', async () => {
    const fakeResponse = {
      ok: true,
      status: 201,
      headers: { get: () => 'application/json' },
      json: async () => ({ id: 1 }),
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
    const fakeResponse = { ok: false, status: 500, statusText: 'Server Error', text: async () => 'boom' }
    vi.mocked(fetch).mockResolvedValue(fakeResponse as any)

    const node = new HttpNode()
    await expect(node.run(makeNodeData(), '', makeContext())).rejects.toThrow(/500/)
  })

  it('parses headers JSON string', async () => {
    const fakeResponse = {
      ok: true,
      status: 200,
      headers: { get: () => 'application/json' },
      json: async () => ({}),
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

  it('has correct static metadata', () => {
    const node = new HttpNode()
    expect(node.name).toBe('httpAgentflow')
    expect(node.type).toBe('HTTP')
    expect(node.inputs.length).toBeGreaterThan(0)
  })
})
