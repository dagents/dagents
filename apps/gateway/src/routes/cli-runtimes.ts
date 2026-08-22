/**
 * CLI Runtime detection route — scans the gateway host's PATH for known CLI
 * binaries (claude, codex, gemini, …) so the console can show real
 * install status instead of a hardcoded "未配置".
 *
 * GET /api/v1/cli-runtimes → { success, data: { runtimes: [{ kind, binary, available, path }] } }
 *
 * Detection is intentionally cheap (each `which` call is ~1–5ms). The result
 * is cached in-process for 60s to avoid re-scanning on every page refresh.
 */
import { Hono } from 'hono'
import { execSync } from 'node:child_process'
import { getAdapterTier } from '@dagents/agent-adapters'

// Re-import from the source directly (this route lives in gateway, but the
// catalog is a console-side module). We inline the binary list here to avoid
// a cross-package dependency that doesn't exist yet.
const CLI_BINARY_MAP: { kind: string; binary: string }[] = [
  { kind: 'claude', binary: 'claude' },
  { kind: 'codex', binary: 'codex' },
  { kind: 'copilot', binary: 'copilot' },
  { kind: 'qwen', binary: 'qwen' },
  { kind: 'cursor', binary: 'cursor-agent' },
  { kind: 'opencode', binary: 'opencode' },
  { kind: 'codebuddy', binary: 'codebuddy' },
  { kind: 'deveco', binary: 'deveco' },
  { kind: 'kimi', binary: 'kimi' },
  { kind: 'kiro', binary: 'kiro-cli' },
  { kind: 'qoder', binary: 'qodercli' },
  { kind: 'traecli', binary: 'traecli' },
  { kind: 'hermes', binary: 'hermes' },
  { kind: 'grok', binary: 'grok' },
  { kind: 'antigravity', binary: 'agy' },
  { kind: 'openclaw', binary: 'openclaw' },
  { kind: 'pi', binary: 'pi' },
]

export const cliRuntimeRoutes = new Hono()

// ── Cache ──────────────────────────────────────────────────────────
let cachedAt = 0
let cachedResult: { kind: string; binary: string; available: boolean; path: string | null }[] | null = null
const CACHE_TTL_MS = 60_000 // 60s

interface RuntimeDetection {
  kind: string
  binary: string
  available: boolean
  path: string | null
  /** Maintenance tier (方案 E): core / community + regression status. */
  tier: { tier: string; regression: string; note?: string }
}

function detectAll(): RuntimeDetection[] {
  const results: RuntimeDetection[] = []
  for (const { kind, binary } of CLI_BINARY_MAP) {
    let available = false
    let path: string | null = null
    try {
      // `which` on macOS/Linux, `where` on Windows
      const cmd = process.platform === 'win32' ? 'where' : 'which'
      const out = execSync(`${cmd} ${binary}`, {
        timeout: 3000,
        encoding: 'utf-8',
        stdio: ['pipe', 'pipe', 'pipe'], // suppress stderr
      }).trim()
      if (out) {
        available = true
        path = out.split('\n')[0].trim()
      }
    } catch {
      // not found — leave available=false
    }
    const { tier, regression, note } = getAdapterTier(kind)
    results.push({ kind, binary, available, path, tier: { tier, regression, note } })
  }
  return results
}

cliRuntimeRoutes.get('/', (c) => {
  const now = Date.now()
  if (cachedResult && now - cachedAt < CACHE_TTL_MS) {
    return c.json({ success: true, data: { runtimes: cachedResult } })
  }
  const runtimes = detectAll()
  cachedResult = runtimes
  cachedAt = now
  return c.json({ success: true, data: { runtimes } })
})
