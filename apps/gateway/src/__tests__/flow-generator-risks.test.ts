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
    expect(
      risks.some((r) => r.message.includes('CustomFunction') && r.message.includes('n2')),
    ).toBe(true)
  })

  it('超长 functionCode（>16KB）→ 追加复核警告', () => {
    const risks = scanGeneratedFlowRisks({
      nodes: [
        { id: 'big', data: { name: 'customFunctionAgentflow', functionCode: 'x'.repeat(17_000) } },
      ],
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

  // ── R4 权限声明风险扫描（2026-10-07）──────────────────────────────────

  it('http 节点未声明 allowedDomains → 过渡期提示警告', () => {
    const risks = scanGeneratedFlowRisks({
      nodes: [{ id: 'h9', data: { name: 'httpAgentflow', url: 'https://api.example.com/x' } }],
      edges: [],
    })
    expect(
      risks.some((r) => r.message.includes('h9') && r.message.includes('未声明 allowedDomains')),
    ).toBe(true)
  })

  it('已声明且静态 URL hostname ∉ 清单 → 运行时必拒预警', () => {
    const risks = scanGeneratedFlowRisks({
      nodes: [
        {
          id: 'h10',
          data: {
            name: 'httpAgentflow',
            url: 'https://api.gitlab.com/x',
            allowedDomains: ['api.github.com'],
          },
        },
      ],
      edges: [],
    })
    expect(
      risks.some(
        (r) =>
          r.message.includes('h10') &&
          // 正则而非 includes：CodeQL 把「对含 URL 的字符串 includes('api.gitlab.com')」
          // 误判为不完整 URL 子串校验（js/incomplete-url-substring-sanitization）——
          // 此处仅断言警告文案提到该域名，非安全校验，语义不变。
          /api\.gitlab\.com/.test(r.message) &&
          r.message.includes('不在 allowedDomains 清单内'),
      ),
    ).toBe(true)
  })

  it('静态 URL 在清单内 → 不出域名警告；模板变量 URL 跳过静态比对', () => {
    const risks = scanGeneratedFlowRisks({
      nodes: [
        {
          id: 'h11',
          data: {
            name: 'httpAgentflow',
            url: 'https://api.github.com/x',
            allowedDomains: ['api.github.com'],
          },
        },
        {
          id: 'h12',
          data: {
            name: 'httpAgentflow',
            url: 'https://{{host}}/x',
            allowedDomains: ['api.github.com'],
          },
        },
      ],
      edges: [],
    })
    expect(risks.some((r) => r.message.includes('h11'))).toBe(false)
    expect(
      risks.some(
        (r) => r.message.includes('h12') && r.message.includes('不在 allowedDomains 清单内'),
      ),
    ).toBe(false)
  })

  it('customFunction 代码用 $exec 而未声明 allowedCommands → 指引警告', () => {
    const risks = scanGeneratedFlowRisks({
      nodes: [
        {
          id: 'c9',
          data: {
            name: 'customFunctionAgentflow',
            functionCode: 'return $exec("git", []).then(() => 1)',
          },
        },
      ],
      edges: [],
    })
    expect(
      risks.some(
        (r) =>
          r.message.includes('c9') &&
          r.message.includes('$exec') &&
          r.message.includes('未声明 allowedCommands'),
      ),
    ).toBe(true)
    // 已声明 → 不出该警告
    const declared = scanGeneratedFlowRisks({
      nodes: [
        {
          id: 'c10',
          data: {
            name: 'customFunctionAgentflow',
            functionCode: 'return $exec("git", []).then(() => 1)',
            allowedCommands: ['git'],
          },
        },
      ],
      edges: [],
    })
    expect(declared.some((r) => r.message.includes('未声明 allowedCommands'))).toBe(false)
  })
})
