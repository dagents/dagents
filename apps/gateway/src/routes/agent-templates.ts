import { Hono, type Context } from 'hono'
import type { ContentfulStatusCode } from 'hono/utils/http-status'
import { z } from 'zod'
import { randomUUID } from 'node:crypto'
import { runQuery } from '@dagents/db'
import { createLogger } from '@dagents/shared'
import type { SsoContextVars, SsoUser } from '../auth.js'

/**
 * `/api/v1/agent-templates/*` — Agent Template Library (one-click agent creation).
 *
 * Returns a static catalogue of pre-configured agent templates (no DB row per
 * template — they're static JSON curated in-repo) and an `instantiate` endpoint
 * that turns a template into a real `agents` row (+ optional `agent_daemons`
 * bridge row under the same id), mirroring the `POST /api/v1/agents` write path.
 *
 * This is the backend half of the "从模板创建" (Create from template) UX: the
 * console's AgentTemplateGallery fetches the catalogue, the user picks a card,
 * and the instantiate call writes the agent so the user lands on the agent
 * detail page with zero form-filling.
 *
 * Template fields align 1:1 with the `agents` table columns the agents POST
 * handler writes (name / kind / model / instructions / roles / skills /
 * executable_path), plus display-only fields the gallery renders (icon emoji,
 * description, category). `category` drives the gallery's filter tabs
 * (popular / coding / specialist).
 *
 * Auth: gated by the SSO session middleware under `REQUIRE_LOGIN=1`, same
 * posture as the other gateway-owned routes. The instantiate endpoint derives
 * `owner_id` from the session (`c.get('ssoUser').sub`) when the caller does not
 * supply one, so a browser flow with a valid session needs no extra headers.
 */

export const agentTemplateRoutes = new Hono<{ Variables: SsoContextVars }>()

const log = createLogger({ svc: 'gateway:agent-templates' })

/** Standard envelope helpers (same shape as the rest of the gateway). */
const ok = <T>(c: Context, data: T) => c.json({ success: true, data })
const fail = (
  c: Context,
  status: ContentfulStatusCode,
  error: string,
  extra?: Record<string, unknown>,
) => c.json({ success: false, error, ...extra }, status)

/**
 * A pre-configured agent template. The first 7 fields (id → executable_path)
 * map 1:1 onto the `agents` table columns the POST /agents handler writes; the
 * last 3 (description / icon / category) are gallery-display-only.
 */
export interface AgentTemplate {
  id: string
  name: string
  kind: string
  model: string
  instructions: string
  roles: string[]
  skills: string[]
  description: string
  /** Emoji shown as the card avatar. */
  icon: string
  executable_path: string
  category: 'popular' | 'coding' | 'specialist'
}

/**
 * The static template catalogue. Curated in-repo (no DB) so adding a template
 * is a code change, not a migration. Each template carries the full agent
 * config the instantiate endpoint writes, so the gallery can show a preview and
 * the instantiate call needs no extra fields beyond name/daemon/workspace
 * overrides.
 */
const TEMPLATES: AgentTemplate[] = [
  {
    id: 'claude-sonnet-general',
    name: 'Claude Sonnet 通用助手',
    kind: 'claude',
    model: 'sonnet',
    instructions: 'You are a helpful coding assistant.',
    roles: ['coding', 'review'],
    skills: [],
    description: '通用编码与代码审查助手，基于 Claude Sonnet 模型，适合日常开发任务。',
    icon: '🤖',
    executable_path: 'claude',
    category: 'popular',
  },
  {
    id: 'claude-opus-expert',
    name: 'Claude Opus 专家',
    kind: 'claude',
    model: 'opus',
    instructions: 'You are an expert software architect.',
    roles: ['architecture', 'coding'],
    skills: [],
    description: '资深软件架构师，基于 Claude Opus 模型，擅长系统设计与复杂重构。',
    icon: '🧠',
    executable_path: 'claude',
    category: 'specialist',
  },
  {
    id: 'codex-general',
    name: 'Codex 编码助手',
    kind: 'codex',
    model: '',
    instructions: 'You are a helpful coding assistant.',
    roles: ['coding'],
    skills: [],
    description: '基于 OpenAI Codex CLI 的编码助手，快速生成与补全代码。',
    icon: '⚡',
    executable_path: 'codex',
    category: 'popular',
  },
  {
    id: 'copilot-general',
    name: 'GitHub Copilot 助手',
    kind: 'copilot',
    model: '',
    instructions: 'You are a helpful coding assistant.',
    roles: ['coding'],
    skills: [],
    description: 'GitHub Copilot CLI 助手，集成 GitHub 生态的编码伙伴。',
    icon: '🐙',
    executable_path: 'github-copilot-cli',
    category: 'coding',
  },
  {
    id: 'qwen-coder',
    name: 'Qwen Coder',
    kind: 'qwen',
    model: '',
    instructions: 'You are a helpful coding assistant specialized in Python.',
    roles: ['coding'],
    skills: [],
    description: '通义千问编码助手，擅长 Python 与数据分析任务。',
    icon: '🐍',
    executable_path: 'qwen',
    category: 'coding',
  },
  {
    id: 'gemini-general',
    name: 'Gemini 助手',
    kind: 'gemini',
    model: '',
    instructions: 'You are a helpful coding assistant.',
    roles: ['coding'],
    skills: [],
    description: 'Google Gemini 编码助手，多语言通用开发支持。',
    icon: '✨',
    executable_path: 'gemini',
    category: 'coding',
  },
]

/**
 * GET /api/v1/agent-templates — list the static template catalogue.
 *
 * Returns `{ templates }`. No filtering at the SQL layer (there's no SQL) — the
 * gallery filters client-side by category, keeping this route trivially
 * cacheable.
 */
agentTemplateRoutes.get('/', (c) => {
  return ok(c, { templates: TEMPLATES })
})

/**
 * POST /api/v1/agent-templates/:id/instantiate — create an agent from a template.
 *
 * Looks up the template by id, then writes the same `agents` INSERT the POST
 * /agents handler does (plus the optional `agent_daemons` bridge row under the
 * shared id when a daemon_id is supplied). The caller can override the template's
 * name and bind a daemon; everything else (kind / model / instructions / roles /
 * executable_path) comes from the template.
 *
 * `workspace_id` defaults to the nil UUID (the agent is workspace-scoped at the
 * DB level; a zero workspace is the honest placeholder when the caller has no
 * workspace context — same posture as a fresh install before any workspace is
 * created). `owner_id` defaults to the SSO session's `sub` so a browser flow
 * needs no extra headers.
 *
 * Returns `{ id }` (the new agent's id) on success. 404 when the template id is
 * unknown, 404 when a supplied daemon_id does not exist, 422 on INSERT failure.
 */
const instantiateSchema = z.object({
  name: z.string().min(1).max(128).optional(),
  daemon_id: z.string().uuid().optional().nullable(),
  workspace_id: z.string().uuid().optional(),
  owner_id: z.string().min(1).max(128).optional(),
})

agentTemplateRoutes.post('/:id/instantiate', async (c) => {
  const templateId = c.req.param('id')
  const template = TEMPLATES.find((t) => t.id === templateId)
  if (!template) {
    return fail(c, 404, 'template not found', { id: templateId })
  }

  let parsed: z.infer<typeof instantiateSchema>
  try {
    // Tolerate an empty body (all fields optional) — `await c.req.json()` throws
    // on an empty body, so default to `{}`.
    const raw = await c.req.json().catch(() => ({}))
    parsed = instantiateSchema.parse(raw)
  } catch (err) {
    return fail(c, 400, 'invalid instantiate body', { detail: String(err) })
  }

  // Resolve the agent fields: template defaults overridable by the caller.
  const ssoUser = c.get('ssoUser') as SsoUser | undefined
  const workspaceId = parsed.workspace_id ?? '00000000-0000-0000-0000-000000000000'
  const ownerId = parsed.owner_id ?? ssoUser?.sub ?? 'system'
  const name = parsed.name ?? template.name
  const daemonId = parsed.daemon_id ?? null

  // When a daemon_id is supplied, verify the daemon exists before inserting
  // (the agent_daemons FK would 500 otherwise; we want a clean 404).
  if (daemonId) {
    try {
      const { records } = await runQuery<{ id: string }>(`SELECT id FROM daemons WHERE id = $1`, [
        daemonId,
      ])
      if (!records[0]) {
        return fail(c, 404, 'daemon not found', { daemon_id: daemonId })
      }
    } catch (err) {
      log.error('template instantiate: daemon lookup failed', { error: String(err) })
      return fail(c, 502, 'instantiate failed')
    }
  }

  const agentId = randomUUID()

  try {
    await runQuery(
      `INSERT INTO agents (id, workspace_id, name, kind, roles, instructions, skills,
                           visibility, concurrency, model, runtime, owner_id,
                           status, availability, activity, summary, input_schema, output_schema,
                           daemon_id)
       VALUES ($1, $2, $3, $4, $5::jsonb, $6, $7::jsonb,
               $8, $9, $10, $11, $12,
               $13, $14, '[]'::jsonb, $15, $16, $17,
               $18)`,
      [
        agentId,
        workspaceId,
        name,
        template.kind,
        JSON.stringify(template.roles),
        template.instructions,
        JSON.stringify(template.skills),
        'workspace',
        1,
        template.model,
        '',
        ownerId,
        'idle',
        'offline',
        template.description,
        '',
        '',
        daemonId,
      ],
    )
  } catch (err) {
    log.error('template instantiate: agents insert failed', { error: String(err) })
    return fail(c, 422, 'instantiate failed', { detail: String(err) })
  }

  // Bridge row: register the agent with a daemon under the same id so the
  // runtime read path (agent_daemons join) lights up immediately. Best-effort
  // — a failure here does not undo the editor row; the agent is still usable
  // for flow orchestration.
  if (daemonId) {
    try {
      const capabilityDescriptor = {
        name,
        summary: template.description,
        tags: template.roles,
        inputSchema: '',
        outputSchema: '',
      }
      await runQuery(
        `INSERT INTO agent_daemons (id, name, kind, daemon_id, capability_descriptor,
                                    executable_path, visibility, workspace_id)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
        [
          agentId,
          name,
          template.kind,
          daemonId,
          JSON.stringify(capabilityDescriptor),
          template.executable_path,
          'workspace',
          workspaceId,
        ],
      )
    } catch (err) {
      log.warn('template instantiate: agent_daemons bridge insert failed', {
        id: agentId,
        error: String(err),
      })
    }
  }

  log.info('agent instantiated from template', {
    id: agentId,
    templateId,
    daemonId,
  })
  return ok(c, { id: agentId })
})
