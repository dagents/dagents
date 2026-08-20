/**
 * persona-compiler 纯函数单测 —— Agent Library（docs/agent-library.md D3/D4/D5）
 * 的编译、瘦身、护栏、包络与 drift 判定。
 */
import { describe, it, expect } from 'vitest'
import {
  parsePersonaMarkdown,
  slugifyPersonaName,
  compilePersonaBody,
  capPersona,
  withLanguageEnvelope,
  buildPersonaInstructions,
  computePersonaDrift,
  sha256Hex,
  MAX_PERSONA_CHARS,
} from '../persona-compiler.js'

/** 结构对齐真实 agency-agents 文件的样例（frontmatter + H2 分节正文）。 */
const SAMPLE = `---
name: Product Manager
description: Holistic product leader who owns the full product lifecycle.
color: blue
emoji: 🧭
vibe: Ships the right thing.
tools: WebFetch, WebSearch
---

# 🧭 Product Manager Agent

## 🧠 Identity & Memory

You are **Alex**, a seasoned Product Manager. You think in outcomes, not outputs.

## 🎯 Core Mission

Own the product from idea to impact.

## 🚨 Critical Rules

1. **Lead with the problem.**
2. **Say no — clearly.**

## 🛠️ Technical Deliverables

### PRD

\`\`\`markdown
# PRD: [Feature Name]
...60 lines of template...
\`\`\`

## 🔄 Workflow Process

1. Discover. 2. Define. 3. Deliver.
`

describe('parsePersonaMarkdown', () => {
  it('parses frontmatter (free-case name, extras into metadata) and body', () => {
    const parsed = parsePersonaMarkdown(SAMPLE)
    expect(parsed).not.toBeNull()
    expect(parsed!.name).toBe('Product Manager')
    expect(parsed!.description).toBe('Holistic product leader who owns the full product lifecycle.')
    expect(parsed!.metadata).toMatchObject({ color: 'blue', emoji: '🧭', vibe: 'Ships the right thing.' })
    expect(parsed!.body).not.toContain('name: Product Manager')
    expect(parsed!.body).toContain('## 🧠 Identity & Memory')
  })

  it('rejects files without frontmatter or without name/description', () => {
    expect(parsePersonaMarkdown('# Just markdown\nNo frontmatter.')).toBeNull()
    expect(parsePersonaMarkdown('---\nname: Only Name\n---\nBody.')).toBeNull()
    expect(parsePersonaMarkdown('---\ndescription: Only desc\n---\nBody.')).toBeNull()
    expect(parsePersonaMarkdown('---\nname: X\ndescription: \n---\nBody.')).toBeNull()
  })
})

describe('slugifyPersonaName', () => {
  it('slugifies display names including punctuation and apostrophes', () => {
    expect(slugifyPersonaName('Product Manager')).toBe('product-manager')
    expect(slugifyPersonaName("X/Twitter Intelligence Analyst")).toBe('x-twitter-intelligence-analyst')
    expect(slugifyPersonaName("ZK Steward's Guide")).toBe('zk-stewards-guide')
    expect(slugifyPersonaName('SRE')).toBe('sre')
    expect(slugifyPersonaName('中文人格')).toBe('agent')
  })
})

describe('compilePersonaBody — profiles', () => {
  it('full keeps the body verbatim', () => {
    const parsed = parsePersonaMarkdown(SAMPLE)!
    expect(compilePersonaBody(parsed.body, 'full')).toBe(parsed.body)
  })

  it('slim keeps identity/mission/rules/workflow and drops deliverables', () => {
    const parsed = parsePersonaMarkdown(SAMPLE)!
    const slim = compilePersonaBody(parsed.body, 'slim')
    expect(slim).toContain('Identity & Memory')
    expect(slim).toContain('Core Mission')
    expect(slim).toContain('Critical Rules')
    expect(slim).toContain('Workflow Process')
    expect(slim).not.toContain('Technical Deliverables')
    expect(slim.length).toBeLessThan(parsed.body.length)
  })

  it('minimal keeps only identity + rules', () => {
    const parsed = parsePersonaMarkdown(SAMPLE)!
    const minimal = compilePersonaBody(parsed.body, 'minimal')
    expect(minimal).toContain('Identity & Memory')
    expect(minimal).toContain('Critical Rules')
    expect(minimal).not.toContain('Core Mission')
    expect(minimal).not.toContain('Workflow Process')
  })

  it('falls back gracefully when no section matches (minimal→slim→full)', () => {
    const noSections = 'Just prose, no H2 headings at all.'
    expect(compilePersonaBody(noSections, 'minimal')).toBe(noSections)
    const oddSections = '## Stuff\nThings.'
    expect(compilePersonaBody(oddSections, 'slim')).toBe(oddSections)
  })
})

describe('size guard + language envelope', () => {
  it('caps instructions at the hard limit with an explicit marker', () => {
    const huge = 'x'.repeat(MAX_PERSONA_CHARS + 5000)
    const capped = capPersona(huge)
    expect(capped.length).toBeLessThanOrEqual(MAX_PERSONA_CHARS + 200)
    expect(capped).toContain('[persona truncated')
  })

  it('envelope appends the language rule without touching the persona', () => {
    const wrapped = withLanguageEnvelope('You are Alex.')
    expect(wrapped.startsWith('You are Alex.')).toBe(true)
    expect(wrapped).toContain('respond in Chinese')
  })

  it('buildPersonaInstructions composes compile + envelope + cap', () => {
    const parsed = parsePersonaMarkdown(SAMPLE)!
    const instructions = buildPersonaInstructions(parsed.body, 'slim')
    expect(instructions).toContain('Identity & Memory')
    expect(instructions).not.toContain('Technical Deliverables')
    expect(instructions.endsWith('\n')).toBe(true)
  })
})

describe('computePersonaDrift — states', () => {
  const instructions = 'You are Alex.'
  const instructionsSha = sha256Hex(instructions)

  it('up-to-date when both hashes match', () => {
    expect(computePersonaDrift({
      fileSha256: 'f1', sourceSha256: 'f1',
      instructions, instructionsSha256AtImport: instructionsSha,
    })).toBe('up-to-date')
  })

  it('upstream-updated when the library file changed', () => {
    expect(computePersonaDrift({
      fileSha256: 'f2', sourceSha256: 'f1',
      instructions, instructionsSha256AtImport: instructionsSha,
    })).toBe('upstream-updated')
  })

  it('locally-modified when instructions drifted from import time', () => {
    expect(computePersonaDrift({
      fileSha256: 'f1', sourceSha256: 'f1',
      instructions: 'You are Alex (edited).', instructionsSha256AtImport: instructionsSha,
    })).toBe('locally-modified')
  })

  it('diverged when both changed; missing-upstream when the file is gone', () => {
    expect(computePersonaDrift({
      fileSha256: 'f2', sourceSha256: 'f1',
      instructions: 'edited', instructionsSha256AtImport: instructionsSha,
    })).toBe('diverged')
    expect(computePersonaDrift({
      fileSha256: null, sourceSha256: 'f1',
      instructions, instructionsSha256AtImport: instructionsSha,
    })).toBe('missing-upstream')
  })

  it('treats legacy rows without import hash as not locally modified', () => {
    expect(computePersonaDrift({
      fileSha256: 'f1', sourceSha256: 'f1',
      instructions, instructionsSha256AtImport: null,
    })).toBe('up-to-date')
  })
})

describe('parsePersonaMarkdown — frontmatter 边界（2026-08-20 巡检加固）', () => {
  it('strips matching quotes around values (real-library shape: color: "#7b2d8e")', () => {
    const parsed = parsePersonaMarkdown('---\nname: ZK Steward\ndescription: "Keeps the knowledge base tidy."\ncolor: "#333"\n---\nBody.')
    expect(parsed!.description).toBe('Keeps the knowledge base tidy.')
    expect(parsed!.metadata).toMatchObject({ color: '#333' })
  })

  it('rejects folded/block YAML indicator descriptions instead of storing ">"', () => {
    for (const bad of ['>', '|', '>-', '|+']) {
      expect(parsePersonaMarkdown(`---\nname: X\ndescription: ${bad}\n  folded text\n---\nBody.`)).toBeNull()
    }
  })

  it('parses CRLF frontmatter (Windows clones)', () => {
    const parsed = parsePersonaMarkdown('---\r\nname: CRLF Agent\r\ndescription: Windows line endings.\r\n---\r\nBody.')
    expect(parsed!.name).toBe('CRLF Agent')
    expect(parsed!.description).toBe('Windows line endings.')
    expect(parsed!.body).toContain('Body.')
  })

  it('keeps colons inside values (first-colon split only)', () => {
    const parsed = parsePersonaMarkdown('---\nname: Ops\nvibe: Rule 1: be exact. Rule 2: be kind.\ndescription: Does ops.\n---\nBody.')
    expect(parsed!.metadata).toMatchObject({ vibe: 'Rule 1: be exact. Rule 2: be kind.' })
  })
})
