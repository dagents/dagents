import type { RestartPolicy, ServiceState, ServiceStatus } from './types'

// 纯状态机（docs/desktop-architecture.md §3.2）——禁 import electron、禁任何副作用：
// transition() 是 (machine, event, policy, now) → { machine, effects } 的纯函数，
// 时间与副作用全部由调用方注入，vitest 直接驱动全迁移表。
//
// 图：
//   idle ──START──▶ starting ──spawn ok──▶ waiting_health ──健康──▶ running
//                       │ spawn fail                                    │ 意外退出(exit)
//                       ▼                                              ▼
//                    failed ◀──预算耗尽── restarting ◀────────────────┘（有界：窗内 3 次，退避 1/3/9s）
//                       │   ▲                    │
//                  retry└───┘└────manual stop────┴──▶ stopped（树终止 + 清预算 + 清 timer）
//
// 附加模式：supervisor 探测到端口已被外部实例占用时直接发 SPAWNED{attach:true}，
// 机器从 idle 进 waiting_health（attachMode=true）——本 app 不 spawn、不 kill、
// 退出也不触发重启（不是我们的进程），RETRY 才接管为 spawn 模式。

export type ServiceEvent =
  | { type: 'START' }
  | { type: 'SPAWNED'; pid?: number; attach?: boolean }
  | { type: 'SPAWN_FAILED'; error: string }
  | { type: 'HEALTH_OK'; db: 'up' | 'down' | 'unknown' }
  | { type: 'HEALTH_FAIL'; error: string }
  | { type: 'HEALTH_TIMEOUT' }
  | { type: 'EXIT'; code: number | null }
  | { type: 'STOP' }
  | { type: 'RETRY' }
  | { type: 'RESTART_DUE' }

export type Effect =
  | { kind: 'spawn' }
  /** pid 随 effect 携带——STOP 转移会清空 machine.pid，事后再读会丢。 */
  | { kind: 'kill-tree'; pid: number }
  | { kind: 'schedule-restart'; delayMs: number }
  | { kind: 'clear-restart-timer' }
  /** 启动期 500ms / 运行期 5s 的健康轮询节拍切换。 */
  | { kind: 'set-health-interval'; ms: number }
  | { kind: 'stop-health-polling' }

export interface MachineState {
  status: ServiceStatus
  pid: number | null
  /** 滑动窗口内的重启发起时间戳（预算依据）。 */
  restartTimestamps: number[]
}

export interface TransitionResult {
  machine: MachineState
  effects: Effect[]
}

/** 启动期健康轮询间隔（尽快进 running）。 */
export const HEALTH_POLL_STARTUP_MS = 500
/** 运行期健康轮询间隔。 */
export const HEALTH_POLL_RUNNING_MS = 5_000

const DB_DOWN_GUIDANCE =
  'Postgres 未就绪（gateway 进程健康、DB 连不上）——请先起库：cd infra && docker compose up -d。此状态下不重启服务（重启救不了 DB）。'

function baseStatus(id: 'gateway' | 'console'): ServiceStatus {
  return {
    id,
    state: 'idle',
    attachMode: false,
    db: 'unknown',
    attempts: 0,
    lastExit: null,
    startedAt: null,
    message: null,
  }
}

export function createMachine(id: 'gateway' | 'console'): MachineState {
  return { status: baseStatus(id), pid: null, restartTimestamps: [] }
}

/** 滑动窗口裁剪后的重启预算申请；耗尽 → failed，否则 → restarting + 退避调度。 */
function requestRestart(
  m: MachineState,
  policy: RestartPolicy,
  now: number,
  lead: Effect[]
): TransitionResult {
  const recent = m.restartTimestamps.filter((t) => now - t < policy.windowMs)
  if (recent.length >= policy.maxAttempts) {
    const minutes = Math.round(policy.windowMs / 60_000)
    return {
      machine: {
        ...m,
        restartTimestamps: recent,
        status: {
          ...m.status,
          state: 'failed',
          attempts: recent.length,
          message: `重启预算耗尽：${minutes} 分钟窗内已重启 ${recent.length} 次。手动「重试」将清零预算重新开始。`,
        },
      },
      effects: [...lead, { kind: 'clear-restart-timer' }],
    }
  }
  const updated = [...recent, now]
  const delay = policy.backoffMs[Math.min(recent.length, policy.backoffMs.length - 1)]
  return {
    machine: {
      ...m,
      restartTimestamps: updated,
      status: {
        ...m.status,
        state: 'restarting',
        attempts: updated.length,
        message: `服务意外退出（exit=${m.status.lastExit?.code ?? '?'}），${Math.round(
          delay / 1000
        )}s 后第 ${updated.length}/${policy.maxAttempts} 次重启…`,
      },
    },
    effects: [...lead, { kind: 'schedule-restart', delayMs: delay }],
  }
}

function patch(m: MachineState, status: Partial<ServiceStatus>): MachineState {
  return { ...m, status: { ...m.status, ...status } }
}

/**
 * 单事件转移。未知组合（如 running+START）一律幂等忽略——重复 start/stop/retry
 * 全幂等是设计规则 4。
 */
export function transition(
  m: MachineState,
  event: ServiceEvent,
  policy: RestartPolicy,
  now: number
): TransitionResult {
  const state = m.status.state

  switch (event.type) {
    case 'START': {
      if (state !== 'idle' && state !== 'stopped') return { machine: m, effects: [] }
      return {
        machine: patch(m, {
          state: 'starting',
          attachMode: false,
          message: `正在启动：${m.status.id === 'gateway' ? 'pnpm --filter @dagents/gateway dev' : 'pnpm --filter @dagents/console dev'}`,
        }),
        effects: [{ kind: 'spawn' }],
      }
    }

    case 'SPAWNED': {
      const attach = event.attach === true
      if (state === 'starting' || (state === 'idle' && attach)) {
        return {
          machine: {
            ...patch(m, {
              state: 'waiting_health',
              attachMode: attach,
              startedAt: now,
              message: attach ? '端口已被监听——附加到现有服务（不 spawn）' : '子进程已拉起，等待健康检查…',
            }),
            pid: attach ? null : (event.pid ?? null),
          },
          effects: [{ kind: 'set-health-interval', ms: HEALTH_POLL_STARTUP_MS }],
        }
      }
      return { machine: m, effects: [] }
    }

    case 'SPAWN_FAILED': {
      if (state !== 'starting') return { machine: m, effects: [] }
      return {
        machine: patch(m, {
          state: 'failed',
          message: `启动失败：${event.error}——检查命令是否在 PATH（桌面启动环境 PATH 可能与终端不同）与 repoRoot 是否有效，然后点「重试」。`,
        }),
        effects: [],
      }
    }

    case 'HEALTH_OK': {
      if (state === 'waiting_health') {
        const degraded = event.db === 'down'
        return {
          machine: patch(m, {
            state: 'running',
            db: event.db,
            startedAt: m.status.startedAt ?? now,
            message: degraded ? DB_DOWN_GUIDANCE : null,
          }),
          effects: [{ kind: 'set-health-interval', ms: HEALTH_POLL_RUNNING_MS }],
        }
      }
      if (state === 'running') {
        // 运行中 db 翻转只更新子状态与文案（degraded 展示，不重启）
        const degraded = event.db === 'down'
        return {
          machine: patch(m, { db: event.db, message: degraded ? DB_DOWN_GUIDANCE : null }),
          effects: [],
        }
      }
      return { machine: m, effects: [] }
    }

    case 'HEALTH_FAIL': {
      // 持续失败的期限判定在 supervisor（firstFailAt + healthTimeoutMs），
      // 机器层面单次失败不改变状态。
      return { machine: m, effects: [] }
    }

    case 'HEALTH_TIMEOUT': {
      if (state !== 'waiting_health' && state !== 'running') return { machine: m, effects: [] }
      if (m.status.attachMode) {
        return {
          machine: patch(m, {
            state: 'failed',
            message: '附加模式下健康持续失败（服务非本 app 托管，不代为重启）——外部实例恢复后点「重试」重新附加。',
          }),
          effects: [{ kind: 'stop-health-polling' }],
        }
      }
      return requestRestart(
        patch(m, { message: '健康检查持续超时，按意外退出处理。', lastExit: null }),
        policy,
        now,
        m.pid !== null
          ? [{ kind: 'kill-tree', pid: m.pid }, { kind: 'stop-health-polling' }]
          : [{ kind: 'stop-health-polling' }]
      )
    }

    case 'EXIT': {
      if (
        state === 'waiting_health' ||
        state === 'running' ||
        state === 'starting'
      ) {
        if (m.status.attachMode) {
          return {
            machine: {
              ...patch(m, {
                state: 'failed',
                lastExit: { code: event.code },
                message: '已附加的外部服务进程退出（非本 app 托管）。点「重试」由本 app 接管拉起。',
              }),
              pid: null,
            },
            effects: [],
          }
        }
        return requestRestart(patch(m, { lastExit: { code: event.code } }), policy, now, [
          { kind: 'stop-health-polling' },
        ])
      }
      return { machine: m, effects: [] }
    }

    case 'RESTART_DUE': {
      if (state !== 'restarting') return { machine: m, effects: [] }
      return {
        machine: patch(m, { state: 'starting', message: `正在重启（第 ${m.status.attempts} 次）…` }),
        effects: [{ kind: 'spawn' }],
      }
    }

    case 'STOP': {
      if (state === 'stopped' || state === 'idle') {
        return { machine: m, effects: [{ kind: 'clear-restart-timer' }] }
      }
      const effects: Effect[] = [{ kind: 'clear-restart-timer' }, { kind: 'stop-health-polling' }]
      if (m.pid !== null) effects.push({ kind: 'kill-tree', pid: m.pid })
      return {
        machine: {
          ...patch(m, {
            state: 'stopped',
            attachMode: false,
            message: '已停止（进程树已终止，重启预算与定时器已清零）。',
          }),
          pid: null,
          restartTimestamps: [],
        },
        effects,
      }
    }

    case 'RETRY': {
      if (state !== 'failed') return { machine: m, effects: [] }
      return {
        machine: {
          ...patch(m, { state: 'starting', attachMode: false, message: '手动重试：预算已清零，重新启动…' }),
          restartTimestamps: [],
        },
        effects: [{ kind: 'spawn' }],
      }
    }

    default: {
      const never: never = event
      void never
      return { machine: m, effects: [] }
    }
  }
}

export { DB_DOWN_GUIDANCE }

// 状态集合导出给表驱动测试做完备性断言
export const ALL_STATES: ServiceState[] = [
  'idle',
  'starting',
  'waiting_health',
  'running',
  'restarting',
  'failed',
  'stopped',
]
