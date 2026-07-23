/**
 * Token type model (P1.10.T8).
 *
 * The console never talks to new-api directly: every token read/write goes
 * browser → Next `/api/tokens/*` → gateway `/api/v1/tokens/*` → new-api
 * `/api/token/*` (see gateway `routes/tokens.ts`). new-api is the system of
 * record for the *key* and the quota/lifecycle, and it **masks** the key in
 * its own list/get responses (e.g. `AAAA**********aaaa`), so the raw key
 * never reaches the browser. The gateway additionally keeps a local
 * `token_meta` row per token (remark / visibility / probe status).
 *
 * `ApiToken` is the shape the console UI renders — a projection of the
 * new-api token record (id / name / group / key mask / quota / status) plus
 * the local `token_meta` fields where they exist. `quotaPoints` uses
 * new-api's own unit (1$ ≈ 500000 points; see docs/m0-newapi-setup.md §3).
 */

/** Token health as the console displays it. Mirrors `token_meta.status`. */
export type TokenHealth = 'unknown' | 'active' | 'disabled' | 'expired' | 'exhausted' | 'rate_limited' | 'error'

/** The console-visible status (the row's effective state). */
export type TokenStatus = 'active' | 'disabled' | 'expired' | 'exhausted'

/**
 * A token as the console renders it. `key` is new-api's masked form
 * (never the raw key); `id` is new-api's integer token id (the REST id the
 * gateway proxy addresses tokens by).
 */
export interface ApiToken {
  /** new-api integer token id — the REST id the gateway proxy addresses. */
  id: number
  name: string
  /** new-api-masked key, e.g. `sk-AAAA**********aaaa`. */
  key: string
  group: string
  /**
   * Quota points consumed so far (new-api unit; 1$ ≈ 500000). Mirrors
   * new-api's `used_quota`. Read-only on the console — never sent back on
   * update (new-api accrues it as calls happen).
   */
  usedQuota: number
  /**
   * Quota points remaining for this token (new-api unit; 1$ ≈ 500000).
   * Mirrors new-api's `remain_quota` — the *remaining* budget, not the
   * original grant. On update we send this back as `remain_quota`. `null`
   * when `unlimitedQuota` is true.
   *
   * NOTE: do not confuse with the design's "total" (original grant). new-api
   * only persists `used_quota` + `remain_quota`; the grant is their sum and is
   * a *derived* display value, not something we write back on edit.
   */
  remainQuota: number | null
  /** Derived original grant (used + remain); `null` when unlimited. Display-only. */
  totalQuota: number | null
  /** Unlimited quota → the bar shows ∞ and never exhausts. */
  unlimitedQuota: boolean
  /** Epoch seconds (-1 / undefined = never expires). */
  expiredTime: number | null
  /** Local-only operator note (token_meta.remark), when known. */
  remark?: string | null
  /** Console visibility (token_meta.visibility), when known. */
  visibility?: 'private' | 'workspace' | 'public'
  /** Effective console status (re-derived from new-api fields + health). */
  status: TokenStatus
  /** true when this is the workspace's default token (local editorial flag). */
  isDefault?: boolean
}

/** new-api's raw token record, as returned by its `/api/token/*` admin API. */
export interface NewapiTokenRecord {
  id: number
  name: string
  /** Masked in list/get responses; the raw key never traverses the gateway. */
  key: string
  group?: string
  status?: number
  remain_quota?: number
  used_quota?: number
  unlimited_quota?: boolean
  expired_time?: number
}

/**
 * The console's own create/edit form payload. `name` is required (new-api
 * rejects empty names); `meta.remark` / `meta.visibility` are stripped by the
 * gateway before it forwards to new-api and applied to the local `token_meta`
 * row instead (gateway `routes/tokens.ts` `metaPatchSchema`).
 */
export interface TokenFormInput {
  name: string
  group?: string
  /**
   * Quota points *remaining* for the token (new-api unit; 1$ ≈ 500000).
   * Maps 1:1 to new-api's `remain_quota` — the live budget left, not the
   * original grant. Omit/null + `unlimitedQuota` false = leave unchanged on
   * edit (no `remain_quota` sent); `unlimitedQuota` true = unlimited.
   */
  remainQuota?: number | null
  unlimitedQuota?: boolean
  /** Epoch seconds (-1 = never). */
  expiredTime?: number | null
  /**
   * Comma-separated model allowlist; empty = all models. Omit/null on edit
   * to leave the existing allowlist untouched (no `models` key sent, so
   * new-api keeps the prior value).
   */
  models?: string | null
  /**
   * new-api token status to set on update (1=enabled, 2=disabled). Omit on
   * create/edit-name flows to leave status untouched; set explicitly by the
   * enable/disable toggle.
   */
  status?: 1 | 2
  /** Local-only editorial fields (gateway splits these out before forwarding). */
  meta?: {
    remark?: string
    visibility?: 'private' | 'workspace' | 'public'
  }
}

/** Derive the console status from a new-api record's raw fields. */
export function deriveTokenStatus(t: {
  status?: number
  remain_quota?: number
  used_quota?: number
  unlimited_quota?: boolean
  expired_time?: number
}): TokenStatus {
  const nowSec = Math.floor(Date.now() / 1000)
  if (t.expired_time && t.expired_time !== -1 && t.expired_time < nowSec) return 'expired'
  if (!t.unlimited_quota && (t.remain_quota ?? 0) <= 0) return 'exhausted'
  // new-api status: 1=enabled, 2=disabled, 3=expired, 4=exhausted. In practice
  // the two early-returns above already catch expired/exhausted (new-api flips
  // status lazily, so we re-derive from expired_time / remain_quota instead of
  // trusting it) — these branches only fire when new-api set status 3/4 but
  // neither derived condition holds yet (defensive; mirrors the gateway's
  // `mapNewapiTokenStatus`).
  switch (t.status) {
    case 2:
      return 'disabled'
    case 3:
      return 'expired'
    case 4:
      return 'exhausted'
    default:
      return 'active'
  }
}

/**
 * Project a raw new-api token record (gateway passthrough) into the
 * console's `ApiToken` view. Keeps the projection in one place so the list,
 * detail, and table renderers all agree on field mapping + status derivation.
 */
export function toApiToken(raw: NewapiTokenRecord, meta?: { remark?: string | null; visibility?: string; isDefault?: boolean }): ApiToken {
  const unlimited = raw.unlimited_quota === true
  const used = raw.used_quota ?? 0
  const remain = raw.remain_quota ?? 0
  // new-api stores `used_quota` + `remain_quota` separately; the original
  // grant (the design's `total`) is their sum. For unlimited tokens there is
  // no grant. `remainQuota` is what we send back on edit — the *remaining*
  // budget, never the grant.
  const total = unlimited ? null : used + remain
  return {
    id: raw.id,
    name: raw.name,
    key: raw.key,
    group: raw.group ?? 'default',
    usedQuota: used,
    remainQuota: unlimited ? null : remain,
    totalQuota: total,
    unlimitedQuota: unlimited,
    expiredTime: raw.expired_time && raw.expired_time !== -1 ? raw.expired_time : null,
    remark: meta?.remark,
    visibility: (meta?.visibility as ApiToken['visibility']) ?? undefined,
    status: deriveTokenStatus(raw),
    isDefault: meta?.isDefault,
  }
}
