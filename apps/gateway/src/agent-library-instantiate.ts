/**
 * agent-library-instantiate.ts — Agent Library 的落库助手（单人格/团队共用）。
 *
 * 从 routes/agent-library.ts 抽出的共享写路径：
 *   - findInstantiatedRow(s)  按 library_meta->>'id' 稳定键找已启用行（reimport/团队复用）
 *   - insertLibraryAgent      instantiate 的 agents INSERT（kind 默认 claude +
 *                             slim 编译 + 语言包络 + library_meta 溯源）
 */
import { randomUUID } from 'node:crypto'
import { runQuery } from '@dagents/db'
import { createLogger } from '@dagents/shared'
import type { AgentLibraryEntry } from './agent-library-registry.js'
import { buildPersonaInstructions, sha256Hex, type PersonaProfile } from './persona-compiler.js'

const log = createLogger({ svc: 'gateway:agent-library-instantiate' })

export interface LibraryAgentRow {
  id: string
  name: string
  instructions: string | null
  library_meta: {
    id?: unknown
    source_path?: unknown
    source_sha256?: unknown
    instructions_sha256_at_import?: unknown
    division?: unknown
    profile?: unknown
    imported_at?: unknown
    reimported_at?: unknown
  } | null
}

/** 按库 id 找已启用的 agents 行（library_meta->>'id' 稳定键）。找不到 → null。 */
export async function findInstantiatedRow(libraryId: string): Promise<LibraryAgentRow | null> {
  try {
    const { records } = await runQuery<LibraryAgentRow>(
      `SELECT id, name, instructions, library_meta FROM agents
        WHERE library_meta->>'id' = $1`,
      [libraryId],
    )
    return records[0] ?? null
  } catch (err) {
    log.error('agent library row lookup failed', { libraryId, error: String(err) })
    return null
  }
}

/** 宿主 kind 白名单由路由层校验；这里只管写。 */
export interface InsertLibraryAgentOpts {
  profile: PersonaProfile
  kind: string
  model?: string
  name?: string
  workspaceId?: string
  ownerId?: string
}

/** 写一行启用的 agents（不查重 —— 调用方先 findInstantiatedRow）。返回 agentId。 */
export async function insertLibraryAgent(
  entry: AgentLibraryEntry,
  opts: InsertLibraryAgentOpts,
): Promise<string> {
  const instructions = buildPersonaInstructions(entry.body, opts.profile)
  const agentId = randomUUID()
  const libraryMeta = {
    id: entry.id,
    source_path: entry.filePath,
    source_sha256: entry.rawSha256,
    instructions_sha256_at_import: sha256Hex(instructions),
    division: entry.division,
    profile: opts.profile,
    imported_at: new Date().toISOString(),
  }
  await runQuery(
    `INSERT INTO agents (id, workspace_id, name, kind, roles, instructions, skills,
                         visibility, concurrency, model, runtime, owner_id,
                         status, availability, activity, summary, input_schema, output_schema,
                         library_meta)
     VALUES ($1, $2, $3, $4, $5::jsonb, $6, '[]'::jsonb,
             'workspace', 1, $7, '', $8,
             'idle', 'offline', '[]'::jsonb, $9, '', '',
             $10::jsonb)`,
    [
      agentId,
      opts.workspaceId ?? '00000000-0000-0000-0000-000000000000',
      opts.name ?? entry.name,
      opts.kind,
      JSON.stringify([entry.division]),
      instructions,
      opts.model ?? '',
      opts.ownerId ?? 'system',
      entry.description,
      JSON.stringify(libraryMeta),
    ],
  )
  log.info('agent library instantiate ok', { id: entry.id, agentId, kind: opts.kind, profile: opts.profile })
  return agentId
}

/**
 * 按前缀找已启用的 agents 行（团队模板批量复用检查）。
 * 返回 library_id → row 的映射；查库失败时 warn 并返回空映射。
 */
export async function findInstantiatedRows(
  libraryIds: string[],
): Promise<Map<string, LibraryAgentRow>> {
  if (libraryIds.length === 0) return new Map()
  try {
    const { records } = await runQuery<LibraryAgentRow & { library_meta: { id?: unknown } }>(
      `SELECT id, name, instructions, library_meta FROM agents
        WHERE library_meta->>'id' = ANY($1::text[])`,
      [libraryIds],
    )
    const map = new Map<string, LibraryAgentRow>()
    for (const row of records) {
      const libId = typeof row.library_meta?.id === 'string' ? row.library_meta.id : null
      if (libId) map.set(libId, row)
    }
    return map
  } catch (err) {
    log.error('agent library rows lookup failed', { error: String(err) })
    return new Map()
  }
}
