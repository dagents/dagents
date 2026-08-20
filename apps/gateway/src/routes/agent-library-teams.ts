/**
 * `/api/v1/agent-library/team-templates/*` — 团队场景工作流模板（Phase 3，D6）。
 *
 * agency-agents README 的 6 个团队组合（Scenario 1~6）预置为静态 flows 模板：
 * 步骤按 **人格 frontmatter name** 引用（不写死 library id，division 重组也不失效，
 * 真库 270 条已验证无重名）。instantiate 时：
 *   1. registry.getAll() 单次扫描解析全部 name → 库条目；有缺失 → 422 列出名字
 *      （上游改名/删条的显式失败，不做静默降级）；
 *   2. 已启用的成员复用 agents 行（library_meta 稳定键），缺的自动 slim 启用；
 *   3. 组装 FlowData（platformAgent 节点绑真实 agentId + 节点级任务指令——节点
 *      systemPrompt 追加在人格 instructions 之后，所以指令只写「这一步的职责」），
 *      落一行 draft flow。
 *
 * 挂载顺序：必须在 `/:division/:slug/instantiate` 之前注册（Hono 按注册顺序匹配，
 * `/team-templates/:id/instantiate` 与 `/:division/:slug/instantiate` 同形）——
 * app.ts 里本路由先 mount。
 */
import { Hono, type Context } from 'hono'
import type { ContentfulStatusCode } from 'hono/utils/http-status'
import { z } from 'zod'
import { runQuery } from '@dagents/db'
import { createLogger } from '@dagents/shared'
import { agentLibraryRegistry } from '../agent-library-registry.js'
import {
  findInstantiatedRows,
  insertLibraryAgent,
} from '../agent-library-instantiate.js'
import { INLINE_SUPPORTED_KINDS } from '../inline-executor.js'

export const agentLibraryTeamRoutes = new Hono()

const log = createLogger({ svc: 'gateway:agent-library-teams' })

const ok = <T>(c: Context, data: T) => c.json({ success: true, data })
const fail = (
  c: Context,
  status: ContentfulStatusCode,
  error: string,
  extra?: Record<string, unknown>,
) => c.json({ success: false, error, ...extra }, status)

export interface TeamStep {
  /** agency-agents frontmatter name —— 实例化时解析。 */
  persona: string
  /** 画布节点标签。 */
  label: string
  /** 节点级任务指令（追加在人格 instructions 后，只写这一步的职责）。 */
  task: string
}

export interface TeamTemplate {
  id: string
  name: string
  description: string
  icon: string
  /** linear = 顺序链；fan-out = 并行成员 + LLM 汇总。 */
  shape: 'linear' | 'fan-out'
  steps: TeamStep[]
  /** fan-out 的汇总指令（llmAgentflow 节点）。 */
  synthesis?: string
}

const TASK_HEADER =
  '这是团队工作流中的一步。根据上游输入完成本步职责，产出结构化、可被下游直接使用的结果。'

export const TEAM_TEMPLATES: TeamTemplate[] = [
  {
    id: 'startup-mvp',
    name: '创业 MVP 构建',
    description: '后端架构 → 前端实现 → 快速原型 → 增长计划 → 上线质检，五步把想法跑成可交付的原型。',
    icon: '🚀',
    shape: 'linear',
    steps: [
      { persona: 'Backend Architect', label: 'API 与数据模型', task: `${TASK_HEADER}\n你负责：设计本产品的 API 契约与数据库模型（实体、关系、关键接口），产出可直接指导实现的规格说明。` },
      { persona: 'Frontend Developer', label: '核心界面', task: `${TASK_HEADER}\n你负责：依据上游的 API 规格，规划核心界面的组件结构与数据流，产出组件清单与关键界面实现要点。` },
      { persona: 'Rapid Prototyper', label: '原型整合', task: `${TASK_HEADER}\n你负责：把前两步的规格整合为一个最小可运行原型的落地计划（技术栈、目录结构、里程碑），强调速度与可迭代。` },
      { persona: 'Growth Hacker', label: '增长计划', task: `${TASK_HEADER}\n你负责：基于原型定位，设计首批用户获取实验（渠道假设、病毒回路、转化指标），产出可执行的实验清单。` },
      { persona: 'Reality Checker', label: '上线质检', task: `${TASK_HEADER}\n你负责：对以上全部产出做证据式审查（假设是否成立、指标是否可测、是否有遗漏风险），给出 GO / NO-GO 结论与修复清单。` },
    ],
  },
  {
    id: 'enterprise-feature',
    name: '企业功能开发',
    description: '项目经理定范围 → UI 方案 → 资深开发实现 → 实验设计 → 证据验收 → 生产就绪认证。',
    icon: '👔',
    shape: 'linear',
    steps: [
      { persona: 'Senior Project Manager', label: '范围拆解', task: `${TASK_HEADER}\n你负责：把需求拆解为可执行的任务清单（含验收标准与依赖顺序），识别范围蔓延风险。` },
      { persona: 'UI Designer', label: '设计系统', task: `${TASK_HEADER}\n你负责：依据任务清单中的界面相关项，产出设计系统层面的方案（组件、状态、一致性约束）。` },
      { persona: 'Senior Developer', label: '复杂实现', task: `${TASK_HEADER}\n你负责：针对任务清单中的复杂实现项，产出实现方案（模式选择、边界情况、测试策略）。` },
      { persona: 'Experiment Tracker', label: '实验设计', task: `${TASK_HEADER}\n你负责：为本功能设计 A/B 实验（假设、分组、指标、样本量考量），确保上线即可度量。` },
      { persona: 'Evidence Collector', label: '证据验收', task: `${TASK_HEADER}\n你负责：列出验收所需的证据清单（截图、测试输出、指标基线），并给出收集方法。` },
      { persona: 'Reality Checker', label: '就绪认证', task: `${TASK_HEADER}\n你负责：综合以上产出做生产就绪认证，按证据给出放行条件与阻塞项。` },
    ],
  },
  {
    id: 'marketing-launch',
    name: '营销活动发布',
    description: '内容策划 → Twitter → Instagram → Reddit 社区 → 数据看板，多平台协同的活动发布流水线。',
    icon: '📣',
    shape: 'linear',
    steps: [
      { persona: 'Content Creator', label: '内容策划', task: `${TASK_HEADER}\n你负责：产出活动的多平台内容日历（主题、形式、发布节奏），作为后续各平台的统一输入。` },
      { persona: 'Twitter Engager', label: 'Twitter 策略', task: `${TASK_HEADER}\n你负责：基于内容日历产出 Twitter 侧的发布与互动策略（话题、时间窗、互动话术）。` },
      { persona: 'Instagram Curator', label: '视觉内容', task: `${TASK_HEADER}\n你负责：基于内容日历产出 Instagram 侧的视觉叙事方案（图文系列、风格一致性）。` },
      { persona: 'Reddit Community Builder', label: '社区运营', task: `${TASK_HEADER}\n你负责：基于内容日历产出 Reddit 侧的社区参与计划（版块选择、价值优先的发帖策略）。` },
      { persona: 'Analytics Reporter', label: '数据看板', task: `${TASK_HEADER}\n你负责：定义活动各平台的效果指标与看板结构，产出复盘模板。` },
    ],
  },
  {
    id: 'paid-media-takeover',
    name: '付费媒体接管',
    description: '账户审计 → 追踪校验 → 账户重构 → 搜索词清理 → 创意刷新 → 报告看板，30 天系统性接管。',
    icon: '💰',
    shape: 'linear',
    steps: [
      { persona: 'Paid Media Auditor', label: '账户审计', task: `${TASK_HEADER}\n你负责：对账户做结构化审计（结构、预算、出价、浪费点），产出优先级排序的问题清单。` },
      { persona: 'Tracking & Measurement Specialist', label: '追踪校验', task: `${TASK_HEADER}\n你负责：依据审计结果，校验转化追踪的完整性与准确性，产出修复清单（事件、归因、CAPI）。` },
      { persona: 'PPC Campaign Strategist', label: '账户重构', task: `${TASK_HEADER}\n你负责：基于审计与追踪结论，设计新的账户架构（系列划分、预算分配、出价策略）。` },
      { persona: 'Search Query Analyst', label: '搜索词清理', task: `${TASK_HEADER}\n你负责：产出搜索词清理方案（否定关键词分层、浪费 Spend 的收割路径）。` },
      { persona: 'Ad Creative Strategist', label: '创意刷新', task: `${TASK_HEADER}\n你负责：产出创意刷新计划（RSA 素材、疲劳预警指标、测试节奏）。` },
      { persona: 'Analytics Reporter', label: '报告看板', task: `${TASK_HEADER}\n你负责：把以上动作映射为 30 天接管节奏表与效果报告看板。` },
    ],
  },
  {
    id: 'product-discovery',
    name: '产品发现（并行）',
    description: '趋势研究 / 用户研究 / 技术可行 / 品牌定位 四路并行，LLM 汇总为统一产品计划。',
    icon: '🔍',
    shape: 'fan-out',
    steps: [
      { persona: 'Trend Researcher', label: '趋势研究', task: `${TASK_HEADER}\n你负责：市场与竞品情报（机会评估、趋势信号），独立产出一份研究简报。` },
      { persona: 'UX Researcher', label: '用户研究', task: `${TASK_HEADER}\n你负责：用户洞察（目标人群、核心痛点、既有替代方案），独立产出一份研究简报。` },
      { persona: 'Backend Architect', label: '技术可行', task: `${TASK_HEADER}\n你负责：技术可行性初判（架构路线、成本量级、主要技术风险），独立产出一份评估简报。` },
      { persona: 'Brand Guardian', label: '品牌定位', task: `${TASK_HEADER}\n你负责：品牌与定位角度的评估（差异化叙事、语气边界），独立产出一份简报。` },
    ],
    synthesis:
      '你收到四份来自不同职能的产品发现简报（趋势 / 用户研究 / 技术可行 / 品牌）。请把它们整合为一份统一的产品计划：机会陈述、目标用户、差异化定位、技术路线要点、首要验证假设与下一步行动。用简报作者的语言（如有中文则中文）输出，保留各简报的关键证据，标注冲突之处。',
  },
  {
    id: 'campus-twin',
    name: '智慧校园数字孪生',
    description: '策略定义 → BIM/GIS 转换 → Web 看板 → 影像提取 → 数据质检，地理管线式的数字孪生流水线。',
    icon: '🏫',
    shape: 'linear',
    steps: [
      { persona: 'Technical Consultant', label: '孪生策略', task: `${TASK_HEADER}\n你负责：定义数字孪生的分层策略（BIM 到楼宇、GIS 到园区、IoT 到实时），产出阶段化路线图。` },
      { persona: 'BIM/GIS Specialist', label: 'BIM→GIS', task: `${TASK_HEADER}\n你负责：依据路线图产出 Revit/IFC 到 GIS 场景层的转换方案与室内地图设计要点。` },
      { persona: 'Web GIS Developer', label: 'Web 看板', task: `${TASK_HEADER}\n你负责：产出校园 Web 看板的前端方案（图层设计、楼栋交互、房间检索）。` },
      { persona: 'GeoAI/ML Engineer', label: '影像提取', task: `${TASK_HEADER}\n你负责：产出无人机影像的 AI 提取方案（建筑轮廓、树冠、变化检测的模型与精度要求）。` },
      { persona: 'GIS QA Engineer', label: '数据质检', task: `${TASK_HEADER}\n你负责：定义发布前的数据质检门（拓扑、CRS 一致性、元数据、精度评估），产出检查清单。` },
    ],
  },
]

/** GET /team-templates — 静态目录（附成员解析状态，纯注册表查询，无 DB）。 */
agentLibraryTeamRoutes.get('/team-templates', (c) => {
  const entries = agentLibraryRegistry.getAll()
  const templates = TEAM_TEMPLATES.map((t) => ({
    id: t.id,
    name: t.name,
    description: t.description,
    icon: t.icon,
    shape: t.shape,
    members: t.steps.map((s) => {
      const entry = entries.find((e) => e.name === s.persona)
      return {
        persona: s.persona,
        label: s.label,
        libraryId: entry?.id ?? null,
        available: !!entry,
        division: entry?.division ?? null,
        emoji: entry?.emoji ?? null,
      }
    }),
  }))
  return ok(c, { templates })
})

const teamInstantiateSchema = z.object({
  profile: z.enum(['full', 'slim', 'minimal']).optional(),
  flow_name: z.string().min(1).max(128).optional(),
})

/**
 * POST /team-templates/:id/instantiate — 解析人格（缺失 422）→ 复用/启用成员
 * → 组装 FlowData → draft flow。幂等：重复调用复用已启用成员、新建 flow。
 */
agentLibraryTeamRoutes.post('/team-templates/:id/instantiate', async (c) => {
  const template = TEAM_TEMPLATES.find((t) => t.id === c.req.param('id'))
  if (!template) return fail(c, 404, `team template not found: ${c.req.param('id')}`)

  let parsed: z.infer<typeof teamInstantiateSchema>
  try {
    parsed = teamInstantiateSchema.parse((await c.req.json().catch(() => ({}))) ?? {})
  } catch (err) {
    return fail(c, 400, 'invalid team instantiate body', { detail: String(err) })
  }
  const profile = parsed.profile ?? 'slim'

  // 1. 单次扫描解析全部成员。
  const all = agentLibraryRegistry.getAll()
  const byName = new Map(all.map((e) => [e.name, e]))
  const missing = [...new Set(template.steps.map((s) => s.persona))].filter((n) => !byName.has(n))
  if (missing.length > 0) {
    return fail(c, 422, `库中未找到以下人格（可能上游已改名，请同步挂载目录后重试）`, { missing })
  }

  // 2. 复用已启用成员 / 自动启用缺失的。
  const uniquePersonas = [...new Set(template.steps.map((s) => s.persona))]
  const libraryIds = uniquePersonas.map((n) => byName.get(n)!.id)
  const existing = await findInstantiatedRows(libraryIds)
  const members: { persona: string; libraryId: string; agentId: string; enabled: boolean }[] = []
  for (const name of uniquePersonas) {
    const entry = byName.get(name)!
    const row = existing.get(entry.id)
    if (row) {
      members.push({ persona: name, libraryId: entry.id, agentId: row.id, enabled: true })
      continue
    }
    try {
      const agentId = await insertLibraryAgent(entry, {
        profile,
        kind: INLINE_SUPPORTED_KINDS[0], // 'claude' —— D2：人格宿主必须是 CLI 类型
      })
      members.push({ persona: name, libraryId: entry.id, agentId, enabled: false })
    } catch (err) {
      log.error('team instantiate: member insert failed', { persona: name, error: String(err) })
      return fail(c, 422, `成员「${name}」启用失败`, { detail: String(err) })
    }
  }
  const agentIdByPersona = new Map(members.map((m) => [m.persona, m.agentId]))

  // 3. 组装 FlowData。
  const flowData = buildTeamFlow(template, agentIdByPersona)

  // 4. 落 draft flow。
  let flowId: string
  try {
    const { records } = await runQuery<{ id: string }>(
      `INSERT INTO flows (name, description, flow_data, status)
       VALUES ($1, $2, $3, 'draft')
       RETURNING id`,
      [
        parsed.flow_name ?? template.name,
        `Agent Library 团队场景「${template.name}」: ${template.description}`,
        JSON.stringify(flowData),
      ],
    )
    flowId = records[0].id
  } catch (err) {
    log.error('team instantiate: flow insert failed', { error: String(err) })
    return fail(c, 422, '工作流创建失败', { detail: String(err) })
  }

  log.info('team instantiate ok', {
    templateId: template.id, flowId,
    members: members.length, newlyEnabled: members.filter((m) => !m.enabled).length,
  })
  return c.json(
    { success: true, data: { flowId, templateId: template.id, members, profile } },
    201,
  )
})

/** 组装画布 FlowData（节点结构对齐 tests/e2e/helpers/flow-builder 的平铺 data.<field>）。 */
function buildTeamFlow(
  template: TeamTemplate,
  agentIdByPersona: Map<string, string>,
): Record<string, unknown> {
  const agentNode = (step: TeamStep, id: string, x: number, y: number) => ({
    id,
    type: 'customNode',
    position: { x, y },
    data: {
      name: 'platformAgentAgentflow',
      label: step.label,
      inputs: {
        agentId: agentIdByPersona.get(step.persona),
        systemPrompt: step.task,
      },
    },
  })
  const startNode = {
    id: 'node_1',
    type: 'customNode',
    position: { x: 0, y: 300 },
    data: { name: 'startAgentflow', label: 'Start' },
  }
  const replyNode = (id: string, x: number, y: number) => ({
    id,
    type: 'customNode',
    position: { x, y },
    data: {
      name: 'directReplyAgentflow',
      label: 'Direct Reply',
      content: `✅ 团队工作流「${template.name}」执行完成，各步骤产出见上方节点。`,
    },
  })

  if (template.shape === 'linear') {
    const nodes = [
      startNode,
      ...template.steps.map((s, i) => agentNode(s, `node_${i + 2}`, (i + 1) * 250, 300)),
      replyNode(`node_${template.steps.length + 2}`, (template.steps.length + 1) * 250, 300),
    ]
    const edges = nodes.slice(0, -1).map((n, i) => ({
      id: `edge_${i + 1}`,
      source: n.id,
      target: nodes[i + 1].id,
    }))
    return { nodes, edges }
  }

  // fan-out：Start → N 个并行 agent → LLM 汇总 → DirectReply
  const laneGap = 200
  const agents = template.steps.map((s, i) =>
    agentNode(s, `node_${i + 2}`, 250, 300 + (i - (template.steps.length - 1) / 2) * laneGap),
  )
  const synthesis = {
    id: `node_${template.steps.length + 2}`,
    type: 'customNode',
    position: { x: 500, y: 300 },
    data: {
      name: 'llmAgentflow',
      label: '汇总',
      model: '',
      systemPrompt: template.synthesis ?? '汇总上游各分支的产出，输出统一结论。',
    },
  }
  const reply = replyNode(`node_${template.steps.length + 3}`, 750, 300)
  const nodes = [startNode, ...agents, synthesis, reply]
  const edges = [
    ...agents.map((a, i) => ({ id: `edge_${i + 1}`, source: 'node_1', target: a.id })),
    ...agents.map((a, i) => ({ id: `edge_${agents.length + i + 1}`, source: a.id, target: synthesis.id })),
    { id: `edge_${agents.length * 2 + 1}`, source: synthesis.id, target: reply.id },
  ]
  return { nodes, edges }
}
