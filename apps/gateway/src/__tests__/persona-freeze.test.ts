/**
 * persona 冻结行为断言（design-recover §3.6(b)，AC-R8-2「run 进行中修改
 * agent 人格 → 本 run 后续节点仍用创建期快照」的单测面）：
 *  - snapshotFlowAgents：run 创建期读 agents 行（skills 预解析进 instructions
 *    ——与 createAgentFetcher 同款 composeSystemPrompt）；
 *  - 闭包冻结 fetcher（assembleWorkflowEngine + frozenAgents）：**改库后**
 *    fetcher 仍回快照——run 执行中改人格不影响本 run；对照：无冻结的实时
 *    fetcher 回新值（差异可见 = AC 的「对照 run 可见差异」单测等价）；
 *  - resume 跨程注入（frozenAgents 快照对象直接注入）同款语义；
 *  - 快照空图（无 platformAgent 节点）→ null（不冻结，零开销）。
 *
 * fetcher 是节点取人格的唯一通道（PlatformAgentNode 的 agentFetcher）——
 * fetcher 级断言即「执行不受改库影响」的直接证明。
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { AppDataSource, runQuery } from '@dagents/db'
import { assertTestDatabase } from '../test-support/gw-test-db.js'
import {
  snapshotFlowAgents,
  assembleWorkflowEngine,
} from '../routes/workflow-engine-service.js'
import type { FlowData, PlatformAgentConfig } from '@dagents/workflow'
import { createLogger } from '@dagents/shared'

const AGENT_ID = '00000000-0000-4000-8000-00000000cc01'
const AGENT_ID_MISSING = '00000000-0000-4000-8000-00000000cc02'
const FLOW_ID = '00000000-0000-4000-8000-00000000cc03'

const log = createLogger({ svc: 'gateway:test:persona-freeze' })

/** 含一个 platformAgent 节点的图（agentId 平铺形态——快照扫描的两种形态之一）。 */
function agentFlow(): FlowData {
  return {
    nodes: [
      { id: 'a1', type: 'customNode', data: { name: 'platformAgentAgentflow', agentId: AGENT_ID } },
    ],
    edges: [],
  } as unknown as FlowData
}

beforeAll(async () => {
  if (!AppDataSource.isInitialized) await AppDataSource.initialize()
  assertTestDatabase(AppDataSource)
  // 列形状对齐 agent-library.test.ts 的插入先例（workspace_id NOT NULL）
  await runQuery(
    `INSERT INTO agents (id, workspace_id, owner_id, name, kind, instructions, skills, model, visibility)
     VALUES ($1::uuid, '00000000-0000-0000-0000-000000000000', 'system', 'Reviewer', 'claude',
             '原始人格指令', '[]'::jsonb, 'claude-opus', 'workspace')`,
    [AGENT_ID],
  )
})

afterAll(async () => {
  await runQuery(`DELETE FROM agents WHERE id = ANY($1::uuid[])`, [
    [AGENT_ID, AGENT_ID_MISSING],
  ]).catch(() => {})
})

describe('snapshotFlowAgents（run 创建期快照，§3.6(b)）', () => {
  it('读 agents 行 → 快照含 instructions/model/kind（skills 预解析同款）', async () => {
    const snapshot = await snapshotFlowAgents(agentFlow())
    expect(snapshot).not.toBeNull()
    expect(snapshot![AGENT_ID]).toMatchObject({
      id: AGENT_ID,
      model: 'claude-opus',
      kind: 'claude',
    })
    expect((snapshot![AGENT_ID] as PlatformAgentConfig).instructions).toContain('原始人格指令')
  })

  it('无 platformAgent 节点 → null（零快照开销）；agentId 缺席的行静默跳过', async () => {
    expect(await snapshotFlowAgents({ nodes: [], edges: [] } as FlowData)).toBeNull()
    const missingFlow = {
      nodes: [
        {
          id: 'a2',
          type: 'customNode',
          data: { name: 'platformAgentAgentflow', agentId: AGENT_ID_MISSING },
        },
      ],
      edges: [],
    } as unknown as FlowData
    // 缺席行：快照为空对象（truthy）但无该键——fetcher 返回 null 节点报错
    const snapshot = await snapshotFlowAgents(missingFlow)
    expect(snapshot).not.toBeNull()
    expect(snapshot![AGENT_ID_MISSING]).toBeUndefined()
  })
})

describe('闭包冻结 fetcher（AC-R8-2 行为断言：改库不影响本 run）', () => {
  it('冻结装配 → 改 agents 行 → fetcher 仍回创建期快照；对照（实时 fetcher）回新值', async () => {
    const snapshot = await snapshotFlowAgents(agentFlow())
    expect(snapshot).not.toBeNull()

    // 冻结装配（run 创建期注入快照——进程内闭包）
    const frozen = assembleWorkflowEngine({
      flowData: agentFlow(),
      runId: '00000000-0000-4000-8000-00000000cc11',
      flowId: FLOW_ID,
      logger: log,
      frozenAgents: snapshot as unknown as Record<string, unknown>,
    })
    // 对照装配（无冻结 = 既有行为，实时读库）
    const live = assembleWorkflowEngine({
      flowData: agentFlow(),
      runId: '00000000-0000-4000-8000-00000000cc12',
      flowId: FLOW_ID,
      logger: log,
    })

    // 「run 进行中修改 agent 人格」：直接改库
    await runQuery(
      `UPDATE agents SET instructions = '改后的人格指令', model = 'gpt-x' WHERE id = $1::uuid`,
      [AGENT_ID],
    )

    // 冻结 run 的后续节点：仍用创建期快照（AC-R8-2 主断言）
    const frozenConfig = await frozen.baseOptions.agentFetcher(AGENT_ID)
    expect(frozenConfig).toMatchObject({ model: 'claude-opus', kind: 'claude' })
    expect(frozenConfig!.instructions).toContain('原始人格指令')

    // 对照 run：实时 fetcher 读到新值（差异可见）
    const liveConfig = await live.baseOptions.agentFetcher(AGENT_ID)
    expect(liveConfig).toMatchObject({ model: 'gpt-x' })
    expect(liveConfig!.instructions).toContain('改后的人格指令')

    frozen.journal.close()
    live.journal.close()
    // 引用保持（组装即写侧挂接，无 run 执行无行）——void 使其成为合法
    // 表达式语句（no-unused-expressions）。
    void frozen.spanWriter
  })

  it('resume 跨进程注入（runs.frozen_agents 载荷）：同款不受改库影响', async () => {
    // resume 路径：路由读 runs.frozen_agents 传入——这里用「改库前的快照
    // 再注入」模拟跨进程（快照对象是持久化 JSON 的等价物）
    const staleSnapshot: Record<string, unknown> = {
      [AGENT_ID]: {
        id: AGENT_ID,
        name: 'Reviewer',
        instructions: '谱系冻结的人格',
        model: 'frozen-model',
        kind: 'claude',
        skills: [],
      },
    }
    const resumed = assembleWorkflowEngine({
      flowData: agentFlow(),
      runId: '00000000-0000-4000-8000-00000000cc13',
      flowId: FLOW_ID,
      logger: log,
      frozenAgents: staleSnapshot,
    })
    const config = await resumed.baseOptions.agentFetcher(AGENT_ID)
    expect(config).toMatchObject({ model: 'frozen-model' })
    expect(config!.instructions).toContain('谱系冻结的人格')
    resumed.journal.close()
  })
})
