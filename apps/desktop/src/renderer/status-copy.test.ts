import { describe, expect, it } from 'vitest'
import type { ContentIntent, DesktopSnapshot, ServiceStatus } from '../main/orchestrator/types'
import {
  bootSteps,
  bootstrapBanner,
  blockingReason,
  describeService,
  enterWorkbenchAction,
  footerFacts,
  formatElapsed,
  globalLight,
  metaLine,
  pgPortChip,
  restartAction,
  serviceYieldChip,
  stopAction,
  waitingBudgetLine,
} from './status-copy'

// 启动态页文案层单测（U1）：真值表核心行 + 模式分叉 + 五步进度 + 动作位。
// 快照工厂最小化——只填被测分支用到的字段。

function svc(over: Partial<ServiceStatus> = {}): ServiceStatus {
  return {
    id: 'gateway',
    state: 'idle',
    attachMode: false,
    db: 'unknown',
    attempts: 0,
    lastExit: null,
    startedAt: null,
    message: null,
    ...over,
  }
}

function snap(over: {
  gateway?: Partial<ServiceStatus>
  console?: Partial<ServiceStatus>
  pg?: Partial<ServiceStatus>
  phase?: DesktopSnapshot['phase']
  intent?: ContentIntent
  runMode?: 'dev' | 'packaged'
  pgEmbedded?: boolean
  pgPort?: number | null
  healthTimeoutMs?: number
  gatewayYielded?: boolean
  consoleYielded?: boolean
  gatewayPort?: number
  consolePort?: number
} = {}): DesktopSnapshot {
  const runMode = over.runMode ?? 'packaged'
  const pgEmbedded = over.pgEmbedded ?? true
  return {
    phase: over.phase ?? 'boot',
    contentIntent: over.intent ?? 'auto',
    services: {
      gateway: svc({ id: 'gateway', ...over.gateway }),
      console: svc({ id: 'console', ...over.console }),
      pg: svc({ id: 'pg', ...over.pg }),
    },
    logTail: { gateway: [], console: [], pg: [] },
    config: {
      repoRoot: 'C:/repo',
      consoleUrl: 'http://localhost:3000',
      gatewayPort: over.gatewayPort ?? 8080,
      consolePort: over.consolePort ?? 3000,
      gatewayYielded: over.gatewayYielded ?? false,
      consoleYielded: over.consoleYielded ?? false,
      runMode,
      pgPort: over.pgPort ?? 55432,
      pgEmbedded,
      pgDataDir: 'C:/ud/pgdata',
      healthTimeoutMs: over.healthTimeoutMs ?? 120_000,
      logsDir: 'C:/ud/logs',
      appVersion: '0.0.0',
    },
    at: 1_000,
  }
}

/** 双健康基线（gateway running+db up，console running）。 */
const healthy = {
  gateway: { state: 'running' as const, db: 'up' as const },
  console: { state: 'running' as const },
  pg: { state: 'running' as const },
  phase: 'console' as const,
}

describe('metaLine 诚实文案（真值表核心行）', () => {
  it('S4 钉住 + 双健康：说「已停留」而非失真的「正在接管…」，并给出口', () => {
    const s = snap({ ...healthy, intent: 'boot' })
    // 钉住时窗口内容在 boot 页——phase 字段是服务健康判定，仍 console
    const text = metaLine(s)
    expect(text).toContain('已停留在此页')
    expect(text).toContain('进入工作台')
  })

  it('S5b 意愿等待：写明原因 + 「恢复后自动进入无需再点」', () => {
    const s = snap({ intent: 'console', gateway: { state: 'starting' } })
    const text = metaLine(s)
    expect(text).toContain('已记录「进入工作台」意愿')
    expect(text).toContain('网关未就绪')
    expect(text).toContain('无需再点')
  })

  it('S6 db:down 驻留：进程已起但数据库未就绪', () => {
    const s = snap({ gateway: { state: 'running', db: 'down' } })
    expect(metaLine(s)).toContain('数据库未就绪')
  })

  it('bootstrap 失败（S11）：明说启动已停止并指路横幅', () => {
    const s = snap({ pg: { state: 'failed', message: 'initdb 失败（exit=1）：…' } })
    expect(metaLine(s)).toContain('数据库初始化失败')
  })

  it('auto 双健康：正在接管（非钉住态如实）', () => {
    expect(metaLine(snap(healthy))).toContain('正在接管工作台')
  })

  it('普通启动中', () => {
    expect(metaLine(snap())).toContain('正在启动服务栈')
  })
})

describe('describeService 模式分叉（dev 话术不泄漏到 packaged）', () => {
  it('db:down + dev → docker compose 指引', () => {
    const s = snap({ runMode: 'dev', gateway: { state: 'running', db: 'down' } })
    const c = describeService('gateway', s.services.gateway, s)
    expect(c?.text).toContain('docker compose')
  })

  it('db:down + packaged 内嵌 → 内嵌恢复动作，零 docker 字样', () => {
    const s = snap({ runMode: 'packaged', gateway: { state: 'running', db: 'down' } })
    const c = describeService('gateway', s.services.gateway, s)
    expect(c?.text).toContain('内嵌数据库未就绪')
    expect(c?.text).not.toContain('docker')
    expect(c?.text).toContain('重试服务')
  })

  it('db:down + packaged 外部 PG → 「不代管」分支', () => {
    const s = snap({
      runMode: 'packaged',
      pgEmbedded: false,
      gateway: { state: 'running', db: 'down' },
    })
    const c = describeService('gateway', s.services.gateway, s)
    expect(c?.text).toContain('本应用不代管')
  })

  it('db:down + packaged 附加模式 → 外部实例分支', () => {
    const s = snap({
      runMode: 'packaged',
      gateway: { state: 'running', db: 'down', attachMode: true },
    })
    const c = describeService('gateway', s.services.gateway, s)
    expect(c?.text).toContain('外部服务数据库不可用')
  })

  it('SPAWN_FAILED + packaged → 安全软件/重装话术（不提 PATH/repoRoot）', () => {
    const s = snap({
      runMode: 'packaged',
      console: { state: 'failed', message: '启动失败：spawn pnpm ENOENT——检查命令是否在 PATH…' },
    })
    const c = describeService('console', s.services.console, s)
    expect(c?.text).toContain('安全软件拦截')
    expect(c?.text).toContain('spawn pnpm ENOENT') // 事实保留
    expect(c?.text).not.toContain('repoRoot')
  })

  it('SPAWN_FAILED + dev → 原文透传（dev 话术对 dev 用户正确）', () => {
    const s = snap({
      runMode: 'dev',
      console: { state: 'failed', message: '启动失败：spawn pnpm ENOENT——检查命令是否在 PATH…' },
    })
    expect(describeService('console', s.services.console, s)?.text).toContain('PATH')
  })

  it('pg 失败时 gateway/console idle 卡给「待命（等待数据库就绪）」（B6 不裸奔）', () => {
    const s = snap({ pg: { state: 'failed', message: 'x' } })
    const c = describeService('gateway', s.services.gateway, s)
    expect(c?.text).toContain('待命（等待数据库就绪）')
  })

  it('预算耗尽 failed → 补「重试清零预算」动作句', () => {
    const s = snap({
      gateway: { state: 'failed', message: '重启预算耗尽：5 分钟窗内已重启 3 次。手动「重试」将清零预算重新开始。' },
    })
    const c = describeService('gateway', s.services.gateway, s)
    expect(c?.tone).toBe('err')
    expect(c?.text).toContain('重试服务')
  })

  it('全停 → 「启动服务」指引（D8）', () => {
    const s = snap({
      gateway: { state: 'stopped' },
      console: { state: 'stopped' },
      pg: { state: 'stopped' },
    })
    expect(describeService('gateway', s.services.gateway, s)?.text).toContain('启动服务')
  })

  it('pg 附加跳过（idle+message）→ 「跳过：」前缀', () => {
    const s = snap({ pg: { state: 'idle', message: '附加模式：gateway 端口已被外部实例监听' } })
    const c = describeService('pg', s.services.pg, s)
    expect(c?.text).toContain('跳过：附加模式')
  })
})

describe('bootSteps 五步进度（B1/B5）', () => {
  it('全新首启：initdb 进行中 → ①◐ 其余 ○', () => {
    const s = snap({
      pg: { state: 'starting', message: '正在初始化数据目录 C:/ud/pgdata（首次启动需 initdb，约几秒）…' },
    })
    const marks = bootSteps(s).map((x) => x.mark)
    expect(marks).toEqual(['active', 'pending', 'pending', 'pending', 'pending'])
  })

  it('迁移进行中 → ①●②◐（无跳步）', () => {
    const s = snap({ pg: { state: 'starting', message: '正在应用数据库迁移…' } })
    const marks = bootSteps(s).map((x) => x.mark)
    expect(marks).toEqual(['done', 'active', 'pending', 'pending', 'pending'])
  })

  it('③亮起后 ④ 独立步：gateway running、console starting → [●,●,●,◐,○]', () => {
    const s = snap({
      pg: { state: 'running' },
      gateway: { state: 'running', db: 'up' },
      console: { state: 'starting' },
    })
    const marks = bootSteps(s).map((x) => x.mark)
    expect(marks).toEqual(['done', 'done', 'done', 'active', 'pending'])
  })

  it('双健康 auto → 全 ●（接管完成）', () => {
    const marks = bootSteps(snap(healthy)).map((x) => x.mark)
    expect(marks).toEqual(['done', 'done', 'done', 'done', 'done'])
  })

  it('钉住 + 双健康 → ⑤ ◐ 且 note 指向「进入工作台」（死路出口在步条上也有）', () => {
    const steps = bootSteps(snap({ ...healthy, intent: 'boot' }))
    expect(steps[4].mark).toBe('active')
    expect(steps[4].note).toContain('进入工作台')
  })

  it('外部 PG → ①② ◔ 跳过·使用外部数据库（B5）', () => {
    const s = snap({ pgEmbedded: false, ...healthy })
    const steps = bootSteps(s)
    expect(steps[0].mark).toBe('skipped')
    expect(steps[1].mark).toBe('skipped')
    expect(steps[0].note).toContain('外部数据库')
  })

  it('initdb 失败 → ①✕②○；迁移失败 → ①●②✕（失败步定位）', () => {
    const init = bootSteps(snap({ pg: { state: 'failed', message: 'initdb 失败（exit=1）：xxx' } }))
    expect([init[0].mark, init[1].mark]).toEqual(['failed', 'pending'])
    const mig = bootSteps(snap({ pg: { state: 'failed', message: '数据库迁移失败（exit=1）：yyy' } }))
    expect([mig[0].mark, mig[1].mark]).toEqual(['done', 'failed'])
  })
})

describe('bootstrapBanner（B6）', () => {
  it('pg failed → 红横幅：标题+错误原文+重试动作', () => {
    const b = bootstrapBanner(snap({ pg: { state: 'failed', message: '数据库迁移失败（exit=1）：relation missing' } }))
    expect(b?.title).toContain('数据库初始化失败')
    expect(b?.detail).toContain('relation missing')
    expect(b?.action).toBe('重试初始化')
  })

  it('非 failed（含迁移进行中）→ 无横幅', () => {
    expect(bootstrapBanner(snap({ pg: { state: 'starting', message: '正在应用数据库迁移…' } }))).toBeNull()
  })
})

describe('header 动作位（A1/A2/D8）', () => {
  it('钉住 + 双健康 → enabled + primary + 呼吸高亮（死路出口）', () => {
    const a = enterWorkbenchAction(snap({ ...healthy, intent: 'boot' }))
    expect(a.disabled).toBe(false)
    expect(a.primary).toBe(true)
    expect(a.breathe).toBe(true)
    expect(a.label).toContain('进入工作台')
  })

  it('不健康 → disabled 且 label 写明等什么（不静默）', () => {
    const a = enterWorkbenchAction(
      snap({ gateway: { state: 'running', db: 'up' }, console: { state: 'starting' } })
    )
    expect(a.disabled).toBe(true)
    expect(a.label).toContain('工作台服务未就绪')
  })

  it('重启按钮三分支：failed→重试服务(primary)，运行中→重启服务，全停→启动服务(primary)', () => {
    expect(restartAction(snap({ gateway: { state: 'failed' } })).label).toBe('重试服务')
    expect(restartAction(snap(healthy)).label).toBe('重启服务')
    const stopped = restartAction(
      snap({
        gateway: { state: 'stopped' },
        console: { state: 'stopped' },
        pg: { state: 'stopped' },
      })
    )
    expect(stopped.label).toBe('启动服务')
    expect(stopped.primary).toBe(true)
  })

  it('停止按钮：全停时 disabled', () => {
    expect(
      stopAction(
        snap({ gateway: { state: 'stopped' }, console: { state: 'stopped' }, pg: { state: 'stopped' } })
      ).disabled
    ).toBe(true)
    expect(stopAction(snap(healthy)).disabled).toBe(false)
  })
})

describe('等待预算（原则 3：等待回答等多久/预算多少）', () => {
  it('waiting_health 计时行 = 已等 + 运行时预算（不写死 120s）', () => {
    const s = snap({ healthTimeoutMs: 300_000, gateway: { state: 'waiting_health', startedAt: 10_000 } })
    expect(waitingBudgetLine(s.services.gateway, s, 70_000)).toBe('已等 1m00s / 预算 300s')
    expect(waitingBudgetLine(s.services.gateway, s, 40_000)).toBe('已等 30s / 预算 300s')
  })

  it('running/failed 不显示预算行', () => {
    const s = snap(healthy)
    expect(waitingBudgetLine(s.services.gateway, s, 99_999)).toBeNull()
  })

  it('formatElapsed：秒与分秒', () => {
    expect(formatElapsed(0)).toBe('0s')
    expect(formatElapsed(59_000)).toBe('59s')
    expect(formatElapsed(65_000)).toBe('1m05s')
  })
})

describe('让位端口与 footer（B4/D2；M9 三服务化）', () => {
  it('pg 让位 → 黄 chip 文案', () => {
    const s = snap({
      pgPort: 55433,
      pg: { state: 'running', message: '端口 :55433（默认 55432 被占用，已让位）' },
    })
    expect(pgPortChip(s)?.text).toContain(':55433')
    expect(pgPortChip(s)?.text).toContain('已让位')
  })

  it('pg 未让位 → 无 chip', () => {
    const s = snap({ pg: { state: 'running', message: '端口 :55432 · 数据目录 C:/ud/pgdata' } })
    expect(pgPortChip(s)).toBeNull()
  })

  it('gateway/console 让位 → 黄 chip 读快照实际端口（§18.2 单源）', () => {
    const s = snap({ gatewayYielded: true, gatewayPort: 8081, consoleYielded: true, consolePort: 3001 })
    expect(serviceYieldChip(s, 'gateway')?.text).toBe('端口 :8081（默认被占用，已让位）')
    expect(serviceYieldChip(s, 'console')?.text).toBe('端口 :3001（默认被占用，已让位）')
  })

  it('gateway/console 未让位 → 无 chip（默认端口形态零噪声）', () => {
    const s = snap()
    expect(serviceYieldChip(s, 'gateway')).toBeNull()
    expect(serviceYieldChip(s, 'console')).toBeNull()
  })

  it('footer：packaged/dev 模式行 + 数据目录行 + 版本行', () => {
    const p = footerFacts(snap(healthy))
    expect(p.modeLine).toContain('安装包内嵌')
    expect(p.pgLine).toContain('卸载不删除')
    expect(p.versionLine).toBe('Dagents v0.0.0')
    const d = footerFacts(snap({ ...healthy, runMode: 'dev' }))
    expect(d.modeLine).toContain('dev 栈')
  })
})

describe('globalLight 全局状态灯', () => {
  it('failed→红「启动受阻」；restarting→紫；双健康→绿；db down→黄', () => {
    expect(globalLight(snap({ pg: { state: 'failed', message: 'x' } })).tone).toBe('err')
    expect(globalLight(snap({ console: { state: 'restarting' } })).tone).toBe('restarting')
    expect(globalLight(snap(healthy)).tone).toBe('ok')
    expect(globalLight(snap({ gateway: { state: 'running', db: 'down' } })).tone).toBe('warn')
  })

  it('附加模式双服务 → 蓝「附加模式」', () => {
    const s = snap({
      gateway: { state: 'running', db: 'up', attachMode: true },
      console: { state: 'running', attachMode: true },
      pg: { state: 'idle', message: '附加模式：…' },
      phase: 'console',
    })
    expect(globalLight(s).label).toBe('附加模式 · 健康')
  })
})

describe('blockingReason（S5b 原因链）', () => {
  it('优先级：数据库 > 网关 > DB 连接 > 工作台服务', () => {
    expect(blockingReason(snap({ pg: { state: 'starting', message: '初始化数据目录…' } }))).toBe('数据库未就绪')
    expect(blockingReason(snap({ gateway: { state: 'starting' } }))).toBe('网关未就绪')
    expect(blockingReason(snap({ gateway: { state: 'running', db: 'down' } }))).toBe('数据库连接未就绪')
    expect(blockingReason(snap({ gateway: { state: 'running', db: 'up' }, console: { state: 'starting' } }))).toBe('工作台服务未就绪')
    expect(blockingReason(snap(healthy))).toBeNull()
  })

  it('外部 PG 时数据库步不阻塞原因（跳过即非阻塞）', () => {
    const s = snap({ pgEmbedded: false, gateway: { state: 'starting' }, pg: { state: 'idle', message: 'postgres.embedded=false' } })
    expect(blockingReason(s)).toBe('网关未就绪')
  })
})
