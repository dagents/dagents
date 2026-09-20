# 浏览器终端架构（/terminal）

> 2026-09-19 · 终端 = 网关宿主机上的真 PTY（`$SHELL` login shell），SSE 推 base64 字节流，
> xterm.js 渲染。「就是浏览器里的 bash」，不是 agent 代跑命令的转述层。
> 契约单一事实源：`packages/contracts/src/shell.ts`（双端共享，改动即两端编译错）。

## 1. 组件图与数据流

```
┌─ console (Next) ──────────────────────────────┐      ┌─ gateway (Hono) ─────────────────────────────┐
│ /terminal page (PageShell)                    │      │ routes/shell.ts        HTTP 投影             │
│ shell-terminal.tsx     纯装配（布局+状态呈现） │      │ shell-registry.ts      进程内会话表           │
│  ├ lib/use-shell-session  编排 hook（状态机/boot/IO 动作）│   └ node-pty → $SHELL -l (真 PTY)          │
│  ├ lib/shell-session-plan 纯决策（恢复/新建/换仓 ◄──────┼─► @dagents/contracts/shell.ts 契约          │
│  ├ lib/shell-protocol     纯解析（SSE 帧/base64）      │   孤儿清扫 60s 周期（默认宽限 10min）        │
│  ├ lib/shell-theme        xterm 主题（tokens 映射）    │                                              │
│  └ shell-dir-picker.tsx   目录选择器（展示+下拉）      │                                              │
│ BFF app/api/shell/**   流式/普通代理          │      │                                              │
└───────────────────────────────────────────────┘      └──────────────────────────────────────────────┘
   输出：GET /:id/stream  SSE（hello 回放 → data* → exit；15s `: ping` 心跳）
   输入：POST /:id/input（base64 键入/粘贴，微批保序）· POST /:id/resize（winsize）
   生命周期：POST /（可带 cwd）· GET /（列表+home）· DELETE /:id
```

关键路径语义：

- **输出单向流（SSE）+ 输入短请求**：不需要全双工，避开 WS 升级穿透 BFF 的复杂度；
  SSE 经 Next BFF（`fetch` + body 直通，不缓冲）验证可用，心跳防中间层掐空闲。
- **base64 帧内封 PTY 原始字节**：SSE data 行装不下控制字节/换行；base64 保证
  ANSI/UTF-8 跨块保真，xterm 收字节流自己解码。
- **hello 帧即重连语义**：订阅即回放（256KB 环形缓冲），刷新页面/导航返回零丢失；
  `exited` 取**订阅之后**的会话状态（退出与订阅竞态时由 hello 补报，不依赖已清空的订阅者集合）。

## 2. 会话生命周期

```
create(POST) ──► LIVE ──┬── exit code N ──► EXITED（保留至清扫宽限，重连可见结果）
       │                ├── DELETE ────────► 移除
       │                └── 孤儿（0 订阅者且 idle>宽限）──► kill+移除
       └── 恢复：localStorage sessionId 命中活会话 → 直接接回（优先于目录偏好）
```

前端状态机：`connecting → live → exited | error`；首字节前显示启动占位（login shell
冷启动 2-5s）。目录偏好（`dagents.terminal.dirId`）只影响**新会话**落点；换目录 =
await DELETE 旧会话再重载（避免恢复查询与删除竞态把旧会话接回）。

## 3. 架构决策记录（ADR 摘要）

| # | 决策 | 备选 | 理由 |
|---|------|------|------|
| 1 | SSE 而非 WS | ws-hub（已存在） | 输出单向即可；WS 需升级协商穿透 BFF；hub 面向广播非字节流 |
| 2 | base64 帧内封 | 两段转义/二进制分帧 | SSE 行协议约束下最小保真方案；契约测试锁定 |
| 3 | 进程内会话表（无持久化） | DB/Redis 注册表 | 本机单进程产品；终端会话本就易失；重启即清空是**接受的语义** |
| 4 | node-pty | bash -i + pipes | 无 PTY 则无提示符/颜色/交互程序（top、vim）—— 不符「就是 bash」目标 |
| 5 | PTY 最小环境（sshd 同款） | 继承网关 env | 网关 env 含 POSTGRES_URL/API key，注入终端=页面 `env` 即泄密；login shell 自行重建用户环境 |
| 6 | 契约进 @dagents/contracts | 双端各写形状 | 已发生过 hello.replay 原文/base64 漂移 bug；单一事实源+两端类型接线根治 |
| 7 | 会话与目录偏好分离记忆 | 绑定 | 活会话恢复优先于偏好；同目录切换不打扰活会话 |
| 8 | 键入微批保序（8ms 窗口 + 串行 flush） | 每键独立 fetch / 全量缓冲 | 并行 fetch 不保序，极速连打实测字符成对乱序到达 PTY；微批兼顾保序与不逐键付 RTT（粘贴本就是单 onData） |

## 4. 安全模型

- **本机模式**：与全站一致 —— 默认开放（127.0.0.1），`GATEWAY_API_KEY` 全局门，
  Origin 守卫常开（跨源 403）。终端没有**额外**的暴露面：platformAgent CLI 本就能跑任意命令。
- **纵深防御**：PTY 环境最小化（ADR-5）；`DAGENTS_SHELL_DISABLED=1` 总开关；
  会话上限 `DAGENTS_SHELL_MAX_SESSIONS`（默认 8）。
- **已知边界**：能打开页面的会话 = 能拿到同用户权限的 shell（与本地开 Terminal.app 等价）。
  对外暴露网关时，终端路由应视为最高危面 —— 必设 `GATEWAY_API_KEY` 或关闭终端。

## 5. 故障模式与降级

| 故障 | 行为 | 依据 |
|------|------|------|
| 网关重启 | 会话全灭（进程内注册表）；前端「连接断开」→ 重连失败自动新建 | ADR-3 语义 |
| BFF/代理缓冲 | 心跳 `: ping` 15s 保活；Next BFF 流式直通已实测 | 集成测试 SSE 心跳用例 |
| 退出 vs 订阅竞态 | hello.exited 补报 + exit 帧补发 | 单测「attach 竞态回归」 |
| 重连窗口丢字节 | attach 原子快照（同步段内订阅+回放，零丢失零重复） | registry.attach 注释 |
| 双标签页同会话 | 双订阅者扇出正常；双写输入会交错（等价两个终端窗口连同一 tmux） | 已知可接受 |
| pnpm 丢 spawn-helper 执行位 | 网关启动自愈 chmod | shell-registry `ensureSpawnHelperExecutable` |

## 6. 边界与演进路径

- **多实例网关：不支持**（会话在单进程内存，SSE 重连需亲和）。上多实例前需sticky 路由
  或注册表外置 —— 当前产品形态（本机单进程）无此需求，**刻意不做**。
- **多标签终端**：服务端上限 8 已备；UI 按单会话做薄，tabs 落地时 localStorage 改数组即可。
- **审计接入（roadmap）**：会话创建/销毁应入 audit trail；`AuditTargetType` 是 db schema
  封闭联合，扩 `'shell_session'` 是独立 schema 变更，不骑劫本特性。
- **场景化入口（roadmap → 已立项设计）**：`/terminal?dir=<目录id>` 深链已就绪（boot 读取并落盘）。
  「终端双锚点」设计（[`design-terminal-anchors.md`](design-terminal-anchors.md)，2026-09-19）定稿了
  入口矩阵与前置数据链修复（runs.directory_id），实施待排期。

## 7. 测试地图

| 层 | 位置 | 覆盖 |
|----|------|------|
| 契约/纯逻辑 | `apps/console/src/lib/__tests__/shell-protocol.test.ts` | base64 往返（多字节/ANSI）、SSE 分块边界、keepalive/畸形帧 |
| 网关单元（真 PTY） | `apps/gateway/src/__tests__/shell.test.ts` | 生命周期/回放/竞态/上限/总开关/非法输入，10 用例 |
| 孤儿清扫器（真 PTY） | `apps/gateway/src/__tests__/shell-sweeper.test.ts` | 压缩时间窗实测三种命运：孤儿回收/订阅者免回收/退出保留 |
| 真机集成 | `/tmp/shell-e2e-test.py` + `shell-e2e-ext.py`（测试存档） | 双链路 26 项 + 扩充 7 项：env 泄漏归零/回放上限截尾/上限 429/快速建删 |
| 浏览器 UI | 实弹（browser automation + Playwright 真合成器） | 键入（含极速连打保序）/回放渲染/新会话/exit 浮层/双主题/目录定向（pwd 铁证）。注意：**挂起的 webview 会饿死 rAF 使 xterm 渲染停摆（自动化假象，非缺陷）—— 渲染裁决用 Playwright** |
