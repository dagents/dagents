# dagents 桌面客户端 · Electron 兼容矩阵（M7 v1 → U2 v2，2026-10-07）

> 痛点②的交付物（需求 inScope 原文）：「页面 × 功能 × 结论 × 证据」全表。
> **验证环境**：win32 真机（Windows 10 19045），desktop dev 形态（`electron . --remote-debugging-port=9444`，编排器拉起内嵌 PG + gateway dev + console dev），经 CDP（Runtime.evaluate / Input.dispatchKeyEvent/MouseEvent/insertText——真实输入流）+ Win32（SetWindowPos/EnumWindows/PostMessage WM_CLOSE）+ PowerShell SendKeys/Get-Clipboard 驱动逐项验证。
> 结论三值：**可用**（真机过）/ **修复后可用**（指向修复提交）/ **明示边界**（文档化行为差异，不劣化核心功能）。
> 验收口径：验收员按下表逐项复验；「证据」列给出可复放的探针命令/断言点。
> **v2 变更（U2，2026-10-07 第二 session 全量复验）**：① 行 1 外链策略升级为三分支——同源 `window.open` 从「一律 deny」改为**受管子窗**（新增行 16/17）；② 行 2 剪贴板边界更新——M7 权限 handler 接线后**无焦点写入也成功**（实测翻案，边界比 v1 记录更宽）；③ 行 6 终端补全链实证（中断/交互输入/多标签/多行粘贴）；④ 行 11/12 缩放与 localStorage 从「机制推断」升级为跨重启实测；⑤ 新增行 18-20（右键/鼠标侧键/缩放持久）。

## 总表

| # | 功能 | 结论 | 证据（真机实跑；v2=U2 session，v1=M7 session） |
|---|---|---|---|
| 1 | 外链/新窗口（`target="_blank"`、`window.open`） | **修复后可用（三分支）** | 壳层 `setWindowOpenHandler` 单点（src/main/index.ts + window-open-policy.ts 纯层 8 单测）：**同源 → 受管子窗（行 16）/ 异源 http(s)+mailto → 系统浏览器 / 其余协议 deny**。v2 实测：`window.open('http://127.0.0.1:9455/hit-external-u2')` → 本地 hit-server 收 `GET /hit-external-u2` **与 `GET /favicon.ico`**（真实浏览器发起的铁证）且 page targets 不增（无裸 Electron 子窗口）。覆盖 assistant-content.tsx:655（聊天 markdown 链接）、form-engine.tsx:159（表单文档外链） |
| 2 | 剪贴板写（`navigator.clipboard.writeText`，console 12 处） | **可用（v2 边界更新：无焦点也成功）** | v2 实测两种路径：真实点击后 `writeText('U2-CLIP-flows')` → 宿主 `Get-Clipboard` 读回一致；**未聚焦状态 evaluate 直接写 'no-focus-attempt' → Get-Clipboard 同样读回**——M7 接线的 `setPermissionRequestHandler` allowlist（含 clipboard-sanitized-write）使 Electron 下无焦点写入被授权（浏览器无 handler 时会 NotAllowedError，桌面比浏览器**更宽**，非劣化） |
| 3 | 系统通知（`new Notification`，3 处；use-desktop-notification.ts:50 permission 门） | **修复后可用** | 壳层：`app.setAppUserModelId('dev.dagents.desktop')` + request/check 双钩子。v2 实测：`Notification.permission='granted'`；`new Notification(...)` → **`onshow` 触发**（到达系统层）。任务栏归属图标（C4）需人工目击通知中心——AUMID 两侧同值为代码级保证（index.ts 与 electron-builder appId 同源），见行 20 备注 |
| 4 | `window.confirm`（3 处：agents/[id]/edit、canvas-kit-page、flow-versions-dialog） | **可用**（v1 翻案维持） | v2 实测两分支：模态阻塞 JS 线程（evaluate 挂起待模态关闭）→ SendKeys `{ENTER}` → `__confirmResult1 === true`；SendKeys `{ESC}` → `__confirmResult2 === false`。三处调用点与浏览器同码 |
| 5 | `window.alert` | **可用（同 4 机制）** | alert/confirm 同属 Chromium JS 对话框通道；无消费场景差异，未单独跑（v1/v2 同） |
| 6 | 终端页 `/terminal`（node-pty/xterm/SSE/输入） | **可用（v2 全链实证）** | v2 逐项（真实输入流，焦点需先真实点击 xterm 区）：**键入** `echo U2PTY_A` → 屏幕两处（回显+输出）；**Ctrl+C** `Start-Sleep -Seconds 30` 运行中 → `^C` 出现且 prompt 立即恢复；**交互 stdin** `Read-Host U2ASK` → `U2ASK:` 提示 → 键入 `answer-42` 回车返回；**多标签** 点 `+` 新开第二 tab → tab2 键入 `TAB2_MARKER` → 切回 tab1 内容不含 marker（会话隔离）→ 切回 tab2 marker 仍在（attach-recreate）；**多行粘贴** `Input.insertText('echo PASTE_L1\necho PASTE_L2')` → 两行各自回显+执行。**vim 进出**：本机 PTY 为 gateway 最小环境注入（PATH 首段为 .bin/corepack，无 System32——`ping` 亦 CommandNotFoundException），vim/more 不可达，**明示边界**（gateway shell 设计，非壳层缺陷；终端能力已由 Read-Host 交互 stdin 等价覆盖）。**agent 交互会话**（`?agent=`）未驱动（需先有启用的 agent 实体）；**杀 gateway 重连**未驱动（有界重启链 U1 已证，SSE 断流回退是 console 侧诚实设计语义） |
| 7 | 下载行为 | **修复后可用** | 壳层 `will-download`：自动落「下载」目录（重名加序号）+ 完成系统通知（点=打开所在文件夹）。v2 实测：页面 blob + `a.download` 点击 → `~/Downloads/u2-download-probe.txt` 落盘 ✓。边界（不弹保存框）维持 v1 |
| 8 | 快捷键 vs 菜单加速器冲突 | **可用（零冲突）** | v2 实测 + grep 双证：`Ctrl+K` 在 console 页打开命令面板并聚焦搜索框、再按关闭（chat-layout.tsx:46 生效——菜单无 Ctrl+K 加速器）；菜单加速器 Ctrl+R/Shift+I/=/-/0/W 与 console 绑定面（grep：Ctrl+K/S + Enter/Esc 无修饰）**交集为空**。**注意**：xterm 聚焦时 Ctrl+K 进 PTY（输入焦点语义，与浏览器一致） |
| 9 | 历史返回/前进（Alt+Left / Alt+Right） | **修复后可用** | v2 实测（CDP modifiers 位 **Alt=1**）：Alt+Left 从 `/flows` → **启动态页 file://**（session 跨 boot↔console 的完整历史）→ Alt+Right 回 `/flows` ✓（SPA pushState 在 navigationHistory 内） |
| 10 | 页面标题 | **可用** | console 统一 `document.title='Dagents'`（v2 主窗/子窗同值）；主窗任务栏标题 `Dagents`（U1 起窗口 title 显式 + Win32 MainWindowTitle 读回）。favicon：无页签概念不适用 |
| 11 | 缩放（Ctrl+= / - / 0） | **可用（v2 端到端实测）** | v2 实测：SendKeys `^{+}`×2（**真实 OS 输入**——CDP 注入事件不触发菜单加速器，方法学坑）→ `devicePixelRatio` 1→**1.2**、innerWidth 1172→977（等比缩放真实生效） |
| 12 | localStorage 持久化 | **可用（v2 跨重启实证）** | v2 实测：`setItem('u2-ls-marker','cross-restart-ok')` → **优雅关窗（全栈退出）→ 重启 app** → `getItem` 读回 `cross-restart-ok` ✓（磁盘 persist partition 真机闭环，v1 只是同会话） |
| 13 | 拖放文件（防误导航） | **修复后可用（防护语义）** | 壳层 `will-navigate` 只许 consoleUrl/file://。v2 实测：`location.href='file:///C:/Windows/win.ini'` → 被拦（仍在 localhost:3000/flows）。真实拖放 CDP 无法可靠注入（Input.dispatchDragEvent 需拖拽拦截模式）——防护在导航层兜底，v1/v2 同口径 |
| 14 | SSE / WS 长连接 | **可用** | 终端 SSE 直播：v2 全链（键入→gateway node-pty→PTY→SSE 回流，行 6 各项实时可见）；WS 在 M6 gateway 启动日志 `ws: /ws` 在案。run-live/聊天流式（C16 三路另两路）本机无 CLI agent/LLM provider 未端到端驱动——**明示边界**：与终端同为 EventSource 经 BFF 代理（浏览器/桌面同码），传输层已证 |
| 15 | 双向导航（启动态页 ↔ 工作台，痛点①） | **修复后可用** | U1 复验全链（死路出口呼吸高亮 → 点击回工作台；pg 崩溃→红横幅→重试→自动接管），见架构文档 §16 U1-3 |
| 16 | **受管子窗（同源 window.open，U2 新增）** | **修复后可用** | 真实场景：form-engine.tsx:155「从广场启用 Agent」`href="/agents?tab=plaza" target="_blank"`（M7 deny 策略下此链接在桌面**静默无效**——本轮修复）。v2 实测：`window.open('/agents?tab=plaza')` → 子窗 target 出现（url=console 同源）、**继承 preload**（子窗 `window.dagentsDesktop` 存在）、**0.8×主窗**（Win32 EnumWindows：主 1188×742 / 子 950×594 同位）、**第二个子窗 +24px 级联**（@184,144）、主窗停留原页（/flows 未跳转）、CDP closeTarget 关子窗后 targets 复原**无残留** |
| 17 | **子窗随主窗关闭（A6，U2 新增）** | **修复后可用** | v2 实测（Win32）：子窗（950×594）在开 → `PostMessage(WM_CLOSE)` 只关主窗（1188×742，按尺寸区分）→ **app 整体退出**：8080/3000/55432/9444 全释放、0 electron 进程、日志 `[shell] 受管子窗开启（在开 1 个）`。若无 destroy-on-main-close（windows.ts），window-all-closed 会等子窗全关才触发——服务栈会残留，A6 验收锁定的正是此点 |
| 18 | **鼠标侧键返回/前进（C11，U2 新增）** | **明示边界（CDP 注入不可达）** | CDP `Input.dispatchMouseEvent button:'back'/'forward'` 注入后不触发导航（注入事件走 renderer 侧，不经浏览器层 XButton1/2 按键映射）；键盘 Alt+←/→（行 9）已证。真实鼠标侧键行为与浏览器同为 Chromium 内建映射——**留人工复验**（方法学限制，与 v1「焦点探针需真实点击」同类） |
| 19 | **右键菜单（C14，U2 新增）** | **可用** | v2 实测：终端区 `contextmenu` DOM 事件触发（计数器 2/2）；输入框复制粘贴键盘等价链全通：palette 输入 `u2-input-copy` → Ctrl+A → Ctrl+C → 宿主 `Get-Clipboard` 读回一致 → 清空 → Ctrl+V → 值复原（select/paste 真实键事件）。原生右键菜单为 Chromium 默认（壳层无抑制）；菜单项的逐项目击留人工 |
| 20 | **缩放持久（C8，U2 新增）** | **可用** | v2 实测闭环：Ctrl+Plus ×2 → dpr 1.2 → 优雅关窗 → `window-state.json` 记 `"zoomFactor":1.2` → 重启 app → 页面 `devicePixelRatio === 1.2`（恢复同档）、窗口 bounds 同步复原（160,120 1188×742——C9 同会话二次闭环） |

## 死路场景实录（验收员复验脚本语义）

1. 双健康自动接管（auto）：启动 → 窗口 target = `http://localhost:3000/`（takeover 日志「接管工作台」）。
2. 钉住（boot）：工作台页 `window.dagentsDesktop.showStartupPage()`（preload 通道，与菜单「服务状态页」同线）→ 窗口回 `file://…/dist/renderer/index.html`；页面断言：meta=「服务健康 · 已停留在此页——点『进入工作台』…」、钉住徽标显示、「进入工作台」按钮 enabled+primary+呼吸高亮（U1 产品化态）。双健康下持续钉住（原病灶如实保留——出口在本页按钮/菜单）。
3. 一键回（console）：`document.getElementById('btn-enter-workbench').click()` → 窗口 4s 内回 `localhost:3000`。
4. 回退回归（R16）：taskkill console dev 进程 → 窗口自动回启动态页（phase 跌落）+ 钉住自动解除 + 「已记录『进入工作台』意愿」文案（意愿保留语义）→ 编排器有界重启 console（~10s）→ 窗口**自动接管回工作台**。did-fail-load 回退路径在 M3 起在案。

## 壳层修复清单（对应「修复后可用」项）

| 修复 | 位置 | 说明 |
|---|---|---|
| 外链三分支 | src/main/window-open-policy.ts（纯层+8 单测）+ index.ts `wireShellCompatibility` | 同源→受管子窗 / 异源 http(s)+mailto→默认浏览器 / 其余 deny（v2 起，替代 v1 的 deny-all） |
| 受管子窗生命周期 | src/main/managed-children.ts + windows.ts | 放行计数→browser-window-created 认领；主窗 close→逐个 destroy（A6） |
| 通知 | index.ts + `app.setAppUserModelId` | request/check 双钩子（只接 request 不够）+ win 归组 |
| 下载 | index.ts `will-download` | 自动落下载目录（防重名）+ 完成通知 + 打开所在文件夹 |
| 历史导航 | index.ts `before-input-event` | Alt+Left/Right → navigationHistory（SPA 兼容） |
| 导航防护 | index.ts `will-navigate` | 只许 consoleUrl/file://（防拖放与误定向）——受管子窗同规则 |
| 双向导航 | takeover.ts / ipc.ts / preload / menu.ts / renderer | contentIntent 三态 + 双 IPC 通道 + 主按钮/徽标/诚实文案（M7/U1） |
| 窗口状态记忆 | window-state.ts + windows.ts（U1） | bounds+maximized+zoom 跨重启；显示器交集回退（C9/C8/C20） |

## 明示边界汇总（不劣化声明）

- **终端最小环境**：PTY 为 gateway 设计的最小 env（不泄漏网关密钥），PATH 无 System32 → `ping`/`vim` 等系统工具不可用（`CommandNotFoundException`）；PowerShell cmdlet 全可用（Read-Host 交互已证）。gateway 侧设计，非壳层缺陷。
- **终端 agent 会话 / 杀 gateway 重连**：未驱动（前者需 agent 实体；后者 console SSE 断流走诚实回退设计）。
- **剪贴板**：M7 handler 接线后桌面**无焦点写入也成功**（比浏览器宽）；console 12 处均在点击处理器内。
- **下载**：自动保存（无「另存为」）；完成通知点开=所在文件夹。
- **通知**：任务栏归属图标需人工目击（AUMID=appId 两侧同值为代码保证）；专注助手等 OS 策略非壳层可干预。
- **鼠标侧键**：CDP 注入不可达（方法学限制，行 18），键盘路径已证；真实侧键留人工复验。
- **真实拖放**：CDP 无法可靠注入拖拽事件；防护由 will-navigate 导航层兜底（行 13）。
- **C16 三路流式**：终端 SSE 已证；run-live/聊天流式无 CLI agent/LLM provider 未端到端驱动（同 EventSource 传输层）。
- **ELECTRON_RUN_AS_NODE 泄漏**（packaged）：gateway 子进程链上的 node CLI 不受影响；Electron GUI 型 CLI agent 会切 node 模式（现网无此形态）——README 已记录。
- **同源子窗 title**：随页面 document.title（console 现统一 'Dagents'——分页 title 是 console 侧议题）。

## 验证方法学备注（复验者须知）

- CDP 真实输入：`Input.dispatchKeyEvent` modifiers 位 **Alt=1 / Ctrl=2 / Meta=4 / Shift=8**；xterm 只消费带 `text` 的 char 事件且**必须先真实点击 xterm 区拿焦点**；DOM 合成 KeyboardEvent 无效。
- **菜单加速器（Ctrl+=/R/W 等）只能用真实 OS 输入驱动**（PowerShell SendKeys/WScript.Shell 或 SendInput）——CDP 注入事件不触发 Electron 菜单层；CDP 亦无 `Emulation.setPageZoomFactor`（Electron 44 实测）。
- 缩放断言：`window.devicePixelRatio` 在 dpr=1 显示器上 == 页面 zoom factor（1→1.1→1.2 逐档可见）。
- 剪贴板项：宿主 `Get-Clipboard` 读回比对（比数窗口更强的断言）；无焦点语义直接 evaluate 写入即可测。
- `window.confirm` 阻塞 CDP evaluate（同步模态）——后台挂 evaluate + SendKeys `{ENTER}`/`{ESC}` 驱动两分支。
- 外链验证：本地 hit-server（node http）收 `GET /hit-external-link`（+favicon.ico 即真实浏览器）；窗口数断言用 CDP `/json/list` page targets 计数。
- 窗口几何/关闭：Win32 EnumWindows+GetWindowRect 枚举同进程全部顶层窗（Get-Process 的 MainWindowHandle 只报一个）；关主窗用 PostMessage WM_CLOSE 按尺寸区分窗口（子窗 0.8×）。
- 受管子窗断言：CDP `/json/list` 出现同源新 target + 子窗 evaluate `!!window.dagentsDesktop`（preload 继承）。
