# END — MVP 全闭环验证（论文复现 1 篇）

> 关联 plan: `docs/superpowers/plans/2026-07-08-mvp-implementation.md` §Task END
> 关联 issue: [MZW-281](mention://issue/b77a14da-27ae-483c-ad9a-6561929cbe88)
> 分支: `issue/MZW-281`（基于 main `e6195d8`）

## 目标

跑通论文复现场景：**定义 agent → 编排 flow → 批量 → 监控 → 复现**，1 篇论文复现 e2e（HITL 兜底）。
这是 48 个 issue 的收尾里程碑：把 M0–M6 已实现的能力串成一条端到端闭环。

## 验收

issue 描述的三条验收：

- ✅ 两个 Gate 都通过
  - Gate-2 [MZW-241](mention://issue/a36ba3bc-cda4-4678-ad5a-f3e70c87900b)（Flow State 定位）= `done`
  - Gate-1 [MZW-250](mention://issue/e0ac2225-79b1-4291-a7f9-69d1e0451dbd)（dispatch↔daemon↔claude e2e 跑通 3 次）= `done`
- ✅ 所有里程碑验收达标 — M0~M6 全部 done（main `e6195d8`）
- ✅ 1 篇论文复现 e2e（HITL 兜底）— 本文档 + `end-closed-loop-e2e.test.ts`

## 闭环五段（串起来的五段，每段对应一个里程碑能力）

```
1. 定义 agent   agent_daemons 行 (claude daemon) — 批量 flow 的 dispatch 目标
2. 编排 flow    stub Flowise agentflow (Tool Agent + DispatchInvoke 节点): 入队 → 轮询 → 返回 agentFlowExecutedData
3. 批量          scheduler.fanOut(2 篇论文) → 1 parent + 2 children, 信号量并发
4. 监控          parent 聚合 output + run_node_spans (≥3 节点/child) + audit_log 版本锁
5. 复现          reproduceRun(1 篇): 同 hash + 同 input 重跑 → 结构比对 → match
```

五段都在**同一个进程、同一条链路**里跑通：`fanOut → gateway → stub flowise → dispatch → daemon → (gateway →) stub LLM`，跑完立刻对其中一个 child 做 `reproduceRun`。每一跳都是真实 instrumented HTTP（见下文「为什么用真实 `serve()`」）。

## 交付物

| 路径 | 说明 |
|---|---|
| `packages/e2e/src/end-closed-loop-e2e.test.ts` | END 闭环验证脚本（1 个测试，断言全部五段验收点 + 双签前置）。 |
| `docs/mvp-closed-loop-evidence.json` | 一次实跑的 JSON 证据快照（flow / fanOut 聚合 / 节点 span / 版本锁 / 复现报告）。 |
| `docs/mvp-closed-loop-verification.md` | 本验证文档。 |

## 测试架构（为什么用真实 `serve()` 而非 `app.request()`）

与 M6.7 同理：W3C `traceparent` 的自动注入（undici 出站）+ 抽取（`http` 入站）依赖 auto-instrumentation。`app.request()` 是进程内调用，**绕过** `http` server instrumentation，无法证明 `traceparent` 真正跨网络跳。本套件用 `@hono/node-server` 的 `serve()` 把 dispatch + gateway 起在临时端口上，stub Flowise + stub LLM/new-api 用真实 `node:http` server，daemon 用真实 `runDaemon`（fake claude backend）。每一跳都是真实 instrumented HTTP 调用 —— 闭环里的「编排 flow → 批量 → 监控」走的预测链就是 M6.7 那条被验证过的链路。

```
scheduler.fanOut([paper-A, paper-B])           ← stage 3 批量 (1 parent + 2 children)
  → 对每个 child: scheduler.child-run span (run.id=childRunId)
    → POST gateway /api/v1/flows/<flowId>/prediction  (x-run-id=childRunId)   ← stage 2 编排 flow
      → gateway.proxy span (run.id=childRunId) + fetch stub Flowise (traceparent 注入)
        → stub Flowise 抽取入站 traceparent，POST gateway /api/v1/dispatch/invoke (x-run-id=childRunId) — 续同一 trace
          → dispatch 入队 dispatch_tasks (run_id=childRunId)，返回 taskId
            → daemon claim（轮询）→ 开 daemon.execute span (run.id=childRunId)
              → fake claude backend: fetch gateway /api/v1/llm/* (claude adapter → LLM 跳，加入 daemon trace)
              → daemon reportMessages + completeTask(usage)
          → stub Flowise 轮询 GET /api/v1/dispatch/tasks/:id 至 completed，返回 agentflow 预测响应
    → scheduler complete child + ingest run_node_spans (trace_id = 预测 traceId)   ← stage 4 监控 (节点级)
  → completeParentRun 聚合两 child 入 parent.output                                  ← stage 4 监控 (批量聚合)
reproduceRun(childA)                                                                  ← stage 5 复现
  → 同 pipeline_version_hash + 同 input 重跑 (runChild) → 结构比对 → match=true
```

> **stub Flowise 复现友好性**：stub 返回的 agentflow 响应里 `executionId`/`sessionId` 由 **input**（paperId）决定，不由 runId 决定 —— 这样同 input 重跑得到结构相同响应，`compareOutputs`（canonical 非字节级）match。这正是一个「复现目标 flow」的契约：可复现的是 input→output 映射，不是 run-id 管道元数据。

## 实测证据（2026-07-10 本机实跑）

证据快照见 `docs/mvp-closed-loop-evidence.json`。要点：

### stage 1 — 定义 agent

`agent_daemons` 行（`kind=claude`）存在，是批量 flow 的 dispatch 目标。两 child 的 dispatch 任务都被同一个在线 daemon claim 走（claim 不按 daemon_id 过滤，`FOR UPDATE SKIP LOCKED`）。

### stage 3 — 批量（fanOut 2 篇）

```json
"fanOut": { "total": 2, "completed": 2, "failed": 0 }
"children": [
  { "runId": "e8b71b9a…", "status": "completed", "agent_answer": "reproduced:paper-A" },
  { "runId": "b2eeaa3d…", "status": "completed", "agent_answer": "reproduced:paper-B" }
]
```

每个 child 的 Agent 节点 `output.content` 把 per-paper 输入折回（`reproduced:paper-A` / `reproduced:paper-B`），证明两 child 走的是各自独立的预测，而非串扰。

### stage 4 — 监控（聚合 + 节点级 span + 版本锁）

- **parent 聚合**：`parentAggregate.total=2, completed=2, children=[2]` — 批量级状态可查。
- **节点级 span**：6 条 `run_node_spans`（≥3 节点 × 2 child），其中 2 条 `nodeId=agent`，`traceId` 非空、`cost=0.012300` —— 节点级状态 + trace + 成本都可查（M6.4/M6.7 监控面）。
- **版本锁审计**：`audit_log` 一行 `action=pipeline_version.lock`，`run_id = parentRunId` —— 批量自快照一次，锁操作留痕（M6.6）。
- **版本绑定**：两 child 的 `pipeline_version_hash` 完全相同（一个 hash）—— 「snapshot once, bind all」契约，也是复现的前置。

### stage 5 — 复现（1 篇 e2e）

```json
"reproduce": {
  "sourceRunId": "e8b71b9a…", "rerunRunId": "ca9a7270…",
  "status": "completed", "match": true, "diff": null,
  "versionHash": "b611c86a…"
}
```

- 同 `pipeline_version_hash` + 同 input 重跑，`compareOutputs` 结构比对 `match=true`、`diff=null`（非字节级，canonical）。
- rerun 行 `created_by_run_id = sourceRunId`，`pipeline_version_hash` 与 source 一致 —— 可追溯（provenance）+ 可比对（identity）。
- rerun 走的是和 fanOut child 完全相同的 `runChild` 生命周期 —— 复现 = 真实重跑，不是回放缓存。

### HITL 兜底

验收的「HITL 兜底」= product-manager + project-architect **双签**（issue 要求），是人工 sign-off，不是自动化断言。本套件把双签之前的所有事自动化跑通并留证据；双签本身在 issue 上发生（code-reviewer 对抗式评审 + 人工 reporter 批准）。套件**不**模拟人 —— 它证明闭环已「就绪待签」。

## 如何复现

```bash
# 前置：docker-compose dev stack 已起（Postgres :15432 / Redis :16479 / MinIO :9000）
cd <repo>
pnpm install
pnpm -r --filter "./packages/*" --filter "./apps/*" build   # 建 mil 包（跳过 vendor/flowise）

# 跑 END 闭环验证
POSTGRES_URL=postgresql://milagents:milagents_dev@localhost:15432/milagents \
REDIS_URL=redis://:milagents_dev@localhost:16479 \
  pnpm --filter @mil/e2e test

# （可选）重新生成证据快照
END_EVIDENCE_PATH="$PWD/docs/mvp-closed-loop-evidence.json" \
POSTGRES_URL=postgresql://milagents:milagents_dev@localhost:15432/milagents \
REDIS_URL=redis://:milagents_dev@localhost:16479 \
  pnpm --filter @mil/e2e test
```

`pnpm --filter @mil/e2e typecheck` 零错误；全 e2e 套件（M6.7 + END）2/2 通过。

## 结论

END 验收达成：论文复现闭环五段（定义 agent → 编排 flow → 批量 → 监控 → 复现）在一条链路里端到端跑通，2 篇批量全完成、1 篇复现 `match=true`；两个 Gate 已双签 done、M0~M6 全部 done。MVP 全闭环达成，待 product-manager + project-architect 双签收尾。
