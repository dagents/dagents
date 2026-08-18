/**
 * Skills catalog API — read surface + custom-root management.
 *
 * The registry owns discovery (see ../skills-registry.ts); these routes only
 * project it. Nothing here touches Postgres — skills are a filesystem-backed
 * runtime catalog, not persisted platform entities.
 *
 * GET /api/v1/skills?refresh=1
 *   → { success, data: { skills: [{ name, description, source }], roots: [{ source, dir, rank, removable }] } }
 *     Catalog summaries only: no bodies. `refresh=1` bypasses the 60s TTL
 *     cache. `roots[].removable` marks UI-managed dirs (界面可删；env 配置的
 *     只能改 DAGENTS_SKILL_DIRS).
 *
 * POST /api/v1/skills/roots { dir }
 *   → 校验目录存在后写入 ~/.agents/skill-dirs.json 并强制重扫，
 *     返回更新后的 { skills, roots }（一次往返即见技能）。
 *
 * DELETE /api/v1/skills/roots?dir=…（也接受 JSON body）
 *   → 从 UI 管理列表移除并强制重扫，同样返回 { skills, roots }。
 *
 * GET /api/v1/skills/:name
 *   → { success, data: { name, description, source, content, dir, metadata } }
 *     Full definition, re-read from disk on every call so SKILL.md edits are
 *     immediately visible. 404 for unknown/non-kebab-case names.
 */

import { Hono } from 'hono'
import { skillsRegistry } from '../skills-registry.js'
import { expandHome, managedSkillDirs } from '../managed-skill-dirs.js'

export const skillsRoutes = new Hono()

/** Project the registry with the removable flag for UI delete affordances. */
function catalogPayload(refresh = false) {
  const skills = skillsRegistry.list({ refresh })
  const envDirs = new Set(
    (process.env.DAGENTS_SKILL_DIRS ?? '')
      .split(':')
      .map((d) => d.trim())
      .filter(Boolean)
      .map(expandHome),
  )
  const roots = skillsRegistry.roots().map(({ source, dir, rank }) => ({
    source,
    dir,
    rank,
    removable: source === 'custom' && !envDirs.has(dir),
  }))
  return { skills, roots }
}

skillsRoutes.get('/', (c) => {
  return c.json({ success: true, data: catalogPayload(c.req.query('refresh') === '1') })
})

// Registered before GET /:name so the literal segment wins over the param.
skillsRoutes.post('/roots', async (c) => {
  const body = (await c.req.json().catch(() => null)) as { dir?: unknown } | null
  if (!body || typeof body.dir !== 'string') {
    return c.json({ success: false, error: 'body must be { dir: string }' }, 400)
  }
  const result = managedSkillDirs.add(body.dir)
  if (!result.ok) {
    return c.json({ success: false, error: result.error }, 400)
  }
  return c.json({ success: true, data: { dir: result.dir, ...catalogPayload(true) } })
})

skillsRoutes.delete('/roots', async (c) => {
  // dir 可来自 query（console 代理的 DELETE 不转发 body）或 JSON body。
  const fromQuery = c.req.query('dir')
  let fromBody: string | undefined
  if (!fromQuery) {
    const body = (await c.req.json().catch(() => null)) as { dir?: unknown } | null
    if (body && typeof body.dir === 'string') fromBody = body.dir
  }
  const dir = (fromQuery ?? fromBody ?? '').trim()
  if (!dir) {
    return c.json({ success: false, error: 'dir is required (query ?dir= or body { dir })' }, 400)
  }
  const result = managedSkillDirs.remove(dir)
  if (!result.ok) {
    return c.json({ success: false, error: result.error }, 400)
  }
  return c.json({ success: true, data: { dir: result.dir, ...catalogPayload(true) } })
})

skillsRoutes.get('/:name', (c) => {
  const name = c.req.param('name')
  const definition = skillsRegistry.get(name)
  if (!definition) {
    return c.json({ success: false, error: `skill not found: ${name}` }, 404)
  }
  return c.json({ success: true, data: definition })
})
