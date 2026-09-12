# PRD — 运行终端（Run Terminal）：CLI Agent 运行结果以终端形式展现

- 日期：2026-09-06
- 状态：已实施（P0 数据层 + P1 渲染层；三方讨论 + 用户四项裁决见 §3）
- 关联：结果面板 v2（2026-08-23）、运行中活动流（2026-08-30）、节点产出流式展示（2026-08-30）

## 1. 背景与问题

产品的执行核心是 CLI agent（claude/codex CLI），它们最可信的呈现介质是自己的原生环境——终端。现状把终端输出「翻译」成 GUI 卡片，且翻译发生在**采集端**，丢的内容不可恢复：

- thinking 落库前截 100 字（span-writer 旧逻辑）
- 工具调用摘要截 60 字（workflow-clients 旧 `toolLabel`）
- activity 环形队列只留最近 12 条
- 工作流路径只转发 3 种事件（text/thinking/tool-use），tool-result / status / log / error 整体丢弃

用户的典型追问「它到底跑了什么命令、看了哪个文件、返回了什么」，UI 永远答不上来。

## 2. 三方讨论要点（摘要）

- **PM**：终端视图 = 信任 + 审计 + 心智模型匹配（「我 spawn 的是 CLI，就该给我看 CLI 的输出」）。面向操作者人格；验收标准 = 用户在 UI 里能回答「agent 做了什么、依据是什么」。
- **设计师**：终端是「设计系统内的一等视图」，不是仿真 CRT —— 令牌化配色、跟随明暗主题、mono 字体栈；行级层次（`$` 提示行 / thinking 暗色 / 工具行 / 正文 / 错误红）；借真终端交互惯例（自动滚动 + 上翻暂停 + 回到底部 + 复制）；默认仍是摘要面板，终端为切换视图（渐进披露，工具参数/结果默认折叠一层）。
- **架构师**：这首先是数据保真度问题，UI 是最后一公里；截断必须从采集端挪到展示端；渲染选型不引入 xterm.js —— 手里是结构化事件流不是 pty 字节流，DOM 行渲染即对（xterm 反而要把事件伪造成 ANSI，还背 canvas 渲染器体积）。

## 3. 用户裁决（2026-09-06）

1. **切换式**：摘要面板保持默认，终端为一键切换（localStorage `dagents.canvas.resultView` 记忆）。
2. **全部保真**：thinking 全文、工具参数全文、tool_result 全文入库，仅保留防膨胀保险丝（非语义截断）。
3. P1 范围**含 chat 折叠区收敛**：ProcessFold 与画布共享同一终端交互组件。
4. **采集端截断全部拿掉**：保真契约 = 采集层保全文，展示层做策展。

## 4. 架构

### 4.1 数据契约（P0）

- `IStreamDelta`（`packages/workflow/src/types/execution.ts`）：activity kinds 扩为
  `thinking | tool | tool_result | status | log | error`；label/detail 携带完整内容，发送端一律不截断
  （tool 的 label=工具名、detail=参数 JSON 全文；tool_result 的 detail=输出全文）。
- CLI client（`apps/gateway/src/routes/workflow-clients.ts`）：`forwardActivityDelta` 转发除 text 外的全部
  AgentEvent 变体（chat 与 chatStream 两个消费循环共用）。
- span-writer（`apps/gateway/src/span-writer.ts`）双通道：
  - `events`：全量过程日志，终端视图与事后回放的唯一保真数据源；
  - `activity`：12 条环形队列，降级定位为摘要面板的**策展缓存**（summary ≤80 字是展示派生物，全文永远在 events）；
  - 落库双节拍：text/activity 每 1s，events 每 5s 同刷（全量 JSON 重写随事件数增长，快节拍会线性膨胀 UPDATE 载荷）；
  - 终态 onNodeEnd 合并双通道进最终 output（回放数据源）。
- 保险丝（防膨胀，非语义截断）：单条 detail 64KB、events ≤800 条、总量 ~1MB（超出丢最旧保近因）。

### 4.2 渲染（P1，console）

- `src/lib/run-terminal-format.ts`：纯派生层（span → section/lines；events 优先，旧运行/早期 running
  降级 activity 环；DirectReply 字符串化 JSON 二次解包与摘要面板同语义）。
- `src/components/run-terminal.tsx`：
  - `RunTerminal`：单流分段终端流 —— 段头分隔线（`── ● 标题 · 状态 · 耗时 · tokens ──` + 本段复制）、
    `$` 提示行、统一 Icon 事件行（brain/wrench/cornerDownRight/alertTriangle/point，2026-09-06 设计师
    验收裁决去 emoji；thinking/工具参数/工具结果默认折叠一层，展开全文）、成品正文全文直出
    （running 带呼吸光标）；
  - `TerminalSurface`（导出）：滚动跟随 / 上翻暂停 / 「回到最新」跳底 —— chat ProcessFold 复用同一交互。
    回放已完成的过程从顶部读起，tail 跟随只在打开时有运行中节点时启用（`initialPinned`）。
- 画布结果面板（`canvas-kit-page.tsx`）：标题行内「摘要 | 终端」分段切换器；终端段序沿用拓扑排序。
- chat ProcessFold（`assistant-content.tsx`）：容器收敛为 TerminalSurface（跟随滚动 + max-height 48vh，
  长过程不再无限撑高聊天流 + 复制过程实录）；行级组件（ToolCallCard 含 diff 视图）保留为终端内富卡片。
- 明确不做：xterm.js / ANSI 透传 / pty 捕获（结构化事件流用 DOM 行渲染；代码高亮沿用 shiki）。

## 5. 已知取舍 / 后续

- 旧运行（events 通道落地前）的终端视图显示 activity 环的摘要级内容 —— 历史数据无法补采。
- events 慢刷 5s：running 期间终端视图的事件行最多滞后 5s（正文 live tail 仍 1s 刷新）。
- 缓议（P2）：`run_events` 独立表（跨运行分析 / 回放分享需求出现时再立项）、运行级聚合单流视图、
  asciinema 式导出回放。
- e2e：未新增 spec（终端视图为纯渲染层，派生契约由单测钉住；live 链路已有 WF-13 覆盖）。

## 6. 测试

- gateway `src/__tests__/span-writer.test.ts`（6 用例）：保真（500 字 thinking / 5000 字参数 / 8000 字输出全文）、
  status/log 进 events 不进 activity 环、summary 为展示派生、双节拍落库、终态合并、保险丝。
- console `src/lib/run-terminal-format.test.ts`（9 用例）：events 优先 / activity 环降级、坏损条目容错、
  DirectReply 解包、command 与 tokens 派生、裸 JSON rawJson、复制 transcript。
