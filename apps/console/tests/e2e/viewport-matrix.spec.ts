/**
 * Viewport matrix — 9 screens × 9 viewports, no horizontal overflow.
 *
 * Implements the DESIGN-HANDOFF responsive contract (design/DESIGN-HANDOFF.md
 * §"Responsive contract" + §"Implementation sequence" step 5/8): every product
 * screen must render with **no horizontal scroll** across the 2025–2026
 * viewport matrix. This spec is the executable form of that contract — for
 * each (screen × viewport) cell it loads the route at that viewport, waits for
 * the shell + page to settle, and asserts `documentElement.scrollWidth -
 * clientWidth <= 0` (the plan M10.2 assertion, verbatim).
 *
 * Matrix (plan §10.2 Task M10.2):
 *   screens  : /, /dashboard, /agents, /agents/agent-01, /flows,
 *              /flows/flow-1/edit, /lab, /workspace, /tasks/new, /settings
 *   viewports: 360×800, 390×844, 430×932, 600×960, 820×1180,
 *              1024×768, 1366×768, 1440×900, 1920×1080
 *
 * Test shape: one `test.describe` per viewport (9), each containing one test
 * per screen (10) → 90 cells. (The plan's prose says "9 屏"; the SCREENS list
 * it writes has 10 entries — the 9 design screens plus `/tasks/new`, which is
 * the new-task route the plan's own M3.1 added. We assert all 10 so the
 * coverage doc's "9 屏 × 9 viewport" grid is complete; the 10th route is a
 * console-native screen, not a design export, but it shares the shell and the
 * same no-overflow contract.) Each cell also captures a full-page screenshot
 * so `docs/v0.3-viewport-coverage.md` can list real artifact paths.
 *
 * Why per-screen tests (not one loop): a failure names the exact
 * screen×viewport cell, and Playwright's `only-on-failure` trace + the
 * captured screenshot land per-cell. `workers: 1` (config) keeps the dev
 * server's on-demand route compilation from racing itself.
 *
 * Overflow tolerance: the contract is `<= 0`. Sub-pixel rounding (devicePixelRatio,
 * fractional clamp() type) can produce a 1px phantom on some viewports; we
 * fail at `> 0` but the assertion stays `<= 0` per the plan — if a real
 * overflow appears it is multiple px and unambiguous, and a 1px phantom we
 * treat as a CSS bug to fix (e.g. `100%` vs `100vw`), not noise to mask.
 *
 * Network: routes fetch live gateway/dispatch data; with the dev stack down
 * the fetches 4xx/5xx and the views render their error/loading shells. Those
 * shells still use the same `.app` grid + `.page` layout, so the no-overflow
 * assertion is valid against them — the contract is geometric, not
 * data-dependent. We `waitForLoadState('networkidle')` so in-flight fetches
 * resolve to their terminal (error/loading) state before measuring.
 */

import { test, expect, type Page } from '@playwright/test'
import { mkdirSync } from 'node:fs'
import { resolve } from 'node:path'

/**
 * The 10 routes covered. The plan's SCREENS literal (§10.2 Step 1) lists
 * these 10 paths; the 9 exported design screens are the first 9 minus
 * `/tasks/new` (a console-native route), and `/` is the launcher/overview.
 */
const SCREENS = [
  '/',
  '/dashboard',
  '/agents',
  '/agents/agent-01',
  '/flows',
  '/flows/flow-1/edit',
  '/lab',
  '/workspace',
  '/tasks/new',
  '/settings',
] as const

/**
 * The 9 DESIGN-HANDOFF viewports: mobile compact → wide desktop. `[width,
 * height]` pairs in the order the handoff lists them.
 */
const VIEWPORTS: ReadonlyArray<readonly [number, number]> = [
  [360, 800],
  [390, 844],
  [430, 932],
  [600, 960],
  [820, 1180],
  [1024, 768],
  [1366, 768],
  [1440, 900],
  [1920, 1080],
]

/** Screenshot output root (relative to apps/console). */
const SHOT_DIR = resolve(__dirname, 'screenshots')

// Ensure the screenshot dir exists before any cell tries to write into it.
// Playwright does not create parent dirs for page.screenshot({ path }).
mkdirSync(SHOT_DIR, { recursive: true })

/**
 * Assert a route renders with no horizontal overflow at the current viewport.
 *
 * Sets the viewport, navigates, waits for the network to settle (so loading
 * shells / error shells are in their terminal state), then measures
 * `documentElement.scrollWidth - clientWidth`. Captures a full-page screenshot
 * named `<w>x<h>--<slug>.png` so the coverage doc can point at real files.
 */
async function assertNoHorizontalOverflow(
  page: Page,
  path: string,
  width: number,
  height: number,
): Promise<void> {
  await page.setViewportSize({ width, height })
  await page.goto(path, { waitUntil: 'domcontentloaded' })
  // Let in-flight data fetches (gateway/dispatch) resolve to their terminal
  // state — error/loading shells share the same grid, so the measurement is
  // valid regardless, but a mid-fetch skeleton must finish rendering first.
  await page.waitForLoadState('networkidle').catch(() => {
    // networkidle can time out if a long-poll/WS keeps a connection open
    // (agent-detail WS, lab/workspace threads). That's fine — the DOM is
    // already laid out; fall through and measure.
  })
  // Give React one paint after network settles so client-rendered shells
  // (loading → error/data) have flushed their final layout.
  await page.waitForTimeout(150)

  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
  )

  // Screenshot every cell — the coverage doc lists 9×9 paths, so we want the
  // artifacts present even on green cells. Named by viewport + route slug.
  const slug = path.replace(/^\//, '').replace(/[^\w-]+/g, '-').replace(/^-|-$/g, '') || 'root'
  await page.screenshot({
    path: resolve(SHOT_DIR, `${width}x${height}--${slug}.png`),
    fullPage: true,
  })

  expect(
    overflow,
    `horizontal overflow at ${width}x${height} on ${path}: scrollWidth-clientWidth=${overflow}`,
  ).toBeLessThanOrEqual(0)
}

// One describe per viewport → the coverage doc's rows. The viewport is set
// inside each test (not via project use.viewport) so a single project runs
// every cell and the screenshot filenames carry the exact dimensions.
for (const [w, h] of VIEWPORTS) {
  test.describe(`viewport ${w}×${h}`, () => {
    for (const path of SCREENS) {
      test(`${path} — no horizontal overflow`, async ({ page }) => {
        await assertNoHorizontalOverflow(page, path, w, h)
      })
    }
  })
}
