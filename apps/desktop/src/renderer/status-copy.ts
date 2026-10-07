import type { DesktopSnapshot, ServiceId, ServiceStatus } from '../main/orchestrator/types'

// 启动态/服务状态页的文案与投影层（U1 产品化）——纯函数、零 DOM、零 electron，
// 全部「诚实文案 / 错误引导分级 / 五步进度 / 模式分叉」的可测真相源。
// 消费方 status.ts 只做 DOM 装配；改文案先改这里（单测钉住语义，见 status-copy.test.ts）。
//
// 原则对照（docs/desktop-ux-spec.md principles）：
//   - 每个状态都有出路 / 每个等待都有预算 / 每个故障都有下一步 / 诚实优先于安抚
//   - 文案按模式分叉：dev 时代话术（docker compose / pnpm 命令）不泄漏到 packaged

export type Tone = 'ok' | 'warn' | 'err' | 'info' | 'restarting' | 'muted' | 'accent'

/** pg-service preparing 阶段 message 标记（单源在 pg-service.ts——改文案两处同步）。 */
const PG_MSG_DB = '确保数据库存在'
const PG_MSG_MIGRATE = '应用数据库迁移'

// ---- 全局状态灯（header 左）----

export interface GlobalLight {
  tone: Tone
  label: string
}

export function globalLight(snap: DesktopSnapshot): GlobalLight {
  const { gateway, console: cs, pg } = snap.services
  const anyFailed = gateway.state === 'failed' || cs.state === 'failed' || pg.state === 'failed'
  if (anyFailed) return { tone: 'err', label: '启动受阻' }
  const anyRestarting =
    gateway.state === 'restarting' || cs.state === 'restarting' || pg.state === 'restarting'
  if (anyRestarting) return { tone: 'restarting', label: '自动重启中' }
  if (gateway.attachMode && cs.attachMode && snap.phase === 'console') {
    return { tone: 'accent', label: '附加模式 · 健康' }
  }
  if (snap.phase === 'console') return { tone: 'ok', label: '服务健康' }
  if (gateway.db === 'down') return { tone: 'warn', label: '数据库未就绪' }
  return { tone: 'warn', label: '启动中' }
}

// ---- 阻塞原因（S5b 意愿等待态的「<原因>」与按钮 label 共用）----

export function blockingReason(snap: DesktopSnapshot): string | null {
  const { gateway, console: cs, pg } = snap.services
  const pgReady = !snap.config.pgEmbedded || pg.state === 'running' || pg.state === 'idle'
  if (!pgReady) return '数据库未就绪'
  if (gateway.state !== 'running') return '网关未就绪'
  if (gateway.db === 'down') return '数据库连接未就绪'
  if (cs.state !== 'running') return '工作台服务未就绪'
  return null
}

function dualHealthy(snap: DesktopSnapshot): boolean {
  return snap.phase === 'console'
}

// ---- 诚实 meta（真值表核心行，替代 M7 前失真的「正在接管工作台…」）----

export function metaLine(snap: DesktopSnapshot): string {
  const pinned = snap.contentIntent === 'boot'
  const reason = blockingReason(snap)
  if (snap.services.pg.state === 'failed') {
    return '数据库初始化失败——启动已停止（见下方红横幅与数据库卡指引）'
  }
  if (snap.services.gateway.db === 'down' && snap.services.gateway.state === 'running') {
    return '服务进程已起，但数据库未就绪——正在等待（gateway 卡有分模式指引）'
  }
  if (pinned && dualHealthy(snap)) {
    return '服务健康 · 已停留在此页——点「进入工作台」或菜单「服务 → 进入工作台」返回工作台'
  }
  if (pinned) {
    return '已钉住服务状态页（服务恢复后仍停留在此页，可随时点「进入工作台」接管）'
  }
  if (snap.contentIntent === 'console' && !dualHealthy(snap)) {
    return `已记录「进入工作台」意愿——等待服务恢复（${reason ?? '启动中'}），恢复后自动进入无需再点`
  }
  if (dualHealthy(snap)) {
    return '服务全部健康 · 正在接管工作台…'
  }
  return '正在启动服务栈（数据库 → 网关 → 工作台）…'
}

// ---- 卡片文案分级（错误引导分级：事实 + 对策 + 动作）----

export interface CardCopy {
  tone: Tone
  text: string
}

/** SPAWN_FAILED 的 packaged 分叉：抽取原始错误短语（'启动失败：<err>——dev 指引'）。 */
function spawnErrorFact(message: string): string {
  const m = /启动失败：(.+?)——/.exec(message)
  return m ? m[1] : '进程未能创建'
}

export function describeService(id: ServiceId, svc: ServiceStatus, snap: DesktopSnapshot): CardCopy | null {
  const packaged = snap.config.runMode === 'packaged'
  const pgFailed = snap.services.pg.state === 'failed'

  // 数据库失败期间，gateway/console 阻塞在 idle——诚实说明「待命」而非空白（B6）
  if (id !== 'pg' && svc.state === 'idle' && pgFailed) {
    return { tone: 'muted', text: '待命（等待数据库就绪）——数据库初始化失败已阻断启动，见上方横幅' }
  }

  if (id === 'gateway' && svc.db === 'down' && svc.state === 'running') {
    // db:down 按数据库归属三分叉（S6 / D6）——dev 保 docker 指引，packaged 不泄漏 dev 话术
    if (!packaged) {
      return {
        tone: 'warn',
        text: 'Postgres 未就绪（gateway 进程健康、DB 连不上）——dev 栈请先起库：cd infra && docker compose up -d；此状态下不重启服务（重启救不了 DB）。',
      }
    }
    if (svc.attachMode || !snap.config.pgEmbedded) {
      return {
        tone: 'warn',
        text: '外部服务数据库不可用，本应用不代管——请恢复外部数据库实例后点「重试服务」重新附加。',
      }
    }
    return {
      tone: 'warn',
      text: '内嵌数据库未就绪——点右上「重试服务」重新拉起数据库（数据目录不会被删除）；反复失败请「打开日志文件夹」查看 postgres 日志。',
    }
  }

  if (svc.state === 'failed' && svc.message?.startsWith('启动失败：')) {
    if (!packaged) return { tone: 'err', text: svc.message }
    return {
      tone: 'err',
      text: `服务进程未能启动（${spawnErrorFact(svc.message)}）——常见原因：安全软件拦截或安装包损坏。点「重试服务」再试一次；反复失败请重装应用。`,
    }
  }

  if (svc.state === 'failed' && svc.attachMode) {
    return {
      tone: 'err',
      text: `${svc.message ?? '已附加的外部服务不可用'}——外部实例非本应用托管，恢复后点「重试服务」重新附加。`,
    }
  }

  if (svc.state === 'failed') {
    // 预算耗尽 / 健康超时 / pg bootstrap 失败：机器层文案已含事实+对策，补动作出口
    return { tone: 'err', text: `${svc.message ?? '服务失败'}——点「重试服务」（手动重试会清零重启预算）。` }
  }

  if (svc.state === 'restarting') {
    return { tone: 'restarting', text: `${svc.message ?? '自动重启中'}（自动进行，无需操作；连续失败会有界停止）` }
  }

  if (svc.state === 'stopped') {
    return { tone: 'muted', text: '已停止——点「启动服务」重新拉起全部服务。' }
  }

  if (svc.state === 'idle' && id === 'pg' && svc.message) {
    return { tone: 'muted', text: `跳过：${svc.message}` }
  }

  // waiting/starting/running：透传机器/控制器 message（含让位端口、附加说明、启动命令）
  if (svc.message) {
    return { tone: 'info', text: svc.message }
  }
  return null
}

// ---- 首启五步进度（B1：④ console 独立步防 ③→⑤ 之间无解释停顿）----

export type StepMark = 'pending' | 'active' | 'done' | 'failed' | 'skipped'

export interface BootStep {
  id: 'pg-init' | 'pg-migrate' | 'gateway' | 'console' | 'takeover'
  label: string
  mark: StepMark
  /** 步备注（跳过原因 / 出口指引）。 */
  note?: string
}

function svcStepMark(svc: ServiceStatus): StepMark {
  switch (svc.state) {
    case 'running':
      return 'done'
    case 'starting':
    case 'waiting_health':
    case 'restarting':
      return 'active'
    case 'failed':
      return 'failed'
    default:
      return 'pending' // idle / stopped
  }
}

export function bootSteps(snap: DesktopSnapshot): BootStep[] {
  const pg = snap.services.pg
  const msg = pg.message ?? ''
  // ①② 跳过判定：外部 PG（pgEmbedded=false）或附加模式（idle + 诚实标记 message）
  const skippedDb = !snap.config.pgEmbedded || (pg.state === 'idle' && msg !== '')

  // ①② 数据库两步：preparing 阶段按 message 标记细分；supervised 后即 done
  let init: StepMark = 'pending'
  let migrate: StepMark = 'pending'
  let note: string | undefined
  if (skippedDb) {
    init = 'skipped'
    migrate = 'skipped'
    note = '跳过 · 使用外部数据库'
  } else if (pg.state === 'starting') {
    if (msg.includes(PG_MSG_DB) || msg.includes(PG_MSG_MIGRATE)) {
      init = 'done'
      migrate = 'active'
    } else {
      init = 'active'
    }
  } else if (pg.state === 'waiting_health' || pg.state === 'running' || pg.state === 'restarting') {
    init = 'done'
    migrate = 'done'
  } else if (pg.state === 'failed') {
    // 失败步定位：initdb 失败 → ①✕；迁移失败 → ①●②✕；端口/pid 等前置失败 → ①✕（横幅承载详情）
    if (msg.includes('迁移')) {
      init = 'done'
      migrate = 'failed'
    } else {
      init = 'failed'
      migrate = 'pending'
    }
  }

  const pinned = snap.contentIntent === 'boot'
  const takeover: StepMark = dualHealthy(snap)
    ? pinned
      ? 'active'
      : 'done'
    : 'pending'

  return [
    { id: 'pg-init', label: '数据库初始化', mark: init, note },
    { id: 'pg-migrate', label: '数据库迁移', mark: migrate, note },
    { id: 'gateway', label: '网关 gateway', mark: svcStepMark(snap.services.gateway) },
    { id: 'console', label: '工作台服务', mark: svcStepMark(snap.services.console) },
    {
      id: 'takeover',
      label: '接管工作台',
      mark: takeover,
      note: takeover === 'active' ? '已就绪——点「进入工作台」' : undefined,
    },
  ]
}

// ---- bootstrap 失败横幅（B6：任意启动轮次可见，不靠首启 UI 隐藏）----

export interface BannerCopy {
  title: string
  detail: string
  action: string
}

export function bootstrapBanner(snap: DesktopSnapshot): BannerCopy | null {
  const pg = snap.services.pg
  if (pg.state !== 'failed') return null
  return {
    title: '数据库初始化失败——服务栈启动已停止',
    detail: pg.message ?? '未知错误（查看数据库卡日志）',
    action: '重试初始化',
  }
}

// ---- header 动作位（「进入工作台」呼吸高亮 = S4 死路出口，全页唯一脉动）----

export interface ActionState {
  label: string
  disabled: boolean
  primary: boolean
  /** box-shadow 2s 脉动（仅钉住+双健康的死路出口）。 */
  breathe: boolean
}

export function enterWorkbenchAction(snap: DesktopSnapshot): ActionState {
  const healthy = dualHealthy(snap)
  const reason = blockingReason(snap)
  return {
    label: healthy ? '进入工作台 →' : `等待服务恢复（${reason ?? '启动中'}）…`,
    disabled: !healthy,
    primary: healthy,
    breathe: healthy && snap.contentIntent === 'boot',
  }
}

export function restartAction(snap: DesktopSnapshot): ActionState {
  const svcs = [snap.services.gateway, snap.services.console, snap.services.pg]
  const anyFailed = svcs.some((s) => s.state === 'failed')
  const anyAlive = svcs.some((s) =>
    ['starting', 'waiting_health', 'running', 'restarting'].includes(s.state)
  )
  if (anyFailed) return { label: '重试服务', disabled: false, primary: true, breathe: false }
  if (anyAlive) return { label: '重启服务', disabled: false, primary: false, breathe: false }
  return { label: '启动服务', disabled: false, primary: true, breathe: false } // D8 全停可重新拉起
}

export function stopAction(snap: DesktopSnapshot): ActionState {
  const svcs = [snap.services.gateway, snap.services.console, snap.services.pg]
  const anyAlive = svcs.some((s) =>
    ['starting', 'waiting_health', 'running', 'restarting'].includes(s.state)
  )
  return { label: '停止服务', disabled: !anyAlive, primary: false, breathe: false }
}

// ---- 等待预算（计时本地走秒：主进程只在状态变化推帧，秒数由渲染层 tick 重算）----

export function formatElapsed(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000))
  if (s < 60) return `${s}s`
  const m = Math.floor(s / 60)
  return `${m}m${String(s % 60).padStart(2, '0')}s`
}

export function waitingBudgetLine(svc: ServiceStatus, snap: DesktopSnapshot, now: number): string | null {
  if (svc.state !== 'starting' && svc.state !== 'waiting_health') return null
  if (svc.startedAt === null) return null
  const budgetMs = snap.config.healthTimeoutMs
  return `已等 ${formatElapsed(now - svc.startedAt)} / 预算 ${Math.round(budgetMs / 1000)}s`
}

// ---- 让位端口 chip（B4；M9 三服务化：gateway/console 读快照 yielded 标记）----

export function pgPortChip(snap: DesktopSnapshot): { text: string } | null {
  const pg = snap.services.pg
  if (snap.config.pgPort === null) return null
  if (!(pg.message ?? '').includes('已让位')) return null
  return { text: `端口 :${snap.config.pgPort}（默认被占用，已让位）` }
}

/** gateway/console 让位黄 chip：数据源是快照 config 的 yielded 标记 + 实际端口（§18.2 单源）。 */
export function serviceYieldChip(
  snap: DesktopSnapshot,
  id: 'gateway' | 'console'
): { text: string } | null {
  const yielded = id === 'gateway' ? snap.config.gatewayYielded : snap.config.consoleYielded
  if (!yielded) return null
  const port = id === 'gateway' ? snap.config.gatewayPort : snap.config.consolePort
  return { text: `端口 :${port}（默认被占用，已让位）` }
}

// ---- footer 事实行（D2 内联版；关于面板在菜单「关于 Dagents」）----

export function footerFacts(snap: DesktopSnapshot): { modeLine: string; pgLine: string; versionLine: string } {
  const modeLine =
    snap.config.runMode === 'packaged'
      ? '服务栈来自安装包内嵌产物（无需仓库 / pnpm / node）'
      : '当前是 dev 栈形态（本机需有仓库检出 + pnpm + node）'
  const pgLine = snap.config.pgEmbedded
    ? `内嵌 Postgres · 数据目录 ${snap.config.pgDataDir}（卸载不删除）`
    : '内嵌 Postgres 已关闭（使用外部数据库，本应用不代管）'
  const versionLine = snap.config.appVersion ? `Dagents v${snap.config.appVersion}` : ''
  return { modeLine, pgLine, versionLine }
}

// ---- 首启教育（B3：CLI agent 需自备——诚实优先于安抚）----

export const FIRST_RUN_KEY = 'dagents.desktop.onboarded.v1'

export const CLI_AGENT_NOTE_TITLE = '首次启动 · 两点说明'

export const CLI_AGENT_NOTE_LINES = [
  '本应用自带全部服务（数据库 / 网关 / 工作台），无需安装 Docker、Node 或拉取仓库。',
  '执行工作流的 CLI agent（如 claude / codex）不随包分发：请自行安装并在终端完成登录，再到工作台「Agents」页启用；未安装时相关功能会明确提示，不影响其余功能。',
] as const
