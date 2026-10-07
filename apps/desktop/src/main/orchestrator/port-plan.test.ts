import { describe, expect, it } from 'vitest'
import {
  IDENTITY_ATTEMPTS,
  IDENTITY_TIMEOUT_MS,
  PORT_MAX_TRIES,
  planPortAllocation,
  type PlanPortDeps,
  type PlanPortInput,
} from './port-plan'
import type { HttpResult } from './supervisor'

// port-plan 单测（docs §18.1/§18.3 矩阵）：dev×stranger 诚实失败 / dev×dagents 附加 /
// packaged×free 默认 / packaged×stranger 让位+1 / 钉死×stranger 失败 / 候选耗尽 /
// 混合态 / gateway 附加→pg skipped / gatewayUrl·consoleUrl 派生 / 三态身份×两服务。
// deps 全注入（busy 端口集合 + 按 URL 路由的 HTTP 应答）——零真网络。

function mkDeps(opts: { busy?: Set<number>; route?: (url: string) => HttpResult } = {}) {
  const busy = opts.busy ?? new Set<number>()
  const logs: { id: string; line: string }[] = []
  const httpCalls: { url: string; timeoutMs: number }[] = []
  const deps: PlanPortDeps = {
    isPortOpen: async (p) => busy.has(p),
    httpGet: async (url, timeoutMs) => {
      httpCalls.push({ url, timeoutMs })
      return opts.route ? opts.route(url) : { error: 'ECONNREFUSED (no route)' }
    },
    log: (id, line) => logs.push({ id, line }),
  }
  return { deps, busy, logs, httpCalls }
}

const input = (over: Partial<PlanPortInput> = {}): PlanPortInput => ({
  runMode: 'packaged',
  gateway: { preferred: 8080, pinned: false },
  console: { preferred: 3000, pinned: false },
  pg: { preferred: 55432, enabled: true },
  ...over,
})

/** 身份路由：gateway /health 与 console / 各自的应答形状（§18.10 真形状）。 */
const GW_DAGENTS: HttpResult = { status: 200, body: '{"ok":true,"svc":"gateway","db":"up"}' }
const CS_DAGENTS: HttpResult = {
  status: 200,
  body: '<!doctype html><html><head><title>Dagents</title></head></html>',
}

describe('无人占用（两形态同构：默认端口直用）', () => {
  it('packaged×free：三服务 spawn 于默认端口，URL 派生', async () => {
    const w = mkDeps()
    const plan = await planPortAllocation(input(), w.deps)
    expect(plan.gateway).toEqual({ mode: 'spawn', port: 8080, yielded: false, reason: null })
    expect(plan.console).toEqual({ mode: 'spawn', port: 3000, yielded: false, reason: null })
    expect(plan.pg).toEqual({ mode: 'spawn', port: 55432, yielded: false })
    expect(plan.gatewayUrl).toBe('http://localhost:8080')
    expect(plan.consoleUrl).toBe('http://localhost:3000')
    expect(w.httpCalls).toEqual([]) // 端口空闲不做身份问询
  })

  it('dev×free：同构默认端口（dev 不漂移但空闲时行为一致）', async () => {
    const w = mkDeps()
    const plan = await planPortAllocation(input({ runMode: 'dev' }), w.deps)
    expect(plan.gateway.mode).toBe('spawn')
    expect(plan.console.mode).toBe('spawn')
    expect(plan.pg).toEqual({ mode: 'spawn', port: 55432, yielded: false })
  })
})

describe('被真 dagents 实例占用 → 附加（附加语义保留的核心）', () => {
  it('dev×dagents 双端口：双双 attach；pg skipped（外部栈自带数据库）', async () => {
    const w = mkDeps({
      busy: new Set([8080, 3000]),
      route: (url) => (url.includes('/health') ? GW_DAGENTS : CS_DAGENTS),
    })
    const plan = await planPortAllocation(input({ runMode: 'dev' }), w.deps)
    expect(plan.gateway.mode).toBe('attach')
    expect(plan.gateway.port).toBe(8080)
    expect(plan.console.mode).toBe('attach')
    expect(plan.pg).toBeNull() // gateway 附加 → pg 不启动
    expect(plan.gatewayUrl).toBe('http://localhost:8080')
    expect(plan.consoleUrl).toBe('http://localhost:3000')
  })

  it('gateway 503 db:down 形态也判 dagents（进程活语义，§18.3）', async () => {
    const w = mkDeps({
      busy: new Set([8080]),
      route: () => ({ status: 503, body: '{"ok":false,"svc":"gateway","db":"down"}' }),
    })
    const plan = await planPortAllocation(input(), w.deps)
    expect(plan.gateway.mode).toBe('attach')
  })
})

describe('被陌生程序占用（病灶①②的正面战场）', () => {
  it('dev×stranger → 诚实 failed + 指引文案（不静默让位）', async () => {
    const w = mkDeps({
      busy: new Set([8080]),
      route: () => ({ status: 200, body: '{"ok":true}' }), // 盲附加病灶形态
    })
    const plan = await planPortAllocation(input({ runMode: 'dev' }), w.deps)
    expect(plan.gateway.mode).toBe('failed')
    expect(plan.gateway.port).toBe(8080)
    expect(plan.gateway.reason).toContain('dev 形态固定端口 8080')
    expect(plan.gateway.reason).toContain('packaged')
  })

  it('packaged×stranger → 让位 +1（8081），reason 沿用 pg yielded 文案语义', async () => {
    const w = mkDeps({
      busy: new Set([8080]),
      route: () => ({ status: 200, body: '{"ok":true}' }),
    })
    const plan = await planPortAllocation(input(), w.deps)
    expect(plan.gateway).toEqual({
      mode: 'spawn',
      port: 8081,
      yielded: true,
      reason: '端口 :8081（默认 8080 被占用，已让位）',
    })
    expect(plan.gatewayUrl).toBe('http://localhost:8081')
  })

  it('packaged×stranger + 候选连续被占 → 递增到首个空闲（8082）', async () => {
    const w = mkDeps({
      busy: new Set([8080, 8081]),
      route: () => ({ status: 200, body: '<title>Vite</title>' }),
    })
    const plan = await planPortAllocation(input(), w.deps)
    expect(plan.gateway.port).toBe(8082)
    expect(plan.gateway.yielded).toBe(true)
  })

  it('packaged×console 陌生 HTML（Vite 形态占 3000）→ 让位 3001', async () => {
    const w = mkDeps({
      busy: new Set([3000]),
      route: (url) =>
        url.endsWith('/health') ? GW_DAGENTS : { status: 200, body: '<title>Vite + TS</title>' },
    })
    const plan = await planPortAllocation(input(), w.deps)
    expect(plan.console).toMatchObject({ mode: 'spawn', port: 3001, yielded: true })
    expect(plan.consoleUrl).toBe('http://localhost:3001')
  })

  it('钉死（portExplicit）×stranger → 两形态都诚实 failed 不让位', async () => {
    const route = () => ({ status: 200, body: '{"ok":true}' })
    for (const runMode of ['dev', 'packaged'] as const) {
      const w = mkDeps({ busy: new Set([9000]), route })
      const plan = await planPortAllocation(
        input({ runMode, gateway: { preferred: 9000, pinned: true } }),
        w.deps,
      )
      expect(plan.gateway.mode).toBe('failed')
      expect(plan.gateway.reason).toContain('钉死')
      expect(plan.gateway.reason).toContain('9000')
    }
  })

  it('候选耗尽（默认+19 全占）→ 诚实 failed 明示范围', async () => {
    const busy = new Set<number>()
    for (let i = 0; i < PORT_MAX_TRIES; i++) busy.add(3000 + i)
    // 默认端口上的监听者是陌生程序（才会进候选递增；候选段全占 → 耗尽）
    const w = mkDeps({ busy, route: () => ({ status: 200, body: '<title>Vite</title>' }) })
    const plan = await planPortAllocation(input(), w.deps)
    expect(plan.console.mode).toBe('failed')
    expect(plan.console.reason).toContain('3000–3019')
  })
})

describe('pg 分配（pickPgPort 语义平移 + dev 门控）', () => {
  it('packaged：默认被占 → 55433 让位', async () => {
    const w = mkDeps({ busy: new Set([55432]) })
    const plan = await planPortAllocation(input(), w.deps)
    expect(plan.pg).toEqual({ mode: 'spawn', port: 55433, yielded: true })
  })

  it('dev：默认被占 → 诚实 failed（不让位——固定端口纪律）', async () => {
    const w = mkDeps({ busy: new Set([55432]) })
    const plan = await planPortAllocation(input({ runMode: 'dev' }), w.deps)
    expect(plan.pg).toMatchObject({ mode: 'failed' })
    if (plan.pg !== null && plan.pg.mode === 'failed') {
      expect(plan.pg.reason).toContain('55432')
      expect(plan.pg.reason).toContain('不让位')
    }
  })

  it('耗尽（20 个全占）→ failed 诚实失败', async () => {
    const busy = new Set<number>()
    for (let i = 0; i < PORT_MAX_TRIES; i++) busy.add(55432 + i)
    const w = mkDeps({ busy })
    const plan = await planPortAllocation(input(), w.deps)
    expect(plan.pg).toMatchObject({ mode: 'failed' })
  })

  it('enabled=false → pg null（外部 PG 不参与分配）', async () => {
    const w = mkDeps()
    const plan = await planPortAllocation(
      input({ pg: { preferred: 55432, enabled: false } }),
      w.deps,
    )
    expect(plan.pg).toBeNull()
  })
})

describe('身份问询通道（10s 超时 + 1 重试，R16）', () => {
  it('超时/网络错 → 重试一次；两次都无应答 → stranger（packaged 让位路径）', async () => {
    const w = mkDeps({ busy: new Set([8080]), route: () => ({ error: 'TimeoutError' }) })
    const plan = await planPortAllocation(input(), w.deps)
    expect(w.httpCalls.length).toBe(IDENTITY_ATTEMPTS)
    expect(w.httpCalls[0]).toEqual({
      url: 'http://localhost:8080/health',
      timeoutMs: IDENTITY_TIMEOUT_MS,
    })
    expect(plan.gateway.mode).toBe('spawn') // stranger → packaged 让位
    expect(plan.gateway.yielded).toBe(true)
    expect(w.logs.some((l) => l.line.includes('按陌生程序处理'))).toBe(true)
  })

  it('首次无应答、重试命中 dagents → attach（冷编译窗口自愈）', async () => {
    let calls = 0
    const w = mkDeps({
      busy: new Set([3000]),
      route: (url) => {
        calls++
        if (url.endsWith('/') && calls === 1) return { error: 'TimeoutError' }
        return url.endsWith('/health') ? GW_DAGENTS : CS_DAGENTS
      },
    })
    const plan = await planPortAllocation(input(), w.deps)
    expect(plan.console.mode).toBe('attach')
    expect(w.logs.some((l) => l.line.includes('重试 2/2'))).toBe(true)
  })

  it('身份问询只发生在默认端口被占时（空闲零 HTTP 开销）', async () => {
    const w = mkDeps({ busy: new Set([8080]), route: () => GW_DAGENTS })
    await planPortAllocation(input(), w.deps)
    expect(w.httpCalls.map((c) => c.url)).toEqual(['http://localhost:8080/health'])
  })
})

describe('混合态（userStory 5：各端口独立判别）', () => {
  it('gateway 真 dagents 附加 + console 陌生占用让位自起 → GATEWAY_URL 指附加实例', async () => {
    const w = mkDeps({
      busy: new Set([8080, 3000]),
      route: (url) =>
        url.includes('/health') ? GW_DAGENTS : { status: 200, body: '<title>Vite</title>' },
    })
    const plan = await planPortAllocation(input(), w.deps)
    expect(plan.gateway.mode).toBe('attach')
    expect(plan.gateway.port).toBe(8080)
    expect(plan.console).toMatchObject({ mode: 'spawn', port: 3001, yielded: true })
    expect(plan.pg).toBeNull() // gateway 附加 → pg skipped
    // console BFF 的 GATEWAY_URL 指附加实例（8080），consoleUrl 指让位自起端口
    expect(plan.gatewayUrl).toBe('http://localhost:8080')
    expect(plan.consoleUrl).toBe('http://localhost:3001')
  })
})
