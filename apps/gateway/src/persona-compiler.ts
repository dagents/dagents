/**
 * persona-compiler.ts — persona markdown 编译为可执行 instructions（纯函数）。
 *
 * Agent Library（`docs/agent-library.md` D3）的编译侧：库里的 agent 人格正文
 * 平均 13.9KB（最大 80KB，含大量 Deliverables 代码示例），原样进 systemPrompt
 * 会吃掉 ~3.5k+ tokens。instantiate/reimport 时按 profile 编译瘦身：
 *
 *   full    原文（去 frontmatter）
 *   slim    （默认）保留 Identity/Mission/Rules/Workflow/Success 等 H2 段，
 *           整段丢弃 Technical Deliverables（代码示例大头）
 *   minimal 只保留 Identity + Rules 段
 *
 * 段落按 H2 标题（`## `）切分；keep 列表匹配不到任何段时优雅回退
 * （minimal→slim→full），warn-and-skip 而不是产出空人格。
 * 尺寸护栏沿用 skill-injection 的模式：32k 字符硬顶 + 截断标注。
 *
 * 语言包络（D5）不进编译器 —— 由路由在 instantiate 时拼装，同一人格
 * 重编译可以换 profile 而包络语义不变。
 */
import { createHash } from 'node:crypto'

/** 单个人格 instructions 硬顶（≈8k tokens，对齐 skill-injection 的护栏风格）。 */
export const MAX_PERSONA_CHARS = 32_000
const TRUNCATION_MARK = '\n\n[persona truncated — see the Agent Library entry for the full definition]\n'

/** slim 档保留的 H2 段（按标题模糊匹配，容忍各家 agent 的标题措辞差异；
 * "Technical Deliverables"（代码示例大头）不命中任何 keep 模式，整段丢弃）。 */
const SLIM_KEEP = /identit|memor|mission|rule|workflow|success|metric/i
/** minimal 档保留的 H2 段。 */
const MINIMAL_KEEP = /identit|memor|rule/i

export type PersonaProfile = 'full' | 'slim' | 'minimal'

export const PERSONA_PROFILES: readonly PersonaProfile[] = ['full', 'slim', 'minimal']

export interface ParsedPersona {
  /** 展示名（frontmatter name，自由大小写，如 "Product Manager"）。 */
  name: string
  /** 单行简介（空白归一）。 */
  description: string
  /** 其余 frontmatter 键（color/emoji/vibe/tools…），无则 null。 */
  metadata: Record<string, unknown> | null
  /** 去 frontmatter 的 markdown 正文。 */
  body: string
}

/** frontmatter 键名 → ParsedPersona.metadata 的提取。 */
export function parsePersonaMarkdown(raw: string): ParsedPersona | null {
  const openFence = raw.match(/^---[ \t]*\r?\n/)
  if (!openFence) return null
  const afterOpen = raw.slice(openFence[0].length)
  const closing = afterOpen.match(/^---[ \t]*$/m)
  if (!closing || closing.index === undefined) return null

  // 逐行解析简单 YAML（frontmatter 均为 `key: value` 平面结构；数组值按原样
  // 保留字符串，不做 YAML 数组展开 —— tools 只用于展示标注）。
  const yamlText = afterOpen.slice(0, closing.index)
  const record: Record<string, string> = {}
  for (const line of yamlText.split(/\r?\n/)) {
    if (!line.trim() || line.trim().startsWith('#')) continue
    const m = line.match(/^([A-Za-z_][\w-]*)\s*:\s*(.*)$/)
    if (!m) continue
    record[m[1]] = m[2].replace(/^['"]|['"]$/g, '').trim()
  }

  const name = record.name ?? ''
  const description = (record.description ?? '').replace(/\s+/g, ' ').trim()
  if (!name || !description) return null
  // 折叠/块 YAML 指示符（`>` / `|` 系列）当前不支持：真库 270 条均为平面
  // `key: value`（2026-08-19 巡检），但上游若采用会静默产出「>」这类垃圾描述
  // —— 显式拒绝（warn-and-skip 由调用方记录）。
  if (/^[>|][+-]?$/.test(description)) return null

  const metadata: Record<string, unknown> = { ...record }
  delete metadata.name
  delete metadata.description
  const body = afterOpen.slice(closing.index + closing[0].length).replace(/^\r?\n/, '')
  return {
    name,
    description,
    metadata: Object.keys(metadata).length > 0 ? metadata : null,
    body,
  }
}

/** "Product Manager" → "product-manager"；非 ASCII/标点折叠，空结果兜底。 */
export function slugifyPersonaName(name: string): string {
  const slug = name
    .toLowerCase()
    .replace(/['’]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
  return slug || 'agent'
}

interface H2Section {
  heading: string
  text: string
}

/** 按 `## ` 标题切分正文；首段 H1 标题/前言不作为段落返回。 */
function splitH2Sections(body: string): H2Section[] {
  const sections: H2Section[] = []
  const lines = body.split(/\r?\n/)
  let current: H2Section | null = null
  for (const line of lines) {
    const m = line.match(/^##[ \t]+(.+?)[ \t]*$/)
    if (m) {
      if (current) sections.push(current)
      current = { heading: m[1], text: `${line}\n` }
    } else if (current) {
      current.text += `${line}\n`
    }
  }
  if (current) sections.push(current)
  return sections
}

function keepSections(body: string, pattern: RegExp, fallback: string): string {
  const kept = splitH2Sections(body)
    .filter((s) => pattern.test(s.heading))
    .map((s) => s.text.trimEnd())
    .join('\n\n')
  return kept || fallback
}

/** 按 profile 编译人格正文（不加密顶/包络 —— 调用方按需组合）。 */
export function compilePersonaBody(body: string, profile: PersonaProfile): string {
  if (profile === 'full') return body
  const slim = keepSections(body, SLIM_KEEP, body)
  if (profile === 'slim') return slim
  return keepSections(body, MINIMAL_KEEP, slim)
}

/** 32k 硬顶：超出截断并标注，绝不静默丢弃尾部。 */
export function capPersona(text: string, max = MAX_PERSONA_CHARS): string {
  if (text.length <= max) return text
  return text.slice(0, max) + TRUNCATION_MARK
}

export const LANGUAGE_ENVELOPE =
  '\n\n## Language\n\n' +
  'Always respond in the user\'s language. If the user writes Chinese, respond in Chinese.\n' +
  'Keep your persona, voice, and domain expertise unchanged.\n'

/** 语言包络（D5）：人格保持英文原文，回复语言跟随用户。 */
export function withLanguageEnvelope(body: string): string {
  return body + LANGUAGE_ENVELOPE
}

/** instantiate 的最终 instructions：编译 + 包络 + 硬顶。 */
export function buildPersonaInstructions(body: string, profile: PersonaProfile): string {
  return capPersona(withLanguageEnvelope(compilePersonaBody(body, profile)))
}

export function sha256Hex(s: string): string {
  return createHash('sha256').update(s, 'utf-8').digest('hex')
}

export type PersonaDriftState =
  | 'up-to-date'
  | 'upstream-updated'
  | 'locally-modified'
  | 'diverged'
  | 'missing-upstream'

export interface PersonaDriftInput {
  /** 库文件当前全文（含 frontmatter）的 sha256；库已无此条目时为 null。 */
  fileSha256: string | null
  /** library_meta.source_sha256（导入时的文件 sha）。 */
  sourceSha256: string | null
  /** agents 行当前 instructions。 */
  instructions: string | null
  /** library_meta.instructions_sha256_at_import（导入时 instructions sha）。 */
  instructionsSha256AtImport: string | null
}

/**
 * drift 三态（+diverged/missing-upstream）判定（D4）。instructions 的比较
 * 用「导入时哈希 vs 当前哈希」，因此换算子/换包络/换 profile 造成的合法变化
 * 也会被判 locally-modified —— reimport 前需要用户确认，这正是想要的行为。
 */
export function computePersonaDrift(input: PersonaDriftInput): PersonaDriftState {
  if (!input.fileSha256) return 'missing-upstream'
  const upstreamChanged = input.sourceSha256 !== input.fileSha256
  const locallyModified =
    !!input.instructionsSha256AtImport &&
    !!input.instructions &&
    sha256Hex(input.instructions) !== input.instructionsSha256AtImport
  if (upstreamChanged && locallyModified) return 'diverged'
  if (upstreamChanged) return 'upstream-updated'
  if (locallyModified) return 'locally-modified'
  return 'up-to-date'
}
