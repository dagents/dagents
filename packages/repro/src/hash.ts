import { createHash } from 'node:crypto'

/**
 * Content-addressing helpers for repro (plan M4.1 / spec §1.8).
 *
 * A pipeline version is locked by the SHA-256 of its flow JSON, and an artifact
 * is stored under a content-addressed key. Both need a *stable* serialization:
 * Flowise may return the same flow with differently-ordered object keys across
 * reads (DB row round-trips, driver serialization), so a naive `JSON.stringify`
 * would hash two identical flows differently and break the "同 flow 二次快照复用
 * hash" acceptance. `canonicalize` sorts object keys recursively (arrays stay
 * order-sensitive — `[1,2]` ≠ `[2,1]` is correct), and `sha256Hex` is the hex
 * digest of the canonical string.
 */

/**
 * Return a deep copy of `value` with every plain-object's keys sorted
 * recursively. Arrays preserve order (they're semantically ordered). Non-plain
 * values (Date, Buffer, …) are passed through by reference — callers hashing
 * flow JSON / artifacts only ever deal with JSON-serializable structures.
 */
export function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize)
  if (value !== null && typeof value === 'object') {
    const obj = value as Record<string, unknown>
    const out: Record<string, unknown> = {}
    for (const key of Object.keys(obj).sort()) {
      out[key] = canonicalize(obj[key])
    }
    return out
  }
  return value
}

/**
 * Stable JSON string: `JSON.stringify(canonicalize(value))`. Two values that
 * differ only by object key order produce the same string, so their SHA-256
 * matches. Used as the hash preimage for flow snapshots and artifact keys.
 */
export function stableStringify(value: unknown): string {
  return JSON.stringify(canonicalize(value))
}

/** SHA-256 hex digest of `stableStringify(value)`. 64 lowercase hex chars. */
export function sha256Hex(value: unknown): string {
  return createHash('sha256').update(stableStringify(value), 'utf8').digest('hex')
}

/** SHA-256 hex digest of raw bytes (artifact content). */
export function sha256Bytes(data: Uint8Array | string): string {
  return createHash('sha256').update(data).digest('hex')
}
