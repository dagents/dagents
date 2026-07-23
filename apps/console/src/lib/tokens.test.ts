import { describe, it, expect } from 'vitest'
import { deriveTokenStatus, toApiToken } from './tokens'

/**
 * Unit tests for the token projection helpers (P1.10.T8).
 *
 * `toApiToken` / `deriveTokenStatus` are pure functions that map a raw
 * new-api token record into the console's `ApiToken` view. Pinning them keeps
 * the list / detail / table renderers in agreement on field mapping + status
 * derivation (mirrors the gateway's `mapNewapiTokenStatus`, which has its own
 * tests in apps/gateway).
 */

const baseRaw = {
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

describe('deriveTokenStatus', () => {
  it('maps enabled + remaining quota → active', () => {
    expect(deriveTokenStatus(baseRaw)).toBe('active')
  })

  it('re-derives expired from expired_time even when status=1', () => {
    const past = Math.floor(Date.now() / 1000) - 10
    expect(deriveTokenStatus({ ...baseRaw, expired_time: past })).toBe('expired')
  })

  it('re-derives exhausted from remain_quota=0 even when status=1', () => {
    expect(deriveTokenStatus({ ...baseRaw, remain_quota: 0 })).toBe('exhausted')
  })

  it('unlimited quota is never exhausted', () => {
    expect(deriveTokenStatus({ ...baseRaw, remain_quota: 0, unlimited_quota: true })).toBe('active')
  })

  it('maps new-api status=2 → disabled', () => {
    expect(deriveTokenStatus({ ...baseRaw, status: 2 })).toBe('disabled')
  })

  it('treats expired_time=-1 as never-expiring', () => {
    expect(deriveTokenStatus({ ...baseRaw, expired_time: -1 })).toBe('active')
  })
})

describe('toApiToken', () => {
  it('projects the raw record into the console view', () => {
    const t = toApiToken(baseRaw)
    expect(t).toMatchObject({
      id: 11,
      name: 'tok-a',
      key: 'AAAA**********aaaa',
      group: 'default',
      usedQuota: 200,
      remainQuota: 1000,
      unlimitedQuota: false,
      status: 'active',
    })
    // total = used(200) + remain(1000) — the derived original grant.
    expect(t.totalQuota).toBe(1200)
    expect(t.expiredTime).toBeNull()
  })

  it('unlimited quota → totalQuota null + remainQuota null', () => {
    const t = toApiToken({ ...baseRaw, unlimited_quota: true, remain_quota: 0 })
    expect(t.totalQuota).toBeNull()
    expect(t.remainQuota).toBeNull()
    expect(t.unlimitedQuota).toBe(true)
  })

  it('keeps the masked key verbatim (never unmasks)', () => {
    const t = toApiToken({ ...baseRaw, key: 'CCCC****cccc' })
    expect(t.key).toBe('CCCC****cccc')
  })

  it('derives totalQuota from used + remain for limited tokens', () => {
    // new-api stores used_quota + remain_quota separately; the grant (total) is
    // their sum. `remainQuota` mirrors new-api's remain_quota exactly — it's
    // what we send back on edit, NOT the grant.
    const t = toApiToken({ ...baseRaw, remain_quota: 5000, used_quota: 1000 })
    expect(t.totalQuota).toBe(6000)
    expect(t.usedQuota).toBe(1000)
    expect(t.remainQuota).toBe(5000)
  })

  it('folds local meta fields when provided', () => {
    const t = toApiToken(baseRaw, { remark: 'prod key', visibility: 'private', isDefault: true })
    expect(t.remark).toBe('prod key')
    expect(t.visibility).toBe('private')
    expect(t.isDefault).toBe(true)
  })

  it('defaults group to "default" when absent', () => {
    const t = toApiToken({ ...baseRaw, group: undefined })
    expect(t.group).toBe('default')
  })
})
