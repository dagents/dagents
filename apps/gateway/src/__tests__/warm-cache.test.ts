/**
 * warm-cache 单测（design-recover §⑥，R2.2/AC-R2-1 单测面）：
 *  - 保守传递闭包专项：改第 3 节点 prompt → 节点 1-2 命中、3-N 全 miss
 *    （hash 口径含上游输出——上游 miss 即断链，无需独立闭包算法）；
 *  - 链上最近优先（PRD R2.1）：多前驱同 hash 时取 candidates 序靠前者；
 *  - 诚实 miss（R2.6）：候选 run 全部查不到 → 零种子；
 *  - 分支图：被剪枝分支的节点不做候选（活动边判定与引擎同源）。
 */
import { describe, expect, it } from 'vitest'
import { planWarmCacheSeeds } from '../routes/warm-cache.js'
import type { FlowData } from '@dagents/workflow'

/** 5 节点线性链 fixture：start → n1(llm) → n2(llm) → n3(llm) → n4(llm)。 */
function linearFlow(): FlowData {
  const chain = ['start', 'n1', 'n2', 'n3', 'n4']
  const nodes = chain.map((id, i) => ({
    id,
    type: 'customNode',
    data:
      i === 0
        ? { name: 'startAgentflow', label: 'Start' }
        : {
            name: 'llmAgentflow',
            label: `LLM ${i}`,
            inputs: { systemPrompt: `prompt-${id}` },
          },
    position: { x: i * 200, y: 0 },
  }))
  const edges = chain.slice(0, -1).map((id, i) => ({
    id: `e${i}`,
    source: id,
    target: chain[i + 1]!,
  }))
  return { nodes, edges } as unknown as FlowData
}

/** 「前驱世界线」的 hash 表：跑一遍 planWarmCacheSeeds，lookup 对每节点
 *  返回假定输出（世界线延续——miss 会断链、下游无 hash 可记），同时记录
 *  每节点在其世界线位置上的 resolved 输入 hash。 */
async function hashesOfWorld(flowData: FlowData): Promise<Record<string, string>> {
  const hashes: Record<string, string> = {}
  await planWarmCacheSeeds({
    flowData,
    startInput: 'hello',
    chatId: 'chat-1',
    lookup: async (nodeId, inputHash) => {
      hashes[nodeId] = inputHash
      return { output: { content: `old-${nodeId}` } }
    },
  })
  return hashes
}

describe('planWarmCacheSeeds（R2 暖缓存匹配内核）', () => {
  it('全链命中：前驱 hash 全一致 → 全部节点种子命中（未改任何东西）', async () => {
    const flow = linearFlow()
    const world = await hashesOfWorld(flow)
    const seeds = await planWarmCacheSeeds({
      flowData: flow,
      startInput: 'hello',
      chatId: 'chat-1',
      lookup: async (nodeId, inputHash) =>
        world[nodeId] === inputHash ? { output: { content: `old-${nodeId}` } } : null,
    })
    expect(Object.keys(seeds).sort()).toEqual(['n1', 'n2', 'n3', 'n4', 'start'])
  })

  it('保守传递闭包（AC-R2-1）：改第 3 节点 prompt → 1-2 命中、3-4 全 miss', async () => {
    const flow = linearFlow()
    // 前驱世界线（旧 prompt-3）
    const world = await hashesOfWorld(flow)
    // 本轮 flow：n3 的 prompt 改了
    const modified = linearFlow()
    const n3 = modified.nodes.find((n) => n.id === 'n3') as unknown as {
      data: { inputs: { systemPrompt: string } }
    }
    n3.data.inputs.systemPrompt = 'prompt-n3-CHANGED'
    const seeds = await planWarmCacheSeeds({
      flowData: modified,
      startInput: 'hello',
      chatId: 'chat-1',
      lookup: async (nodeId, inputHash) =>
        world[nodeId] === inputHash ? { output: { content: `old-${nodeId}` } } : null,
    })
    // start/n1/n2 命中（输入未变）；n3 hash 已变 miss；n4 上游 miss → 断链 miss。
    expect(Object.keys(seeds).sort()).toEqual(['n1', 'n2', 'start'])
  })

  it('改运行输入 → 全链 miss（nodeInput 进 hash，AC-R3 口径）', async () => {
    const flow = linearFlow()
    const world = await hashesOfWorld(flow)
    const seeds = await planWarmCacheSeeds({
      flowData: flow,
      startInput: 'DIFFERENT-INPUT',
      chatId: 'chat-1',
      lookup: async (nodeId, inputHash) =>
        world[nodeId] === inputHash ? { output: { content: `old-${nodeId}` } } : null,
    })
    // start 即 miss（nodeInput = 输入本身），下游全断链。
    expect(Object.keys(seeds)).toEqual([])
  })

  it('链上最近优先（R2.1）：lookup 是「链上候选」的单点抽象——返回即最近前驱产出', async () => {
    const flow = linearFlow()
    const world = await hashesOfWorld(flow)
    let callCount = 0
    const seeds = await planWarmCacheSeeds({
      flowData: flow,
      startInput: 'hello',
      chatId: 'chat-1',
      // 返回内容须与 hash 世界线一致（输出进下游 nodeInput 的 hash——内容
      // 不同则下游断链，保守闭包的正确行为）。「最近优先」的排序职责在
      // repo 的 findLatestDecisionByNodeAndHash（SQL ORDER BY CASE），本内核
      // 只消费 lookup 的返回。
      lookup: async (nodeId, inputHash) => {
        callCount += 1
        return world[nodeId] === inputHash ? { output: { content: `old-${nodeId}` } } : null
      },
    })
    expect(callCount).toBe(5)
    expect(seeds['n2']).toEqual({ content: 'old-n2' })
  })

  it('诚实 miss（R2.6）：候选全查不到 → 零种子不报错', async () => {
    const seeds = await planWarmCacheSeeds({
      flowData: linearFlow(),
      startInput: 'hello',
      chatId: 'chat-1',
      lookup: async () => null,
    })
    expect(Object.keys(seeds)).toEqual([])
  })

  it('lookup 抛错不炸（catch → 当 miss 处理）', async () => {
    const seeds = await planWarmCacheSeeds({
      flowData: linearFlow(),
      startInput: 'hello',
      chatId: 'chat-1',
      lookup: async () => {
        throw new Error('db down')
      },
    })
    expect(Object.keys(seeds)).toEqual([])
  })
})
