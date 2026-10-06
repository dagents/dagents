# dagents 桌面客户端 · Electron 兼容矩阵（M7，2026-10-07）

> 痛点②的交付物（需求 inScope 原文）：「页面 × 功能 × 结论 × 证据」全表。
> **验证环境**：win32 真机（Windows 10 19045），desktop dev 形态（`electron . --remote-debugging-port=9333`，编排器拉起内嵌 PG + gateway dev + console dev），经 CDP（Runtime.evaluate / Input.dispatchKeyEvent/MouseEvent——真实输入流）驱动页面逐项验证；宿主与 renderer 的所有断言均为本 session 实跑输出。
> 结论三值：**可用**（真机过）/ **修复后可用**（指向修复提交）/ **明示边界**（文档化行为差异，不劣化核心功能）。
> 验收口径：验收员按下表逐项复验；「证据」列给出可复放的探针命令/断言点。

## 总表

| # | 功能 | 结论 | 证据（本 session 真机实跑） |
|---|---|---|---|
| 1 | 外链/新窗口（`target="_blank"`、`window.open`） | **修复后可用** | 壳层 `setWindowOpenHandler`（src/main/index.ts）：http(s) 一律 `shell.openExternal`（默认浏览器）+ deny 开子窗口。实测：console 页 `window.open('http://127.0.0.1:9444/hit-external-link')` → 本地 hit-server 收到 `GET /hit-external-link`（外链真实经默认浏览器发起）且 CDP targets 恒为 1（**无裸 Electron 子窗口**）。覆盖 assistant-content.tsx:655、form-engine.tsx:159 同类场景（同一 window.open 通道） |
| 2 | 剪贴板写（`navigator.clipboard.writeText`，console 12 处） | **可用** | 焦点态实测：页面 `await navigator.clipboard.writeText('M7-CLIP-7f3k')` → 宿主 PowerShell `Get-Clipboard` 输出 `M7-CLIP-7f3k`。边界（与浏览器一致）：文档无焦点时 Chromium 拒绝（NotAllowedError）——console 的 12 处均在用户点击处理器内触发（真实交互必有焦点），无劣化 |
| 3 | 系统通知（`new Notification`，3 处；use-desktop-notification.ts:50 permission 门） | **修复后可用** | 壳层三件接线（src/main/index.ts）：`app.setAppUserModelId('dev.dagents.desktop')`（win 通知归组）+ `setPermissionRequestHandler`/`setPermissionCheckHandler` 双钩子授予（**只接 request 不接 check 时 permission getter 仍 denied**——踩过）。实测：`Notification.permission` → `'granted'`；`new Notification(...)` → `onshow` 回调触发（通知真实到达系统层） |
| 4 | `window.confirm`（3 处：agents/[id]/edit、canvas-kit-page、flow-versions-dialog） | **可用**（原「嫌疑清单」系误判） | 实测：Electron 44 renderer 的 `window.confirm` 弹 Chromium 原生模态框且阻塞返回——SendKeys `{ENTER}` 后返回 `true`、Escape 后 `false`。与浏览器行为等价，**无需修复** |
| 5 | `window.alert` | **可用（同 4 机制）** | alert/confirm 同属 Chromium JS 对话框通道（confirm 已实证弹框+返回值）；未单独跑 alert（无消费场景差异） |
| 6 | 终端页 `/terminal`（node-pty/xterm/SSE/输入） | **可用** | 实测（CDP 真实键入）：`/terminal` 挂载 `.xterm`（41 行 rows）、SSE 资源连接（performance entries 含 /shell）；真实键入 `echo M7PTY_OK` + Enter → 屏幕文本出现 **2 处** `M7PTY`（键入回显 + 命令执行输出）——输入→gateway node-pty→cmd.exe PTY→SSE 回流全链。多标签 tab 条挂载 ✓；tab 切换/新增为 console 组件层逻辑（与浏览器同码，未单测——浏览器侧既有覆盖）。packaged 形态 node-pty ABI 已由 M6 安装树 gateway db:up（含 node-pty 静态 import）实证 |
| 7 | 下载行为 | **修复后可用** | 壳层 `will-download`（src/main/index.ts）：自动落系统「下载」目录（重名加序号防覆盖）+ 完成系统通知（点通知=打开所在文件夹）。实测：页面 blob + `a.download` 点击 → `~/Downloads/m7-download-probe.txt` 出现 ✓。边界：不弹保存对话框（自动保存，浏览器是「询问/自动」可选——本机模式取自动+通知，不劣化） |
| 8 | 快捷键 vs 菜单加速器冲突 | **可用（零冲突，审查通过）** | console 绑定面（grep 实录）：Ctrl/Cmd+K（chat-layout.tsx:46 聊天聚焦）、Ctrl/Cmd+S（flow-editor 保存）、Enter/Esc（无修饰）。菜单加速器：Ctrl+R/Ctrl+Shift+I/Ctrl+=/-/0（viewMenu role 内置）、Ctrl+W（windowMenu close，console 未绑定——保留原生关窗=优雅退出）、M7 新增 Alt+Shift+W/S（console 无 Alt 系绑定）。**交集为空** |
| 9 | 历史返回/前进（Alt+Left / Alt+Right） | **修复后可用** | 壳层 `before-input-event`（src/main/index.ts）→ `webContents.navigationHistory`。实测（CDP 真实按键，注意 CDP modifiers 位 Alt=1）：pushState 两跳到 /agents → Alt+Left×2 → `/flows` → `/`；Alt+Right → `/flows` ✓（SPA pushState 在 navigationHistory 内） |
| 10 | 页面标题 | **可用** | console 统一 `document.title` = `Dagents`（首页/settings 均实测同值——console 侧未做分页 title，非壳层问题）；Electron 窗口标题自动同步 document.title（默认行为）。favicon：窗口无页签概念，不适用；packaged 后任务栏/窗口图标取 exe 图标 |
| 11 | 缩放（Ctrl+= / Ctrl+- / Ctrl+0） | **可用（菜单 role 内置）** | viewMenu role 自带 zoomIn/zoomOut/resetZoom（Chromium zoomLevel，页面等比缩放）——代码级接线（menu.ts viewMenu role），与浏览器同快捷键。未逐级实测像素（机制为 Chromium 原生） |
| 12 | localStorage 持久化 | **可用** | 实测：`localStorage.setItem('m7-ls','persist-ok')` → 同会话读回 ✓；默认 persist partition（`userData/Local Storage/`，Chromium 磁盘存储机制——重启 app 后存活为 Chromium 保证，未做跨会话逐字节复验，如实记录） |
| 13 | 拖放文件（防误导航） | **修复后可用（防护语义）** | 壳层 `will-navigate`（src/main/index.ts）：窗口只允许 consoleUrl 本机导航与启动态页 file://。实测：`location.href='file:///C:/Windows'` → 导航被拦（仍在 localhost:3000）。console 当前无拖放文件消费入口（画布/聊天无 drop handler——grep 无 drop 消费），矩阵记防护语义 |
| 14 | SSE / WS 长连接 | **可用** | 终端 SSE（#6 实证）；WS（gateway /ws）在 M6 packaged 验收的 gateway 启动日志 `gateway on 127.0.0.1:8080 (ws: /ws)` 在案；console 侧 run-live SSE 与终端同机制（EventSource 经 BFF 代理，浏览器/桌面同码） |
| 15 | 双向导航（启动态页 ↔ 工作台，痛点①） | **修复后可用** | contentIntent 三态（takeover.ts）+ `desktop:enterWorkbench`/`desktop:showStartupPage` IPC + preload 双通道 + 启动态页主按钮/钉住徽标 + 菜单重排。死路场景实测：工作台 → showStartupPage 钉住 → 双健康下持续钉住（6s 复核，pin 不自动解除——原病灶复现）→ 页面按钮 click → 窗口回 `localhost:3000`（一键回工作台）✓；meta 诚实文案/徽标/按钮态三断言过（见 §死路场景实录） |

## 死路场景实录（验收员复验脚本语义）

1. 双健康自动接管（auto）：启动 → 窗口 target = `http://localhost:3000/`（takeover 日志「接管工作台」）。
2. 钉住（boot）：工作台页 `window.dagentsDesktop.showStartupPage()`（preload 通道，与菜单「服务状态页」同线）→ 窗口回 `file://…/dist/renderer/index.html`；页面断言：meta=「服务健康 · 已停留在此页——点『进入工作台』或菜单…」、钉住徽标显示、「进入工作台」按钮 enabled+primary。双健康下 6s 后仍钉住（原死路状态如实保留——出口在本页按钮/菜单）。
3. 一键回（console）：`document.getElementById('btn-enter-workbench').click()` → 窗口 4s 内回 `localhost:3000`。
4. 回退回归（R16）：taskkill console dev 进程 → 窗口自动回启动态页（phase 跌落）+ 钉住自动解除 + 「已记录『进入工作台』意愿——服务恢复健康后自动接管」文案（意愿保留语义）→ 编排器有界重启 console（~10s）→ 窗口**自动接管回工作台**。did-fail-load 回退路径在 M3 起在案（takeover.ts did-fail-load 分支原样保留）。

## 壳层修复清单（对应上表「修复后可用」项）

| 修复 | 位置 | 说明 |
|---|---|---|
| 外链出口 | src/main/index.ts `wireShellCompatibility` | `setWindowOpenHandler` → http(s) 经默认浏览器，拒绝一切子窗口 |
| 通知 | 同上 + `app.setAppUserModelId` | request/check 双钩子（只接 request 不够）+ win 归组 |
| 下载 | 同上 `will-download` | 自动落下载目录（防重名）+ 完成通知 + 打开所在文件夹 |
| 历史导航 | 同上 `before-input-event` | Alt+Left/Right → navigationHistory（SPA 兼容） |
| 导航防护 | 同上 `will-navigate` | 只许 consoleUrl/file://（防拖放与误定向） |
| 双向导航 | takeover.ts / ipc.ts / preload / menu.ts / renderer | contentIntent 三态 + 双 IPC 通道 + 主按钮/徽标/诚实文案 + 菜单「进入工作台/服务状态页」重排（Alt+Shift+W/S） |

## 明示边界汇总（不劣化声明）

- **剪贴板**：无焦点时写被拒（Chromium 语义，与浏览器一致）；console 全部 12 处在点击处理器内，真实交互不触发。
- **下载**：自动保存（无「另存为」对话框）；完成通知点开=所在文件夹——浏览器「询问位置」用户可在系统浏览器完成一次性另存。
- **通知**：未签名应用的 win 通知在部分系统设置（专注助手）下的呈现受 OS 策略控制（非壳层可干预）；AppUserModelID 已归组（dev 形态 dev.dagents.desktop）。
- **标题**：console 统一 title（无分页 title）——桌面与浏览器表现一致（console 侧议题，非壳层缺陷）。
- **localStorage 跨会话**：Chromium persist partition 机制保证；本表只做了同会话读写实证。
- **ELECTRON_RUN_AS_NODE 泄漏**（packaged 形态）：gateway 子进程链上的 CLI agent（claude/codex 等 node CLI）不受影响；若用户的 CLI agent 本身是 Electron GUI 应用会被切到 node 模式（现网无此形态）——README 已记录，config.extraEnv 可针对性覆盖。

## 验证方法学备注（复验者须知）

- CDP 真实输入：`Input.dispatchKeyEvent` 的 modifiers 位是 **Alt=1 / Ctrl=2 / Meta=4 / Shift=8**（本 session 踩过 8 当 Alt 的坑）；xterm 只消费真实输入流（带 `text` 的 char 事件），DOM 合成 KeyboardEvent 无效。
- 剪贴板/焦点依赖项：先 `Page.bringToFront` + 真实鼠标点击（`Input.dispatchMouseEvent`）拿焦点再 evaluate——纯 `Runtime.evaluate` 无焦点。
- `window.confirm` 会阻塞 CDP evaluate（同步模态）——用 SendKeys（PowerShell `WScript.Shell`）驱动模态按钮。
- 外链验证用本地 hit-server（`http.createServer` 监听随机口）作为 `window.open` 目标，服务端收到 GET 即证明 `shell.openExternal` 真实链路（比数窗口数更强的断言）。
