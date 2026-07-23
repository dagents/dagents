import { describe, it, expect } from 'vitest'
import { createRedis } from '../index.js'

describe('redis', () => {
  it('createRedis 返回带前缀的客户端', () => {
    const client = createRedis('redis://localhost:6379')
    expect(client).toBeDefined()
    expect(typeof client.get).toBe('function')
    expect(typeof client.set).toBe('function')
    expect(typeof client.del).toBe('function')
    expect(typeof client.lpush).toBe('function')
    expect(typeof client.brpop).toBe('function')
    expect(typeof client.raw).toBe('function')
  })
  it('raw 暴露底层 ioredis', () => {
    const client = createRedis('redis://localhost:6379')
    expect(client.raw()).toBeDefined()
    expect(typeof client.raw().quit).toBe('function')
  })
})
