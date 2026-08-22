/**
 * Builtin template gate (产品方案 G 验收)：all shipped templates must pass
 * the single-source topology validator, the 2026-08-22 batch (7 new) must be
 * zero-dependency (no agentRefs → runs with no persona library and no
 * provider), and parameterized templates must surface their `{{var}}` params.
 */
import { describe, it, expect } from 'vitest'
import { validateFlowTopology } from '@dagents/workflow'
import { BUILTIN_FLOW_TEMPLATES } from '../flow-templates/builtin/index.js'
import { scanTemplateParams } from '../flow-template-pipeline.js'

/** The 2026-08-22 batch: pure-LLM chains, zero dependency by design. */
const ZERO_DEP_SLUGS = new Set([
  'builtin/code-review-chain',
  'builtin/refactor-plan',
  'builtin/bug-triage',
  'builtin/tech-comparison',
  'builtin/docs-readme',
  'builtin/translate-localize',
  'builtin/release-checklist',
])

describe('BUILTIN_FLOW_TEMPLATES gate', () => {
  it('ships at least 10 templates', () => {
    expect(BUILTIN_FLOW_TEMPLATES.length).toBeGreaterThanOrEqual(10)
  })

  it('every template passes topology validation with zero errors', () => {
    for (const tpl of BUILTIN_FLOW_TEMPLATES) {
      const verdict = validateFlowTopology(tpl.flowData)
      expect(verdict.ok, `${tpl.id}: ${verdict.ok ? '' : JSON.stringify(verdict.errors)}`).toBe(true)
    }
  })

  it('every template starts from startAgentflow and ends at a reply-capable node', () => {
    for (const tpl of BUILTIN_FLOW_TEMPLATES) {
      const names = tpl.flowData.nodes.map((n) => (n.data as { name?: string }).name)
      expect(names[0], tpl.id).toBe('startAgentflow')
      expect(
        names.includes('directReplyAgentflow') || names.includes('platformAgentAgentflow'),
        tpl.id,
      ).toBe(true)
    }
  })

  it('the 2026-08-22 batch is zero-dependency (no persona refs)', () => {
    for (const tpl of BUILTIN_FLOW_TEMPLATES) {
      if (ZERO_DEP_SLUGS.has(tpl.id)) {
        expect(tpl.agentRefs, tpl.id).toEqual([])
        // 零依赖同时意味着：全部节点为 start/LLM/DirectReply（无人格绑定节点）
        const kinds = new Set(tpl.flowData.nodes.map((n) => (n.data as { name?: string }).name))
        for (const kind of kinds) {
          expect(
            ['startAgentflow', 'llmAgentflow', 'directReplyAgentflow'].includes(kind as string),
            `${tpl.id}: unexpected node kind ${kind}`,
          ).toBe(true)
        }
      }
    }
  })

  it('parameterized templates scan their {{var}} params', () => {
    const byId = new Map(BUILTIN_FLOW_TEMPLATES.map((t) => [t.id, t]))
    const docs = byId.get('builtin/docs-readme')!
    expect(scanTemplateParams(docs.flowData).map((p) => p.name)).toEqual(['项目名'])
    const translate = byId.get('builtin/translate-localize')!
    expect(scanTemplateParams(translate.flowData).map((p) => p.name)).toEqual(['目标语言'])
    const release = byId.get('builtin/release-checklist')!
    expect(scanTemplateParams(release.flowData).map((p) => p.name)).toEqual(['版本号'])
    const review = byId.get('builtin/code-review-chain')!
    expect(scanTemplateParams(review.flowData).map((p) => p.name)).toEqual(['关注点'])
  })

  it('tech-comparison fans out in parallel (three branches from start)', () => {
    const tpl = byIdHelper('builtin/tech-comparison')
    const fanoutEdges = tpl.flowData.edges.filter((e) => e.source === 'node_1')
    expect(fanoutEdges.length).toBe(3)
    const convergeEdges = tpl.flowData.edges.filter((e) => e.target === 'node_5')
    expect(convergeEdges.length).toBe(3)
  })
})

function byIdHelper(id: string) {
  const tpl = BUILTIN_FLOW_TEMPLATES.find((t) => t.id === id)
  if (!tpl) throw new Error(`template not found: ${id}`)
  return tpl
}
