import { describe, it, expect } from 'vitest'
import { scanGeneratedFlowRisks } from '../routes/flow-generator.js'

/** 生成内容风险扫描（2026-09-17）——拓扑校验管形状，这里管攻击面。 */
describe('scanGeneratedFlowRisks', () => {
  it('customFunction 节点 → 代码执行警告', () => {
    const risks = scanGeneratedFlowRisks({
      nodes: [
        { id: 'n1', data: { name: 'startAgentflow' } },
        { id: 'n2', data: { name: 'customFunctionAgentflow', functionCode: 'return 1' } },
      ],
      edges: [{ id: 'e1', source: 'n1', target: 'n2' }],
    })
    expect(risks.some((r) => r.message.includes('CustomFunction') && r.message.includes('n2'))).toBe(true)
  })

  it('超长 functionCode（>16KB）→ 追加复核警告', () => {
    const risks = scanGeneratedFlowRisks({
      nodes: [{ id: 'big', data: { name: 'customFunctionAgentflow', functionCode: 'x'.repeat(17_000) } }],
      edges: [],
    })
    expect(risks.some((r) => r.message.includes('16KB'))).toBe(true)
  })

  it('HTTP 节点指向私网 → SSRF 预警（运行时必被守卫拦）', () => {
    const risks = scanGeneratedFlowRisks({
      nodes: [{ id: 'h1', data: { name: 'httpAgentflow', url: 'http://10.0.0.1/admin' } }],
      edges: [],
    })
    expect(risks.some((r) => r.message.includes('SSRF') || r.message.includes('内网'))).toBe(true)
  })

  it('HTTP 节点非 https → 协议警告；非法 URL → 解析警告', () => {
    const risks = scanGeneratedFlowRisks({
      nodes: [
        { id: 'h2', data: { name: 'httpAgentflow', url: 'http://api.example.com/x' } },
        { id: 'h3', data: { name: 'httpAgentflow', url: 'not a url' } },
      ],
      edges: [],
    })
    expect(risks.some((r) => r.message.includes('h2') && r.message.includes('https'))).toBe(true)
    expect(risks.some((r) => r.message.includes('h3') && r.message.includes('绝对地址'))).toBe(true)
  })

  it('干净图 → 零警告', () => {
    const risks = scanGeneratedFlowRisks({
      nodes: [
        { id: 's', data: { name: 'startAgentflow' } },
        { id: 'llm', data: { name: 'llmAgentflow', prompt: 'p' } },
      ],
      edges: [{ id: 'e1', source: 's', target: 'llm' }],
    })
    expect(risks).toEqual([])
  })
})
