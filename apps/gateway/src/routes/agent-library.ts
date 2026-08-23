/**
 * `/api/v1/agent-library/*` — Agent 人格库（registry-not-database）的 HTTP 面。
 *
 * `docs/agent-library.md` 的路由侧。读端点（list/detail/divisions）永远只读
 * 文件系统注册表；写端点只有 instantiate（启用 = fork 成 agents 行）与
 * reimport（按溯源覆盖 instructions，id 不变所以工作流引用不失效）。
 * roots 管理（UI 挂载目录）与 skills 路由同构。
 *
 * instantiate 的 agents INSERT 镜像 `agent-templates.ts` 的写路径
 * （workspace_id 默认 nil UUID / owner_id 默认 'system' / 本机模式无登录），
 * 额外写入 `library_meta` 溯源（source sha + instructions sha + profile），
 * drift 判定的全部输入都在这一列里。
 */
import { Hono, type Context } from 'hono'
import type { ContentfulStatusCode } from 'hono/utils/http-status'
import { z } from 'zod'
import { runQuery } from '@dagents/db'
import { createLogger } from '@dagents/shared'
import { agentLibraryRegistry } from '../agent-library-registry.js'
import { managedAgentLibraryDirs } from '../managed-agent-library-dirs.js'
import {
  findInstantiatedRow,
  insertLibraryAgent,
  type LibraryAgentRow,
} from '../agent-library-instantiate.js'
import { INLINE_SUPPORTED_KINDS } from '../inline-executor.js'
import {
  PERSONA_PROFILES,
  buildPersonaInstructions,
  compilePersonaBody,
  computePersonaDrift,
  sha256Hex,
  type PersonaProfile,
} from '../persona-compiler.js'

export const agentLibraryRoutes = new Hono()

const log = createLogger({ svc: 'gateway:agent-library-routes' })

const ok = <T>(c: Context, data: T) => c.json({ success: true, data })
const fail = (
  c: Context,
  status: ContentfulStatusCode,
  error: string,
  extra?: Record<string, unknown>,
) => c.json({ success: false, error, ...extra }, status)

/** 宿主 kind 白名单 = 可本机执行的 CLI 类型（D2：人格宿主必须有真工具）。 */
const ALLOWED_KINDS: readonly string[] = INLINE_SUPPORTED_KINDS

function driftForRow(
  row: LibraryAgentRow,
  fileSha256: string | null,
): ReturnType<typeof computePersonaDrift> {
  const meta = row.library_meta ?? {}
  return computePersonaDrift({
    fileSha256,
    sourceSha256: typeof meta.source_sha256 === 'string' ? meta.source_sha256 : null,
    instructions: row.instructions,
    instructionsSha256AtImport:
      typeof meta.instructions_sha256_at_import === 'string' ? meta.instructions_sha256_at_import : null,
  })
}

/** GET / — 目录：部门元数据 + 人格摘要（无正文），?division= 过滤。 */
agentLibraryRoutes.get('/', (c) => {
  const refresh = c.req.query('refresh') === 'true'
  const division = c.req.query('division')?.trim()
  const entries = agentLibraryRegistry.list({ refresh }).filter(
    (e) => !division || e.division === division,
  )
  return ok(c, {
    divisions: agentLibraryRegistry.divisions({ refresh }),
    entries,
    roots: agentLibraryRegistry.roots(),
  })
})

/** GET /drift — 已启用人格的同步状态三态（+diverged/missing-upstream）清单。 */
agentLibraryRoutes.get('/drift', async (c) => {
  let rows: LibraryAgentRow[]
  try {
    const { records } = await runQuery<LibraryAgentRow>(
      `SELECT id, name, instructions, library_meta FROM agents
        WHERE library_meta IS NOT NULL AND library_meta->>'id' IS NOT NULL
        ORDER BY name`,
    )
    rows = records
  } catch (err) {
    log.error('drift query failed', { error: String(err) })
    return fail(c, 502, 'drift query failed')
  }
  const items = rows.map((row) => {
    const libraryId = String(row.library_meta?.id ?? '')
    const entry = libraryId ? agentLibraryRegistry.get(libraryId) : undefined
    return {
      agentId: row.id,
      libraryId,
      name: row.name,
      division: typeof row.library_meta?.division === 'string' ? row.library_meta.division : null,
      state: driftForRow(row, entry?.rawSha256 ?? null),
      currentProfile:
        typeof row.library_meta?.profile === 'string' ? (row.library_meta.profile as PersonaProfile) : null,
    }
  })
  return ok(c, { items })
})

/** POST /roots — UI 挂载目录（写 ~/.agents/agent-library-dirs.json 后强制重扫）。 */
agentLibraryRoutes.post('/roots', async (c) => {
  const body = (await c.req.json().catch(() => null)) as { dir?: unknown } | null
  if (!body || typeof body.dir !== 'string') {
    return fail(c, 400, 'body must be { dir: string }')
  }
  const result = managedAgentLibraryDirs.add(body.dir)
  if (!result.ok) return fail(c, 400, result.error ?? 'add root failed')
  agentLibraryRegistry.list({ refresh: true })
  return ok(c, { dir: result.dir })
})

/** DELETE /roots — 移除挂载目录（dir 来自 query 或 body，console 代理不转发 DELETE body）。 */
agentLibraryRoutes.delete('/roots', async (c) => {
  const fromQuery = c.req.query('dir')
  let fromBody: string | undefined
  if (!fromQuery) {
    const body = (await c.req.json().catch(() => null)) as { dir?: unknown } | null
    if (body && typeof body.dir === 'string') fromBody = body.dir
  }
  const dir = (fromQuery ?? fromBody ?? '').trim()
  if (!dir) return fail(c, 400, 'dir is required (query ?dir= or body { dir })')
  const result = managedAgentLibraryDirs.remove(dir)
  if (!result.ok) return fail(c, 400, result.error ?? 'remove root failed')
  agentLibraryRegistry.list({ refresh: true })
  return ok(c, { dir: result.dir })
})

/** GET /:division/:slug — 详情：原文 + 三档编译预览 + 已启用/drift 状态。 */
agentLibraryRoutes.get('/:division/:slug', async (c) => {
  const id = `${c.req.param('division')}/${c.req.param('slug')}`
  const entry = agentLibraryRegistry.get(id)
  if (!entry) return fail(c, 404, `library entry not found: ${id}`, { id })

  const row = await findInstantiatedRow(id)
  const previews = PERSONA_PROFILES.map((profile) => {
    const compiled = compilePersonaBody(entry.body, profile)
    return { profile, chars: compiled.length, preview: compiled }
  })
  return ok(c, {
    ...entry,
    previews,
    instantiated: row
      ? { agentId: row.id, drift: driftForRow(row, entry.rawSha256) }
      : null,
  })
})

const instantiateSchema = z.object({
  profile: z.enum(['full', 'slim', 'minimal']).optional(),
  kind: z.string().min(1).max(64).optional(),
  model: z.string().max(128).optional(),
  name: z.string().min(1).max(128).optional(),
  workspace_id: z.string().uuid().optional(),
  owner_id: z.string().min(1).max(128).optional(),
})

/**
 * POST /:division/:slug/instantiate — 启用人格：编译（默认 slim）+ 语言包络
 * + 溯源哈希，落一行 kind 默认 'claude' 的 agents。同一库 id 已启用 → 409
 * （走 reimport 更新，不要产生重复行）。
 */
agentLibraryRoutes.post('/:division/:slug/instantiate', async (c) => {
  const id = `${c.req.param('division')}/${c.req.param('slug')}`
  const entry = agentLibraryRegistry.get(id)
  if (!entry) return fail(c, 404, `library entry not found: ${id}`, { id })

  let parsed: z.infer<typeof instantiateSchema>
  try {
    parsed = instantiateSchema.parse((await c.req.json().catch(() => ({}))) ?? {})
  } catch (err) {
    return fail(c, 400, 'invalid instantiate body', { detail: String(err) })
  }

  // 建议优先级：请求体 > 人格 frontmatter（快速开始档位人格锁定 kind/model）> 默认 claude
  const kind = parsed.kind ?? entry.suggestedKind ?? 'claude'
  if (!ALLOWED_KINDS.includes(kind)) {
    return fail(c, 400, `kind must be one of: ${ALLOWED_KINDS.join(', ')}`, { kind })
  }
  const model = parsed.model ?? entry.suggestedModel ?? ''
  const profile = parsed.profile ?? 'slim'

  const existing = await findInstantiatedRow(id)
  if (existing) {
    return fail(c, 409, '该人格已启用，请使用 reimport 更新', {
      id,
      agentId: existing.id,
    })
  }

  let agentId: string
  try {
    agentId = await insertLibraryAgent(entry, {
      profile,
      kind,
      model,
      name: parsed.name ?? entry.name,
      workspaceId: parsed.workspace_id,
      ownerId: parsed.owner_id,
    })
  } catch (err) {
    log.error('agent library instantiate: agents insert failed', { id, error: String(err) })
    return fail(c, 422, 'instantiate failed', { detail: String(err) })
  }

  return c.json({ success: true, data: { id: agentId, libraryId: id, kind, profile } }, 201)
})

const reimportSchema = z.object({
  confirm: z.boolean().optional(),
  profile: z.enum(['full', 'slim', 'minimal']).optional(),
})

/**
 * POST /:division/:slug/reimport — 按最新库文件覆盖 instructions（id/引用
 * 不变）。本地已修改（locally-modified/diverged）时要求 body.confirm=true，
 * 防止上游同步静默冲掉用户的定制。
 */
agentLibraryRoutes.post('/:division/:slug/reimport', async (c) => {
  const id = `${c.req.param('division')}/${c.req.param('slug')}`
  const entry = agentLibraryRegistry.get(id)
  if (!entry) return fail(c, 404, `library entry not found: ${id}`, { id })

  let parsed: z.infer<typeof reimportSchema>
  try {
    parsed = reimportSchema.parse((await c.req.json().catch(() => ({}))) ?? {})
  } catch (err) {
    return fail(c, 400, 'invalid reimport body', { detail: String(err) })
  }

  const row = await findInstantiatedRow(id)
  if (!row) {
    return fail(c, 404, '该人格尚未启用，请先 instantiate', { id })
  }

  const state = driftForRow(row, entry.rawSha256)
  if ((state === 'locally-modified' || state === 'diverged') && !parsed.confirm) {
    return fail(c, 409, '本地 instructions 已被修改，覆盖前需 confirm=true', { id, state })
  }

  const profile = parsed.profile ?? 'slim'
  const instructions = buildPersonaInstructions(entry.body, profile)
  const oldMeta = (row.library_meta ?? {}) as Record<string, unknown>
  const libraryMeta = {
    ...oldMeta,
    id,
    source_path: entry.filePath,
    source_sha256: entry.rawSha256,
    instructions_sha256_at_import: sha256Hex(instructions),
    division: entry.division,
    profile,
    reimported_at: new Date().toISOString(),
  }

  try {
    await runQuery(
      `UPDATE agents
          SET instructions = $1, summary = $2, library_meta = $3::jsonb, updated_at = NOW()
        WHERE id = $4::uuid`,
      [instructions, entry.description, JSON.stringify(libraryMeta), row.id],
    )
  } catch (err) {
    log.error('agent library reimport failed', { id, agentId: row.id, error: String(err) })
    return fail(c, 422, 'reimport failed', { detail: String(err) })
  }

  log.info('agent library reimport ok', { id, agentId: row.id, profile, fromState: state })
  return ok(c, { id: row.id, libraryId: id, profile, fromState: state, state: 'up-to-date' })
})
