# Changelog

All notable changes to Dagents are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/); versions follow
[Semantic Versioning](https://semver.org/).

## [Unreleased]

### Added

- **工作流多人格优化轮（2026-10-04，12 个人格 × 12 个方面）** — 从内置人格库选角，对
  `@dagents/workflow` 全链路的一揽子优化；引擎语义改动由新测试套 `executor-v2-semantics.test.ts`
  （17 例）钉死：
  - **失败分支隔离**（Backend Architect）：节点级 `isolateFailure` 输入——失败只塌缩本分支
    （下游 skipped 剪枝），run 不中断、终态 `partial_success`（有产出 + 失败记账）；默认语义
    不变。附带 `finalOutput` 显式指定（压过「拓扑最深」默认）。
  - **LLM 输出契约**（Prompt Engineer）：`outputSchema` 输入（JSON Schema 子集）——schema 编入
    system prompt（HTTP/CLI 同语义）、`json-schema-lite` 解析校验（零依赖手写子集：type/required/
    properties/items/enum/长度与数值界）、一轮「错误清单喂回」修复重试、命中后输出带 `json` 字段
    （下游 `{{id.json}}`）；声明契约禁用流式（修复重试无法撤回增量）。多入边合并 content 64KB
    截断（保头尾 + 对账省略标记，`DAGENTS_MERGE_CONTENT_CAP` 可调）。
  - **混合会话检索**（AI Engineer）：LLM 节点 `includeChatHistory`——宿主 `historyRetriever`
    按「关键词×3 + 时间衰减×2 + 同会话+2」融合排序，作用域当前会话 + 同目录（近 7 天）；
    向量升级路径 = 换实现不动契约。
  - **Iteration 双新语义**（DevOps + Product Manager）：`concurrency`（默认 1；1-8 有界并行，
    每项独立 runtime 覆盖层 + 收集器，项序归并保 executedNodes 确定性，游标沿连续前缀推进，
    嵌套迭代自动回退串行）与 `whileCondition`（JS 表达式，user-code-exec 硬化求值，真值停剩余项
    ——「循环直到 X」原生表达，聚合带 earlyExit）。
  - **run 级 tokenBudget**（DevOps Automator）：run body `tokenBudget`——波次结算对账，越线停机
    终态 `budget_exceeded`（产出截至停机点，错误带对账数字）；失控循环不再只靠上限兜底烧钱。
  - **ExecuteFlow 子流程复活**（Agents Orchestrator）：`executeFlowAgentflow` 一等画布节点
    （D8 删除后按引擎 DB-free 纪律重建）——宿主注入 `flowExecutor`（同 runId 递归装配子引擎，
    spans 并入父 run 旁观/轨迹无缝），深度上限 3 + 祖先链防环引用；生成器词汇同步。
  - **flow_versions 版本化回滚**（Codebase Archaeologist）：迁移 1720000102000 建快照表；结构
    保存自动存档被覆盖旧结构（保留 20 版），`GET /workflows/:id/versions` + restore 端点
    （回滚前先存档当前——回滚可撤销）+ BFF 代理 + 画布「版本」面板。
  - **节点类型画像**（Analytics Reporter）：`GET /workflows/:id/analytics`——run_node_spans 按
    node_type 聚合执行数/失败率/平均/P95/tokens + 近 30 run 趋势；FlowRunsPanel 新增「节点画像」
    折叠表（哪类节点最贵最慢最易失败一眼可见）。
  - **校验错误画布高亮**（Frontend Developer）：保存时拓扑校验的问题节点经 `applyRunStates` 标红
    + 悬停错误文案（校验器错误本就带 node/edge 定位，差最后一步可视化）；子图折叠待立项。
  - **HITL 应答条对齐**（UX Researcher）：聊天详情页补齐悬浮副驾 F6 的内联应答条——SSE
    `custom:human_input` 清 sending + 末条 human_input 提示时常驻「流程在等待你的输入」条。
  - **诚实清单纠偏**（AppSec + Reality Checker）：workflow-engine.md 三处过时条目修正——Tool/
    Loop/conditionAgent/retriever 节点已随 D8 删除（唯一用户 JS 是已硬化的 CustomFunction），
    whileCondition 求值同样走 user-code-exec；前端 HITL 输入框早已存在。新语义 17 例测试 +
    gateway 全量 449 例全绿。

- **工作流优化轮 · 端到端收尾与挂账清偿（2026-10-04 第二轮）**：
  - **真机黑盒 e2e（16 断言全过）**：经 dev 网关全链路验证子流程/迭代并发/失败隔离/whileCondition/
    finalOutput/版本回滚/analytics；实弹逮出两处——`runs_status_chk` 约束缺新终态（迁移
    1720000103000 放宽 partial_success/budget_exceeded，否则终态 upsert 被拒、runs 永停 running）
    与循环体取项陷阱（body 单入边是 content 字符串，当前项须 `$flow.state.iterationItem` /
    `{{iterationItem}}` 取用——已写入 workflow-engine.md）。
  - **运行谱系（挂账 #12 清偿）**：runs 列表带出 `resumedFromRunId`（repo/路由/面板三处），
    FlowRunsPanel 续跑行缩进 + ↩ chip + 悬停溯源。
  - **大图导航纠偏（挂账 #7 收口）**：核实画布 MiniMap（可平移缩放）+ Controls 早已在位；
    子图折叠确需产品裁决（折叠态持久化/引擎语义），文档明示不立项。
  - **向量检索（挂账 #3 收口）**：混合检索已上线；pgvector 路径 = 替换 `historyRetriever` 实现，
    embedding 供给方属产品决策，文档明示 blocked-by-decision。

- **上下文管理 P1-P3 落地（2026-10-04 第四轮，调研驱动）** — 依据 `docs/context-management-research.md`：
  - **P1a 总预算分配制**：LLM 节点组装从「各块独立上限」升级为牺牲序预算
    （常驻不裁 → 丢检索历史【摘要块最先、避免大摘要饿死短消息】→ 头尾保真截断上游输入），
    对账账目 `contextBudget` 进 span；http 节点与内置 http_request 改保尾截断（判决在末尾）。
    测试逮出并修复两个预算器真 bug（摘要饿死、超限放行）。
  - **P1b 两级历史**：chats 滚动摘要（迁移 1720000104000：`context_summary` + 水位列；
    `lib/chat-context-summary.ts`：阈值 40 折叠、保近 20、仅 HTTP provider、fire-and-forget
    钩子挂 persistComplete/聊天流式落库）；`includeChatHistory` 升级「滚动摘要 + 近期原文」
    混合注入（检索器契约升级 `{summary, messages}`）；dsh 技巧全量应用——摘要指令作末条
    user 消息保 KV 前缀、五节 checkpoint、前次摘要合并不照抄。
  - **P2a flow 级上下文**：`flows.context_md`（迁移 1720000105000，flow_versions 同列）；
    画布「上下文」面板（textarea + 计数 + 保存）；运行时 `DAGENTS_FLOW_CONTEXT_CAP` 预裁
    后注入 LLM/Agent 节点 system 前部（直跑/聊天流式/@flow 三路径全接）；版本快照与
    回滚连带上下文（真机冒烟验证往返）。
  - **P2b 收编结论**：dagents 聊天无在途增长上下文（flow 每消息全新引擎态、CLI 单发
    自理、节点一次性上下文）——压缩面即滚动摘要，独立 compaction 无对象（文档明示）。
  - **P3**：persona 本体预算（`DAGENTS_PERSONA_CONTEXT_CAP`，技能侧原有三层护栏不动）；
    `/metrics` 新增 `dagents_llm_assembled_nodes_total/chars_total/over_budget_total`
    （按节点类型，span 对账驱动）。
  - **验证**：workflow 267 + gateway 449 + console 428 全绿；真机冒烟（context.md CRUD/
    版本回滚恢复上下文/新指标出数）通过；新测试 10 例（预算分配序 7 + 注入语义 3）。

- **e2e 收尾（2026-10-04 第三轮）**：全量 Playwright 套件 240 用例，10 失败全数归因清偿——
  ① `DAGENTS_DISABLE_LLM_FALLBACK=1` e2e 总闸（新）：CLI 降级会把 mock 的确定性失败变成真
  claude 慢成功（15s+ 且烧 token），闸门保 e2e 确定性、生产默认不受影响（README/CI 配方同步，
  另补 `DAGENTS_HTTP_ALLOW_PRIVATE` 本地网关配方提醒）；② spec-16 ×5 对齐广场一等页面 IA
  （commit 4470a3b 的 spec 漂移欠账：旧「从人格库启用」对话框选择器全部改写为
  `/agents?tab=plaza` 页面流）；③ 5 个环境敏感 spec（WF-04/OB-03/ED-07/MA-10/MA-14）在
  e2e 环境下复跑全过。运行谱系（`resumedFromRunId` 贯通 repo/路由/面板）随本轮落地。

- **稳定性专项（2026-10-04，十个方面全面加固）** — 从进程兜底到前端边界的一揽子稳定性机制：
  - **进程级异常兜底**：`index.ts` 挂 `unhandledRejection`（记日志 + error-sink，进程继续服务）与
    `uncaughtException`（受控走优雅停机链，boot sweep 下次启动兜底）——此前任何漏接的后台 rejection
    都会按新版 Node 默认语义直接杀死网关，连带全部在跑 run 与 CLI 子进程。
  - **启动依赖重试**：`initDb` 包上预算内退避重试（`DB_INIT_RETRY_MS` 默认 60s）——Postgres 慢半拍
    （compose 竞态/开机顺序）不再让网关当场退出等人工 restart。
  - **LLM HTTP 重试退避**（`lib/fetch-retry.ts`）：429/5xx/瞬时网络错误指数退避 + jitter 有限重试
    （`LLM_HTTP_RETRY_ATTEMPTS` 默认 3），尊重 `Retry-After`；外部取消立即中断不重试；chatStream 仅在
    产出第一字节前重试（已 yield 的增量无法撤回）。
  - **LLM provider 熔断 → CLI 降级**（`lib/llm-breaker.ts`）：按 provider 记连续瞬时失败，达阈值
    （`LLM_HTTP_BREAKER_THRESHOLD` 默认 3）熔断 `LLM_HTTP_BREAKER_COOLDOWN_MS`（默认 60s），期间与单次
    瞬时失败都降级本地 CLI（过程流留可见活动标记）；冷却后半开探测自动恢复；配置错误（401/404 等）
    诚实抛出不掩盖。
  - **run 并发闸**（`lib/run-gate.ts`，`DAGENTS_MAX_CONCURRENT_RUNS` 默认 8）：画布直跑 / chat @flow /
    chat 流式 / 断点续跑（resume + answer）五条执行路径统一准入，满载诚实 429（排队是「已启动却永远
    running」的谎言）。
  - **CLI spawn 闸**（`lib/cli-spawn-gate.ts`，`DAGENTS_MAX_CLI_PROCESSES` 默认 16）：工作流节点 / 聊天
    inline / agent 单发调用三处 spawn 点的 FIFO 总量护栏——并发 run × 分支并行不再打爆本机。
  - **可观测性**：`GET /metrics`（手写 Prometheus 文本格式注册表 `lib/metrics.ts`，零依赖——run
    启动/终态计数、CLI/run 闸水位、run-live 缓冲截断与条目驱逐、熔断器状态、执行/PTY 活跃水位、进程
    基础指标）；`GET /livez` 与 `/health` 探针分离（liveness=进程活着，readiness=DB 可用——本机单进程
    模式下 DB 断连更该「活着等回来」而不是杀实例丢执行）。
  - **DB 连接池显式调优**（`DB_POOL_MAX`/`DB_POOL_IDLE_MS`/`DB_POOL_CONNECT_TIMEOUT_MS`）：池耗尽/DB
    抖动时请求 5s 快速失败（→ 503 + 错误信封），不再无限挂起堆叠超时。
  - **console 错误边界**：`app/global-error.tsx`（最外层，自带 html/body，双语直排零全局依赖）+
    `app/error.tsx`（根路由段，i18n 可用）+ 可复用 `components/error-boundary.tsx`（画布已挂局部边界）——
    任何渲染抛错从「整页白屏」降级为「错误卡 + 周围照常」；样式入 `error-boundary.css`（棘轮/孤儿
    CSS 双护栏合规）。
  - **e2e 残留自动清扫**：`createSeedContext` 前置清 `e2e-mock-%` provider 行——中途强杀后的尸体在
    下一轮首个 spec 的 beforeAll 就被清掉，不再劫持「首个 active provider」语义。
  - **注册表水位可观测**：run-live 缓冲截断/条目驱逐从静默降级变为计数 + 每 run 一次 warn（调参信号：
    `DAGENTS_RUNLIVE_BUFFER_BYTES` / `DAGENTS_RUNLIVE_MAX_RUNS`）；shell 会话数进 metrics。
  - **测试**：六个新模块 38 例单测（重试分类学 / 熔断状态机含 half-open 探测失败重开 / FIFO 槽位移交 /
    诚实 429 / Prometheus 渲染含 label 转义与 collect 异常降级 / 启动重试预算语义）；gateway 全量 449
    例全绿。

- **运行轨迹视图（结果面板第三视图，参考 deepseek-harness Trajectory）** — 执行 trace 从「事后列表」升级为
  「时间轴上的轨迹」：
  - **数据层**：run-live 帧带服务端 `at` 时间戳（`run-live-registry` `emit()` 单点打点，truncated 回放标记除外；
    契约 `@dagents/contracts/run-live.ts` 可选字段，旧网关兼容）——直播与回放事件摆上同一面墙钟；历史运行
    复用 span events 既有的 `at`（2026-09-06 起）。
  - **投影层**：新纯函数模块 `console/lib/run-trace-model.ts`（19 单测）——直播帧（`createLiveTraceBuilder`）
    与 DB spans 快照（`buildTraceFromSpans`）两路收敛为同一 `RunTraceModel`；迭代重跑 = 同 lane 多 segment；
    sequence/duration/actual 三投影（无时间戳旧数据自动降级 sequence 并诚实提示）；框选命中集
    `timelineFocusIndexes`。
  - **视图**：`canvas-trace-view.tsx` + `canvas-trace.css`——节点泳道甘特（拖拽框选过滤台账 / 滚轮缩放 /
    右键平移复位 / hover 起止·时长·状态 / 运行段随秒级 tick 延伸、时长显示 `—` 不造假）+ 事件台账
    （running/failed 状态驱动自动展开，手动开关优先）+ Inspector 覆盖层（节点概览/输入/输出/用量 + 事件
    全文，拖宽可调双击复位）；`use-run-live` 同一流解析喂双 builder（终端段 + 轨迹模型）；轨迹 tab 激活时
    结果面板加宽（480→760px）。零新依赖（交互语法照搬 dsh，视觉走既有 tokens，暗色自动适配）。
  - **测试**：单测 19 例（含「同一执行两路数据源产出等价模型」一致性钉子）；e2e 新 spec 24（甘特/台账/
    Inspector/无时间戳降级四景）；顺手修正存量过期用例 OT-02a（`.rti-done` 已于 2026-09-20 裁决移除，
    spec 未同步——改为断言结束态无底栏 + 标题行重跑）。

- **终端双锚点全家桶（P0/P1/P2/P4）** — 设计 `docs/design-terminal-anchors.md` 剩余四项落地：
  - **P0 运行→目录数据链**：runs 表新增 `directory_id`（迁移 1720000097000），四个写入点
    （画布直跑/异步先行行/chat 继承/续跑回流）与两个读点（GET /runs、node-spans）全线打通；
    断点续跑的 `originalDirectoryId()` 收口改读列（原 envelope 读取是无写入方的假设）。
  - **P1 三入口**：失败运行的「在项目目录打开终端」直达 —— FlowRunsPanel 失败行「终端」按钮、
    画布失败摘要按钮、Chat 错误卡按钮；href 单源 `terminalHrefForDir`（一扇门原则）；解析不到
    目录不渲染（不回落主目录）。
  - **P2 多标签终端**：tab 条（切换/× 关闭/+ 同目录新开）+ tabs 持久化；决策层重写为
    `planTabsBoot`/`planOpenDir`（同目录复用 tab、活动 tab attach/recreate、旧版单会话 key 迁移）；
    「入口爆炸后杀旧建新」的取舍就此消解。
  - **P4 交互式 agent 会话**：终端承载 agent —— registry 支持按命令 spawn（`agt_` 会话 +
    kind/label 贯穿契约），Agent 详情「交互式会话」经 `/terminal?agent=` 深链直达，人格经
    `--system-prompt` 注入 claude（v1 唯一支持档，其余 kind 诚实 400 不裸启冒充）。
- **运行实时终端（live attach）** — 画布终端视图从 700ms 轮询策展快照升级为
  SSE 实时帧流：引擎钩子（`onNodeStart/End/Delta`，含插话 user_input 回显）在
  `assembleWorkflowEngine` 单一收口旁路进进程内 `run-live-registry`（per-run
  帧缓冲，512KB 环形截断 + truncated 标记），`GET /api/v1/workflows/runs/:runId/live`
  晚订阅者经 `hello.replay` 拿全量前缀再追直播，run settle 发 `runEnd` 关流
  （三入口显式 finish，清扫器对漏报/网关重启兜底收敛）。断点续跑/HumanInput
  应答同 runId 重开条目，replay 里的 runEnd 成为阶段边界。协议契约
  `@dagents/contracts/run-live.ts`（shell.ts 姊妹篇）；404 时 console 诚实回退
  node-spans 轮询渲染（DB 路径永远在）。设计：`docs/design-terminal-anchors.md` P3。

- **Browser terminal (`/terminal`)** — a real shell in the console, not an
  agent relaying commands: the gateway spawns the user's `$SHELL` on a true
  PTY (`node-pty`), streams raw terminal bytes to `xterm.js` over SSE
  (base64 frames), and pipes keystrokes back to PTY stdin. Native prompt,
  colors, interactive programs (`top`/`vim`), `Ctrl-C` — everything behaves
  like the local terminal. Sessions survive page refresh (replay buffer +
  reconnect by stored session id; orphaned sessions are recycled after
  10 min with no subscriber). Nav entry「终端」; kill switch
  `DAGENTS_SHELL_DISABLED=1`, caps via `DAGENTS_SHELL_MAX_SESSIONS` /
  `DAGENTS_SHELL_ORPHAN_MS`. Note: pnpm unpacks node-pty's prebuilt
  `spawn-helper` without the exec bit — the gateway self-heals it at
  startup (chmod), and `pnpm-workspace.yaml` allows its build script.
- **Terminal × project directories** — the terminal grows into the
  workbench instead of a standalone toy: a header directory picker
  (home / registered project dirs / OS-native browse to register a new
  one) opens the next session directly in that project, remembers the
  preference per browser, and never disturbs a live session that is
  already in the target directory. The ⌘K command palette gained a
  「终端」jump via the shared NAV model.

### Fixed

- **AI 生成工作流节点互相叠放**：LLM 坐标本就不可信（分叉挤同一 y、直接叠放、无视
  间距要求——历史 prompt 的 "~250px" 软约束连一个节点宽度 280px 都放不下），归一化
  又只在缺 position 时兜 grid，数字型重叠坐标原样透传画布。修复为成功产物一律按图
  拓扑确定性重排：`@dagents/workflow` 新增 `applyAutoLayout`（最长路径分层 + 层内
  BFS 序 + 垂直居中对齐父节点均值，步长 360×150 与节点物理尺寸匹配，环输入不悬挂），
  `generateFlow` 成功出口统一收口（chat 与 canvas 两入口同时生效）；验收不变量
  「任意两节点横向 ≥360 或纵向 ≥150 错开」进单测。prompt 措辞同步改为「坐标仅占位」。
- **断点续跑认领互斥三处漏洞**（架构审计轮）：① resume 路由认领后、起跑前的
  失败路径（flow 404 / 拓扑 422 / 种子组装抛错）泄漏进程内认领 —— 该 checkpoint
  从此 409 直到网关重启；修复为只读校验前置到认领之前 + 失败显式释放。
  ② `startWorkflowExecution` 同步装配段（坏 flowData 等）够不到 execute 的
  finally，同样泄漏认领 —— 拆 inner 函数 try/catch 兜底。③ `/runs/:id/answer`
  此前完全不认领，并发两发应答会各自起跑同 runId；chat 消息回流路径
  （`answerAwaitingRunForChat`）同步补认领，认领失败回落正常聊天路由。
- **run-live 收口路径**：`finish()` 幂等化（重复收口不重发 runEnd）；@flow
  触发的运行（此前把 live 丢给解构）与 chat 流式异常路径（live 不在 catch
  作用域）现在都显式关流 —— 画布旁观者不再靠 2 分钟 idle 兜底才发现结束。

### Changed

- **设计走查轮五**（异常态审计）：用路由拦截把各视图数据 API 打成 500 /
  慢网，审计错误态与加载态 —— ① 核心修复：`unwrapEnvelope` 非 2xx 时此前
  把原始 body 整段塞进错误消息，用户看到 `{"success":false,…}` 这样的 JSON
  转储（agents / skills 等列表页实测命中）；现解析信封只取 `error` 字段，
  BFF transformError 包裹的上游原因（`detail`）递归解一层，非 JSON 错误页
  保留文本摘要，`(status)` 契约不变 —— 一处修复全站错误横幅受益。
  ② 加载骨架屏（agents 列表）与 flows 居中错误态 + 重试钮实测质量良好，
  无需改动。③ 新增 2 个 api 契约测试钉住人话化格式。

- **设计走查轮四**（令牌对比度审计 / 品牌细节）：① WCAG 对比度全量审计 ——
  解析浅/深两套令牌、按实际使用配对（含半透明 soft 底合成）计算对比度：
  新增状态色「文字档」`--success-text` / `--warn-text` / `--danger-text`
  （基础档在浅色表面作正文仅 2.03-3.81:1，文字场景 78 处全部切到文字档，
  保色相压明度后 ≥4.5:1；填充场景——圆点/进度条/徽章底——继续用基础档，
  深色下文字档别名基础档）；`--meta` 浅色 #85858b→#6c6c71、深色
  #7f7f86→#88888f（辅助文字此前 3.1-4.0:1 不达标）；`--accent` 浅色
  #6c5ce7→#6859de（品牌紫压暗 3.7%，卡片上文字 4.46→4.5+，按钮白字
  4.86→5.17，视觉不可感）。② 品牌一致性：命令面板页脚「DAgent」→
  「Dagents」；新增 `src/app/icon.svg` favicon（此前浏览器 tab 无站点图标，
  无 public 目录与 icon 约定文件）。③ reduced-motion 全局兜底与深色令牌
  全量通过（40/40 配对）。

- **设计走查轮三**（动效可访问性 / 对话框与设置子页 / 窄视口）：① 全局
  `prefers-reduced-motion` 兜底 —— 此前全仓 74 处 animation + 134 处
  transition 中只有 5 个组件文件自带减弱动效覆盖，其余对开启「减弱动态」
  的用户照播不误；现于 shell.css 基础层统一压平时长（入场动画瞬间到终态、
  spinner 停为静态、平滑滚动改即达），个别组件自己的 reduce 覆盖继续生效；
  已用 Playwright reduce 仿真实证入场元素不被钉在透明态。② 走查覆盖生成
  对话框 / 运行对话框 / 新建 Agent / 设置外观·用量·审计子页 / 1280 窄视口
  —— 三轮修复后未再发现新视觉缺陷；focus-visible 体系（全局 `:focus-ring`
  + 组件级细化）确认健康。

- **设计走查轮二**（详情页 / 交互态 / CSS 补盲）：① composer 底栏重叠修复 ——
  悬浮 chat 窄面板下 FlowSelector 芯片与「⏎ 发送」提示文本互相叠压：trailing
  区从 `flex: none` 改为可收缩、提示文本省略号化、选择器芯片对齐
  flow-selector 的收缩规范（`min-width: 0` + span ellipsis，含组件包裹层）；
  宽面板视觉不变。② CSS 硬编码色补盲扫描（上轮只查了 TSX）：清除错误令牌名
  `var(--warn-border)`（从未定义，靠回退值蒙对便签色 → `var(--note-border)`）、
  死回退值（`--note-*`/`--success` 旁的过时色值）、模板实例化输入框未定义
  `--bg-elev`（浅色模式深底深字 → `--surface-warm`）；claude/codex 品牌色相
  收敛单源为 `--glyph-claude` / `--glyph-codex`（此前 agents.css 与
  agent-detail.css 各持一份字面值）。hover-card 的常暗设计有文档说明，保留。

- **架构优化轮二**：① `listFlows` 不再逐行拖全量 `flow_data` JSONB —— 完整
  画布文档单份可达数十 KB，此前工作流列表每次加载都把 N 份文档拽进 gateway
  仅为数节点数然后丢弃；节点数现于 SQL 侧计算（`jsonb_array_length` +
  `jsonb_typeof` 守卫，语义与原实现一致），HTTP 响应字节级不变。② resume /
  answer 路径的 runs 行落库从裸 SQL 收敛到 `persistWorkflowRunRow`（补
  `resumedFromRunId` 参数 + COALESCE 冲突更新）—— 消除 runs 表结构知识的
  第二份副本；`runAndPersist` 与 `startWorkflowExecution` 的整体收敛继续
  留档（同步响应 vs 纯异步、INSERT vs UPSERT、Langfuse/spans 差异是实质性
  语义，无专属 e2e 回归不合并）。③ fleet 仪表 finished_at 窗口索引
  （迁移 1720000099000）：`runs (finished_at DESC) INCLUDE (cost)` 部分覆盖
  索引 + `dispatch_tasks (finished_at DESC)` 部分索引 —— 资源仪表盘 UI
  轮询的吞吐/成本滚动查询从全表扫变 Index Only Scan（EXPLAIN 实证）。

- **设计走查轮**：机械审计（i18n / 硬编码色 / inline 棘轮 / 可访问性）+ 浅色/深色
  双主题浏览器逐页走查，修复 —— ① 画布小地图（React Flow minimap）此前白底
  不跟主题令牌：深色下死白、浅色下与画布无边界，现走 `--surface` /
  `--border-strong`；② flow 列表头像取字跳过前导标点（「【验收演示】…」头像
  从悬置的「【」变为「验」）；③ 11 个真实缺译词条补齐（无/今天/已保存/预览/
  图标/分类/内容/准备中/收尾中/正在执行/产出 —— 此前英文模式回退显示中文，
  缺译扫描测试因此处于红态）；④ daemon 注册对话框关闭钮补 `aria-label`；
  ⑤ create-agent 表单提示的 inline 色（含过时回退值 `#b45309`）正式化为
  `.field-hint` / `.field-hint-warn` 类；⑥ 新增 `.ic-16` 图标定寸工具类，
  inline 样式棘轮 267 → **265**（只降不升）。

- **热点查询索引补课 + 冗余索引清理**（迁移 1720000098000）：随 runs /
  dispatch_tasks / chats 线性增长此前全表扫的高频路径补齐 ——
  `dispatch_tasks(agent_daemon_id, created_at DESC)`（agents 目录页逐行
  LATERAL 探测 + 最近任务）、`runs(pipeline_id, created_at DESC)`（运行历史 /
  workflows 页徽标批量汇总）、`runs(created_at DESC)`（默认运行列表）、
  `chats(updated_at DESC)`（全局会话列表，chats 永不清理）、
  `runs(agent_daemon_calls) GIN jsonb_path_ops`（agent 详情 / fleet 仪表
  JSONB 包含查询）；同时删除被同列唯一索引完全遮蔽的
  `idx_run_node_spans_run_node` —— span-writer 每秒级 upsert 的最热写表
  停付双倍索引维护。

## [0.2.0] - 2026-09-04

Workflow-first, and execution you can watch.

### Changed

- **Workflow-First IA reversal** — `/` is now the Flows workbench (flow cards
  with run history, template gallery entry, one-line generator); chat demoted
  to a global floating copilot (draggable, position memory) present on every
  page. New app navigation (Workflows / Agents / Skills / Daemons +
  project-scoped chat tree). Rollback via `localStorage dagents.ia.workflow-first=off`.
- **One home per run: the canvas** — the old flow detail page is retired;
  starting a run lands on the canvas spectator view (`?run=<id>`), same entry
  as run-history rows and chat execution records. Sidebar template tab and
  standalone `/runs` page removed (history lives in each flow's card).
- **No wall-clock cap on CLI agents** — replaced by an inactivity watchdog
  (default 5 min, reset on every output line); long autonomous runs are the
  norm, a hard 180s cap was truncating real 4-agent parallel runs into false
  successes. Timeouts/cancellations now fail honestly with usage attached.
- List-page runs are async (`?async=1`) with a run-input dialog and
  project-directory selector — the button responds instantly instead of
  blocking for minutes.

### Added

- **Streaming node output** — LLM/Agent nodes stream text as they generate
  (live tail in the run panel, canvas badges flip in real time, edges light
  up); runs are no longer a black box until completion.
- **Activity stream while running** — CLI thinking (💭) and tool calls (🔧)
  surface as a live timeline per node, and are preserved in the final output
  for post-run replay ("dropping it on completion drops how the work was done").
- **Team-scenario templates expanded** — 9 multi-agent templates covering all
  10 documented agency-agents workflows (org-wide parallel discovery 8-way
  fan-out, landing-page sprint, book-chapter drafting…), with first-run input
  guidance (`inputHint`/`inputExample`) on start nodes.
- Template instantiation flow: structural preview in the confirm step,
  parameter defaults visible, per-node instruction audit.
- README demo GIF (17s canvas run) and a `docs/launch/` kit.

### Fixed

- **Engine: N-into-1 merge contract** — `mergeInputs` now concatenates
  `content`; downstream LLM/PlatformAgent nodes previously lost N-1 upstream
  outputs to shallow-merge overwrite (e2e WF-09 regression-pinned).
- **Engine: empty-output guard** — LLM/PlatformAgent nodes with empty bodies
  fail honestly instead of fake-succeeding (WF-10/11).
- Iteration/Loop final-state spans now report true whole-run duration and
  `completedIterations` (six previously failing e2e cases green).
- Gateway test suite isolated to an auto-provisioned `dagents_gw_test`
  database — running tests no longer wipes real run history from the dev DB.
- Canvas UI: run-button hover invisibility, checklist button overlaying
  dialogs, Esc/outside-click closes the run-input panel, MUI dropdown
  key-spread warning.

## [0.1.0] - 2026-08-22

First public release.

### Added

- **Chat-First console** (Next.js) — chat home + detail pages, agents / flows /
  daemons / settings / directories / skills pages, bilingual UI (Chinese +
  English, natural-key i18n with fallback).
- **Gateway** (Hono, :8080) — SSO/API-key auth, chats & chat-execution with
  `@workflow` / `@agent` mentions, workflow CRUD + runs with SSE streaming,
  dispatch protocol routes (daemon register/heartbeat/claim/complete), LLM
  provider CRUD with dynamic AES-256-GCM-encrypted proxying.
- **Workflow engine** (`@dagents/workflow`) — 14 node types, DAG executor with
  parallel waves / condition routing / loops / iteration, variable resolution,
  human-in-the-loop, sub-flow execution, Langfuse trace export.
- **Workflow canvas** — React Flow editor at `/workflows/[id]/canvas`
  (vendored from Flowise Agentflow, Apache-2.0).
- **CLI-first execution** — 17 CLI agent adapters (claude, codex, qwen, copilot,
  opencode, codebuddy, cursor, deveco, antigravity, openclaw, pi, hermes, kimi,
  kiro, grok, qoder, traecli); workflows and chat run with zero LLM-provider
  configuration, HTTP providers optional.
- **Skills registry** — filesystem-based skill discovery (`~/.agents/skills`),
  console-managed roots, system-prompt injection into chat and workflow agents.
- **Agent personality library** — mount agency-agents-style libraries
  (270+ personas), enable-on-demand compilation with slim tiers, upstream drift
  sync + reimport, 6 team-scenario templates.
- **Flow template center** — built-in templates, canvas "save as template",
  personaName re-binding with LLM-node degradation for missing personas.
- **Daemon** (`@dagents/daemon`) — pull-based remote execution loop with
  graceful drain.
- **Observability** — OTel tracing with `run_id` threading end-to-end,
  optional Langfuse v2 profile via `docker compose --profile obs up`.
- **Deployment** — single `docker compose up` full stack (Postgres + gateway +
  console, migrations automatic), localhost-only port binding by default.
- **Testing** — per-package Vitest suites, Playwright e2e against a
  OpenAI-compatible mock LLM provider (55+ execution-state cases).

### Security

- SSRF hardening on the LLM proxy (absolute-URL hijack + key exfiltration
  blocked); `/internal` and dispatch non-protocol routes gated by
  `GATEWAY_API_KEY`; WebSocket upgrades validate token + Origin; HTTP nodes
  enforce scheme allowlist, 15s timeout, 32KB truncation (2026-08-16 audit).

---

# 开发流水账（Dev Log）

> 2026-09-17 从 AGENTS.md「架构要点」拆出的带日期功能/修复记录，按时间倒序。条目描述「落地当时」的事实，后续演进由更晚条目覆盖，不回改。操作事实见 `AGENTS.md`，架构现状见 `docs/ARCHITECTURE.md`。

## 2026-09-08

- **可操作终端（PRD `docs/prd-operable-terminal.md`，用户四项裁决）**：终端视图从旁观窗升级为操作台（bash 四动词「看/停」已有，「说/再来」补齐）——①**运行中插话**：`POST /api/v1/workflows/runs/:runId/message`（nodeId+text）→ execution-registry `ExecutionHandle.sendToNode`（abort 的姊妹控制动词，同步回执 sent/unsupported/not_running）→ workflow-clients 汇点表（`runId:nodeId → 活 CLI 会话`；节点经 `llmClient.chat` 新参数 `nodeId` 上报，llm/platformAgent 节点传 `nodeData.id`；PlatformAgent 工具循环每轮新建会话按 nodeId 覆盖注册、same-sink 守卫防误删）→ contracts `AgentSession.send?` → claude 适配器 `--input-format stream-json`（prompt JSON 帧首帧化 + stdin 常开 + `session.send(text)` 写帧）。**claude 终态语义改静默判定**：openTurns 计数（stdin user 帧开 turn、result 帧关 turn，is_error 即终局），归零才 end stdin——进程在 result 后活着等下一帧是 stream-input 协议行为，不主动收尾运行永不结束；中间 result 的 completed status 抑制（turn 边界非终局）。插话是「排队补话」语义（下一 turn 消化，最终 output = 最后 turn 的 result，不承诺打断）。`user_input` 新 activity kind 经节点 onDelta 通道回写，span-writer 即时落库（不等 5s events 慢节拍）进 events/activity 双通道，终端渲染 `❯` accent 高亮行（回放审计「谁在何时对哪个节点说了什么」）。console `TerminalInputBar` 钉终端视图底部：`❯` 提示行 + 多 running 节点目标 select + 诚实三态回执 + 结束态原位变「重跑」入口；chat ProcessFold 不加（聊天输入框即其 stdin 行）。逃生门 `DAGENTS_CLAUDE_INPUT_FORMAT=text` 回退旧一次性 stdin；逐适配器放行（codex exec 一次性不支持 → 如实禁用）。②**重跑闭环（⬆ 等价物）**：运行输入按 flowId 记忆（`dagents.canvas.runInput.<flowId>`，画布运行面板与 FlowRunDialog 共键，打开预填、提交即记）；gateway runs 列表新增 `input` 全文字段（8k 保险丝——inputPreview 80 字只够展示）；FlowRunsPanel 历史行「重跑」按钮 → 预填对话框（输入可再编辑，⌘⏎ 已有）。③ BFF `/api/workflows/runs/[runId]/message` 透传 + node-spans 端点增 `inputSupported`（无 CLI 汇点 → stdin 行禁用态给原因，HTTP provider 运行如实不可插话；chat @flow 运行经 registry byRun 次键同样可插话）。**顺手修存量地雷**：canvas 页面图把 @dagents/workflow dist 拉进浏览器包撞上 user-code-exec.ts 的 worker_threads 静态 import（9-06 批次落地、此前无新编译未暴露，canvas 全页 500）——双路置空：next.config webpack resolve.fallback（next build/裸 dev 走 webpack）+ turbopack resolveAlias 指空模块替身 src/stubs/worker-threads-stub.js（dev 脚本 --turbopack 忽略 webpack() 配置，首次重启只修了一路、console 仍 500 即此因）。测试：adapter lifecycle 18 用例（stream-input 四例：argv 断言/静默判定收尾/插话时序（turn1 进行中 send → R2）/text 回退）、gateway message 路由 6 + span-writer user_input 快节拍 2、console format 2；e2e 23 号 spec OT-01~04（重跑全旅程/stdin 结束态/禁用态/BFF 409）；真机 claude 冒烟通过（stream-json 输入被本机 CLI 接受 + 静默收尾）。C 接龙（跨 run 管道）缓议未做。**turn 分隔符（同日真机复跑补钉）**：插话把节点产出拆成多 turn，adapter 在中间 result 帧发显式 `turn-boundary` status（completed 仍只留终局一个），CLI client（chat/chatStream 两路）收到即正文补 `\n\n` 分隔 + 过程流记「── 插话已并入，开始新的 turn ──」——修「40我此刻」粘连；gateway workflow-clients-cli.test.ts 2 用例（可编程后端桩）+ lifecycle 插话用例断言边界事件；真机复跑验证 `40\n\n我收到了…`。另：用户报的「正文空行」经查证为粘贴到富文本编辑器的段落化效果——数据 0 个双换行、页面 pre-wrap 渲染截图核实无空行，非产品缺陷。

## 2026-09-06

- **运行终端视图 + 采集端全量保真（PRD `docs/prd-run-terminal.md`）**：CLI Agent 的运行结果以终端形式展现，数据先行 —— ①数据层（保真契约「采集层保全文，展示层做策展」）：`IStreamDelta` activity kinds 扩至 thinking/tool/tool_result/status/log/error，CLI client（workflow-clients `forwardActivityDelta`）全事件转发零截断（此前 toolLabel 截 60 字 + thinking 落库前截 100 字 + tool-result/status/log 整体丢弃）；span-writer 双通道 —— `events` 全量过程日志（终端/回放唯一保真数据源，保险丝：单条 64KB / 800 条 / 总量 ~1MB 丢最旧保近因）+ `activity` 12 条环降级为面板策展缓存（summary ≤80 字是展示派生物），落库双节拍（text 1s / events 5s 同刷），终态合并保留。②console：`run-terminal.tsx` 的 `RunTerminal`（段头分隔线 + `$` 提示行 + 统一 Icon 事件行 + 正文全文直出 + streaming 光标 + 段级复制）挂进画布结果面板「摘要/终端」切换（`dagents.canvas.resultView` 记忆，摘要保持默认）；`TerminalSurface`（滚动跟随/上翻暂停/回到底部）被 chat ProcessFold 复用收敛（顺手补 48vh max-height，长过程不再无限撑高聊天流；ToolCallCard 含 diff 保留为终端内富卡片）。用户裁决：切换式不替换默认、全部保真、含 chat 收敛、采集端截断拿掉。明确不做 xterm.js/ANSI（结构化事件流非 pty 字节流，DOM 行渲染）。旧运行无 events，终端视图降级显示 activity 环摘要级内容。**长输出「查看全文」（同日设计师裁决）**：结果面板的输出块被 max-height 小滚动框困住 —— 新共享组件 `result-viewer.tsx`（`ResultViewer` 包装块 + maximize 角标悬浮露出 → 全屏模态：完整未截断正文/JSON + 复制 + Esc/点背景关闭，portal 到 body）；摘要视图四块（正文/产出 JSON/输入/原始数据，模态给全量 stringify 而非 500/900 截断版）与终端视图（成品正文/裸 JSON/事件详情行）全部接入。**图标统一（同日设计师验收追加裁决）**：功能位 emoji 文本标记全部废除（💭🔧↳✗⚡🤖✨⚠ 及 chat 工具卡 🔍✏️💻），统一 `@/components/icon` stroke 体系 —— Icon 集新增 wrench/cornerDownRight/point/sparkles；语义映射三处共用：`lineIcon`（终端）/`activityIcon`（画布摘要活动流）/`CATEGORY_ICON`（ToolCallCard）；`CATEGORY_GLYPH` emoji 表已删；产品约定「Icon 包装 span 不约束 svg，逐面 `.wrapper svg {width;height}` 定尺寸」照抄（run-terminal.css/tool-call.css/canvas.css/workflow-run-card.css/flows.css 五处补规则）；人格库角色头像 emoji 是数据内容不属 UI chrome，保留。
- **单机还债批次（架构师盘点 → 用户裁决「除用户相关外全修」）**：①**dispatch/daemon 远程任务取消**（spec §7 Deferred 补齐）：迁移 `1720000094000` 给 dispatch_tasks 加 `cancel_requested_at`；`cancelDispatchTask`（queued/claimed 直接落终态 failed/'cancelled'，running 打标记）+ `POST /tasks/:id/cancel`（daemon 协议面，白名单已加）；daemon 执行环 2s 轮询 cancelRequested → AbortController 注入 execOptions.signal → 子进程 SIGTERM/SIGKILL → failTask('cancelled')；chat/run 取消端点级联名下非终态任务；**@daemon 命令现落真实 runs 行（path='direct'）**——取消可级联、boot 清扫可收敛、usage rollup 不再跳过。②**CustomFunction worker 硬化**：`user-code-exec.ts` worker_threads 执行（超时强杀默认 5s `CUSTOM_FN_TIMEOUT_MS`、AbortSignal 贯穿、危险全局形参遮蔽）——死循环只死节点不再冻住 gateway；**是隔离不是沙箱**（constructor 逃逸拦不住，多用户前换 isolated-vm；Tool/Loop condition 仍同步）。③**执行轨迹 retention**：`retention.ts` boot+每日清 runs/run_node_spans/dispatch 轨迹（`DAGENTS_RETENTION_DAYS` 默认 90，0 关闭；聊天内容/flow 配置永不清）。④**HumanInput boot 孤儿标记**：`markOrphanedHumanInputs` 把「聊天最后一条是 human_input 提示」的会话补中断说明（挂起 Promise 恢复=持久化 DAG 执行态，单机不立项）。⑤**备份**：`scripts/backup.sh`（pg_dump -Fc + ~/.agents tar，保留 db30/fs10 份，实跑验证过）。⑥**Workflow-First 回滚双壳退役**：`ia-flag`/`ChatHome`/`ChatNavSidebar` 删除，`/` 恒 FlowsView，FloatingChat 只在聊天详情隐藏；e2e IA-04 已删。⑦**dev/build 互踩工程化**：turbo `test` 改 `dependsOn: ^build`（pnpm test 不再建 console 的 .next）；`next.config` 支持 `NEXT_DIST_DIR`（`build:isolated` 写 .next-build 不碰 dev）；根 build/test/typecheck 挂 `scripts/guard-build.mjs`（dev 在跑出警告+出路，`DAGENTS_SKIP_GUARD=1` 跳过，CI 零打扰）。⑧ e2e 兜底：seed dispose 自动清 `e2e-mock-%` provider 残留；**终端视图 e2e**（22 号 spec，RT-01~03：全量事件流/查看全文/旧运行「早于全量采集」提示——派生层新增 `lineSource` 如实标注数据来源）。**明示不做**：多实例（单机单进程成立）、认证多用户（用户裁决排除）。适配器真机回归仍欠（本机无 codex/qwen/codebuddy/copilot CLI，无法跑）。
- **画布布局自动保存（架构师裁决）**：此前节点坐标/视口虽在文档模型里（serialize 写 `position:{x,y}`+viewport），但**只有显式「保存」才落库** —— 拖完布局刷新即回退。现在布局走独立静默管线：FlowEditor 在拖拽停/视口停后 debounce 800ms 调 `onLayoutPersist`（position 逐帧变更合并到停手后一拍；readOnly 跳过），CanvasKitPage 静默 fire-and-forget `PUT /api/workflows/:id/layout`（BFF 透传），gateway 服务端 merge —— 只更新 flow_data 里**已存在节点**的 position（取整）与顶层 viewport，未知 id 静默忽略，节点配置一字不动；布局无语义价值不进审计日志。脏标记语义不变：布局自动保存不翻脏、不清脏（未保存的配置编辑仍是草稿，全量保存管线原样）；全量自动保存被否（违背「尊重草稿自由」，会把半配置节点静默落库）。e2e `20-canvas-layout-autosave.spec.ts`（CV-LAY-01~03）真实 CDP 拖拽钉全链路 —— IAB webview 的合成输入驱动不了 RF 的 d3-drag 层（连 cua.click 都选不中节点），画布拖拽类交互验证一律走 playwright。
- **`{{$start.input}}` 别名修复（review 发现的存量引擎 bug）**：executor 此前只把 Start 输出挂在节点 id 键下，resolveAlias 的 `state.start.content` 永远落空（画布运行面板文案宣传的语法实际失效，condition 里写它恒走 False）——Start 节点输出现额外登记 `state.start`（executor.ts，回归测试双向钉住）。

## 2026-09-05

- **Canvas Kit 上线 / vendor/agentflow 整体退役**：Workflow 画布编辑器 `/workflows/[id]/canvas` 改用**自研 Canvas Kit `apps/console/src/components/flow-canvas/`**；vendor/agentflow（Flowise fork）整体删除——含 MUI/emotion/tiptap 依赖树、`/api/flowise/*` BFF 与 `convertToFlowiseFormat` 形状税。架构与实施记录见 `docs/canvas-replacement-architecture.md`。
- **画布 Canvas Kit**：`@xyflow/react` v12 单运行时依赖；`model/normalize` 读写规范化（读宽容三类存量形状、写统一扁平规范形，golden 测试钉往返）；registry 从 `CANVAS_NODES` 派生 NodeSpec（图标/选项源 console 侧注入：agentId→平台 agents、model→providers+agents）；连线环检测（图环不允许，循环走 Iteration 锚点）；`FlowEditorHandle` 命令式 API；运行态单向注入（节点徽章 + 边状态由 nodeStates 派生，不进文档不落库）。已知防御：Turbopack 不解析 `.js`→`.tsx` 后缀映射（kit 内部 import 无后缀）；RF v12 的 RO→updateNodeInternals 回路在 IAB webview 不触发，FlowEditor 有测量加固。
- **节点体系 D8 精简（CLI-Agent 核心）**：15→9 类（start / platformAgent（展示名 Agent (CLI)）/ llm / directReply / condition / iteration / humanInput / http / customFunction）。agent/tool/conditionAgent/loop/executeFlow/retriever 六类连同引擎 handler、`flowExecutor`/`historyRetriever` 宿主注入、executor loop 分支一并删除（用户裁决：无真实用户、零兼容包袱）；生成器别名 `agent→llm`、`loop→iteration`、`conditionagent→condition`。`validateFlowTopology` 的 KNOWN_NODE_TYPES 随 allNodes() 自动收敛。
- **生成器 BFF 迁移**：`POST /api/flow-generator` 纯透传 gateway canonical（旧 `/api/flowise/api/v1/agentflowv2-generator` 的 vendor 形状转换层已删）；`generate-flow-dialog` 消费 canonical；模型/Agent 下拉由 Canvas Kit 的 option-providers 聚合 `/api/llm-providers` + `/api/agents`。

## 2026-08-31

- **团队场景模板扩至 agency-agents 全量**（隶属 2026-08-19 人格库条目的 Phase 3）：`GET/POST /api/v1/agent-library/team-templates*`，9 个多 Agent 模板覆盖 agency-agents 全部 10 条文档化工作流（README Scenario 1~6 + examples/ 的落地页冲刺、全机构并行发现 8 路 fan-out、书籍章节起草；startup-mvp 按 examples 版增强为 7 人格并行发现头，with-memory 变体不立项——边数据流已天然取代其 copy-paste 交接）。按人格 name 解析成员 → 复用/自动启用 → 生成 draft flow（start 节点带 inputHint/inputExample 运行输入引导，画布/列表运行面板与确认步透出）。形态三选 `linear` / `fan-out` / `parallel-head`（前 N 步从 Start 并行扇出、汇入顺序尾，吃 N 进 1 合并契约）（注意：teams 路由须在 `/:division/:slug` 前注册）。

## 2026-08-30

- **运行中活动流**：真实复跑发现 PlatformAgent 节点 running 期间 output 恒空 —— 根因是 CLI agent 干活的大头在 thinking 和工具调用，text 事件要到收尾才出现，此前的 delta 通道只转发 text（旁观端全程「（执行中…）」黑盒）。修复：onNodeDelta 载荷结构化 IStreamDelta（text 正文增量 | activity 过程活动），CLI client 把 thinking（截 100 字）与 tool-use（工具名+参数摘要 60 字）作为 activity 发射，span-writer 按节点维护 text 缓冲 + activity 环形队列（最近 12 条），节流落 {text, content, activity}；画布结果面板运行中行渲染 💭/🔧 时间线（最近 6 条，mono 小字）+ live 正文，摘要行无正文时显示最近活动。**活动流随终态保留**（onNodeEnd 把 activity 并入最终 output —— 过程回放有审计价值，用户裁决「跑完即丢等于丢掉它是怎么干的」）。线上探针验证：running 期间 acts≥1（thinking 可见）、终态 text+acts 并存。
- **详情页退役 —— 一次运行一个家 = 画布旁观（三方协商：PM/设计师/资深用户）**：原列表内详情页（.flow-detail-page，DAG 缩略 + inspector）与画布旁观 80% 功能重叠且入口不对称（详情页唯一入口是发起运行后自动落地，返回即不可回访），用户分不清两个视图。定稿收敛：发起运行（列表「开始运行」后）直接 router.push 画布旁观 ?run=，与卡片运行历史行、chat 执行记录入口完全一致。删除面：flows-view 详情状态/effects/JSX/NodeInspector/FlowOverview/mapFlowDetail/hash 深链（#flow=&run= 通道随之退役）、flow-dag.tsx 组件、shell.css 详情专属规则 —— flows-view 从 1343 行减到 635 行。轻量瞄状态由卡片 FlowRunsPanel 行承担。e2e：WF-12/UI-01 改 waitForURL 断言（dev 冷编译放宽 15s），UI-02 重写为画布旁观渲染断言，flows-detail 单测文件删除。
- **运行历史进 flow 卡片（用户裁决）**：/runs 独立页与导航 tab 已删（与模板同理：历史属于 flow 自己的上下文）。列表卡片展开区的静态「暂无运行记录」提示行换为 **`FlowRunsPanel`**（`/api/runs?flowId=` 数据源不变）：紧凑行（状态点+状态文本/触发源 chip/起止/耗时/输入预览/失败摘要/画布旁观直链），空历史才显示提示；发起运行成功即 bump 刷新（新 run 立即可见），存在 running 行时 3s 轻轮询到终态。gateway `runs.ts` 顺手修 inputPreview：JSONB `{"input":"…"}` 解包为文本（此前对象透传，消费端恒显 '—'）。e2e NAV-02 改断言导航无运行历史项，IA-01 重写为卡片展开区断言。
- **节点产出流式展示**：运行中的 LLM/Agent 节点边生成边可见，不再黑箱到节点收尾。链路四段：①引擎 `IExecutionContext.onNodeDelta` + executor `onNodeDelta` 钩子（按当前节点绑定，并行波次各报各的）；②LLM 节点流式门控放宽——只要 llmClient 有 `chatStream` 就走流式（此前要求 isLastNode+SSE，画布/详情旁观全程黑箱），SSE token 仍只推末节点；`chat` 参数新增 `onDelta`（PlatformAgent 工具循环每轮生成过程可旁观）；③gateway CLI client 消费 `AgentSession.events` 真逐帧流式（`chatStream` 不再等 result 一次性吐），span-writer 新增 `onNodeDelta`：按节点累积 + 1s 节流 `UPDATE run_node_spans SET output`（`WHERE status='running'` 守卫，永不覆盖终态全文）；④console：画布结果面板 running 行自动展开 + live tail 单行预览 + 光标呼吸动画（`.canvas-result-text.streaming`），详情页 inspector 输出正文直出（`{text,content}` 解包）。e2e WF-13 钉死全链路（慢速 mock 流中途轮询断言 running+partial、终态全文覆盖）。顺手修 mock server 调速 bug：`resolveResponse` 投影漏掉 `streamChunkSize/streamIntervalMs`（注释宣传了但从未生效，慢速流此前测不了）。

## 2026-08-29

- **Workflow-First IA 反转（PRD `docs/prd-workflow-first.md` v1.1 已评审）**：`/` = Flows 工作台（空态三入口：团队场景模板 / 一句话生成 / 空白画布，`flows-empty-hero`）；新主导航 `app-nav-sidebar`（工作流 / Agents / 技能 / Daemons + 项目维度会话树 `chat-history-tree`；**模板不占导航位**——原 `/templates` 路由与「模板」tab 已删（用户裁决），入口收敛到工作流工具栏「从模板创建」按钮 + Hero 三入口；运行历史同理不占导航位）；**Chat 降为全局悬浮副驾**（`floating-chat` 除 `/chats/[id]` 外全路由常驻，可拖动/拉大/位置记忆，画布页避让 minimap，历史抽屉承接旧会话树，HITL 内联应答条）；执行核心收敛到 `use-chat-execution`（F0 单一实现，WS 帧语义 `applyChatFrame` 纯函数可复用）；`@workflow` 生成落点 toast+直达（toast 支持 action 按钮）；gateway `GET /api/v1/runs` 端点新挂载（跨流查询 + 失败原因摘要）。**回滚通道**：`localStorage dagents.ia.workflow-first=off` 恢复 Chat-First 首页+旧侧栏（e2e IA-04 钉住；flag 存续期 ≤1 迭代，2026-09-06 回滚壳退役后失效）。e2e：01/03/08 重写为新 IA 断言 + 新增 19 号冒烟（IA-01~04）。
- **列表页运行异步化 + 运行输入面板 + 详情页进度轮询**：Flows 列表「运行」按钮此前 POST 同步 run 端点 —— HTTP 响应被压住直到整个流程跑完（CLI Agent 动辄几分钟），期间无跳转无进度，用户感知「点了没反应」；含 HumanInput 节点的流程更是永久挂起。现在三点闭环：①点「运行」先开 `flow-run-dialog`（输入作为 `{{$start.input}}` 传入 + 项目目录选择器，记忆键与画布共用 `dagents.canvas.runDir`）；②提交走 `?async=1` 立即返回 runId 并打开详情页；③详情页 node-spans 从一次性拉取改为 **1.2s 轮询到终态**（终态依据 runs 行 runStatus，`fetchRunNodeSpans` 现返回 `{spans, runStatus}`；无 runs 行的旧运行退化为画布同款启发式收尾），终态时 toast + 刷新详情/列表，打开旧运行详情不重复打扰。e2e WF-12 钉住整条 UI 旅程。
- **侧栏会话树回归项目维度（用户裁决）**：Workflow-First 主壳的会话历史从扁平「最近对话」列表改回**以项目目录为第一维度的树** —— 旧 ChatNavSidebar 的目录树整体抽成共享组件 `chat-history-tree.tsx`（搜索胶囊/目录重命名删除/每目录新建 ➕/会话重命名删除/HoverCard 预览/显示更多溢出/活动目录自动展开，全套功能单一来源），`AppNavSidebar` 主导航下方与 `ChatNavSidebar`（回滚壳）共用同一实现；样式复用 chat-nav-sidebar.css 的类（含折叠态）。ChatNavSidebar 瘦身为壳（品牌/新建对话/NAV/树/页脚）。e2e UC-NAV-05 重写为目录树断言（分组展开/会话行/详情页 aria-current）。
- **gateway 单测专用库自动供给**：`apps/gateway` 的 vitest `globalSetup`（`src/test-support/gw-test-db.ts`）把整套集成测试（15 个 DB-backed 文件）钉到 `dagents_gw_test` —— 连 `postgres` 维护库建库、经 `@dagents/db` 的 dist 迁移（幂等可增量）、在 worker fork **之前**注入 `POSTGRES_URL`（`AppDataSource` 在模块构造时捕获 env，与 e2e `seed.ts` 同款约束）。此前这些测试直连 dev 库，dispatch 两个文件还 `DELETE FROM runs` 全表 wipe——**每跑一次 gateway 单测就清空 dev 库全部真实运行历史**，且末用例种子（`flow-1`/`running` 行）残留成「孤儿 running」。服务器地址沿用 `POSTGRES_URL` 只换库名：本机 :15432 与 CI 服务容器 :5432 均适用，dev 库从此零触碰（CI `ci.yml` 无需改动，服务容器用户具备建库权限）。

## 2026-08-27

- **多实例 CLI 协作引擎修复（真实复跑驱动）**：对「产品发现（并行）」（7 节点菱形，4 并行 claude 实例）做真实复跑暴露三个 mock 测不出的引擎缺陷并已修复——①**N 进 1 合并契约**：`mergeInputs` 拼接 `content`，下游 LLM/PlatformAgent 节点优先取 `content`（`text` 被浅合并覆盖只剩最后一条边；修复前汇总节点丢 N-1 份上游产出，e2e WF-09 钉住）；②**空产出守卫**：LLM/PlatformAgent 空正文抛错标 failed，不再假成功（WF-10/11）；③**Iteration/Loop 终态 span**：controller 体内执行完成后重发 `onNodeEnd`，`completedIterations`/`iterations` 落库、endedAt 为整轮真实耗时（OB-05/MA-06/07/16/ED-03/04 六例既有 e2e 失败全部转绿）。真实终验：汇总节点 209s（> 旧 180s 墙）正常完成、四份简报全到达、逐节点 tokens 完整。详见 `docs/workflow-engine.md` 执行模型速查。

## 2026-08-23

- **结果面板 v2**：节点产出按内容渲染——LLM/DirectReply 的 text/content 双重解包后**正文直出**（DirectReply 的字符串化 JSON 也会二次解包），JSON 降为「原始数据」二级折叠；折叠行内联**正文预览**（首行截断）；**tokens 徽章** ↑输入↓输出（CLI 兜底 client 此前丢 usage，现已从 result.usage 聚合返回，双命名 prompt_tokens/inputTokens 兼容）；运行中**已完成的节点自动展开**（用户手动收起则记住不强开）。进度分母 = 流程总节点数（initialFlowData），非已出现 span 数。
- **画布运行项目目录**：运行输入面板含**项目目录选择器**（`dagents.canvas.runDir` 记忆）。run body `directoryId` → gateway 解析 `directories.path` → `createDefaultLlmClient('claude', { cwd })` 闭包注入 → 所有 LLM/Agent/PlatformAgent 节点的 CLI 在选定项目目录执行（此前 CLI 一律在网关进程 cwd 跑——Agent 在错误的项目里干活）。chat 流式路径同样注入会话绑定目录的 cwd。HTTP provider 路径不受影响（无文件系统语义）。
- **画布异步运行**：`POST /workflows/:id/run?async=1` —— 先落 status='running' 的 runs 行、后台执行、**立即返回 runId**（同步等待会让 5-9 分钟的多 Agent 链撞上代理层 300s 超时，客户端误报失败）。画布统一走 `watchLoop` 轮询终态；任一 span failed 时**立即**置失败态并提示节点名（不等 runs 行落库）。结果面板：运行中显示「正在执行：节点X（n/m 完成）」呼吸行 + 节点开始时间 + 输入折叠。
- **画布运行输入 + 运行结果面板**：点「▶ 运行」先弹输入面板（输入作为 `{{$start.input}}` 传入，支持 `{{<节点id>.output}}` 引用；⌘⏎ 快捷运行）——不再空跑。顶栏「运行结果（n）」按钮打开逐节点面板：状态点（旋转/绿/红）+ 耗时 + 展开看产出 JSON（`latestSpans` 来自 node-spans 轮询，旁观模式同样可用）。
- **画布旁观任意运行**：画布页支持 `?run=<runId>` 自动旁观任意运行（chat @flow 触发的也行）；入口在 chat 详情右栏「执行记录」和 Flows 详情页的「画布查看」。chat 流式执行路径（`GET /chats/:id/stream`）与画布直跑共用 `span-writer.ts` 增量进度（按节点串行化防终态被并发 start 覆盖；`run_node_spans` 有 `(run_id,node_id)` 唯一索引 + 幂等 upsert），并在结束后补写 `runs` 行（chat 触发的运行从此进 flow 运行历史）。连线随进度点亮：完成段静态绿、活动段 dash 流动（`canvas-kit-page.tsx` 移植版，边状态现由 FlowEditor 从 nodeStates 单向派生）。node-spans 读端点附带 `runStatus/runDurationMs` 供旁观端判断终态。
- **agent-templates 已退役（方案 B）**：原「从模板创建」的 5 个静态模板翻译为人格库「快速开始」分区（`apps/gateway/quickstart-library/`，内置库根 rank 50，frontmatter `kind`/`model` 为建议运行时）。instantiate 默认采用人格建议（请求体可覆盖）；人格库确认步新增运行时/模型档位选择器。Agents 页只剩「新建 Agent」+「从人格库启用」两个互补入口。`routes/agent-templates.ts` 与 console 的 gallery/lib/BFF 已删除（flow-templates 是另一套，未动）。

## 2026-08-22

- **画布内运行 + 节点实时进度**：画布顶栏「▶ 运行」自带 `x-run-id` 请求头发起 POST（run 端点接受客户端 runId），同时 700ms 轮询 `GET /runs/:runId/node-spans`，把节点状态刷到节点徽章（running=旋转 / done=绿勾 / failed=红叉）。数据源是引擎新钩子：`DagExecutor.execute` 的 `onNodeStart/onNodeEnd` → gateway `run_node_spans` 增量 UPDATE-then-INSERT（事后批量落库跳过已写节点防重复）。引擎钩子测试在 `packages/workflow/src/__tests__/executor.test.ts`。
- **模板参数化（产品方案 G）**：节点文案里的 `{{变量名}}`（支持中文，与引擎变量语法共用）在「另存为模板」时扫描入 `flow_templates.params`；实例化确认框表单回填（`answers`），缺省回落 defaultValue/空串，未声明占位符保留原样交给引擎运行时解析。
- **统一 AI 生成管线（产品方案 A1/A2/A5）**：chat `@workflow` 与画布 GenerateFlowDialog 共用 gateway 单一服务 `routes/flow-generator.ts`（CLI 优先/HTTP 兜底，canvas 可指定 `providerId::model` 或 `agent::<id>` 引擎；别名归一 → `@dagents/workflow` 的 `validateFlowTopology` 拓扑校验 → 一轮修复循环 → **显式失败，静默兜底已删除**；每次生成写 `generator_attempts` 埋点）。console BFF 只做 vendor 形状适配（薄代理 `POST /api/v1/flow-generator/generate`）。画布保存走同一校验器做非阻断干跑警告。
- **执行可取消 + 超时（产品方案 B / 执行取消 spec；2026-08-27 修订 CLI 时长策略）**：HTTP LLM 调用超时 `LLM_HTTP_TIMEOUT_MS`（默认 120s，流式为空闲看门狗）；**CLI 执行不设墙钟上限**（Agent 自主长跑是常态，曾有 4 路并行 Agent 在 180s 墙被截断成「部分文本 + done」假成功）——inline 聊天 `INLINE_INACTIVITY_TIMEOUT_MS`、工作流节点 `WORKFLOW_CLI_INACTIVITY_TIMEOUT_MS`（均默认 300s 静默看门狗，逐行输出即重置）；看门狗触发/取消 → 非完成状态（timeout/aborted/cancelled）诚实抛错，usage 附着错误对象、失败节点 span 仍记 tokens；显式取消 `POST /api/v1/chats/:id/cancel` 与 `POST /api/v1/workflows/runs/:runId/cancel` → `execution-registry.ts` 内存注册表（单进程红线）→ AbortSignal 贯穿引擎/llmClient/adapters（SIGTERM→SIGKILL）→ `chat:cancelled` WS 帧 + `persistCancelled`；gateway boot 清扫悬空 running（chats/runs→failed）。console 停止按钮接真取消。**dispatch/daemon 远程任务取消当时未做**（spec §7 Deferred；2026-09-06 补齐）。适配器维护分级单源在 `packages/agent-adapters/src/tiers.ts`（core：claude/codex/qwen）。

## 2026-08-20

- **流程模板中心**：三层模板收拢 —— 内置（`gateway/src/flow-templates/builtin/*.json`，import 内联含 `with { type: 'json' }`，社区 PR 见其 README）/ 团队场景（agent-library）/ 我的模板（画布顶部操作条「另存为模板」→ `flow_templates` 表）。`POST /api/v1/flow-templates/:id/instantiate` 按 personaName 重绑（复用/自动启用），未命中降级 LLM 节点（模板零依赖可跑）；`builtin/<slug>` 含斜杠有专属路由形态。console：/flows「从模板创建」三 tab 画廊。详见 `docs/flow-templates.md`

## 2026-08-19

- **Agent 人格库**：registry-not-database 模式承载 agency-agents 人格库（默认根 `~/.agents/agent-library`，软链到 clone 即挂载；`DAGENTS_AGENT_LIBRARY_DIRS` + `POST/DELETE /api/v1/agent-library/roots`）。**库/目录分离：人格住文件系统，agents 表只装「已启用」的**（`POST /api/v1/agent-library/:division/:slug/instantiate`，默认 kind=claude + slim 三档编译 + 语言包络 + `library_meta` 溯源），`@workflow` 清单注入天然不爆（另有 80 条防御上限）。上游同步 = 挂载目录 `git pull` + `GET /drift` 三态 + `reimport`（覆盖 instructions、id 不变、工作流引用不失效）。console：/agents 页「从人格库启用」。团队场景模板见 2026-08-31 条目。中文人格衍生库在 `~/.agents/agent-library-zh`（不挂载；同名覆盖语义见其 README）。详见 `docs/agent-library.md`
- **执行态 e2e**：`apps/console/tests/e2e/` spec 11~15（57 用例：工作流执行契约（含 WF-09~11 合并/空产出回归钉）/ 多 Agent 协作 MA-01~18 / 聊天触发 SSE / 边界 / UI 旅程），地基是 **Mock LLM Provider**（`tests/e2e/fixtures/mock-llm-server/`，OpenAI 兼容 + `/__control/*` 控制面，端口 4010，playwright webServer 自动拉起）。`seedMockLlmProvider` 会临时切换 dev 库的 active provider —— **测试中途强杀可能残留 `e2e-mock-%` 行，导致真实 LLM 调用指向死 mock；清理：`DELETE FROM llm_providers WHERE name LIKE 'e2e-mock-%'`**。DAG 构造用 `tests/e2e/helpers/flow-builder.ts`（平铺 `data.<field>`）。专用测试库 `dagents_e2e` 已建（全栈隔离需 gateway 以 `POSTGRES_URL=…dagents_e2e` 启动，见 `tests/e2e/README.md`）；CI 在 `.github/workflows/e2e.yml`。详见 `docs/e2e-test-plan.md` §12 执行记录。

## 2026-08-18

- **CLI 第一性**：本地 CLI agent 是基线执行引擎，HTTP LLM Provider 只是可选加速 —— ①`@workflow` 生成默认走 CLI spawn（prompt 注入真实 agent 清单 + 技能清单，"claude a 做规划"可映射到真实 agentId 的 platformAgentAgentflow 节点），CLI 失败才降级 HTTP；②工作流执行的 llmClient 无 provider 时用 CLI 兜底（`createDefaultLlmClient`），LLM/Agent 节点零配置可跑。配置了 provider 则自动用 HTTP。

## 2026-08-16

- **中英双语 i18n**：自然键 i18n（`apps/console/src/i18n/`）——中文文案即 key，`en/` 词典分模块维护（common/agents/flows/daemons/settings/chat），缺译自动回退中文；`useI18n()` 无 Provider 也能用（默认 zh）。语言切换在设置页「通用 · 外观与语言」tab（2026-09-06 从侧栏底部移入；`dagents.locale` 持久化，明暗切换同页同 tab —— `ThemeSettingControl`/`LocaleSettingControl` 分段控件，旧侧栏 ThemeToggle/LocaleToggle 按钮已删）。新增界面文案直接写中文并用 `t('中文')` 包裹，英文词条加到对应 `en/*.ts`。
- **审计修复（摘要）**——全库审计后修复的主要问题（详见当次会话）：
  - **安全**：llm 代理 SSRF（绝对 URL 劫持 + 密钥外泄）已封堵；`/internal` 与 dispatch 非 daemon-protocol 路由纳入 `GATEWAY_API_KEY` 门禁；dispatch 任务生命周期路由校验认领 daemon 的 token；WS 升级在 key 模式下校验 token + Origin、非 `/ws` 升级请求显式拒绝；HTTP 节点加 scheme 白名单/15s 超时/32KB 截断；pi 适配器 resumeSessionId 约束到会话目录。
  - **引擎**：画布 `data.inputs` 配置归一化（此前画布 flow 全部按空配置跑）；锚点 handle 路由修复（普通数据节点的下游不再被静默跳过，画布 Condition 数字/Else 锚点映射 true/false）；DirectReply/CustomFunction 字段名对齐；workflow LLM client 改用 AES-GCM 解密（此前开加密必 401）；Iteration 100 项上限；HumanInput/ExecuteFlow 无注入时显式报错。
  - **适配器**：codex 重写为 `codex exec --json` + 真实事件流（旧版双幻觉）；openclaw 支持多行 JSON blob + 纯文本错误行判失败（实测 openclaw 失败时退出码是 0）；codebuddy 去掉自相矛盾的 `--input-format`；copilot 加自主 flag；gemini 模板移除（无适配器，建了也跑不了）。**注意：codex/codebuddy/copilot/qwen 本机未安装，修复基于官方文档格式，未经真实 CLI 回归。**
  - **前端**：daemon 删除死按钮接通代理；Daemons「日志」改为真实 task events；Settings 五个假数据 tab 标注「未接入」；onboarding 条件对齐 inline 架构；AgentSelector 快速创建 bug 修复；Flows 假筛选/假运行记录移除；cost/load 标注估算。
  - **基础设施**：`@dagents/db` 构建产物现在包含 entities/migrations（此前 dist 下 `runMigrations()` 静默 no-op）；audit 测试不再回退 CHECK 约束（dev 库已同步修复）；daemon 401/403 触发重注册（此前只听 404 永不触发）、注册失败 exit 1；空壳 e2e 包已删除。

[Unreleased]: https://github.com/dagents/dagents/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/dagents/dagents/releases/tag/v0.1.0
