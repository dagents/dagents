// 启动态/错误态页脚本（M2）：消费 window.dagentsDesktop（preload 桥）渲染真实编排
// 状态——两服务状态/进度、日志尾部（等宽滚动）、db-down 引导、重试/停止按钮。
// 无框架经典 script；所有动态内容经 textContent 注入（无 innerHTML，无注入面）。

interface ServiceStatusView {
  id: 'gateway' | 'console' | 'pg'
  state: string
  attachMode: boolean
  db: 'up' | 'down' | 'unknown'
  attempts: number
  lastExit: { code: number | null } | null
  startedAt: number | null
  message: string | null
}

interface SnapshotView {
  phase: 'boot' | 'console'
  services: { gateway: ServiceStatusView; console: ServiceStatusView; pg: ServiceStatusView }
  logTail: { gateway: string[]; console: string[]; pg: string[] }
  config: {
    repoRoot: string
    consoleUrl: string
    gatewayPort: number
    consolePort: number
    runMode: 'dev' | 'packaged'
    pgPort: number | null
    pgEmbedded: boolean
    pgDataDir: string
  }
  at: number
}

interface DesktopApi {
  getState(): Promise<SnapshotView>
  onState(cb: (snap: SnapshotView) => void): () => void
  restart(): Promise<void>
  stop(): Promise<void>
  openExternal(url: string): Promise<void>
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

const SERVICE_TITLES: Record<string, string> = {
  gateway: 'gateway · 网关',
  console: 'console · 工作台',
  pg: 'postgres · 内嵌数据库',
}

interface LogPane {
  pre: HTMLPreElement
  pinnedToBottom: boolean
}

const logPanes: Record<string, LogPane> = {}

function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  opts: { cls?: string; text?: string } = {}
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag)
  if (opts.cls) node.className = opts.cls
  if (opts.text !== undefined) node.textContent = opts.text
  return node
}

function buildServiceCard(id: 'gateway' | 'console' | 'pg', port: number | null): HTMLElement {
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
  attachChip.style.display = 'none'
  head.appendChild(attachChip)
  card.appendChild(head)

  const factsText =
    id === 'pg'
      ? port === null
        ? '端口未启用（外部 Postgres 或附加模式）'
        : `端口 :${port} · 数据目录本地保留`
      : `端口 :${port}`
  const facts = el('div', { cls: 'facts', text: factsText })
  facts.dataset.role = 'facts'
  facts.dataset.base = factsText
  card.appendChild(facts)

  const message = el('div', { cls: 'message' })
  message.dataset.role = 'message'
  card.appendChild(message)

  const pre = el('pre', { cls: 'log', text: '（暂无日志）' })
  const pane: LogPane = {
    pre,
    pinnedToBottom: true,
  }
  pre.addEventListener('scroll', () => {
    pane.pinnedToBottom = pre.scrollTop + pre.clientHeight >= pre.scrollHeight - 8
  })
  logPanes[id] = pane
  card.appendChild(pre)
  return card
}

function renderService(svc: ServiceStatusView, card: HTMLElement): void {
  const stateChip = card.querySelector<HTMLElement>('[data-role="state"]')
  if (stateChip) {
    stateChip.className = `chip state-${svc.state}`
    stateChip.textContent = STATE_LABELS[svc.state] ?? svc.state
  }
  const dbChip = card.querySelector<HTMLElement>('[data-role="db"]')
  if (dbChip) {
    if (svc.id === 'gateway') {
      dbChip.style.display = ''
      dbChip.className = `chip db-${svc.db}`
      dbChip.textContent = svc.db === 'up' ? 'DB 正常' : svc.db === 'down' ? 'Postgres 未就绪' : 'DB 未知'
    } else {
      dbChip.style.display = 'none'
    }
  }
  const attachChip = card.querySelector<HTMLElement>('[data-role="attach"]')
  if (attachChip) attachChip.style.display = svc.attachMode ? '' : 'none'

  const facts = card.querySelector<HTMLElement>('[data-role="facts"]')
  if (facts) {
    const bits: string[] = []
    if (svc.attempts > 0) bits.push(`本窗口重启 ${svc.attempts} 次`)
    if (svc.lastExit) bits.push(`上次退出码 ${svc.lastExit.code ?? 'null'}`)
    if (svc.startedAt && (svc.state === 'running' || svc.state === 'waiting_health')) {
      bits.push(`started ${new Date(svc.startedAt).toLocaleTimeString('zh-CN')}`)
    }
    facts.textContent = `${facts.dataset.base ?? ''}${bits.length > 0 ? ' · ' + bits.join(' · ') : ''}`
  }

  const message = card.querySelector<HTMLElement>('[data-role="message"]')
  if (message) message.textContent = svc.message ?? ''
}

function renderLogs(id: string, lines: string[]): void {
  const pane = logPanes[id]
  if (!pane) return
  const text = lines.length > 0 ? lines.join('\n') : '（暂无日志）'
  if (pane.pre.textContent === text) return
  pane.pre.textContent = text
  if (pane.pinnedToBottom) pane.pre.scrollTop = pane.pre.scrollHeight
}

function renderSnapshot(snap: SnapshotView): void {
  const grid = document.getElementById('grid')
  if (grid) {
    if (grid.children.length === 0) {
      grid.appendChild(buildServiceCard('gateway', snap.config.gatewayPort))
      grid.appendChild(buildServiceCard('console', snap.config.consolePort))
      grid.appendChild(buildServiceCard('pg', snap.config.pgPort))
    }
    const gw = grid.querySelector<HTMLElement>('[data-svc="gateway"]')
    const cs = grid.querySelector<HTMLElement>('[data-svc="console"]')
    const pg = grid.querySelector<HTMLElement>('[data-svc="pg"]')
    if (gw) renderService(snap.services.gateway, gw)
    if (cs) renderService(snap.services.console, cs)
    if (pg) renderService(snap.services.pg, pg)
  }
  renderLogs('gateway', snap.logTail.gateway)
  renderLogs('console', snap.logTail.console)
  renderLogs('pg', snap.logTail.pg)

  const meta = document.getElementById('meta')
  if (meta) {
    const pgFailed = snap.services.pg.state === 'failed'
    const gwDown = snap.services.gateway.db === 'down'
    if (pgFailed) {
      meta.textContent = '内嵌 Postgres 启动失败 · gateway 未启动（看第三卡日志与指引）'
    } else if (gwDown) {
      meta.textContent = '服务已起（Postgres 未就绪，不接管工作台）'
    } else if (snap.phase === 'console') {
      meta.textContent = '双服务健康 · 正在接管工作台…'
    } else {
      meta.textContent = `启动编排中（pg → gateway → console）· 仓库 ${snap.config.repoRoot}`
    }
  }

  const btnRestart = document.getElementById('btn-restart') as HTMLButtonElement | null
  const btnStop = document.getElementById('btn-stop') as HTMLButtonElement | null
  const anyFailed =
    snap.services.gateway.state === 'failed' ||
    snap.services.console.state === 'failed' ||
    snap.services.pg.state === 'failed'
  const anyAlive = ['starting', 'waiting_health', 'running', 'restarting'].some((s) =>
    [snap.services.gateway.state, snap.services.console.state, snap.services.pg.state].includes(s)
  )
  if (btnRestart) {
    btnRestart.disabled = !(desktopApi && (anyFailed || anyAlive))
    btnRestart.textContent = anyFailed ? '重试服务' : '重启服务'
  }
  if (btnStop) btnStop.disabled = !(desktopApi && anyAlive)

  const footer = document.getElementById('footer')
  if (footer) {
    footer.textContent = ''
    const pgPart = snap.config.pgEmbedded
      ? `内嵌 Postgres 已启用（数据目录 ${snap.config.pgDataDir}，卸载不删除）。`
      : '内嵌 Postgres 已关闭（使用外部数据库）。'
    const modePart =
      snap.config.runMode === 'packaged'
        ? '服务栈来自安装包内嵌产物（ELECTRON_RUN_AS_NODE 拉起，无需仓库/pnpm/node）。'
        : '当前是 dev 栈形态（本机需有仓库检出 + pnpm + node）。'
    footer.appendChild(el('span', { text: `${pgPart}${modePart}可 ` }))
    const link = el('a', { text: '在浏览器打开 console' })
    link.addEventListener('click', () => {
      void desktopApi?.openExternal(snap.config.consoleUrl)
    })
    footer.appendChild(link)
  }
}

let desktopApi: DesktopApi | undefined

function main(): void {
  desktopApi = (window as Window & { dagentsDesktop?: DesktopApi }).dagentsDesktop
  const api = desktopApi
  const meta = document.getElementById('meta')
  if (!api) {
    if (meta) meta.textContent = '⚠️ 主进程桥不可用（preload 未注入）——这是缺陷，请报告'
    return
  }

  const btnRestart = document.getElementById('btn-restart')
  const btnStop = document.getElementById('btn-stop')
  btnRestart?.addEventListener('click', () => {
    void api.restart()
  })
  btnStop?.addEventListener('click', () => {
    void api.stop()
  })

  void api
    .getState()
    .then((snap) => renderSnapshot(snap))
    .catch(() => undefined)
  api.onState((snap) => renderSnapshot(snap))
}

main()
