import { join } from 'node:path'
import type {
  DesktopConfig,
  PostgresConfig,
  ServiceRunSpec,
  ServiceStatus,
} from './types'
import type { ServiceSupervisor, SupervisorDeps, SupervisorOptions } from './supervisor'

// 内嵌 Postgres 服务切片（docs/desktop-architecture.md §10，M5）。
// 纯度纪律：本文件禁 import electron（purity.test.ts 钉死）；一切副作用经
// PgExtraDeps 注入（真接线 ../spawn-runtime.ts）。对 supervisor.ts 仅 type import。

export const PG_PORT_DEFAULT = 55432
/** 端口让位上限（+1 递增探测次数，docs §10.3）。 */
export const PG_PORT_MAX_TRIES = 20
/**
 * 建库连接的崩溃恢复窗口（docs §10.2 建库注，2026-10-07 真机缺陷①）：
 * 非干净关机后的下一次启动，postgres 端口已 accept（TCP 探活过）但仍在 crash
 * recovery——建库连接吃 FATAL 'the database system is starting up'。窗口内每 1s
 * 重试；耗尽才判死（实测恢复常在秒级，30s 覆盖 PG 大数据目录的恢复期）。
 */
export const ENSURE_DB_RETRY_WINDOW_MS = 30_000
export const PG_SUPERUSER = 'dagents'
export const PG_DATABASE = 'dagents'
export const PG_HOST = '127.0.0.1'

/** 一次性脚本（迁移）的 node 运行时（dev=PATH 的 node；packaged=execPath+RUN_AS_NODE）。 */
export interface NodeRuntimeSpec {
  command: string
  env: Record<string, string>
}

/** 解析后的内嵌 PG 运行时路径（config 覆盖值或调用方默认值——index.ts 汇聚）。 */
export interface PgRuntimePaths {
  /** initdb/postgres/pg_ctl 所在 bin 目录。 */
  binDir: string
  /** 数据目录（userData/pgdata，卸载保留）。 */
  dataDir: string
  /** 迁移脚本（dev：<repoRoot>/packages/db/scripts/migrate.mjs；packaged 指 staged）。 */
  migrateScript: string
  /** pg 驱动解析根（建库用，dev：packages/db；packaged 指 services/gateway）。 */
  pgRequireRoot: string
  /** 迁移子进程的 node 载体（M6 packaged：ELECTRON_RUN_AS_NODE + process.execPath）。 */
  nodeRuntime: NodeRuntimeSpec
}

/** 一次性子进程（initdb/pg_ctl/migrate）——与常驻服务的 SpawnHandle 不同生命周期。 */
export interface RunOnceSpec {
  command: string
  args: string[]
  cwd?: string
  env?: Record<string, string>
  timeoutMs?: number
}

export interface RunOnceResult {
  code: number | null
  stdout: string
  stderr: string
}

/** 建库用的最小 pg 客户端面（真实实现 spawn-runtime 经 createRequire 动态加载 pg）。 */
export interface PgClient {
  query(sql: string): Promise<{ rows: Record<string, unknown>[] }>
  end(): Promise<void>
}

export interface PgExtraDeps {
  existsSync(path: string): boolean
  readFileUtf8(path: string): string | null
  removeFile(path: string): void
  runOnce(spec: RunOnceSpec): Promise<RunOnceResult>
  connectPg(maintenanceDsn: string): Promise<PgClient>
  isProcessAlive(pid: number): boolean
}

export type PgDeps = SupervisorDeps & PgExtraDeps

/** 端口让位结果：yielded = 实际端口 ≠ 配置默认（状态页明示依据）。 */
export interface PgPortChoice {
  port: number
  yielded: boolean
  tried: number
}

/**
 * 挑 PG 端口：默认端口空闲直接用；被占 +1 递增（≤maxTries 次）；
 * 全部被占返回 null（诚实失败——不猜不抢，docs §10.3）。
 */
export async function pickPgPort(
  preferred: number,
  isPortOpen: (port: number) => Promise<boolean>,
  maxTries = PG_PORT_MAX_TRIES
): Promise<PgPortChoice | null> {
  for (let i = 0; i < maxTries; i++) {
    const port = preferred + i
    if (!(await isPortOpen(port))) return { port, yielded: i > 0, tried: i + 1 }
  }
  return null
}

export function pgDsn(port: number, database: string): string {
  return `postgresql://${PG_SUPERUSER}@${PG_HOST}:${port}/${database}`
}

function platformExe(binDir: string, name: string): string {
  return join(binDir, process.platform === 'win32' ? `${name}.exe` : name)
}

/** initdb 幂等初始化（docs §10.2：-U dagents -E UTF8 --locale=C -A trust，仅本机回环）。 */
export function initdbSpec(paths: PgRuntimePaths): RunOnceSpec {
  return {
    command: platformExe(paths.binDir, 'initdb'),
    args: [
      '-D',
      paths.dataDir,
      '-U',
      PG_SUPERUSER,
      '-E',
      'UTF8',
      '--locale=C',
      '-A',
      'trust',
    ],
    cwd: paths.binDir,
    timeoutMs: 120_000,
  }
}

/** postgres 前台直跑规格（不走 pg_ctl daemonize——保进程树归属使 taskkill /T 可达）。 */
export function pgSpawnRunSpec(paths: PgRuntimePaths, port: number): ServiceRunSpec {
  return {
    command: platformExe(paths.binDir, 'postgres'),
    args: ['-D', paths.dataDir, '-p', String(port), '-h', PG_HOST],
    cwd: paths.binDir,
    env: {},
  }
}

/** 迁移：node migrate.mjs + POSTGRES_URL（幂等——runMigrations 跳过已应用项；
 * packaged 形态经 ELECTRON_RUN_AS_NODE 载体跑同一脚本，docs §11.1）。 */
export function migrateRunOnceSpec(paths: PgRuntimePaths, dsn: string): RunOnceSpec {
  return {
    command: paths.nodeRuntime.command,
    args: [paths.migrateScript],
    env: { POSTGRES_URL: dsn, ...paths.nodeRuntime.env },
    timeoutMs: 300_000,
  }
}

/** 优雅停止：pg_ctl stop -m fast（干净 checkpoint 数据落盘；超时由树终止兜底）。 */
export function pgCtlStopSpec(paths: PgRuntimePaths): RunOnceSpec {
  return {
    command: platformExe(paths.binDir, 'pg_ctl'),
    args: ['-D', paths.dataDir, '-m', 'fast', '-w', '-t', '5', 'stop'],
    cwd: paths.binDir,
    timeoutMs: 30_000,
  }
}

/** postmaster.pid 首行即 postmaster PID（PG 官方格式）；解析失败返回 null。 */
export function parsePostmasterPid(content: string): number | null {
  const first = content.split(/\r?\n/, 1)[0]?.trim() ?? ''
  return /^\d+$/.test(first) ? Number(first) : null
}

function baseStatus(over: Partial<ServiceStatus>): ServiceStatus {
  return {
    id: 'pg',
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

/** controller 自身阶段（bootstrap 管线语义，supervisor 之外的生命周期）。 */
type PgPhase =
  | 'idle' // 未启动
  | 'skipped' // 附加模式/外部 PG——诚实展示不 spawn
  | 'preparing' // initdb/残留清理中
  | 'supervised' // supervisor 已接管（状态透传）
  | 'failed' // bootstrap 失败（gateway 因此不启动）
  | 'stopped'

export interface PgServiceControllerOptions {
  paths: PgRuntimePaths
  createSupervisor: (options: SupervisorOptions) => ServiceSupervisor
  emit: () => void
}

/**
 * 内嵌 PG 管线（docs §10.2）：
 *   initdb（幂等）→ postgres 前台直跑（supervisor TCP 探活）→ 建库 → 迁移 → ready
 * 失败任一步 → failed + gateway 不启动（Orchestrator.startAsync 判定）。
 */
export class PgServiceController {
  private phase: PgPhase = 'idle'
  private message: string | null = null
  private port: number | null = null
  private portYielded = false
  private sup: ServiceSupervisor | null = null
  private readonly paths: PgRuntimePaths

  constructor(
    private config: DesktopConfig,
    private deps: PgDeps,
    private opts: PgServiceControllerOptions
  ) {
    this.paths = opts.paths
  }

  get enabled(): boolean {
    return this.config.postgres.embedded
  }

  get actualPort(): number | null {
    return this.phase === 'skipped' || this.phase === 'idle' ? null : this.port
  }

  get dataDir(): string {
    return this.paths.dataDir
  }

  log(line: string): void {
    this.deps.log('pg', line)
  }

  logTail(n: number): string[] {
    return this.deps.getLogTail('pg', n)
  }

  /** 附加模式等场景：诚实标记「本 app 不托管内嵌 PG」。 */
  markSkipped(reason: string): void {
    if (this.phase !== 'idle') return
    this.phase = 'skipped'
    this.message = reason
    this.log(reason)
    this.opts.emit()
  }

  async start(): Promise<{ ok: true; dsn: string } | { ok: false; error: string }> {
    if (this.phase === 'supervised' || this.phase === 'preparing') {
      // 重复 start 幂等（Orchestrator.startAsync 单点调用，防御性兜底）
      return { ok: false, error: '内嵌 PG 启动管线已在进行中' }
    }
    if (!this.enabled) {
      this.markSkipped('postgres.embedded=false——使用外部 Postgres（gateway 走 .env/extraEnv 的 POSTGRES_URL）')
      return { ok: true, dsn: '' }
    }
    const fail = (error: string): { ok: false; error: string } => {
      this.phase = 'failed'
      this.message = error
      this.log(`✗ ${error}`)
      this.opts.emit()
      return { ok: false, error }
    }

    // 0. 二进制在位（ensure-postgres.mjs 产物）
    if (!this.deps.existsSync(platformExe(this.paths.binDir, 'postgres'))) {
      return fail(
        `内嵌 Postgres 二进制未就位（${this.paths.binDir}）——先执行：pnpm --filter @dagents/desktop ensure:postgres`
      )
    }

    // 1. 端口让位（docs §10.3：55432 起递增 ≤20；全占诚实失败）
    const preferred = this.config.postgres.port
    const choice = await pickPgPort(preferred, (p) => this.deps.isPortOpen(p))
    if (choice === null) {
      return fail(
        `端口 ${preferred}–${preferred + PG_PORT_MAX_TRIES - 1} 全被占用——内嵌 Postgres 无处可听，请释放其一或改 postgres.port`
      )
    }
    this.port = choice.port
    this.portYielded = choice.yielded
    if (choice.yielded) {
      this.log(`默认端口 ${preferred} 被占用，让位至 ${choice.port}（第 ${choice.tried} 次探测命中）`)
    }

    // 2. initdb 幂等初始化
    this.phase = 'preparing'
    this.message = `正在初始化数据目录 ${this.paths.dataDir}（首次启动需 initdb，约几秒）…`
    this.opts.emit()
    const stale = this.clearStalePostmasterPid()
    if (!stale.ok) return fail(stale.error)
    if (!this.deps.existsSync(join(this.paths.dataDir, 'PG_VERSION'))) {
      this.log(`数据目录无 PG_VERSION → initdb：${this.paths.dataDir}`)
      const res = await this.deps.runOnce(initdbSpec(this.paths))
      if (res.code !== 0) {
        return fail(
          `initdb 失败（exit=${res.code}）：${tailOf(res.stderr || res.stdout, 400)}——数据目录可能残留半成品，检查 ${this.paths.dataDir}`
        )
      }
      this.log('initdb 完成（superuser=dagents，trust 本机认证）')
    }

    // 3. postgres 前台直跑 + TCP 探活（supervisor 状态机全套：有界重启/树终止）
    this.phase = 'supervised'
    this.message = null
    this.sup = this.opts.createSupervisor({
      probe: async (port) => {
        const open = await this.deps.isPortOpen(port)
        return open ? { status: 200, body: '' } : { error: `TCP ${PG_HOST}:${port} 无监听` }
      },
      runSpec: () => pgSpawnRunSpec(this.paths, this.port as number),
      port: this.port,
      attachable: false,
    })
    await this.sup.start()
    const wait = await this.waitUntilSettled(this.config.restartPolicy.healthTimeoutMs + 5_000)
    if (wait !== 'running') {
      return fail(
        wait === 'timeout'
          ? `内嵌 Postgres ${this.config.restartPolicy.healthTimeoutMs / 1000}s 内未达健康（端口 ${this.port}）——查看日志尾定位`
          : `内嵌 Postgres 未健康启动（状态 ${wait}）——查看日志尾定位`
      )
    }

    // 4. 建库（tarball 无 createdb；pg 驱动幂等 CREATE DATABASE）。
    //    崩溃恢复窗口有界重试（ENSURE_DB_RETRY_WINDOW_MS）：非干净关机后端口已开但
    //    'the database system is starting up'——单次失败即判死会让下一次启动卡
    //    failed 等人工「重试初始化」（真机缺陷①，重试即恢复）。
    this.message = 'Postgres 已监听，正在确保数据库存在…'
    this.opts.emit()
    const ensureDbDeadline = this.deps.now() + ENSURE_DB_RETRY_WINDOW_MS
    for (;;) {
      try {
        await this.ensureDatabase()
        break
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e)
        if (this.deps.now() >= ensureDbDeadline) {
          return fail(`建库失败：${msg}`)
        }
        this.log(`建库暂不可用（${msg}）——数据库可能处于崩溃恢复窗口，1s 后重试`)
        this.message = '数据库崩溃恢复中，等待就绪…'
        this.opts.emit()
        await new Promise<void>((r) => this.deps.setTimer(() => r(), 1_000))
      }
    }

    // 5. 迁移（幂等；失败 → gateway 不启动，对齐 docker-entrypoint 语义）
    this.message = '正在应用数据库迁移…'
    this.opts.emit()
    const dsn = pgDsn(this.port, PG_DATABASE)
    const migrate = await this.deps.runOnce(migrateRunOnceSpec(this.paths, dsn))
    if (migrate.code !== 0) {
      return fail(
        `数据库迁移失败（exit=${migrate.code}）：${tailOf(migrate.stderr || migrate.stdout, 400)}——gateway 不启动（迁移是硬前置）`
      )
    }
    this.log(`迁移完成：${tailOf(migrate.stdout, 200) || '(无输出)'}`)
    this.message = null
    this.opts.emit()
    return { ok: true, dsn }
  }

  /**
   * 优雅停止（docs §10.2）：suppressExit（pg_ctl 引发的退出不算意外）→
   * pg_ctl stop -m fast → 树终止兜底 → 端口释放断言（同 gateway/console 口径）。
   */
  async stop(): Promise<boolean> {
    const sup = this.sup
    if (sup === null || this.phase === 'idle' || this.phase === 'skipped') {
      if (this.phase !== 'skipped') this.phase = 'stopped'
      return true
    }
    this.phase = 'stopped'
    sup.suppressExit()
    try {
      await this.deps.runOnce(pgCtlStopSpec(this.paths))
    } catch (e) {
      this.log(`pg_ctl stop 异常（${e instanceof Error ? e.message : String(e)}）——走树终止兜底`)
    }
    sup.stop()
    sup.dispose()
    this.sup = null
    const port = this.port
    if (port !== null) {
      if (await this.deps.isPortOpen(port)) {
        await new Promise<void>((r) => this.deps.setTimer(() => r(), 1500))
        if (await this.deps.isPortOpen(port)) {
          this.log(`停止后端口 ${port} 仍被占用——请人工检查（pg_ctl fast + 树终止均未停净）`)
          this.opts.emit()
          return false
        }
      }
      this.log(`内嵌 Postgres 已停净（端口 ${port} 释放）`)
    }
    this.opts.emit()
    return true
  }

  /** 渲染层状态投影：supervised 阶段透传 supervisor（让位端口在 message 前缀明示）。 */
  status(): ServiceStatus {
    if (this.phase === 'supervised' && this.sup !== null) {
      const base = this.sup.status
      if (base.state === 'running' && this.portYielded) {
        return {
          ...base,
          message: `端口 :${this.port}（默认 ${this.config.postgres.port} 被占用，已让位）`,
        }
      }
      if (base.state === 'running' && base.message === null) {
        return { ...base, message: `端口 :${this.port} · 数据目录 ${this.paths.dataDir}` }
      }
      return base
    }
    if (this.phase === 'skipped') {
      return baseStatus({ state: 'idle', message: this.message })
    }
    if (this.phase === 'preparing') {
      return baseStatus({ state: 'starting', message: this.message })
    }
    if (this.phase === 'failed') {
      return baseStatus({ state: 'failed', message: this.message })
    }
    if (this.phase === 'stopped') {
      return baseStatus({ state: 'stopped', message: '已停止（pg_ctl fast 停净）' })
    }
    return baseStatus({ state: 'idle' })
  }

  /** 等待 supervisor 进入稳定态（running=健康 / failed / stopped）。 */
  private async waitUntilSettled(
    timeoutMs: number
  ): Promise<'running' | 'failed' | 'stopped' | 'timeout'> {
    const deadline = this.deps.now() + timeoutMs
    for (;;) {
      const state = this.sup?.state
      if (state === 'running') return 'running'
      if (state === 'failed' || state === 'stopped') return state
      if (this.deps.now() >= deadline) return 'timeout'
      await new Promise<void>((r) => this.deps.setTimer(() => r(), 200))
    }
  }

  /**
   * stale postmaster.pid 清理（R9）：PID 已死 → 移除锁文件（PG 官方认可的 stale lock
   * 处置，非删数据）；PID 活着 → 诚实失败（另一个 Postgres 在用该目录）。
   */
  private clearStalePostmasterPid(): { ok: true; removed: boolean } | { ok: false; error: string } {
    const pidFile = join(this.paths.dataDir, 'postmaster.pid')
    if (!this.deps.existsSync(pidFile)) return { ok: true, removed: false }
    const content = this.deps.readFileUtf8(pidFile)
    const pid = content !== null ? parsePostmasterPid(content) : null
    if (pid !== null && this.deps.isProcessAlive(pid)) {
      return {
        ok: false,
        error: `postmaster.pid 残留且 PID ${pid} 仍在运行——另一 Postgres 实例正占用 ${this.paths.dataDir}。请先停止它，或更换数据目录`,
      }
    }
    this.deps.removeFile(pidFile)
    this.log(`已移除 stale postmaster.pid（PID ${pid ?? '?'} 已不存在）`)
    return { ok: true, removed: true }
  }

  /** 连 postgres 维护库幂等建 dagents 库（CREATE DATABASE IF NOT EXISTS 竞态按 42P04 忽略）。 */
  private async ensureDatabase(): Promise<void> {
    const client = await this.deps.connectPg(pgDsn(this.port as number, 'postgres'))
    try {
      const found = await client.query(
        `SELECT 1 AS ok FROM pg_database WHERE datname = '${PG_DATABASE}'`
      )
      if (found.rows.length > 0) {
        this.log(`数据库 ${PG_DATABASE} 已存在（跳过建库）`)
        return
      }
      try {
        await client.query(`CREATE DATABASE ${PG_DATABASE}`)
        this.log(`已创建数据库 ${PG_DATABASE}`)
      } catch (e) {
        const code = (e as { code?: string }).code
        if (code !== '42P04') throw e // duplicate_database——并发建库竞态，幂等通过
        this.log(`数据库 ${PG_DATABASE} 已被并发创建（42P04，幂等通过）`)
      }
    } finally {
      await client.end()
    }
  }
}

function tailOf(text: string, max: number): string {
  const t = text.trim()
  return t.length <= max ? t : `…${t.slice(-max)}`
}

/**
 * 路径默认值汇聚（纯函数）：config.postgres 的 null 字段按形态取默认。
 * dev：binDir=desktop/stage/pg（ensure-postgres.mjs 产物）、migrate/pg 驱动取 repoRoot、node 走 PATH。
 * packaged：binDir/migrate/驱动/node 载体全部指向安装包 resources（docs §11.4）。
 */
export function resolvePgPaths(
  postgres: PostgresConfig,
  ctx: {
    userDataDir: string
    desktopDir: string
    repoRoot: string
    /** packaged 形态定位（M6）：services 根、pg native 根、Node 载体。 */
    packaged?: { servicesDir: string; pgNativeDir: string; execPath: string }
  }
): PgRuntimePaths {
  if (ctx.packaged) {
    const { servicesDir, pgNativeDir, execPath } = ctx.packaged
    return {
      binDir: postgres.binDir ?? join(pgNativeDir, 'bin'),
      dataDir: postgres.dataDir ?? join(ctx.userDataDir, 'pgdata'),
      migrateScript:
        postgres.migrateScript ??
        join(servicesDir, 'gateway', 'node_modules', '@dagents', 'db', 'scripts', 'migrate.mjs'),
      pgRequireRoot: postgres.pgRequireRoot ?? join(servicesDir, 'gateway'),
      nodeRuntime: { command: execPath, env: { ELECTRON_RUN_AS_NODE: '1' } },
    }
  }
  return {
    binDir: postgres.binDir ?? join(ctx.desktopDir, 'stage', 'pg', 'native', 'bin'),
    dataDir: postgres.dataDir ?? join(ctx.userDataDir, 'pgdata'),
    migrateScript:
      postgres.migrateScript ?? join(ctx.repoRoot, 'packages', 'db', 'scripts', 'migrate.mjs'),
    pgRequireRoot: postgres.pgRequireRoot ?? join(ctx.repoRoot, 'packages', 'db'),
    nodeRuntime: { command: 'node', env: {} },
  }
}
