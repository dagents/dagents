import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { app, BrowserWindow, dialog, Notification, session, shell } from 'electron'
import { loadConfig } from './orchestrator/config'
import { resolvePgPaths } from './orchestrator/pg-service'
import { resolveRunMode } from './orchestrator/run-mode'
import { Orchestrator } from './orchestrator/supervisor'
import { registerDesktopIpc } from './ipc'
import { buildAppMenu } from './menu'
import { createRuntimeDeps } from './spawn-runtime'
import { createTakeoverController, type TakeoverController } from './takeover'
import {
  claimManagedChild,
  expectManagedChild,
  managedChildCount,
} from './managed-children'
import { classifyOpenUrl, consoleOriginOf, managedChildBounds } from './window-open-policy'
import { createMainWindow, focusMainWindow, getMainWindow } from './windows'

// 主入口（docs §3.1 进程模型 + §10.2 内嵌 PG 编排 + §11.4 三级模式开关 +
// §12.2 双向导航 + §13 壳层兼容修复）：
//   app ready → 加载配置 → 探测运行形态 → 建编排器（pg bootstrap → gateway/console）
//   → 窗口（阶段 A 启动态页）→ IPC 桥 + 菜单 + 接管控制器 → 编排启动
//   双健康（computePhase）→ 窗口 loadURL(consoleUrl) 进入阶段 B；
//   console 崩溃/健康跌落 → 回退阶段 A 显示有界重启与引导。
// 退出：window-all-closed → app.quit() → will-quit 先全量树终止再退（无孤儿语义；
//   停止顺序 console → gateway → pg，pg_ctl fast 优先）。
//
// 壳层兼容（M7，兼容矩阵 docs/desktop-compat-matrix.md 的接线面）：
//   - setWindowOpenHandler：外链一律 shell.openExternal（默认浏览器），不开裸子窗口
//   - will-navigate：窗口只允许 consoleUrl 本机导航（防拖放文件/误拖导航离开 app）
//   - 通知：AppUserModelID（win 通知归组）+ permission request/check 双钩子授予
//   - 下载：自动落「下载」目录（重名加序号），完成后系统通知 + 打开所在文件夹入口
//   - Alt+Left/Right：历史返回/前进（console 是 SPA，Chromium navigationHistory 含 pushState）

let orchestrator: Orchestrator | null = null
let takeover: TakeoverController | null = null

const gotLock = app.requestSingleInstanceLock()
if (!gotLock) {
  app.quit()
} else {
  // win 通知归组（无此设置通知会挂在 explorer 名下甚至不显示）——packaged 后 exe
  // 有 AppUserModelID 资源，dev 形态靠这行兜底；取 electron-builder appId 同值
  if (process.platform === 'win32') app.setAppUserModelId('dev.dagents.desktop')

  app.on('second-instance', () => focusMainWindow())

  void app.whenReady().then(() => {
    const userData = app.getPath('userData')
    const desktopDir = app.getAppPath()
    const { config, warnings } = loadConfig({
      userDataDir: userData,
      // dev 模式 = apps/desktop（electron .）→ 向上发现 pnpm-workspace.yaml 即仓库根
      startDir: desktopDir,
    })
    for (const w of warnings) console.warn(`[desktop-config] ${w}`)

    // 三级模式开关（docs §11.4）：安装包的 resourcesPath 下有 services/gateway/dist
    // → packaged；dev（electron .）的 resourcesPath 是 electron 发行目录，自然回落 dev。
    const resourcesDir = process.resourcesPath
    const packagedServicesDir = join(resourcesDir, 'services')
    const runMode = resolveRunMode(config, {
      packagedServicesExists: existsSync(join(packagedServicesDir, 'gateway', 'dist')),
    })
    const pgPaths = resolvePgPaths(config.postgres, {
      userDataDir: userData,
      desktopDir,
      repoRoot: config.repoRoot,
      packaged:
        runMode === 'packaged'
          ? {
              servicesDir: packagedServicesDir,
              pgNativeDir: join(resourcesDir, 'pg', 'native'),
              execPath: process.execPath,
            }
          : undefined,
    })

    // 接管 URL 单源（docs §18.2）：config 显式 consoleUrl（逃生门）优先，否则由
    // 编排器端口计划派生（让位/附加后端口正确）——getter 形式，五处消费全现读。
    const consoleUrlOf = () =>
      orchestrator?.consoleUrl() ??
      (config.consoleUrl !== '' ? config.consoleUrl : `http://localhost:${config.services.console.port}`)

    // 壳层兼容接线（窗口创建前——session/webContents 钩子要在内容加载前就位）
    wireShellCompatibility(consoleUrlOf)

    const logsDir = join(userData, 'logs')
    orchestrator = new Orchestrator(
      config,
      createRuntimeDeps(config, {
        logDir: logsDir,
        pgRequireRoot: pgPaths.pgRequireRoot,
      }),
      {
        pgPaths,
        runMode,
        // 服务子进程环境基底：父环境全量（PATH 是 gateway 内 spawn CLI agent 的前提）
        parentEnv: process.env as unknown as Record<string, string>,
        packaged:
          runMode === 'packaged'
            ? { servicesDir: packagedServicesDir, execPath: process.execPath }
            : undefined,
        // takeover 意愿经闭包进快照（契约由 tsc 钉住——index 先建 takeover 再建编排器）
        contentIntent: () => takeover?.contentIntent() ?? 'auto',
        // 关于面板信息（D2）——快照投影到状态页 footer
        about: { appVersion: app.getVersion(), logsDir },
      }
    )

    const win = createMainWindow()
    takeover = createTakeoverController({
      win,
      consoleUrl: consoleUrlOf,
      log: (line) => console.log(`[takeover] ${line}`),
    })
    registerDesktopIpc(win, orchestrator, {
      onEnterWorkbench: () => takeover?.enterWorkbench(),
      onShowStartupPage: () => takeover?.showStartupPage(),
    })
    buildAppMenu({
      onEnterWorkbench: () => takeover?.enterWorkbench(),
      onShowStartupPage: () => takeover?.showStartupPage(),
      onRestartServices: () => void orchestrator?.restartAll(),
      onStopServices: () => void orchestrator?.stopAll(),
      onOpenConsoleInBrowser: () => void shell.openExternal(consoleUrlOf()),
      onOpenDataFolder: () =>
        void shell.openPath(orchestrator?.snapshot().config.pgDataDir ?? userData),
      onOpenLogsFolder: () => void shell.openPath(logsDir),
      onAbout: () => showAboutDialog(),
    })

    // mac dock 点击：窗口已全关时重建
    app.on('activate', () => {
      if (!getMainWindow()) createMainWindow()
    })

    orchestrator.onChange(() => {
      const orch = orchestrator
      if (orch) takeover?.onSnapshot(orch.snapshot())
    })
    takeover.onSnapshot(orchestrator.snapshot())
    orchestrator.start()
  })

  app.on('window-all-closed', () => {
    app.quit()
  })

  // 关窗即退出的收尾：先全量树终止（端口释放校验在 stopAll 内），再真正退出。
  // 6s 兜底防止 taskkill 卡死拖住退出（正常 <1s）。
  app.on('will-quit', (event) => {
    if (orchestrator === null) return
    const orch = orchestrator
    event.preventDefault()
    void Promise.race([orch.stopAll(), new Promise((r) => setTimeout(r, 6_000))]).then(() => {
      app.exit(0)
    })
  })
}

/** 壳层兼容接线（docs §13，M7；§18.2 consoleUrl getter 化，M8）：外链/导航防护/通知/下载/历史返回。 */
function wireShellCompatibility(consoleUrl: () => string): void {
  const ses = session.defaultSession

  // 通知权限：request（new Notification 触发）与 check（Notification.permission 查询）
  // 两个钩子都要接——只接 request 时 permission getter 仍报 denied，console 的
  // use-desktop-notification.ts:50 门就过不去
  const allow = new Set(['notifications', 'clipboard-sanitized-write', 'clipboard-read'])
  ses.setPermissionRequestHandler((_wc, permission, callback) => {
    callback(allow.has(permission))
  })
  ses.setPermissionCheckHandler((_wc, permission) => allow.has(permission))

  // 下载：不弹系统保存框（无人值守退避），自动落「下载」目录，重名加序号防覆盖；
  // 完成后系统通知（win 需上方 AppUserModelID 归组）+ 「打开所在文件夹」入口
  ses.on('will-download', (_event, item) => {
    const downloads = app.getPath('downloads')
    const base = item.getFilename() || 'dagents-download'
    let target = join(downloads, base)
    for (let i = 1; existsSync(target); i++) {
      const dot = base.lastIndexOf('.')
      target = join(
        downloads,
        dot > 0 ? `${base.slice(0, dot)} (${i})${base.slice(dot)}` : `${base} (${i})`
      )
    }
    item.setSavePath(target)
    item.once('done', (_e, state) => {
      if (state !== 'completed') return
      if (!Notification.isSupported()) return
      const notify = new Notification({
        title: '下载完成',
        body: `${base} 已保存到「下载」文件夹`,
      })
      notify.on('click', () => void shell.showItemInFolder(target))
      notify.show()
    })
  })

  // 窗口级钩子在窗口创建后挂（createMainWindow 内已加载 boot 页——钩子对后续导航生效）
  app.on('browser-window-created', (_event, win: BrowserWindow) => {
    const wc = win.webContents
    // 受管子窗认领（U2 三分支）：放行计数在等 → 本窗即受管子窗（主窗/devtools 不被误收）
    if (claimManagedChild(win)) {
      console.log(`[shell] 受管子窗开启（在开 ${managedChildCount()} 个）`)
    }
    // 外链三分支（体验规格 flows「外部链接与新窗口三分支」——单点防线）：
    //   同源 → 受管子窗（继承 preload、0.8×主窗、24px 级联；title 随页面文档 C15）
    //   异源 http(s)/mailto（含 :8080/:3001）→ 系统默认浏览器
    //   其余协议 → deny（无裸 Electron 子窗口）
    // origin 必须在 handler 回调内现读 getter（docs §18.2）：主窗创建早于端口计划求出
    // （startAsync 在窗口创建后才跑），创建期捕获会把 origin 钉死在默认 :3000——让位
    // 形态下同源链接被误判 external 进系统浏览器（M10 S6 真机抓到的 M8 回归）。
    wc.setWindowOpenHandler(({ url }) => {
      const decision = classifyOpenUrl(url, consoleOriginOf(consoleUrl()))
      if (decision === 'managed') {
        expectManagedChild()
        const main = getMainWindow()
        const parent = main && !main.isDestroyed() ? main.getNormalBounds() : null
        const bounds = parent ? managedChildBounds(parent, managedChildCount()) : undefined
        return {
          action: 'allow',
          overrideBrowserWindowOptions: {
            ...(bounds ?? {}),
            // 不设 title——子窗标题随页面 document.title（C15）；继承主窗 preload 语义
            webPreferences: {
              preload: join(__dirname, '../preload/index.js'),
              contextIsolation: true,
              sandbox: true,
              nodeIntegration: false,
            },
          },
        }
      }
      if (decision === 'external') {
        void shell.openExternal(url)
      }
      return { action: 'deny' }
    })
    // 导航防护：窗口只许本机 consoleUrl 与启动态页（file://）——拖放文件到窗口、
    // 意外重定向等一律拒绝，窗口内容只归编排器管（受管子窗同样只许 console 同源）。
    // allowlist 每次事件现读 getter（让位端口会变，docs §18.2）
    wc.on('will-navigate', (event, url) => {
      const cu = consoleUrl()
      const allowed = url === cu || url.startsWith(`${cu}/`) || url.startsWith('file://')
      if (!allowed) event.preventDefault()
    })
    // 历史返回/前进（console 为 SPA，pushState 也在 navigationHistory 里）
    wc.on('before-input-event', (event, input) => {
      const altOnly = input.alt && !input.control && !input.meta && !input.shift
      if (altOnly && input.key === 'ArrowLeft') {
        if (wc.navigationHistory.canGoBack()) {
          wc.navigationHistory.goBack()
          event.preventDefault()
        }
      } else if (altOnly && input.key === 'ArrowRight') {
        if (wc.navigationHistory.canGoForward()) {
          wc.navigationHistory.goForward()
          event.preventDefault()
        }
      }
    })
  })

  // 全局兜底：webContents 新建（多窗口防御）同样挂外链策略（非 window 类型无受管分支）
  app.on('web-contents-created', (_event, contents) => {
    if (contents.getType() === 'window') return // browser-window-created 已处理
    contents.setWindowOpenHandler(({ url }) => {
      if (/^https?:\/\//i.test(url)) void shell.openExternal(url)
      return { action: 'deny' }
    })
  })
}

/** 关于面板（D2）：版本/运行形态/数据目录/日志目录/未签名提示/关窗即退出提示。 */
function showAboutDialog(): void {
  const orch = orchestrator
  const snap = orch?.snapshot()
  const mode = snap?.config.runMode === 'packaged' ? '安装包内嵌服务栈（无需仓库/pnpm/node）' : '开发栈（本机仓库 + pnpm + node）'
  const dataDir = snap?.config.pgDataDir ?? app.getPath('userData')
  const logsDir = snap?.config.logsDir ?? join(app.getPath('userData'), 'logs')
  void dialog.showMessageBox({
    type: 'none',
    title: '关于 Dagents',
    message: `Dagents 桌面客户端 v${app.getVersion()}`,
    detail: [
      `运行形态：${mode}`,
      `数据目录：${dataDir}（卸载不会删除）`,
      `日志目录：${logsDir}`,
      '安装包未签名——被 SmartScreen/Gatekeeper 拦截时的绕过方法见 apps/desktop/README.md。',
      '关闭窗口即退出：gateway / console / 内嵌 Postgres 会一并停止。',
    ].join('\n'),
    buttons: ['好的'],
    defaultId: 0,
  })
}
