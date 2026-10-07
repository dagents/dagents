# R4 声明式权限闭环 · 架构设计

> 文档定位：`docs/zcode-borrow/requirements.md` R4（声明式权限闭环：命令白名单 / 域名清单，fail-closed）的实施方案。只设计不写实现。
> 锚点口径：本文引用的 `path:line` 均在 2026-10-07 工作区（分支 `feat/zcode-borrow`）实读核验。
> 安全立场：fail-closed（缺席即拒、malformed 即全拒、逃生门显式）、最小惊讶（声明语义=字面集合，无隐式扩展）、每个决策有代码锚点。
> 撞车检查（2026-10-07 二轮复查，含 `design-sharp.md`）：与并行四方向的共享面均为「同文件不同段/不同字段」的追加式改动——`design-verdict.md`（R5）动 `node-registry-canvas.ts` platformAgent 段并已互认「R4 声明字段同文件追加」、动 `types/execution.ts` 的 kind 词表/chat 签名（与本文 `execRunner` 不同字段）；`design-recover.md`（R1/R2/R3/R7/R8）动 `workflows.ts` 的 runBodySchema/runAndPersist 段、`types/execution.ts` 的 ordinal 系列、`canvas-kit-page.tsx` 的 watchTick/重跑分叉（与本文 run panel 权限区不同区块）；`design-artifacts.md`（R6）动 `workflows.ts` 的 node-spans 端点段（`:899-972`）与 `metrics.ts` counter（追加式）；`design-sharp.md`（R9/R10）动 `http.node.ts` 的 trialMode skip 分支（其 §3.4-③ 落 `:86-88` 邻域、其 §⑦:330 已互认「R4 域名守卫同文件不同区块」）、`types/execution.ts` 的 trialMode 字段、`executor.ts` buildNodeContext。**同缝定序裁决（评审定稿）**：http 节点内顺序为 协议 → SSRF → **域名守卫（R4，本文 §3.1）** → trialMode skip（R10/sharp 持有）→ fetch——declared-but-violated 的静态配置错误须在试运行中暴露（守卫在 fetch 前抛、零网络副作用），skip 分支只对通过静态校验的请求生效。`validate-topology.ts` / `custom-function/*` / `flow-generator.ts` / `contracts/src/flow.ts` 及本文全部新文件为 R4 独占；`http.node.ts` 为 R4+R10 共享（两分支不同区块，定序如上）。

---

## 0. 现状基线（设计依据，全部实读核验）

| 事实 | 锚点 |
|---|---|
| customFunction 用户代码在 worker_threads 执行，`require/process/globalThis/Worker/fetch` 形参 shadow 成 undefined——**无任何命令执行通道**，头注释自认「隔离不是沙箱」 | `packages/workflow/src/nodes/custom-function/user-code-exec.ts:14-19,22-37` |
| customFunction 节点注册表只有 code / parameters 两项 | `packages/workflow/src/nodes/node-registry-canvas.ts:437-462` |
| http 节点只有协议白名单 http(s) + SSRF 私网阻断 + 重定向逐跳复检，**任意公网域名放行** | `packages/workflow/src/nodes/http/http.node.ts:74-86,120-144`、`packages/workflow/src/nodes/http/ssrf-guard.ts:77-85` |
| http 节点注册表只有 method/url/headers/body——运行时 inputs 与画布注册是两份列表（`http.node.ts:21-55` 类字段 vs `node-registry-canvas.ts:220-271`） | `packages/workflow/src/nodes/http/http.node.ts:21-55`、`packages/workflow/src/nodes/node-registry-canvas.ts:220-271` |
| `validateFlowTopology` 是纯结构校验（shape / start 唯一 / 边可达 / 孤儿 warning / platformAgent agentId warning / 环检测），错误带 `node`/`edge` 定位，warnings 全量收集 | `packages/workflow/src/utils/validate-topology.ts:19-35,172-270` |
| 引擎执行时把节点配置双形态归一：平铺 `data.<field>` 打底、嵌套 `data.inputs.<field>` 覆盖，节点统一从 `nodeData.inputs` 读 | `packages/workflow/src/engine/executor.ts:443-458` |
| gateway 保存入口（POST/PUT）不跑拓扑校验，只查 zod body 形状；运行入口只查 flowData 数组形状 | `apps/gateway/src/routes/workflows.ts:69-83,121-157,159-240,396-399` |
| `flowDataSchema` 的 data 是 zod passthrough——新字段零破坏性 schema 变更 | `packages/workflow/src/utils/flow-data.ts:16-22` |
| flows.flow_data 是 jsonb 列 | `packages/db/src/entities/flow.entity.ts:32` |
| 引擎装配单源 `assembleWorkflowEngine`：llmClient/agentFetcher/toolRegistry/flowExecutor 等宿主注入能力都挂 baseOptions，三入口（画布直跑/chat 流式/@flow）共用 | `apps/gateway/src/routes/workflow-engine-service.ts:97-109,203-251` |
| CLI spawn 闸（FIFO 排队，`DAGENTS_MAX_CLI_PROCESSES` 默认 16） | `apps/gateway/src/lib/cli-spawn-gate.ts:26,57-76` |
| `resolveCliExecutable`：三平台 spawn 目标解析（win32 PATH 探测 `.exe` 优先、`.cmd` shim 标记 `viaShell: true`），从 `@dagents/agent-adapters` 导出 | `packages/agent-adapters/src/win-spawn.ts:50-86`、`packages/agent-adapters/src/index.ts:60` |
| CLI 后端 spawn 形态：`spawn(resolved.path, args, { shell: resolved.viaShell })` | `packages/agent-adapters/src/claude.ts:452-458` |
| 逃生门先例：`DAGENTS_HTTP_ALLOW_PRIVATE=1` 每次调用现读 env，全局放行私网 | `packages/workflow/src/nodes/http/ssrf-guard.ts:69-71` |
| console inspector 声明式驱动：注册表加参数 = 配置 UI 自动出现；json 控件带「非法 JSON 红框、合法时提交解析值」 | `apps/console/src/components/flow-canvas/inspector/InspectorPanel.tsx:83-92`、`apps/console/src/components/flow-canvas/inspector/form-engine.tsx:3,198-232`、适配层 `apps/console/src/components/flow-canvas/registry/node-spec.ts:37-45` |
| 运行前确认面天然位置 = 运行输入面板；预扫先例 `extractHumanInputPrompts`（双形态归一读） | `apps/console/src/components/canvas/canvas-kit-page.tsx:949-1057`、`apps/console/src/lib/flow-human-inputs.ts:26-66` |
| 保存干跑 + 问题节点标红管线现成（复用 failed 徽章样式） | `apps/console/src/components/canvas/canvas-kit-page.tsx:743-774` |
| 生成器内容风险扫描 warning 级先例；`normalizeToCanonicalFlow` 用 `...data` 展开保真透传全部 data 字段；修复循环吃 `validateFlowTopology` 错误清单 | `apps/gateway/src/routes/flow-generator.ts:584-622,250-262,624-642` |
| 内置 JSON 模板（10 个）现状**零 http / customFunction 节点**（本次 grep `builtin/*.json` 无 `httpAgentflow|customFunction` 命中）；模板 gate 测试先例 | `apps/gateway/src/flow-templates/builtin/`、`apps/gateway/src/__tests__/builtin-templates.test.ts:25-31` |
| 活动流 kind 词表（`tool`/`tool_result` 现成）、节点内可用 `options.onNodeDelta` 发过程活动 | `packages/workflow/src/types/execution.ts:107-126,162` |
| http 节点现状**不解析模板变量**（url 声明 `acceptVariable: true` 但 run() 不调 `resolveVariables`）——静态 URL 才是现状语义 | `packages/workflow/src/nodes/http/http.node.ts:35,62-63`（对照 `llm.node.ts:103-104` 有解析） |

---

## 1. 数据模型与迁移

### 1.1 结论：零新表、零新列、零 DB 迁移

- **声明随 flow JSON 走**：`allowedCommands: string[]`（customFunction 节点 data）、`allowedDomains: string[]`（http 节点 data），存进 `flows.flow_data` jsonb（`packages/db/src/entities/flow.entity.ts:32`）。`flowDataSchema` data 是 passthrough（`packages/workflow/src/utils/flow-data.ts:16-22`），新字段往返保真；布局静默 merge 只动 position/viewport 不触碰 data 字段（`apps/gateway/src/routes/workflows.ts:284-307`）。
- **run 行不加白名单快照列**：run 启动时引擎持有 flowData 对象引用，run 进行中改 flows 表不影响本次 run（`workflows.ts:396` 读出后传引用进 `executor.execute`，`workflows.ts:498`）；裁决发生在节点执行时、数据源就是该引用——无快照需求。与 R8 的「persona 创建期冻结」不同：R8 冻结的是**运行期可变的库行**（`workflow-clients.ts:920-951` 每次实时读库），R4 的 flow_data 是启动时一次性读入的不可变快照，问题不存在。
- **过渡期开关是环境变量不是配置表**：`DAGENTS_HTTP_DOMAIN_POLICY ∈ {'warn' | 'enforce' | 'off'}`，默认 `'warn'`（v1 过渡期）。先例：`DAGENTS_HTTP_ALLOW_PRIVATE` 现读 env（`ssrf-guard.ts:69-71`）、`CUSTOM_FN_TIMEOUT_MS`（`user-code-exec.ts:46`）。产品翻转默认值 = 改代码默认 + CHANGELOG 记录版本线（OQ-4 终裁时点），不为一次性过渡建 DB 配置面。

### 1.2 存量数据策略（不迁移任何行）

| 存量对象 | 策略 | 依据 |
|---|---|---|
| 用户存量 http flow（无 allowedDomains） | 过渡期 `warn`：放行 + 过程流活动行留痕 + gateway 计数；`enforce` 生效后拒绝 | requirements.md R4 需求 6 / OQ-4 建议方案 |
| 用户存量 customFunction flow（无 allowedCommands） | **行为零变化**——命令通道是新增能力，缺席=通道不存在，与现状全封一致，无需过渡 | requirements.md R4 需求 1「缺席 = 通道不存在 = 全封（与现状零命令能力兼容）」 |
| 内置 JSON 模板 | 现状零 http/customFunction 节点（§0 核验），无需补声明；gate 测试加断言钉住「凡出现此类节点必须带合法声明」，防未来新增模板缺席 | `builtin-templates.test.ts:25-31` 先例 |
| `flow_templates` 表（用户/团队保存的模板） | **不自动改写用户数据**（自动补 `allowedDomains` 是臆测语义）；提供一次性扫描脚本报告缺席清单（运维知悉），实例化后用户在画布自行声明；模板 flow 经实例化落库时走保存门（§3.3） | AC-R4-6 口径「扫描断言零缺席」以「内置 + gate 断言 + 扫描脚本」组合达成 |
| flow-generator 产物 | prompt 规则教 LLM 产出声明 + `validateFlowTopology` 新错误进修复循环（自动修复）——生成侧「全量带声明」由校验器强制而非自觉 | `flow-generator.ts:624-642` validate() 吃 verdict.errors |

### 1.3 词表/枚举安全

无 DB CHECK、无枚举列变更——NFR-1「词表收紧类迁移强制预检」不适用，本文档范围内**零迁移**即零风险；gateway 单测库 `dagents_gw_test` 迁移链不受影响（不改迁移链）。

**与 `run_node_spans` status CHECK 的关系（全体阻塞项核验，零依赖）**：该表建表即带 `run_node_spans_status_chk CHECK (status IN ('running','done','failed','paused','unknown'))`（`packages/db/src/migrations/1720000007000-create-run-node-spans.ts:57-58`，本次实读核验；后续迁移 1720000014000/1720000093000/1720000098000 均未触碰该 CHECK）。R4 的全部拒绝语义（域名被拒 / `$exec` 被拒 / invalid 全拒）都走**节点抛错** → `IExecutedNode.status='failed'` → span-writer 落现有 `'failed'`（`apps/gateway/src/span-writer.ts:212` `en.status === 'failed' ? 'failed' : 'done'`）——**零新 span status 值**，对 design-sharp 持有的 CHECK 放宽迁移（`1720000106200`，词表 `+ 'rejected','cached','stopped'`）零依赖、无先行/时序要求。

---

## 2. 契约变更（@dagents/contracts + @dagents/workflow 类型面）

### 2.1 `packages/contracts/src/flow.ts`（追加式，纯类型）

```ts
/** 节点级权限声明（R4，2026-10-07）——随节点 data 走，data 保持 passthrough。 */
export interface NodePermissionDeclarations {
  /** customFunction：受控命令通道白名单（裸命令名数组）；缺席 = 通道不存在。 */
  allowedCommands?: string[]
  /** http：请求与重定向目标域名清单（hostname 精确匹配）；缺席按网关策略裁决。 */
  allowedDomains?: string[]
}
```

`FlowNode.data` 保持 `Record<string, unknown>`（`contracts/src/flow.ts:17`）不收紧——声明是「节点类型专属约定」而非全节点通用 schema，收紧会误伤 10 类节点的其余 data 字段。此类型是编译期文档 + 共享词面（`'allowedCommands'`/`'allowedDomains'` 字符串字面量类型），防三处消费点（引擎守卫 / console 预扫 / gateway preflight）手抄字段名漂移。

### 2.2 `packages/workflow/src/types/execution.ts`（追加式）

`IExecutionContext` 追加宿主注入的受控命令执行通道（与 `flowExecutor` 同模式，引擎 DB-free / spawn-free）：

```ts
/** 受控命令执行请求（R4）：engine 校验白名单后转发宿主执行。 */
export interface ControlledExecRequest {
  command: string            // 裸命令名（引擎侧已校验 ∈ allowedCommands）
  args: string[]             // 参数原样透传（no-shell spawn，无注入面）
  allowedCommands: string[]  // 该节点声明白名单（gateway 二次复核用，纵深防御）
  timeoutMs?: number         // 单次执行超时（缺省 15s，上限 60s）
  signal?: AbortSignal       // worker 超时/取消级联
}
export interface ControlledExecResult {
  code: number | null
  stdout: string   // 32KB 截断（保头 60% + 标记 + 保尾 40%）
  stderr: string   // 同上
  truncated: boolean
}
export interface IExecutionContext {
  // …现有字段不变…
  /** 受控命令执行（R4）：宿主注入（gateway controlled-exec.ts）；未注入 = 通道不存在 = 全拒。 */
  execRunner?: (req: ControlledExecRequest) => Promise<ControlledExecResult>
}
```

锚点：`execution.ts:134-247`（IExecutionContext 现有宿主注入位 `flowExecutor` `:242-246` 是同款先例）。

### 2.3 新文件 `packages/workflow/src/utils/flow-permissions.ts`（本方向独占，权限单源）

全仓权限「读 / 验 / 判 / 投影」唯一实现，四类消费点（拓扑校验器、http 节点守卫、customFunction 节点、console 确认面预扫、gateway preflight）全部 import 此处——AC-R4-4「同源常量」的物理载体：

| 导出 | 职责 | 关键设计 |
|---|---|---|
| `readNodePermission(node, field)` | 双形态归一读（嵌套 `data.inputs.<field>` 覆盖平铺 `data.<field>`） | **与 executor merge 同规则**（`executor.ts:443-453`）、与 `resolveAgentId`（`validate-topology.ts:72-79`）、`extractHumanInputPrompts` 的 read（`flow-human-inputs.ts:42-45`）同款。返回 `{ kind: 'absent' }` \| `{ kind: 'declared', values: string[] }` \| `{ kind: 'invalid', reason }`。**语义阶梯（fail-closed 心脏）**：`undefined/null/''/空白串` → absent；`[]` → **declared-empty（显式声明空集 = 全拒）**；非空非数组或含非法项 → invalid（运行时全拒 + 拓扑 error） |
| `isValidDomainEntry(s)` | 域名条目格式：RFC 1123 hostname 或 IP 字面量，1-253 字符；**禁 port/scheme/path/通配符**（v1 无 `*.example.com`） | v1 精确匹配是闭集语义；通配符属 v2 扩展（届时回本设计修订） |
| `isValidCommandEntry(s)` | 命令条目格式：`/^[A-Za-z0-9][A-Za-z0-9._@:+-]{0,63}$/`——**裸命令名，禁路径分隔符 `/` `\`、禁空白** | v1 不支持绝对路径白名单：PATH 解析语义由 `resolveCliExecutable` 提供（`win-spawn.ts:50`）、模板可移植、白名单不绑定机器路径。子命令属 args（`docker compose` → 声明 `docker`） |
| `isDomainAllowed(hostname, values)` | 小写化精确匹配 | — |
| `httpDomainPolicy()` | 现读 `DAGENTS_HTTP_DOMAIN_POLICY`，默认 `'warn'` | 先例 `privateHttpAllowed()` 现读 env（`ssrf-guard.ts:69-71`） |
| `assertAllowedHttpDomain(url, state, what)` | http 节点运行时守卫（抛错面向 flow 作者） | 见 §3.1 判定表 |
| `extractFlowPermissions(flowData)` | 全图投影：`{ commandNodes: [{nodeId, label, commands}], domainNodes: [{nodeId, label, domains}], undeclaredHttp: string[], invalid: TopologyError[] }` | 确认面 / gateway preflight / 审计共用；内部逐节点调 `readNodePermission`（同源） |
| `validatePermissionDeclarations(flowData)` | 声明合法性 → `TopologyError[]`（带 node 定位） | 被 `validateFlowTopology` 内部调用（console 干跑 / 生成器修复循环自动生效）**且**被 gateway 保存/运行入口独立调用（服务端硬门） |
| 常量 | `MAX_DOMAINS_PER_NODE=32`、`MAX_COMMANDS_PER_NODE=16`、`MAX_ENTRY_LEN=253/63` | 防千条目清单；超限 → invalid（error） |

**守卫判定表（`assertAllowedHttpDomain`，http 节点专属）**：

| 声明状态 × 策略 | warn（v1 默认） | enforce | off |
|---|---|---|---|
| declared + 域名 ∈ 清单 | 放行 | 放行 | 跳过本守卫（SSRF 仍生效） |
| declared + 域名 ∉ 清单（含 declared-empty） | **拒绝** | **拒绝** | 跳过 |
| absent | 放行 + `onNodeDelta` 活动行留痕（NFR-6 不静默） | **拒绝**（错误带「如何声明」指引） | 跳过 |
| invalid | **拒绝（deny-all）** | **拒绝** | 跳过 |

> 关键裁决：**invalid 一律 deny-all，与策略无关**——这是封死「改一道 JSON 绕过」的运行时不变量：恶意者把 `allowedDomains` 写成垃圾形状，不能被当成「未声明」享受过渡期放行（requirements.md R4 背景「fail-closed 若只写进校验器不进运行前置，改一道 JSON 就绕过」的直接回应）。declared-but-violated 在**任何策略**下都拒绝（含 warn 期）——AC-R4-1/AC-R4-5 的 e2e 因此不依赖策略配置，确定性更好。

**与 SSRF 叠加**：域名守卫插在协议校验之后、`assertPublicHttpUrl` 之前后皆可，设计取「协议 → SSRF → 域名」顺序（先挡最通用的），两层都过才放行（requirements.md R4 需求 3）。

---

## 3. 引擎 / 路由 / gateway 改动

### 3.1 http 节点域名守卫（`packages/workflow/src/nodes/http/http.node.ts`）

1. `run()` 读 `nodeData.inputs.allowedDomains`（executor 已 merge 双形态，`executor.ts:443-458`）→ `readNodePermission` 归一。
2. 首跳：`parsedUrl` 协议校验（`http.node.ts:74-82`）与 `assertPublicHttpUrl(parsedUrl)`（`:86`）之后调 `assertAllowedHttpDomain(parsedUrl, state, \`节点 ${nodeData.id}\`)`。
3. 重定向循环：`nextUrl` 协议校验（`:134-136`）与 `assertPublicHttpUrl(nextUrl)`（`:137`）之后同款调用——**逐跳复检同清单**（复用 `:120-144` 结构）。
3a. **同缝定序（与 design-sharp 的 trialMode skip 分支，评审裁决写死）**：`run()` 内校验链最终顺序为 **协议 → SSRF → 域名守卫（本守卫）→ trialMode skip 分支（R10，`options.trialMode?.http === 'skip'` 短路）→ fetch**。理由：declared-but-violated 是**静态配置错误**，试运行（skip 模式）本就该暴露它——守卫在 fetch 前抛、零网络副作用、试跑面板即见拒绝文案；skip 分支只对通过静态校验的请求生效（即 sharp 侧「skip 路径同样先过声明校验再短路」）。warn 期缺席放行的 URL 在 skip 模式照常走 skip 分支（缺席非违规）。
4. 错误文案（面向 flow 作者、直接出现在节点失败 span 上，对齐 `assertPublicHttpUrl` 的 `ssrf-guard.ts:77-85` 风格）：
   - 域名未列：`HTTP 节点 {nodeData.id}：目标域名 {host} 未在 allowedDomains 声明（已声明：api.github.com, …）——在节点配置「域名清单」补充后重试`（满足 AC-R4-1「错误含节点 id 与未声明域名」的字面要求——span 层的 nodeId 定位之外，消息文本自带）。
   - enforce 期缺席：`HTTP 节点 {nodeData.id}：未声明 allowedDomains（网关已启用 enforce 策略）——在节点配置中声明域名清单，格式 ["api.github.com"]`。
   - invalid：`HTTP 节点 {nodeData.id}：allowedDomains 声明非法（{reason}）——修复格式；修复前本节点所有请求都被拒绝`。
5. warn 期缺席放行时发 `options.onNodeDelta?.({ type: 'activity', kind: 'log', label: '域名清单未声明（过渡期放行）: {host}' })`（kind 词表现成，`execution.ts:111-112`）——过程流留痕，不静默。

### 3.2 customFunction 受控命令通道

**架构：用户代码永不直连 child_process；worker RPC → 引擎白名单裁决 → 宿主 execRunner 受控 spawn。**

#### 3.2.1 `user-code-exec.ts`（worker 执行器扩展）

- **异步支持（向后兼容契约扩展）**：`WORKER_SOURCE` 的求值改 `Promise.resolve(fn(...)).then(ok).catch(err)`——现状「函数体同步 return」约定（`user-code-exec.ts:49-51` 注释）升级为「同步 return 或 return Promise」，旧同步代码零影响。
- **`$exec` 形参注入**：`new Function(...)` 形参表追加 `'$exec'`（`user-code-exec.ts:27-31`）。**通道缺席时 `$exec` 是 undefined**——用户代码调用 `$exec(...)` 抛 `TypeError`，worker catch 回传；节点层把它翻译成结构化错误：`customFunction 节点 {id}：$exec 不可用——本节点未声明 allowedCommands；在节点配置「命令白名单」声明后方可调用命令`（AC-R4-2「无声明 → 受控 exec 通道不可用（调用即结构化错误带指引）」）。
- **RPC 协议（父侧驱动，`runUserCode` 内）**：
  1. worker 侧 `$exec(cmd, args?, opts?)` 把 `{ __exec: { id, cmd, args } }` postMessage 给父，返回按 `id` 对账的 Promise；
  2. 父侧（引擎，持**可信白名单**——来自 nodeData 非 worker 消息）裁决：`cmd ∈ allowedCommands`（`isValidCommandEntry` 形状 + 精确匹配）否则回 `{ __execResult: { id, ok: false, error: '命令 {cmd} 未在 allowedCommands 声明（已声明：…）' } }`；
  3. 通过则调 `opts.execRunner({ command, args, allowedCommands, timeoutMs, signal })`——`execRunner` 未注入（宿主没提供通道）也回结构化错误（同「通道不存在」语义）；
  4. settle（超时/取消/正常返回）时 terminate worker 并 abort 全部在途 exec（`AbortSignal` 级联），杜绝「worker 死了子进程还在跑」。
- **白名单持有方裁决（安全关键）**：`allowedCommands` 从 customFunction 节点读（`nodeData.inputs.allowedCommands`，merge 后），**绝不由 worker 消息携带**——worker 里的用户代码是攻击面，不能自报家门。锚点：`custom-function.node.ts:50-58`（节点读 inputs 的现有模式）。
- **用户代码不可指定 cwd / env**：cwd 由 run 级注入（见 3.2.3）；请求体里没有这两个字段——闭集。

#### 3.2.2 `custom-function.node.ts`（节点接线）

读 `allowedCommands` → 传 `runUserCode` 新 opts `{ allowedCommands, execRunner: options.execRunner }`；每次 `$exec` 经 `options.onNodeDelta` 发 `kind: 'tool'` / `kind: 'tool_result'` 活动行（label=命令名、detail=参数/输出全文——契约 `execution.ts:114-126`「采集层保全文」）——终端/轨迹/摘要三视图**零改动**即可见每条命令（`run-terminal-format.ts`/`run-trace-model.ts` 的 kinds 白名单已含 tool/tool_result，见 requirements.md R5 现状锚点 `run-trace-model.ts:88-96`）。

#### 3.2.3 gateway 受控 spawn 层（新文件 `apps/gateway/src/lib/controlled-exec.ts`，本方向独占）

`assembleWorkflowEngine` 构造并挂 `baseOptions.execRunner`（`workflow-engine-service.ts:209-215` 一处注入——画布直跑 / chat 流式 / @flow / resume / 子流程递归装配**全部路径自动继承**，子流程 `:156-166` 同款）：

1. **白名单二次复核**：`req.command ∈ req.allowedCommands`（引擎已裁过，gateway 再裁——两层都过才放行，与「域名+SSRF 叠加」同哲学；防引擎侧回归）。
2. **spawn 闸**：`acquireCliSlot('custom-exec')`（`cli-spawn-gate.ts:57`）——R4 需求 7「继承 CLI spawn 闸」的字面落实；`DAGENTS_MAX_CLI_PROCESSES` 总量护栏覆盖命令通道。
3. **目标解析**：`resolveCliExecutable(command)`（`win-spawn.ts:50`，`@dagents/agent-adapters` 已导出 `index.ts:60`）。
4. **`viaShell === true` → 拒绝**（win32 `.cmd`/`.bat` npm shim）：shell spawn + 用户可控 args 是命令注入面（cmd.exe 引号语义不可靠）。fail-closed：受控通道只接受直启可执行文件；错误文案指引「Windows 请安装原生二进制（.exe）或改用 POSIX」。这是有意的平台不对称，宁拒不裸奔。
5. **spawn 形态**：`spawn(resolved.path, args, { shell: false, cwd: opts.cwd, env: process.env, signal, windowsHide: true })`——**无 shell = 无注入面**；cwd = run 的项目目录（`workflows.ts:422-439` 解析的 runCwd 经 assemble 注入，与 CLI 节点同源 `workflow-engine-service.ts:56-57`）；env 继承网关进程（与 CLI 后端 spawn 同姿态，`claude.ts:453-458`；终端 PTY 的最小环境注入是后续可选硬化项，不进 v1）。
6. **超时**：缺省 15s（`DAGENTS_CUSTOM_EXEC_TIMEOUT_MS` 可调，上限 60s、禁 0）；超时 SIGTERM → 1s 宽限 → SIGKILL（POSIX）/ `treeKill`（win32 `taskkill /T /F`，`win-spawn.ts:98-114` 现成）。
7. **输出截断**：stdout/stderr 各 32KB，保头 60% + 对账标记 + 保尾 40%——与 http 节点响应截断同款哲学（`http.node.ts:147-155`）。
8. **指标**：`declareCounter('dagents_custom_exec_total', …, ['result'])`（`metrics.ts:57` 先例；`result ∈ {allowed, denied, timeout, shell_rejected}`）——NFR-6 可观测锚点。

### 3.3 gateway 路由门（`apps/gateway/src/routes/workflows.ts`）

三道门 + 一条审计，与节点层守卫构成纵深（节点层是最终不变量，路由层是提前失败与 UX）：

| 门 | 位置 | 行为 |
|---|---|---|
| ① 保存门 | `POST /`（`workflows.ts:121-157`）与 `PUT /:id`（`:159-240`）：`data.flowData !== undefined` 时调 `validatePermissionDeclarations` | invalid → `422` + located errors（沿用 `fail(c, 422, …, { errors })` 形态，`flow-generator.ts:713-720` 先例）。**只拒声明非法，不跑全量拓扑校验**——草稿自由（环可存不可跑）是现状语义（console 干跑不阻断，`canvas-kit-page.tsx:746-749`），本设计不扩大拒绝面，最小惊讶 |
| ② 运行门 | `POST /:id/run`（`:367` 起）在 flowData 形状检查（`:396-399`）后：`validatePermissionDeclarations` + `extractFlowPermissions` | invalid → `422`；`undeclaredHttp` 非空且 `httpDomainPolicy() === 'enforce'` → `400`（错误列出缺席节点 id + 指引）——enforce 期把「跑到 http 节点才炸」提前到提交时；`warn` 期放行 + `dagents_permission_undeclared_http_runs_total` 计数 |
| ③ 节点门 | §3.1/§3.2 运行时守卫 | 最终不变量：任何路径（含绕过路由门的 resume / answer / chat @flow——`resume-execution.ts`、`chat-execute.ts` 不加重复 preflight，节点层天然覆盖）改 JSON 都封不死 |
| 审计 | run 路由 preflight 后：闭合集非空（有命令声明或有域名声明）时 `recordAudit(c, { action: 'workflow.run', target: { type: 'workflow', id }, detail: { permissions: 摘要 } })` | 新 action 名（现有 `workflow.create/update/delete`，`workflows.ts:151,234,338`——无冲突）；只记有声明的 run，低频不淹审计日志 |

### 3.4 生成器（`apps/gateway/src/routes/flow-generator.ts`）

1. **prompt**（`buildWorkflowGeneratorPrompt` `:59-121`）Rules 追加两条：`For httpAgentflow nodes, set data.inputs.allowedDomains to the exact hostnames the flow may call (requests and redirects are rejected on any other host)`；`customFunctionAgentflow nodes that need shell commands MUST set data.inputs.allowedCommands (bare command names); $exec() is unavailable without it`。
2. **归一保真**：`normalizeToCanonicalFlow` 的 `...data` 展开（`:258`）已透传新字段——零改动（本次实读核验）。
3. **风险扫描升级**（`scanGeneratedFlowRisks` `:584-622`）：① http 节点未声明 `allowedDomains` → warning（含节点 id + 过渡期说明）；② 已声明且 url 是静态可解析 URL 时 hostname ∉ 清单 → warning（模板变量 URL 跳过静态判定，诚实留给运行时守卫）；③ customFunction 代码文本出现 `$exec` 而未声明 `allowedCommands` → warning。现状 customFunction 泛警告（`:589-598`）保留。
4. **修复循环自动生效**：`validate()`（`:624-642`）吃 `validateFlowTopology` 错误清单——声明非法（error 级）自动进入修复轮，生成侧「全量带声明」由校验器强制（AC-R4-6 的生成器半边）。

### 3.5 拓扑校验器（`packages/workflow/src/utils/validate-topology.ts`，追加式）

在 platformAgent agentId warning 循环（`:239-248`）之后追加：遍历节点，`resolveNodeType(node)`（`:60-65`）为 `httpAgentflow` / `customFunctionAgentflow` 时，`validatePermissionDeclarations` 产出的 errors 并入 `errors` 数组（**error 级非 warning**——非法声明不可执行，AC-R4-3 口径），全量收集原则保持（`:171`）。错误带 `node: node.id` 定位 → console 保存干跑 toast + `applyRunStates` 标红管线（`canvas-kit-page.tsx:753-767`）**零改动**复用——「与环检测同体验」。

### 3.6 注册表（`packages/workflow/src/nodes/node-registry-canvas.ts`，追加式）

- http 节点 inputs（`:226-260`）追加：`{ label: '域名清单', name: 'allowedDomains', type: 'json', rows: 3, description: 'JSON 字符串数组（如 ["api.github.com"]）——请求与重定向的每个目标域名必须在列；留空 = 未声明（过渡期放行，网关 enforce 后拒绝）' }`；`defaultData` 加 `allowedDomains: ''`。
- customFunction 节点 inputs（`:443-456`）追加：`{ label: '命令白名单', name: 'allowedCommands', type: 'json', rows: 3, description: 'JSON 字符串数组（如 ["git","rg"]）——声明后代码内可用 $exec(cmd, args) 执行白名单命令；留空 = $exec 不可用' }`；`defaultData` 加 `allowedCommands: ''`。
- 运行时 inputs（`http.node.ts:21-55` / `custom-function.node.ts:32-48`）同步加声明项（description 同文案）——运行时注册（节点类 inputs 字段）与画布注册（`node-registry-canvas.ts`）是两份列表（现状如此），同批改齐。
- console inspector **零代码改动**：`node-spec.ts:37-45` 适配层直通 CANVAS_NODES，json 控件（`form-engine.tsx:198-232`）即时校验 + 合法时提交解析值——`['api.github.com']` 数组从 json 控件直接产出，用户无需手写嵌套 inputs。

### 3.7 明确不纳入（诚实边界）

- **platformAgent CLI Bash 工具授权面**（`--allowedTools` 旗标映射）：OQ-3 已裁不进 R4 v1。`workflow-clients.ts:277-280` 的 `--disallowedTools` 反向先例留在原地。
- **`http_request` 内置工具**（`workflow-clients.ts:962-1023`，platformAgent 工具循环用）不受 allowedDomains 管辖——它属于 platformAgent 授权面（同上一条边界）；其 SSRF 守卫（`:987`）现状不变。「闭环了 http 节点 ≠ 闭环了全部出站面」，此边界写进 docs/workflow-engine.md 防误读。
- **子流程（executeFlow）**：子流程节点在运行时经 `flowExecutor` 递归装配（`workflow-engine-service.ts:139-177`），其内部 http/customFunction 节点**各自声明、各自裁决**（节点层守卫天然覆盖）；根图确认面只展示根图闭合集（子流程目标 flow 是运行期才解析的另一个文档）——确认面如实标注「子流程内的声明以子流程画布为准」。

---

## 4. console 改动

### 4.1 运行前确认面（`apps/console/src/components/canvas/canvas-kit-page.tsx`）

运行输入面板（`:951-1057` `canvas-run-panel`）内、HumanInput 预答区（`:997-1007`）之后新增**权限确认区**（新组件 `RunPermissionSummary`，建议落独立文件 `apps/console/src/components/canvas/run-permission-summary.tsx` + 就近 `run-permission-summary.css` 显式 import——孤儿 CSS 护栏，`apps/console/scripts/check-orphan-css.mjs` 挂 lint）：

- 数据源：`useMemo(() => extractFlowPermissions(editorRef.current?.getDocument()), [flowDataVersion])`——**与执行层同一投影函数**（AC-R4-4 同源）。预扫先例 `extractHumanInputPrompts` 同款接线（`canvas-kit-page.tsx:180` import、`:997` 消费）。
- 展示：
  - 闭合命令集：按节点分组 `节点 {label}：$exec 允许 {git, rg}`（全图聚合 + 节点来源，含「$exec 实际调用在白名单内即放行——运行时裁决」诚实提示，因为 cmd 是用户代码运行期字符串）；
  - 闭合域名集：按节点分组 `节点 {label}：允许域名 {api.github.com}`；URL 静态可解析时逐条比对 hostname ∈ 清单，不一致打黄点（运行时必拒的提前可见）；URL 含 `{{…}}` 显示「含变量——运行时守卫裁决」；
  - 缺席黄警：`{n} 个 HTTP 节点未声明域名清单——当前过渡期放行，网关 enforce 后将拒绝运行`（`undeclaredHttp`）；
  - invalid 声明：红条列出节点 id + 原因（与保存干跑同源错误）。
- 零新增交互负担：确认区是只读信息面板，「开始运行」按钮（`:1046-1054`）不新增勾选步骤——声明的裁决权在执行层，确认面是知情面不是二次授权面（最小惊讶；与 HumanInput 预答的「必须填」不同类）。

### 4.2 inspector 编辑面：零代码改动

§3.6 注册表加字段后，`InspectorPanel.tsx:83-92` 自动渲染 json 控件（含即时校验红框）。格式级错误（数组外形状/非法条目）由保存干跑 `validateFlowTopology` 报并标红（§3.5）——json 控件管「JSON 合法」，拓扑校验管「条目合法」，两层提示分工与 req-console.md R4 缺口 3 的预判一致。

### 4.3 i18n（NFR-4）

新文案全部 `t('中文')` 自然键 + `apps/console/src/i18n/en/flows.ts` 补英文词条（文件现状 `flows.ts:6` 起 Record<string,string> 追加式）：确认区标题（`权限确认`）、命令集行、域名集行、缺席黄警、运行时裁决提示、invalid 红条等约 8-10 条。

**查重结论（全体 i18n 条目核验，2026-10-07）**：拟用键（权限确认 / 命令白名单 / 域名清单 / 过渡期放行 / 运行时裁决 / 未声明 等概念词）对六模块词典（`apps/console/src/i18n/en/` 的 common/agents/flows/daemons/settings/chat）grep 查重——**零同名冲突**（既有命中仅 `chat.ts:194`「疑似权限受限」、`settings.ts:296-297/357`「通知权限」系，字面不同）。词典是六模块 spread 全局合并（`en/index.ts:13-20`，顺序 common→agents→flows→daemons→settings→chat，**settings/chat 在 flows 之后展开、同名键静默压过 flows**）——实施守则：① 新键全进 `flows.ts` 且不得与 settings/chat 既有键同字面（提交前对两文件 grep 一遍）；② 模块内同键重复是 TS 编译错（先例教训：「等待输入」`flows.ts:201` 已存在，勿重加）；③ 不复用/不新增「已拒绝」（`settings.ts:288` 已有 'Denied'，且 R4 拒绝文案是服务端 span error 非 UI 词条，不进词典）。

### 4.4 生成器对话框：零改动

升级后的 `scanGeneratedFlowRisks` warnings 随 generate 响应返回（`flow-generator.ts:693-696`），GenerateFlowDialog 现有 warnings 展示管线自动可见。

---

## 5. 兼容与存量 run 数据策略

| 面 | 策略 |
|---|---|
| 存量 flow_data | 零迁移（§1.2）；jsonb passthrough 往返保真（`flow-data.ts:16-22`） |
| 存量 run / spans | **零影响**——R4 不改 run/span 形状、不改状态词表（R3 的事）；历史 run 的节点错误渲染不变 |
| 现有单测 | http.node.test.ts 现有用例的 makeNodeData 无 allowedDomains（`http.node.test.ts:7-15`）→ `warn` 默认放行全绿；user-code-exec.test.ts 现有同步用例 → Promise.resolve 包装向后兼容全绿（`user-code-exec.test.ts:14-27` 同步 return 用例是回归钉子） |
| 现有 e2e | e2e flow-builder 支持 http 节点（`tests/e2e/helpers/flow-builder.ts:88`）；`warn` 默认下未声明放行——现有 e2e 零破坏（NFR-2）；新 e2e 用「declared-but-violated」路径断言拒绝，不依赖策略 env |
| 老版本 console + 新 gateway | 新字段在老 inspector 不可编辑，引擎照跑（data passthrough）；422 响应对老 console 是保存失败 toast——可接受（声明非法本就该拒） |
| 新 console + 老 flow | 确认面显示缺席黄警，行为同现状（warn 放行） |
| resume / answer / chat @flow 路径 | 不加重复 preflight（§3.3 门③说明）；这些路径的 flowData 均经保存门落库或与画布同源，节点层守卫覆盖全部执行路径（含子流程递归装配 `workflow-engine-service.ts:156-166`） |
| 模板实例化 | 模板 flowData 落库走 POST /（保存门拦截 invalid 声明）；未声明模板走 warn 过渡 |
| flow-generator 修复循环 | 声明非法是 error 级 → 自动进修复轮（§3.4.4），生成失败率不劣化 |

---

## 6. 测试计划

### 6.1 单测（vitest，`packages/workflow`）

| 文件 | 用例 | 对应 AC |
|---|---|---|
| `utils/flow-permissions.test.ts`（新） | ① `readNodePermission` 双形态 + 冲突（nested 覆盖 flat）+ 语义阶梯（`''`→absent、`[]`→declared-empty、垃圾→invalid）；② 域名/命令格式边界（port/scheme/路径分隔符/通配符/空白全拒；合法 hostname/IP/命令名通过）；③ `isDomainAllowed` 大小写；④ `extractFlowPermissions` 聚合（混合图：http×2 + customFunction×1 + 无关节点）；⑤ `validatePermissionDeclarations` 错误带 node 定位；⑥ 条目数上限 | AC-R4-3、AC-R4-4 |
| `nodes/http/http.node.test.ts`（追加） | ① 声明 `['api.github.com']` 请求 `api.gitlab.com` → throw，错误含节点 id + 未声明域名 + 已声明清单（mock fetch 形态沿用 `http.node.test.ts:23-27`）；② 重定向 302 跳未声明域名 → 同样拒绝（mock 首跳 302 + location）；③ enforce 策略（env 注入）+ 缺席 → throw 带指引；④ warn + 缺席 → 放行且 onNodeDelta 收到留痕活动行；⑤ `[]` declared-empty → 拒绝；⑥ invalid → 拒绝 | AC-R4-1 |
| `nodes/custom-function/user-code-exec.test.ts`（追加） | ① 无 allowedCommands → `$exec` undefined/结构化错误；② 声明 `['git']` 调 `$exec('git', […])` → mock execRunner 收到请求且结果回流；③ `$exec('curl')` ∉ 白名单 → 结构化错误（含已声明清单）且 execRunner 零调用；④ 异步 return（`return (async () => …)()`）正常回传——同步用例（现有）不回归；⑤ worker 超时 → 在途 exec 被 abort（execRunner 收到 signal abort） | AC-R4-2 |
| `utils/validate-topology.test.ts`（追加） | 域名格式错 / 白名单非数组 / 条目超限 → errors 带 `node` 定位、warnings 全量收集原则不破坏（合法图 warnings 照常） | AC-R4-3 |
| **同源钉子**（`flow-permissions.test.ts` 内） | 对 flat / nested / 冲突三形态 fixture：`extractFlowPermissions` 输出的 commands/domains **逐字等于** executor merge 后 `nodeData.inputs.<field>` 值（用与 `executor.ts:448-453` 相同的 merge 规则构造）——UI 说的和守卫放的是同一集合 | AC-R4-4 |

### 6.2 gateway 单测（`apps/gateway/src/__tests__/`）

| 文件 | 用例 |
|---|---|
| `controlled-exec.test.ts`（新） | ① 白名单复核拒绝（引擎漏裁兜底）；② spawn 闸计数（`resetCliSpawnGateForTest` 隔离，先例 `cli-spawn-gate.test.ts`）；③ 超时强杀（真 spawn `sleep`/`node -e`）；④ 输出 32KB 截断；⑤ viaShell 分支拒绝（注入假 resolved）；⑥ `/metrics` 文本含 `dagents_custom_exec_total` |
| `workflow-permissions.test.ts`（新，`app.request()` 形态沿用 `flow-templates.test.ts:187`） | ① PUT 非法声明 → 422 + located errors；② PUT 合法声明/拓扑带环 flow → 照常 200（草稿自由不扩大拒绝面）；③ run invalid → 422；④ enforce + 未声明 → 400；⑤ warn + 未声明 → 放行且指标递增；⑥ 有声明 run 产生 `workflow.run` 审计行 |
| `flow-generator-risks.test.ts`（追加） | 未声明域名 warning / `$exec` 未声明 warning / 静态 URL 不在清单 warning（沿用现有 describe 模式 `flow-generator-risks.test.ts:6`） |
| `builtin-templates.test.ts`（追加） | gate 断言：模板含 httpAgentflow 节点 → 必须带合法 allowedDomains；含 customFunctionAgentflow 且代码用 $exec → 必须带合法 allowedCommands（现状零此类节点 = 断言空转通过，未来新增模板强制带声明） | 

### 6.3 e2e（`apps/console/tests/e2e/`）

| 用例 | 场景 | AC |
|---|---|---|
| `28-permission-guard.spec.ts`（新；编号避让——verdict/artifacts/sharp 三方拟占 25，评审建议分配 25/26/27，本方向取 28） | ① 恶意 flow：http 节点声明 `allowedDomains: ['allowed.test']`、URL `https://blocked.test/x` → 运行 → 节点 failed，span error 含 `blocked.test` 与节点 id（守卫在 fetch 前抛，零真实网络依赖，确定性）；② customFunction 声明 `allowedCommands: ['node']`、代码 `$exec('node', ['-e','console.log(1)'])` → 成功且活动流含 tool 行；代码改 `$exec('sh', …)` → 节点失败带指引；③ 确认面：同 flow 打开运行面板 → 权限确认区展示命令/域名清单（选择器断言文案） | AC-R4-5、AC-R4-2、AC-R4-1 的 UI 面 |
| 运维脚本 | `scripts/scan-template-permissions.mjs`（新）：扫 `flow_templates` 表 + 内置 JSON，输出缺席声明清单（exit code 非零当且仅当扫描失败，缺席仅报告——不阻断 CI）；AC-R4-6 的清点仪器 | AC-R4-6 |

### 6.4 明确不测（诚实边界）

- DNS rebinding / 真实逃逸（worker constructor 链）——沿用 ssrf-guard.ts:10-11 与 user-code-exec.ts:14-18 的既有取舍声明，不假装覆盖。
- platformAgent Bash 授权面（OQ-3 边界，§3.7）。

---

## 7. 涉及文件清单（ownedFiles）

**独占（本方向新建 / 唯一改动方）**：

- `packages/workflow/src/utils/flow-permissions.ts`（新）
- `packages/workflow/src/utils/flow-permissions.test.ts`（新）
- `apps/gateway/src/lib/controlled-exec.ts`（新）
- `apps/gateway/src/lib/controlled-exec.test.ts`（新）
- `apps/gateway/src/__tests__/workflow-permissions.test.ts`（新）
- `apps/console/src/components/canvas/run-permission-summary.tsx` + `run-permission-summary.css`（新）
- `apps/console/tests/e2e/28-permission-guard.spec.ts`（新；编号避让 25/26/27，见 §6.3）
- `scripts/scan-template-permissions.mjs`（新）
- `docs/zcode-borrow/design-permission.md`（本文档）

**追加式（共享文件，本方向只追加不重构）**：

- `packages/contracts/src/flow.ts`（+NodePermissionDeclarations；R1/R7 动 run-live.ts 不碰此文件主体）
- `packages/workflow/src/types/execution.ts`（+execRunner 契约；R5/R8 同文件追加——错峰合入）
- `packages/workflow/src/utils/validate-topology.ts`（+声明规则段；R9c 动 severity 字段——两段互不重叠）
- `packages/workflow/src/nodes/http/http.node.ts`（+域名守卫；**与 design-sharp 共享**——其 trialMode skip 分支同文件 `:86-88` 邻域，同缝定序「域名守卫在前、skip 在后」见 §3.1-3a 与头部撞车检查，其 §⑦:330 已互认）
- `packages/workflow/src/nodes/custom-function/custom-function.node.ts`、`user-code-exec.ts`（+$exec 通道）
- `packages/workflow/src/nodes/node-registry-canvas.ts`（+两处 inputs；R5 加 outputSchema——纯追加）
- `packages/workflow/src/index.ts`（barrel：+flow-permissions 导出、+ControlledExec 类型）
- `apps/gateway/src/routes/workflows.ts`（+三道门/审计；R1/R2 动 resume/spans 段——不同函数体）
- `apps/gateway/src/routes/flow-generator.ts`（prompt + 风险扫描）
- `apps/gateway/src/routes/workflow-engine-service.ts`（+execRunner 注入一行式；R1/R2/R8/R10 大动该文件——本方向改动限于 baseOptions 组装处）
- `apps/gateway/src/lib/metrics.ts`（+两个 counter 声明）
- `apps/gateway/src/__tests__/builtin-templates.test.ts`、`flow-generator-risks.test.ts`（+断言/用例）
- `packages/workflow/src/nodes/http/http.node.test.ts`、`custom-function/user-code-exec.test.ts`、`utils/validate-topology.test.ts`（+用例）
- `apps/console/src/components/canvas/canvas-kit-page.tsx`（运行面板内挂 RunPermissionSummary；R1/R2/R3/R6 同文件大动——本方向改动限于 run panel 区块）
- `apps/console/src/i18n/en/flows.ts`（+词条）
- `docs/workflow-engine.md`（现状与限制节：$exec 通道 + 权限边界说明）、`AGENTS.md`（节点体系一句话 + 配置节 `DAGENTS_HTTP_DOMAIN_POLICY`/`DAGENTS_CUSTOM_EXEC_TIMEOUT_MS`）

---

## 8. 分步实施（可恢复性友好：每步独立可合入、可回滚）

### 第 0 步【地基——契约 + 校验器 + 引擎核心守卫】（PR-1，纯 packages/workflow + contracts）

1. `contracts/src/flow.ts` 类型 + `workflow/src/index.ts` barrel 导出
2. `utils/flow-permissions.ts` + 单测（纯函数零依赖，任何宿主可测）
3. `validate-topology.ts` 声明规则 + 测试（console 保存干跑自动获得标红——零 console 改动）
4. `http.node.ts` 域名守卫（首跳 + 逐跳）+ 测试 → **AC-R4-1、AC-R4-3 引擎侧达成**
5. `node-registry-canvas.ts` + 运行时 inputs 注册（inspector 编辑面自动出现）

> 地基可独立发布：warn 默认下行为兼容（§5），是后续一切的上承。

### 第 1 步【受控命令通道】（PR-2）

6. `types/execution.ts` execRunner 契约；`user-code-exec.ts` RPC + 异步支持 + 测试
7. `custom-function.node.ts` 接线（白名单持有方 = 节点）+ 活动行
8. `apps/gateway/src/lib/controlled-exec.ts`（闸 + resolve + no-shell + viaShell 拒 + 超时 + 截断 + 指标）+ 测试
9. `workflow-engine-service.ts` 注入 execRunner → **AC-R4-2 达成**

### 第 2 步【路由门 + 生成器 + 模板】（PR-3）

10. `workflows.ts` 保存门 / 运行门 / 审计 + 路由测试
11. `flow-generator.ts` prompt + 风险扫描 + 测试（修复循环自动生效）
12. `builtin-templates.test.ts` gate 断言 + `scripts/scan-template-permissions.mjs` → **AC-R4-6 达成**

### 第 3 步【console 确认面 + i18n】（PR-4，可与 PR-3 并行）

13. `RunPermissionSummary` 组件 + canvas-kit-page 挂载 + en 词条 → **AC-R4-3 UI 面、AC-R4-4 钉子测试达成**

### 第 4 步【e2e + 文档】（PR-5）

14. `xx-permission-guard.spec.ts`（declared-but-violated 主路径）→ **AC-R4-5 达成**
15. `docs/workflow-engine.md` / `AGENTS.md` 更新（含 §3.7 诚实边界成文）

### OQ-4 终裁后的翻转步（独立小 PR）

16. `httpDomainPolicy()` 默认值 `warn → enforce` + CHANGELOG 版本线 + e2e 全量回归（enforce 下未声明 run 400 的既有用例适配）。

---

## 9. 风险与裁决记录

| 风险 / 裁决点 | 处置 |
|---|---|
| **受控命令通道是新增攻击面**（requirements.md R4 风险原话「设计评审重点」） | 五层缓解：① no-shell spawn（无注入面）；② 裸命令名白名单（禁路径/空白）；③ worker 消息不可携带白名单（持有方=节点/engine）；④ spawn 闸 + 超时 + 输出截断 + treeKill；⑤ viaShell（.cmd shim）一概拒绝。评审时按此清单逐项过 |
| invalid = deny-all 是否过狠（合法 URL 也被拒） | 是有意为之：malformed 声明不可回退成「未声明」享受放行（否则 JSON 篡改即绕过）；拓扑校验 error + 保存门 422 保证用户在保存时就看见，不会带到运行时才发现 |
| `[]` = declared-empty = 全拒 vs 当作未声明 | 显式声明空集是用户意图（「这个 http 节点哪儿都别去」），当 absent 处理会让 enforce 语义说谎；fail-closed 侧取全拒，UI 描述文案明示 |
| 确认面与放行集「两张皮」漂移 | 同源物理载体 `extractFlowPermissions`（§2.3）+ 同源钉子单测（§6.1）双保险；不依赖文档约定 |
| enforce 翻转时点 | OQ-4 产品终裁；机制（env + 默认值）先行，翻转是独立小 PR（§8 步 16），不与功能交付耦合 |
| http URL 模板变量现状不解析（§0 末行） | 不在本方向修（行为面变更另行立项）；守卫挂在最终请求 URL 上，未来补 resolveVariables 后守卫语义不变——设计对「URL 从哪来」无假设 |
| 与 R9d 上限词汇对齐 | `$exec` 被拒 / 域名被拒 = 节点级失败（span failed + 错误文案），不产生新 run 终态；R9d 对照表落档时按「节点拒绝档」归类（本设计不预写 R9 的表） |
| **[评审·全体] run_node_spans status CHECK** | 建表 CHECK 五词表（`1720000007000:57-58` 实读核验）；R4 零新 span status 值（拒绝全走 `failed`，`span-writer.ts:212`），对 sharp 持有的 `1720000106200` 放宽迁移零依赖、无时序要求——R4 任何批次不因该迁移阻塞（§1.3） |
| **[评审·权限闭环+工试] http.node.ts 同缝定序** | 裁决采纳：域名/声明校验在前、trialMode skip 在后（§3.1-3a）——试运行须暴露 declared-but-violated 静态配置错误；sharp 侧「真发路径 R4 守卫照常生效」之外补「skip 路径同样先过声明校验再短路」由其文档落同款定序 |
