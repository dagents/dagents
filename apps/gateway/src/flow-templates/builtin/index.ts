/**
 * builtin/index.ts — 内置流程模板聚合（docs/flow-templates.md D3）。
 *
 * 静态 import 而非运行时 fs 读：gateway 以 `tsup src/index.ts` 单入口构建，
 * dist 不含额外源文件，JSON import 由打包器内联。新增内置模板 = 加一个
 * *.json + 下面一行 import + BUILTIN_TEMPLATES 一项（格式见 README.md）。
 */
import devThreeStep from './dev-three-step.json' with { type: 'json' }
import researchFanout from './research-fanout.json' with { type: 'json' }
import contentPipeline from './content-pipeline.json' with { type: 'json' }
import codeReviewChain from './code-review-chain.json' with { type: 'json' }
import refactorPlan from './refactor-plan.json' with { type: 'json' }
import bugTriage from './bug-triage.json' with { type: 'json' }
import techComparison from './tech-comparison.json' with { type: 'json' }
import docsReadme from './docs-readme.json' with { type: 'json' }
import translateLocalize from './translate-localize.json' with { type: 'json' }
import releaseChecklist from './release-checklist.json' with { type: 'json' }
import type { FlowTemplateSpec, TemplateCategory } from '../../flow-template-pipeline.js'

interface BuiltinFile {
  name: string
  description: string
  icon: string
  category: string
  flowData: { nodes: Record<string, unknown>[]; edges: Record<string, unknown>[] }
  agentRefs: FlowTemplateSpec['agentRefs']
}

const FILES: Array<{ slug: string; file: BuiltinFile }> = [
  { slug: 'dev-three-step', file: devThreeStep as BuiltinFile },
  { slug: 'research-fanout', file: researchFanout as BuiltinFile },
  { slug: 'content-pipeline', file: contentPipeline as BuiltinFile },
  { slug: 'code-review-chain', file: codeReviewChain as BuiltinFile },
  { slug: 'refactor-plan', file: refactorPlan as BuiltinFile },
  { slug: 'bug-triage', file: bugTriage as BuiltinFile },
  { slug: 'tech-comparison', file: techComparison as BuiltinFile },
  { slug: 'docs-readme', file: docsReadme as BuiltinFile },
  { slug: 'translate-localize', file: translateLocalize as BuiltinFile },
  { slug: 'release-checklist', file: releaseChecklist as BuiltinFile },
]

const CATEGORIES = new Set(['dev', 'research', 'content', 'ops', 'custom'])

export const BUILTIN_FLOW_TEMPLATES: FlowTemplateSpec[] = FILES.map(({ slug, file }) => ({
  id: `builtin/${slug}`,
  name: file.name,
  description: file.description,
  icon: file.icon,
  category: (CATEGORIES.has(file.category) ? file.category : 'custom') as TemplateCategory,
  source: 'builtin',
  flowData: file.flowData,
  agentRefs: file.agentRefs ?? [],
}))
