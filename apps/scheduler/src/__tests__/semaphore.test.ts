import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest'
import { createRedis } from '@dagents/shared'
import { createRedisSemaphore } from '../semaphore.js'

/**
 * Concurrency-gate integration test (P1.7.T3).
 *
 * Drives the real Redis (docker-compose 127.0.0.1:16479). Verifies the
 * semaphore's core contract: it grants up to `maxConcurrent` slots
 * concurrently and rejects beyond that, releases reopen slots, and `withSlot`
 * bounds concurrent execution to `maxConcurrent` even when N>max tasks start
 * at once. This is the gate M3.2's fan-out reuses.
 *
 * The default URL bakes in the dev Redis password: the dagents compose
 * stack starts Redis with `--requirepass dagents_dev` (see infra/.env.example
 * REDIS_PASSWORD), so a bare `redis://localhost:16479` hits `NOAUTH` and every
 * test skips — a green run would silently depend on an undocumented exported
 * REDIS_URL. Mirrors how `@dagents/db` bakes the dev PG creds into its default
 * POSTGRES_URL. Override via REDIS_URL for a non-dev stack.
 */
const redisUrl =
  process.env.REDIS_URL ?? 'redis://localhost:16479'
const redis = createRedis(redisUrl)

beforeAll(async () => {
  // sanity: the client is connected (raw() resolves the ioredis instance)
  await redis.raw().ping()
})

afterAll(async () => {
  await redis.raw().quit()
})

beforeEach(async () => {
  // `redis.del` applies the `dagents:` prefix → clears `dagents:sem`, the semaphore's
  // default key. Raw EVAL inside the semaphore composes the same prefix, so
  // this and the semaphore see one key.
  await redis.del('sem')
})

describe('RedisSemaphore acquire/release', () => {
  it('grants up to maxConcurrent slots then rejects', async () => {
    const sem = createRedisSemaphore({ redis, maxConcurrent: 2 })

    const a = await sem.acquire()
    const b = await sem.acquire()
    const c = await sem.acquire()

    expect(a.acquired).toBe(true)
    expect(b.acquired).toBe(true)
    expect(c.acquired).toBe(false) // gate full
    expect(await sem.count()).toBe(2)
  })

  it('release reopens a slot', async () => {
    const sem = createRedisSemaphore({ redis, maxConcurrent: 1 })

    expect((await sem.acquire()).acquired).toBe(true)
    expect((await sem.acquire()).acquired).toBe(false) // full
    await sem.release()
    expect((await sem.acquire()).acquired).toBe(true) // reopened
  })

  it('release clamps at 0 (double-release does not free a phantom slot)', async () => {
    const sem = createRedisSemaphore({ redis, maxConcurrent: 2 })

    await sem.release() // noop from zero
    await sem.release() // noop from zero
    expect(await sem.count()).toBe(0)

    // both slots still grantable — the stray releases didn't invent capacity
    expect((await sem.acquire()).acquired).toBe(true)
    expect((await sem.acquire()).acquired).toBe(true)
    expect((await sem.acquire()).acquired).toBe(false)
  })

  it('reset drops the counter', async () => {
    const sem = createRedisSemaphore({ redis, maxConcurrent: 3 })
    await sem.acquire()
    await sem.acquire()
    expect(await sem.count()).toBe(2)
    await sem.reset()
    expect(await sem.count()).toBe(0)
  })
})

describe('RedisSemaphore withSlot', () => {
  it('bounds concurrent execution to maxConcurrent', async () => {
    const sem = createRedisSemaphore({ redis, maxConcurrent: 2 })

    let active = 0
    let peak = 0
    const task = async (): Promise<void> => {
      await sem.withSlot(async () => {
        active += 1
        peak = Math.max(peak, active)
        await sleep(20)
        active -= 1
      })
    }

    // 5 tasks, gate of 2 → peak concurrency must never exceed 2
    await Promise.all(Array.from({ length: 5 }, () => task()))
    expect(peak).toBeLessThanOrEqual(2)
    expect(await sem.count()).toBe(0) // all released
  })

  it('releases the slot even when the task throws', async () => {
    const sem = createRedisSemaphore({ redis, maxConcurrent: 1 })

    await expect(
      sem.withSlot(async () => {
        throw new Error('boom')
      }),
    ).rejects.toThrow('boom')

    // slot was released despite the throw → next acquire succeeds
    expect((await sem.acquire()).acquired).toBe(true)
  })
})

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}
