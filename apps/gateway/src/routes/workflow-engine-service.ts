import { DagExecutor, type FlowData, resolveNodeType } from '@dagents/workflow'
import { NodeRegistry } from '@dagents/workflow'
import type { Logger } from '@dagents/shared'
import { allNodes } from '@dagents/workflow'
import { makeIncrementalSpanWriter, type IncrementalSpanWriter } from '../span-writer.js'
import { forRunLive, type RunLiveTap } from '../run-live-registry.js'
import {
  createDefaultLlmClient,
  createAgentFetcher,
  createBuiltInToolRegistry,
  resetProviderCache,
} from './workflow-clients.js'

/**
 * 工作流引擎装配单一来源（2026-09-17 评审收敛）。
 *
 * 此前「NodeRegistry + DagExecutor + CLI-first clients + spanWriter」这段
 * 装配在三个入口各复制一份（workflows.ts 画布直跑 / chats.ts chat 流式 /
 * chat-execute.ts @flow），行为差异不是设计而是复制漂移的产物 —— @flow
 * 路径漏接 spanWriter 就是这么来的（该运行在画布旁观里永远「无进度」）。
 * 三个入口现在共用本函数；入口特有差异（sseStreamer / humanInputResolver
 * / 静态预供答案）由调用方在 baseOptions 之上 spread 合并。
 */

export interface AssembleWorkflowEngineOptions {
  flowData: FlowData
  runId: string
  flowId: string
  /** CLI 工作目录（项目目录语境）；缺省时 CLI 在网关进程 cwd 执行。 */
  cwd?: string
  /** 调用方 logger（span-writer 依赖注入，必传）。 */
  logger: Logger
}

export interface AssembledWorkflowEngine {
  executor: DagExecutor
  /** 增量节点进度（run_node_spans）；onNodeStart/End/Delta 已并入 baseOptions。 */
  spanWriter: IncrementalSpanWriter
  /** 运行实时终端的发射入口（与 spanWriter 同源旁路）；执行路径 settle
   *  时调用 `live.finish(runStatus)` 上报终态（漏报由注册表清扫器兜底）。 */
  live: RunLiveTap
  /** 节点 label/type 查找表（事后批量落库 spans 时复用）。 */
  nodeLabelById: Map<string, string | null>
  nodeTypeById: Map<string, string | null>
  /** executor.execute 的公共基座参数 —— 调用方 spread 后叠加自己的字段。 */
  baseOptions: {
    llmClient: ReturnType<typeof createDefaultLlmClient>
    agentFetcher: ReturnType<typeof createAgentFetcher>
    toolRegistry: ReturnType<typeof createBuiltInToolRegistry>
    onNodeStart: IncrementalSpanWriter['onNodeStart']
    onNodeEnd: IncrementalSpanWriter['onNodeEnd']
    onNodeDelta: IncrementalSpanWriter['onNodeDelta']
  }
}

export function assembleWorkflowEngine(opts: AssembleWorkflowEngineOptions): AssembledWorkflowEngine {
  const registry = new NodeRegistry()
  registry.registerMany(allNodes())
  const executor = new DagExecutor(registry)

  // Reset the LLM provider cache so each run picks up the latest config.
  resetProviderCache()
  // CLI-first：配了 provider 走 HTTP（加速），否则 LLM/Agent 节点全部跑
  // 本地 CLI —— 与聊天一致零配置可用。
  const llmClient = createDefaultLlmClient('claude', { cwd: opts.cwd, runId: opts.runId })
  const agentFetcher = createAgentFetcher()
  const toolRegistry = createBuiltInToolRegistry()

  // 节点 label/type 查找表：span 携带画布 inspector 同款人类可读元数据。
  // nodeType 用引擎同款解析（resolveNodeType：data.name 优先、type 回退，
  // 2026-09-22 单源化）—— 此前直接写画布渲染类型，画布保存的 flow 恒为
  // 'customNode'，console 终端 `$` 提示行随之退化成无信息的 "$ customNode"。
  const nodeLabelById = new Map<string, string | null>()
  const nodeTypeById = new Map<string, string | null>()
  for (const n of opts.flowData.nodes) {
    nodeLabelById.set(n.id, (n.data as { label?: string })?.label ?? n.id)
    nodeTypeById.set(n.id, resolveNodeType(n) ?? n.type ?? 'customNode')
  }
  const spanWriter = makeIncrementalSpanWriter({
    runId: opts.runId,
    flowId: opts.flowId,
    nodeLabelById,
    nodeTypeById,
    log: opts.logger,
  })

  // 运行实时终端（live attach）：钩子与 span-writer 组合旁路 —— 引擎的
  // start/end/delta（含插话回显：sink.onDelta 即引擎绑定的 onNodeDelta）
  // 一份进 DB 节流落库，一份进进程内帧缓冲实时分发。run 的 settle 由各
  // 执行路径显式 live.finish(status) 上报（漏报由注册表清扫器兜底收敛）。
  const live = forRunLive(opts.runId, opts.flowId, (nodeId) => nodeTypeById.get(nodeId) ?? null)

  return {
    executor,
    spanWriter,
    live,
    nodeLabelById,
    nodeTypeById,
    baseOptions: {
      llmClient,
      agentFetcher,
      toolRegistry,
      onNodeStart: (n) => {
        spanWriter.onNodeStart(n)
        live.nodeStart(n)
      },
      onNodeEnd: (n) => {
        spanWriter.onNodeEnd(n)
        live.nodeEnd(n)
      },
      onNodeDelta: (n, chunk) => {
        spanWriter.onNodeDelta(n, chunk)
        live.delta(n, chunk)
      },
    },
  }
}

/** 引擎执行状态 → runs 行 status（三入口共用映射，防再漂移）。 */
export function toRunStatus(executionStatus: string): 'completed' | 'cancelled' | 'failed' {
  if (executionStatus === 'success') return 'completed'
  if (executionStatus === 'cancelled') return 'cancelled'
  return 'failed'
}
