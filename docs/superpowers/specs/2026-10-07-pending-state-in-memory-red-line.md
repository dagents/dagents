# ADR：挂起/escalation registry 的纯内存红线

> 日期：2026-10-07 · 需求：R9 9a（`docs/zcode-borrow/requirements.md`）· 设计：`docs/zcode-borrow/design-sharp.md` §2.1
> 状态：已采纳。任何「把可兑现承诺写进持久表」的提案，须先驳倒本 ADR 的核心论证。

## 1. 核心论证：持久表只会说谎

Dagents 是单进程本机网关。挂起态（HumanInput 等答案、执行中的 AbortController）的
真相是**进程内的 Promise / AbortController / 回调句柄**——它们随进程死亡而死亡。

若把「挂起中」这类**可兑现的承诺**写进持久表：

- 重启后表说「可继续」，而兑现承诺的执行上下文（闭包、调用栈、CLI 子进程管道）已死；
- 读到该行的任何代码（resume 路由、UI、清扫器）都面临两难：拒绝（表为什么这么说？）
  或假兑现（新起一次执行，但用户以为在「继续」原来的）；
- 结论：**诚实失败优于假承诺**。挂起态持久化的正确形态是「意图 + 重建所需的全部
  事实」（即 checkpoint 快照），不是「承诺仍在」的声明。

这不是丢数据——是分清两类信息：

| 信息类型 | 归属 | 例子 |
|---|---|---|
| **状态事实**（已发生什么） | DB 是真相源 | `runs.status`、spans、checkpoint 快照、journal decision |
| **控制通道**（正在进行、可被谁打断/兑现） | 进程内 registry | execution-registry、`pendingByChat`、run-live 帧缓冲 |

现有红线注释（互引锚点）：

- `apps/gateway/src/routes/human-input.ts` 头注释——chat 流式路径 in-memory 取舍的原始论证；
- `apps/gateway/src/execution-registry.ts` 红线段——「DB stays the source of truth for
  STATE; this registry is only the CONTROL channel」；
- `apps/gateway/src/routes/resume-execution.ts`（持久 resolver）——「不持有任何内存
  Promise（重启安全）」。

## 2. 两机制并存的边界判据

现状挂起双轨制，边界判据如下（何时用哪个）：

| 判据 | chat SSE 内存 promise（`pendingByChat`） | 画布/answer 持久 checkpoint |
|---|---|---|
| 挂起的兑现者 | 用户下一条 chat 消息（同 SSE 连接续流） | `POST /runs/:id/resume` 或 chat 应答回流（新执行、新进程亦可） |
| 重启语义 | 即死 + 会话补中断说明（`markOrphanedHumanInputs`） | checkpoint 落 `awaiting_input`，重启后仍可续（deadline 由 boot sweep 收敛） |
| 持有物 | 内存 Promise（**不持有任何持久化承诺**） | 持久快照（**不持有任何内存 Promise**，重启安全） |
| 选择规则 | 挂起与兑现都绑定**这条连接/这个会话进程**时 | 挂起需要**跨进程/跨时段**兑现时 |

两轨各守其一侧红线：内存轨绝不写「挂起中」进表（重启即死、不留假承诺行）；持久轨
绝不在 gateway 内存里持有可兑现的 Promise（应答回流 = 新执行从快照重建，不是唤醒旧
Promise）。

## 3. 红线适用范围

同属「进程内 = 控制通道，DB = 状态真相源」模型：

- **execution-registry**（执行句柄：AbortController / done Promise / 插话汇点）——
  单进程 Map，无 Redis / pub-sub；
- **pendingByChat**（chat 域 HumanInput 挂起 promise）；
- **run-live-registry**（直播帧缓冲）——重启即丢，客户端 404 时诚实回退 node-spans
  轮询渲染（契约注释见 `packages/contracts/src/run-live.ts` Availability ladder 段）；
- **trial-registry**（R10 试运行 mock 调用记录）——持久层是 spans，进程内记录丢失时
  证据面板如实标注并回退 spans 投影；
- **run-notify claim Set**（R9b 通知发射幂等）——进程内 `Set<runId>`，重启清零无害
  （重启后无新终态产生，不构成双通知面）。

## 4. 补偿机制：历史不说谎

进程内状态死了不算完——**补偿动作让持久历史如实反映中断**：

- `markOrphanedHumanInputs`：重启后为被中断的 chat 会话补「中断说明」消息；
- boot sweep（`apps/gateway/src/boot-sweep.ts`，2026-10-07 从 index.ts 抽出）：收敛
  悬空 running 的 runs / spans / checkpoints（R1 落地后语义升级为 stopped +
  resumable，见 §5）；
- run-live registry 清扫器：长期无终态上报的条目按 unknown 收敛。

## 5. 修订记录

- 2026-10-07：初版（R9a）。可恢复性方向（R1/R3）落地后，boot sweep 语义从「在途
  run → failed」升级为「stopped(interrupted) + checkpoint 收敛 resumable」——届时本
  ADR 追加一段修订说明，不改写结论；内存轨/持久轨的边界判据不受影响（checkpoint
  仍是持久快照不是 Promise）。
