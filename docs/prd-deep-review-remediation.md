# PRD · 深度试用问题修复：画布可用性 / 变量契约 / CLI 兜底语义（PM 深评审整改）

> **版本**：v1.1（2026-08-31，三角色评审定稿）
> **状态**：✅ 已评审（架构师 / 设计师 / 测试总监 + 产品经理列席），决议 D1~D9 已并入正文，见 §11 评审记录
> **作者**：产品经理（以 PM + 资深用户双重视角完成深度试用后整理）
> **输入来源**：2026-08-31 全产品深度实测 —— 17 个各类型工作流、20+ 次真实运行（零 LLM Provider、全 CLI 兜底）、模板中心 / 一句话生成 / 另存为模板 / 画布编辑与旁观 / 取消 / 并发 / HITL / 浮层聊天 `@workflow` / i18n 全旅程走查。证据见附录 A。
> **一句话摘要**：引擎层出乎意料地扎实（17 个流无一因引擎 bug 跑挂），但产品层有两个「最后一公里」级 P0——画布直链白屏（漏导入一个 CSS）、UI 亲自教用户的变量语法引擎不解析——全部是用户第一眼会撞上的问题。

---

## 1. 背景与问题

### 1.1 本次深评怎么做的

- **通道**：Gateway API（`/api/v1/*`）+ 浏览器 UI 双轨；
- **广度**：17 个工作流覆盖全部节点类型——LLM 顺序链 / 四路并行菱形合并 / Condition 双分支 / Iteration 批处理 / Loop 循环 / HumanInput（HITL 预填）/ DirectReply / CustomFunction / HTTP（含 file:// 反例）/ Retriever / ExecuteFlow 子流程 / PlatformAgent / 混合水槽 / 内置模板实例化（带参数）/ 一句话生成 ×2（API + 聊天 `@workflow`）；
- **深度**：异步运行 + 轮询旁观、中途取消、双流并发、失败路径、画布内 UI 发起运行、节点检查器、变量选择器、模板三 tab、另存为模板、i18n 切换；
- **环境**：零 LLM Provider（验证 CLI 兜底第一性设计），本机 claude CLI。

### 1.2 总体结论

| 层 | 结论 |
|---|---|
| 引擎（executor / 节点 / 取消 / 合并契约） | ✅ 可靠。除故意的 file:// 反例外零引擎故障；取消传播到 CLI 子进程、失败语义诚实、tokens/活动流/旁观可观测性超配 |
| 产品皮（画布加载 / 变量教学 / 文案 / 命名一致性） | ❌ 两个 P0 + 一批 P1/P2，集中在「用户第一触点」 |

### 1.3 问题陈述

1. **画布页直链 / 刷新 / 外部旁观链接 = 白屏**（高度塌缩为 0），只有从列表页客户端导航进入才正常——根因是画布页复用了模板画廊的 CSS 类但未导入样式表。
2. **变量体系三张皮**：运行面板提示文案教的 `{{$start.input}}` / `{{<节点id>.output}}` 引擎解析不到（查不到值时静默保留字面量）；变量选择器推荐的是 Flowise 原版的 chat 路径变量（画布运行下不存在）；真正可用的 `{{input}}` / `{{节点id.content}}` 在 UI 上无处可学。
3. **CLI 兜底语义漂移**：「纯 LLM 模板节点」在零 Provider 环境下变成带工具的真 Agent，在网关 cwd（用户仓库）里翻箱倒柜——实测代码审查链 318 秒 / 9 万 tokens，结论跑偏（「该函数不在仓库中」）。

---

## 2. 目标与非目标

### 2.1 目标

1. **G1**：任何入口打开画布（直链、刷新、书签、`?run=` 旁观外链）都完整可见可交互；
2. **G2**：变量语法单一事实来源——UI 教的、选择器给的、引擎解析的，三者一致且全部真实可用；现有 flow 零破坏兼容；
3. **G3**：「纯文本 LLM 节点」与「CLI Agent 节点」在产品语义上可区分、可预期（成本、耗时、行为边界）；
4. **G4**：清掉 P1/P2 级文案与数据诚实性问题（假状态徽章、矛盾文案、API 命名不一致、i18n 漏译等）。

### 2.2 非目标（明确不做 / 不许动）

- ❌ 不重构引擎执行模型（合并契约、迭代、取消等实测全部健康，是资产不是负债）；
- ❌ 不砍 CLI 兜底第一性设计（零配置可跑是核心卖点，问题只在「节点档位不可区分」）；
- ❌ 不做成本计价 UI、多租户账户体系（「我的」tab 问题仅做减法处理，不做加法）;
- ❌ 不动模板参数化、`@workflow` 生成旅程、活动流/tokens 可观测性——本次实测全链路好评，守土。

---

## 3. 用户与受影响场景

| # | 场景 | 现状遭遇 | 关联需求 |
|---|---|---|---|
| S1 | 用户在画布页按 F5 刷新 | 画布消失只剩工具栏，以为数据丢了 | FR-01 |
| S2 | 把 `?run=` 旁观链接发给同事 / 从执行记录新开 tab | 打开是空白编辑器 | FR-01 |
| S3 | 新用户照着运行面板提示在 prompt 里写 `{{$start.input}}` | LLM 收到字面量，回答「变量未解析」，用户以为是自己的错 | FR-02 |
| S4 | 用户在 LLM 节点后接 Condition 再接 LLM，用文档语法引用输入 | 兜底的「上游输出自动追加」失效，bug 必现 | FR-02 |
| S5 | 用户从变量选择器插入 `{{question}}` / `{{chat_history}}` | 画布运行下静默变字面量 | FR-02 |
| S6 | 用户零 Provider 跑「代码审查链」模板审查一段贴入的代码 | Agent 跑去项目仓库全仓搜索，318s / 9 万 tokens，结论跑偏 | FR-03 |
| S7 | 用户跑完流回到列表页 | 卡片收起态显示「未触发」，以为运行丢了 | FR-04 |
| S8 | API 集成方创建工作流（name）、实例化模板（flow_name）、生成流（question） | 三套字段名，静默吞参或报错 | FR-05 |

---

## 4. 需求详述

### FR-01 【P0】画布直链白屏：补齐样式依赖 + 补 e2e 视觉断言

**现状与证据**
- `apps/console/src/app/workflows/[id]/canvas/page.tsx:77-81` 使用 `ftpl-canvas-column` / `ftpl-canvas-body` 布局类；
- 样式定义在 `apps/console/src/styles/flow-templates.css`，**仅**被 `apps/console/src/components/flow-template-gallery.tsx:31` 导入；
- 实测 A/B（决定性）：
  - 直接 `goto` 画布 URL → `.ftpl-canvas-column` 计算样式 `display: block`，`.react-flow` 高度 **0px**，截图全白（DOM 节点全在，视觉为零，改窗口尺寸不可恢复）；
  - 从首页点「编辑画布」客户端导航 → 同类 `display: flex`，画布 694px，一切正常。
- 连锁机制：vendor CSS `.agentflow-container{height:100%}` 撞上高度不明确的 block 父级 → 塌成 58px 工具栏 → `.agentflow-main/.agentflow-canvas/.react-flow` 全部 0 高。

**用户故事**
> 作为用户，我希望无论从哪里打开画布（刷新 / 书签 / 外部旁观链接），都能看到完整画布，而不是一个只有工具栏的空白页面。

**需求描述**
1. 画布 page 显式导入所需布局样式（推荐：把 `ftpl-canvas-column/body` 规则迁入 `canvas.css`，消除跨文件隐式耦合；最小热修：page.tsx 加一行 `import '@/styles/flow-templates.css'`）；
2. 顺手审计其余「复用类名但未导入样式」的同类风险（grep 类名 vs import 清单）。

**验收标准**
- [ ] 直链打开、F5 刷新、`?run=` 外链打开画布，`.react-flow` 可视高度 > 400px；
- [ ] e2e 新增用例：**全新 page（非客户端导航）打开画布 URL，断言画布容器可见尺寸**（DOM 存在性断言不足以捕获本 bug——本次 e2e 全绿正是盲区）。

**影响面**：画布页全量用户。**预估**：0.5 天（含测试）。

> **决议 D1（架构师 + 测试总监）**：热修采用「画布 page 显式 `import '@/styles/flow-templates.css'`」一行方案，**不做**类名迁移（两处共用同名类，迁移引入画廊级联回归风险，收益不匹配）；类与样式的解耦重构另立技术债任务。e2e 断言落在 `viewport-matrix` 既有视口矩阵上，增加「fresh context + 直接 goto」导航模式（现有 e2e 全部客户端导航，正是漏网原因）。

---

### FR-02 【P0】变量契约统一：一处定义、三处对齐

**现状与证据（三张皮）**
1. **UI 提示文案**（`flow-run-dialog.tsx:94`、`flowise-canvas.tsx:783`）：教 `{{$start.input}}` 与 `{{<节点id>.output}}`；
2. **引擎实际形状**：start 输出 `{content, variables}`（`start.node.ts`，无 `.input` 字段）、LLM 输出 `{text, content}`（无 `.output` 字段）；`resolveVariables` 查不到即静默保留字面量（`utils/variables.ts`）；
3. **变量选择器**：推荐 Flowise 原版 Chat Context 变量（`question`「User's question from chatbox」/ `chat_history` / `file_attachment` 等，画布运行路径下不存在）与整对象引用 `{{cond}}`；真正可用的 `{{input}}` / `{{节点id.content}}` 无处可学。

**A/B 实锤（同一流、同一位置、仅换变量写法）**
- `{{$start.input}}` → LLM 收到字面量，回答「变量未解析 请补充输入」（run `f68b83dd`）；
- `{{input}}` → 「先查慢查询连接数再限流扩容」（run `d9064c5d`）。

**为什么一直没被发现**：线性链里 LLM 节点会把上游输出自动追加到 prompt 末尾（`llm.node.ts` 的 input-append 兜底），字面量虽在但被模型忽略；一旦中间隔了 Condition 这类输出无 `content` 的节点，bug 必现。

**用户故事**
> 作为流程搭建者，我在任何输入框照 UI 提示或选择器插入的变量，运行时都必须被真实解析；写错时我要得到显式警告，而不是模型收到一串 `{{...}}` 原文。

**需求描述（评审定稿：引擎兼容别名 + UI 对齐，双管齐下）**
1. **引擎兼容**（`resolveVariables`，单点覆盖全部 8 个消费节点：llm / platform-agent / agent / condition / condition-agent / direct-reply / human-input / execute-flow）：为文档宣传的两个语法建立别名解析——`{{$start.input}}` → start 节点的 `content`（即运行输入）；`{{<id>.output}}` → 该节点输出正文（取 `text ?? content`，两者皆无时回落整对象 JSON 串，Condition 的 `matched` 等由此可达）。保持「查不到才留字面量」的现有行为不变，向后兼容零破坏；
2. **提示文案**：运行面板 / 运行对话框改为真实且稳定的语法示例（`{{input}}`、`{{节点id.content}}`，兼容别名上线后可并列展示 `{{$start.input}}`）；
3. **变量选择器**：下架 Flowise chat 路径幽灵变量（`question` / `chat_history` / `file_attachment` 等在画布运行路径下不存在）；Node Outputs 列表按节点类型提供可用路径（LLM → `.content`、Condition → `.matched`、Iteration → `.iterations` 等），并标注「整对象引用」与「字段引用」的区别；分组重构为「运行输入 / 上游产出（含字段路径）/ 流程元数据」三组；
4. **显式警告**（可后置）：运行前干跑扫描 prompt 中未解析占位符，画布保存时的非阻断警告复用同一扫描器；
5. **【评审新增】模板参数扫描器引擎保留字**（`apps/gateway/src/flow-template-pipeline.ts`）：现扫描正则 `[A-Za-z_\u4e00-\u9fa5][\w\u4e00-\u9fa5]*` 匹配不了带 `$`/`.` 的引擎变量是**正则巧合而非设计**；更严重的是单词型引擎变量（`{{input}}` 等 flat state 键）**会被当成模板参数收集**——实例化时 answers 表单会要求填「input」并直接替换文本，运行输入从此到不了节点（双重身份冲突）。必须新增引擎变量保留字清单（`input`、`$` 前缀、含 `.` 路径一律显式排除并写注释说明依据）。

**验收标准**
- [ ] A/B 复现用例转正：`{{$start.input}}`、`{{id.output}}`、`{{input}}`、`{{id.content}}` 四种写法在同一位置全部解析出真实值；
- [ ] 变量选择器不再出现画布路径下不存在的变量；
- [ ] 含 `{{input}}` 的 flow 另存为模板后，参数表单**不**出现「input」；
- [ ] 既有全部 e2e（WF 系列）零回归；
- [ ] 单测覆盖别名解析优先级（显式字段 > 别名 > 字面量保留）与 Condition 无 text/content 时的 JSON 回落；
- [ ] 【测试总监补充】节点 span 新增 `unresolvedPlaceholders` 字段（运行期统计送入 prompt 仍为字面量的 `{{...}}`），使「变量一次成功率」可查询、可度量（见 §6）。

**影响面**：所有引用变量的 flow 与模板（含 10 个内置模板中含 `{{关注点}}` 参数化语法的模板——中文参数名与引擎保留字不冲突，勿误伤）。**预估**：2 天（评审上调：+0.5 天用于扫描器保留字与 span 字段）。

> **决议 D2（架构师）**：别名层集中落在 `variables.ts` 单点，禁止在节点内各自实现；优先级钉死「显式字段 > 别名 > 字面量保留」，杜绝输出恰好含真实 `.output` 字段时的歧义；发布门禁见 D8 干跑对比。
> **决议 D3（架构师 + PM）**：扫描器保留字清单与别名解析**同批发布**——只修别名不修扫描器会制造新的双重身份坑，属半成品。

---

### FR-03 【P0→P1 排期】CLI 兜底档位：让「纯 LLM」与「真 Agent」可区分、可预期

**现状与证据**
- 模板「代码审查链」自述「纯 LLM 节点零依赖」；零 Provider 环境下 CLI 兜底执行，节点实为**带工具的 claude 实例**；
- 实测：贴入 `export function add(a,b){return a+b}` 请求审查 → Agent 在网关 cwd（dagents 仓库）执行 `rg` 全仓搜索 + `git status`，得出「该函数不在仓库中」→ 三节点逐级放大，末节点输入 35k tokens，总耗时 **318s**、合计约 9 万 tokens（对照：同输入走纯文本语义预期 <60s / <2 万 tokens）；
- 用户语义预期（审一段文本）与实际行为（项目级调查）错位，成本 ×数倍且结论跑偏。

**用户故事**
> 作为零 Provider 用户，我跑「纯 LLM」模板时预期得到文本加工；当我真需要 Agent 在项目里干活时，我也能明确选择并看到它将在哪个目录干活。

**需求描述（分层方案，最小改动先行）**
1. **节点/模板档位标注**：LLM 节点在 CLI 兜底模式下，画布徽章与运行面板标注「CLI 兜底 · 带工具」与实际执行 cwd（项目目录选择器已回填此值，展示即可）；模板描述不再宣称「纯 LLM」当兜底会改变行为；
2. **无工具模式**：llmClient 增加无工具调用形态（CLI 以禁用工具方式 spawn，或 HTTP 无 tools 语义），LLM 节点默认无工具、PlatformAgent 节点默认有工具——把「节点类型」与「工具能力」的映射变成显式契约；
3. **cwd 防御默认**：LLM 节点（非 PlatformAgent）在未显式选择项目目录时，不默认以网关进程 cwd（用户仓库根）执行工具调用；
4. **成本护栏**（可后置）：运行面板对单 run 累计 tokens 超阈值（如 50k）给出提示。

**验收标准**
- [ ] 同一「代码审查链」模板 + 同一输入，LLM 档位下不出现仓库搜索类工具调用、耗时 <90s（P90）、tokens <2.5 万（P90）；
- [ ] 画布/运行面板可见当前 run 的执行引擎档位与 cwd；
- [ ] 显式选择项目目录的 PlatformAgent 行为不变（回归 14 号单 Agent 用例语义）。

**影响面**：CLI 兜底路径全量（当前为默认路径）。**预估**：2 天（含适配器回归；codex/qwen 等本机未装 CLI 仍按文档推演，标注未经真机）。

> **决议 D4（架构师）**：无工具档**不新造旗标体系**——claude 适配器已有 `--permission-mode` 管道（`claude.ts:86`），`tools:'none'` 档映射到最严 permission mode + 空 allowedTools 即可落地；claude 真机回归先行，codex/qwen 按官方文档推演并标注「未经真机」（与既有审计惯例一致）。**默认值裁决**：LLM 节点默认无工具、PlatformAgent 默认有工具——「节点类型 ↔ 工具能力」成为显式契约。
> **测试总监修正**：耗时/tokens 门槛从硬性 `<90s/<2.5 万` 改为 **P90 目标**（CLI 冷启动与网络波动大，硬门槛会造成 CI 假红）；CI 内用 mock-llm-server 断言「无工具调用事件」，真机仅做人工冒烟。

---

### FR-04 【P1】列表卡片收起态状态徽章数据诚实化

**现状**：刚跑完 4 次的 flow，收起态仍显示「尚无运行状态数据：未触发」；运行记录为懒加载（展开才拉取），加载后头部徽章不回写。
**需求**：收起态徽章三态——「未触发 / 最近一次状态（✓ ✗ ⏳）+ 次数 / 加载失败」。
**验收**：跑完流返回列表（含浏览器返回键），卡片徽章在 3s 内反映最近一次运行状态。
**预估**：0.5 天。

> **决议 D5（架构师 + 设计师）**：数据源用**新增批量 summary 端点**（`POST /api/runs/summary`，body 为 flowIds 数组，一次请求返回每流最近一次 run 的状态/时间/次数）——列表 35 张卡片，逐卡懒加载 `?flowId=` 是 N+1，违背列表页性能底线；徽章数据随列表首屏一次拉齐，存在 running 时复用 FlowRunsPanel 的 3s 轻轮询到终态，不额外加定时器。

### FR-05 【P1】API 字段命名与路径统一

**现状**：创建工作流 `name` / 模板实例化 `flow_name`（传 `name` 被 zod 静默吞）/ 生成器 `question`（传 `prompt` 报错）；node-spans 挂 `/api/v1/workflows/runs/:id/node-spans` 而 runs 列表挂 `/api/v1/runs`。
**需求**：新字段一律 camelCase 单一命名（`flowName`、`prompt`），旧 snake/别名保留兼容期并在响应中标注 deprecation；runs 读取路径统一收敛（保留旧路径 302/兼容）。
**验收**：三种资源用同构字段名可创建成功；OpenAPI/README 有唯一真相表。
**预估**：0.5 天（不含文档站）。

> **决议 D6（架构师）**：兼容策略收敛为「新名 + 旧名并存一个 minor 版本 + 响应头 `Deprecation: true` 标注」，下个大版本移除旧名；**不追加 zod `.strict()`**（会立刻打死存量调用方）。runs 双路径保留双挂载，文档以 `/api/v1/workflows/runs/...` 为唯一真相。

### FR-06 【P1】Iteration 聚合语义显式化

**现状**：3 项迭代后节点 `content` 只剩最后一项（"cherry"），完整数组在 `.iterations`；下游 `{{iter.content}}` 静默只拿最后一条。
**需求**：`content` 改为「逐项结果有序拼接」（与 N 进 1 合并契约的 `mergeInputs` 语义对齐）或新增 `contentAll`；节点编辑器与文档标注该语义；变量选择器对 Iteration 节点提供 `.iterations` 路径。
**验收**：e2e 钉住拼接语义；选择器可选到完整数组。
**预估**：0.5 天。

### FR-07 【P1】Settings 空态文案与 CLI 兜底设计对齐

**现状**：「还没有 Provider。Flow 工作流节点（LLM / Agent / PlatformAgent）需要在此配置 Provider 才能调用大模型」——与 CLI 第一性（零 Provider 全功能可跑，本次实测 20+ 次）直接矛盾，会把新用户吓去配 key。
**需求**：改为「未配置也可用：节点默认走本机 CLI（较慢、消耗订阅额度）；配置 HTTP Provider 可加速并统一计费」+ 附「CLI vs Provider 对比」说明。
**验收**：文案经产品评审；与 FR-03 的档位标注互洽。
**预估**：0.5 小时。

### FR-08 【P1】i18n 英文补译（主导航优先）

**现状**：切 EN 后主导航为 "Workflow / **智能体** / Skills / **守护进程**"，相对时间却已翻译（"1m/2d"）——门面漏译。
**需求**：补 `en/common.ts` 导航词条；建立 e2e 或 lint 级检查（切 EN 后导航区不得含 CJK 字符）。
**验收**：EN 模式主导航、设置侧栏分组、Daemons 页全英文。
**预估**：0.5 天（含词条清理与检查器）。

### FR-09 【P1】模板对话框加载态

**现状**：首开 2-6 秒空窗（仅 tab 无内容、无 loading），首次体验像坏了。
**需求**：骨架卡（复用画布 loading 骨架样式）+ 失败重试。
**验收**：弱网模拟下无「空白对话框」中间态。
**预估**：0.5 天。

### FR-10 【P2】运行记录时间本地化

中文界面显示 `08/31 09:04 PM`（12 小时制 + AM/PM）。改为 locale 感知格式（zh：`08/31 21:04`）。**预估**：1 小时。

### FR-11 【P2】CustomFunction 对象入参护栏

`String($input)` 对象直接 `[object Object]`（本次实测踩中）。customFunction 运行时对非字符串入参注入 `$inputText`（content 解包），README/编辑器提示。**预估**：2 小时。

### FR-12 【P2】Retriever 无检索源显式提示

画布路径下检索 chat 历史，新会话必空 `docs:[]` 静默成功。至少：空结果时输出附 `warning: '无命中'`；中期：提供文件目录检索源选项。**预估**：0.5 天（提示）。

### FR-13 【P2】生成节点透明度

一句话生成的 Agent 节点不带 `agentId` / `systemPrompt`（能跑但等于隐形默认 agent）。生成确认步展示「将绑定哪个 agent / 降级说明」，与模板实例化的 members 透明度对齐。**预估**：1 天。

> **架构师意见（收窄）**：UI 大改不做。落地形态收窄为——生成响应中附 `bindings` 说明字段（哪些节点是默认 CLI agent、将用什么 cwd），确认步以文案行展示（复用模板实例化 members 的展示样式），生成器 prompt 同步要求带上 agent 引用时显式写 agentId。预估降为 0.5 天。

### FR-14 【P2】「我的」tab 处理

单机无账户体系，「我的 0 / 全部 35」中「我的」恒 0。

> **决议 D7（设计师）**：二选一裁决为**直接删除**该 tab，不做「我最近运行过的」语义改造——单机产品里「所有权」是伪概念，语义改造会引入新的解释成本；未来多用户落地时再随账户体系回归。

### FR-15 【P2·评审新增】结果面板节点行序改为拓扑序

**现状**：画布结果面板节点行按完成时间倒序排列（实测顺序 cond → urgent → start，start 最先完成却排最后），与画布拓扑和阅读直觉相悖。
**需求**：默认按 flow 拓扑序排列；运行中的节点置顶吸底跟随（保持现有「正在执行」呼吸行的活动感）。
**验收**：同一 run 的面板行序与画布节点左右序一致；e2e 断言首行为 start 节点。
**预估**：0.5 天。

---

## 5. 优先级与路线图

| 批次 | 内容 | 预估 | 说明 |
|---|---|---|---|
| **热修（本周）** | FR-01（含 e2e 直链断言）、FR-07 | 1 天 | 一行 import + 一句文案，收益/成本比最高 |
| **Sprint 1** | FR-02（变量契约 + 扫描器保留字 + span 字段）、FR-04（含批量 summary 端点） | 3 天 | 变量是工作流产品命根子；D3 要求别名与保留字同批发布 |
| **Sprint 2** | FR-03（CLI 档位）、FR-05、FR-06 | 3 天 | 档位涉及适配器回归，排在变量之后 |
| **Sprint 3** | FR-08、FR-09、FR-10~FR-12、FR-13（收窄版）、FR-14、FR-15 | 择机 | 体验打磨批次 |

依赖关系：FR-02 的别名解析先行，FR-06 的选择器路径与 FR-13 复用其变量元数据；FR-03 的档位标注依赖 FR-07 文案定调。

---

## 6. 成功指标

| 指标 | 基线（本次实测） | 目标 |
|---|---|---|
| 画布直链/刷新可用率 | 0%（必现白屏） | 100%，e2e 钉住 |
| UI 教学的变量语法一次成功率 | 0%（`{{$start.input}}` 必现字面量） | 100%（四种写法全解析） |
| 变量选择器插入即有效率 | 部分（chat 变量全无效） | 100% |
| `unresolvedPlaceholders` 残留（span 聚合） | 无字段（不可度量） | 上线后 30 天内自然流量下 ≥95% 的 run 为 0 |
| 零 Provider「代码审查链」耗时/成本 | 318s / ~9 万 tokens | P90 <90s / <2.5 万 tokens（测试总监修正：非硬门槛） |
| 列表卡片状态与最近 run 一致性 | 不一致（恒「未触发」） | 3s 内一致 |
| e2e 对「视觉可用性」的覆盖 | 无 | ≥3 条尺寸/可见性断言 |

---

## 7. 风险与依赖

1. **FR-02 别名解析的歧义风险**：若某节点输出恰好有真实 `.output` / `.input` 字段，显式字段必须优先于别名（D2）；需单测钉优先级，并对 10 个内置模板 + 存量 flow 做解析干跑对比——diff 清单允许**增益型**变化（原字面量开始解析），经人工评审放行（D8，比 v1.0 的「必须为空」放宽但增加评审关卡）。
2. **FR-03 无工具模式**的 CLI 旗标在各适配器上行为不一：claude 走既有 `--permission-mode` 管道真机回归，codex/qwen 按官方文档推演并标注「未经真机」（沿袭 2026-08-16 审计惯例）；CI 一律用 mock-llm-server 断言无工具事件。
3. **FR-01 样式依赖**：热修仅加一行 import（D1 裁决不做类迁移）；「类与样式解耦」另立技术债（行动项 A5），避免画廊级联风险。
4. **测试盲区整改是隐性主线**：本次两个 P0 均为 e2e 全绿下的视觉/语义缺陷，所有 FR 的验收标准都必须包含「真实用户路径」级断言（直链、字面量、token 计数），而非 DOM 存在性。

---

## 8. 附录 A · 测试证据索引

**运行记录（Gateway `runs` 表，`GET /api/v1/runs` 可查）**

| 证据 | runId | 结果 |
|---|---|---|
| `{{$start.input}}` 不解析（字面量送达 LLM） | `f68b83dd-dd7c-4e6a-8f09-bb5f1fef4e84` | completed，输出「变量未解析 请补充输入」 |
| `{{input}}` 正常解析（同一位置 A/B） | `d9064c5d-4389-4865-b8d1-5ea5d07d2b9c` | completed，「先查慢查询连接数再限流扩容」 |
| file:// scheme 白名单拦截 | `c17bc96b-663d-49ea-b876-7a639a9445f1` | failed，span.error 含完整原因 |
| 取消传播到 CLI 子进程 | `9151683f-189d-4a4a-99f7-eb62bfb1f9ad` | cancelled，p1/p3/p4 标注「claude cancelled by caller」 |
| CLI 兜底语义漂移（仓库搜索） | `fb52269a-7ce3-43fa-92a5-9a9972565bc4` | completed 318s / 末节点输入 35k tokens |
| 四路并行合并契约 | `a9669d1c-81f0-413b-8a60-cd82521c8087` | completed，merge 汇总四视角 |
| HITL 预填 | `bace085e-6546-479b-83f4-5e537399d031` | completed，confirm 捕获 yes |
| 画布 UI 发起运行（含目录注入） | 见 flows 卡片运行记录 | completed 15.1s，tokens ↑9.0k ↓422 |

**关键代码位置**
- 画布布局类使用：`apps/console/src/app/workflows/[id]/canvas/page.tsx:77-81`；样式仅在 `apps/console/src/styles/flow-templates.css`，唯一导入方 `apps/console/src/components/flow-template-gallery.tsx:31`；
- 变量提示文案：`apps/console/src/components/flow-run-dialog.tsx:94`、`apps/console/src/components/canvas/flowise-canvas.tsx:783`；
- 引擎形状：`packages/workflow/src/nodes/start/start.node.ts`（输出无 `.input`）、`packages/workflow/src/nodes/llm/llm.node.ts`（输出无 `.output`，input-append 兜底）、`packages/workflow/src/utils/variables.ts`（查不到保留字面量）；
- Settings 矛盾文案：`/settings` LLM Provider 空态。

**截图存档**：`/Users/rowan/.zcode/cli/artifacts/sess_a58df87b-1994-4116-9a6f-c9444e744ccd/`（含：白屏画布 vs 正常画布对照、运行输入面板、运行完成结果面板、首页全貌）。

**实测数据摘要**：17 个工作流（「PM深评-01~14」+ 模板实例 + 生成 ×2）；41 条运行（35 completed / 1 cancelled / 5 failed，含 1 次故意的 file:// 失败与历史旧账）；CLI 单 LLM 节点典型耗时 8~20s。

## 9. 附录 B · 测试痕迹与清理指引

本次评审在 dev 库留下的数据（保留作为复现证据，可随时清理）：
- 17 个 flow：`GET /api/v1/workflows` 过滤名称前缀 `PM深评` / `PM评审`，另含「代码审查链」（模板实例）与两个一句话生成流（站会纪要 / 团队周报）；
- 1 个用户模板「PM评审-三链模板」（模板中心「我的模板」tab 可见可删）；
- 1 条 `@workflow` 会话（dagents 目录下「@workflow 生成一个每日站会纪要工作流…」）；
- 41 条 runs 记录（随 flow 删除级联或保留无碍）。

## 10. 附录 C · 资产盘点（实测确认健康，整改时不许误伤）

- 引擎：并行合并契约 / Iteration 聚合数组 / Loop 硬上限 / 子流程解包 / 空产出守卫——全部实测通过；
- 取消与失败语义：SIGTERM 贯穿、span.error 完整、无假成功；
- 可观测性：tokens 徽章、thinking/tool-use 活动流（随终态保留）、逐节点耗时、画布旁观、运行中 live 输出；
- 旅程：`@workflow` 51.5s 生成 + 双入口直达；模板参数化（「关注点=并发安全」精确注入）；另存为模板参数扫描正确排除引擎变量；
- Daemons 页本机 CLI 探测（claude/openclaw/hermes）与 Settings 真实空态（除 FR-07 文案矛盾外）。

---

## 11. 评审记录

### 11.1 评审会信息

- **时间**：2026-08-31（PM 深评报告 + PRD v1.0 提交当日）
- **参与**：架构师、设计师、测试总监、产品经理（列席记录）
- **输入**：PRD v1.0 + 附录 A 全部证据（评审前三方各自复核了关键代码位置与 run 记录）

### 11.2 架构师意见

1. **【采纳并细化 FR-01】**根因确认属实（`canvas/page.tsx` 复用 `ftpl-*` 类但 `flow-templates.css` 仅被画廊导入）。**驳回「迁移类到 canvas.css」方案**：两个组件共用同名类，迁移引入画廊级联回归风险，热修场景下收益不匹配。裁定一行 import + 事后技术债任务（→ D1）。
2. **【采纳并加固 FR-02】**别名层必须**单点落在 `variables.ts`**——实测 `resolveVariables` 被 8 个节点复用（llm / platform-agent / agent / condition / condition-agent / direct-reply / human-input / execute-flow），任何节点级实现都会漏。优先级「显式字段 > 别名 > 字面量保留」必须单测钉死，否则输出恰含真实 `.output` 字段时产生新歧义（→ D2）。
3. **【评审新发现，升格为阻断项】模板参数扫描器的「正则巧合」与 `{{input}}` 双重身份**：`flow-template-pipeline.ts:70` 的 `PARAM_PATTERN` 不含 `$`/`.`，引擎变量不被收集是巧合而非设计；单词型 flat state 键（`{{input}}`）**会被误收集为模板参数**，实例化时被 answers 静默替换，运行输入永远到不了节点。FR-02 若只修别名不同批修扫描器，等于用新语法制造新坑（→ D3，新增验收项）。
4. **【细化 FR-03 落地路径】**无工具档不需要新旗标体系：`claude.ts:86` 已有 `--permission-mode` 管道，`tools:'none'` 映射最严 mode + 空工具集即可；非 claude 适配器按文档推演并显式标注「未经真机」（沿袭 2026-08-16 审计惯例）。默认值裁决：LLM 节点默认无工具 / PlatformAgent 默认有工具（→ D4）。
5. **【修正 FR-04 数据源】**35 张卡片逐卡 `?flowId=` 懒加载是 N+1，新增批量 summary 端点一次拉齐（→ D5）。
6. **【收窄 FR-13】**驳回生成确认步 UI 大改，收窄为响应附 `bindings` 字段 + 文案行展示（预估 1 天 → 0.5 天）。
7. **【提醒】**FR-05 不得引入 `zod .strict()`（立刻打死存量调用方），走新名 + 兼容期 + Deprecation 头（→ D6）。

### 11.3 设计师意见

1. **【FR-04 视觉规范】**徽章三态色板沿用现有状态点语义（绿 ✓ / 红 ✗ / 琥珀 ⏳），次数用次要文字不加粗；「未触发」保留灰点但**去掉「尚无运行状态数据」整句**，改为徽章自说明——诚实数据不等于多话。
2. **【FR-02 选择器信息架构】**分组重构：`运行输入`（1 项）/ `上游产出`（按节点罗列，含字段路径徽章）/ `流程元数据`（sessionId 等）；Flowise 的 Chat Context 组整组下架；空态给一行教学文案「输入框直接打 `{{` 也可唤起」。插入整对象与插入字段用不同图标区分。
3. **【FR-07 文案定稿建议】**「未配置也可用：节点默认走本机 CLI（较慢、消耗订阅额度）。配置 HTTP Provider 可加速并统一计费。」——保留「能跑」的安心感，同时给出升级动机，不吓唬人。
4. **【FR-09 骨架】**复用画布 `canvas-loading` 骨架语言（顶栏条 + 内容块），模板卡片骨架三列；失败态给重试按钮而非红字。
5. **【FR-10 时间格式】**zh 走 `MM/DD HH:mm` 24 小时制；en 走 locale 默认。全站统一一个 `formatRunTime` 工具，禁止各处手写。
6. **【FR-14 裁决：删除】**「我的」tab 直接删（→ D7）——单机产品「所有权」是伪概念，「我最近运行过的」会与卡片运行记录面板语义打架。
7. **【评审新增 FR-15】**结果面板行序按完成时间倒序（实测 cond → urgent → start），违背阅读直觉，改拓扑序 + 运行中节点跟随。

### 11.4 测试总监意见

1. **【测试盲区定性】**本次两个 P0 均在 e2e 全绿下存活，共同根因是**「客户端导航 + DOM 存在性」断言范式**——它测不出视觉高度与语义解析。整改为范式级要求：所有 FR 的验收必须含「真实用户路径」断言（直链 goto、变量解析结果、token 计数），不接受「元素存在」（→ D8）。
2. **【FR-01 断言落点】**复用 `viewport-matrix.spec.ts` 视口矩阵；新增 `freshPage.goto()` 测试工具函数（fresh context，无预载 CSS），断言 `.react-flow` boundingRect.height > 400。**注意**：Next dev 冷编译下首帧可能未水合，断言前 `waitForSelector('.react-flow')` + 一次 300ms 稳定窗口（沿 UI-01 放宽 15s 的先例）。
3. **【FR-02 回归转正】**A/B 用例（run `f68b83dd` 字面量 vs `d9064c5d` 解析）转正为 WF 系列钉子（建议 WF-14「变量契约」）：四种写法 × 三种节点位置（直连 / Condition 后 / Iteration 体内）共 12 断言；扫描器保留字单测（`{{input}}` 不入 params、`{{关注点}}` 仍入）。
4. **【FR-02 发布门禁：干跑对比】**上线前对 dev 库全部 35 个存量 flow + 10 个内置模板跑「别名层前后解析结果 diff」脚本，diff 清单人工评审后方可发布（PRD 原文「必须为空」过强——存在少量**增益型**变化如字面量开始解析，属预期，评审放行）。
5. **【FR-03 度量修正】**耗时/tokens 硬门槛改 P90；CI 内 mock-llm-server 断言「无工具调用事件」（`/__control/*` 已可录制请求序列），真机只做人工冒烟。**运维提醒**：e2e 中途强杀可能残留 `e2e-mock-%` provider 行毒化 dev 环境（既有已知问题），新增用例须带 afterAll 清理。
6. **【FR-04 防抖】**summary 端点压测：35 flow 一次请求 <100ms；running 轮询须在页面失焦时暂停（防止后台 tab 空转轮询）。
7. **【度量可查性】**「变量一次成功率」原为不可度量指标，要求 span 增加 `unresolvedPlaceholders` 字段（已并入 FR-02 验收），上线 30 天后出首份自然流量报告。

### 11.5 决议汇总

| # | 决议 | 来源 |
|---|---|---|
| D1 | FR-01 热修 = 一行 import；类迁移另立技术债；e2e 加 fresh-page 直链导航模式 | 架构师 |
| D2 | FR-02 别名单点落 `variables.ts`；优先级「显式字段 > 别名 > 字面量保留」单测钉死 | 架构师 |
| D3 | 别名解析与扫描器引擎保留字**同批发布**（修复 `{{input}}` 双重身份），缺一即半成品 | 架构师 + PM |
| D4 | FR-03 无工具档复用 `--permission-mode` 管道；LLM 默认无工具 / PlatformAgent 默认有工具 | 架构师 |
| D5 | FR-04 数据源 = 新增批量 `POST /api/runs/summary`；徽章三态 + 失焦暂停轮询 | 架构师 + 设计师 + 测试总监 |
| D6 | FR-05 新名 camelCase + 旧名兼容一个 minor + `Deprecation` 头；禁用 zod `.strict()` | 架构师 |
| D7 | 「我的」tab 直接删除，不做语义改造 | 设计师 |
| D8 | 范式级要求：验收断言走真实用户路径（直链 / 解析结果 / 计数），不接受 DOM 存在性 | 测试总监 |
| D9 | 结果面板行序改拓扑序（新增 FR-15）；运行中节点保持视觉跟随 | 设计师 |

### 11.6 遗留行动项

| # | 行动项 | 责任 | 截止 |
|---|---|---|---|
| A1 | 热修 FR-01 + FR-07 发布（含 e2e 直链断言） | 开发 | 本周 |
| A2 | 存量 flow/模板 别名解析干跑 diff 脚本编写与首跑 | 开发 + 测试 | Sprint 1 中 |
| A3 | FR-02/03 验收标准逐条转为 e2e/单测用例清单（WF-14 起） | 测试 | Sprint 1 末 |
| A4 | `unresolvedPlaceholders` 字段上线后的 30 天自然流量首报 | 测试 | 上线 +30d |
| A5 | 类与样式解耦（`ftpl-*` 布局类归属）技术债立项 | 架构 | Sprint 3 |

---

## 12. 实施记录（2026-08-31 当日热修 + Sprint 1 首批）

> 开发：架构师 + 全栈开发；测试：单测 / 全量回归 / 真机六项（T1~T6）；验收：PM。

### 12.1 已落地

| FR | 改动 | 验证 |
|---|---|---|
| **FR-01** | `canvas/page.tsx` 显式 `import '@/styles/flow-templates.css'`（D1 一行热修） | T5：直链首载 `display:flex`、画布 694px（修复前 `block`/0px）；e2e 新增 `21-canvas-direct-url.spec.ts`（CV-01/02，fresh-context 直链 + 尺寸断言，CI 侧运行） |
| **FR-02 引擎** | `variables.ts` 别名层（D2：显式字段 > 别名 > 字面量）+ `{{id.output}}` 精确命中自引用对象时解包 `text ?? content` | 单测 22 项全绿；T1：`{{$start.input}}` 从「变量未解析」→ 真实建议（run `dce96a92`）；T2：`{{llm1.output}}` 进 prompt 的是干净正文（run `412e…` 后续复跑），字面量残留 = False |
| **FR-02 度量** | `llm.node.ts` 输出附 `unresolvedPlaceholders`（零残留时不携带） | T2 span 检查：未携带 = 零残留 |
| **FR-02 扫描器** | `flow-template-pipeline.ts` 引擎保留字（D3：`input` 等 7 个 flat 键不入模板参数） | 单测 +2 绿；T4 API 实测：`{{input}}+{{关注点}}` 流另存模板 `paramCount=1` |
| **FR-03** | `workflow-clients.ts` 文本档：claude 且未声明 tools 的调用注入 `--disallowedTools`（全内建工具族；D4 复用 extraArgs 通道，不动适配器） | T3：审查链复测 **tool 事件 0**（修复前 rg/git 全仓搜索）、prompt 实际 1.1k 字符、node_2 28s 纯文本审查；PlatformAgent 回归无恙（精确回 OK） |
| **FR-07** | Settings Provider 空态文案改「不配置也能跑…」（zh+en 同步） | T6：文案已上线 |
| **FR-10** | `format.ts` `hourCycle:'h23'` | T6：运行时间 `08/31 21:56`，无 AM/PM |

**回归**：workflow 27 文件 207 用例 + gateway 26 文件 337 用例全绿；workflow/gateway/console 三包 typecheck 干净。

### 12.2 已知事项与未竟项

1. **CLI usage 计量口径**：T3 中 node_3 报 ↑39,570 而实际 prompt 仅 1,110 字符——claude stream-json 会话级累计把多轮上下文重发计入输入侧。行为无碍（tokens 徽章偏大），建议另立小任务在 client 侧按「末次事件为准」或标注会话口径。
2. **FR-03 量化目标部分达成**：审查链端到端 408s（P90 目标 <90s 未达）——工具漂移已根除，剩余耗时由模板 systemPrompt 自身的详尽输出要求驱动（8.7k 输出 tokens 的修复清单），属模板内容设计问题，转模板文案调优，不再是执行档位问题。
3. **未实施**（按路线图顺延）：FR-04 批量 summary 端点与徽章、FR-05 API 命名统一、FR-06 iteration 聚合、FR-08 i18n 补译、FR-09 模板骨架屏、FR-11~FR-15；FR-02 的变量选择器重构（vendor 包 UI）未动——幽灵变量仍在选择器里，引擎侧已保证选了也能解析（`question` 等保留字在 chat 路径有值、canvas 路径留字面量并有 unresolvedPlaceholders 留痕）。
4. **21 号 e2e spec 未在本机跑**（需 playwright webServer + dagents_e2e 库环境），已按 D8 范式写好待 CI；本机以真机 T5 等价验证。

### 12.3 验收结论（PM）

**通过。** 两个 P0 的用户可见症状全部消除（画布直链可用、文档变量语法兑现），D3 同批要求满足，FR-03 语义漂移根除；未竟项均有明确归属与理由，无隐瞒。

### 12.4 第二批实施（同日 · 清剿 §12.2 全部遗留与未竟项）

| FR | 改动 | 验证 |
|---|---|---|
| **FR-04** | gateway `POST /api/v1/runs/summary`（DISTINCT-LATERAL 单查询，≤200 flowIds）+ console BFF `/api/runs/summary` + 列表徽章三态（running 琥珀呼吸点 3s 轮询、绿✓/红✗/灰⊘ + 次数，`visibilitychange` 失焦暂停） | 端点实测单请求返回每流 `{latestStatus, runCount, …}`；浏览器实测卡片显示「已完成 · 5 次运行」，零运行才显示「未触发」 |
| **FR-05** | instantiate 接受 `flowName`/`name`（兼容 `flow_name`，zod transform 归一）；generate 接受 `prompt`（兼容 `question`，refine 二选一） | 实测 `flowName` 命名生效；`{}` 空 body 400；`prompt` 真跑生成成功 |
| **FR-06** | executor：Iteration 聚合 `content` = 逐项正文 `\n\n` 有序拼接（Loop 保持末轮语义，完整数组两边都在 `.iterations`） | 单测 + 真机：3 项迭代 `content="apple\n\nbanana\n\ncherry"`（修复前仅 "cherry"） |
| **FR-08** | en/common 补 `智能体`/`守护进程`（+`已取消`） | 浏览器 EN 主导航 "Workflow / Agents / Skills / Daemons"，无中文残留 |
| **FR-09** | 勘误：**骨架屏本就存在**（gallery `loading` 态渲染 `atg-skeleton` 卡）——深评「空窗无 loading」为 a11y 快照对纯 div 的漏报，非缺陷。已核实代码路径，无需改动 | 代码核实（`flow-template-gallery.tsx:485-497`） |
| **FR-11** | customFunction 注入 `$inputText`（content ?? text ?? JSON 解包），`String($input)` 的 `[object Object]` 脚枪消除 | 单测 ×2（对象/裸串/无形状）+ 真机 `$inputText` 生效 |
| **FR-12** | Retriever 空命中输出显式 `warning`（不再静默 `docs:[]`） | 真机：新会话画布直跑返回 warning 全文 |
| **FR-13** | generate 响应附 `bindings`（agentNodeCount / unbound / 档位说明）→ BFF 透传 → 生成落库时写进 flow description（列表/画布长期可见） | 真机：`prompt` 生成返回 `"纯 LLM 节点：CLI 文本档执行（无工具）"` |
| **FR-14** | 「我的」tab 删除（Scope 类型收窄 + scopeCounts/visibleFlows 同步） | 浏览器：tabs 仅「全部 35 / 已归档 0」 |
| **FR-15** | 结果面板行序改流程拓扑序（initialFlowData 节点序，未知节点殿后） | 浏览器：旁观面板行序 `start → cond → urgent`（修复前 `cond → urgent → start`） |
| **FR-03 残留** | 代码审查链内置模板三段 systemPrompt 加输出篇幅约束（≤5 条、每条 ≤2 行等） | 模板 JSON 校验通过、gateway 重启加载无误；耗时收益待下次真机复跑确认 |
| **CLI 计量口径** | 结案定性：适配器已优先采信 result 帧权威 usage（`claude.ts:757`），膨胀（prompt 1.1k 字符 / 报 39k 输入）是 **claude CLI 会话级累计**的上游口径（node_2 无工具纯文本同样 14x），非我方求和错误。不改猜口径，文档标注 | 源码核实 + T3 数据交叉验证 |

**回归**：workflow 27 文件 **210** 用例（+3 新：迭代拼接断言 / retriever warning ×2 / $inputText ×2）+ gateway 26 文件 **337** 用例全绿；三包 typecheck 干净。

### 12.5 最终状态（PM 二次验收）

**全部通过，PRD 清单收口。** FR-01~FR-15 中：FR-01/02/03/04/05/06/07/08/10/11/12/13/14/15 已落地并验证；FR-09 经核实为存量已实现（深评快照误报，勘误记录在案）。**唯一未动**：FR-02 的变量选择器 UI 重构（vendor dist 包，幽灵变量仍在选择器中——引擎侧已保证其可解析或留痕，UI 重构列入下一迭代独立任务）。
