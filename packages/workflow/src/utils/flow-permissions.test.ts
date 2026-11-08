import { describe, it, expect } from 'vitest'
import {
  readNodePermission,
  parsePermissionValue,
  isValidDomainEntry,
  isValidCommandEntry,
  isDomainAllowed,
  httpDomainPolicy,
  extractFlowPermissions,
  assertAllowedHttpDomain,
  type NodePermissionState,
  validatePermissionDeclarations,
  PERMISSION_FIELDS,
  MAX_DOMAINS_PER_NODE,
  MAX_COMMANDS_PER_NODE,
} from './flow-permissions.js'

/**
 * R4 权限单源（docs/zcode-borrow/design-permission.md §6.1）：
 * 语义阶梯（absent/declared-empty/invalid）是 fail-closed 心脏；
 * 同源钉子（AC-R4-4）钉「投影说的 = executor merge 后守卫读的」。
 */

/** 平铺形态（AI 生成）：配置直接在 data.<field>。 */
function flatNode(id: string, name: string, data: Record<string, unknown> = {}) {
  return { id, type: 'customNode', position: { x: 0, y: 0 }, data: { name, ...data } }
}

/** 画布形态：配置嵌套 data.inputs.<field>（覆盖平铺）。 */
function nestedNode(
  id: string,
  name: string,
  inputs: Record<string, unknown>,
  flat: Record<string, unknown> = {},
) {
  return { id, type: 'agentflowNode', position: { x: 0, y: 0 }, data: { name, ...flat, inputs } }
}

describe('readNodePermission 双形态归一', () => {
  it('undefined/null/空串/空白串 → absent', () => {
    for (const raw of [undefined, null, '', '   ']) {
      expect(
        readNodePermission(
          flatNode('n', 'httpAgentflow', { allowedDomains: raw }),
          'allowedDomains',
        ),
      ).toEqual({ kind: 'absent' })
    }
  })

  it('字段缺席 → absent', () => {
    expect(readNodePermission(flatNode('n', 'httpAgentflow'), PERMISSION_FIELDS.domain)).toEqual({
      kind: 'absent',
    })
  })

  it('[] → declared-empty（显式空集 = 全拒，不是未声明）', () => {
    expect(
      readNodePermission(
        flatNode('n', 'httpAgentflow', { allowedDomains: [] }),
        PERMISSION_FIELDS.domain,
      ),
    ).toEqual({
      kind: 'declared',
      values: [],
    })
  })

  it('合法数组 → declared（值原样）', () => {
    expect(
      readNodePermission(
        flatNode('n', 'httpAgentflow', { allowedDomains: ['api.github.com', 'Api.Example.COM'] }),
        PERMISSION_FIELDS.domain,
      ),
    ).toEqual({ kind: 'declared', values: ['api.github.com', 'Api.Example.COM'] })
  })

  it('非空字符串 / 对象 / 含非字符串条目 → invalid（fail-closed）', () => {
    for (const raw of ['api.github.com', '["ok"]', { 0: 'a' }, 42, [1, 2]]) {
      expect(
        readNodePermission(
          flatNode('n', 'httpAgentflow', { allowedDomains: raw }),
          'allowedDomains',
        ).kind,
      ).toBe('invalid')
    }
  })

  it('嵌套 inputs 覆盖平铺（与 executor merge 同规则）', () => {
    const node = nestedNode(
      'n',
      'httpAgentflow',
      { allowedDomains: ['api.github.com'] },
      { allowedDomains: ['flat.test'] },
    )
    expect(readNodePermission(node, PERMISSION_FIELDS.domain)).toEqual({
      kind: 'declared',
      values: ['api.github.com'],
    })
    // 平铺声明 + 嵌套未写该字段 → 平铺生效（nested undefined 不覆盖）
    const node2 = nestedNode(
      'n2',
      'httpAgentflow',
      { url: 'https://x.test' },
      { allowedDomains: ['flat.test'] },
    )
    expect(readNodePermission(node2, PERMISSION_FIELDS.domain)).toEqual({
      kind: 'declared',
      values: ['flat.test'],
    })
  })

  it('条目数超限 → invalid', () => {
    const tooManyDomains = Array.from({ length: MAX_DOMAINS_PER_NODE + 1 }, (_, i) => `d${i}.test`)
    expect(
      readNodePermission(
        flatNode('n', 'httpAgentflow', { allowedDomains: tooManyDomains }),
        'allowedDomains',
      ).kind,
    ).toBe('invalid')
    const tooManyCommands = Array.from({ length: MAX_COMMANDS_PER_NODE + 1 }, (_, i) => `cmd${i}`)
    expect(
      readNodePermission(
        flatNode('c', 'customFunctionAgentflow', { allowedCommands: tooManyCommands }),
        'allowedCommands',
      ).kind,
    ).toBe('invalid')
  })
})

describe('条目格式', () => {
  it('域名：合法 hostname / IP 通过', () => {
    for (const ok of [
      'api.github.com',
      'a.io',
      'sub.domain.example.org',
      '1.2.3.4',
      '::1',
      '[::1]',
      '2001:db8::1',
    ]) {
      expect(isValidDomainEntry(ok), ok).toBe(true)
    }
  })

  it('域名：port / scheme / 路径 / 通配符 / 单标签 / 空白全拒', () => {
    for (const bad of [
      'api.github.com:8080',
      'https://api.github.com',
      'api.github.com/path',
      '*.example.com',
      'a.*.com',
      'localhost',
      'my host',
      ' api.github.com',
      'api..com',
      '-lead.test',
      '256.1.1.1',
      '1.2.3',
      '',
    ]) {
      expect(isValidDomainEntry(bad), JSON.stringify(bad)).toBe(false)
    }
  })

  it('命令：裸命令名通过；路径/空白/子命令全拒', () => {
    for (const ok of ['git', 'rg', 'docker', 'node', 'a-b_c.d:e+f@1']) {
      expect(isValidCommandEntry(ok), ok).toBe(true)
    }
    for (const bad of [
      '/usr/bin/git',
      'C:\\tools\\git.exe',
      'git push', // 子命令属 args
      'git&&rm',
      '',
      ' git',
      '.hidden-start',
      'git\n',
    ]) {
      expect(isValidCommandEntry(bad), JSON.stringify(bad)).toBe(false)
    }
  })
})

describe('isDomainAllowed', () => {
  it('小写化精确匹配 + IPv6 方括号归一', () => {
    expect(isDomainAllowed('api.github.com', ['api.github.com'])).toBe(true)
    expect(isDomainAllowed('API.GitHub.com', ['api.github.com'])).toBe(true)
    expect(isDomainAllowed('api.gitlab.com', ['api.github.com'])).toBe(false)
    expect(isDomainAllowed('evil-api.github.com', ['api.github.com'])).toBe(false) // 前缀不算命中
    expect(isDomainAllowed('[::1]', ['::1'])).toBe(true)
  })
})

describe('httpDomainPolicy', () => {
  it("默认 'enforce'（2026-10-08 OQ-4 终裁）；warn/off 透传；未知值回落 enforce", () => {
    const prev = process.env.DAGENTS_HTTP_DOMAIN_POLICY
    try {
      delete process.env.DAGENTS_HTTP_DOMAIN_POLICY
      expect(httpDomainPolicy()).toBe('enforce')
      process.env.DAGENTS_HTTP_DOMAIN_POLICY = 'warn'
      expect(httpDomainPolicy()).toBe('warn')
      process.env.DAGENTS_HTTP_DOMAIN_POLICY = 'off'
      expect(httpDomainPolicy()).toBe('off')
      process.env.DAGENTS_HTTP_DOMAIN_POLICY = 'typo-value'
      expect(httpDomainPolicy()).toBe('enforce')
    } finally {
      if (prev === undefined) delete process.env.DAGENTS_HTTP_DOMAIN_POLICY
      else process.env.DAGENTS_HTTP_DOMAIN_POLICY = prev
    }
  })
})

describe('extractFlowPermissions 全图投影', () => {
  const mixed = {
    nodes: [
      flatNode('start', 'startAgentflow'),
      flatNode('h1', 'httpAgentflow', {
        url: 'https://api.github.com/x',
        allowedDomains: ['api.github.com'],
      }),
      flatNode('h2', 'httpAgentflow', { url: 'https://plain.test/y' }),
      nestedNode('h3', 'httpAgentflow', { url: 'https://z.test', allowedDomains: [] }),
      flatNode('c1', 'customFunctionAgentflow', {
        functionCode: 'return 1',
        allowedCommands: ['git', 'rg'],
      }),
      flatNode('c2', 'customFunctionAgentflow', { functionCode: 'return 2' }),
      flatNode('bad', 'httpAgentflow', { allowedDomains: 'not-an-array' }),
      flatNode('llm', 'llmAgentflow', { prompt: 'p' }),
    ],
    edges: [],
  }

  it('聚合闭合命令集/域名集/缺席/非法', () => {
    const p = extractFlowPermissions(mixed)
    expect(p.domainNodes).toHaveLength(2) // h1（declared）+ h3（declared-empty 也是 declared）
    expect(p.domainNodes.find((n) => n.nodeId === 'h1')?.domains).toEqual(['api.github.com'])
    expect(p.domainNodes.find((n) => n.nodeId === 'h3')?.domains).toEqual([])
    expect(p.domainNodes.find((n) => n.nodeId === 'h1')?.url).toBe('https://api.github.com/x')
    expect(p.undeclaredHttp).toEqual(['h2'])
    expect(p.commandNodes).toEqual([{ nodeId: 'c1', label: 'c1', commands: ['git', 'rg'] }])
    expect(p.invalid).toHaveLength(1)
    expect(p.invalid[0]?.node).toBe('bad')
  })

  it('无关节点零影响；label 缺省用 id', () => {
    const p = extractFlowPermissions({ nodes: [flatNode('s', 'startAgentflow')], edges: [] })
    expect(p).toEqual({
      commandNodes: [],
      domainNodes: [],
      undeclaredHttp: [],
      invalid: [],
      hasSubflow: false,
    })
  })

  it('executeFlow 节点 → hasSubflow=true', () => {
    const p = extractFlowPermissions({
      nodes: [
        flatNode('s', 'startAgentflow'),
        flatNode('sf', 'executeFlowAgentflow', { targetFlowId: 'x' }),
      ],
      edges: [],
    })
    expect(p.hasSubflow).toBe(true)
  })

  it('宽容任意输入形状（null/数组 nodes/空对象）', () => {
    expect(extractFlowPermissions(null).hasSubflow).toBe(false)
    expect(extractFlowPermissions({ nodes: 'nope' }).undeclaredHttp).toEqual([])
    expect(extractFlowPermissions({}).invalid).toEqual([])
  })

  it('【同源钉子·AC-R4-4】投影值逐字等于 executor merge 后的 inputs 值', () => {
    // 与 executor.ts mergedNodeInputs 相同的 merge 规则构造（平铺打底、嵌套覆盖）
    const mergedOf = (node: { data: Record<string, unknown> }): Record<string, unknown> => {
      const flat = node.data ?? {}
      const nested = flat.inputs
      if (nested && typeof nested === 'object' && !Array.isArray(nested)) {
        return { ...flat, ...(nested as Record<string, unknown>) }
      }
      return { ...flat }
    }
    for (const fixture of [
      flatNode('f1', 'httpAgentflow', { allowedDomains: ['a.test'] }),
      nestedNode(
        'f2',
        'httpAgentflow',
        { allowedDomains: ['b.test'] },
        { allowedDomains: ['flat.test'] },
      ),
      flatNode('f3', 'customFunctionAgentflow', { allowedCommands: ['git'] }),
      nestedNode('f4', 'customFunctionAgentflow', { allowedCommands: [] }, {}),
    ]) {
      const kind = String(fixture.data.name)
      const field = kind === 'httpAgentflow' ? PERMISSION_FIELDS.domain : PERMISSION_FIELDS.command
      const projection = extractFlowPermissions({ nodes: [fixture], edges: [] })
      const mergedValue = mergedOf(fixture)[field]
      // 投影集合逐字等于守卫将从 merged inputs 读到的集合（同一 parse 单源）
      expect(parsePermissionValue(mergedValue, field)).toEqual(
        kind === 'httpAgentflow'
          ? {
              kind: 'declared',
              values: projection.domainNodes[0]?.domains ?? [],
            }
          : {
              kind: 'declared',
              values: projection.commandNodes[0]?.commands ?? [],
            },
      )
    }
  })
})

describe('validatePermissionDeclarations（拓扑校验产出）', () => {
  it('非法声明 → error 带 node 定位；合法/缺席零产出', () => {
    const errors = validatePermissionDeclarations({
      nodes: [
        flatNode('h1', 'httpAgentflow', { allowedDomains: 'oops' }),
        flatNode('h2', 'httpAgentflow', { allowedDomains: ['ok.test'] }),
        flatNode('h3', 'httpAgentflow', {}),
        flatNode('c1', 'customFunctionAgentflow', { allowedCommands: 42 }),
        flatNode('c2', 'customFunctionAgentflow', { allowedCommands: ['git'] }),
        flatNode('c3', 'customFunctionAgentflow', {}),
        flatNode('x', 'llmAgentflow', { allowedDomains: 'wrong-field-type-but-not-http' }),
      ],
      edges: [],
    })
    expect(errors).toHaveLength(2)
    expect(errors[0]?.node).toBe('h1')
    expect(errors[0]?.message).toContain('allowedDomains')
    expect(errors[1]?.node).toBe('c1')
    expect(errors[1]?.message).toContain('allowedCommands')
  })

  it('非法条目（域名带 port）也判 invalid', () => {
    const errors = validatePermissionDeclarations({
      nodes: [flatNode('h', 'httpAgentflow', { allowedDomains: ['api.test:8080'] })],
      edges: [],
    })
    expect(errors).toHaveLength(1)
    expect(errors[0]?.message).toContain('port')
  })
})

describe('assertAllowedHttpDomain 守卫判定表（design §2.3 直测）', () => {
  const url = (u: string): URL => new URL(u)
  // 显式标 NodePermissionState（as const 会把 values 固成 readonly，与
  // 契约的可变 string[] 不兼容）
  const DECLARED: NodePermissionState = { kind: 'declared', values: ['api.github.com'] }
  const DECLARED_EMPTY: NodePermissionState = { kind: 'declared', values: [] }
  const ABSENT: NodePermissionState = { kind: 'absent' }
  const INVALID: NodePermissionState = { kind: 'invalid', reason: '应为字符串数组' }

  /** env 隔离包装（policy 现读 env，测完恢复）。 */
  const withPolicy = (policy: string | undefined, fn: () => void): void => {
    const prev = process.env.DAGENTS_HTTP_DOMAIN_POLICY
    if (policy === undefined) delete process.env.DAGENTS_HTTP_DOMAIN_POLICY
    else process.env.DAGENTS_HTTP_DOMAIN_POLICY = policy
    try {
      fn()
    } finally {
      if (prev === undefined) delete process.env.DAGENTS_HTTP_DOMAIN_POLICY
      else process.env.DAGENTS_HTTP_DOMAIN_POLICY = prev
    }
  }

  it('declared + 域名 ∈ 清单 → 任何策略放行（矩阵左上格）', () => {
    for (const policy of [undefined, 'enforce'] as const) {
      withPolicy(policy, () => {
        expect(() =>
          assertAllowedHttpDomain(url('https://api.github.com/x'), DECLARED, 'HTTP 节点 h'),
        ).not.toThrow()
      })
    }
  })

  it('declared + 域名 ∉ 清单（含 declared-empty）→ warn/enforce 都拒绝、错误含未声明域名与已声明清单', () => {
    for (const policy of ['warn', 'enforce'] as const) {
      withPolicy(policy, () => {
        expect(() =>
          assertAllowedHttpDomain(url('https://api.gitlab.com/x'), DECLARED, 'HTTP 节点 h'),
        ).toThrow(
          /h：目标域名 api\.gitlab\.com 未在 allowedDomains 声明（已声明：api\.github\.com）/,
        )
        expect(() =>
          assertAllowedHttpDomain(url('https://any.test/x'), DECLARED_EMPTY, 'HTTP 节点 h'),
        ).toThrow(/未在 allowedDomains 声明（已声明：）/)
      })
    }
  })

  it('absent × warn（显式逃生门）→ 放行且 onWarn 留痕（NFR-6 不静默；OQ-4 终裁后默认已是 enforce）', () => {
    withPolicy('warn', () => {
      const warns: string[] = []
      expect(() =>
        assertAllowedHttpDomain(url('https://plain.test/x'), ABSENT, 'HTTP 节点 h', {
          onWarn: (m) => warns.push(m),
        }),
      ).not.toThrow()
      expect(warns).toEqual(['域名清单未声明（warn 策略放行——enforce 默认下会拒跑，建议补声明）: plain.test'])
    })
  })

  it('absent × enforce → 拒绝并带「如何声明」指引（格式示例内嵌）', () => {
    withPolicy('enforce', () => {
      expect(() =>
        assertAllowedHttpDomain(url('https://plain.test/x'), ABSENT, 'HTTP 节点 h'),
      ).toThrow(/未声明 allowedDomains（网关已启用 enforce 策略）.*\["api\.github\.com"\]/s)
    })
  })

  it('invalid → deny-all 与策略无关（warn/enforce 都拒；合法域名也拒）', () => {
    for (const policy of ['warn', 'enforce'] as const) {
      withPolicy(policy, () => {
        expect(() =>
          assertAllowedHttpDomain(url('https://api.github.com/x'), INVALID, 'HTTP 节点 h'),
        ).toThrow(/allowedDomains 声明非法（应为字符串数组）——修复格式/)
      })
    }
  })

  it('off → 跳过本守卫（declared-but-violated / absent / invalid 全部不抛）', () => {
    withPolicy('off', () => {
      expect(() =>
        assertAllowedHttpDomain(url('https://evil.test/x'), DECLARED, 'HTTP 节点 h'),
      ).not.toThrow()
      expect(() =>
        assertAllowedHttpDomain(url('https://plain.test/x'), ABSENT, 'HTTP 节点 h'),
      ).not.toThrow()
      expect(() =>
        assertAllowedHttpDomain(url('https://any.test/x'), INVALID, 'HTTP 节点 h'),
      ).not.toThrow()
    })
  })
})
