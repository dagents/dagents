/**
 * `/api/v1/agent-library/team-templates/*` — 团队场景工作流模板（Phase 3，D6）。
 *
 * agency-agents 的 10 条文档化工作流整合为 9 个静态模板：
 *   - README Scenario 1~6 的团队组合（6 条）；
 *   - examples/ 的 4 条工作流：workflow-landing-page（落地页冲刺）、
 *     workflow-book-chapter（书籍章节）、nexus-spatial-discovery（全机构并行发现）
 *     并入模板；workflow-startup-mvp 用于增强同名模板（7 人格 + 并行发现头）；
 *     workflow-with-memory 不单独立模板 —— 它解决的 copy-paste 交接痛点在
 *     dagents 引擎里天然不存在（边数据流自动把上游产出递给下游节点）。
 *
 * 步骤按 **人格 frontmatter name** 引用（不写死 library id，division 重组也不失效，
 * 真库 270 条已验证无重名；nexus 文档里的「Product Trend Researcher」库内实名
 * 为「Trend Researcher」，以库为准）。instantiate 时：
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
  /** linear = 顺序链；fan-out = 并行成员 + LLM 汇总；parallel-head = 头部并行 + 顺序尾。 */
  shape: 'linear' | 'fan-out' | 'parallel-head'
  /** parallel-head 专属：从 Start 并行扇出的头部步数（缺省 2），其后各步顺序汇合执行。 */
  parallelCount?: number
  steps: TeamStep[]
  /** fan-out 的汇总指令（llmAgentflow 节点）。 */
  synthesis?: string
  /** 运行输入引导：这条流程需要用户提供什么输入。实例化时写进 start 节点
   *  data.inputHint，画布/列表运行面板据此把引擎术语 placeholder 换成人话。 */
  inputHint: string
  /** 输入示例：持久展示在输入框下方（输入后也不消失）。 */
  inputExample: string
}

const TASK_HEADER =
  '这是团队工作流中的一步。根据上游输入完成本步职责，产出结构化、可被下游直接使用的结果。' +
  '在本次回复内直接给出完整产出——不要只描述计划、不要启动后台任务后就结束。'

export const TEAM_TEMPLATES: TeamTemplate[] = [
  {
    // 对齐 examples/workflow-startup-mvp.md：发现阶段（冲刺规划 ∥ 用户验证）并行起跑，
    // 产出汇合后进入架构 → 实现 → 原型 → 增长 → 质检的顺序主链（7 人格）。
    id: 'startup-mvp',
    name: '创业 MVP 构建',
    description: '冲刺规划 ∥ 用户验证并行起跑 → 后端架构 → 前端实现 → 原型整合 → 发布计划 → 上线质检，七人格把想法跑成可交付的原型。',
    icon: '🚀',
    shape: 'parallel-head',
    parallelCount: 2,
    steps: [
      { persona: 'Sprint Prioritizer', label: '冲刺规划', task: `${TASK_HEADER}\n你负责：把产品想法拆解为以周为单位的冲刺计划（每周交付物、验收标准、依赖顺序），识别范围蔓延风险。` },
      { persona: 'UX Researcher', label: '快速验证', task: `${TASK_HEADER}\n你负责：快速竞品分析——目标场景下哪些是标配功能、竞品短板在哪、我们能占住的一个差异化点，产出 1 页研究简报。` },
      { persona: 'Backend Architect', label: 'API 与数据模型', task: `${TASK_HEADER}\n你负责：综合冲刺计划与研究简报，设计 API 契约与数据库模型（实体、关系、关键接口），产出可直接指导实现的规格说明。` },
      { persona: 'Frontend Developer', label: '核心界面', task: `${TASK_HEADER}\n你负责：依据上游的 API 规格，规划核心界面的组件结构与数据流，产出组件清单与关键界面实现要点。` },
      { persona: 'Rapid Prototyper', label: '原型整合', task: `${TASK_HEADER}\n你负责：把前面的规格整合为一个最小可运行原型的落地计划（技术栈、目录结构、里程碑），强调速度与可迭代。` },
      { persona: 'Growth Hacker', label: '发布计划', task: `${TASK_HEADER}\n你负责：基于产品定位设计发布与增长计划（渠道假设、发布节奏、首周指标），产出可执行的实验清单。` },
      { persona: 'Reality Checker', label: '上线质检', task: `${TASK_HEADER}\n你负责：对以上全部产出做证据式审查（假设是否成立、指标是否可测、是否有遗漏风险），给出 GO / NO-GO 结论与修复清单。` },
    ],
    inputHint: '描述你的产品想法：解决什么问题、给谁用、核心功能、时间线与约束（技术栈 / 团队规模）',
    inputExample: '产品：RetroBoard——远程团队的实时回顾工具。时间线：4 周 MVP。核心功能：登录、创建回顾板、卡片、投票、行动项。约束：单人开发，React + Node.js。',
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
    inputHint: '描述要开发的企业功能：目标用户、业务价值、关键需求点与约束（合规 / 集成 / 性能）',
    inputExample: '为公司版工作区增加「跨部门审批流」：多级审批、与现有 SSO 集成、需要完整审计日志。',
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
    inputHint: '描述要发布的活动 / 产品：是什么、目标人群、发布时间窗与渠道偏好',
    inputExample: '产品：FlowSync（API 集成平台）下月发布。目标人群：中型公司的开发者和技术 PM。希望多平台同步造势。',
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
    inputHint: '描述要接管的广告账户：平台（Google / Meta…）、当前月消耗、主要痛点（若有）',
    inputExample: 'Google Ads 账户，月消耗 $8k，转化追踪疑似不准，CPC 持续走高，需要系统性重构。',
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
    inputHint: '描述要评估的产品机会：一句话概念、目标人群、你已有的判断或疑虑',
    inputExample: '机会：AI Agent 编排 × 空间计算的交叉点——为多 Agent 系统做空间化指挥中心（3D 关系图谱 + 实时监控）。',
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
    inputHint: '描述数字孪生项目：园区 / 校园范围、已有数据（BIM / GIS / 影像）、目标用途',
    inputExample: '大学校园数字孪生：12 栋楼已有 Revit 模型，园区 GIS 底图齐全，近期有无人机航拍；用于运维与参观导览。',
  },
  {
    // examples/workflow-landing-page.md：文案 ∥ 设计规格并行出稿 → 前端合流构建 → 增长复盘优化。
    id: 'landing-page-sprint',
    name: '落地页冲刺',
    description: '文案 ∥ 设计规格并行出稿，前端汇合构建单文件页面，增长复盘转化优化——一天节奏的多人格落地页流水线。',
    icon: '🎯',
    shape: 'parallel-head',
    parallelCount: 2,
    steps: [
      { persona: 'Content Creator', label: '页面文案', task: `${TASK_HEADER}\n你负责：产出转化导向的落地页全套文案——Hero（主标题+副标题+CTA）、痛点陈述、工作原理（3 步）、社会证明（占位格式）、定价分层、收尾 CTA，保持可扫读、无废话。` },
      { persona: 'UI Designer', label: '设计规格', task: `${TASK_HEADER}\n你负责：产出落地页设计规格——版式线框（分区顺序与间距）、色板（主/辅/强调/背景）、字体配对与字号阶梯、关键组件规格（Hero、特性卡、定价表、CTA）、响应式断点。` },
      { persona: 'Frontend Developer', label: '页面构建', task: `${TASK_HEADER}\n你负责：依据上游的文案与设计规格，产出单文件可部署的落地页（HTML + Tailwind，移动优先、无重资源、无障碍：语义标题/alt/焦点态，含可接通的注册表单）。` },
      { persona: 'Growth Hacker', label: '转化优化', task: `${TASK_HEADER}\n你负责：对构建产出做转化审查——CTA 是否在折叠线以上、价值主张 5 秒内是否清晰、注册流程有无摩擦、首批 A/B 测试清单、SEO 基础（meta/OG/结构化数据）。给具体修改，不给泛泛建议。` },
    ],
    inputHint: '描述要做的落地页：产品是什么、目标人群、语气偏好、定价结构（若有）',
    inputExample: '产品：FlowSync——5 分钟连接任意两个 SaaS 的 API 集成平台。受众：开发者和技术 PM。语气：自信简洁。定价 Free/Pro/Enterprise。',
  },
  {
    // examples/nexus-spatial-discovery.md：全机构 8 人格并行发现 + 交叉综合（cross-agent synthesis）。
    id: 'full-agency-discovery',
    name: '全机构并行发现',
    description: '市场验证 / 技术架构 / 品牌 / 增长 / 客服 / UX / 执行计划 / 空间界面 八路并行，LLM 交叉综合为统一机会结论与路线图。',
    icon: '🛰️',
    shape: 'fan-out',
    steps: [
      { persona: 'Trend Researcher', label: '市场验证', task: `${TASK_HEADER}\n你负责：市场验证简报——市场规模与增速、竞争格局（各家强项与 UX 缺口）、关键风险与分级，给出 CONDITIONAL GO / NO-GO 初判。` },
      { persona: 'Backend Architect', label: '技术架构', task: `${TASK_HEADER}\n你负责：技术架构简报——系统概览、技术栈选型、核心数据模型、实时通道与安全边界、MVP 分期与扩展目标。` },
      { persona: 'Brand Guardian', label: '品牌策略', task: `${TASK_HEADER}\n你负责：品牌策略简报——定位陈述、命名方向与验证、品牌人格与语气边界、差异化叙事。` },
      { persona: 'Growth Hacker', label: '增长计划', task: `${TASK_HEADER}\n你负责：GTM 简报——目标人群与定价分层、发布渠道、获客实验与首周指标。` },
      { persona: 'Support Responder', label: '客服蓝图', task: `${TASK_HEADER}\n你负责：客服运营蓝图——支持分级与 SLA、知识库结构、常见问题预案、上线首月支持节奏。` },
      { persona: 'UX Researcher', label: 'UX 方向', task: `${TASK_HEADER}\n你负责：UX 研究简报——用户画像、关键旅程图、核心设计原则与可用性风险。` },
      { persona: 'Project Shepherd', label: '执行计划', task: `${TASK_HEADER}\n你负责：项目执行简报——阶段化路线图、里程碑与工单拆解、依赖与关键路径。` },
      { persona: 'XR Interface Architect', label: '空间界面', task: `${TASK_HEADER}\n你负责：空间界面架构规范——布局与空间语法、交互模型、Agent 状态可视化（含各状态的设计处理）。` },
    ],
    synthesis:
      '你收到来自八个职能的全机构发现简报（市场验证 / 技术架构 / 品牌 / 增长 / 客服 / UX / 执行计划 / 空间界面）。请做交叉综合：机会陈述与 CONDITIONAL GO / NO-GO 结论、统一路线图（把各简报的行动项去重对齐到同一时间轴）、首要验证假设、各简报之间的冲突与未决问题。用简报作者的语言（如有中文则中文）输出，保留关键证据。',
    inputHint: '描述要全机构评估的机会：一句话概念、为什么是现在、目标人群',
    inputExample: '机会：Nexus Spatial——为多 Agent 系统提供空间化指挥中心（3D 关系图谱 + 实时监控），2D 优先、空间其次。',
  },
  {
    // examples/workflow-book-chapter.md：单人格但有明确产出契约的章节起草工作流。
    id: 'book-chapter',
    name: '书籍章节起草',
    description: '把粗素材（语音笔记/片段/战略笔记）转成强化品类定位的第一人称章节初稿，带显式修订循环与编辑注记。',
    icon: '📖',
    shape: 'linear',
    steps: [
      { persona: 'Book Co-Author', label: '章节起草', task: `${TASK_HEADER}\n你负责：把上游给的粗素材转化为章节初稿，按五段式产出契约输出——Target Outcome（本章目标与在书中的战略角色）、Chapter Draft（第一人称、一个明确承诺、主张挂靠素材或显式标记为假设、去除空泛励志语言）、Editorial Notes（假设与证据缺口）、Feedback Loop（修订循环安排）、Next Step（具体的下一步修订问题，不做含糊交接）。` },
    ],
    inputHint: '提供书籍背景与本章素材：书的目标与读者、本章主题、粗素材（语音笔记 / 片段 / 故事）、定位角度',
    inputExample: '书：务实 AI 落地（读者：中小企业老板）。本章：为什么大多数 AI 项目在实施前就失败。素材：「失败在预期设定不在工具」；差点上线错误自动化的故事。',
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
    ...(t.shape === 'parallel-head' ? { parallelCount: t.parallelCount ?? 2 } : {}),
    inputHint: t.inputHint,
    inputExample: t.inputExample,
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
    // label 中文化 + 携带输入引导：运行面板检测到 inputHint 就把引擎术语
    // placeholder 换成人话（第一次跑模板的用户才知道该输入什么）。
    data: {
      name: 'startAgentflow',
      label: '任务输入',
      inputHint: template.inputHint,
      inputExample: template.inputExample,
    },
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

  if (template.shape === 'parallel-head') {
    // Start → N 个并行头部 → 汇入首个顺序节点（mergeInputs 拼接 content）→ 顺序链 → DirectReply。
    const headCount = Math.min(Math.max(template.parallelCount ?? 2, 1), template.steps.length - 1)
    const laneGap = 200
    const heads = template.steps.slice(0, headCount).map((s, i) =>
      agentNode(s, `node_${i + 2}`, 250, 300 + (i - (headCount - 1) / 2) * laneGap),
    )
    const tail = template.steps.slice(headCount)
    const tailNodes = tail.map((s, i) => agentNode(s, `node_${headCount + i + 2}`, (i + 2) * 250, 300))
    const reply = replyNode(`node_${headCount + tail.length + 2}`, (tail.length + 1) * 250, 300)
    const nodes = [startNode, ...heads, ...tailNodes, reply]
    const edges = [
      ...heads.map((h, i) => ({ id: `edge_${i + 1}`, source: 'node_1', target: h.id })),
      ...heads.map((h, i) => ({ id: `edge_${headCount + i + 1}`, source: h.id, target: tailNodes[0].id })),
      ...tailNodes.slice(0, -1).map((n, i) => ({
        id: `edge_${headCount * 2 + i + 1}`,
        source: n.id,
        target: tailNodes[i + 1].id,
      })),
      { id: `edge_${headCount * 2 + tail.length}`, source: tailNodes[tailNodes.length - 1].id, target: reply.id },
    ]
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
