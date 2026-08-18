/**
 * skill-injection.ts — compose agent system prompts with real skill bodies.
 *
 * 技能注册表的执行侧消费（根治「技能只能看不能用」）：把 console 里
 * Agent 声明的 `agents.skills`（kebab-case 名称数组）解析为 SKILL.md 的
 * 真实指令正文，拼进 system prompt。两条执行路径共用：
 *
 *   - inline-executor：正文经 `ExecOptions.systemPrompt` 传给 CLI 适配器
 *     （claude/codebuddy/pi 走 --append-system-prompt，openclaw 内联进
 *     消息；不支持系统提示的 CLI 由适配器自行丢弃）。
 *   - workflow-clients 的 agentFetcher：预先组装进 instructions 再交给
 *     PlatformAgentNode，避免节点层的技能名清单与正文重复声明。
 *
 * 尺寸护栏：单个技能 16k 字符、总计 48k 字符封顶（超出截断并标注），
 * 防止巨型 SKILL.md 撑爆上下文。找不到的技能名 warn 后跳过 —— 声明
 * 引用一个已删除/改名的能力不应该让整个执行失败。
 */
import { createLogger } from '@dagents/shared'
import { skillsRegistry, type SkillsRegistry } from './skills-registry.js'

const log = createLogger({ svc: 'gateway:skill-injection' })

/** Per-skill body cap (~4k tokens). */
export const MAX_SKILL_CHARS = 16_000
/** Total cap across all injected skills (~12k tokens). */
export const MAX_TOTAL_SKILL_CHARS = 48_000

const SKILL_HEADER =
  '## Skills\n\n' +
  'The agent has the following skills installed. Their full instructions are\n' +
  'included below — follow the relevant skill when the request calls for it.\n'

/**
 * Normalize the JSONB `agents.skills` column (unknown at the type level) into
 * a de-duplicated list of non-empty strings, preserving declaration order.
 */
export function normalizeSkillNames(skills: unknown): string[] {
  if (!Array.isArray(skills)) return []
  const seen = new Set<string>()
  const names: string[] = []
  for (const s of skills) {
    if (typeof s !== 'string') continue
    const name = s.trim()
    if (!name || seen.has(name)) continue
    seen.add(name)
    names.push(name)
  }
  return names
}

/**
 * Resolve skill names against the registry and render the markdown skill
 * section. Returns '' when nothing resolves (no names, or all missing).
 * The registry seam defaults to the process singleton; tests inject their own.
 */
export function buildSkillContext(
  names: string[],
  registry: Pick<SkillsRegistry, 'get'> = skillsRegistry,
): string {
  if (names.length === 0) return ''
  const sections: string[] = []
  let total = 0
  for (const name of names) {
    const def = registry.get(name)
    if (!def) {
      log.warn(`skill "${name}" declared on agent but not found in registry — skipped`)
      continue
    }
    let body = def.content.trim()
    if (body.length > MAX_SKILL_CHARS) {
      body = `${body.slice(0, MAX_SKILL_CHARS)}\n…(truncated, full definition in ${def.dir})`
    }
    let section = `### ${def.name}\n${def.description}\n\n${body}`
    const remaining = MAX_TOTAL_SKILL_CHARS - total
    if (remaining <= 0) {
      log.warn(`skill injection total cap reached, "${name}" dropped`)
      break
    }
    if (section.length > remaining) {
      section = `${section.slice(0, remaining)}\n…(truncated by total skill budget)`
    }
    total += section.length
    sections.push(section)
  }
  if (sections.length === 0) return ''
  return `${SKILL_HEADER}\n${sections.join('\n\n')}`
}

/**
 * Compose the final system prompt: agent instructions + injected skill
 * section. Empty instructions degrade to just the skill section (and vice
 * versa); both empty → undefined so no system prompt is passed at all.
 */
export function composeSystemPrompt(
  instructions: string | null | undefined,
  skills: unknown,
  registry: Pick<SkillsRegistry, 'get'> = skillsRegistry,
): string | undefined {
  const base = (instructions ?? '').trim()
  const context = buildSkillContext(normalizeSkillNames(skills), registry)
  if (base && context) return `${base}\n\n${context}`
  return base || context || undefined
}
