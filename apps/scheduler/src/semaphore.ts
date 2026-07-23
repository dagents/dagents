import type { RedisClient } from '@mil/shared'
import { createLogger } from '@mil/shared'

/**
 * Concurrency gate for the fan-out / single-run execution path (P1.7.T3).
 *
 * Flowise Iteration processes arrays serially, so the scheduler's fan-out
 * runs child predictions concurrently to recover throughput (architecture v0.2
 * §6.5). Unbounded concurrency would saturate the LLM gateway and blow cost
 * budgets (R7), so every prediction call passes through a bounded semaphore
 * before it starts. M3.1 defined this surface (Redis `mil:sem`); M3.2 reuses
 * the same interface so single-run and batch paths share one gate.
 *
 * Implementation: a Redis-backed counting semaphore keyed by `semKey`. Lua
 * scripts make acquire/release atomic — acquire INCRs the counter and rejects
 * (returns 0) when `maxConcurrent` is exceeded; release DECRs, clamped at 0 so
 * a stray double-release can't drive the counter negative and "free" a slot
 * that was never held. Using `EVALSHA` would shave a round-trip, but the gate
 * is far from hot enough for that to matter and `EVAL` keeps the script body
 * visible in any `MONITOR` trace for debugging.
 *
 * The interface is transport-shaped (`acquire()` / `release()`) rather than
 * `withSlot(async () => …)` so callers compose it with their own promise
 * plumbing (fan-out needs to start all child promises immediately, then gate
 * only the Prediction API hop inside each — see `fanout.ts`). A `withSlot`
 * helper is provided for the common run-then-release pattern.
 */
export interface AcquireResult {
  /** True when a slot was granted; false means the gate is full — retry/wait. */
  acquired: boolean
  /** Current held count after the attempt (0..maxConcurrent). Debug only. */
  count: number
}

export interface Semaphore {
  /** Try to take one slot. Non-blocking: returns immediately. */
  acquire(): Promise<AcquireResult>
  /** Release one slot. Idempotent against double-release (clamps at 0). */
  release(): Promise<void>
  /** Current held count (best-effort snapshot). */
  count(): Promise<number>
  /** Acquire a slot, run `fn`, release on settle (success or failure). */
  withSlot<T>(fn: () => Promise<T>): Promise<T>
  /** Drop the key. Test teardown. */
  reset(): Promise<void>
}

/**
 * Free slots remaining under `maxConcurrent` (`maxConcurrent - count()`).
 * `/health` reports this so an operator can see concurrency headroom without
 * doing the subtraction. Counted from the live Redis counter, so it reflects
 * slots held by *both* the worker (M3.1) and any in-flight fan-out (M3.2) —
 * the two paths share one `mil:sem` gate.
 *
 * Takes `maxConcurrent` explicitly rather than reading it off the semaphore
 * object: the `Semaphore` interface deliberately does not expose its cap (a
 * caller has no business mutating it), so the value is threaded in by the one
 * place that already knows it — `buildApp`/`index.ts`, which constructed the
 * semaphore with that cap in the first place.
 */
export async function availableSlots(
  sem: Semaphore,
  maxConcurrent: number,
): Promise<number> {
  const held = await sem.count()
  return Math.max(0, maxConcurrent - held)
}

const ACQUIRE_SCRIPT = `
local cur = tonumber(redis.call('GET', KEYS[1]) or '0')
if cur < tonumber(ARGV[1]) then
  redis.call('INCR', KEYS[1])
  return cur + 1
else
  return 0
end
`

const RELEASE_SCRIPT = `
local cur = tonumber(redis.call('GET', KEYS[1]) or '0')
if cur <= 0 then
  return 0
end
return redis.call('DECR', KEYS[1])
`

export interface RedisSemaphoreOpts {
  redis: RedisClient
  /** Max concurrent slots across the gate. */
  maxConcurrent: number
  /** Redis key under the `mil:` prefix. Defaults to `sem` → `mil:sem`. */
  semKey?: string
  /**
   * Key prefix applied to `semKey`. Must match the `createRedis` prefix so the
   * semaphore's raw `EVAL` lands on the same key the prefixed helpers
   * (`redis.get`/`redis.del`) use. Defaults to `mil:` (the `@mil/shared`
   * default). Raw `EVAL` does not apply the prefix automatically, so the
   * semaphore composes the full key itself.
   */
  prefix?: string
}

/**
 * Build a Redis-backed semaphore. `redis` is the `@mil/shared` prefixed client;
 * the full key is `${prefix}${semKey}` (default `mil:sem`) so raw `EVAL`
 * operations and the prefixed `redis.get`/`redis.del` helpers hit the same key.
 */
export function createRedisSemaphore(opts: RedisSemaphoreOpts): Semaphore {
  const { redis, maxConcurrent } = opts
  const prefix = opts.prefix ?? 'mil:'
  const key = `${prefix}${opts.semKey ?? 'sem'}`
  const log = createLogger({ svc: 'scheduler:sem' })

  const raw = redis.raw()

  const acquire = async (): Promise<AcquireResult> => {
    const res = await raw.eval(ACQUIRE_SCRIPT, 1, key, maxConcurrent)
    const n = typeof res === 'number' ? res : Number(res)
    if (n > 0) return { acquired: true, count: n }
    return { acquired: false, count: 0 }
  }

  const release = async (): Promise<void> => {
    await raw.eval(RELEASE_SCRIPT, 1, key)
  }

  return {
    acquire,
    release,
    count: async () => {
      const v = await raw.get(key)
      return v ? Number(v) : 0
    },
    withSlot: async <T>(fn: () => Promise<T>): Promise<T> => {
      // Spin-wait for a slot. Fan-out keeps concurrency bounded but starts
      // every child immediately, so several children may be waiting here at
      // once; a short backoff spreads their retries and avoids a Redis hot
      // loop. Predictions dominate the latency, so the poll interval is a
      // rounding error against a real run.
      while (true) {
        const r = await acquire()
        if (r.acquired) break
        await sleep(POLL_INTERVAL_MS)
      }
      try {
        return await fn()
      } finally {
        try {
          await release()
        } catch (err) {
          // A failed release leaks a slot, but throwing here would mask the
          // real result/error of the work we just did. Log and let the caller
          // see the original outcome; the key is short-lived (test teardown
          // or a process restart clears it).
          log.warn('semaphore release failed', { key, error: String(err) })
        }
      }
    },
    reset: async () => {
      // raw DEL on the full key (prefix + semKey) so reset clears exactly the
      // semaphore's counter, not the prefixed helpers' view of a different key.
      await raw.del(key)
    },
  }
}

const POLL_INTERVAL_MS = 10

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}
