/**
 * shell-registry.ts — 浏览器终端（PTY）会话注册表。
 *
 * 「效果上就是浏览器里的 bash」的真身：每个会话用 node-pty 在网关宿主机上
 * 起一个真伪终端（用户的 $SHELL，login shell），提示符 / 颜色 / 交互程序
 * （top、vim）全都原生 —— 不是「agent 代跑命令再转述」的模拟。
 *
 * 与 execution-registry 同族的进程内注册表：
 *   - 生命周期全在内存（网关重启即清空，无持久化 —— 终端会话本就是易失的）
 *   - 输出以 base64 帧推给订阅者（SSE 不容纳原始换行/控制字节）
 *   - replay 环形缓冲（默认 256KB）支持断线重连回放（刷新页面不丢历史）
 *   - 空闲清扫：退出会话保留一小段供重连看结果；无订阅者的活会话在
 *     DAGENTS_SHELL_ORPHAN_MS（默认 10 分钟）后回收，长任务刷新页面也能接回
 *
 * 安全口径：与平台其余 API 一致（本机开放 / GATEWAY_API_KEY 全局门）。
 * 终端直通 shell 是显式能力，关闭开关：DAGENTS_SHELL_DISABLED=1。
 */

import { randomUUID } from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createRequire } from 'node:module'
import { spawn as ptySpawn, type IPty } from 'node-pty'
import { createLogger } from '@dagents/shared'
import { declareGauge } from './lib/metrics.js'

const log = createLogger({ svc: 'gateway:shell' })

const MAX_SESSIONS_DEFAULT = 8
/** 惰性读取：测试与运维可在进程内调整（模块级 const 会把首帧值焊死）。 */
function maxSessions(): number {
  const n = Number(process.env.DAGENTS_SHELL_MAX_SESSIONS ?? MAX_SESSIONS_DEFAULT)
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : MAX_SESSIONS_DEFAULT
}
/** 已退出会话的残留时间（重连看结果）与孤儿活会话的回收时间共用。 */
const ORPHAN_MS_DEFAULT = 10 * 60_000
const SWEEP_INTERVAL_DEFAULT_MS = 60_000
const REPLAY_CAP_BYTES = 256 * 1024

/** 惰性读取（模块级 const 会把首帧值焊死，清扫器就无法被测试驱动）。 */
function orphanMs(): number {
  const n = Number(process.env.DAGENTS_SHELL_ORPHAN_MS ?? ORPHAN_MS_DEFAULT)
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : ORPHAN_MS_DEFAULT
}

function sweepIntervalMs(): number {
  const n = Number(process.env.DAGENTS_SHELL_SWEEP_INTERVAL_MS ?? SWEEP_INTERVAL_DEFAULT_MS)
  return Number.isFinite(n) && n >= 100 ? Math.floor(n) : SWEEP_INTERVAL_DEFAULT_MS
}

/** 订阅者收到的事件：data 为 base64 的 PTY 输出块，exit 为会话退出码。 */
export type ShellEvent = { type: 'data'; b64: string } | { type: 'exit'; code: number }
type Subscriber = (evt: ShellEvent) => void

export interface ShellSession {
  id: string
  pty: IPty
  cols: number
  rows: number
  cwd: string
  createdAt: number
  lastActiveAt: number
  exited: boolean
  exitCode: number | null
  exitedAt: number | null
  replay: string
  subscribers: Set<Subscriber>
  /** 会话形态（P4 交互式 agent 会话）：shell = 用户 $SHELL；agent = agent CLI 托管。 */
  kind: 'shell' | 'agent'
  /** 展示标签（agent 会话 = agent 名；shell 会话 null）。 */
  label: string | null
}

/**
 * pnpm 解包 node-pty 的 prebuilds 时会丢掉 spawn-helper 的可执行位（npm
 * tarball 里有，pnpm store 落盘后变成 644），posix_spawnp 直接 EACCES ——
 * 上游 postinstall 只清 build/Release 不管 prebuilds。这里在首次使用前
 * 自愈：检测到无可执行位就补 chmod。build/Release（源码编译路径）一并处理。
 */
function ensureSpawnHelperExecutable(): void {
  try {
    const require = createRequire(import.meta.url)
    const pkgRoot = path.dirname(require.resolve('node-pty/package.json'))
    const candidates = [
      path.join(pkgRoot, 'build/Release/spawn-helper'),
      path.join(pkgRoot, 'prebuilds', `${process.platform}-${process.arch}`, 'spawn-helper'),
    ]
    for (const helper of candidates) {
      try {
        const st = fs.statSync(helper)
        if ((st.mode & 0o111) === 0) {
          fs.chmodSync(helper, 0o755)
          log.info('restored spawn-helper exec bit', { helper })
        }
      } catch {
        // 该路径不存在（prebuild 或源码编译只占其一）——跳过
      }
    }
  } catch (err) {
    log.warn('spawn-helper self-heal failed (shell sessions may fail to spawn)', {
      error: String(err),
    })
  }
}

export function shellDisabled(): boolean {
  return process.env.DAGENTS_SHELL_DISABLED === '1'
}

const sessions = new Map<string, ShellSession>()

// 水位指标（稳定性专项 2026-10-04）：PTY 会话数靠近上限 8 = 孤儿回收
//（默认 10 分钟）跟不上开洞速度的信号，/metrics 一眼可见。
declareGauge('dagents_shell_sessions_active', 'Active PTY shell sessions (cap: 8)', {
  collect: () => sessions.size,
})

export function listSessions(): Array<
  Pick<ShellSession, 'id' | 'cwd' | 'createdAt' | 'exited' | 'kind' | 'label'>
> {
  return [...sessions.values()].map(({ id, cwd, createdAt, exited, kind, label }) => ({
    id,
    cwd,
    createdAt,
    exited,
    kind,
    label,
  }))
}

export class ShellSessionError extends Error {
  constructor(
    message: string,
    public status: number,
  ) {
    super(message)
  }
}

export interface CreateSessionOptions {
  cwd?: string
  cols?: number
  rows?: number
  /** P4 交互式 agent 会话：显式命令（如 claude）替代用户 $SHELL 托管在 PTY。 */
  command?: string
  args?: string[]
  kind?: 'shell' | 'agent'
  label?: string
}

export function createSession(opts: CreateSessionOptions): ShellSession {
  if (shellDisabled()) {
    throw new ShellSessionError('shell sessions disabled (DAGENTS_SHELL_DISABLED=1)', 403)
  }
  if (sessions.size >= maxSessions()) {
    throw new ShellSessionError(`too many shell sessions (max ${maxSessions()})`, 429)
  }

  ensureSpawnHelperExecutable()

  const cwd = opts.cwd ?? os.homedir()
  const cols = clampInt(opts.cols ?? 80, 10, 500)
  const rows = clampInt(opts.rows ?? 24, 4, 300)
  // shell 选择：SHELL 指向存在的 POSIX 路径就用它；Windows 默认 PowerShell
  // （node-pty 需要 Windows 可执行文件 —— /bin/bash 在 win32 上不存在）。
  // login 参数同理分平台：POSIX `-l`，Windows PowerShell 不吃 `-l`。
  const isWindows = process.platform === 'win32'
  const posixShellOk =
    !!process.env.SHELL && process.env.SHELL.startsWith('/') && !isWindows
  const shell = posixShellOk ? process.env.SHELL! : isWindows ? 'powershell.exe' : '/bin/bash'
  const kind = opts.kind ?? 'shell'
  const label = opts.label ?? null
  const id = kind === 'agent' ? `agt_${randomUUID().slice(0, 8)}` : `shl_${randomUUID().slice(0, 8)}`
  // agent 会话：PTY 里托管 agent CLI（交互 TUI 直连）；shell 会话：login shell。
  const file = opts.command ?? shell
  const argv = opts.command != null ? (opts.args ?? []) : isWindows ? [] : ['-l']

  let pty: IPty
  try {
    pty = ptySpawn(file, argv, {
      name: 'xterm-256color',
      cols,
      rows,
      cwd,
      // 最小环境（sshd 同款策略）：绝不把网关进程环境灌进终端 ——
      // POSTGRES_URL / GATEWAY_API_KEY / provider 密钥一旦进 env，
      // 页面上一个 `env` 就全见了。login shell（-l）会自行 source
      // 用户 profile 重建完整环境；agent CLI（claude 等）凭 HOME 找到
      // 自己的凭据，这里只需要能让进程起来的骨架。
      env: {
        HOME: os.homedir(),
        USER: os.userInfo().username,
        LOGNAME: os.userInfo().username,
        SHELL: shell,
        PATH: process.env.PATH ?? '/usr/bin:/bin',
        LANG: process.env.LANG,
        TZ: process.env.TZ,
        TERM: 'xterm-256color',
        COLORTERM: 'truecolor',
        // win32 骨架：Windows 进程没有 SystemRoot/ComSpec 起不来或退出态
        // 损坏（实测 powershell.exe 缺 SystemRoot 时 `exit 3` 报
        // 0xFFFF0000 而非 3）—— 只透传系统级变量，用户级密钥仍不进 env。
        ...(process.platform === 'win32'
          ? {
              SystemRoot: process.env.SystemRoot,
              windir: process.env.windir,
              ComSpec: process.env.ComSpec,
              USERNAME: os.userInfo().username,
              USERPROFILE: os.homedir(),
              APPDATA: process.env.APPDATA,
              LOCALAPPDATA: process.env.LOCALAPPDATA,
              TEMP: process.env.TEMP,
              TMP: process.env.TMP,
            }
          : {}),
      } as Record<string, string>,
    })
  } catch (err) {
    log.error('pty spawn failed', { file, kind, cwd, error: String(err) })
    throw new ShellSessionError(`pty spawn failed: ${String(err)}`, 500)
  }

  const session: ShellSession = {
    id,
    pty,
    cols,
    rows,
    cwd,
    createdAt: Date.now(),
    lastActiveAt: Date.now(),
    exited: false,
    exitCode: null,
    exitedAt: null,
    replay: '',
    subscribers: new Set(),
    kind,
    label,
  }
  sessions.set(id, session)

  pty.onData((data) => {
    session.lastActiveAt = Date.now()
    session.replay += data
    if (session.replay.length > REPLAY_CAP_BYTES) {
      // 按 3/4 截断而非掐一半：留足余量减少频繁截断
      session.replay = session.replay.slice(session.replay.length - Math.floor(REPLAY_CAP_BYTES * 0.75))
    }
    const evt: ShellEvent = { type: 'data', b64: Buffer.from(data, 'utf8').toString('base64') }
    for (const sub of session.subscribers) sub(evt)
  })
  pty.onExit(({ exitCode }) => {
    session.exited = true
    session.exitCode = exitCode
    session.exitedAt = Date.now()
    for (const sub of session.subscribers) sub({ type: 'exit', code: exitCode })
    session.subscribers.clear()
  })

  log.info('shell session created', { id, kind, file, cwd, cols, rows })
  return session
}

export function getSession(id: string): ShellSession | undefined {
  return sessions.get(id)
}

/**
 * 原子订阅：注册订阅者并同拍快照 replay —— PTY 数据事件异步派发，同步段内
 * 不会插入新输出，回放与实时流之间零丢失零重复。
 *
 * 返回订阅后的会话对象本身（而非让调用方用先前快照）：若 PTY 在调用方
 * getSession 与此处 attach 之间退出，onExit 已 clear 过 subscribers ——
 * 订阅者拿不到 exit 事件，必须以 attach 后的 session.exited 为准补发。
 */
export function attach(
  id: string,
  sub: Subscriber,
): { session: ShellSession; replay: string; unsubscribe: () => void } | undefined {
  const session = sessions.get(id)
  if (!session) return undefined
  session.subscribers.add(sub)
  const replay = session.replay
  return {
    session,
    replay,
    unsubscribe: () => session.subscribers.delete(sub),
  }
}

export function writeInput(id: string, b64: string): boolean {
  const session = sessions.get(id)
  if (!session || session.exited) return false
  const data = Buffer.from(b64, 'base64').toString('utf8')
  session.lastActiveAt = Date.now()
  session.pty.write(data)
  return true
}

export function resizeSession(id: string, cols: number, rows: number): boolean {
  const session = sessions.get(id)
  if (!session || session.exited) return false
  const c = clampInt(cols, 10, 500)
  const r = clampInt(rows, 4, 300)
  try {
    session.pty.resize(c, r)
  } catch (err) {
    // 进程刚退出的窗口期 resize 可能抛错 —— 无害，吞掉即可
    log.debug('pty resize failed', { id, error: String(err) })
    return false
  }
  session.cols = c
  session.rows = r
  return true
}

export function killSession(id: string): boolean {
  const session = sessions.get(id)
  if (!session) return false
  try {
    session.pty.kill()
  } catch {
    // 已退出进程的 kill 抛错 —— 清理照常进行
  }
  sessions.delete(id)
  log.info('shell session killed', { id })
  return true
}

/** 惰性启动的清扫循环：回收已退出的残留会话与孤儿活会话。 */
let sweeper: ReturnType<typeof setInterval> | null = null

function sweep(): void {
  const now = Date.now()
  for (const [id, s] of sessions) {
    if (s.exited) {
      if (s.exitedAt != null && now - s.exitedAt > orphanMs()) sessions.delete(id)
      continue
    }
    if (s.subscribers.size === 0 && now - s.lastActiveAt > orphanMs()) {
      log.info('shell session orphaned, recycling', { id, idleMs: now - s.lastActiveAt })
      try {
        s.pty.kill()
      } catch {
        // 忽略 —— kill 失败也照常移除（进程已死时常见的竞态）
      }
      sessions.delete(id)
    }
  }
}

export function ensureSweeper(): void {
  if (sweeper) return
  sweeper = setInterval(sweep, sweepIntervalMs())
  sweeper.unref()
}

function clampInt(v: number, min: number, max: number): number {
  const n = Math.floor(Number(v))
  if (!Number.isFinite(n)) return min
  return Math.min(max, Math.max(min, n))
}
