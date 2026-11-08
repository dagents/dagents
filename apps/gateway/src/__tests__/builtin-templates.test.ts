/**
 * Builtin template gate (产品方案 G 验收)：all shipped templates must pass
 * the single-source topology validator, the 2026-08-22 batch (7 new) must be
 * zero-dependency (no agentRefs → runs with no persona library and no
 * provider), and parameterized templates must surface their `{{var}}` params.
 */
import { describe, it, expect } from 'vitest'
import { validateFlowTopology, readNodePermission, PERMISSION_FIELDS } from '@dagents/workflow'
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
      expect(verdict.ok, `${tpl.id}: ${verdict.ok ? '' : JSON.stringify(verdict.errors)}`).toBe(
        true,
      )
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

  // R4 权限声明 gate（2026-10-07，AC-R4-6 内置半边）：现状 10 个内置模板
  // 零 http/customFunction 节点（断言空转通过）；未来新增模板凡出现此类
  // 节点必须带合法声明——gate 钉住「模板中心不发货未声明的权限面」。
  it('http/customFunction templates must carry valid permission declarations (R4 gate)', () => {
    for (const tpl of BUILTIN_FLOW_TEMPLATES) {
      for (const raw of tpl.flowData.nodes) {
        // 内置模板的 nodes 是宽松 JSON（Record<string, unknown>）——按引擎
        // 消费形态收窄（data.name 分发即 resolveNodeType 同款规则）
        const node = raw as unknown as { id: string; data: Record<string, unknown> }
        const kind = (node.data as { name?: string }).name
        if (kind === 'httpAgentflow') {
          const perm = readNodePermission(node, PERMISSION_FIELDS.domain)
          expect(
            perm.kind === 'declared' || perm.kind === 'absent',
            `${tpl.id}/${node.id}: allowedDomains ${perm.kind === 'invalid' ? `invalid: ${perm.reason}` : 'unexpected'}`,
          ).toBe(true)
          if (perm.kind === 'declared') {
            expect(
              perm.values.length,
              `${tpl.id}/${node.id}: 空 declared 等于全拒，模板不应声明空集`,
            ).toBeGreaterThan(0)
          }
        }
        if (kind === 'customFunctionAgentflow') {
          const perm = readNodePermission(node, PERMISSION_FIELDS.command)
          expect(perm.kind !== 'invalid', `${tpl.id}/${node.id}: allowedCommands invalid`).toBe(
            true,
          )
          const code = String(
            (node.data as Record<string, unknown>).functionCode ??
              (node.data as Record<string, unknown>).code ??
              '',
          )
          if (code.includes('$exec')) {
            expect(
              perm.kind === 'declared' && perm.values.length > 0,
              `${tpl.id}/${node.id}: 代码用 $exec 必须带非空 allowedCommands`,
            ).toBe(true)
          }
        }
      }
    }
  })
})

function byIdHelper(id: string) {
  const tpl = BUILTIN_FLOW_TEMPLATES.find((t) => t.id === id)
  if (!tpl) throw new Error(`template not found: ${id}`)
  return tpl
}
