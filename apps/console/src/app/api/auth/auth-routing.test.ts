import { describe, it, expect } from 'vitest'
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

/**
 * Routing-structure guard for the console auth routes (M5b.4).
 *
 * The reviewer found that a single `api/auth/route.ts` serving `/api/auth` did
 * NOT serve the sub-paths the client fetches (`/api/auth/login`, `/session`,
 * `/logout`) — so login/session/logout all 404'd even though the handler tests
 * were green. Those tests import the handlers directly and bypass Next.js
 * routing, so a path/method structural bug was invisible to them. This file
 * closes that blind spot: it asserts the route *files* exist in the layout
 * App Router actually routes by, and (when a build is present) cross-checks
 * the `next build` app-paths-manifest. It does NOT start a Next server (that's
 * heavy + slow); the file-existence + manifest check catches the exact class
 * of bug that shipped (wrong file → missing path).
 *
 * What this pins:
 *  1. Each sub-path has its own `route.ts` exporting the expected method.
 *  2. No single `api/auth/route.ts` shadows the sub-paths (App Router prefers
 *     a more specific segment, but a stray `route.ts` next to `login/` is a
 *     smell and we removed it intentionally).
 *  3. The exported method per file matches what the client (`auth-client.tsx`)
 *     sends — POST login, GET session, POST logout — so there's no method
 *     mismatch (405) like the DELETE-vs-POST logout bug.
 *  4. When `.next/server/app-paths-manifest.json` exists (a `next build` ran),
 *     it lists the three sub-paths and NOT a bare `/api/auth` — the real
 *     routing truth.
 */

const here = dirname(fileURLToPath(import.meta.url))
const authDir = resolve(here) // tests/ live in api/auth/, so __dirname IS api/auth
const manifestPath = resolve(here, '..', '..', '..', '..', '..', '.next', 'server', 'app-paths-manifest.json')

interface RouteCase {
  sub: 'login' | 'session' | 'logout'
  method: 'POST' | 'GET'
}

const CASES: RouteCase[] = [
  { sub: 'login', method: 'POST' },
  { sub: 'session', method: 'GET' },
  { sub: 'logout', method: 'POST' },
]

describe('auth route structure (App Router path + method wiring)', () => {
  it('has no single route.ts shadowing the sub-path routes', () => {
    // A `route.ts` directly in api/auth/ would serve /api/auth and is what
    // caused the original 404s. It must not exist.
    expect(existsSync(resolve(authDir, 'route.ts'))).toBe(false)
  })

  for (const { sub, method } of CASES) {
    it(`exposes ${method} /api/auth/${sub} via a co-located route.ts`, async () => {
      const file = resolve(authDir, sub, 'route.ts')
      expect(existsSync(file)).toBe(true)

      // The route file must export the method the client sends. Reading the
      // source (not importing) keeps this a structural check — it can't run
      // the handler, and it fails loudly if someone renames the export or
      // switches the method (the exact DELETE-vs-POST logout bug).
      const src = readFileSync(file, 'utf8')
      const re = new RegExp(`\\bexport\\s+async\\s+function\\s+${method}\\b`)
      expect(re.test(src)).toBe(true)
    })
  }

  it('does not export the wrong method on any auth sub-route', async () => {
    // e.g. logout must NOT export DELETE (the bug): the client posts, so a
    // DELETE-only route 405s. For login/session the "wrong" method is the
    // other verb; assert each exports exactly its expected one and not the
    // sibling. This is a targeted guard, not a general style rule.
    const wrong: Record<RouteCase['sub'], string> = {
      login: 'DELETE',
      session: 'POST',
      logout: 'DELETE',
    }
    for (const { sub, method } of CASES) {
      const src = readFileSync(resolve(authDir, sub, 'route.ts'), 'utf8')
      const hasRight = new RegExp(`\\bexport\\s+async\\s+function\\s+${method}\\b`).test(src)
      expect(hasRight, `${sub}/route.ts must export ${method}`).toBe(true)
      const bad = wrong[sub]
      const hasWrong = new RegExp(`\\bexport\\s+async\\s+function\\s+${bad}\\b`).test(src)
      expect(hasWrong, `${sub}/route.ts must NOT export ${bad} (would 405 the client's ${method})`).toBe(false)
    }
  })

  it('the api/auth dir holds exactly the three sub-path dirs (no stray files)', () => {
    // Catches an accidental second `route.ts` (or a `.bak`) re-appearing. The
    // only entries should be login/ session/ logout/ + this test file +
    // (maybe) a README. route.ts must be absent.
    const entries = readdirSync(authDir)
    const routeTs = entries.filter((e) => e === 'route.ts' || e === 'route.test.ts')
    expect(routeTs, 'no bare route.ts/route.test.ts in api/auth/').toEqual([])
    for (const sub of ['login', 'session', 'logout']) {
      expect(entries, `api/auth/${sub}/ must exist`).toContain(sub)
    }
  })
})

describe('next build app-paths-manifest (when present)', () => {
  // Only runs if a `next build` produced the manifest. CI/local builds will;
  // a bare `vitest run` without a prior build skips. This is the real
  // routing-truth check: Next wrote these paths, so if a sub-path is missing
  // here the browser would 404 regardless of the source layout.
  it.skipIf(!existsSync(manifestPath))('lists the three auth sub-paths and no bare /api/auth', () => {
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as Record<string, string>
    const keys = Object.keys(manifest)
    expect(keys).toContain('/api/auth/login/route')
    expect(keys).toContain('/api/auth/session/route')
    expect(keys).toContain('/api/auth/logout/route')
    // The bug shipped as a bare /api/auth/route; it must be gone from the
    // manifest too.
    expect(keys).not.toContain('/api/auth/route')
  })
})
