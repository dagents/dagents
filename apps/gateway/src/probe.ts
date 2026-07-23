import { runQuery } from '@mil/db'
import {
  newapiAdminConfigured,
  newapiBaseUrl,
  newapiLog as log,
  probeTokenHealth,
} from './newapi.js'

/**
 * Health probe worker (plan M2.8 / P1.4.T8).
 *
 * Periodically polls every `token_meta` row's new-api token and writes the
 * derived health to `token_meta.status` + `last_probed_at`. new-api is the
 * source of truth for token status, but it flips `status` lazily (only when a
 * request trips expiry/exhaustion); the probe re-derives it from
 * `expired_time` / `remain_quota` so the console shows reality without a user
 * request having to fail first.
 *
 * Lifecycle: `startProbeWorker()` schedules the interval and returns a handle
 * with `stop()`. `index.ts` starts it at bootstrap and stops it on SIGTERM so
 * the process exits cleanly. The first run fires immediately so a fresh
 * gateway doesn't sit at `unknown` until the interval elapses.
 *
 * The worker is a no-op when `NEWAPI_ADMIN_KEY` isn't configured (dev without
 * new-api) — it logs once and never schedules, so tests/dev don't need a stub.
 */

export interface ProbeWorker {
  stop(): void
}

// Floor the interval so a misconfigured `TOKEN_PROBE_INTERVAL_MS` (0, negative,
// or a non-numeric string → NaN) can't turn the probe into a tight loop that
// hammers new-api's admin API. `||` keeps the default when the env is absent.
const DEFAULT_INTERVAL_MS = Math.max(5_000, Number(process.env.TOKEN_PROBE_INTERVAL_MS) || 60_000)

/**
 * One probe sweep: load all `newapi_token_id`s, probe each, write the result.
 * Runs sequentially to avoid hammering new-api's admin API; token counts are
 * small (console-managed, not per-user). Errors on individual tokens don't
 * abort the sweep.
 */
export async function runProbeSweep(): Promise<{ probed: number; ok: number; failed: number }> {
  const { records } = await runQuery<{ newapi_token_id: string }>(
    `SELECT newapi_token_id FROM token_meta ORDER BY newapi_token_id`,
  )
  let ok = 0
  let failed = 0
  for (const row of records) {
    const id = Number(row.newapi_token_id)
    if (!Number.isSafeInteger(id) || id <= 0) continue
    const result = await probeTokenHealth(id)
    const status = result.status
    try {
      await runQuery(
        `UPDATE token_meta SET status = $1, last_probed_at = NOW(), updated_at = NOW() WHERE newapi_token_id = $2`,
        [status, id],
      )
      ok += 1
    } catch (err) {
      failed += 1
      log.warn('probe write failed', { id, status, error: String(err) })
    }
  }
  return { probed: records.length, ok, failed }
}

/**
 * Start the probe interval. Returns a handle whose `stop()` clears the timer.
 * No-op (returns a stopped handle) when the admin key isn't configured, so a
 * gateway running without new-api wired up doesn't spam errors.
 */
export function startProbeWorker(intervalMs: number = DEFAULT_INTERVAL_MS): ProbeWorker {
  if (!newapiAdminConfigured()) {
    log.info('probe worker idle — NEWAPI_ADMIN_KEY not set', { baseUrl: newapiBaseUrl() })
    return { stop: () => {} }
  }
  // Fire immediately so a fresh gateway reflects real token health without
  // waiting for the first interval tick.
  void runProbeSweep().then((r) => log.info('probe sweep done', r)).catch((err) =>
    log.error('probe sweep crashed', { error: String(err) }),
  )
  const handle = setInterval(() => {
    void runProbeSweep().then((r) => log.info('probe sweep done', r)).catch((err) =>
      log.error('probe sweep crashed', { error: String(err) }),
    )
  }, intervalMs)
  // Don't keep the event loop alive solely for the probe — index.ts owns the
  // server that keeps it alive; on SIGTERM the server stops and this unref'd
  // timer won't block exit.
  if (typeof handle.unref === 'function') handle.unref()
  return {
    stop: () => clearInterval(handle),
  }
}
