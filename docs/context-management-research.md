# 上下文管理（Context Management）调研报告

> 2026-10-04 · 起因：向量检索搁置后，先做好上下文管理。调研对象：本地克隆的

> **落地状态（同日第二轮）**：P1a/P1b/P2a/P3 已实现——LLM 节点总预算分配制
> （`utils/context-budget.ts` + span 对账）、两级历史（chats 滚动摘要迁移 1720000104000
> + `lib/chat-context-summary.ts`，dsh KV 前缀技巧）、flow 级 context_md（迁移
> 1720000105000 + 画布「上下文」面板 + 版本快照/回滚含上下文）、persona 预算 +
> `/metrics` 组装字节三指标。**P2b 被收编**：dagents 架构里聊天无"越跑越长"的
> 在途上下文（flow 每条消息全新引擎态、CLI 单发自理、节点一次性上下文）——
> 真正的压缩面就是滚动摘要本身，独立 compaction 无对象。P0（聊天会话连续性）
> 仍待立项。
> deepseek-harness、everything-claude-code、AgentSpace、openworker（ai-teams /
> mil-agents-main 为空壳，无实现），结合业界已知模式（Claude Code、memGPT/Letta、
> Cline）。结论面向 dagents 的落地建议在 §5。

## 0. 一页结论

所有项目的做法可以收进一个**五层心智模型**——从便宜到贵、从被动到主动：

| 层 | 名称 | 一句话 | 代表做法 |
|---|---|---|---|
| L0 | **瘦身** | 常驻内容最小化：一切「每次请求都带着」的东西都要审计 | MCP/工具 schema 限数（ECC：\<10 服务/\<80 工具，每工具 ≈500 token）；CLAUDE.md \<300 行；trigger-table 懒加载 |
| L1 | **裁剪** | 进上下文之前先砍：预算制 + 头尾保真截断 | dsh 工具输出裁剪（头+省略标记+尾，全文留日志）；openworker shell 保**尾部** 20k；dagents 多入边合并 64KB |
| L2 | **压缩** | 临界时把旧历史浓缩成结构化 checkpoint | dsh 自动压缩（阈值 0.8、保留 0.16、溢出错→压缩重试）；Claude Code auto-compact；ECC 战略压缩（逻辑断点手动） |
| L3 | **记忆** | 跨会话的持久层：显式记忆/知识页/摘要续接 | openworker 记忆三档 scope+工具；AgentSpace 知识页渐进披露；ECC 会话三件套 hooks |
| L4 | **分担** | 架构级：让别的上下文干脏活，主上下文只收结论 | 子代理独立窗口只回报告（ECC/openworker）；@引用不附内容（dsh）；全量落盘按需读（AgentSpace） |

**最重要的统一裁决**（多个项目独立收敛到同一答案）：
1. **摘要内联 + 全量落盘按需读**的两级结构（dsh / ECC / AgentSpace 三家一致）；
2. **会话日志是事实源，模型侧 session 只是缓存**（AgentSpace 明文；dsh 的 shadowed-seq 可回放设计同义）；
3. **压缩前先把状态写文件**（ECC PreCompact hook）；
4. **注入的上下文要 durable**（dsh：注入即入历史，参与回放与后续压缩，不是隐形 prepend）。

---

## 1. deepseek-harness（DeepSeek 官方 harness，本地 ~/Projects/deepseek-harness）

### 1.1 compaction 家族（packages/compaction/）

插件化四件套，职责切分干净：

| 包 | 职责 |
|---|---|
| `compaction`（契约） | 定义操作与摘要格式，`ctx.compaction` 服务缝 |
| `compaction-basic`（实现） | token 压力达阈值（默认 `thresholdRatio: 0.8`）→ 把最老历史浓缩为摘要、保留近期（`retainRatio: 0.16` 或绝对 `retainTokens`）；**上下文溢出报错后压缩再重试**；`/compact` 手动；按模型分策略（小上下文模型单独阈值） |
| `compaction-tool-result-pruner` | **压缩前先裁**：超预算的工具输出替换为「有界头部 + middle-pruned 标记 + 有界尾部」；全文留在会话日志（回放/查验完整）；可能裁完就够了、免掉一次摘要调用 |
| `compaction-image-offload` | 图片超预算→占位符（监听请求错误） |

三个可抄的工程细节：
- **摘要指令放在重放对话之后的最后一条 user 消息**（不是独立 system prompt）——辅助调用成为「上一次真实请求的真前缀」，provider 的 **KV cache 直接复用**而不是失效（`compaction-basic/src/summarizer.ts`）。
- **结构化 checkpoint 格式**（固定八节，空节写 "(none)" 不许删节）：Primary Request and Intent / Key Technical Concepts / Files and Code / Errors and Fixes / Pending Jobs / Current Work / Next Step / Critical Context。规则：保留精确路径/命令/错误串/数字/签名；不暴露「发生过的压缩」；**已有前次摘要时合并而非照抄**（保留仍真、丢弃过时、并入新信息）。
- **会话事件日志上的可回放压缩**：`compaction/start|summary|end` 三事件（锁语义——崩溃留下可检测的孤儿锁）；被替换范围记 `shadowedSeqs`；摘要以 `user/message + surfaceOp: replace` 落地。压缩后的会话仍然**可精确重建**。

### 1.2 context 注入家族（packages/context/）

「每请求注入、不定义工具」的插件群，两条硬原则：
- **字节预算 + 层级取舍**（agent-instructions）：AGENTS.md/CLAUDE.md 链有总字节预算，超限时**先丢更宽泛的文件、最后截最特定的文件**（全局 < 项目 < 嵌套的取舍序）。
- **@file 引用永不附带内容**（file-reference）：补全只插入路径提及，模型要看必须自己调 read 工具——引用是索引不是载荷。
- **注入即 durable**：注入的指令/引用以 user 消息进入会话历史，参与回放与后续压缩，不是隐形 system prepend。

## 2. everything-claude-code（~/Projects/everything-claude-code）

Claude Code 技巧合集，按出现频率排序的最佳实践：

1. **MCP 瘦身是第一杠杆**（6+ 处出现）：每个 MCP 工具 schema ≈500 token 常驻；200k 窗口可被工具描述吃到只剩 ~70k。硬性建议每项目启用 <10 服务 / <80 工具，CLI 能替代的 MCP 一律删（`gh` 代替 GitHub MCP）。
2. **战略压缩 > 自动压缩**（strategic-compact skill + suggest-compact hook）：在逻辑断点（探索完→实现前、里程碑后、调试后、失败方案后）手动 `/compact`，可带自定义聚焦指令；实现中途绝不压缩。附「压缩后什么存活」对照表（CLAUDE.md/TodoWrite/memory 文件/git 状态存活；中间推理、已读文件内容丢失）。
3. **子代理保护主上下文**：探索/读文件/跑测试交给子代理（可配便宜模型），只回摘要；编排者传「目标」不只传「查询」；阶段产物落盘（research-summary.md/plan.md…）、阶段间 `/clear`。
4. **状态落盘三件套 hooks**：PreCompact 压缩前存状态；SessionEnd 从 transcript 提取「有效/无效/待办」摘要写文件；SessionStart 自动加载。跨天工作靠摘要文件续接，不硬撑长会话。
5. **常驻内容审计**（context-budget skill）：按 `words×1.3`（散文）/`chars÷4`（代码）估算各常驻组件 token，输出 Top3 节省建议；skill 用 trigger-table 懒加载（基线上下文降 50%+）。
6. **上下文最后 20% 不做难事**（低上下文敏感任务才放后期）；thinking token 设上限（默认 31999→10000 省约 70%）。
7. **按模式注入**：dev/review/research 三套系统提示按场景加载，而非全量常驻。
8. **持续学习**：会话结束把重复模式自动提取成 skill，下次按需加载。

## 3. AgentSpace（~/Projects/AgentSpace，多 agent 工作台）

- **每任务重组一次性大 prompt**：频道历史以「一行一条摘要」（时间 | speaker: 180 字符摘要）内联；同时 `channelHistoryPath` 指向**落盘的全量历史 Markdown**，prompt 明示「内联不够就自己去读」——**摘要内联 + 全量落盘按需读**两级结构。
- **Router session 是事实源，provider 原生 session 只是不可靠缓存**：有 session 时用 `claude --resume sessionId`（省 token），冷启动用 memorySummary + transcript 事件日志重建。这条裁决直接回答了「CLI 原生 resume 还是自管历史」之争：**都要，且自管为源**。
- **Knowledge Pages 渐进披露**：按 agent 分配的知识页物化到工作目录；prompt 只给**标题清单（≤12 篇）**，正文让 agent 自己按需读文件。
- **每块注入硬预算**：router 块 2400 字符、transcript 行 220 字符（最近 40 行）、知识页 12 篇、通知 8 条。
- 多 agent 完全隔离（独立 workDir/prompt），靠频道摘要+文档+@mention（级联深度 ≤2）共享。

## 4. openworker（~/Projects/openworker，Python 单机 agent）

- **全量历史直传**（无截断/滑窗/摘要）——反例：这是最朴素的一档，长会话必然溢出，不推荐。
- **显式记忆三件套**：SQLite 记忆库（global/workspace/session 三档 scope）+ `remember/update/forget` 工具 + 已知记忆整体注入 system prompt（配使用指引教模型何时该记）。**显式记忆 vs 自动摘要**是两条路线：openworker 选显式（可控、可审计），dsh 选自动摘要（无感）。
- **explore 子代理**：全新独立上下文 + 只读工具 + 最多 10 轮 + 禁递归，**只回传 report**——研究开销不烧主上下文。
- **工具输出保尾部**：shell 截 20k 字符**保留尾部**（注释：「build/test 的结论在末尾」）；read_file 2000 行/单行 500 字符；grep 每行 300 字符。**保尾不保头**是对构建/测试输出的关键洞察。

## 5. 业界已知模式（补齐）

- **Claude Code**：auto-compact（接近上限自动压缩为结构化摘要）+ CLAUDE.md 记忆文件 + `/clear`（换任务）+ `--resume`（会话续接）。摘要结构与 dsh 的八节 checkpoint 同源。
- **memGPT/Letta**：分层记忆——主上下文（窗口内）+ 外部上下文（窗口外），模型用函数调用自主换页（self-paging）。学术优雅，工程重；其「记忆操作工具化」的洞见被 openworker 继承。
- **Anthropic 上下文工程指引**（2026 广为引用的四招）：just-in-time retrieval（要用了才取）、compaction（压缩）、structured note-taking（边干边把状态写到文件/TODO）、sub-agent architectures（隔离烧上下文的工作）。本调研的本地项目全部可归入这四招的组合。

## 6. dagents 现状盘点（诚实清单）

| 面 | 现状 | 对照模型 |
|---|---|---|
| 聊天 inline agent | **每轮无记忆单发**：新消息直接一次性 spawn CLI，无历史、无 resume | L3 缺失（最大缺口） |
| 聊天 flow 路径 | 每条消息全新引擎状态；LLM 节点可 opt-in `includeChatHistory`（关键词+时间混合检索，近 7 天） | L3 雏形 |
| 工作流 LLM 节点 | prompt + 上游合并（64KB 头尾截断 ✓）+ 可选 history/schema；**无整体预算观**（各块独立上限，无「总预算-分配」） | L1 部分 |
| 工作流节点天然隔离 | 每节点一次性上下文（buildCliMessages 单发）；executeFlow 子流程同 runId 独立执行 | L4 天然具备 ✓ |
| 工具输出 | http 节点/内置 http_request 32KB **保头部**截断（openworker 的洞察：构建/测试类输出应保尾） | L1 部分 |
| 压缩 | 无（CLI agent 内部自理；HTTP LLM 节点/聊天长会话无压缩） | L2 缺失 |
| 记忆/知识 | 无 per-flow/per-directory 上下文文件（registry-not-database 家族可装） | L3 缺失 |
| 常驻审计 | system prompt 注入人格/skills（composeSystemPrompt），无体积预算 | L0 缺失 |
| 事件/轨迹 | run-live 环形缓冲有界 ✓；span 落库完整 ✓ | — |

## 7. 建议（按优先级，均映射到 dagents 架构）

### P0：聊天 agent 会话连续性（最大缺口，用户可感知）
采纳 AgentSpace 裁决的 dagents 版：
- **会话日志（chat_messages）为事实源**，CLI 原生 session（`--resume`）为加速缓存；
- 每轮组装 = 人格 system + **历史摘要行内联**（每条 180 字符，最近 N 条）+ **全量历史落盘文件**（复用 run 事件或新-table，prompt 注明路径让 agent 按需读）；
- 适配器层加 `--resume sessionId` 支持（claude 档先行），命中时省掉历史内联。

### P1：LLM 节点上下文预算器（context budget）
把节点输入组装从「各块独立上限」升级为**总预算分配制**（dsh agent-instructions 的取舍序）：
`总预算（按模型窗口百分比，默认 60%）→ system+prompt 常驻 → 上游合并 → history → schema`，超限按「宽泛先丢」序裁剪，每步留痕（span 记录裁剪了对账数字——沿用 64KB 截断的标记风格）。同时把 http/http_request 的截断策略改「保尾优先」可选。

### P1：两级历史落盘（flow/chat 通用）
全量过程已有（events/spans），补「**摘要视图**」：为每个 chat 生成滚动会话摘要（dsh 八节 checkpoint 格式裁剪为 chat 版），`includeChatHistory` 升级为「摘要 + 最近 K 条原文」混合注入——现在只有原文检索。

### P2：压缩（compaction）最小可用
触发面先收窄到**聊天流式路径的 HTTP LLM**（CLI 自理不需要我们管）：阈值触发 → dsh 式摘要（结构化 checkpoint + 指令放末条 user 消息保 KV 前缀）→ 替换旧历史。工作流 run 是短生命周期（节点一次性上下文），不需要 run 内压缩——**dagents 的架构让 L2 的适用面天然很小，这是优势**。

### P2：flow 级上下文文件（L3，registry-not-database 家族）
flow 可挂一个 `context.md`（画布编辑、随 flow 版本化快照），运行时按字节预算注入 LLM/Agent 节点 system（dsh 取舍序：flow 级 > 目录级 > 全局）。对齐 CLAUDE.md 生态直觉，零新基础设施。

### P3：常驻审计与工具面瘦身
- `composeSystemPrompt`（人格+skills 注入）加字节预算与去重（ECC：重复指令检测）；
- platformAgent 的 tools 声明做「按需注册」审计（未用工具不进 schema——对照 ECC 的 MCP 瘦身第一杠杆）；
- `/metrics` 加 per-node 组装后上下文字节数直方图（可观测先于优化）。

### 不建议做的
- **memGPT 式自主换页记忆**：工程重、与「节点一次性上下文」的 DAG 架构相性差；
- **run 内自动压缩**：run 生命周期短，节点即隔离，没有「越跑越长」的会话对象；
- **向量检索**（本轮已裁决搁置）：L3 的检索层在摘要+落盘两级结构落地后再评估。

## 8. 参考文件索引

| 项目 | 关键文件 |
|---|---|
| deepseek-harness | `packages/compaction/compaction-basic/src/summarizer.ts`（摘要 prompt+KV 技巧）、`docs/subsystems/compaction.md`（事件/锁/回放契约）、`packages/context/agent-instructions/README.md`（字节预算取舍） |
| everything-claude-code | `skills/strategic-compact/SKILL.md`、`skills/context-budget/SKILL.md`、`hooks/hooks.json`（三件套）、`docs/token-optimization.md` |
| AgentSpace | `packages/daemon/src/task-context.ts`（prompt 组装+块预算）、`packages/daemon/src/agent-router/adapters/claude.ts`（--resume）、`packages/services/src/knowledge/knowledge.ts`（知识页） |
| openworker | `coworker/engine.py`（全量直传反例）、`coworker/memory/`（显式记忆）、`coworker/tools/subagent.py`（explore 子代理）、`coworker/tools/shell.py`（保尾截断） |
