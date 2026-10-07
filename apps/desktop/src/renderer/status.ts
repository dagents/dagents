// 服务状态页装配层（U1 产品化）：消费 window.dagentsDesktop（preload 桥）渲染编排状态。
// 文案与投影逻辑全部在 ./status-copy（纯函数 + 单测）；本文件只做 DOM 装配与副作用：
//   - header：全局状态灯 / 钉住徽标 / 诚实 meta / 三个动作位（呼吸高亮 = 死路出口）
//   - bootstrap 失败红横幅（B6）/ 首启五步进度（B1）/ 首启教育（B3）
//   - 三服务卡：状态 chip / 等待预算行（本地 1s 走秒）/ 分级 message / 日志面板（D7）
// 无框架经典 script；所有动态内容经 textContent 注入（无 innerHTML，无注入面）。

import type { DesktopSnapshot, ServiceId, ServiceStatus } from '../main/orchestrator/types'
import {
  CLI_AGENT_NOTE_LINES,
  CLI_AGENT_NOTE_TITLE,
  FIRST_RUN_KEY,
  bootSteps,
  bootstrapBanner,
  describeService,
  enterWorkbenchAction,
  footerFacts,
  globalLight,
  metaLine,
  pgPortChip,
  restartAction,
  serviceYieldChip,
  stopAction,
  waitingBudgetLine,
  type BootStep,
  type StepMark,
} from './status-copy.js'

interface DesktopApi {
  getState(): Promise<DesktopSnapshot>
  onState(cb: (snap: DesktopSnapshot) => void): () => void
  restart(): Promise<void>
  stop(): Promise<void>
  /** 双向导航（docs §12.2）：意愿进工作台 / 钉住本页。 */
  enterWorkbench(): Promise<void>
  showStartupPage(): Promise<void>
  openExternal(url: string): Promise<void>
  openLogsFolder(): Promise<void>
  openDataFolder(): Promise<void>
  copyLogTail(id: ServiceId): Promise<number>
}

const STATE_LABELS: Record<string, string> = {
  idle: '待命',
  starting: '启动中',
  waiting_health: '等待健康检查',
  running: '运行中',
  restarting: '自动重启中',
  failed: '失败',
  stopped: '已停止',
}

const SERVICE_TITLES: Record<ServiceId, string> = {
  gateway: 'gateway · 网关',
  console: 'console · 工作台',
  pg: 'postgres · 数据库',
}

/**
 * 卡片副标题（信息层级：每个服务「是什么」一句话）。端口不写死在这里——
 * 让位后实际端口由 facts 行动态读快照（§18.2 单源；M9 前静态 :8080/:3000
 * 在让位形态下是错的事实）。
 */
const SERVICE_ROLES: Record<ServiceId, string> = {
  gateway: '本地 API 网关，连接工作台与执行引擎',
  console: '工作台界面服务（浏览器里看到的页面）',
  pg: '本机数据存储，工作流 / 会话 / 配置都在这里',
}

const STEP_GLYPHS: Record<StepMark, string> = {
  pending: '○',
  active: '◐',
  done: '●',
  failed: '✕',
  skipped: '◔',
}

interface LogPane {
  pre: HTMLPreElement
  pinnedToBottom: boolean
}

const logPanes: Record<string, LogPane> = {}
let desktopApi: DesktopApi | undefined
let lastSnap: DesktopSnapshot | null = null
let onboardingDismissed = false

function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  opts: { cls?: string; text?: string } = {}
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag)
  if (opts.cls) node.className = opts.cls
  if (opts.text !== undefined) node.textContent = opts.text
  return node
}

function text(id: string, value: string): void {
  const node = document.getElementById(id)
  if (node && node.textContent !== value) node.textContent = value
}

function buildServiceCard(id: ServiceId): HTMLElement {
  const card = el('section', { cls: 'svc' })
  card.dataset.svc = id

  const head = el('div', { cls: 'svc-head' })
  head.appendChild(el('h2', { text: SERVICE_TITLES[id] }))
  const stateChip = el('span', { cls: 'chip state', text: '—' })
  stateChip.dataset.role = 'state'
  head.appendChild(stateChip)
  const dbChip = el('span', { cls: 'chip db', text: '' })
  dbChip.dataset.role = 'db'
  head.appendChild(dbChip)
  const attachChip = el('span', { cls: 'chip attach', text: '附加模式' })
  attachChip.dataset.role = 'attach'
  attachChip.hidden = true
  head.appendChild(attachChip)
  const yieldChip = el('span', { cls: 'chip yield', text: '' })
  yieldChip.dataset.role = 'yield'
  yieldChip.hidden = true
  head.appendChild(yieldChip)
  const extChip = el('span', { cls: 'chip ext', text: '外部模式' })
  extChip.dataset.role = 'ext'
  extChip.hidden = true
  head.appendChild(extChip)
  card.appendChild(head)

  card.appendChild(el('p', { cls: 'role', text: SERVICE_ROLES[id] }))

  const facts = el('div', { cls: 'facts' })
  facts.dataset.role = 'facts'
  card.appendChild(facts)

  const budget = el('div', { cls: 'budget' })
  budget.dataset.role = 'budget'
  card.appendChild(budget)

  const message = el('div', { cls: 'message' })
  message.dataset.role = 'message'
  card.appendChild(message)

  // 日志面板标题行（D7）：复制最近 400 行（主进程 clipboard，无权限/焦点坑）+ 打开完整日志
  const logHead = el('div', { cls: 'log-head' })
  logHead.appendChild(el('span', { cls: 'log-title', text: 'LOG' }))
  const btnCopy = el('button', { text: '复制最近 400 行' })
  btnCopy.dataset.act = 'copy-log'
  logHead.appendChild(btnCopy)
  const btnOpen = el('button', { text: '打开完整日志' })
  btnOpen.dataset.act = 'open-log'
  logHead.appendChild(btnOpen)
  card.appendChild(logHead)

  const pre = el('pre', { cls: 'log', text: '（暂无日志）' })
  const pane: LogPane = { pre, pinnedToBottom: true }
  pre.addEventListener('scroll', () => {
    pane.pinnedToBottom = pre.scrollTop + pre.clientHeight >= pre.scrollHeight - 8
  })
  logPanes[id] = pane
  card.appendChild(pre)
  return card
}

function renderService(svc: ServiceStatus, snap: DesktopSnapshot, card: HTMLElement): void {
  const stateChip = card.querySelector<HTMLElement>('[data-role="state"]')
  if (stateChip) {
    stateChip.className = `chip state-${svc.state}`
    stateChip.textContent = STATE_LABELS[svc.state] ?? svc.state
  }
  const dbChip = card.querySelector<HTMLElement>('[data-role="db"]')
  if (dbChip) {
    if (svc.id === 'gateway') {
      dbChip.hidden = false
      dbChip.className = `chip db-${svc.db}`
      dbChip.textContent = svc.db === 'up' ? 'DB 正常' : svc.db === 'down' ? 'Postgres 未就绪' : ''
    } else {
      dbChip.hidden = true
    }
  }
  const attachChip = card.querySelector<HTMLElement>('[data-role="attach"]')
  if (attachChip) attachChip.hidden = !svc.attachMode

  const port = svc.id === 'gateway' ? snap.config.gatewayPort : svc.id === 'console' ? snap.config.consolePort : snap.config.pgPort
  const facts = card.querySelector<HTMLElement>('[data-role="facts"]')
  if (facts) {
    const bits: string[] = []
    if (svc.id === 'pg') {
      bits.push(port === null ? '端口未启用（外部 Postgres 或附加模式）' : `端口 :${port} · 数据目录本地保留`)
    } else {
      bits.push(`端口 :${port}`)
    }
    if (svc.attempts > 0) bits.push(`本窗口重启 ${svc.attempts} 次`)
    if (svc.lastExit) bits.push(`上次退出码 ${svc.lastExit.code ?? 'null'}`)
    if (svc.startedAt && (svc.state === 'running' || svc.state === 'waiting_health')) {
      bits.push(`started ${new Date(svc.startedAt).toLocaleTimeString('zh-CN')}`)
    }
    const joined = bits.join(' · ')
    if (facts.textContent !== joined) facts.textContent = joined
  }

  // 等待预算行（本地 1s tick 重算——主进程只在状态变化推帧）
  const budget = card.querySelector<HTMLElement>('[data-role="budget"]')
  if (budget) {
    const line = waitingBudgetLine(svc, snap, Date.now())
    if (budget.textContent !== line) budget.textContent = line ?? ''
  }

  // 分级 message（错误引导分级 / 模式分叉文案——真相源 status-copy）
  const message = card.querySelector<HTMLElement>('[data-role="message"]')
  if (message) {
    const copy = describeService(svc.id, svc, snap)
    const cls = copy ? `message tone-${copy.tone}` : 'message'
    if (message.className !== cls) message.className = cls
    if (message.textContent !== (copy?.text ?? '')) message.textContent = copy?.text ?? ''
  }

  // 让位黄 chip（B4，M9 三服务化）：gateway/console 读快照 yielded 标记（§18.2），
  // pg 沿用 message 判定（pgPortChip）
  const yieldChip = card.querySelector<HTMLElement>('[data-role="yield"]')
  const chip =
    svc.id === 'pg' ? pgPortChip(snap) : serviceYieldChip(snap, svc.id as 'gateway' | 'console')
  if (yieldChip) {
    yieldChip.hidden = chip === null
    if (chip && yieldChip.textContent !== chip.text) yieldChip.textContent = chip.text
  }

  // pg 卡专属：外部/附加灰态（visualNotes）
  if (svc.id === 'pg') {
    const extChip = card.querySelector<HTMLElement>('[data-role="ext"]')
    const external = !snap.config.pgEmbedded || (svc.state === 'idle' && svc.message !== null)
    if (extChip) extChip.hidden = !external
    card.classList.toggle('inert', external)
  }
}

function renderLogs(id: ServiceId, lines: string[]): void {
  const pane = logPanes[id]
  if (!pane) return
  const value = lines.length > 0 ? lines.join('\n') : '（暂无日志）'
  if (pane.pre.textContent === value) return
  pane.pre.textContent = value
  if (pane.pinnedToBottom) pane.pre.scrollTop = pane.pre.scrollHeight
}

function renderSteps(snap: DesktopSnapshot): void {
  const wrap = document.getElementById('steps-wrap')
  const list = document.getElementById('steps')
  if (!wrap || !list) return
  const steps: BootStep[] = bootSteps(snap)
  const pinned = snap.contentIntent === 'boot'
  const allDone = steps.every((s) => s.mark === 'done' || s.mark === 'skipped')
  wrap.hidden = allDone && !pinned // 全完成且未钉住 → 收起（二次启动不常驻步条）
  if (wrap.hidden) return
  if (list.children.length !== steps.length) {
    list.textContent = ''
    for (const step of steps) {
      const li = el('li', { cls: 'step' })
      li.dataset.step = step.id
      li.appendChild(el('span', { cls: 'glyph' }))
      li.appendChild(el('span', { cls: 'label', text: step.label }))
      li.appendChild(el('span', { cls: 'note' }))
      list.appendChild(li)
    }
  }
  for (const step of steps) {
    const li = list.querySelector<HTMLElement>(`[data-step="${step.id}"]`)
    if (!li) continue
    const cls = `step mark-${step.mark}`
    if (li.className !== cls) li.className = cls
    const glyph = li.querySelector<HTMLElement>('.glyph')
    if (glyph && glyph.textContent !== STEP_GLYPHS[step.mark]) glyph.textContent = STEP_GLYPHS[step.mark]
    const note = li.querySelector<HTMLElement>('.note')
    const noteText = step.note ?? ''
    if (note && note.textContent !== noteText) note.textContent = noteText
  }
}

function renderBanner(snap: DesktopSnapshot): void {
  const banner = document.getElementById('banner')
  const title = document.getElementById('banner-title')
  const detail = document.getElementById('banner-detail')
  const action = document.getElementById('banner-action')
  const copy = bootstrapBanner(snap)
  if (!banner || !title || !detail || !action) return
  banner.hidden = copy === null
  if (copy === null) return
  if (title.textContent !== copy.title) title.textContent = copy.title
  if (detail.textContent !== copy.detail) detail.textContent = copy.detail
  if (action.textContent !== copy.action) action.textContent = copy.action
}

function renderOnboarding(snap: DesktopSnapshot): void {
  const node = document.getElementById('onboarding')
  if (!node) return
  // 教育文案从 status-copy 注入（真相源单点，html 只留结构）
  const list = document.getElementById('onboarding-list')
  if (list && list.children.length === 0) {
    text('onboarding-title', CLI_AGENT_NOTE_TITLE)
    for (const line of CLI_AGENT_NOTE_LINES) list.appendChild(el('li', { text: line }))
  }
  if (onboardingDismissed) {
    node.hidden = true
    return
  }
  const firstRun = localStorage.getItem(FIRST_RUN_KEY) === null
  node.hidden = !firstRun
  // 自动接管发生 = 完成首次引导（B2：二次启动无 onboarding）
  if (firstRun && snap.phase === 'console') markOnboarded()
}

function markOnboarded(): void {
  try {
    localStorage.setItem(FIRST_RUN_KEY, '1')
  } catch {
    // localStorage 不可用（隐私模式等）——教育块保持可见，无害
  }
}

function renderActions(snap: DesktopSnapshot): void {
  const enter = enterWorkbenchAction(snap)
  const btnEnter = document.getElementById('btn-enter-workbench') as HTMLButtonElement | null
  if (btnEnter) {
    btnEnter.disabled = enter.disabled
    btnEnter.textContent = enter.label
    btnEnter.classList.toggle('primary', enter.primary)
    btnEnter.classList.toggle('breathe', enter.breathe)
  }
  const restart = restartAction(snap)
  const btnRestart = document.getElementById('btn-restart') as HTMLButtonElement | null
  if (btnRestart) {
    btnRestart.disabled = restart.disabled
    btnRestart.textContent = restart.label
    btnRestart.classList.toggle('primary', restart.primary)
  }
  const stop = stopAction(snap)
  const btnStop = document.getElementById('btn-stop') as HTMLButtonElement | null
  if (btnStop) {
    btnStop.disabled = stop.disabled
    btnStop.textContent = stop.label
  }
}

function renderFooter(snap: DesktopSnapshot): void {
  const footer = document.getElementById('footer')
  if (!footer) return
  footer.textContent = ''
  const { modeLine, pgLine, versionLine } = footerFacts(snap)
  const parts: string[] = []
  if (versionLine) parts.push(versionLine)
  parts.push(modeLine)
  footer.appendChild(el('span', { text: `${parts.join(' · ')}。` }))
  footer.appendChild(el('br'))
  footer.appendChild(el('span', { text: `${pgLine}。可 ` }))
  const linkData = el('a', { text: '打开数据文件夹' })
  linkData.addEventListener('click', () => void desktopApi?.openDataFolder())
  footer.appendChild(linkData)
  footer.appendChild(el('span', { text: ' / ' }))
  const linkLogs = el('a', { text: '打开日志文件夹' })
  linkLogs.addEventListener('click', () => void desktopApi?.openLogsFolder())
  footer.appendChild(linkLogs)
  footer.appendChild(el('span', { text: ' / ' }))
  const linkConsole = el('a', { text: '在浏览器打开 console' })
  linkConsole.addEventListener('click', () => void desktopApi?.openExternal(snap.config.consoleUrl))
  footer.appendChild(linkConsole)
}

function renderSnapshot(snap: DesktopSnapshot): void {
  lastSnap = snap

  // 全局状态灯（左）+ 诚实 meta + 钉住徽标
  const light = globalLight(snap)
  const lightNode = document.getElementById('global-light')
  if (lightNode) lightNode.className = `light tone-${light.tone}`
  text('global-light-label', light.label)
  text('meta', metaLine(snap))
  const pinChip = document.getElementById('pin-chip')
  if (pinChip) pinChip.hidden = snap.contentIntent !== 'boot'

  renderBanner(snap)
  renderSteps(snap)
  renderOnboarding(snap)
  renderActions(snap)
  renderFooter(snap)

  const grid = document.getElementById('grid')
  if (grid) {
    if (grid.children.length === 0) {
      grid.appendChild(buildServiceCard('pg'))
      grid.appendChild(buildServiceCard('gateway'))
      grid.appendChild(buildServiceCard('console'))
    }
    const order: ServiceId[] = ['pg', 'gateway', 'console']
    for (const id of order) {
      const card = grid.querySelector<HTMLElement>(`[data-svc="${id}"]`)
      if (card) renderService(snap.services[id], snap, card)
    }
  }
  renderLogs('gateway', snap.logTail.gateway)
  renderLogs('console', snap.logTail.console)
  renderLogs('pg', snap.logTail.pg)
}

/** 桥不可用态（S10）：页面按钮全灰（HTML 默认 disabled）+ 醒目菜单指引，不假装可操作。 */
function renderBridgeDead(): void {
  const meta = document.getElementById('meta')
  if (meta) {
    meta.textContent =
      '⚠ 主进程桥不可用（preload 未注入）——页面按钮不可用，请用顶部菜单「服务」操作（进入工作台 / 服务状态页 / 重启服务）。这是缺陷，请报告。'
  }
  const light = document.getElementById('global-light')
  if (light) light.className = 'light tone-err'
  text('global-light-label', '桥不可用')
  const banner = document.getElementById('banner')
  banner?.setAttribute('hidden', '')
}

function main(): void {
  desktopApi = (window as Window & { dagentsDesktop?: DesktopApi }).dagentsDesktop
  const api = desktopApi
  if (!api) {
    renderBridgeDead()
    return
  }

  document.getElementById('btn-restart')?.addEventListener('click', () => {
    void api.restart()
  })
  document.getElementById('btn-stop')?.addEventListener('click', () => {
    void api.stop()
  })
  document.getElementById('btn-enter-workbench')?.addEventListener('click', () => {
    markOnboarded() // 用户主动进入工作台 = 完成首次引导
    void api.enterWorkbench()
  })
  // 横幅「重试初始化」与「重启服务」同线：restartAll 含 pg bootstrap 管线（initdb→迁移→…）
  document.getElementById('banner-action')?.addEventListener('click', () => {
    void api.restart()
  })
  document.getElementById('onboarding-dismiss')?.addEventListener('click', () => {
    onboardingDismissed = true
    markOnboarded()
    const node = document.getElementById('onboarding')
    if (node) node.hidden = true
  })

  // 卡片日志工具按钮（事件委托——卡在首帧快照时才建）
  document.getElementById('grid')?.addEventListener('click', (event) => {
    const target = event.target as HTMLElement | null
    const act = target?.dataset?.act
    if (act !== 'copy-log' && act !== 'open-log') return
    const card = target?.closest<HTMLElement>('[data-svc]')
    const id = card?.dataset.svc as ServiceId | undefined
    if (id === undefined) return
    if (act === 'open-log') {
      void api.openLogsFolder()
      return
    }
    void api.copyLogTail(id).then((n) => {
      if (target && n >= 0) {
        const original = '复制最近 400 行'
        target.textContent = `已复制 ${n} 行`
        setTimeout(() => {
          target.textContent = original
        }, 1600)
      }
    })
  })

  void api
    .getState()
    .then((snap) => renderSnapshot(snap))
    .catch(() => undefined)
  api.onState((snap) => renderSnapshot(snap))

  // 计时本地走秒：主进程只在状态变化推帧，秒数由本地 1s tick 重算（防冻在旧值形似卡死）
  window.setInterval(() => {
    if (lastSnap === null) return
    renderSnapshot(lastSnap)
  }, 1_000)
}

main()
