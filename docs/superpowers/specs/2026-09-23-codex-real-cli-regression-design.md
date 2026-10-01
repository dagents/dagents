# codex 适配器真机回归 — 架构设计

> **状态**: Proposed（依据 product-plan.md 方案 C（P0）；需求侧按「候选 2」锁定，若有误重定向本 spec）
> **上游**: `docs/product-plan.md` § 方案 C · 里程碑 M2 出口判据「README 无『未实测』的 core 承诺」
> **日期**: 2026-09-23 · **角色**: 架构设计（Claude B）

---

## 1. 问题与目标

`packages/agent-adapters/src/codex.ts`（258 行）2026-08-16 按官方文档重写为 `codex exec --json` NDJSON 解析，**从未在真实 codex CLI 上运行过**。现有 `codex.test.ts` 的夹具是「按文档想象的手写字面量」——文档若与真实输出有偏差，测试全绿也毫无意义。codex 是 README 副标题点名的两大 CLI 之一，tier 为 core，`regression: 'docs-only'` 是 core 承诺与现实之间最大的欠账。

**目标**：

1. 在装有真实 codex CLI 的机器上，用固定任务集回归适配器全链路（spawn → 事件流解析 → usage 采集 → 退出码语义）。
2. 真实事件样本固化为入仓夹具，让**无真机的 CI 永久可回归**解析逻辑。
3. 差异即修（修 adapter，不修测试迁就）。
4. 通过后同步全部真相源（tiers.ts / 双语 README / AGENTS.md / product-plan）。

**非目标**：

- qwen / copilot / codebuddy 回归（product-plan 明示排后；但捕获器接口按 adapter-generic 设计，复用是副产品而非本 spec 验收项）。
- stream-backend.ts / contracts 的契约变更（除非 Gate-RC1 失败，见 §9）。
- 新产品功能、API、migration——零数据库、零接口面变化。
- README 叙事重写（只摘「未实测」标注）。

---

## 2. 现状锚点（代码事实）

| 事实 | 位置 | 含义 |
|---|---|---|
| 适配器只含 argv 构造 + 逐行解析 | `packages/agent-adapters/src/codex.ts` | 生命周期（超时/看门狗/kill 升级/取消）全部委托 `spawnStreamAgent`（`stream-backend.ts`，568 行）——回归焦点在解析层与退出码映射，不在进程管理层 |
| 现有单测夹具是手写文档字面量 | `src/codex.test.ts` | 保留（argv 构造覆盖仍有价值），新增真机夹具层 |
| claude 已有成熟的三段式测试范式 | `claude.lifecycle.test.ts`（假 CLI harness）/ `claude.usage.test.ts`（纯函数）/ `real-cli-smoke.sh`（真机 canary） | 直接移植范式，不发明新模式 |
| 冒烟脚本只测「CLI 活着」 | `scripts/real-cli-smoke.sh`：直接跑 `codex exec "$PROMPT"`，**不经过适配器代码** | 现有 nightly 只能发现 CLI 挂了，不能发现适配器解析错了——这是本次要补的洞 |
| nightly 已有 self-hosted 通道 | `.github/workflows/real-cli.yml`（标签 `real-cli`，缺 CLI 诚实 SKIP） | 真机回归挂进现有 workflow，不新建 |
| tier 单源 | `src/tiers.ts`：codex = core + docs-only，note 提及「claude 侧后续修复未回流验证」 | 通过后改 verified；注释要求 README 同 PR 更新 |
| 取消/超时已泛型覆盖 | `src/cancellation.test.ts`（三套 spawn 栈 signal 接线） | codex 走 spawnStreamAgent 栈，已被覆盖；本 spec 不重复，仅在 L2 各钉一颗钉子 |

---

## 3. 总体架构：三层测试金字塔 + 一次性捕获

```
                    ┌─────────────────────────────┐
   真机（一次性/漂移时） │  capture-real-cli.ts 捕获器   │──→ fixtures/codex/*.ndjson + meta.json（入仓）
                    └─────────────┬───────────────┘         │
                                  │ spawn 真实 codex          │ verbatim 回放
                                  ▼                          ▼
 nightly（有 CLI 的      ┌──────────────────┐      普通 CI（每次 push）
 self-hosted runner）    │  L3 codex.real    │      ┌──────────────────┐
                        │  env 门控真机回归  │      │ L1 fixtures 回放   │
                        └──────────────────┘      │ L2 lifecycle 假 CLI│
                                                  └──────────────────┘
```

- **捕获器**（新增）：在真机上用**适配器自己的 `buildCodexArgs`** 构造 argv、spawn 真实 codex、原样落盘 stdout NDJSON + 退出码 + 环境 provenance。产物入仓。
- **L1 回放层**（新增）：读夹具逐行喂 `parseCodexLine`，断言事件序列 / state（sessionId、output、usage、finalStatus）。无 CLI 依赖，普通 CI 跑。
- **L2 生命周期层**（新增）：移植 claude.lifecycle 的假 CLI harness——wrapper 忽略 codex 形状的 argv，node 脚本**回放真机捕获的行**（而非手编），可注入挂死/非零退出/坏 JSON。走真实 `codexBackend.execute`，钉住 spawn/parse/queue/退出码映射全链路。
- **L3 真机层**（新增）：env 门控（`REAL_CLI` 含 `codex` 才跑，缺 CLI `describe.skipIf` 诚实跳过），同一套语义断言跑活 CLI。挂进现有 real-cli.yml nightly。
- **漂移闭环**：L3 红而 L1 绿 ⇒ codex 事件格式漂移 ⇒ 真机重捕获 + 修解析器 + 夹具随 PR 更新。这是唯一允许改夹具的路径。

---

## 4. 场景集（捕获注册表）

六次捕获，五个类别（对齐 product-plan 方案 C 设计第 1 条）。提示词要求模型输出精确标记串（沿用 smoke 的 `dagents-smoke-ok` 手法），断言一律**语义级**（事件类型序列、标记串包含、usage 字段映射），绝不字节级比对——模型文本天然不确定。

| # | 场景目录 | 构造方式 | 必须钉住的行为 |
|---|---|---|---|
| 1 | `single-turn/` | prompt: `Reply with exactly: dagents-codex-ok` | thread.started→sessionId；item.completed(agent_message)→text 事件；turn.completed usage；exit 0→completed |
| 2 | `long-output/` | 要求 ~100+ 行结构化长文 | 多 item / 长 text 的分段累积；reasoning item（若出现）→log 事件不丢 |
| 3 | `tool-call-write/` | 临时目录内：`运行 ls 并把结果写入 out.txt`（--full-auto 默认沙箱） | command_execution→tool-use+tool-result 对（command/aggregated_output/exit_code 映射）；file_change→log 事件；**在非 git 临时 cwd 跑 = 顺带验证 --skip-git-repo-check 真实生效** |
| 4a | `error-model-invalid/` | `--model definitely-not-a-real-model` | turn.failed / error 帧真实形状；finalStatus=failed + finalError；进程退出码 |
| 4b | `error-max-turns/` | `--max-turns 1` + 必须多轮的任务 | 超限中断的真实帧形状（文档最语焉不详处，重点取证） |
| 5 | `usage-multiround/` | 强制多轮工具调用的任务 | usage 帧语义（会话累计快照、`accumulateUsage 'max'` 防重）、cached_input_tokens 字段映射（值可为 0，字段必须在） |

> 4a 零 token 成本、确定性最高，建议最先捕获——它同时验证「报错退出」与「捕获器自身能正确记录失败」。

**实施纪律**：捕获前不得预填夹具；真实输出与 `codex.ts` 注释里的文档假设**不一致即为发现**，修代码 + 把真实形状写回注释。

---

## 5. 目录结构与产物格式

```
packages/agent-adapters/
├── fixtures/codex/                    # 新增：真机捕获产物（入仓，verbatim，禁止手改）
│   ├── single-turn/
│   │   ├── raw.ndjson                 # stdout 原样逐行（含任何非 JSON 噪声行——解析器容错是被测行为）
│   │   └── meta.json                  # provenance（见下）
│   ├── long-output/ …
│   ├── tool-call-write/ …
│   ├── error-model-invalid/ …
│   ├── error-max-turns/ …
│   └── usage-multiround/ …
├── scripts/
│   └── capture-real-cli.ts            # 新增：捕获器（adapter-generic，SCENARIOS 注册表先只有 codex）
├── src/
│   ├── codex.ts                       # 仅限回归差异修复（动前先红测）
│   ├── codex.fixtures.test.ts         # 新增 L1
│   ├── codex.lifecycle.test.ts        # 新增 L2（Unix-only，win32 skip，对齐 claude.lifecycle）
│   ├── codex.real.test.ts             # 新增 L3（env 门控）
│   └── tiers.ts                       # 通过后 codex → verified
└── package.json                       # +capture:real +test:real 脚本
.github/workflows/real-cli.yml         # +vitest 真机回归 step（smoke 之后）
scripts/real-cli-smoke.sh              # 不动（保留「CLI 活着」canary 语义）
```

`meta.json`（格式漂移取证的最小集）：

```json
{
  "kind": "codex",
  "scenario": "single-turn",
  "capturedAt": "2026-09-23T…Z",
  "cliVersion": "<codex --version 输出>",
  "model": "<实际模型>",
  "sandbox": "full-auto",
  "os": "darwin 25.6.0",
  "exitCode": 0,
  "lineCount": 7
}
```

---

## 6. 接口定义

### 6.1 捕获器（`scripts/capture-real-cli.ts`）

```
pnpm --filter @dagents/agent-adapters capture:real [--kind codex] [--scenario <name>] [--force]
```

- 运行器：tsx（gateway dev 已用；agent-adapters 未声明则加 devDependency）。脚本经 `../src/codex.js` 直接触达真实的 `buildCodexArgs`——**捕获与生产共用同一 argv 单源**，不得在脚本里重拼。
- 行为：校验 `command -v codex`（缺则列 SKIP 退出 0——不伪装）；临时 cwd（非 git，场景 3 语义）；spawn + 逐行 tee 到 `raw.ndjson`；stderr 落 `meta.json` 尾部字段（截 2KB）；已存在同名夹具时拒绝覆盖，`--force` 显式重建。
- 退出码：任一捕获失败非零；产物不完整即删（不留半截夹具）。

### 6.2 L1（`codex.fixtures.test.ts`）

场景表驱动：`[{ dir, expect: { eventsContains, finalStatus, usageShape, sessionId? } }]` × 遍历 `fixtures/codex/*`。断言用语义谓词（`text` 事件包含 `dagents-codex-ok`；`tool-use.tool === 'shell'`；usage 各字段 `>= 0` 且存在映射）。**夹具目录存在而场景表缺项 ⇒ 测试失败**（防夹具悄悄失管）。

### 6.3 L2（`codex.lifecycle.test.ts`）

移植 claude.lifecycle 模式：`mkdtemp` 写 harness.mjs + wrapper.sh，`cfg.executablePath` 指向 wrapper，`MIL_FAKE_CODEX_MODE` 选行为。**行来源 = 读真机夹具回放**，另加三个注入模式：`hang`（超时/看门狗路径）、`exit-nonzero-silent`（非零退出且无终态帧——先钉 stream-backend 现状行为，若发现「既不 failed 也不报 stderr」的缺口，红测 + 修复，这是本层最可能的产出点）、`garbage-lines`（容错）。覆盖：事件流 / finalStatus / usage 聚合 / ENOENT。取消路径不重建（cancellation.test.ts 已泛型覆盖），只加一颗「codex argv 下 kill 升级正常」钉子。

### 6.4 L3（`codex.real.test.ts`）

```ts
const RUN = (process.env.REAL_CLI ?? '').split(/\s+/).includes('codex')
describe.skipIf(!RUN || !commandExists('codex'))('codex real-CLI regression', () => { … })
```

场景 = §4 注册表，断言 = §6.2 同一套语义谓词（**复用同一断言模块**，L1/L3 断言漂移即 bug）。每次运行前 `codex --version` 写进测试报告输出。

### 6.5 workflow（`real-cli.yml` 追加 step，smoke 之后）

```yaml
- name: Adapter real regression (vitest)
  run: pnpm --filter @dagents/agent-adapters test:real
  env:
    REAL_CLI: ${{ github.event.inputs.kinds || 'claude codex qwen copilot opencode' }}
```

`package.json`：`"test:real": "REAL_CLI=1 vitest run"`（runner 为 Linux；本地 mac 同语法可用）。缺 CLI 时 skipIf 全绿通过——与「缺 CLI 如实 SKIP」的既有哲学一致，通过的标准永远是**跑过并断言**，不是「没红」。

---

## 7. 数据流

```
[真机] capture-real-cli.ts
   └─ buildCodexArgs(生产单源) → spawn codex exec --json → tee stdout/exitCode
        → fixtures/codex/<scenario>/{raw.ndjson, meta.json}  （git 提交）
             │
             ├─→ [CI 每次] L1: raw.ndjson → parseCodexLine 折叠 → 语义断言
             ├─→ [CI 每次] L2: raw.ndjson + 注入模式 → 真 codexBackend.execute → 全生命周期断言
             └─→ [nightly] L3: 同断言 × 活 codex → 绿/红
                    └─ 红 ⇒ 格式漂移 ⇒ 重捕获 → 修 codex.ts → 夹具新 PR（闭环）
[收尾] 全绿 ⇒ tiers.ts verified ⇒ README ×2 / AGENTS.md / product-plan 真相源同步
```

---

## 8. 决策表

| # | 决策点 | 锁定值 | 依据 |
|---|---|---|---|
| D1 | 真机回归载体 | env 门控 vitest 套件（L3）挂现有 real-cli.yml，**不**扩展 bash smoke | smoke 直跑 CLI 不经适配器代码，测不到解析层；vitest 复用断言与夹具基础设施 |
| D2 | 夹具形态 | 原样 `.ndjson` 文件 + `meta.json` provenance，入仓 | 保留真实噪声行（容错是被测行为）；防手改编造；版本漂移可取证。不用 `.ts` 内联字面量（诱改 + 丢真） |
| D3 | 断言级别 | 语义断言（类型序列/标记串/字段映射），禁字节比对 | 模型输出不确定；标记串手法已被 smoke 验证有效 |
| D4 | L2 行来源 | 真机夹具回放 + 少量注入模式，**不**手编假行 | claude.lifecycle 的教训：手编行 = 重演「按文档想象」的原罪；注入只做夹具给不了的进程级行为 |
| D5 | 捕获器 argv | 复用生产 `buildCodexArgs` | 捕获意义在于回归生产 argv；脚本重拼 = 测了另一个东西 |
| D6 | L1/L3 断言单源 | 共用一个断言模块 | 两层断言漂移会让 nightly 变成摆设 |
| D7 | 夹具更新路径 | 仅「真机重捕获」可改 `.ndjson` | 唯一合法来源是真实 CLI；PR 里手改夹具 = review 拦截项 |
| D8 | codex.ts 修改纪律 | 每处先红测（L1 或 L2）再修 | TDD 仓规；防止「改解析迁就猜测」 |

---

## 9. Gate（高风险未知）

**Gate-RC1：首次真机捕获格式对账**（time-box：一次真机 session）

- **Spike 范围**：在装有 codex CLI 的机器跑 §4 六次捕获。
- **通过判据**：全部偏差可收敛在 `codex.ts` 解析层内修复（含 `parseCodexLine` 的类型分支与 `usage.ts` 映射），不需要动 `stream-backend.ts` 契约或 `contracts`。
- **失败路径**：若真实事件流要求进程管理/事件契约变更（如终态语义不同于现有 finalStatus 模型）→ 本 spec 打回，升级为新 spec 走评审；已捕获夹具保留作为证据。

**次级风险**：

| 风险 | 缓解 |
|---|---|
| codex `--json` 为实验性格式，版本间漂移 | meta.json 记版本；L3 nightly 即漂移探测器；解析器已留旧 Responses-API 兼容分支先例 |
| 真机 quota / 网络依赖 | 场景提示词极小；工具场景只需本地 `ls`/写文件，不依赖外网（codex 登录态除外）；nightly 一天一次 |
| self-hosted runner 不存在 | 既有已知问题（AGENTS.md 在册）：workflow 可见排队不伪装；本地手跑 L3 等价（同一命令） |
| 场景 3 沙箱策略与本机 codex 配置冲突 | 显式 `DAGENTS_CODEX_SANDBOX` 钉住捕获环境并写进 meta.json |

---

## 10. 验收标准（对齐 product-plan 方案 C）

- [ ] §4 五类别六捕获全部完成，夹具 + meta 入仓。
- [ ] `pnpm --filter @dagents/agent-adapters test`（普通 CI 路径）含 L1+L2 且全绿。
- [ ] 真机 `pnpm --filter @dagents/agent-adapters test:real`（REAL_CLI 含 codex）全绿；无 CLI 机器上诚实 SKIP。
- [ ] real-cli.yml nightly 含 L3 step 并至少绿跑一次。
- [ ] `tiers.ts` codex → `regression: 'verified'`（note 摘除或改写——含「claude 侧修复回流验证」句式的处置）。
- [ ] `README.md` L126 / `README.zh-CN.md` L122 的 codex 从未实测清单摘除（tiers 注释要求同 PR）。
- [ ] `AGENTS.md` 已知问题第 4 条「codex/qwen 等 15 个」更新为排除 codex。
- [ ] `docs/product-plan.md` 方案 C 状态 → 已交付。
- [ ] 差异修复清单（若有）逐条有红→绿测试对应。

## 11. 实施顺序（供 plan 阶段展开为 TDD 任务）

1. 捕获器 + package.json 脚本（先 error-model-invalid，零成本验证捕获器本身处理失败的正确性）。
2. Gate-RC1：真机六捕获。
3. L1 回放测试（捕获差异在这一步暴露 → 红测 → 修 codex.ts）。
4. L2 生命周期测试（退出码映射钉子；发现缺口则修）。
5. L3 真机套件 + workflow step。
6. 真相源同步（§10 后四项）——只在全绿后动。

---

## 12. 约束

- 零数据库 / 零 API / 零 migration；不动 `apps/*`；不碰工作区在途的 `getRunError` 迁移改动。
- 不引入新框架：vitest / tsx / bash 均为仓内既有设施。
- 诚实原则贯穿：缺 CLI = SKIP 不算通过；夹具只能来自真机；「没测」不因任何理由写成「已验证」。
