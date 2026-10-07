# dagents 桌面客户端 · 体验规格（desktop-ux-spec）

> 体验侧真相源。工程机制（编排器/打包/内嵌 PG/导航意愿态的协议层）见 `docs/desktop-architecture.md` §10–§17，冲突处以架构文档的约束为准、本文的视觉/文案/交互裁决为准。本文所有源码引用均于 2026-10-07 在 `feat/desktop-client` 分支实读复核（含评审轮对 state-machine/shell 路由的补读）。
>
> 读者：实现本体验的工程师（照抄即可）、真机验收的质检员（§10 判据逐条执行——**全部判据自足，不依赖任何未交付文档**）、后续迭代的设计者。

---

## 0. 读者地图与现状病灶

本文要修的四个体验病灶（均已源码定位）：

| # | 病灶 | 源码证据 |
|---|---|---|
| P1 | 启动态页是死路：钉住后无「进入工作台」出口，且 meta 文案失实 | `apps/desktop/src/main/takeover.ts:81-84`（pin 唯一解除条件是 phase 跌落，takeover.ts:76）；`apps/desktop/src/renderer/status.ts` 全文仅 重试/停止/在浏览器打开 三出口；`status.ts:166-167` 钉住时仍显示「双服务健康 · 正在接管工作台…」 |
| P2 | console 功能在壳里兼容面未排查未修复 | desktop 全源码无 `setWindowOpenHandler`/`will-navigate`/`setPermissionRequestHandler`/`setAppUserModelId`（本轮 grep 实证，仅 `ipc.ts:17` 有一处 IPC 级 openExternal）；外链 `target="_blank"` 两处（`assistant-content.tsx:655`、`flow-canvas/inspector/form-engine.tsx:159`）会开裸 Electron 子窗口 |
| P3 | 首启是黑盒：内嵌 PG 的 initdb/迁移无进度呈现，「CLI agent 需自备」这一前提无诚实告知位 | 首启仅有 dev 栈 footer 文案（`status.ts:191`「MVP 边界：默认命令是 dev 栈…」，packaged 模式下已失实）；console 侧有 `first-run-readiness.tsx` 黄条但只在进入工作台后出现 |
| P4 | 窗口是工程态：固定 1440×900 不记忆（`windows.ts:10-20`）、无图标（electron-builder.yml 无 icon 配置）、菜单未按产品收口（`menu.ts` 四动作，无 帮助/后退/关于） | — |

**既有文案与真实行为的偏差（评审轮补读坐实，本文案必须按模式分叉覆盖）**：状态机的引导文案是 dev 栈时代单值——`state-machine.ts:58-59` DB_DOWN_GUIDANCE 硬编码 docker compose 指引；`state-machine.ts:174` SPAWN_FAILED 硬编码「检查 PATH 与 repoRoot」dev 话语；`state-machine.ts:144` START message 硬编码 pnpm dev 命令。packaged 模式下这三处都会误导排障方向——裁决见 §2.4/§3.4。

---

## 1. 设计原则（十条，评审与验收的裁决依据）

1. **console 单真相源，壳只做容器与守护**：桌面端永不 fork console UI、不注入常驻界面改写其行为；壳层页面（启动态页）只承担「服务编排」这一 console 做不了的事。
2. **每个状态都有出路**：任何屏幕、任何状态下，用户至少有一个 enabled 的可达动作（进入工作台 / 重试 / 看日志 / 打开数据文件夹），不允许无出口的终态屏。
3. **每个等待都有事实反馈**：等待必须回答「正在等什么、已等多久、预算多少」，数据来自状态机与日志尾，不许出现无解释的停顿——**等待必须有预算，超预算必须转失败态给动作**。
4. **每个故障都有下一步**：错误呈现 = 事实一句（退出码/错误码原文）+ 原因/对策一句 + 至少一个动作；禁止「未知错误」这类甩锅文案。
5. **诚实优先于安抚**：不假装零依赖（CLI agent 自备的前提明示）、不假装健康（钉住态明说「已停留在此页」）、降级必写清「哪些功能不可用」。
6. **菜单是故障态第一锚点**：原生菜单不受任何 web 页面崩溃/卡死影响——「进入工作台」「服务状态页」「重启服务」必须在菜单层冗余存在（不变式 §2.1）。
7. **桌面语义，不做浏览器拟态**：外链走系统默认浏览器、通知走系统通知中心、关窗即优雅退出整栈；不模拟标签页、地址栏、浏览器快捷键全集。
8. **兼容修复零 console 改动优先**：所有兼容问题先在 main/preload/session 壳层解决；console 源码仅在壳层原理性无解时才动，且逐处论证（本轮矩阵 15 项中 console 改动数为 0；gateway 侧文案补句不计入 console 改动）。
9. **数据在用户手里**：数据目录路径在界面可见、可一键打开；卸载不删数据；任何「重置数据目录」动作必须显式二次确认，永不静默删。
10. **过程可追溯**：重启次数、退出码、端口让位、日志尾在状态页对用户可见——状态页就是产品的诚实窗口。

---

## 2. 导航模型（痛点①根治）

### 2.1 三层出口不变式（验收口径，任何时刻必须成立）

用户「到达工作台」的通路至少一条可用：

- **L1 自动接管**：`contentIntent === 'auto'` 且双健康（`computePhase`，supervisor.ts:286-293）→ 窗口自动 loadURL。
- **L2 启动态页主按钮**：「进入工作台」在 `phase === 'console'` 时 enabled（钉住态即死路出口，见 §2.4 按钮矩阵）。
- **L3 菜单「服务 → 进入工作台」**：**永远可点**——点击 = 调用与页面按钮**同一条 `desktop:enterWorkbench` IPC = 置 `intent='console'`**（与 §2.2 意愿保留同语义）；不健康时不静默：置意愿 + 跳服务状态页 + meta 给原因。**菜单点击必须置意愿**——否则「恢复后自动接管无需再点」不成立。

反向不变式：菜单「服务 → 服务状态页」任何时刻可达（原生菜单层）。回归项：`did-fail-load` 回退（takeover.ts:62-70）与 phase 跌落自动回 boot（takeover.ts:75-78）行为保留不动。

### 2.2 意愿态模型（冻结方案落地，架构 §12.2）

`pinnedBoot: boolean` → `contentIntent: 'auto' | 'boot' | 'console'`：

- `auto`：现行为（双健康接管、跌落回 boot）。
- `boot`：钉住（原「打开启动态页」语义）；phase 跌落仍自动回 `auto`（回退不回归）。
- `console`：用户意愿进工作台——**立即 loadURL；若当前不健康，不加载但意愿保留**，双健康一恢复即接管（S5b 态）。`console` 意愿**不因 phase 跌落清除**（与 `boot` 相反——boot 钉住的本意是「留在状态页」，console 意愿的本意是「我要工作台」，恢复后必须兑现）。

新 IPC `desktop:enterWorkbench`（ipc.ts）+ preload `enterWorkbench(): Promise<void>`，页面按钮与菜单同一通道。`DesktopSnapshot` 增 `contentIntent` 字段（契约由 tsc 钉住），启动态页据此显示「已钉住」徽标与按钮态。

**接管预算（loadURL 挂起防线）**：takeover 现状无超时（takeover.ts:45-59，`did-fail-load` 只兜失败不兜挂起）。规定：`loadURL` 起 15s 未 resolve/did-finish → 视为接管超时 → 回 boot 页 + meta 计数「接管超时（console 应答慢），已自动重试 N 次」+ 连续 3 次超时后停止自动重试、显示「手动进入工作台」按钮（服务状态仍健康，不标服务失败）。预算值 15s 定值（console 健康检查已过 HTTP 200，接管挂起属异常慢而非未起）。

**为什么不做常驻状态栏/overlay**（架构 §12.2 已裁决，体验侧确认）：向完整 Next 应用注入常驻 UI 有 CSP/样式冲突/导航闪烁三个新失败面，与原则 1 冲突；菜单 + CTA 双锚点零 console 改动即满足双向可达。WebContentsView 底部状态条列为可选增强（§9，非阻塞、独立于不变式）。

### 2.3 启动态页（更名「服务状态页」）信息架构

页面自上而下五区（现有 `index.html` 骨架保留，重排为）：

```
┌ header ──────────────────────────────────────────────────┐
│ [◉ 全局状态灯] dagents · 服务编排   [meta 一句话真相]      │
│                          [进入工作台*] [重试/重启] [停止]  │
├ bootstrap 横幅（bootstrap 出错时红条，任意启动轮次都渲染）─┤
├ progress strip（仅首启，§4.2）────────────────────────────┤
├ main 三卡网格 ────────────────────────────────────────────┤
│ [Postgres 内嵌卡]  [gateway 卡]  [console 卡]             │
├ footer ──────────────────────────────────────────────────┤
│ 模式徽章（内置服务栈/dev 栈/附加模式）· 数据目录 · 日志 ·  │
│ [打开数据文件夹] [打开日志文件夹] [在浏览器打开 console]   │
└ about（未签名绕过说明，现有 aside 保留）──────────────────┘
```

- **全局状态灯**（header 左侧新增，色值同卡片 chip 语义 §6）：绿=双健康、黄=降级/等待、红=失败、蓝=附加模式、灰=已停止。一眼可读「现在整体怎么样」，不再需要读完三张卡。
- **主按钮组**置于 header actions 区（现有位置 index.html:209-212），顺序：「进入工作台」（primary，新增）→「重试/重启服务」（现有 btn-restart）→「停止服务」（现有 btn-stop）。
- 三卡网格从 `1fr 1fr` 改 `repeat(3, 1fr)`（PG 卡加入）；窗口 <1100px 时纵向堆叠（media query，壳层页面自有样式，无 console 耦合）。
- **计时文案本地走秒**：主进程状态推送只在 orchestrator 变化时到帧（ipc.ts:33-37 onChange 节流，状态无变化无新帧）——所有「已 Ns」类 meta 由渲染层**本地 1s tick 重算**（快照不变也要走秒），否则计时冻在旧值形似卡死（原则 3）。

### 2.4 按钮与文案真值表（实现照抄；消灭 status.ts:166-167 的失实文案）

设 `gwDb = snapshot.services.gateway.db`，`intent = snapshot.contentIntent`，`ht = snapshot.config.healthTimeoutMs`（**运行时值**，config.ts:104-105 可配至 600s——meta 永不写死 120s）：

| # | 全局状态（判定条件） | header meta 文案（真相句） | 「进入工作台」 | 重试/重启按钮 |
|---|---|---|---|---|
| S1 | bootstrap 管线进行中（initdb/migrate，任意启动轮次；首启另有 §4.2 进度条） | 「初始化数据库 · 第 N/2 步：<initdb/迁移> · 已 Ns / 预算 180s」 | disabled（tooltip：初始化完成即可进入） | disabled |
| S2 | 启动编排中（任一 starting/waiting_health） | 「正在启动 <阻塞服务名> · 已 Ns / 健康预算 <ht>s · 详见下方日志」 | disabled | 文案「重启服务」 |
| S3 | 双健康 + intent=auto、接管中（content loading） | 「双服务健康 · 正在接管工作台…（预算 15s）」 | enabled·primary（本态瞬时即逝） | enabled·「重启服务」 |
| S4 | **双健康 + intent=boot（钉住，痛点①核心态）** | **「服务健康 · 已停留在此页（你在菜单选择停留）——点「进入工作台」返回」** | **enabled·primary·高亮呼吸态** | enabled·「重启服务」 |
| S5 | 双健康 + intent=console、接管尝试中 | 「已请求进入工作台，正在接管…」；接管超时（§2.2 预算）：「接管超时（console 应答慢），已自动重试 N 次」；连续 3 次超时停自动重试：「自动接管反复超时——点「进入工作台」手动重试，或查看日志」 | enabled·primary | enabled |
| **S5b** | **intent=console + 服务不健康（意愿等待态，新模型最常驻的等待）** | **「已请求进入工作台 · 等待服务恢复（<阻塞原因一句：Postgres 未就绪/console 启动中/…>）——恢复后自动进入，无需再点」** | **disabled，label「等待服务恢复…」（disabled 原因在 meta，意愿已记录）** | 按 S6/S7 子态 |
| S6 | gateway db:down（降级；文案按 **PG 归属三分叉**，非按启动模式二分叉） | 内嵌（packaged 默认）：「Postgres 未就绪——网关已起但数据库不可用，暂不接管工作台；PG 恢复后自动继续（下方 PG 卡有恢复动作）」。dev 栈：「Postgres 未就绪——请先起库：cd infra && docker compose up -d；此状态下不重启服务（重启救不了 DB）」（state-machine.ts:58-59 语义，dev 分支保留）。附加模式（外部实例 db:down）：「外部 dagents 服务的数据库不可用——本应用不代管外部服务，可在浏览器打开 console 确认其状态」 | disabled（原因见 meta） | 内嵌：enabled（PG 卡恢复动作为主）；附加：disabled |
| S7 | 任一 failed / 重启预算耗尽 | 「<服务名>失败（退出码 <code>）——<message 原文>。点「重试服务」清零预算重新开始」 | disabled | **primary 转移到此按钮**，文案「重试服务」 |
| S8 | 附加模式（8080/3000 已被外部监听） | 「检测到本机已有 dagents 服务在运行——本应用只观察不接管进程；双健康后仍可进入工作台」 | 双健康时 enabled | disabled（不代杀外部进程，menu.ts 语义） |
| S9 | 已停止（全 stopped） | 「服务已停止——点「启动服务」重新拉起」 | disabled | 文案「启动服务」·primary |
| S10 | 主进程桥不可用（preload 未注入；status.ts:204-211 现状即 return，渲染层无 api 无事件可挂） | 「⚠️ 页面与主进程失联（preload 未注入）——这是缺陷，请报告。**页面按钮全部不可用，请用顶部菜单「服务」组操作（重启/停止/进入工作台）**」 | hidden（页面侧无动作线） | disabled（页面侧）——**唯一出口是原生菜单** |
| S11 | bootstrap 失败（initdb/migrate 失败，任意启动轮次；架构 §10.2「migrate 失败→gateway 不启动」） | 顶部红横幅：「数据库初始化/迁移失败：<错误原文>——gateway 未启动。修复后点「重试初始化」」。gateway/console 卡呈 idle 灰「待命（等待数据库就绪）」——**idle 必须带这句说明**，否则 state-machine.ts:139 前的 idle 无失败呈现成隐形死路 | disabled | 横幅上「重试初始化」为 primary（页面级主按钮组 disabled） |

- meta 是「一句话真相」：状态推送（250ms 节流）+ 本地 1s tick 双驱动重算，禁止任何跨状态滞留的静态文案。
- S4 的高亮呼吸态：`box-shadow` 脉动动画（2s 循环），唯一使用呼吸态的地方——它就是死路的出口，值得全场唯一的高亮。
- 「在浏览器打开 console」从 footer 降级保留（consoleUrl 直开，现有 openExternal 通道 ipc.ts:17-19，仅 http(s)）。

### 2.5 菜单规格（产品级收口）

**win/linux**（`menu.ts` 重写为）：

```
文件(F)    关闭窗口  Ctrl+W          （role:close；关窗=优雅退出全栈，§7.4）
编辑(E)    role:editMenu             （撤销/剪切/复制/粘贴/全选——剪贴板键盘路径，mac 尤其必需）
查看(V)    后退      Alt+←           （webContents.goBack，Next app-router 历史）
           前进      Alt+→
           ──
           重新加载  Ctrl+R / F5      （role:reload）
           强制重新加载 Ctrl+Shift+R
           开发者工具 Ctrl+Shift+I    （role:toggleDevTools，排障保留）
           ──
           重置缩放  Ctrl+0           （role 组）
           放大      Ctrl+=
           缩小      Ctrl+-
           切换全屏  F11
服务(S)    进入工作台                  （无加速器——永远可点；点击=enterWorkbench IPC=置 intent=console；不健康时置意愿+跳状态页+反馈）
           服务状态页                  （原「打开启动态页」改名，即 intent=boot）
           ──
           重启服务（停止后重新拉起）
           停止服务（终止全部子进程树）
           ──
           在浏览器打开 console
帮助(H)    关于 dagents…              （dialog.showMessageBox：版本/模式/数据目录/日志目录/未签名提示/Ctrl+W 退出提示）
           打开日志文件夹              （userData/logs）
           打开数据文件夹              （userData，含 pgdata）
```

**mac 差异**：前置 `role:appMenu`（关于/退出 Cmd+Q——will-quit 树终止链已接，index.ts:74-81）；「服务」「帮助」组同上；`role:windowMenu` 保留。

- 「服务」组四动作语义不变（menu.ts:22-46 既有 handlers），新增 enterWorkbench/showStatusPage 两 handler。
- 帮助组两「打开文件夹」走新 IPC `desktop:openPath`（主进程白名单：仅 userData 与 userData/logs、userData/pgdata 子路径，防任意路径打开）。
- 「进入工作台」刻意不绑加速器：菜单加速器会先于页面 keydown 拦截按键（Electron 语义），任何绑定都有与 console 快捷键（Ctrl+K/S/Enter，§5.8）撞车的风险——可达性靠菜单常驻而非快捷键。

---

## 3. 服务状态页视觉与组件规格

### 3.1 三卡布局与 PG 卡

卡片结构沿用现有（chip 行 + facts 行 + message 条 + 日志尾 pre），新增第三卡：

- **Postgres 内嵌卡**：标题「Postgres · 内嵌数据库」；chips：状态（同七态色）+ 「端口 :55432」或让位态「端口 :55433（默认 55432 被占用，已让位）」（黄 chip，架构 §10.3 明示语义）+ 模式 chip（「内嵌」/「外部」——config 显式关或 extraEnv.POSTGRES_URL 已设时不 spawn 本卡进程，卡显示「外部模式 · 未启用内嵌 PG」灰态）；附加模式下本卡整体灰「附加模式 · 未启动」。
- facts 行：`数据目录 <pgdata 路径>` + 重启次数 + 上次退出码（复用 renderService 的 bits 逻辑，status.ts:125-130）。
- **R9 恢复动作**：bootstrap 检测 `postmaster.pid` 残留 → message 条显示「上次可能未正常退出。通常直接重试即可恢复；若反复失败，可重置数据目录（会删除全部工作流/会话数据，需二次确认）」+ 动作按钮「重置数据目录…」（confirm 二次确认 + 逐字警告「将永久删除 N 张工作流与全部会话记录」→ 停 PG → 删目录 → 重走 bootstrap）。**取消分支必须零副作用**（验收 D9）。
- gateway 卡 db chip 语义不变（up/down/unknown，status.ts:111-117）；console 卡不变。

### 3.2 日志面板

- 等宽字体滚动区保留（Cascadia Mono/Consolas，180px 高，pin-to-bottom 已实现 status.ts:95-98）。
- 增强：日志尾标题行加「复制最近 400 行」按钮（navigator.clipboard——壳层页面，可用性同矩阵 #3）与「打开完整日志」链接（openPath userData/logs/<svc>.log，轮转文件 10MB）。两动作纳入验收（D7）。
- 三卡下日志各自独立，不合并（排障时按服务定位）。

### 3.3 视觉基线

- 沿用现有暗色 token（index.html:12-27 CSS 变量），不引入框架/依赖（壳层零 runtime deps 纪律）。
- 状态色语义全 app 唯一：绿 `#4ade80`/`#22c55e` 运行、黄 `#fbbf24`/`#eab308` 等待与降级、红 `#ef4444`/`#f87171` 失败、蓝 `#7aa2f7` 附加/信息、紫 `#a78bfa` 自动重启中、灰 `#6b7280` 已停止。console 侧主题不受影响（壳层页面独立）。

### 3.4 状态机文案的模式分叉（渲染层裁决）

状态机内嵌 message 是 dev 栈时代单值（§0 已列三处）。裁决：**呈现层（status.ts）按 snapshot 的模式字段选文案模板，状态机 message 仅作 dev 兜底**——不动 state-machine.ts 语义（纯度与既有单测不破）：

| 场景 | dev 模式（现状文案，保留） | packaged 模式（渲染层替换） |
|---|---|---|
| db:down 引导 | 「cd infra && docker compose up -d」（state-machine.ts:58-59） | 「内嵌 PG 恢复动作见下方 PG 卡」（S6 三分叉） |
| SPAWN_FAILED | 「检查命令是否在 PATH…repoRoot 是否有效」（state-machine.ts:174） | 「启动失败：<error 原文>——内置服务栈可能被安全软件拦截或损坏；先重试，反复失败请重新安装安装包」 |
| START 中 | 「正在启动：pnpm --filter …」（state-machine.ts:144） | 「正在启动：内置 gateway / 内置 console」 |

---

## 4. 首启 onboarding（痛点：黑盒 → 有进度、有预期、有诚实边界）

### 4.1 首启判定与入口

- 判定：packaged 模式 && `userData/pgdata/PG_VERSION` 不存在 → 本启为「首启」，服务状态页顶部插入 **progress strip**（欢迎区）。
- 非首启（含 dev 模式、附加模式）不渲染进度条——onboarding 不骚扰老用户。
- **例外（与首启无关，永远渲染）**：`snapshot.bootstrap.error` 非空 → 顶部红色横幅（S11），gateway 不启动的事实必须在任意启动轮次可见——非首启的迁移失败不能靠「首启才有 UI」隐藏。

### 4.2 五步进度条（progress strip）

```
欢迎使用 dagents · 首次初始化仅此一次，约 30 秒
 ① 数据库初始化 ─ ② 数据结构迁移 ─ ③ 网关启动 ─ ④ 工作台服务 ─ ⑤ 接管工作台
```

- **console 是独立步**（④）：③ gateway 亮起后 console 冷启+健康+接管可能 10-30s，若并入「工作台就绪」单步，④ 会停在 ○ 待开始无任何进行中步——B1「无跳步无黑屏停顿」最可能栽在这段。五步划分后每段等待都有归属：
  - ① ← bootstrap.initdb；② ← bootstrap.migrate；③ ← `services.gateway.state`；④ ← `services.console.state`；⑤ ← takeover content === 'console'（接管完成，非仅双健康）。
- 步态五值：`○ 待开始` / `◐ 进行中（spinner + 本步已耗时/预算）` / `● 完成` / `✕ 失败` / `◔ 跳过`（外部 PG 模式下 ①② 显示「跳过 · 使用外部数据库」）。
- **步预算（原则 3：等待必须有预算）**：① 180s、② 120s、③④ 走 healthTimeoutMs 运行时值、⑤ 走 §2.2 接管预算 15s。到预算未完成 → 步转 ✕ + 展开错误原文/「超时」事实 + 「重试初始化」按钮（重走 bootstrap，幂等）；绝不无尽头等待。计时由渲染层本地 1s tick 驱动（§2.3）。
- ⑤ 完成即接管（intent=auto 正常路径）；若用户此时 intent=boot，按 S4 文案给出口。
- 预期管理文案：initdb 冷启动（HDD + 首次解压）可能 30s+——文案写「约 30 秒」且日志尾实时滚动。

### 4.3 欢迎面板（progress strip 下方，仅首启渲染）

三条事实，一条小字，零弹窗零向导步骤（onboarding 不挡路，与接管并行）：

1. **「全部内置，无需安装任何东西」**——服务栈与 Postgres 数据库都在安装包里，随应用启动就绪、随退出停净。
2. **「唯一需要你自备的：CLI agent」**——要让 LLM/Agent 节点工作，需本机已安装并登录至少一个 CLI agent（如 claude/codex），或在 设置 → LLM Provider 配置 HTTP Provider。没有它，画布/聊天仍可浏览与编排，但生成与执行不可用。（与 console 侧 `first-run-readiness.tsx` 黄条同口径——用户进工作台后还有第二道教育，此处是第一道且更早。）
3. **「你的数据在你手里」**——数据存放于 `<pgdata 路径>`（按钮「打开数据文件夹」）；卸载应用不会删除数据；换新安装包升级数据保留。
4. 小字（可折叠 details）：「已自备 Postgres？可让桌面端直接使用它——编辑 `<config.json 路径>` 配置 `extraEnv.POSTGRES_URL`（或 `postgres.embedded:false`），重启应用生效。示例：<JSON 片段>」。**不做设置界面**：外部 PG 是高级用户路径，普通用户零配置即用；配置文件路径可直接打开（openPath）。

### 4.4 dev 模式与附加模式的首启差异

- dev 模式：无 progress strip；footer 模式徽章「dev 栈 · 仓库 <repoRoot>」；db-down 引导保留 docker compose 文案（§3.4 表）。
- 附加模式：footer 徽章「附加模式 · 本应用未启动任何服务」；重试/停止按钮 disabled（不代杀外部进程），「在浏览器打开 console」升为主出口；PG 卡整体灰（§3.1）。

---

## 5. 兼容体验矩阵（痛点② UX 侧裁决；实现侧证据记录归 desktop-compat-matrix.md——**验收判据以本文 §10 为准，全文自足**）

> 裁决总则（原则 7/8）：**优先壳层**；行为对标「浏览器里用 console」的等价或明示不劣化。console 侧改动数 = 0（本矩阵全部壳层可解；#6 的 gateway 文案补句是 gateway 侧，非 console）。

| # | 功能面 | 期望行为（用户感知） | 壳层落点 | 真机验证法 |
|---|---|---|---|---|
| 1 | 外部链接（`assistant-content.tsx:655`，http/https/mailto） | 点聊天里的链接 → 系统**默认浏览器**打开，桌面窗口不跳走 | `setWindowOpenHandler` 三分支（#2 定义）中的「外部」分支：shell.openExternal + deny | 聊天发送含 markdown 链接的消息，点击 → 默认浏览器打开该 URL，桌面窗口无新窗口无导航 |
| 2 | 新窗口三分支（`form-engine.tsx:159` `/agents?tab=plaza` target=_blank；localhost:8080 gateway 链接；:3001 Langfuse） | ① origin === consoleUrl → **受管子窗口**（浏览器新标签页等价物，不丢画布编辑态——源码注释明示此意图 form-engine.tsx:153-155）；② 其他一切 http(s)/mailto（**含 localhost:8080/:3001 同机异 origin**）→ 系统浏览器；③ 其余协议（file:// 等）→ deny | `setWindowOpenHandler` 单点三分支：同 origin → 受管 `new BrowserWindow`（继承 preload/最小尺寸，0.8×主窗、24px 级联偏移）+ `overrideBrowserWindowOptions`；异 origin http(s)/mailto → openExternal+deny；默认 deny。**受管子窗生命周期挂主窗：主窗 `close` → 逐个 `destroy()` 子窗**——否则 window-all-closed 要等子窗全关才触发，主窗关了应用不退、服务栈继续跑，违背 §7.4 关窗即退出。边界声明：子窗是链接兼容行为非「多工作台」特性（不提供「新建窗口」入口） | 画布 LLM 节点参数面板点「从广场启用 Agent ↗」→ 受管子窗口显示广场页，主窗画布编辑态不丢，关闭子窗无残留；**开着子窗关主窗 → 应用整体退出、端口停净（A6）**；gateway 管理链接（若出现）走系统浏览器 |
| 3 | 剪贴板写（11 处 writeText：agent-plaza:291 / assistant-content:699 / canvas-trace-view:838 / chat-detail:845 / chat-history-tree:811 / code-block:62 / daemons-view:386,1029 / result-viewer:82 / run-terminal:184 / tool-call-card:87） | 点「复制」→ 内容进系统剪贴板，可在任意应用粘贴 | Electron 默认放行 clipboard-sanitized-write——**但该默认的前提是「未设 permission handler」，与 #4 的 handler 必须打包设计**（#4 allowlist 显式含 clipboard-sanitized-write，否则 #4 自伤 #3） | 代表抽查 4 处（代码块/聊天消息/轨迹事件/广场克隆命令）+ 其余 7 处回归；每处复制后在记事本 Ctrl+V 比对；**C17 专测：设 handler 后复制仍可用** |
| 4 | 系统通知（3 处 new Notification：notification-settings:119 / use-desktop-notification:51 / use-task-notification:190；permission 门 use-desktop-notification.ts:47） | 任务完成/失败的系统通知照常弹出（win 右下角/toast） | ① `app.setAppUserModelId('dev.dagents.desktop')`——**统一钉 appId 值**（electron-builder.yml:1 appId 即此值；NSIS 快捷方式的 AUMID 取 appId 而非 exe 名，packaged 两侧同值才匹配，dev 同值零分叉）；② `session.setPermissionRequestHandler` **显式 allowlist：`notifications` + `clipboard-sanitized-write` 允许，其余全部 deny + 主进程日志**（Electron 一旦设 handler 所有权限请求都过它——不显式放行 clipboard-write 就推翻 #3 前提；clipboard-read 不放行：console 零 readText 调用，grep 实证） | 设置→通知→发送测试通知；最小化窗口跑长任务→完成通知；任务栏通知归属显示 dagents 图标（AUMID 匹配）；通知点击无动作（与浏览器形态等价——console 未设 onclick，如实记录） |
| 5 | window.confirm（3 处：agents/[id]/edit/page.tsx:61 / canvas-kit-page.tsx:835 / flow-versions-dialog.tsx:76） | 离开未保存确认、回滚版本确认照常弹出（系统原生同步对话框，朴素但可用=浏览器等价） | 无需修复（Electron 原生支持同步 dialog）；样式为 Chromium 默认，**记为可接受朴素** | 三处各触发一次：画布改动后点返回、版本面板点回滚、agent 编辑器有修改切走——弹窗出现且取消/确认分支行为正确 |
| 6 | 终端页（/terminal，xterm + SSE PTY 直通） | **零降级全功能**（终端策略冻结：node-pty N-API 双运行时实测 PASS）：输入/粘贴/Ctrl+C/vim/top 交互、多标签开/关/切换、SSE 直播、重连 | 无壳层动作（gateway 活则终端活）。**边界呈现的归属裁决**：现状 shell 禁用是 gateway 403 + 英文文案 `shell sessions disabled (DAGENTS_SHELL_DISABLED=1)`（shell.ts:41、shell-registry.ts:154 实读——此前草稿写「503」失实，更正）。若某平台 node-pty 加载失败，gateway /shell 系路由返回 403/503 均可（工程定，与既有禁用语义同族），**文案归属 gateway 侧**补一句「终端组件在此平台暂不可用，其余功能不受影响」（gateway 非 console——约束只限 console 改动；壳层无法向 console 页面注入文案，如实记录）；**降级预案**：若工程不接受 gateway 改文案，则矩阵记明示边界（错误信封英文原文照现），此裁决二选一写死在 compat-matrix，不悬空。状态页 gateway 卡此场景不标红（/health 仍 ok） | 开 2 标签（不同目录）互切；粘贴多行命令；跑 vim 改文件退出；Ctrl+C 中断；关 gateway 再恢复验证重连；agent 交互会话（/terminal?agent=）一档 |
| 7 | 下载行为 | 现无下载入口（grep console 源码零命中，如实记录）；兜底防死路 | `session.on('will-download')`：存系统下载目录 + 完成后系统通知 +「在文件夹中显示」（`shell.showItemInFolder`） | devtools 执行一个 blob 下载验证兜底链路（C13）——落系统下载目录、通知弹出、可打开所在文件夹 |
| 8 | 快捷键与加速器冲突 | console 快捷键（Ctrl+K 面板 chat-layout.tsx:46、Ctrl+S 保存 flow-editor.tsx:192、Ctrl+Enter 运行 canvas-kit-page.tsx:1021/flow-run-dialog.tsx:134、Esc 关弹窗、? 帮助、G 序列 keyboard-shortcuts.tsx）全部照常；菜单加速器（Ctrl+R/F5/Ctrl+Shift+R/I、Ctrl+0/±、F11、Ctrl+W、Alt+←/→）不与上述任何一个撞车 | 菜单表 §2.5 已裁决：**不引入** Ctrl+K/S/Enter/Esc 任何菜单加速器（唯一风险源是菜单层，不建即无冲突）；Ctrl+R/F5 保留=浏览器刷新等价（丢未保存画布编辑的风险与浏览器一致）；Ctrl+W=关窗优雅退出（桌面语义，风险已评估见 §7.4）；Ctrl+Shift+I 保留（排障） | 画布上逐个跑 Ctrl+S（保存请求 toast）、Ctrl+K（面板）、Ctrl+Enter（运行）、Esc（关弹窗）、?（帮助）；再跑 Ctrl+R（重载无白屏死）、Ctrl+=/0/-（缩放生效且保持）、Ctrl+W（退出且端口停净，D10） |
| 9 | 右键菜单 | 输入框/文本区右键 → Chromium 默认菜单（复制/粘贴/检查）可用；xterm 区域右键不破坏终端习惯 | 无需动作（Electron 默认上下文菜单存在）；验证 xterm 右键行为并记录 | 输入框右键粘贴可用；终端区右键验证（选词/粘贴习惯是否可用，结论写矩阵，C14） |
| 10 | 历史返回（Alt+←、鼠标侧键） | 页面间返回/前进可用（Next app-router 历史），不越出应用 origin | 菜单绑定 Alt+←/→（§2.5 **新增菜单项，必须有验收**）；鼠标侧键 Chromium 原生；`will-navigate` 防线：主窗口仅允许 consoleUrl origin 与本地启动页，越界（拖放文件/恶意导航）→ prevent + openExternal | 工作流→画布→Alt+← 返回；鼠标侧键返回；Alt+→ 前进；向窗口拖一个 .txt 文件：无导航逃逸无崩溃（C12） |
| 11 | 页面标题与图标 | 窗口/任务栏标题「Dagents」（console layout.tsx:9 metadata title 接管）；任务栏/Dock 图标=真实应用图标（§7.2 三平台图标） | 窗口 title 初始 'dagents'（windows.ts:13）+ 文档 title 接管为 'Dagents'——两态都正确；图标落 electron-builder.yml | 任务栏悬停看标题；任务栏/开始菜单/安装向导/快捷方式四处图标（D1） |
| 12 | 缩放 | Ctrl+0/± 调整，刷新/接管/重启后保持 | viewMenu role 组 + zoomFactor 持久化进 window-state.json（§7.1），webContents 创建时应用（loadURL 不重置 zoom） | Ctrl+= 两档 → Ctrl+R 刷新 → 缩放保持；重启应用 → 缩放保持（C8） |
| 13 | localStorage | 主题/语言/终端标签（dagents.terminal.tabs）/画布运行输入记忆等 75 处读写跨重启持久（Electron userData partition） | 无需动作 | 切暗色主题 + 开 2 个终端标签 → 完全退出重启 → 主题与标签恢复；画布「重跑」仍记得上次运行输入（C10） |
| 14 | 拖放文件 | console 无 file drop 入口（grep 仅画布 pointer 拖拽，如实记录）；意外拖放不得导航逃逸 | `will-navigate` origin 白名单兜底（#10 同一防线）；不实现拖放上传（无场景不造特性） | 向窗口拖一个 .txt 文件：无导航逃逸、无崩溃（C12，与 #10 合并执行） |
| 15 | SSE/WebSocket 直播 | 运行直播（use-run-live）、终端流、聊天流式三路实时帧在 Electron 网络栈原生工作 | 无需动作（同源 BFF 代理） | 画布跑一个流式工作流：终端视图逐字输出、轨迹视图泳道延伸；聊天流式逐 token（C16） |

**矩阵产出要求**：实现侧将本表落为 `docs/desktop-compat-matrix.md`（页面×功能×结论三值：可用/修复后可用/明示边界 + 截图/录屏编号），**其验收口径逐条引用本文 §10 对应 hook（C1-C17）——判据不自立于本文之外**（该文档今天尚不存在，是 M7 交付物；本文 §10 已覆盖全部 15 项，无悬空依赖）。

**preload 注入边界**（如实记录）：console 源码零处引用 `dagentsDesktop`（本轮 grep 实证）——preload 对 console 页是休眠注入，兼容矩阵全部行为不依赖它；R8 远程页撤注入议题维持搁置（outOfScope）。

---

## 6. 错误 / 空 / 加载态统一规范（壳层页面通用模板）

四态模板，任何状态呈现必须落入其一：

| 态 | 视觉 | 内容三要素 | 反例（禁止） |
|---|---|---|---|
| **进行中** | 黄灯/spinner | ①正在做什么（服务名+动作）②已耗时/预算（「已 8s / 120s」，**预算读运行时配置值**）③事实流（日志尾滚动或进度步） | 转圈无文字；「加载中…」无已耗时；**无预算的无尽等待** |
| **空** | 灰 | 一句话事实+为何正常（「（暂无日志）——服务刚启动，日志将实时出现」） | 纯空白区块 |
| **降级** | 黄 message 条 | ①哪个组件降级 ②影响面（哪些功能暂不可用）③为何不自动修（「重启救不了数据库，不重启」）+ 出路 | 把降级画成运行中的绿色 |
| **失败** | 红 | ①事实（退出码/错误码**原文**）②最可能原因或对策一句 ③至少一个 enabled 动作（重试/看日志/打开文件夹） | 「未知错误」「出错了请重试」 |

规则：

1. 颜色语义 §3.3 全 app 唯一，跨页面不换义。
2. 错误码/退出码永远原文呈现（`exit=1`、`-3 ERR_ABORTED`、`EPERM`），工程师可搜索。
3. 每张卡片失败时，重试按钮移为主按钮（S7）——失败态的 primary 永远是「下一步动作」，不是「停止」。
4. 降级态永不显示绿色（db:down 时 gateway 卡运行 chip 仍绿是「进程活」语义、db chip 黄是「数据库」语义——两 chip 分离即诚实，现状已对，保留）。
5. 等待超过预算 1/2 时 meta 加提示（「比预期慢——看日志尾是否卡在编译/网络」），**超预算必须转失败态给动作**（bootstrap 步预算 §4.2、接管预算 §2.2 与 healthTimeout 状态机语义三处同口径）。
6. **计时类文案由渲染层本地 1s tick 驱动**（主进程只在状态变化时推帧，ipc.ts:33-37）——快照不变计时也要走秒。
7. console 内部错误态（global-error.tsx/error.tsx/error-boundary）是 console 既有能力，壳层不重复不遮盖——画布崩溃时菜单「服务→进入工作台/服务状态页」仍是壳层锚点（原则 6）。

---

## 7. 窗口体验

### 7.1 尺寸/位置记忆

- 新增 `window-state.json`（userData 下）：`{x, y, width, height, maximized, zoom}`。
- 写入时机：`resize`/`move` 事件 debounce 500ms + `close` 时强制落盘；最大化态只记 `maximized:true`（不记最大化 bounds）。
- 恢复校验（生产级细节，防「窗口消失在拔掉的显示器上」）：恢复的 bounds 必须与 `screen.getAllDisplays()` 任一 `workArea` 有交集，否则丢弃并回退默认 1440×900 居中（现值 windows.ts:11-12 作为回退保留）。
- 最小尺寸 960×640（console 三栏布局下限；现无 minWidth，补）。
- zoom 持久化同文件（矩阵 #12）。
- 首启（无 window-state.json）：1440×900 居中——首屏即工作台级尺寸，不留小窗观感。

### 7.2 应用图标（三平台）

- 设计源：console 品牌标（app-nav-sidebar 品牌行的三角节点 SVG，app-nav-sidebar.tsx:73-80）——与工作台视觉同源，不新造符号。
- 规格：win `.ico`（256/48/32/16 多尺寸）；mac `.icns`（512@2x 起）；linux 512×512 PNG。三份入 `apps/desktop/build/`（electron-builder 约定目录），`electron-builder.yml` 补 `icon` 字段（win/mac 自动拾取 build/ 下约定名，linux 需显式）。
- 任务栏/开始菜单/Dock/安装器（NSIS 向导与快捷方式）全部使用同一图标——「生产观感」的最低门槛。
- 底色与造型与暗色状态页协调（#0f1115 底 + 蓝 #7aa2f7 节点色），小尺寸（16px）保轮廓不糊。

### 7.3 窗口标题栏

- win/linux 原生标题栏（不搞 frameless——outOfScope webContents 深度定制之外，原生标题栏=最小失败面）；标题「dagents」（初始）→「Dagents」（console 接管后文档 title）。
- mac 原生交通灯 + hiddenInset 不做（保守原生）。

### 7.4 关闭/退出语义（对用户诚实的桌面契约）

- 关窗（X / Ctrl+W / 菜单关闭窗口）→ app 退出 → will-quit 树终止全栈（index.ts:74-81 现有链）→ 8080/3000/PG 端口释放。
- **受管子窗必须随主窗关闭**（§5 #2）：主窗 `close` → destroy 全部受管子窗——否则 window-all-closed 等子窗全关才触发，违背本节契约（A6 验收）。
- **不弹「确认退出？」**：退出是优雅的（服务有界停止、数据落盘），打断式确认是浏览器习惯残留；例外——有运行中工作流时也**不弹**（gateway 侧 boot 清扫把悬空 run 收敛为 failed，AGENTS.md 既有语义），README 记录。
- **Ctrl+W 风险（已评估，记录在案而非无声接受）**：Ctrl+W 是浏览器关标签肌肉记忆键，长任务用户误按一次即触发整栈退出、运行中工作流被收敛为 failed。评估结论=**保留**，理由：①桌面平台语义（全部原生应用如此）；②损失有界——run 标记 failed 可重跑（运行输入按 flowId 记忆，AGENTS.md），画布拖拽自动保存、损失窗口 ≤ 未保存的 inspector 编辑（与浏览器 F5 同界）；③缓冲方案（运行中时二次按键确认/5s 延迟退出）引入「以为关了没关」的新失败面且阻塞停净断言，判负。补偿：关于页与 README 写明此语义；D10 验收锁定行为。
- 关于页（帮助→关于 dagents）写明：「关闭窗口即停止全部内置服务并退出；未完成的运行会被标记为失败，可重新发起」。

### 7.5 单实例与再启动

- 现有单实例锁（index.ts:21-25）：二次启动聚焦已有窗口——保留；聚焦时若窗口最小化则 restore（focusMainWindow 已实现，windows.ts:33-39）。

---

## 8. 卸载与数据保留（产品决策落地）

- NSIS 卸载**默认保留** `%APPDATA%/dagents-desktop/`（不设 `deleteAppDataOnUninstall`，架构 §10.4）——升级（换安装包）数据不丢。
- 卸载器附加页（NSIS custom page 或 README 明示）：「如需彻底清除数据，删除 `<路径>`」——README「卸载与数据」一节写死路径三平台对照 + pg_dump 迁移说明（outOfScope 不做自动迁移）。
- 服务状态页 footer 的「打开数据文件夹」是数据可见性的界面兑现（原则 9）。

---

## 9. 可选增强（非阻塞，独立于 §2.1 不变式）

**WebContentsView 底部状态条**（架构 §12.2 列为体验侧可选）：

- 形态：console 内容时窗口底部 28px 常驻条（WebContentsView 叠加，不注入 console DOM）：左「◉ 服务健康 · :8080 :3000 · PG :55432」右「服务状态页 →」。
- 价值：工作台内随时可见健康 + 一键回状态页（菜单之外的第四锚点）。
- 风险与约束：console 底部有 floating-chat 悬浮件，需验证不遮挡（28px 让位：console 视口高度 -28px）；导航闪烁与焦点劫持需真机过；**不做也不影响验收**——L1-L3 不变式已覆盖需求。
- 裁决：M7 后若有余力且真机无闪烁再做；做坏了宁可撤。

---

## 10. 验收判据（质检员真机逐条执行；win-x64 必跑，mac/linux 按 CI artifact 抽验。**全部判据自足，不依赖未交付文档**）

**A. 导航不变式（痛点①）**

- A1 死路修复正场：菜单「服务→服务状态页」钉住 → 双服务健康后 header 显示 S4 文案「服务健康 · 已停留在此页…」，「进入工作台」按钮呼吸高亮 → 点击 → ≤2s 内进入工作台（**工作流列表页渲染出数据**——数据来自 PG 经 BFF，不存 localStorage）。
- A2 菜单永远可点：杀掉 gateway（任务管理器结束进程）→ 菜单「服务→进入工作台」仍可点击 → 置意愿（S5b）+ 跳服务状态页给原因反馈，无静默。
- A3 意愿保留（含驻留配方）：**驻留 db:down**——packaged 用 config.json 设 `postgres.embedded:false` + `extraEnv.POSTGRES_URL` 指向无人监听端口（如 :59999）→ gateway 起而 db:down 持续；此态「进入工作台」disabled 且 meta 给 S6 三分叉文案；菜单「进入工作台」点击置意愿（S5b「等待服务恢复…无需再点」）→ 恢复 PG（改回内嵌配置重启）→ 双健康后自动接管无需再点。
- A4 回退不回归：工作台内杀 console 进程 → 窗口自动回服务状态页显示恢复过程 → 自动重启后回工作台（takeover 既有行为回归）。
- A5 反向可达：工作台内任意页面（含画布、终端）菜单「服务→服务状态页」可达。
- A6 子窗随主窗关闭：画布开「从广场启用 Agent ↗」受管子窗保持打开 → 关主窗 → **应用整体退出**（非仅主窗消失），8080/3000/PG 端口全释放、无残留进程。
- A7 接管挂起有预算：人为拖慢 console 应答（如对 :3000 挂限速代理属极端手段，实操可用「接管瞬间暂停 console 进程」模拟挂起）→ 15s 预算内 meta 显示「正在接管…（预算 15s）」→ 超时回状态页 + 「已自动重试 N 次」计数；连续 3 次超时后停自动重试、显示手动进入按钮，服务卡不标红。

**B. 首启 onboarding 与 bootstrap**

- B1 全新机器语义（无仓库/无 pnpm/无 node/无 docker）：安装 → 双击 → 五步进度条 ①→⑤ 逐步点亮（**每段等待都有进行中步，无跳步无黑屏停顿**——③ 亮起后 ④「工作台服务」必须立即转 ◐）→ 自动进入工作台。计时：冷启 ≤90s（HDD 放宽 180s）。**预判**：若卡死在 ① 且错误为 DLL/运行库缺失，判 VC++ 运行库前提问题（§11 风险表 R-2），不是 UX 缺陷但必须回报。
- B2 二次启动无 onboarding（进度条不出现，秒级到工作台）；`pgdata/PG_VERSION` 存在。
- B3 诚实前提：首启面板出现「CLI agent 需自备」文案；空配置机器进工作台后 console 黄条（FirstRunReadiness）也出现——两道教育都在。
- B4 端口让位：预占 55432（临时起一个监听）→ 启动 → PG 卡显示「端口 :55433（默认 55432 被占用，已让位）」黄 chip，gateway db:up，全功能可用。
- B5 外部 PG 回退：config.json 写 extraEnv.POSTGRES_URL 指向可达外部库 → 启动 → ①②步显示「跳过 · 使用外部数据库」，不 spawn 内嵌 PG（进程列表无 postgres.exe 本 app 子进程），PG 卡灰「外部模式」。
- B6 非首启 bootstrap 失败可见（S11）：人为制造迁移失败（如 pgdata 数据目录写保护/损坏 PG_VERSION 文件）→ 重启应用 → 状态页顶部红横幅「数据库初始化/迁移失败：<原文>」+「重试初始化」按钮，gateway/console 卡 idle 且带「待命（等待数据库就绪）」说明——不出现裸 idle 灰卡无解释。
- B7 bootstrap 步预算：人为挂起 initdb（占住 pgdata 目录句柄/挂起子进程）→ 步 ① 计时走秒（本地 tick）到 180s 预算 → 转 ✕ 失败步态 + 超时事实 + 「重试初始化」——不无尽头等待。

**C. 兼容矩阵（§5 十五项全量，判据如下；证据记录归 compat-matrix）**

- C1 外链：聊天含 markdown 链接 → 点击 → 系统默认浏览器打开；桌面无新窗口。
- C2 同源新窗口：画布 agentId 参数「从广场启用 Agent ↗」→ 受管子窗口开广场页；主窗画布编辑态不丢；子窗关闭无残留。
- C3 剪贴板 11 处：code-block/chat-detail/canvas-trace-view/agent-plaza 四处复制 → 记事本粘贴一致；其余 7 处回归过。
- C4 通知与 AUMID：设置→通知测试按钮 → win 系统通知弹出且**任务栏归属显示 dagents 图标**（AUMID=appId 匹配，dev.dagents.desktop）；最小化窗口跑长任务 → 完成通知。
- C5 confirm 三处：画布未保存返回/版本回滚/agent 编辑离开 → 原生确认框弹出且两分支正确。
- C6 终端：双标签互切 + 多行粘贴 + vim 进出 + Ctrl+C + agent 交互会话；关 gateway 再启 → 重连。
- C7 快捷键无撞车：画布上 Ctrl+S/Ctrl+K/Ctrl+Enter/Esc/? 逐个生效（保存 toast/面板/运行/关弹窗/帮助）。
- C8 缩放持久：Ctrl+= 两档 → Ctrl+R → 重启应用 → 缩放保持。
- C9 窗口记忆：移动+改尺寸 → 退出重启 → 位置尺寸恢复；拔显示器场景（bounds 校验）回退居中不丢窗。
- C10 localStorage：主题/语言/终端标签/画布运行输入跨重启保留。
- C11 历史返回：工作流→画布→菜单/键盘 Alt+← 返回工作流；鼠标侧键返回；Alt+→ 前进；无导航越界。
- C12 导航越界拦截：向窗口拖一个 .txt 文件 → 无导航逃逸、无崩溃、页面仍在本应用 origin。
- C13 下载兜底：devtools 触发一个 blob 下载 → 落系统下载目录 + 完成系统通知 +「在文件夹中显示」可达。
- C14 右键菜单：输入框右键复制/粘贴可用；终端区右键行为如实记录（选词/粘贴）。
- C15 标题与子窗：主窗任务栏标题「Dagents」；受管子窗标题随页面文档 title。
- C16 SSE/WS 三路：运行直播逐字 + 轨迹泳道延伸 + 聊天流式逐 token。
- C17 权限 handler 不自伤：#4 的 setPermissionRequestHandler 接线后，#3 的 11 处复制仍全部可用（allowlist 含 clipboard-sanitized-write 的交集验证）。

**D. 收口与停净**

- D1 图标：任务栏/开始菜单/安装向导/桌面快捷方式四处理论同一图标（非 Electron 默认原子图）。
- D2 关于：帮助→关于 dagents 弹版本+模式+数据目录+日志目录+未签名提示+「关窗即退出」提示。
- D3 退出停净：关窗退出后 8080/3000/55432 三端口释放（`netstat -ano | findstr`）+ 无 dagents/postgres/node 残留进程；二次冷启正常。
- D4 数据保留：卸载重装（或换新包覆盖装）→ 工作流与会话数据仍在。
- D5 回归：config.json 指仓库 dev 栈模式照常跑（MVP 第一轮模式）；附加模式（先手动起 dev 栈再开 app）观察不代杀。
- D6 模式分叉文案（含驻留配方）：**dev 模式**停 docker PG → 状态页显示 docker compose 引导；**packaged** 驻留 db:down 用 A3 配方 → 显示内嵌 PG 恢复动作文案；**附加模式**指向 db:down 的外部实例（如 dev 栈停 PG 后被附加）→ 显示「外部服务数据库不可用，本应用不代管」——三分支各验一次。
- D7 日志面板：状态页「复制最近 400 行」→ 剪贴板含日志文本；「打开完整日志」→ 资源管理器打开 userData/logs/<svc>.log。
- D8 失败态与停止态按钮：制造服务 failed（如 config 写坏命令）→「重试服务」为 primary 且点击清零预算重启；菜单停止全部服务 → 按钮变「启动服务」且点击可重新拉起。
- D9 R9 重置数据目录：制造 postmaster.pid 残留（强杀 postgres.exe）→ 出现恢复提示 +「重置数据目录…」→ 二次确认弹窗含逐字警告 → **取消分支零副作用（数据完好）**；确认分支数据清空并自动重走 bootstrap 初始化。
- D10 Ctrl+W 退出：长任务运行中 Ctrl+W → 应用退出、三端口停净、该 run 在重开后标记为 failed 且可重跑（行为与 §7.4 记录一致）。

---

## 11. 边界、已评估风险与明确不做

**已评估风险（记录在案，验收时对照）**：

| # | 风险 | 裁决/对策 |
|---|---|---|
| R-1 | Ctrl+W 误按退出整栈杀运行中工作流 | 保留桌面语义（§7.4 完整评估：损失有界可重跑；缓冲方案引入新失败面判负）；关于页/README 写明；D10 锁定 |
| R-2 | **win 干净系统缺 VC++ 2015+ 运行库 → initdb/postgres 起不来**（架构 §16 证据 #4/#5 全在开发机跑通，自带运行库；@embedded-postgres win 二进制依赖未在裸机验证） | 预判项：NSIS 链 vc_redist（仅当实测缺库）或 ensure-postgres 阶段加二进制可执行性自检（失败给「缺少 Visual C++ 运行库」明示文案）；B1 若卡 ① 步+DLL 错误即命中，回报归此项 |
| R-3 | AUMID 与快捷方式不匹配致通知不弹/归属错 | 统一钉 appId 值 dev.dagents.desktop（§5 #4）；C4 验证归属图标 |
| R-4 | 权限 handler 接线推翻剪贴板默认放行 | allowlist 显式含 clipboard-sanitized-write（§5 #4）；C17 交集验证 |
| R-5 | 受管子窗使 window-all-closed 迟滞、退出不停净 | 子窗生命周期挂主窗（§5 #2/§7.4）；A6 验收 |
| R-6 | 终端边界文案归属悬空 | gateway 侧补句为首选（非 console，合规）；工程拒绝则矩阵记明示边界（英文原文），二选一写死（§5 #6） |
| R-7 | 接管挂起无尽头 | 15s 接管预算 + 3 次自动重试上限（§2.2）；A7 验收 |
| R-8 | 等待计时冻结形似卡死 | 渲染层本地 1s tick（§2.3/§6 规则 6）；B7/A7 顺带验证走秒 |

**明确不做（体验侧声明）**：

- 不做托盘、深链协议、多工作台、自动更新、代码签名（outOfScope 原文）——未签名绕过文案保留在 about 区与 README。
- 不做桌面壳设置界面（主题/语言用 console 设置页；外部 PG 等高级配置走 config.json + 打开文件夹）。
- 不做「确认退出」弹窗（§7.4 理由与评估记录）。
- 不给「进入工作台」绑菜单加速器（§2.5 理由）。
- WebContentsView 状态条非阻塞（§9），不进验收门禁。
- 通知点击无动作（与浏览器形态等价，console 未设 onclick——如实记录不补救）。
