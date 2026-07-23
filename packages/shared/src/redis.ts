import { Redis } from 'ioredis'

export interface RedisClient {
  get(key: string): Promise<string | null>
  set(key: string, value: string, ttlSeconds?: number): Promise<void>
  del(key: string): Promise<void>
  lpush(key: string, value: string): Promise<void>
  brpop(key: string, timeoutSeconds: number): Promise<string | null>
  raw(): Redis
}

export function createRedis(url: string, prefix = 'mil:'): RedisClient {
  const client = new Redis(url)
  const k = (key: string) => `${prefix}${key}`
  return {
    get: (key) => client.get(k(key)),
    set: async (key, value, ttl) => {
      if (ttl) await client.set(k(key), value, 'EX', ttl)
      else await client.set(k(key), value)
    },
    del: (key) => client.del(k(key)).then(() => undefined),
    lpush: (key, value) => client.lpush(k(key), value).then(() => undefined),
    brpop: (key, timeout) => client.brpop(k(key), timeout).then((r: [string, string] | null) => r?.[1] ?? null),
    raw: () => client,
  }
}
