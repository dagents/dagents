# Reddit 社区参与计划 v1.0（基于 10/1 定稿日历）

> 与 [`reddit.md`](./reddit.md)（三份 launch 帖正文）的关系：本文件是包在帖子外面的
> **社区参与策略层**——版块选择、发帖时机、90/10 价值参与纪律。帖子正文以 `reddit.md` 为准。
> 口径回内容日历 §一消息屋，红线继承 X 稿 §七（同源不另立）。

## 〇、Reddit 在渠道矩阵中的定位

- **角色**：与 IG（视觉沉淀层）互补的**深度信任层 + 长效获客层**——HN 引爆后的第一承接面；
  帖子经 Google "xxx reddit" 搜索长期回流，是所有渠道中内容半衰期最长的一层。
- **语言**：EN 单语（与 IG 同口径）。中文开发者阵地由 V2EX/掘金承担（`chinese.md`）。
- **节奏**：**跟 HN，不跟 X**。Show HN 出结果后才动 Reddit（launch kit 既有决策）；
  X 周四工程线程、周五 Ship Log 以「改写」而非「转发」形式进 Reddit，且降频（§四）。
- **参与纪律**：**90/10 硬约束**——每 1 帖自发内容 ↔ ≥9 条纯价值评论/回复（近 30 天窗口计）。
  launch 帖前 2 小时分钟级守评论；常态提及帖 <4h 回复。不求赞、不买互动、小号不进场。

## 一、版块选择

### T1 主攻发帖（launch 周 3 帖，稿已备于 reddit.md）

| 版块 | 角度（钩子映射） | 版规风险与对策 | 动作 |
|---|---|---|---|
| **r/LocalLLaMA** | 本地优先：CLI 兜底 + llama.cpp/vLLM/LM Studio 可作 fast path（钩子②） | **最高风险位**：anti-slop 自动审查在收紧、agent 话题敏感，营销口吻分钟级被删。对策：正文按技术细节密度写（14 节点 DAG、AES-256-GCM、547 e2e）；发前重读 sidebar，删一切可读作 marketing 的形容词 | launch 帖 #1（10/3） |
| **r/selfhosted** | docker compose up / 127.0.0.1 / no telemetry（钩子②隐私面） | 低风险：自托管项目分享是本 sub 常态，**必须选 flair**（selfhosted software / open source）；「求首跑反馈」收尾问句与该 sub 文化契合 | launch 帖 #2（10/4） |
| **r/ClaudeAI** | 一条终端一个 Claude Code → 画布并行多实例（钩子①） | 讨论型社区，对无历史账号的自我推广 actively moderated。对策：账号预热达标（§二）才发，最后发 | launch 帖 #3（10/5） |

### T2 轮换发帖（launch 周后，每 2–4 周 ≤1 帖，单帖单 sub）

| 版块 | 角度 | 前置条件 |
|---|---|---|
| **r/ChatGPTCoding** | codex 与 claude 混编排——「你的 codex 和 claude 为什么不能在一张图上打工」（钩子①跨 CLI 面） | 10/14 后；潜伏 3 天读热帖校准 |
| **r/ClaudeCode** | Claude Code 工作流增强（并行实例 + spectator link） | 版规未核实，先只评论 1 周再定 |
| **r/SideProject** | buildinpublic 里程碑帖 | 仅里程碑，不刷存在感 |

### T3 只评论、永发帖（90% 价值层主战场）

r/programming、r/webdev、r/commandline、r/docker、r/PostgreSQL、r/automation——
每日搜 `multiple claude code instances` / `agent orchestration` / `tmux agents` /
`parallel coding agents` 等痛点词，回 2–3 条**不带链接**的真实解答；对方明确追问工具时才提 Dagents。

### 明确不进

- **r/AI_Agents、r/AgentLLM、r/ArtificialInteligence**：促销泛滥区，发帖=自贬，仅作监测关键词源
- **r/n8n、r/Dify、r/flowise**：竞品社区，红线禁区
- **r/programming、r/MachineLearning**：站规禁自推，进 T3 评论层即可

### 监测布防（T-1）

- **F5Bot** 设关键词 `dagents`（免费邮件提醒）+ 每日一次 `reddit.com/search?q=dagents` 人工扫
- 第三方提及帖：先完整回答对方问题、再视语境提项目；绝不复制粘贴话术

## 二、账号预热（T-1 检查点，越早启动越好）

- 发帖账号立即进入**纯评论期**：T1/T3 sub 每日 2–3 条真实回答，零链接、零项目提及
- 门槛线：**combined karma ≥200 且账号有 ≥2 周互动史**才发 r/ClaudeAI；其余两 sub 同样要求非零历史
- 90/10 配比以近 30 天计：自发内容（含评论里的项目链接）≤10%

## 三、价值优先发帖策略

### 帖型库（5 类，launch 周后轮换）

| 帖型 | 说明 | 频率 |
|---|---|---|
| **A · Launch 帖** | `reddit.md` 三份现成稿；每帖自带诚实限制段 + 尾问 | launch 周 1 次，仅此一次 |
| **B · 工程故事帖** | X 周四线程的 Reddit 改写（非转发）：如「How we regression-test 3 CLI adapters with a mock-LLM harness — 547 e2e cases」。纯干货、链接只放文末、可无链接发 | 每 2–4 周 1 帖，T2 轮换 |
| **C · 求反馈帖** | 「What would it take for you to actually run this locally?」式独立帖（如首跑体验征集） | 里程碑/大改版时 |
| **D · 诚实清单帖**（备弹） | 钩子③ Reddit 原生形态：标题即「…here are its 6 worst limitations」。**仅在决策树触发时用**（§七） | 触发式 |
| **E · AMA** | 远期：1k stars 或模板生态里程碑后，r/selfhosted casual AMA（先与 mod 沟通） | 里程碑后 1 次 |

### 每帖纪律

1. **尾问必须具体**——Reddit 算法看评论率，纯广播帖必沉（launch kit 既有结论）
2. **作者身份首段披露**（"I built / sharing a project I made"）
3. **诚实限制段**与 README 原文逐字一致，不软化、不删减
4. **当日 1 sub、间隔 ≥24h**，正文不跨 sub 复用（角度已按 sub 定制）
5. 发前 30 分钟重读该 sub 当日热帖校准语气；发后 2 小时分钟级守评论

## 四、排期

### 发布周（10/1–10/9，Reddit 跟 HN 不跟 X）

| 日期 | 动作 |
|---|---|
| T-1 10/1 | 账号 karma 检查；三帖终稿冻结；三 sub sidebar 版规复核；F5Bot 布防；确认 README GIF 已合入（帖内图链依赖仓库文件） |
| T+0 10/2 | Show HN 首发。**Reddit 全天不发**，晚间看 HN 走向 |
| T+1 10/3 | 帖 #1 r/LocalLLaMA（HN 上首页当晚跟发；没上则照发错峰——launch kit 既有决策） |
| T+2 10/4 | 帖 #2 r/selfhosted；晚 T+48h 复盘（§七，与 X/IG 同场） |
| T+3 10/5 | 帖 #3 r/ClaudeAI（**预热达标才发**，否则顺延至 10/6） |
| T+4 10/6 | PH 日：Reddit 无动作；仅补发顺延的 #3 |
| T+5–7 10/7–9 | 不发新帖；三帖评论深耕 + T3 价值评论满额。Team Sheet / Template Drop / Ship Log **均不进 Reddit** |

### 常态周节奏

- **每日**：F5Bot 邮件 → 提及帖 <4h 真实回复；T3 痛点搜索回 2–3 条
- **每 2–4 周**：帖型 B（或 C）1 帖，T2 轮换——对齐 X 周四线程，隔周四落 Reddit
- **周五 Ship Log / 周二 Template**：Reddit 不发，仅在相关提问评论里自然引用
- 90/10 配比月度自查

## 五、评论运营与话术映射（X 话术库 §四 → Reddit 落地）

| X 话术 | Reddit 场景 | 落地要点 |
|---|---|---|
| ① 无 key | r/LocalLLaMA 必问 | 一律带 **to start**；补 llama.cpp/vLLM fast path 细节 |
| ② 对比不拉踩 | 「和 n8n/Dify 比呢」高频追问 | 只摆事实（local CLI engine / data stays local），不给优劣结论 |
| ③ Flowise 承认 | canvas 截图/GIF 下方必问 | `(vendored from Flowise, Apache-2.0, frontend-only, NOTICE included)`——r/selfhosted 吃 license 合规细节 |
| ④ 限制走 FAQ | 「能沙箱吗」「daemon 能取消吗」 | 不辩解，指 README 限制清单原文 + roadmap 态度 |
| ⑦ 差评三步法 | bug 指认（launch 周最高风险） | 当场认 + 当场开 issue + 修完回评论贴 PR 链接——公开闭环是 Reddit 上最强的差评变好评路径 |
| ⑨ 安全危机 | 数据/安全质疑 | <30min 首响同稿；追问更技术，备好 127.0.0.1 绑定 / AES-256-GCM / GATEWAY_API_KEY 细节 |

## 六、Reddit 侧红线检查单（发前过一遍）

- [ ] API key 表述一律带 **to start**
- [ ] 作者身份首段披露
- [ ] 诚实限制段 = README 原文，不软化
- [ ] canvas 首次出现处带 `(vendored from Flowise, Apache-2.0, frontend-only)`
- [ ] 不点评 Dify/n8n/LangFlow（被问走话术②，永不出结论）
- [ ] 当日 1 sub、与上帖 ≥24h、正文不跨 sub 复用
- [ ] r/selfhosted 选好 flair；r/LocalLLaMA 发前重读 sidebar
- [ ] 帖尾有具体问题
- [ ] 近 30 天账号自容占比 ≤10%
- [ ] 不删负评、不刷票、小号不进场
- [ ] 每帖挂日历 A/B/C 至少一支柱

## 七、度量与 T+48h 决策树（10/4 晚，与 X/IG 复盘同场）

| 指标 | T+7 保底 | T+14 目标 | 性质 |
|---|---|---|---|
| 三帖合计评论数 | 15 | 60 | **核心信号**（评论率 = 算法权重） |
| 单帖 upvote 融合率 | ≥80% | ≥85% | 内容质量 |
| GitHub referral（reddit.com 来源） | ≥500 | ≥2,000 | 转化 |
| 来自 Reddit 用户的 issue/PR | ≥3 | ≥10 | 深度信任 |
| 他发提及帖（F5Bot 捕获） | ≥2 | ≥8，100% <4h 回复 | 品牌监测 |

**T+48h 决策树**：

- 任一帖进 sub 日榜 top 10 → 维持原案；追评集中的问题当周扩进 FAQ
- r/LocalLLaMA 被 automod 移除 → 读理由，技术化改写后 48h 内重发**一次**；二次移除 → 该 sub 弃用，帖 #3 提前，B 型帖承接本地钩子
- 三帖全线 <10 upvote 且 <5 评论 → launch 周后转纯评论模式 2 周；下次发帖启用帖型 D（「worst limitations」前置）
- 评论区 bug 指认 → 话术⑦全流程，修复后回评贴 PR
- 任一帖破 100 upvote → **不追发新帖**，深耕该帖评论 48h（追发 = 消耗 sub 信用）

## 八、依赖与交付确认（T-1）

1. README 首屏 GIF + 截图合入仓库（三帖正文直接引用仓库链接——与 X/IG 素材同源同批次催办）
2. FAQ 页上线（话术④的出口）
3. `reddit.md` 三稿 T-1 冻结（现成可用）
4. F5Bot 账号注册（运营侧 5 分钟动作）
