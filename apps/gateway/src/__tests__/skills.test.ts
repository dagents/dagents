import { describe, it, expect, afterAll, vi } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { app } from '../app.js'
import { SkillsRegistry, defaultSkillRoots } from '../skills-registry.js'

// Route tests must not touch the user's real ~/.agents/skill-dirs.json —
// swap the singleton for a tmp-backed instance for the whole file.
vi.mock('../managed-skill-dirs.js', async () => {
  const actual = await vi.importActual<typeof import('../managed-skill-dirs.js')>(
    '../managed-skill-dirs.js',
  )
  const { mkdtempSync } = await import('node:fs')
  const { tmpdir } = await import('node:os')
  const { join } = await import('node:path')
  const dir = mkdtempSync(join(tmpdir(), 'dagents-managed-mock-'))
  const file = join(dir, 'skill-dirs.json')
  ;(globalThis as { __testManagedFile?: string }).__testManagedFile = file
  return { ...actual, managedSkillDirs: new actual.ManagedSkillDirs(file) }
})

import { ManagedSkillDirs, MAX_MANAGED_SKILL_DIRS } from '../managed-skill-dirs.js'

const testManagedFile = () => (globalThis as { __testManagedFile?: string }).__testManagedFile ?? ''

const tmpRoots: string[] = []

afterAll(() => {
  for (const dir of tmpRoots) rmSync(dir, { recursive: true, force: true })
  if (testManagedFile()) rmSync(join(testManagedFile(), '..'), { recursive: true, force: true })
})

function makeRoot(source: 'custom' | 'user-agents'): { dir: string; registry: SkillsRegistry } {
  const dir = mkdtempSync(join(tmpdir(), `dagents-skills-${source}-`))
  tmpRoots.push(dir)
  return { dir, registry: new SkillsRegistry(() => [{ source, dir, rank: source === 'custom' ? 300 : 500 }]) }
}

function writeSkill(root: string, name: string, frontmatter: string, body = 'Do the thing.\n'): void {
  mkdirSync(join(root, name), { recursive: true })
  writeFileSync(join(root, name, 'SKILL.md'), `---\n${frontmatter}---\n${body}`)
}

describe('skills registry — discovery shapes', () => {
  it('discovers directory bundles and normalizes multiline descriptions', () => {
    const { dir, registry } = makeRoot('custom')
    writeSkill(dir, 'my-skill', 'name: my-skill\ndescription: >\n  Line one\n  line two.\n')
    const skills = registry.list()
    expect(skills).toHaveLength(1)
    expect(skills[0]).toEqual({ name: 'my-skill', description: 'Line one line two.', source: 'custom' })
  })

  it('discovers flat <name>.md files', () => {
    const { dir, registry } = makeRoot('custom')
    writeFileSync(join(dir, 'flat-one.md'), '---\nname: flat-one\ndescription: A flat skill.\n---\nBody.\n')
    expect(registry.list().map((s) => s.name)).toEqual(['flat-one'])
  })

  it('skips hidden dirs, non-markdown files, and dirs without SKILL.md', () => {
    const { dir, registry } = makeRoot('custom')
    writeSkill(dir, 'good-one', 'name: good-one\ndescription: Good.\n')
    mkdirSync(join(dir, '.hidden'))
    writeFileSync(join(dir, '.hidden', 'SKILL.md'), '---\nname: hidden-x\ndescription: nope\n---\n')
    writeFileSync(join(dir, 'notes.txt'), 'not a skill')
    mkdirSync(join(dir, 'no-skill-md'))
    expect(registry.list().map((s) => s.name)).toEqual(['good-one'])
  })
})

describe('skills registry — frontmatter validation (warn-and-skip)', () => {
  it('skips skills missing description', () => {
    const { dir, registry } = makeRoot('custom')
    writeSkill(dir, 'no-desc', 'name: no-desc\n')
    expect(registry.list()).toHaveLength(0)
  })

  it('skips skills with non-kebab-case names', () => {
    const { dir, registry } = makeRoot('custom')
    writeSkill(dir, 'bad-name', 'name: Bad_Name\ndescription: x\n')
    writeSkill(dir, 'ok-name', 'name: ok-name\ndescription: x\n')
    expect(registry.list().map((s) => s.name)).toEqual(['ok-name'])
  })

  it('skips skills with invalid YAML frontmatter', () => {
    const { dir, registry } = makeRoot('custom')
    mkdirSync(join(dir, 'broken'), { recursive: true })
    writeFileSync(join(dir, 'broken', 'SKILL.md'), '---\nname: [unclosed\ndescription: x\n---\nbody\n')
    expect(registry.list()).toHaveLength(0)
  })

  it('skips files without frontmatter entirely', () => {
    const { dir, registry } = makeRoot('custom')
    mkdirSync(join(dir, 'plain'), { recursive: true })
    writeFileSync(join(dir, 'plain', 'SKILL.md'), 'Just some markdown, no fence.\n')
    expect(registry.list()).toHaveLength(0)
  })
})

describe('skills registry — rank merge and caching', () => {
  it('resolves duplicate names by root rank (custom beats user)', () => {
    const custom = makeRoot('custom')
    const user = makeRoot('user-agents')
    writeSkill(custom.dir, 'dup-skill', 'name: dup-skill\ndescription: from custom\n')
    writeSkill(user.dir, 'dup-skill', 'name: dup-skill\ndescription: from user\n')
    writeSkill(user.dir, 'user-only', 'name: user-only\ndescription: only here\n')
    const registry = new SkillsRegistry(() => [
      { source: 'custom', dir: custom.dir, rank: 300 },
      { source: 'user-agents', dir: user.dir, rank: 500 },
    ])
    const skills = registry.list()
    expect(skills.find((s) => s.name === 'dup-skill')?.description).toBe('from custom')
    expect(skills.find((s) => s.name === 'user-only')?.source).toBe('user-agents')
  })

  it('caches the catalog for the TTL window; refresh=1 forces a rescan', () => {
    const { dir, registry } = makeRoot('custom')
    writeSkill(dir, 'cached-skill', 'name: cached-skill\ndescription: v1\n')
    expect(registry.list()[0].description).toBe('v1')
    writeSkill(dir, 'cached-skill', 'name: cached-skill\ndescription: v2\n')
    // TTL not expired → stale-but-cached view is intentional.
    expect(registry.list()[0].description).toBe('v1')
    expect(registry.list({ refresh: true })[0].description).toBe('v2')
  })

  it('get() re-reads the body from disk on every call (no body cache)', () => {
    const { dir, registry } = makeRoot('custom')
    writeSkill(dir, 'fresh-skill', 'name: fresh-skill\ndescription: fresh\ntriggers:\n  - go\n', 'Old body.\n')
    const first = registry.get('fresh-skill')
    expect(first?.content).toBe('Old body.\n')
    expect(first?.metadata).toEqual({ triggers: ['go'] })
    expect(first?.dir).toBe(join(dir, 'fresh-skill'))
    writeSkill(dir, 'fresh-skill', 'name: fresh-skill\ndescription: fresh\n', 'New body.\n')
    expect(registry.get('fresh-skill')?.content).toBe('New body.\n')
  })

  it('get() rejects unknown or non-kebab-case names', () => {
    const { dir, registry } = makeRoot('custom')
    writeSkill(dir, 'real-skill', 'name: real-skill\ndescription: x\n')
    expect(registry.get('nope-skill')).toBeUndefined()
    expect(registry.get('../etc')).toBeUndefined()
  })

  it('defaultSkillRoots reads DAGENTS_SKILL_DIRS and appends ~/.agents/skills', () => {
    const prev = process.env.DAGENTS_SKILL_DIRS
    process.env.DAGENTS_SKILL_DIRS = '/tmp/a:/tmp/b'
    try {
      const roots = defaultSkillRoots()
      expect(roots.map((r) => r.source)).toEqual(['custom', 'custom', 'user-agents'])
      expect(roots[2].dir.endsWith(join('.agents', 'skills'))).toBe(true)
    } finally {
      if (prev === undefined) delete process.env.DAGENTS_SKILL_DIRS
      else process.env.DAGENTS_SKILL_DIRS = prev
    }
  })
})

describe('skills routes', () => {
  it('GET /api/v1/skills lists catalog + roots and refresh picks up env changes', async () => {
    const { dir } = makeRoot('custom')
    writeSkill(dir, 'route-skill', 'name: route-skill\ndescription: via route\n')
    const prev = process.env.DAGENTS_SKILL_DIRS
    process.env.DAGENTS_SKILL_DIRS = dir
    try {
      const res = await app.request('/api/v1/skills?refresh=1')
      expect(res.status).toBe(200)
      const json = (await res.json()) as {
        success: boolean
        data: { skills: { name: string; description: string; source: string }[]; roots: { source: string; dir: string }[] }
      }
      expect(json.success).toBe(true)
      expect(json.data.skills.find((s) => s.name === 'route-skill')?.description).toBe('via route')
      expect(json.data.roots.some((r) => r.dir === dir)).toBe(true)
      // Summaries must not leak bodies or absolute paths.
      expect(json.data.skills.find((s) => s.name === 'route-skill')).not.toHaveProperty('dir')
    } finally {
      if (prev === undefined) delete process.env.DAGENTS_SKILL_DIRS
      else process.env.DAGENTS_SKILL_DIRS = prev
    }
  })

  it('GET /api/v1/skills/:name returns the full definition; unknown names 404', async () => {
    const { dir } = makeRoot('custom')
    writeSkill(dir, 'detail-skill', 'name: detail-skill\ndescription: details\n', 'Full body here.\n')
    const prev = process.env.DAGENTS_SKILL_DIRS
    process.env.DAGENTS_SKILL_DIRS = dir
    try {
      const ok = await app.request('/api/v1/skills/detail-skill?refresh=1')
      expect(ok.status).toBe(200)
      const json = (await ok.json()) as { success: boolean; data: { content: string; dir: string } }
      expect(json.data.content).toBe('Full body here.\n')
      expect(json.data.dir).toBe(join(dir, 'detail-skill'))

      const missing = await app.request('/api/v1/skills/does-not-exist')
      expect(missing.status).toBe(404)
      const bad = await app.request('/api/v1/skills/Not_Kebab')
      expect(bad.status).toBe(404)
    } finally {
      if (prev === undefined) delete process.env.DAGENTS_SKILL_DIRS
      else process.env.DAGENTS_SKILL_DIRS = prev
    }
  })
})

describe('ManagedSkillDirs — UI 管理的自定义目录', () => {
  it('add validates existence, dedupes, and persists; list survives a reload', () => {
    const file = join(mkdtempSync(join(tmpdir(), 'dagents-msd-')), 'skill-dirs.json')
    tmpRoots.push(join(file, '..'))
    const dirs = new ManagedSkillDirs(file)

    expect(dirs.list()).toEqual([])
    const missing = dirs.add('/definitely/not/here')
    expect(missing.ok).toBe(false)
    expect(missing.error).toContain('目录不存在')

    const real = mkdtempSync(join(tmpdir(), 'dagents-msd-real-'))
    tmpRoots.push(real)
    expect(dirs.add(real)).toEqual({ ok: true, dir: real })
    expect(dirs.add(real).ok).toBe(false) // duplicate
    expect(dirs.list()).toEqual([real])

    // A fresh instance over the same file reloads the persisted list.
    expect(new ManagedSkillDirs(file).list()).toEqual([real])
  })

  it('remove drops a dir; unknown dirs surface a guided error', () => {
    const file = join(mkdtempSync(join(tmpdir(), 'dagents-msd-')), 'skill-dirs.json')
    tmpRoots.push(join(file, '..'))
    const dirs = new ManagedSkillDirs(file)
    const real = mkdtempSync(join(tmpdir(), 'dagents-msd-real-'))
    tmpRoots.push(real)
    dirs.add(real)

    expect(dirs.remove(real)).toEqual({ ok: true, dir: real })
    expect(dirs.list()).toEqual([])
    const gone = dirs.remove(real)
    expect(gone.ok).toBe(false)
    expect(gone.error).toContain('DAGENTS_SKILL_DIRS')
  })

  it('caps the list and tolerates a corrupt file', () => {
    const file = join(mkdtempSync(join(tmpdir(), 'dagents-msd-')), 'skill-dirs.json')
    tmpRoots.push(join(file, '..'))
    const dirs = new ManagedSkillDirs(file)
    for (let i = 0; i < MAX_MANAGED_SKILL_DIRS; i++) {
      const d = mkdtempSync(join(tmpdir(), 'dagents-msd-cap-'))
      tmpRoots.push(d)
      expect(dirs.add(d).ok).toBe(true)
    }
    const extra = mkdtempSync(join(tmpdir(), 'dagents-msd-cap-'))
    tmpRoots.push(extra)
    expect(dirs.add(extra).ok).toBe(false)
    expect(dirs.add('').ok).toBe(false)

    // Corrupt JSON → warn + empty list, never throw.
    writeFileSync(file, 'not json at all')
    expect(new ManagedSkillDirs(file).list()).toEqual([])
  })

  it('defaultSkillRoots merges env (300+) and managed (400+) with env dedupe winning', () => {
    const prev = process.env.DAGENTS_SKILL_DIRS
    const envDir = mkdtempSync(join(tmpdir(), 'dagents-msd-env-'))
    tmpRoots.push(envDir)
    const managedDir = mkdtempSync(join(tmpdir(), 'dagents-msd-managed-'))
    tmpRoots.push(managedDir)
    // Seed the mocked singleton's backing file.
    new ManagedSkillDirs(testManagedFile()).add(envDir) // must be deduped out
    new ManagedSkillDirs(testManagedFile()).add(managedDir)
    process.env.DAGENTS_SKILL_DIRS = envDir
    try {
      const roots = defaultSkillRoots()
      expect(roots.map((r) => r.dir)).toEqual([envDir, managedDir, roots[2].dir])
      expect(roots[0].rank).toBe(300)
      expect(roots[1].rank).toBeGreaterThanOrEqual(400)
      expect(roots[2].source).toBe('user-agents')
    } finally {
      if (prev === undefined) delete process.env.DAGENTS_SKILL_DIRS
      else process.env.DAGENTS_SKILL_DIRS = prev
    }
  })
})

describe('skills routes — custom root management', () => {
  it('POST /roots loads a dir immediately and marks it removable; DELETE removes it', async () => {
    const { dir } = makeRoot('custom')
    writeSkill(dir, 'ui-skill', 'name: ui-skill\ndescription: added via UI\n')

    const add = await app.request('/api/v1/skills/roots', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ dir }),
    })
    expect(add.status).toBe(200)
    const added = (await add.json()) as {
      success: boolean
      data: { skills: { name: string }[]; roots: { dir: string; removable: boolean }[] }
    }
    expect(added.success).toBe(true)
    expect(added.data.skills.some((s) => s.name === 'ui-skill')).toBe(true)
    const root = added.data.roots.find((r) => r.dir === dir)
    expect(root?.removable).toBe(true)

    const remove = await app.request(`/api/v1/skills/roots?dir=${encodeURIComponent(dir)}`, {
      method: 'DELETE',
    })
    expect(remove.status).toBe(200)
    const removed = (await remove.json()) as { data: { skills: { name: string }[]; roots: { dir: string }[] } }
    expect(removed.data.skills.some((s) => s.name === 'ui-skill')).toBe(false)
    expect(removed.data.roots.some((r) => r.dir === dir)).toBe(false)
  })

  it('POST /roots rejects missing dirs and bad bodies with 400', async () => {
    const bad = await app.request('/api/v1/skills/roots', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ dir: '/definitely/not/here' }),
    })
    expect(bad.status).toBe(400)
    const json = await bad.json()
    expect(json.error).toContain('目录不存在')

    const noBody = await app.request('/api/v1/skills/roots', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: 'not json',
    })
    expect(noBody.status).toBe(400)
  })

  it('marks env-configured roots as not removable', async () => {
    const { dir } = makeRoot('custom')
    writeSkill(dir, 'env-skill', 'name: env-skill\ndescription: from env\n')
    const prev = process.env.DAGENTS_SKILL_DIRS
    process.env.DAGENTS_SKILL_DIRS = dir
    try {
      const res = await app.request('/api/v1/skills?refresh=1')
      const json = (await res.json()) as { data: { roots: { dir: string; removable: boolean }[] } }
      const root = json.data.roots.find((r) => r.dir === dir)
      expect(root?.removable).toBe(false)
    } finally {
      if (prev === undefined) delete process.env.DAGENTS_SKILL_DIRS
      else process.env.DAGENTS_SKILL_DIRS = prev
    }
  })
})
