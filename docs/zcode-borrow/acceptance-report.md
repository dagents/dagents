# zcode-borrow 终验收报告（R1–R10）

> 分支 `feat/zcode-borrow` @ `eb7c874`（2026-10-08 21:18 提交）· 验收日期 2026-10-08 · 需求定稿 `docs/zcode-borrow/requirements.md`（PRD v1.3，十项需求 58 条 AC）
> 素材：五路验收结论（可恢复性 / 权限闭环 / 提交裁决 / 渐进产物 / 工程决策与试运行）、终门禁退出码、分支提交链。
>
> **两段验收时点**（两段验的不是同一棵代码树，差异面见「门禁与复测记录」第 5 条）：五路验收结论基于 `2f2e39a` + 未提交工作区修复批（五路自述 19 修改 + 7 新文件，恰为 eb7c874 的 26 文件集）；终门禁三绿基于 `eb7c874`（= 该工作区 + 其后两处非行为性修复 + dist 重建）。
>
> **证据口径标注**（本报告三种来源，逐条注明）：
> - 【五路】= 五路验收员在验收轮实跑的命令与输出（含其临时测试，跑后已删）；
> - 【批次】= 各实现/集成批次在 `docs/zcode-borrow/dev-notes.md` 的定向实跑记录；
> - 【本报告】= 本报告撰写时在本工作区实跑核验（命令随文给出；核验时 `git diff HEAD -- apps packages` 为空，即代码文件与 eb7c874 逐字节一致）。
> - **判词与证据强度分档**：「通过【五路末轮】」= 验收轮实跑判定；「通过（单测）/（直连集成）」= 仓内常驻测试绿（终门禁 test=0 含）；「通过（等价模型）」= e2e 型 AC 的替代证据形态（依据见下条总则）；「通过（实现面†）」= **弱证据档**——无专属测试，证据 = 源码核验 + 邻近单测（全报告共 2 处：AC-R2-5 / AC-R8-6，已在 notCovered 第 4 条集中披露）。
>
> **e2e 型 AC 的裁决总则**：PRD 中标注（e2e）的 AC，验收轮受「禁跑 e2e / 禁启常驻服务」任务约束，按五路验收既定口径以**等价证据形态**判定——单测 / gateway 测试库直连集成（`dagents_gw_test` + `app.request` 全链路）/ kill 停止发射模型。此为验收约束下的**降档判定，不等价于真 e2e**（真实进程边界、浏览器行为、SSE 断连重连未覆盖）；受影响条目在逐条表标注「等价模型」并于 notCovered 第 1 条披露，真 e2e 复跑列建议后续 #2。
>
> 本报告对五路证据引用的承重锚点做了逐处抽验（清单与方式见**附录 A**）。

---

## 一、结论

> **复验补记（2026-10-08 晚，本报告定稿后）**：建议后续 #1 已执行——AC-R2-3 端到端复验**通过**，
> 并固化为常驻 gateway 集成测试 `apps/gateway/src/__tests__/warm-cache-lineage-tokens.test.ts`
> （真跑前驱 → 回填 tokens/usage_events → `warmFromRunId` 重跑：断言 R2.1 谱系书写、cached span
> tokens 继承、journal `lineage.inheritedTokens`、`usage_events` 零重复记账、node-spans 信封
> `lineageTokens` 口径一致；vitest 实跑 1 passed / 233ms）。该测试全链经 `@dagents/workflow`
> **dist** 的引擎消费段，兼作 src↔dist 漂移门禁。据此 R2 由「有条件通过」升级为**整体通过**，
> 十项全部通过；下方正文保持验收时点判定口径，不追改。

- **十项需求全部实现落地，终门禁三绿**：`pnpm typecheck` / `pnpm lint` / `pnpm test` 退出码均 **0**（素材给定；批次记录见「门禁与复测记录」节）。
- **五路验收末轮实判 37 条：36 项通过 + 1 项未通过**。另有 1 条**已计入** 36 中的 AC-R3-1 附分句级缺口注记——它不是第三个互斥分类，勿作三桶读：
  - 36 项通过 = 可恢复性 7 + 权限闭环 6 + 提交裁决 6 + 渐进产物 5 + 工程决策与试运行 12；
  - 1 项未通过 = **AC-R2-3**（验收时点 `packages/workflow/dist` 未重建，gateway 运行时缺 seedTokens 消费——时点性正确判定，详见 R2 节；修复前置已由终门禁完成，端到端复验未重跑，列遗留）；
  - AC-R3-1 附注（计入 36 内）= 其「预算重新起算」黄警分句无行为断言（AC 主体双路径行为已实证通过，五路明示「不再单独判 failed」）。
- **十项归并（验收时点口径）：9 项整体通过（R1/R3/R4/R5/R6/R7/R8/R9/R10），R2 有条件通过**——条件 = AC-R2-3 端到端复验；**该条件已由页首复验补记达成：R2 升级为整体通过，十项全部通过**。（原判词：修复源码链各环节单测齐全 + dist 已重建核验，唯缺「重建后」的全链路复跑；见 R2 节专段，不追改验收时点判定。）
- 计数口径说明：可恢复性方向的 `passed=7` 是**末轮复测**判定数——修复批次触碰 **8 条** AC（R1-6 / R2-2 / R2-3 / R3-1 / R3-4 / R7-1 / R7-3 / R8-2），判定 **7 过 1 未过**；该方向其余 21 条 AC（29 − 8）未在末轮重判，以前轮验收与仓内测试库存为据——即逐条表中**不带**【五路末轮】标记、标注「通过（单测）/（等价模型）/（实现面†）」的条目。其余四方向的 passed 数即其 AC 全数（6/6、6/6、5/5、12/12）。

---

## 二、十项逐条

### R1 Journal 确定性重放与 resume —— ✅ 通过

| AC | 结论 | 证据 |
|---|---|---|
| AC-R1-1 kill gateway → stopped(interrupted) → resume 零重调（e2e） | 通过（等价模型；e2e 未跑，见 notCovered） | 【批次】`boot-sweep.test.ts`（三件收敛：runs→`stopped(interrupted)`、悬空 span、checkpoint→`resumable`）；【五路】`journal-replay-superset.test.ts`（kill=停止发射模型：订阅者已收每帧 ⊆ journal 行集、seq 对齐后 canonical 逐字节相等） |
| AC-R1-2 迭代 per-ordinal resume 只重跑断点项 | 通过（单测） | 【五路】`packages/workflow/src/__tests__/executor-resume.test.ts` 19 例全绿（含 seedTokens 继承追加两例）；【批次】`journal-writer.test.ts:111-135`（(nodeId, ordinal) 幂等 upsert + per-ordinal 多档）、`recover-seed.test.ts`（itemNodeOutputs 组装） |
| AC-R1-3 input_hash 漂移响亮失败 | 通过（单测） | 【批次】`executor.ts:133`（不一致抛 `SeedHashMismatchError`，错误带 nodeId + expected/got hash）；`executor-resume.test.ts`（地基批） |
| AC-R1-4 hash 确定性 | 通过（单测） | 【批次】`packages/workflow/src/utils/input-hash.test.ts`（canonicalJson 键序无关） |
| AC-R1-5 迁移兼容存量 | 通过 | 【五路】`recover-seed.test.ts`（checkpoint 兜底、老 run 无 seedHashes 照旧种子化）；gateway vitest globalSetup 自动建/迁移 `dagents_gw_test` 每轮通过；【批次】e2e `24-run-resume.spec.ts` 3/3 回绿（集成批实测记录） |
| AC-R1-6 UI 三消费点收尾定格 | **通过【五路末轮】** | 【五路】`apps/console/src/components/workflow-run-card.tsx` 终态词 chip（`wf-run-state`）+ `workflow-run-card.test.tsx`（词表全集 clearInterval、已中断/已停止渲染）——`cd apps/console && npx vitest run …workflow-run-card.test.tsx` 11 测绿（与其余两文件合计） |

**遗留**：AC-R1-1 的真 e2e（实杀网关进程 + 断连重连）未跑；`26-run-recovery.spec.ts` 未新增（设计即裁给统一把关，本报告核验确认仓内不存在该文件）。

### R2 修订重跑暖缓存 —— ✅ 通过（AC-R2-3 经 2026-10-08 复验补记通过；下文保留验收时点判定）

| AC | 结论 | 证据 |
|---|---|---|
| AC-R2-1 暖缓存命中/受影响子图保守 | 通过（单测；e2e 未跑） | 【批次】`warm-cache.test.ts` 6 例（全链命中 / 改第 3 节点 prompt→1-2 命中 3-4 全 miss 传递闭包专项 / 改输入全 miss / lookup 抛错 / 诚实 miss）；【五路】复测轮 6 例随返回形状改动适配后仍绿 |
| AC-R2-2 cached 徽章 + 终端无假 CLI 行 | **通过【五路末轮】** | 【五路】`run-terminal.tsx` cached 段「⚡ 来自缓存」（`.rtl-cmd-cached`）+ `run-terminal-cached.test.tsx`；`SPAN_STATUS_MAP` cached→⚡ 徽章 |
| AC-R2-3 token 对账（继承+新增双口径、零重复记账、口径一致） | **通过（复验补记 2026-10-08）**；验收时点原判「未通过」保留于专段 | 常驻测试 `__tests__/warm-cache-lineage-tokens.test.ts`（见专段复验补记） |
| AC-R2-4 前驱被 retention 清理后诚实 miss | 通过（单测） | 【批次】`lineage.test.ts` 断链例（被清前驱不进候选）+ `warm-cache.test.ts` 诚实 miss 例 |
| AC-R2-5 FlowRunsPanel 暖缓存 lineage chip | 通过（实现面†） | 【本报告】`apps/console/src/components/flow-runs-panel.tsx:223-228`（「暖缓存自：{id}」chip，源码核验）；【批次】`run-status.test.ts` STATUS_LABEL 单源 8 例（邻近词表单测，非该 chip 的组件测试） |

**AC-R2-3 专段（唯一未过项）**：
- 五路验收判定：**仍未通过**——验收时点修复以未提交工作区变更交付（后落 `eb7c874`），源码链各环节齐全且分别有测试，但 `packages/workflow/dist/index.js`（构建于 20:30:45）不含 20:51:41 的源码修改（`grep -c seedTokens` = 0）；gateway 经 package.json exports 解析 dist，引擎侧消费逻辑不在运行时。直连集成实证：`buildWarmCacheSeed` 真库返回正确含 `seedTokens`（gateway src 新代码），但新 run 的 cached span `tokens=null`、journal lineage 无 `inheritedTokens`（断点在 dist 里的引擎消费段）。
- **判词依据**：验收时点的「未通过」是时点性正确判定（运行时确实缺消费逻辑），不追改；当前树修复前置已满足但端到端未复跑——故 AC-R2-3 维持「未通过（待复验）」，R2 整体判「**有条件通过**」：其余 4 条 AC 全过 + 本条源码链各环节单测齐全（executor-resume 19 测 / recover-seed / warm-cache / run-tokens，终门禁 test=0 含）+ dist 已重建核验，所缺仅「重建后」的一次全链路复跑。
- **修复前置已由终门禁完成**【本报告核验】：`stat` —— `packages/workflow/dist/index.js` = Oct 8 **21:13:06**（晚于源码 `executor.ts` 20:51:41）；`grep -c seedTokens packages/workflow/dist/index.js` → **4**、`grep -c inheritedTokens` → **1**。即验收结论指出的「重建后复验」前置条件已满足。
- 修复源码链（五路核阅 + 本报告抽验）：`warm-cache.ts:99/116/146/155`（planWarmCacheSeeds 产 seedTokens）→ `workflows.ts:629`（resume 原样传入）→ `resume-execution.ts` / `execution-resume.ts`（resume/answer 两路透传）→ `executor.ts:670-687`（cached `nodeEnd.tokens = seedTokens` + `lineage.inheritedTokens`）→ `workflows.ts:1136-1142`（node-spans 信封 `lineageTokens` = 链上前驱 usage_events SUM）→ `run-tokens.ts`（`dualBasisTokens`）→ `canvas-results-panel.tsx:757-761`（「谱系继承 M · 本次新增 N · 合计 T」双口径行）。
- 维持达成的子句【五路】：usage_events 零重复记账（暖缓存 run 计数 0 实证）、lineageTokens 端点（`recover-budget-resume.test.ts` 真库断言 warm=500 / 根=null）、run-tokens.test 绿、账单口径一致。
- **遗留**：「dist 重建后」的端到端复验（前驱 journal tokens → `warmFromRunId` 重跑 → cached span 继承 + lineage）未重跑——验收轮的临时集成测试已删、无对应常驻测试；建议固化为常驻测试（见「建议后续」#1）。
- **复验补记（2026-10-08）**：上述遗留已闭环——常驻测试 `apps/gateway/src/__tests__/warm-cache-lineage-tokens.test.ts` 真跑全链：directReply 微图前驱 run（引擎落真实 inputHash 决策）→ 回填 `payload.tokens`（total 500）与 `usage_events`（300+200）→ 同输入 `warmFromRunId` 重跑 → 断言谱系书写（`runs.resumed_from_run_id` 指向前驱）、cached span `tokens.total_tokens`=500（继承侧）、journal `lineage.inheritedFromRunId/inheritedTokens`、暖缓存 run `usage_events` 计账 0（零重复记账）、node-spans 信封 `lineageTokens`=500（与账单同源，口径一致）。vitest 实跑 1 passed / 233ms；断言路径经 `@dagents/workflow` dist 的引擎消费段——dist 陈旧时 cached span `tokens=null` 即红，兼作 src↔dist 漂移门禁（建议后续 #1 的防复发锚）。

### R3 结算状态机 cancel ≠ fail —— ✅ 通过

| AC | 结论 | 证据 |
|---|---|---|
| AC-R3-1 取消/failed/budget_exceeded 的 resume 三态 | **通过【五路末轮】**（黄警分句见遗留） | 【五路】`recover-budget-resume.test.ts`（真库 + mock startWorkflowExecution 捕获 req）：携 tokenBudget=5000 覆盖生效 / 缺省沿用 runs.input 3000 / 老 run 无预算 undefined / 非法值 400 四态 |
| AC-R3-2 kill → (stopped, interrupted) 可 resume | 通过（等价模型，同 AC-R1-1） | 【批次】`boot-sweep.test.ts` + `recover-seed.test.ts`（checkpoint→resumable 后种子组装） |
| AC-R3-3 toRunStatus 单源 + 词表双钉 | 通过（单测） | 【批次】`recover-status.test.ts` 12 例（三入口一致）+ `recover-db-check.test.ts` 3 例（information_schema 读 CHECK 九值/五值与 TS 词表逐字一致，词表外值 INSERT/UPDATE 双路拒收） |
| AC-R3-4 UI 收尾 + 轮询泄漏修复 | **通过【五路末轮】** | 【五路】`workflow-run-card.test.tsx`（fake timers：partial_success 终态 clearInterval、推进 5s 零新增 fetch、六终态逐一钉）；`run-status.test.ts`（TERMINAL_RUN_STATUSES 双读 stopped+cancelled） |
| AC-R3-5 存量 cancelled 双读不回归 | 通过（单测） | 【批次】`run-status.test.ts`（STATUS_LABEL 九态 + 双读）；recover-db-check（cancelled 显式保留在 CHECK） |
| AC-R3-6 superseded 通知抑制 | 通过 | 【五路·工程决策】`run-notify-ws.test.ts` 5/5（superseded+非终态零发射）+【批次】console `use-task-notification.test.tsx` / `run-notify-claim.test.ts`（14 例） |
| AC-R3-7 summarizeWatch 不再折 failed | 通过 | 【批次】`canvas-kit-page.tsx` cancelled 分支独立于 failed（routes 批交付，dev-notes 记录） |

**遗留**：AC-R3-1 伴随披露分句「过程流有『预算重新起算（谱系链累计已耗 X）』黄警」无行为断言——实现存在（`resume-execution.ts:377-391`，携预算且 resumedFromRunId 时沿谱系链 `lineageTokensSpent` 发 activity 帧），但现有测试 mock 掉 `startWorkflowExecution`（不真执行），黄警帧发射未被任何测试捕获。分句级缺口，不影响 AC 主体判定。

### R4 声明式权限闭环 —— ✅ 通过（6/6）

| AC | 结论 | 证据【五路】 |
|---|---|---|
| AC-R4-1 http 域名 fail-closed + 重定向逐跳复检 | 通过 | `flow-permissions.ts:203-231` assertAllowedHttpDomain + `http.node.ts:93-94/117`（首跳）`:189-190`（重定向逐跳）；命令 `pnpm --filter @dagents/workflow exec vitest run src/nodes/http/http.node.test.ts src/nodes/custom-function/custom-function.node.test.ts src/nodes/custom-function/user-code-exec.test.ts src/utils/flow-permissions.test.ts src/utils/validate-topology.test.ts` → 5 文件 **98 测全绿**（`http.node.test.ts:186-220`：NodeRejectedError + fetch 零调用 + 302 跳未声明域同拒） |
| AC-R4-2 $exec 受控通道（缺席=通道不存在） | 通过 | `custom-function.node.ts:77-86/133-137` + `user-code-exec.ts:148-151/210-229` + `apps/gateway/src/lib/controlled-exec.ts:94-103`（白名单二次复核）/`:124`（spawn 闸）/`:154-159`（shell:false）；`cd apps/gateway && pnpm exec vitest run src/__tests__/workflow-permissions.test.ts src/__tests__/controlled-exec.test.ts` → 17 测绿 |
| AC-R4-3 非法声明保存即报 + 画布标红 | 通过 | `validate-topology.ts:305-306` + `workflows.ts:161-163/212-214`（PUT/POST 422 带 node 定位）+ `canvas-kit-page.tsx:897-921`（复用环检测红边管线）；`validate-topology.test.ts:398-419` + gateway 422 断言 |
| AC-R4-4 确认面与放行集同源 | 通过 | `flow-permissions.ts:34-39` PERMISSION_FIELDS 单源 + `flow-permissions.test.ts:275-313` 逐字一致钉子；console `run-permission-summary.test.tsx` 8 测绿（【本报告】组件文件在位核验） |
| AC-R4-5 恶意 flow 拦在执行层 | 通过 | 验收员临时集成测试（SQL 直插绕过保存门 → POST run 同步）3/3：span rejected + run partial_success + 错误文案三场景全断言；执行层管道 `executor.ts:817-851` |
| AC-R4-6 模板与生成器产物零缺席 | 通过 | `node scripts/scan-template-permissions.mjs` exit 0（内置 10 模板 + dev 库 flow_templates 1 行均零缺席）；`builtin-templates.test.ts` 等 4 文件 42 测绿 |

**附注（如实）**：flow_templates 表侧扫描为报告级而非 CI 阻断层（OQ-4 过渡期口径，缺席仅报告不阻断）；内置 JSON 半边有 CI gate。`DAGENTS_HTTP_DOMAIN_POLICY` 默认仍 `warn`（enforce 翻转待 OQ-4 产品终裁）。

### R5 结构化提交裁决 —— ✅ 通过（6/6）

| AC | 结论 | 证据【五路】 |
|---|---|---|
| AC-R5-1 违规回喂修复、上游零重调 | 通过 | 引擎级临时测试（真实 DagExecutor + mock llmClient 分流）1 passed：上游恰 1 次调用、修复消息含 path/期望/实际、输出 json 深相等；`platform-agent.node.test.ts` 15 测（三值裁决 describe 全量） |
| AC-R5-2 claude 档 --resume 会话守恒 | 通过（真机覆盖断言 ①③；② 由单测承担） | PRD:254 三断言：① 修复轮 `result.sessionId` 与原始轮相同（会话 id 守恒）；② 过程流无「会话重建」活动行；③ CLI spawn 计数每轮恰 +1。真机（本机 claude CLI 2.1.211 两轮）：① TURN2 spawn argv 含 `--resume e9bc7e1b…` 且返回 sessionId 同值（输出「PASS: session id conserved across --resume」）；③ 适配器日志恰两次 spawn（两轮两 spawn = 每轮 +1）；② 真机 smoke 未断言过程流，由单测覆盖（两档对照测 A 档无「会话重建」行 + resume 失守回落重放测）；`claude.lifecycle.test.ts -t resume` 1 绿（argv 实录）；`workflow-clients-resume.test.ts` / `workflow-clients-recover.test.ts` 16 测 |
| AC-R5-3 修复成功带 json / 两轮耗尽诚实失败 | 通过 | `platform-agent.node.test.ts`（恒违规恰 3、恒空文本恰 2、截断优先、非 JSON/围栏 JSON）；`json-schema-lite.ts` expected/got 五分支 |
| AC-R5-4 非 claude 档降级一致性 | 通过 | 两档对照测（A 档 resume / B 档重放 +「会话重建」活动行）；`span-writer-verdict-db.test.ts`（verdict 活动真库落 run_node_spans.output JSONB） |
| AC-R5-5 inspector outputSchema 控件 + 行内错误 | 通过 | 临时 UI 测试 2 passed（json 控件红框/合法对象 onChange）；`form-engine.tsx:198-230`；`canvas-results-panel.tsx:955-957`（canvas-result-err-inline） |
| AC-R5-6 交互预算 ≤3 钉死 | 通过 | `platform-agent.node.ts:20-25` VERDICT_MAX_INTERACTIONS=3 硬编码无 env 旋钮（【本报告】`grep` 确认）；恒违规恰 3 次断言 |

**附注（如实）**：e2e `25-agent-verdict.spec.ts` 未跑（存在，:107-252 覆盖 AC-R5-1/4/5/6）；/metrics 运行态读数未断言（以「每 chat 恰一次 execute/spawn」单测 + 真机两轮恰两 spawn 等价核验）。

### R6 渐进产物与失败抢救 —— ✅ 通过（5/5）

| AC | 结论 | 证据【五路】 |
|---|---|---|
| AC-R6-1 失败 run 产出清单 + runs.output 语义不变 | 通过 | `run-deliverables.test.ts` **22 测绿**（gateway 测试库；中途失败 run 终态响应 deliverables=['s1','d1','d2'] + runs.output=null 断言 :496-582）；验收员临时集成测试 ①：SQL 断言 output IS NULL OR 'null'::jsonb |
| AC-R6-2 长跑中断/失败渐进呈现 | 通过 | 临时集成测试 ②：runs (stopped,interrupted) → node-spans 信封 runStopReason + deliverables=['n1','n2','n3']；词表边界（stopped/rejected 不进产出清单）22 测内 |
| AC-R6-3 resume 种子节点清单幂等 | 通过 | `journal-writer.test.ts:93-135`（cached decision 带 lineage + 幂等 upsert）；临时集成测试 ③：清单恰 2 条、种子恰 1 条 |
| AC-R6-4 聚合区与单节点行同一提取单源 | 通过 | `packages/contracts/src/run-deliverables.ts:52-74` extractDeliverableText 单源（12 测搬家钉子）；`run-terminal-format.test.ts:185` 同一性断言 |
| AC-R6-5 子流程归属标注 + 终端锚点 | 通过 | `canvas-results-panel.tsx:311-494`（继承/子流程 chip）+ `:561-576` jumpToTerminalSection 双 rAF 锚点；`run-terminal-anchor.test.tsx` 2 测；console 四文件 46 测绿 |

**附注（如实）**：e2e `26-run-deliverables.spec.ts`（4 用例）验收轮未跑；实现/集成批曾实跑 4/4 全绿（dev-notes:257-258 记录）。

### R7 事件全序与统一回放 —— ✅ 通过

| AC | 结论 | 证据 |
|---|---|---|
| AC-R7-1 kill 后回放 ⊇ 已收前缀、逐字节一致 | **通过【五路末轮】**（kill 等价模型；真 e2e 未跑） | 【五路】`journal-replay-superset.test.ts`（真库 + forRunLive×makeJournalWriter 真实组合）：「kill=停止发射」模型下订阅已收帧 ⊆ journal 行集且 seq 对齐 canonical 相等；结构帧 write-through 先落库后发帧（接收序 ≠ seq 序如实在断言口径体现） |
| AC-R7-2 seq 一一同位无空洞 | 通过（单测） | 【批次】`journal-writer.test.ts`（seq 与 emit 同计数器、(run_id,seq) 唯一、write-through 顺序）+ `run-live.test.ts`（emit seq 单调） |
| AC-R7-3 正常流零丢失 / 崩溃尾部诚实截断 | **通过【五路末轮】** | 【五路】同文件：无崩溃流 74 帧全程（跨微批阈值）+ close → journal 行数 == 发射帧数；单 run 上限拒收 + journal_overflow 留痕行【批次】 |
| AC-R7-4 跨源双 builder 逐字节一致 | 通过（单测） | 【批次】console `run-trace-model.test.ts` 跨源一致性 2 例 |
| AC-R7-5 刷新后视图一致 / 无 truncated 头部提示 | 通过（单测面） | 【批次】`execution-live-replay.test.ts`（live 404 → journal 前缀重建 hello.replay、乱序行按 seq 纠正、超上限头部截断标记、「有 runs 行但无 journal 行才真 404」） |

**遗留**：真 e2e（kill 网关 + 浏览器刷新比对）未跑；浏览器级「刷新一致」以双路投影单测 + 回放端点单测为据。

### R8 确定性会话身份与模型 pin —— ✅ 通过

| AC | 结论 | 证据【批次】 |
|---|---|---|
| AC-R8-1 会话 id 铸造确定性 | 通过（单测） | `workflow-clients-recover.test.ts`（同键同 id、异 run 异 id、ordinal 维度隔离、显式传入优先、collectRunSessions 只回 claude） |
| AC-R8-2 persona 创建期冻结 | **通过【五路末轮】** | 【五路】`persona-freeze.test.ts`（真库）：冻结装配后改 agents 行 → frozen fetcher 仍回创建期快照，对照实时 fetcher 回新值；resume 跨进程注入同款 |
| AC-R8-3 pin 禁降级响亮失败 | 通过（单测） | `workflow-clients-recover.test.ts`（modelPinned + provider 500 → providerFailure/期望模型/「因 pin 拒绝降级」活动行 + CLI 零调用；熔断开启同拒）；【本报告】`workflow-clients.ts:688-696` 错误文案核验 |
| AC-R8-4 三处模型可查 | 通过（对账单测） | `usage-events.test.ts` rollupPrimaryModel 5 例（用量最大节点 resolvedModel、双 token 命名、诚实缺席）+ runs.models / span resolvedModel（迁移 1720000111000 快照列，【本报告】文件在位核验） |
| AC-R8-5 插话 ordinal 寻址 + 409 清单 | 通过（单测） | `execution-message-ordinal.test.ts`（透传/409+活跃清单/负数归一） |
| AC-R8-6 终端提示行模型名 + pin 标红 | 通过（实现面†） | `run-terminal-format.ts` commandOf 单源（resume 重挂同模型名自动受益，`run-terminal-format.test.ts` 邻近单测）；stdin 行 `nodeId[ordinal]`；pin 失败错误含期望/实际模型（AC-R8-3 同链）——两项 UI 呈现无专属组件测试 |

### R9 工程决策包 —— ✅ 通过（5/5）

| AC | 结论 | 证据【五路·工程决策】 |
|---|---|---|
| AC-R9-1 挂起红线 ADR 落档 | 通过（文档） | 【本报告】`docs/superpowers/specs/2026-10-07-pending-state-in-memory-red-line.md` 在位；`human-input.ts:19-26` 红线论证段（「持久表只会说谎」+ 双轨判据 + ADR 互引）实读核验；三处注释互引（execution-registry / resume-execution） |
| AC-R9-2 上限语义对照表覆盖七类 | 通过（文档） | 【本报告】`docs/workflow-engine.md:99-123` 对照表实读核验：四列 10 行（并发闸/spawn 闸/迭代上限/子流程深度/重试耗尽/R4 域名/R4 $exec/R5 裁决/maxIterations 软截断/tokenBudget）+ 归类原则 |
| AC-R9-3 多入口至多一次通知 / superseded 零通知 | 通过（并发单测，载体已落地） | `run-notify-ws.test.ts` 5/5（claim 幂等、superseded 零发射、订阅维度定向）；console `run-notify-claim.test.ts` + `use-task-notification.test.tsx` 14/14（跨标签页真 BroadcastChannel 首 claim 单发） |
| AC-R9-4 repairable 不遮蔽/不阻断/节点黄警 | 通过 | `validate-topology.test.ts` 24/24（:306-330 全量返回、:267-280 不改 ok）；`executor-semantics.test.ts` 14/14（迭代超限/重试耗尽 → partial_success + span rejected 不整体翻红）；`canvas-kit-page.tsx:891-955`（保存不阻断 + waiting 黄警） |
| AC-R9-5 节点拒绝词汇三处一致 | 通过 | http/iteration/平台裁决三测 43/43（http 字面断言 `NodeRejectedError` + `/^节点被拒绝：/`）；**如实注明**：R5 侧为内容级断言（path/期望/实际文案——正是 NodeRejectedError 消息体），非字面首词断言，一致性由代码+测试内容成立 |

### R10 画布试运行 —— ✅ 通过（7/7）

| AC | 结论 | 证据【五路·工程决策】 |
|---|---|---|
| AC-R10-1 mock 命中 + 零真 provider/CLI | 通过 | `trial-run.test.ts` 内核 12 例（byNode 选择、prompt+占位符记录、stream、error/malformed 注入）；临时集成测试（本地计数假 provider）：trial 后真 provider HTTP 命中 0、span 输出为 mock 文本；「CLI spawn 0」由代码结构证实——`workflow-engine-service.ts:149-155` `llmClient = opts.llmClientOverride ?? createDefaultLlmClient(...)` 短路：默认 CLI 客户端不构造，llm/platform-agent 节点只消费注入 client；指标 `dagents_trial_mock_calls_total` |
| AC-R10-2 customFunction 真跑 | 通过（临时测试实证） | 仓内无常驻测试（如实）；验收员临时集成测试 4/4：`return {result:21*2}` → done+output 42（未被 mock 短路）、throw → failed+boom-CF-trial、死循环 → 超时 5000ms 如实呈现 |
| AC-R10-3 产物隔离三面为零 + spans/journal 照写 | 通过 | `trial-isolation.test.ts` 2/2（全链路 + 测试库直查：spans/journal 有行、checkpoint/usage_events 零行、source='trial'、listRunsHistory 缺省排除 + NULL 旧行不误伤） |
| AC-R10-4 试运行后正式 run 走原 provider | 通过 | 临时集成测试 1/1（同一 flow 先 trial 后正式 run：前者命中 0、后者命中 ≥1 + REAL-PROVIDER-OK）；trial 全路径零 llm_providers 写操作 |
| AC-R10-5 http 默认跳过 + 真发守卫照常 | 通过 | `http.node.ts:131-149` skip 分支（定序：协议→SSRF→R4 域名守卫→skip→fetch，守卫在 skip 前）；`http.node.test.ts` 21/21（:311 同缝定序零 fetch、:370 real 不短路） |
| AC-R10-6 拓扑非法拒绝带定位 | 通过 | `workflow-trial.ts:148-160`（422 与保存校验同源）；`trial-subgraph.test.ts` 10/10；临时集成测试：回边 → 422 + errors 含 node:'a' + cycle detected |
| AC-R10-7 未解析占位符可计数可定位 | 通过 | `trial-mock-llm.ts:181-190/233-240`（扫描与逐调用记录）+ `trial-run.test.ts:147/228-238`；面板徽标 + 逐调用列前 3（`trial-run-panel.tsx:351-377`） |

---

## 三、门禁与复测记录

### 终门禁（素材给定 + 批次记录）

| 门禁 | 退出码 | 备注 |
|---|---|---|
| `pnpm typecheck` | **0** | turbo 14/14 tasks（批次记录：第 1 轮曾因 `warm-cache.ts:195` TS2322（并行 seedTokens 类型流未对齐）红，修复后归零） |
| `pnpm lint` | **0** | turbo 9/9 tasks（批次记录：第 1 轮曾因 `execution-live.ts:104` prefer-const 红，修复后 0 errors；存量 warning 不挡门禁） |
| `pnpm test` | **0** | turbo 14/14 tasks（dependsOn ^build 重建 workspace 包 dist——见下条）；批次记录全套规模：workflow 380 / gateway 626+1 todo / console 515+5 skipped / contracts 20 / db 8 |

### dist 重建核验【本报告】——AC-R2-3 遗留的前置已满足

```
stat -f '%Sm %N' packages/workflow/dist/index.js packages/workflow/src/engine/executor.ts
  → Oct 8 21:13:06 2026  packages/workflow/dist/index.js   （晚于源码 20:51:41）
grep -c seedTokens      packages/workflow/dist/index.js → 4
grep -c inheritedTokens packages/workflow/dist/index.js → 1
```

验收轮指出的「dist 不含 seedTokens 消费（=0 命中）」在当前工作区已消除——终门禁的 `pnpm test`（dependsOn `^build`）完成了 `@dagents/workflow` 重建。**但「重建后复验 AC-R2-3 端到端」未重跑**（验收临时测试已删、无常驻等价物），该项维持遗留。

### 提交链（`git log --oneline main..HEAD`【本报告】）

```
eb7c874 fix(zcode-borrow): 验收问题修复与复测      ← 26 文件 +1289/-21（R1-6/R2-2/R2-3/R3-1/R3-4/R7-1/R7-3/R8-2 修复批）
2f2e39a test(zcode-borrow): 单测补齐，全量门禁绿
74758e6 feat(zcode-borrow): 五方向实现与集成收口
0ad266e feat(zcode-borrow): 五方向实现与集成收口
668a74e feat(zcode-borrow): 需求/架构文档与可恢复性地基
```

### 复测轨迹（时序与代码状态对应）

1. 五方向并行实现 → 集成收口（74758e6：词汇冲突裁决采 R9d、trial union bug、resume 缺省 input 根因修复等六项）→ 单测补齐（2f2e39a，全量门禁第一轮绿）。
2. 五路验收（对 2f2e39a + 当时的在途工作区）提出问题 → 修复批对照验收清单逐条修复（覆盖 8 条 AC，dev-notes 七节展开）。
3. 修复批以工作区变更交付（19 修改 + 7 新文件）→ 五路复测（本报告素材 JSON，时点 = 2f2e39a + 该工作区）：36 通过 / AC-R2-3 因 dist 未重建判未过（验收员明示不代为重建——dev gateway/console 在跑，AGENTS.md 禁 dev 期间 build）。
4. 其后门禁复测第 1 轮两失败点在**工作区**修复（`warm-cache.ts` TS2322——seedTokens 类型流全链对齐 ITokenUsage；`persona-freeze.test.ts` no-unused-expressions——改 `void` 表达式；两处均**非行为性修复**，dev-notes「门禁复测第 1 轮失败修复·集成批续二」记录）→ dist 重建（21:13，动手前核实 `runs_active 0`）→ **终门禁三绿** → 21:18 将上述全部（修复批 + 两处门禁修复 + dev-notes）一并提交为 `eb7c874`。【本报告】实证两修复在 eb7c874 内：`git show eb7c874:apps/gateway/src/routes/warm-cache.ts | grep -c ITokenUsage` → **7**；`git show eb7c874:apps/gateway/src/__tests__/persona-freeze.test.ts | grep -c 'void frozen.spanWriter'` → **1**。
5. **两段验收的代码状态差异**：五路复测验的 = `2f2e39a` + 修复批工作区（其文件集与 eb7c874 的 26 文件一一对应）；终门禁验的 = `eb7c874`（= 该工作区 + 上述两处非行为修复 + dist 重建）。即「五路验的代码」与「门禁绿的代码」相差至多两处类型/lint 修复（另有 dist 重建——五路复测明确因 dist 陈旧判 AC-R2-3 未过，重建正是修复动作本身），五路的行为判定结论不受该差异影响；本报告头部按两段时点分别标注。
6. 本报告撰写时 `git diff HEAD -- apps packages` 为空（代码文件与 eb7c874 逐字节一致；工作区改动仅本报告相关的三份文档）【本报告】。

---

## 四、notCovered（未覆盖面，如实列明）

1. **e2e 全程未跑（验收轮禁令）→【已于 2026-10-08 复验补记闭环】**：`apps/console/tests/e2e/` 整套未在验收轮执行——含 24-run-resume（RM-01 回归钉子）、25-agent-verdict、26-canvas-trial-run、26-run-deliverables、28-permission-guard。各 e2e 标注 AC 的验收结论均以单测 / gateway 测试库直连集成 / kill 等价模型为证据形态（五路证据逐条注明）。注：实现与集成批曾实跑部分 spec 全绿（dev-notes 记录：25 2/2、26-trial 3/3、26-deliverables 4/4、28 3/3、24 3/3），验收轮未重跑；`26-run-recovery.spec.ts`（kill 网关/暖缓存链）从未新增（设计裁给统一把关）。**复验补记（建议后续 #2 执行结果）**：全量 e2e 已在隔离栈三跑收口——首轮暴露本机 `dagents_e2e` schema 陈旧（环境性），二轮 225/231 → 6 例修复（详见建议后续 #2 条目），**第三轮全量全绿**；「kill 网关」级真 e2e 维持等价模型不立项 v1（落档 workflow-engine.md），浏览器断连重连面仍是唯一残余未覆盖点。
2. **桌面打包未覆盖**：`apps/desktop` 不在 zcode-borrow 十项范围内，本轮零验证（Electron 编排/打包/端口让位等维持既有状态）。
3. **真机 CLI 未回归**：除 claude 外（AC-R5-2 真机两轮 `--resume` 会话守恒 PASS，claude CLI 2.1.211），codex/qwen 等 15 个 docs-only 适配器的真机回归欠账维持（AGENTS.md 已知问题；nightly `real-cli.yml` 需带 CLI 的 self-hosted runner）。
4. 其他如实列明（不属于 ask 指定三项，一并披露）：
   - ~~AC-R2-3 端到端复验未重跑~~（**已闭环 2026-10-08**：常驻测试 `warm-cache-lineage-tokens.test.ts` 复验通过，见 R2 专段）；
   - ~~AC-R3-1 黄警帧发射无行为断言~~（**已闭环 2026-10-08**：`recover-budget-warning.test.ts` 真执行钉住，见建议后续 #3）；
   - AC-R10-2 无常驻测试（临时集成测试实证后删除）；
   - /metrics 运行态读数未断言（R5/R10 以单测与 spawn 计数等价核验）；
   - R2-5 / R8-6 等 UI 面以实现 + 邻近单测为据，无浏览器级验证；
   - R4 的 flow_templates 扫描为报告级非 CI 阻断层（OQ-4 过渡期口径）。

---

## 五、建议后续

1. **【已完成 2026-10-08】复验并固化 AC-R2-3**：已按本条执行——常驻测试 `warm-cache-lineage-tokens.test.ts` 落地并复验通过（详见 R2 节复验补记），兼作 src↔dist 漂移门禁。根因教训存档：workflow 包 vitest 跑 src、gateway 运行时吃 dist，src↔dist 漂移无门禁拦截——常驻集成测试是防复发的锚。
2. **【已完成 2026-10-08】跑全量 e2e**：隔离栈（fresh `dagents_e2e` + 专用网关 :8081 + Mock :4010 + console :3100）全量三跑——第一轮暴露本机 e2e 库 schema 陈旧（缺 14 轮迁移，runs 查询成片 502——**环境性非代码回归**；根治 = 整库重建 + 迁移，配方已补进 `tests/e2e/README.md`「先迁移再起网关」警告）；第二轮 225/231，6 例失败全数定性修复：WF-04/ED-07/AC-R10-5 补 `allowedDomains` 声明（enforce 默认下 spec 需声明才测得到目标语义；试运行 skip 分支定序在静态守卫后，域名未声明原样暴露是 R10 设计）、ED-03 对齐 R9d 节点拒绝档（iteration 超限 → span rejected + partial_success，弃旧 500 断言）、UI-02 定位器消歧（R6 聚合区新增同名标签）、OT-02a 点名「全新重跑」（R2 后重跑入口为两枚）；修复后五文件定向 34/34 绿，**第三轮全量全绿**。26-run-recovery（kill 网关真 e2e）裁决：**维持等价模型不立项 v1**，锚点清单与自托管 runner 升级路径落档 `docs/workflow-engine.md` 现状与限制。
3. **【已完成 2026-10-08】补 AC-R3-1 黄警行为断言**：新增 `__tests__/recover-budget-warning.test.ts`（去 mock 真执行：budget_exceeded + resumable checkpoint + 谱系账面 500 → 真实 `POST /runs/:id/resume` → directReply 真跑收敛 completed → journal event 帧 label 逐字断言「预算重新起算（谱系链累计已耗 500 tokens）——本次续跑预算 3000」；1 passed / 386ms）。
4. **【已完成 2026-10-08】OQ-4 终裁并落地**：版本线裁决——`DAGENTS_HTTP_DOMAIN_POLICY` 默认翻 `enforce`（未知值回落更严一侧；warn/off 显式逃生门，warn 放行文案与指标留痕保留）；内置模板扫描升级 **CI 阻断层**（`scan-template-permissions.mjs` 内置缺席/非法即 exit 1，ci.yml 新增 `Template permission scan` 步；flow_templates 用户数据仍报告不阻断）；文档四件同步（requirements OQ-4 终裁注记 / AGENTS.md / workflow-engine.md / CHANGELOG）。
5. **【部分完成 2026-10-08】真机 CLI 回归**：nightly `real-cli.yml` 已随批落地（self-hosted `real-cli` 标签 runner，缺 CLI 诚实 SKIP）；本机复跑冒烟——**claude PASS**（re-confirm，tiers 已 verified 一致）、**codex FAIL 属环境性**（登录 token 刷新 403 region not supported + workspace routing 超时——账号/地区限制非适配器缺陷，tiers 维持待回归不虚标）；其余适配器清欠仍需带有效登录的自托管 runner。
6. **【已完成 2026-10-08】小项清理**：console `NodeRunStatus` 同名双轨收敛（lib/flows.ts 更名 `NodeCardStatus`，kit 的 `NodeRunStatus` 为唯一持有者，语义零变化）；gateway 存量 lint warning 清零（workflows.ts 四个 unused import + resume-flow.test.ts 骨架残留瘦身）；`$exec` 超时交互设计期裁决落地——worker 墙钟改 **deadline 模型**：初始预算只管用户计算，在途受控 exec 把 deadline 单调抬到「exec 超时 + 2s 余量」（等待宿主不烧计算预算；有界 ≤60s+余量；宿主 abort 级联不变），`user-code-exec.test.ts` 三例钉住，口径落 workflow-engine.md。

---

## 附录 A · 本报告抽验锚点清单

核验对象：本报告撰写时的工作区——`git diff HEAD -- apps packages` 为空（代码文件与 `eb7c874` 逐字节一致）。核验方式：`sed -n` 实读片段 / `grep -n` 定位 / `ls` 在位确认，命令均在撰写会话实跑；「锚点」列为五路证据引用的原文位置，「结果」一致 = 实读内容与五路证据描述相符。

| # | 锚点 | 方式 | 结果 |
|---|---|---|---|
| 1 | `packages/workflow/src/engine/executor.ts:665-687`（seedTokens 消费：cached `nodeEnd.tokens` + lineage 继承） | sed 实读 | 一致 |
| 2 | `apps/gateway/src/routes/warm-cache.ts:77/99/116/146/155`（planWarmCacheSeeds 产 seedTokens，ITokenUsage 口径） | grep -n | 一致 |
| 3 | `apps/gateway/src/routes/workflows.ts:1136-1142`（node-spans 信封 lineageTokens = 链上前驱 SUM） | sed 实读 | 一致 |
| 4 | `apps/gateway/src/routes/workflow-trial.ts:115`（POST /:id/trial）/ `:363`（GET /:runId/trial-calls）/ `:148-160`（前置校验 422 与保存同源） | grep + sed | 一致 |
| 5 | `apps/gateway/src/lib/run-notify.ts:20/37`（进程内 Set claim + 测试钩子；头注释 superseded 抑制） | grep -n | 一致 |
| 6 | `packages/workflow/src/nodes/platform-agent/platform-agent.node.ts:25`（`VERDICT_MAX_INTERACTIONS = 3` 硬编码） | grep -n | 一致 |
| 7 | `apps/gateway/src/repositories/run-deliverables.repo.ts:67/121`（projectDeliverableRows / buildRunDeliverables） | grep -n | 一致 |
| 8 | `apps/gateway/src/boot-sweep.ts` 在位 | ls | 在位 |
| 9 | `packages/db/src/migrations/1720000110000-create-run-node-journal.ts` / `1720000111000-runs-stop-reason-and-snapshots.ts` | ls | 在位 |
| 10 | `docs/superpowers/specs/2026-10-07-pending-state-in-memory-red-line.md`（ADR 落档） | ls | 在位 |
| 11 | `apps/gateway/src/routes/human-input.ts:19-26`（红线论证段 + ADR 互引） | sed 实读 | 一致 |
| 12 | `docs/workflow-engine.md:99-123`（上限对照表：四列 10 行 + 归类原则） | sed 实读 | 一致 |
| 13 | `apps/gateway/src/__tests__/recover-seed.test.ts:137-144`（seedTokens 断言 tail1:{total_tokens:200}） | sed 实读 | 一致 |
| 14 | `apps/console/src/components/flow-runs-panel.tsx:223-228`（暖缓存 lineage chip） | grep -n | 一致 |
| 15 | `packages/workflow/src/utils/flow-permissions.ts:34-39`（PERMISSION_FIELDS 单源） | grep -n | 一致 |
| 16 | `packages/workflow/src/nodes/http/http.node.ts:93-94/117`（guardDomain 构造与首跳调用） | grep -n | 一致 |
| 17 | `apps/gateway/src/routes/workflow-clients.ts:285-288/688-696`（modelPinned 契约 +「因 pin 拒绝降级」错误文案） | grep -n | 一致 |
| 18 | `packages/workflow/src/engine/executor.ts:11/133`（SeedHashMismatchError import + AC-R1-3 注释） | grep -n | 一致 |
| 19 | `packages/workflow/src/__tests__/executor-resume.test.ts:596`（「resume：cached 继承 token」describe） | sed 实读 | 一致 |
| 20 | 常驻测试在位：gateway `src/__tests__/` 相关 20 文件（recover-五件 / journal-replay-superset / persona-freeze / warm-cache / trial 四件 / run-notify-ws / span-writer-verdict-db / workflow-permissions / controlled-exec / flow-generator 两件 / scan-template-permissions / builtin-templates / run-deliverables）+ console `run-tokens.test.ts`、`run-permission-summary.tsx`、`trial-run-panel.tsx` + workflow `executor-resume.test.ts` | ls | 全部在位 |
| 21 | `apps/console/tests/e2e/26-run-recovery.spec.ts` | ls | **不存在**（如实：从未新增，已记 notCovered 第 1 条） |

共 21 项：20 项与五路证据一致/在位，1 项为「确认不存在」类核验（结论如实入册，非偏差）。

---

> 报告产物：`docs/zcode-borrow/acceptance-report.md`（本文件）；随本批同步更新 `CHANGELOG.md`（顶部词条）与 `AGENTS.md`（新机制/端点/表/环境变量精确补充）。
