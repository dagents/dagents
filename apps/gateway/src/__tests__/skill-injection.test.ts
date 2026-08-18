import { describe, it, expect, afterAll } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  buildSkillContext,
  composeSystemPrompt,
  normalizeSkillNames,
  MAX_SKILL_CHARS,
  MAX_TOTAL_SKILL_CHARS,
} from '../skill-injection.js'
import { SkillsRegistry } from '../skills-registry.js'

const tmpRoots: string[] = []

afterAll(() => {
  for (const dir of tmpRoots) rmSync(dir, { recursive: true, force: true })
})

function makeRegistry(): SkillsRegistry {
  const dir = mkdtempSync(join(tmpdir(), 'dagents-skill-injection-'))
  tmpRoots.push(dir)
  return new SkillsRegistry(() => [{ source: 'custom', dir, rank: 300 }])
}

function writeSkill(root: string, name: string, description: string, body = 'Do the thing.\n'): void {
  mkdirSync(join(root, name), { recursive: true })
  writeFileSync(join(root, name, 'SKILL.md'), `---\nname: ${name}\ndescription: ${description}\n---\n${body}`)
}

describe('normalizeSkillNames', () => {
  it('filters non-strings, empties, and duplicates while preserving order', () => {
    expect(normalizeSkillNames(['a', 3, 'b', 'a', ' ', '', null])).toEqual(['a', 'b'])
  })

  it('returns [] for non-array input (jsonb scalar / null)', () => {
    expect(normalizeSkillNames(undefined)).toEqual([])
    expect(normalizeSkillNames('not-array')).toEqual([])
  })
})

describe('buildSkillContext', () => {
  it('renders header + section per resolved skill', () => {
    const registry = makeRegistry()
    writeSkill(registry.roots()[0].dir, 'code-review', 'Reviews code diffs.')
    const ctx = buildSkillContext(['code-review'], registry)
    expect(ctx).toContain('#'.repeat(2) + ' Skills')
    expect(ctx).toContain('### code-review')
    expect(ctx).toContain('Reviews code diffs.')
    expect(ctx).toContain('Do the thing.')
  })

  it('skips names missing from the registry and returns "" when none resolve', () => {
    const registry = makeRegistry()
    writeSkill(registry.roots()[0].dir, 'real-one', 'Real.')
    expect(buildSkillContext(['ghost-skill'], registry)).toBe('')
    expect(buildSkillContext(['real-one', 'ghost-skill'], registry)).toContain('### real-one')
    expect(buildSkillContext(['ghost-skill'], registry)).not.toContain('ghost')
  })

  it('truncates oversized single bodies with a pointer to the source dir', () => {
    const registry = makeRegistry()
    const dir = registry.roots()[0].dir
    writeSkill(dir, 'huge-one', 'Big.', 'x'.repeat(MAX_SKILL_CHARS + 1000))
    const ctx = buildSkillContext(['huge-one'], registry)
    expect(ctx.length).toBeLessThan(MAX_SKILL_CHARS + 2000)
    expect(ctx).toContain('truncated, full definition in')
  })

  it('enforces the total budget across skills', () => {
    const registry = makeRegistry()
    const dir = registry.roots()[0].dir
    // Four skills each just under the per-skill cap: 4×15.5k ≈ 62k blows the
    // 48k total, so the fourth must come back truncated (3×15.5k ≈ 46.5k fits).
    writeSkill(dir, 'big-a', 'A.', 'a'.repeat(MAX_SKILL_CHARS - 500))
    writeSkill(dir, 'big-b', 'B.', 'b'.repeat(MAX_SKILL_CHARS - 500))
    writeSkill(dir, 'big-c', 'C.', 'c'.repeat(MAX_SKILL_CHARS - 500))
    writeSkill(dir, 'big-d', 'D.', 'd'.repeat(MAX_SKILL_CHARS - 500))
    const ctx = buildSkillContext(['big-a', 'big-b', 'big-c', 'big-d'], registry)
    expect(ctx.length).toBeLessThanOrEqual(MAX_TOTAL_SKILL_CHARS + 500)
    expect(ctx).toContain('### big-a')
    expect(ctx).toContain('### big-d')
    expect(ctx).toContain('truncated by total skill budget')
  })
})

describe('composeSystemPrompt', () => {
  it('joins instructions and skill section with a blank line', () => {
    const registry = makeRegistry()
    writeSkill(registry.roots()[0].dir, 'pdf', 'Makes PDFs.')
    const prompt = composeSystemPrompt('You are a builder.', ['pdf'], registry)
    expect(prompt).toBe(`You are a builder.\n\n${buildSkillContext(['pdf'], registry)}`)
  })

  it('degrades to skill-only / instructions-only / undefined', () => {
    const registry = makeRegistry()
    writeSkill(registry.roots()[0].dir, 'solo', 'Solo skill.')
    expect(composeSystemPrompt('', ['solo'], registry)).toBe(buildSkillContext(['solo'], registry))
    expect(composeSystemPrompt('Only instructions.', [], registry)).toBe('Only instructions.')
    expect(composeSystemPrompt('', [], registry)).toBeUndefined()
    expect(composeSystemPrompt(null, null, registry)).toBeUndefined()
  })
})
