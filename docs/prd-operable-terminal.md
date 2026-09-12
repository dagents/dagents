# PRD — 可操作终端（Operable Terminal）：运行中插话 + 重跑闭环

- 日期：2026-09-08
- 状态：已实施（P0 = A + B 全量落地；真机 claude 冒烟通过；C 接龙缓议；用户四项裁决见 §3）
- 关联：`prd-run-terminal.md`（终端视图是本 PRD 的展示底座）、执行取消 spec（execution-registry 控制通道）、结果面板 v2 / 运行中活动流（2026-08-30）

## 1. 背景与问题

9-06 终端视图解决了「看见」（events 全量保真 + `$` 提示行 + 跟随滚动），但它是**只读旁观窗**。bash 心智的四个动词——看、停、说、再来——前两个已有，后两个缺失，且断点是实打实的：

- 运行输入面板每次打开为空（只有 `dagents.canvas.runDir` 记忆了目录，输入正文不记忆）；
- FlowRunsPanel 历史行没有「同输入重跑」，两次 run 之间无法低成本对比；
- 运行中只能看不能插话，跑偏了拉不回来；
- `claude.ts:582` spawn 时 stdin 就是 pipe，但 `:714` 写完 prompt 即 `end()` 关闭——**管子已埋好，话路没接**。适配器注释明确记载 `--input-format stream-json`（JSON 帧双向 stdin）是 multica 已验证、被 defer 到「真正需要它的任务」的路径。

## 2. 三方讨论要点（摘要）

- **PM**：操作者人格缺的动词就是「说」和「再来」。信任 = 能介入，不只是能旁观。插话是 HITL 的泛化——HumanInput 是流程开口问你（阻塞、表单语义），插话是你主动开口（不阻塞、自然语言），两个入口并存不合并。验收标准：用户能在 run 跑偏时拉一把，结束后能一键原样再来。
- **设计师**：从旁观窗到操作台的跃迁。stdin 行钉在终端底部（真终端惯例：常驻、`>` 提示符、Enter 发送）；送达语义诚实三态，不做假乐观；并行节点用目标 chip 定位；插话作为一等事件进 events（9-06 保真契约的自然延伸）；重跑遵循就近原则——终端行原位变重跑入口。
- **架构师**：管道已经在了（stdio pipe），`--input-format stream-json` 是文档化路径；execution-registry 已解决「HTTP 请求如何找到活着的执行」，`send` 是 `abort` 的姊妹方法。真正的工程风险在**进程终态语义重钉**：现在「一次 prompt 一次 result 即节点完成」，stdin 常开后 completion 判定、inactivity 看门狗、EPIPE 路径都要回归。适配器分级推进，codebuddy 8-16 曾撤此 flag 的教训 = 逐适配器实测，不假设通用。

## 3. 用户裁决（2026-09-08）

1. **方向**：做「可操作的终端」——终端视图从旁观窗升级为操作台（看/停/说/再来四动词齐全）。
2. **旁观可插话**：`?run=` 旁观模式下 stdin 行同样开放（单机无认证，操作者即本人）。
3. **只对 running 节点插话**；不给未来节点排队留言（排队留言是另一个产品，不立项）。
4. **P0 = A（stdin 行）+ B（重跑闭环）**；C（接龙/跨 run 管道）后置缓议。

## 4. 方案

### 4.1 A — stdin 行（运行中插话）

- **位置与形态**：终端视图（画布结果面板「终端」tab + `?run=` 旁观）底部钉一根输入行，不随滚动走。运行中常驻；运行结束原位变灰为「重跑」入口（就近原则：看完结果，⬆ 就在原地）。inline chat 与 chat ProcessFold **不加**（聊天输入框本身就是它的 stdin 行）。
- **节点定位**：单 running 节点直连；多于一个时输入行左侧出目标 chip（默认当前聚焦节点），`@节点名` 语法兜底。只允许 running 节点（裁决 3）。
- **送达语义，诚实三态**：`sent`（行内确认「已送达 节点X」）/ `unsupported`（适配器或执行路径不支持，禁用并给原因）/ `not_running`（进程已退出 → toast 引导重跑）。UI 只承诺「已送达」，不承诺「已打断」——插话在当前 turn 内的处理顺序由 CLI stream-input 实现决定（见 §7），按「补话」设计。
- **审计闭环**：新事件 kind `user_input`（label=目标节点名、detail=全文），span-writer 即时落库（复用 text 的 1s 快节拍，不等 events 的 5s 慢节拍），终端渲染为高亮行。回放时「谁在何时对哪个节点说了什么」完整可考。
- **执行路径覆盖**：CLI 路径可插话；HTTP provider 路径（fetch 在途、无进程）与 dispatch/daemon 远程任务天然 `unsupported`，如实禁用不假装。chat `@flow` 触发的运行经 registry `byRun` 次键同样可插话。

### 4.2 B — 重跑闭环（⬆ 等价物）

- **输入记忆**：运行输入面板按 flowId 记忆上次输入（localStorage `dagents.canvas.runInput.<flowId>`，与 `runDir` 同模式），打开预填、可清空。画布运行面板与列表 `flow-run-dialog` 共用同一记忆键。
- **历史行重跑**：FlowRunsPanel 行（「画布旁观」按钮旁）加「重跑」→ 打开**预填的**运行对话框，非静默直发（输入可能很长，确认一步；⌘⏎ 快捷已有）。
- **终端行重跑**：运行结束后 stdin 行原位变「重跑」→ 打开输入面板（预填上次输入）。

### 4.3 C — 接龙（缓议，不进 P0）

结果面板正文块「以此输出发起运行」→ 选 flow → 输入预填。跨 run 引用 = pipe 语义（比流程内 `{{节点id.output}}` 再进一步）。等 A/B 落地、真实使用反馈出现后按需求立项。

## 5. 工程拆解（P0）

### 5.1 数据契约

- `IStreamActivityKind` 增 `user_input`（`packages/workflow/src/types/execution.ts:95` 现为 thinking/tool/tool_result/status/log/error 六种）。
- 插话**不走引擎钩子**：经 registry 控制通道直入适配器进程，`user_input` 事件走 span-writer 常规通道落库（nodeId 绑定目标节点），终态合并语义与既有 kinds 一致。

### 5.2 适配器（claude 先行）

- `claude.ts`：开 `--input-format stream-json`，prompt 首帧 JSON 化，stdin 写完首帧**不再 `end()`**；`AgentSession` 增 `send(text): boolean`（写 JSON 帧 user message）。
- **终态语义重钉**（本 PRD 最大工程风险）：final result 到达即节点终态（保持「一次节点一次终态」不变），适配器随即关闭 stdin / 结束子进程；常开窗口仅限节点 running 期间。
- 其余适配器禁用（codex `exec` 一次性无 stdin 收话）；分级挂 `tiers.ts` 思路，逐适配器实测后再逐个放行（codebuddy 教训）。

### 5.3 gateway 控制通道

- 新路由 `POST /api/v1/workflows/runs/:runId/message`，body `{nodeId, text}`；鉴权随既有 runs 路由族（`GATEWAY_API_KEY` 模式下同门禁）。
- `ExecutionHandle` 增可选 `sendToNode(nodeId, text): 'sent' | 'unsupported' | 'not_running'`（`abort` 的姊妹方法，`execution-registry.ts` 的 `byRun` Map 已解决寻址）；HTTP 响应即送达回执（同步三态）。
- span-writer 收 `user_input` 事件即时 UPDATE（`WHERE status='running'` 守卫照旧，永不覆盖终态）。

### 5.4 console 渲染

- `run-terminal.tsx`：TerminalSurface 内新增 pin 底部的 stdin 行组件（`>` 提示符、Enter 发送、目标 chip、三态回执、结束态变重跑入口）。
- `run-terminal-format.ts`：`user_input` 行派生 + 高亮样式（`run-terminal.css`）。
- 输入记忆读写 + FlowRunsPanel「重跑」按钮（`flow-runs-panel.tsx:149` 画布旁观按钮旁）。

## 6. 边界与明确不做

- **不做任意 shell**：终端不发文件系统/进程命令，控制动词仅既有取消按钮。
- **不暴露 control_request / 权限批准为 UI 动词**：自动批准语义留在适配器层，stdin 行只送用户消息。
- **不做 xterm / ANSI / pty**：沿用 9-06 裁决（结构化事件流用 DOM 行渲染）。
- **不做未来节点排队留言**（裁决 3）。
- **chat 路径不加 stdin 行**（聊天输入框已是双向入口）。

## 7. 已知取舍 / 风险（实施后回填）

- **插话时序**：落地为「排队补话」—— 插话在当前 turn 之后的下一个 turn 被 CLI 消化，节点最终 output = 最后一个 turn 的 result；UI 只承诺「已送达」，不承诺「已打断」。lifecycle 测试钉住时序（turn1 进行中 send → R2 收尾）。
- **@节点名 语法兜底未做**（对 PRD §4.1 的简化）：多 running 节点用输入行左侧的目标 select（单选 chip 形态）覆盖，语义等价；自然语言 `@` 解析的歧义不值得 V1 引入。
- **常开 stdin 的生命周期回归面**：终态判定（final result 归零即 end stdin）、inactivity 看门狗（逐行输出重置逻辑不变，用户打字不算活动）、EPIPE 容错 —— lifecycle 测试全量覆盖，真实 claude 冒烟通过。
- **`user_input` 即时落库**与 5s events 慢节拍并存：单条即时 UPDATE 载荷可控（一条消息），不引入膨胀。
- **旧运行回放**：旧 events 无 `user_input` 行，无需迁移，派生层按缺省降级。
- **多 turn 正文分隔**（实施复跑发现）：插话把节点产出拆成多 turn，直拼会粘连（「40我此刻」）—— adapter 在中间 result 帧发 `turn-boundary` status，CLI client 据此补 `\n\n` 分隔并在过程流记「插话已并入」边界行；终态 output 仍是全部 turn 正文的顺序拼接（每段都是真实交付物）。
- **存量地雷顺手修**：canvas 页面图把 `@dagents/workflow` dist 拉进浏览器包，撞上 user-code-exec.ts 的 worker_threads 静态 import（9-06 批次落地，此前无新编译未暴露）—— 双路置空：next.config 客户端 webpack resolve.fallback（next build/裸 dev）+ turbopack resolveAlias 指空模块替身（`pnpm dev` 带 --turbopack，忽略 webpack() 配置；浏览器侧永不执行）。

## 8. 测试

- **agent-adapters**：`claude.lifecycle.test.ts` 扩——stdin 常开、JSON 帧格式、`send` 写帧、final result 后关闭、EPIPE 容错。
- **gateway**：registry `sendToNode` 三态路由；message 路由鉴权与无 handle 404；span-writer `user_input` 快节拍落库 + 终态合并 + running 守卫。
- **console**：`run-terminal-format` 的 user_input 行单测；输入记忆读写单测。
- **e2e**：新 23 号 spec——B 重跑全旅程（历史行重跑 → 预填 → 运行 → 新 run 行出现）；A 的 UI 状态机（HTTP provider 运行天然 `unsupported`，可作禁用态断言路径）；A 的真实送达走本机 claude 真机冒烟（不进 CI，mock LLM server 无 CLI 进程）。
