import { describe, expect, it } from 'vitest'
import { defaultConfig } from './config'
import { packagedRunSpecs, resolveRunMode } from './run-mode'

// join() 在 win32 产反斜杠——路径断言统一按正斜杠比较
const norm = (p: string) => p.replace(/\\/g, '/')

// run-mode 单测（docs §11.4 三级模式开关 + packaged spawn 规格）。纯函数直测。

describe('resolveRunMode（三级开关：显式 dev > 显式 packaged > auto 探测）', () => {
  it("mode:'dev' 显式 → 永远 dev（内嵌栈在位也不走 packaged——既有用户路径）", () => {
    expect(resolveRunMode({ mode: 'dev' }, { packagedServicesExists: true })).toBe('dev')
    expect(resolveRunMode({ mode: 'dev' }, { packagedServicesExists: false })).toBe('dev')
  })

  it("mode:'packaged' 显式 → 永远 packaged（resources 缺失会在启动时诚实失败，不静默回落）", () => {
    expect(resolveRunMode({ mode: 'packaged' }, { packagedServicesExists: false })).toBe('packaged')
  })

  it("mode:'auto'（默认）→ 内嵌栈在位 packaged，否则 dev", () => {
    expect(resolveRunMode({ mode: 'auto' }, { packagedServicesExists: true })).toBe('packaged')
    expect(resolveRunMode({ mode: 'auto' }, { packagedServicesExists: false })).toBe('dev')
  })

  it('defaultConfig 的 mode 默认 auto（零配置形态探测）', () => {
    expect(defaultConfig('C:/repo').mode).toBe('auto')
  })
})

describe('packagedRunSpecs（ELECTRON_RUN_AS_NODE 拉起内嵌栈，docs §11.1/§11.4 + §18.2 注入）', () => {
  const specs = packagedRunSpecs({
    servicesDir: 'C:/app/resources/services',
    execPath: 'C:/app/dagents.exe',
    extraEnv: { DAGENTS_FOO: 'bar' },
    gatewayPort: 8080,
    consolePort: 3000,
    gatewayUrl: 'http://localhost:8080',
  })

  it('gateway：execPath + deploy 产物 dist/index.js + GATEWAY_PORT（计划注入）', () => {
    expect(specs.gateway.command).toBe('C:/app/dagents.exe')
    expect(specs.gateway.args.map(norm)).toEqual(['C:/app/resources/services/gateway/dist/index.js'])
    expect(norm(specs.gateway.cwd)).toBe('C:/app/resources/services/gateway')
    expect(specs.gateway.env.ELECTRON_RUN_AS_NODE).toBe('1')
    expect(specs.gateway.env.GATEWAY_PORT).toBe('8080')
    expect(specs.gateway.env.DAGENTS_FOO).toBe('bar') // extraEnv 逃生门保留
  })

  it('console：execPath + standalone server.js + PORT/HOSTNAME/GATEWAY_URL/NODE_ENV（计划注入）', () => {
    expect(specs.console.args.map(norm)).toEqual([
      'C:/app/resources/services/console/apps/console/server.js',
    ])
    expect(norm(specs.console.cwd)).toBe('C:/app/resources/services/console')
    expect(specs.console.env).toMatchObject({
      ELECTRON_RUN_AS_NODE: '1',
      NODE_ENV: 'production',
      PORT: '3000',
      HOSTNAME: '127.0.0.1',
      GATEWAY_URL: 'http://localhost:8080',
    })
  })

  it('端口参数化（让位形态）：8081/3001 与派生 gatewayUrl 直接进 env，无字面量残留', () => {
    const yielded = packagedRunSpecs({
      servicesDir: 'C:/app/resources/services',
      execPath: 'C:/app/dagents.exe',
      extraEnv: {},
      gatewayPort: 8081,
      consolePort: 3001,
      gatewayUrl: 'http://localhost:8081',
    })
    expect(yielded.gateway.env.GATEWAY_PORT).toBe('8081')
    expect(yielded.console.env.PORT).toBe('3001')
    expect(yielded.console.env.GATEWAY_URL).toBe('http://localhost:8081')
    // extraEnv 写了计划键也会被计划值覆盖（placement 单源——展开顺序在后）
    const hijacked = packagedRunSpecs({
      servicesDir: 'C:/app/resources/services',
      execPath: 'C:/app/dagents.exe',
      extraEnv: { GATEWAY_PORT: '9999', PORT: '9999', GATEWAY_URL: 'http://evil' },
      gatewayPort: 8080,
      consolePort: 3000,
      gatewayUrl: 'http://localhost:8080',
    })
    expect(hijacked.gateway.env.GATEWAY_PORT).toBe('8080')
    expect(hijacked.console.env.PORT).toBe('3000')
    expect(hijacked.console.env.GATEWAY_URL).toBe('http://localhost:8080')
  })
})
