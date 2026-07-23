/**
 * MCP server-config injection — write `opts.mcpConfig` to a private temp file
 * and pass its path to the claude CLI via `--mcp-config`.
 *
 * Translated from multica `writeMcpConfigToTemp` (Go): the CLI reads MCP server
 * definitions from a JSON/YAML file, so a runtime-supplied config object must
 * be materialized on disk for the duration of the run and removed after. The
 * temp file is world-unreadable (0o600) because it may carry command env / args
 * that include secrets (API keys passed to MCP servers).
 *
 * Scope (M2.6 / P1.6.T4): materialize + clean up only. The config object's
 * shape (`mcpServers` map, stdio vs sse transport, …) is owned by the caller
 * and passed through verbatim — the adapter does not validate or rewrite it,
 * matching multica, which forwards `McpConfig` to the CLI unmodified.
 */
import { mkdtemp, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

/**
 * Result of materializing an MCP config: the temp file path to hand to
 * `--mcp-config`, and a `cleanup()` that removes the file and its private dir.
 * `cleanup()` is total (never rejects) so it is safe in a `finally` block.
 */
export interface McpConfigFile {
  /** Absolute path to the temp config file; pass verbatim to `--mcp-config`. */
  path: string
  /** Remove the temp file and its dir. Safe to call more than once. */
  cleanup: () => Promise<void>
}

const MCP_FILE_PREFIX = 'mil-claude-mcp-'
const MCP_FILE_NAME = 'mcp.json'

/**
 * Validate that `opts.mcpConfig` is serializable to a JSON object the CLI will
 * accept. The CLI expects an `mcpServers` map (or per-server entries); we do
 * not enforce that schema here — we only reject the values that would produce
 * a malformed or empty file, deferring shape errors to the CLI itself (mirrors
 * multica, which does not schema-check `McpConfig`). Returns the JSON string
 * to write, or `null` when there is nothing to inject.
 */
function serializeMcpConfig(mcpConfig: unknown): string | null {
  if (mcpConfig == null) return null
  if (typeof mcpConfig !== 'object') {
    throw new TypeError(
      `mcpConfig must be an object (the CLI's mcpServers map), got ${typeof mcpConfig}`,
    )
  }
  if (Array.isArray(mcpConfig)) {
    throw new TypeError('mcpConfig must be an object (mcpServers map), got an array')
  }
  // An empty object would write `{}` to disk — a valid but no-op config. The
  // CLI loads it fine; still, skip the temp file entirely when there are no
  // keys so a caller passing `{}` does not pay the spawn/IO cost. (Reflects
  // the multica truthiness check before writing.)
  if (Object.keys(mcpConfig as Record<string, unknown>).length === 0) return null
  try {
    return JSON.stringify(mcpConfig)
  } catch (err) {
    throw new TypeError(`mcpConfig is not JSON-serializable: ${(err as Error).message}`)
  }
}

/**
 * Write `mcpConfig` to a private temp file and return its path + a cleanup
 * callback. Returns `null` when `mcpConfig` is absent/empty (nothing to
 * inject) so the caller can skip `--mcp-config` entirely.
 *
 * The file lives in its own temp dir (not a shared one) with mode 0o600 so
 * concurrent runs never collide and no other user can read the file. The dir
 * is created with mkdtemp (0o700 on POSIX) for the same reason.
 */
export async function writeMcpConfigToTemp(mcpConfig: unknown): Promise<McpConfigFile | null> {
  const json = serializeMcpConfig(mcpConfig)
  if (json === null) return null

  const dir = await mkdtemp(join(tmpdir(), MCP_FILE_PREFIX))
  const path = join(dir, MCP_FILE_NAME)
  // 0o600: owner-read/write only — the file may carry MCP server secrets.
  await writeFile(path, json, { mode: 0o600 })

  let cleaned = false
  return {
    path,
    cleanup: async () => {
      if (cleaned) return
      cleaned = true
      // rm -rf the private dir (file + dir in one call). Never throws: a
      // leftover temp file is a leak, not a run failure — the agent result is
      // already settled by the time cleanup runs.
      try {
        await rm(dir, { recursive: true, force: true })
      } catch {
        // Swallow: best-effort cleanup. The OS temp reaper will reap the dir
        // eventually; surfacing here would mask the real run outcome.
      }
    },
  }
}
