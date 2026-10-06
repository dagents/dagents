import { describe, expect, it } from 'vitest'
import {
  ALL_STATES,
  createMachine,
  DB_DOWN_GUIDANCE,
  transition,
  type ServiceEvent,
} from './state-machine'
import type { RestartPolicy } from './types'

// 状态机全量单测（docs/desktop-architecture.md §6：全迁移表 / 重启窗口滑动耗尽 /
// 幂等 / db-down 不触发重启——纯逻辑，注入假时钟）。

const policy: RestartPolicy = {
  maxAttempts: 3,
  windowMs: 300_000,
  backoffMs: [1_000, 3_000, 9_000],
  healthTimeoutMs: 120_000,
}

let now = 1_000_000
const tick = (ms: number) => (now += ms)

/** 驱动到指定状态的便捷序列（从 idle 走主干到 running）。 */
function driveToRunning(id: 'gateway' | 'console' = 'gateway') {
  let m = createMachine(id)
  m = transition(m, { type: 'START' }, policy, now).machine
  m = transition(m, { type: 'SPAWNED', pid: 4242 }, policy, now).machine
  m = transition(m, { type: 'HEALTH_OK', db: 'up' }, policy, now).machine
  expect(m.status.state).toBe('running')
  return m
}

describe('主干迁移', () => {
  it('idle→starting→waiting_health→running', () => {
    const m = driveToRunning()
    expect(m.pid).toBe(4242)
    expect(m.status.db).toBe('up')
    expect(m.status.attachMode).toBe(false)
    expect(m.status.attempts).toBe(0)
  })

  it('spawn 失败 → failed（不自动重试，等手动）', () => {
    let m = createMachine('gateway')
    m = transition(m, { type: 'START' }, policy, now).machine
    const r = transition(m, { type: 'SPAWN_FAILED', error: 'spawn pnpm ENOENT' }, policy, now)
    expect(r.machine.status.state).toBe('failed')
    expect(r.machine.status.message).toContain('ENOENT')
    expect(r.effects).toEqual([]) // 不调度重启
  })

  it('健康 503 db:down → running + 引导文案（degraded 展示，不重启）', () => {
    let m = createMachine('gateway')
    m = transition(m, { type: 'START' }, policy, now).machine
    m = transition(m, { type: 'SPAWNED', pid: 1 }, policy, now).machine
    const r = transition(m, { type: 'HEALTH_OK', db: 'down' }, policy, now)
    expect(r.machine.status.state).toBe('running') // 进程活着，只是 DB 未就绪
    expect(r.machine.status.db).toBe('down')
    expect(r.machine.status.message).toBe(DB_DOWN_GUIDANCE)
    expect(r.machine.status.message).toContain('docker compose up')
    // 轮询切到运行期节拍
    expect(r.effects).toContainEqual({ kind: 'set-health-interval', ms: 5_000 })
  })

  it('运行中 db up↔down 翻转只更新子状态与文案，不产生重启副作用', () => {
    const m = driveToRunning()
    const down = transition(m, { type: 'HEALTH_OK', db: 'down' }, policy, now)
    expect(down.machine.status.db).toBe('down')
    expect(down.effects).toEqual([])
    const up = transition(down.machine, { type: 'HEALTH_OK', db: 'up' }, policy, now)
    expect(up.machine.status.db).toBe('up')
    expect(up.machine.status.message).toBeNull()
    expect(up.effects).toEqual([])
  })
})

describe('有界重启（规则 1：5 分钟窗 3 次，退避 1s/3s/9s）', () => {
  it('意外退出 → 退避调度；三次后第四次 → failed', () => {
    const m = driveToRunning()

    const r1 = transition(m, { type: 'EXIT', code: 1 }, policy, now)
    expect(r1.machine.status.state).toBe('restarting')
    expect(r1.machine.status.attempts).toBe(1)
    expect(r1.effects).toContainEqual({ kind: 'schedule-restart', delayMs: 1_000 })

    // 退避到期 → 重启 → 又健康 → 又退出（三次全在窗口内）
    tick(1_000)
    let r = transition(r1.machine, { type: 'RESTART_DUE' }, policy, now)
    expect(r.machine.status.state).toBe('starting')
    r = transition(r.machine, { type: 'SPAWNED', pid: 2 }, policy, now)
    r = transition(r.machine, { type: 'HEALTH_OK', db: 'up' }, policy, now)
    tick(60_000)

    const r2 = transition(r.machine, { type: 'EXIT', code: 1 }, policy, now)
    expect(r2.machine.status.attempts).toBe(2)
    expect(r2.effects).toContainEqual({ kind: 'schedule-restart', delayMs: 3_000 })

    tick(3_000)
    r = transition(r2.machine, { type: 'RESTART_DUE' }, policy, now)
    r = transition(r.machine, { type: 'SPAWNED', pid: 3 }, policy, now)
    r = transition(r.machine, { type: 'HEALTH_OK', db: 'up' }, policy, now)
    tick(60_000)

    const r3 = transition(r.machine, { type: 'EXIT', code: 1 }, policy, now)
    expect(r3.machine.status.attempts).toBe(3)
    expect(r3.effects).toContainEqual({ kind: 'schedule-restart', delayMs: 9_000 }) // 退避数组末位兜底

    tick(9_000)
    r = transition(r3.machine, { type: 'RESTART_DUE' }, policy, now)
    r = transition(r.machine, { type: 'SPAWNED', pid: 4 }, policy, now)
    r = transition(r.machine, { type: 'HEALTH_OK', db: 'up' }, policy, now)
    tick(60_000)

    const r4 = transition(r.machine, { type: 'EXIT', code: 1 }, policy, now)
    expect(r4.machine.status.state).toBe('failed')
    expect(r4.machine.status.attempts).toBe(3)
    expect(r4.machine.status.message).toContain('预算耗尽')
    expect(r4.effects).toContainEqual({ kind: 'clear-restart-timer' })
    expect(r4.effects).not.toContainEqual({ kind: 'schedule-restart', delayMs: expect.anything() })
  })

  it('窗口滑动：重启预算随时间过期复活', () => {
    let m = driveToRunning()
    m = transition(m, { type: 'EXIT', code: 1 }, policy, now).machine // t0，第 1 次
    tick(1_000)
    m = transition(m, { type: 'RESTART_DUE' }, policy, now).machine
    m = transition(m, { type: 'SPAWNED', pid: 2 }, policy, now).machine
    m = transition(m, { type: 'HEALTH_OK', db: 'up' }, policy, now).machine

    // 跑满窗口（>5min）后退出——t0 那次已滑出窗口，预算从 0 重新计数
    tick(301_000)
    const r = transition(m, { type: 'EXIT', code: 1 }, policy, now)
    expect(r.machine.status.attempts).toBe(1)
    expect(r.effects).toContainEqual({ kind: 'schedule-restart', delayMs: 1_000 })
  })

  it('健康超时按意外退出处理：先树终止（带 pid）再进重启预算', () => {
    const m = driveToRunning()
    const r = transition(m, { type: 'HEALTH_TIMEOUT' }, policy, now)
    expect(r.machine.status.state).toBe('restarting')
    expect(r.effects).toContainEqual({ kind: 'kill-tree', pid: 4242 })
    expect(r.effects).toContainEqual({ kind: 'stop-health-polling' })
  })

  it('RETRY 从 failed 清零预算重启', () => {
    let m = driveToRunning()
    // 耗尽预算
    for (let i = 0; i < 3; i++) {
      const rr = transition(m, { type: 'EXIT', code: 1 }, policy, now)
      m = transition(rr.machine, { type: 'RESTART_DUE' }, policy, tick(10_000)).machine
      m = transition(m, { type: 'SPAWNED', pid: 100 + i }, policy, now).machine
      m = transition(m, { type: 'HEALTH_OK', db: 'up' }, policy, now).machine
    }
    m = transition(m, { type: 'EXIT', code: 1 }, policy, now).machine
    expect(m.status.state).toBe('failed')

    const retry = transition(m, { type: 'RETRY' }, policy, now)
    expect(retry.machine.status.state).toBe('starting')
    expect(retry.machine.restartTimestamps).toEqual([])
    expect(retry.effects).toContainEqual({ kind: 'spawn' })
  })
})

describe('停止语义（规则 2：树终止 + 清预算 + 清 timer，幂等）', () => {
  it('running + STOP → stopped，kill-tree + 双清；重复 STOP 幂等', () => {
    const m = driveToRunning()
    const r = transition(m, { type: 'STOP' }, policy, now)
    expect(r.machine.status.state).toBe('stopped')
    expect(r.machine.pid).toBeNull()
    expect(r.machine.restartTimestamps).toEqual([])
    expect(r.effects).toContainEqual({ kind: 'kill-tree', pid: 4242 })
    expect(r.effects).toContainEqual({ kind: 'clear-restart-timer' })
    expect(r.effects).toContainEqual({ kind: 'stop-health-polling' })

    const again = transition(r.machine, { type: 'STOP' }, policy, now)
    expect(again.machine.status.state).toBe('stopped')
    expect(again.effects.some((e) => e.kind === 'kill-tree')).toBe(false)
  })

  it('restarting + STOP → stopped 且清掉 pending 重启定时器', () => {
    let m = driveToRunning()
    m = transition(m, { type: 'EXIT', code: 1 }, policy, now).machine
    const r = transition(m, { type: 'STOP' }, policy, now)
    expect(r.machine.status.state).toBe('stopped')
    expect(r.effects).toContainEqual({ kind: 'clear-restart-timer' })
    // stopped 状态下退避到期事件被忽略
    const due = transition(r.machine, { type: 'RESTART_DUE' }, policy, now)
    expect(due.machine.status.state).toBe('stopped')
  })

  it('STOP 后 EXIT（树终止引发的 exit 事件）被忽略', () => {
    const m = driveToRunning()
    const stopped = transition(m, { type: 'STOP' }, policy, now).machine
    const exited = transition(stopped, { type: 'EXIT', code: 1 }, policy, now)
    expect(exited.machine.status.state).toBe('stopped')
    expect(exited.effects).toEqual([])
  })

  it('stopped + START → starting（重启服务入口）', () => {
    const m = driveToRunning()
    const stopped = transition(m, { type: 'STOP' }, policy, now).machine
    const r = transition(stopped, { type: 'START' }, policy, now)
    expect(r.machine.status.state).toBe('starting')
    expect(r.effects).toContainEqual({ kind: 'spawn' })
  })
})

describe('附加模式（端口已听不 spawn）', () => {
  it('idle + SPAWNED{attach} → waiting_health(attachMode)，EXIT 不重启 → failed 引导', () => {
    let m = createMachine('gateway')
    const r = transition(m, { type: 'SPAWNED', attach: true }, policy, now)
    expect(r.machine.status.state).toBe('waiting_health')
    expect(r.machine.status.attachMode).toBe(true)
    expect(r.machine.pid).toBeNull()
    expect(r.effects).not.toContainEqual({ kind: 'spawn' })

    m = transition(r.machine, { type: 'HEALTH_OK', db: 'up' }, policy, now).machine
    expect(m.status.state).toBe('running')

    const died = transition(m, { type: 'EXIT', code: 0 }, policy, now)
    expect(died.machine.status.state).toBe('failed') // 不是我们的进程——不代为重启
    expect(died.effects.some((e) => e.kind === 'kill-tree')).toBe(false)
    expect(died.machine.status.message).toContain('接管')
  })

  it('attach + 健康持续超时 → failed（不 kill 非托管进程）', () => {
    let m = createMachine('console')
    m = transition(m, { type: 'SPAWNED', attach: true }, policy, now).machine
    m = transition(m, { type: 'HEALTH_OK', db: 'unknown' }, policy, now).machine
    const r = transition(m, { type: 'HEALTH_TIMEOUT' }, policy, now)
    expect(r.machine.status.state).toBe('failed')
    expect(r.effects.some((e) => e.kind === 'kill-tree')).toBe(false)
  })

  it('RETRY 从 failed(attach) 接管为 spawn 模式', () => {
    let m = createMachine('gateway')
    m = transition(m, { type: 'SPAWNED', attach: true }, policy, now).machine
    m = transition(m, { type: 'EXIT', code: 1 }, policy, now).machine
    expect(m.status.state).toBe('failed')
    const r = transition(m, { type: 'RETRY' }, policy, now)
    expect(r.machine.status.state).toBe('starting')
    expect(r.machine.status.attachMode).toBe(false)
    expect(r.effects).toContainEqual({ kind: 'spawn' })
  })
})

describe('幂等与未知组合（规则 4）', () => {
  it('非 idle/stopped 状态下 START 被忽略', () => {
    for (const state of ['starting', 'waiting_health', 'running', 'restarting', 'failed'] as const) {
      let m = createMachine('gateway')
      if (state === 'starting') m = transition(m, { type: 'START' }, policy, now).machine
      else if (state === 'waiting_health') {
        m = transition(m, { type: 'START' }, policy, now).machine
        m = transition(m, { type: 'SPAWNED', pid: 1 }, policy, now).machine
      } else if (state === 'running') m = driveToRunning()
      else if (state === 'restarting') {
        m = driveToRunning()
        m = transition(m, { type: 'EXIT', code: 1 }, policy, now).machine
      } else {
        m = transition(m, { type: 'START' }, policy, now).machine
        m = transition(m, { type: 'SPAWN_FAILED', error: 'x' }, policy, now).machine
      }
      expect(m.status.state).toBe(state)
      const r = transition(m, { type: 'START' }, policy, now)
      expect(r.machine).toBe(m) // 完全不变
      expect(r.effects).toEqual([])
    }
  })

  it('RETRY 只在 failed 生效；RESTART_DUE 只在 restarting 生效', () => {
    const m = driveToRunning()
    expect(transition(m, { type: 'RETRY' }, policy, now).machine).toBe(m)
    expect(transition(m, { type: 'RESTART_DUE' }, policy, now).machine).toBe(m)
  })

  it('单次 HEALTH_FAIL 不改变任何状态（期限判定归 supervisor）', () => {
    const m = driveToRunning()
    const r = transition(m, { type: 'HEALTH_FAIL', error: 'ECONNREFUSED' }, policy, now)
    expect(r.machine).toBe(m)
    expect(r.effects).toEqual([])
  })

  it('状态集合七态齐备（防止枚举漂移）', () => {
    expect(ALL_STATES).toHaveLength(7)
  })
})

describe('waiting_health 阶段的退出', () => {
  it('启动即退（EXIT during waiting_health）也走有界重启', () => {
    let m = createMachine('gateway')
    m = transition(m, { type: 'START' }, policy, now).machine
    m = transition(m, { type: 'SPAWNED', pid: 9 }, policy, now).machine
    const r = transition(m, { type: 'EXIT', code: 1 }, policy, now)
    expect(r.machine.status.state).toBe('restarting')
    expect(r.machine.status.attempts).toBe(1)
  })

  it('启动即退（EXIT during starting，与 SPAWNED 竞态）同样进预算', () => {
    let m = createMachine('gateway')
    m = transition(m, { type: 'START' }, policy, now).machine
    const r = transition(m, { type: 'EXIT', code: 1 }, policy, now)
    expect(r.machine.status.state).toBe('restarting')
  })
})

// 让 lint 安心：ServiceEvent 全体成员都至少被上面消费过
type _AllEventsConsumed = ServiceEvent
void (null as unknown as _AllEventsConsumed)
