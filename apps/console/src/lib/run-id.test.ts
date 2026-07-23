import { describe, it, expect } from 'vitest'
import { resolveRunId, MAX_RUN_ID_LEN } from './run-id'

/**
 * Unit tests for the server-side run_id resolver (plan M5b.4 / P1.10.T10).
 *
 * The acceptance bar is "所有请求带 run_id": every proxy hop must carry an
 * `x-run-id`, generated if absent. These pin the rule the proxy routes rely on
 * — a caller id is forwarded when well-formed, else a fresh UUID is minted —
 * without spinning up a gateway stub (the route tests cover the wiring).
 */
describe('resolveRunId', () => {
  it('returns a well-formed caller run id verbatim', () => {
    expect(resolveRunId('run-abc-123')).toBe('run-abc-123')
  })

  it('trims whitespace before validating', () => {
    expect(resolveRunId('  run-abc-123  ')).toBe('run-abc-123')
  })

  it('generates a UUID when the caller id is absent', () => {
    const id = resolveRunId(undefined)
    // UUID v4 shape — the gateway generates the same kind for the flows proxy.
    expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/)
    expect(id).not.toBe('')
  })

  it('generates a UUID when the caller id is an empty string', () => {
    expect(resolveRunId('')).toMatch(/^[0-9a-f-]{36}$/)
  })

  it('generates a UUID when the caller id is only whitespace', () => {
    expect(resolveRunId('   ')).toMatch(/^[0-9a-f-]{36}$/)
  })

  it('generates a UUID when the caller id exceeds MAX_RUN_ID_LEN', () => {
    const tooLong = 'x'.repeat(MAX_RUN_ID_LEN + 1)
    const id = resolveRunId(tooLong)
    expect(id).toMatch(/^[0-9a-f-]{36}$/)
    expect(id).not.toBe(tooLong)
  })

  it('accepts a caller id exactly MAX_RUN_ID_LEN long', () => {
    const exact = 'x'.repeat(MAX_RUN_ID_LEN)
    expect(resolveRunId(exact)).toBe(exact)
  })

  it('generates a fresh UUID on each call (not cached)', () => {
    const a = resolveRunId(undefined)
    const b = resolveRunId(undefined)
    expect(a).not.toBe(b)
  })
})
