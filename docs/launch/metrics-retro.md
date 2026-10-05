# Launch 指标看板与复盘体系 v1.0（2026-10-01 定稿）

> 定位：10 月 launch 的**度量与复盘层**，包在所有渠道计划外面。口径回日历 §一消息屋；
> Reddit 侧指标直接继承 `reddit-engagement.md` §七（不重定义）；复盘节点对齐 checklist.md
> D 节（T+7 对比 3 UV 基线）。红线继承 X 稿 §七，本文件不另立红线。

## 〇、基线与口径声明（先立事实，再谈目标）

- **零点基线（2026-09-04 诊断）**：14 天访问 29 次 / **3 个独立访客**、全网零提及。
  **2026-10-01 实测修正**：仓库当前 live 基线 **2 stars / 27 UV（14d）/ 4 open issues**
  （9/4 后有自然微流入）。T-1（10/1）落盘值即为正式起点戳，写入 metrics-log 板 1
  首行；「launch 增量」= T+x 值 − 起点戳，不用 9/4 老值。
- **HN 检索口径（实测踩坑）**：Algolia `query=Dagents` 模糊命中 D'Agents/Dagens 噪声，
  采集命令必须用**引号精确短语**（见 §二命令），并以标题含 `Show HN: Dagents` 或
  `github.com/dagents` 为准二次确认。
- **数据留存红线**：GitHub traffic API（views/clones/referrers/paths）**只回溯 14 天**。
  T+14 复盘（10/16）要用的数据若不每日落盘，届时已不可回采——因此 §二 的每日快照
  纪律是硬要求，不是可选。
- **统计口径声明（诚实优先）**：launch 期样本为单事件，所有指标按**运营监测口径**
  （描述性）使用，不做显著性检验。常态周积累 ≥3 个同型帖后才做跨帖对比，届时用
  简单区间对比并标注样本量。
- **目标值性质**：§三 的保底/目标两档为先验估计（基于开源 launch 常态分布），
  **10/4 T+48h 首次快照后校准后续目标**，校准记录写入复盘模板第 5 节，不悄悄改。

## 一、指标体系（四层 + 定义字典）

### 层级逻辑

```
北极星（活动成败）      —— 只看 1 个主指标 + 3 个辅助
 ├─ 渠道效果（每渠道）  —— 主信号一律是「互动/行动」，曝光只做健康度参考
 ├─ 转化漏斗（归因用）  —— 区分「渠道问题」vs「落地页问题」vs「产品问题」
 └─ 红线健康（品牌安全）—— 响应时长类指标，超线即事故
```

**虚荣指标警示（口径先立）**：stars 是里程碑信号不是 launch 目标（不刷星红线已有）；
X impressions / IG 曝光无行动价值，只用于诊断内容触达，**不进复盘打分表**。核心信号
三件套：**评论数（Reddit/HN）、referral UV（全渠道）、社区 issue/PR（GitHub）**。

### 定义字典（复盘时口径吵架的终结者）

| ID | 指标 | 定义 | 数据源 | 频率 |
|---|---|---|---|---|
| **NS-1** | 累计新增 GitHub UV | `traffic/views` uniques 自 T+0 累计（基线 3） | GH API | 每日 |
| NS-2 | stars 增量 | `stargazers_count` − T-1 晚值（T-1 记一次起点） | GH API | 每日 |
| NS-3 | 社区 issue/PR 数 | 非本人账号开启的 issue + PR（含评论里报的 bug 转 issue） | GitHub | 每日 |
| NS-4 | clones | `traffic/clones` uniques 累计（真实尝试的代理指标） | GH API | 每日 |
| HN-1 | points / 评论数 | Show HN 帖 points 与 num_comments | Algolia HN API | 每日 |
| HN-2 | 首响覆盖率 | 前 2h 内作者已回复的评论占比（Show HN 存亡线） | 人工 | 发帖当晚 |
| HN-3 | HN referral UV | referrers 表 `news.ycombinator.com` 行 | GH API | 每日 |
| RD-1~5 | Reddit 五指标 | **继承 `reddit-engagement.md` §七 原表**（评论数为核心信号、upvote 融合率、reddit.com referral、Reddit 来源 issue/PR、F5Bot 提及帖及 <4h 回复率） | Reddit + GH API | 每日 |
| RD-6 | 90/10 自容比 | 近 30 天自发内容占比 ≤10% | 人工 | 月度 |
| X-1 | link clicks | X Analytics 帖卡链接点击（X 渠道主信号） | X Analytics | 每周 |
| X-2 | engagement rate | 互动/展示（参考健康度，不打分） | X Analytics | 每周 |
| IG-1 | saves | 保存数（IG 渠道主信号——沉淀意图） | IG Insights | 每周 |
| IG-2 | reach / link taps | 触达与链接贴纸点击 | IG Insights | 每周 |
| PH-1~3 | PH 三指标 | upvotes、评论数、日榜排名（10/6 单日事件） | PH 产品页 | 10/6 当日 + 次日 |
| CN-1~3 | 中文渠道 | V2EX 回复数、掘金阅读/互动、中文 referral UV（v2ex.com / juejin.cn） | 各平台 + GH API | 发帖后 3 日 |
| AW-1/2 | awesome 清单 | PR 状态（提交/合并/拒绝）、合并后每周 referral 长尾 | GitHub PR + GH API | 周度 |
| FUN-1~3 | 漏斗转化率 | UV→clone、UV→star、UV→issue/PR，见 §一漏斗基准 | 计算 | 复盘时 |
| HL-1 | 负评首响时长 | bug 指认/数据安全质疑的首条作者回复耗时（危机口径 <30min 同稿） | 人工 | 事件驱动 |
| HL-2 | 删帖/移除事件 | automod 移除、平台判 spam 次数（目标恒为 0 之外逐次记录原因） | 人工 | 事件驱动 |

### 漏斗基准与归因规则（复盘诊断的核心逻辑）

开源项目 launch 的常态转化区间（先验）：**UV→clone 5–10%，UV→star 3–6%，UV→issue/PR 0.3–1%**。

归因规则（T+7 起每次复盘过一遍，避免「渠道不行」的错误结论）：

| 症状 | 诊断 | 处方归属 |
|---|---|---|
| referral UV 达标但 UV→star <2% | **落地页问题**：README 首屏/钩子不转化 | 改 README，渠道侧不动 |
| clone 达标但 issue≈0 且首跑反馈少 | **首跑体验问题**：装起来卡住了 | checklist A 节干净克隆复验 + FAQ |
| UV 不达标但点进来的转化率正常 | **渠道问题**：内容或时机，换钩子/换 sub/换时段 | 渠道计划侧 |
| 评论多但 referral UV 低 | **内容 entertained but not acted**：钩子与工具价值脱节 | 帖尾 CTA 与尾问检修 |

## 二、看板结构（三张板 + 采集手册）

看板不做自动化系统——单人运营、launch 周高强度，**一张每日 5 分钟人工表 + 一段可复制
的采集命令**就是当前最优投入产出比。载体：[`metrics-log.md`](./metrics-log.md)。

### 板 1 · 每日 War Room 行（launch 周 T+0–T+7，之后降频）

```
| 日期 | GH UV 当日 | UV 累计 | Stars | Clones | Top referrer | HN pts/评论 | RD三帖 pts/评论 | X clicks | IG saves | 提及 | 事件 |
```

- 「事件」列记红线类事项：automod 移除、bug 指认及首响耗时、爆帖、目标校准。
- 每日 22:00 前采完（美西白天数据基本落定）。

### 板 2 · 周度渠道表（常态周，周日晚采）

```
| 周 | 渠道 | 发帖/动作数 | 主信号 | referral UV | 社区 issue/PR | 投入小时 | UV/小时 |
```

UV/小时 是 T+14 渠道 ROI 排序的原始列，从第一周就记。

### 板 3 · 复盘快照（T+48h / T+7 / T+14 / T+30，模板见 §四）

### 采集手册（命令可直接复制）

```bash
# —— GitHub（需 gh 登录态；traffic 只回溯 14 天，每日必采）——
gh api repos/dagents/dagents/traffic/views --jq '{daily: .views[-1], total_uniques: .uniques}'
gh api repos/dagents/dagents/traffic/popular/referrers          # 各渠道归因主表
gh api repos/dagents/dagents/traffic/clones --jq '{daily: .clones[-1], total_uniques: .uniques}'
gh api repos/dagents/dagents --jq '{stars: .stargazers_count, forks: .forks_count, issues: .open_issues_count}'

# —— HN（Algolia 公开 API，无需登录；必须引号精确短语，裸搜会命中 D'Agents/Dagens 噪声）——
curl -s 'https://hn.algolia.com/api/v1/search?query=%22Dagents%22&tags=story' \
  | jq '.hits[] | {title, points, num_comments, created_at}'

# —— Reddit（人工 5 分钟：三个帖页面 + F5Bot 邮件；或带 UA 拉 JSON）——
curl -s -A 'dagents-launch-monitor' 'https://www.reddit.com/r/LocalLLaMA/comments/<id>.json' | jq '.[0].data.children[0].data | {score, num_comments}'
```

X Analytics / IG Insights / PH / V2EX / 掘金为人工读取（各后台一次点击），写入对应列。

## 三、目标值（保底/目标两档 × T+7/T+14）

> 保底 ≈ P50 预期（HN 未上首页、Reddit 无爆帖）；目标 ≈ P80（HN 上首页或 Reddit 单帖
> 破百，二占一即可）。**10/4 晚首次校准后，后续以校准值为准。**

| 指标 | T+7 保底 | T+7 目标 | T+14 保底 | T+14 目标 |
|---|---|---|---|---|
| **NS-1 UV 累计** | **500** | **2,500** | **1,200** | **5,000** |
| NS-2 stars 增量 | +40 | +150 | +80 | +300 |
| NS-4 clones 累计 | 30 | 150 | 60 | 300 |
| NS-3 社区 issue/PR | 5 | 15 | 12 | 30 |
| HN-1 points / 评论 | 20 / 10 | 100 / 30（上首页） | 30 / 15 | 150 / 40 |
| HN-3 HN referral UV | 400 | 1,800 | 600 | 2,500 |
| RD-1~5 | **继承 reddit-engagement §七原值**（评论 15、referral 500、issue 3、提及 2） | 同左 | 同左（60 / 2,000 / 10 / 8） | 同左 |
| X-1 link clicks | 300 | 1,000 | 600 | 2,000 |
| IG-1 saves | 30 | 100 | 60 | 200 |
| PH-1~2（10/6 单日） | 50 upvotes / 10 评论 | 150 / 25 + 日榜 top 20 | — | — |
| CN 中文 referral UV | 100 | 400 | 150 | 600 |
| AW-1 PR 合并数 | 1 | 2 | 2 | 3 |
| HL 全部 | 首响 100% 达标（<30min 危机口径 / <4h 提及 / 24h issue 首响）——**红线不设弹性档** | 同左 | 同左 | 同左 |

## 四、复盘模板（四级，填空即用）

> 使用规则：开会前先把 §二 板 3 快照采完填入第 1 节，会中只填 2–6 节；结论必须落到
> 「动作 + 日期」，不落动作的复盘结论视为未得出。

### 模板 A · T+48h（10/4 晚，X/IG/Reddit 三渠道同场，首场也是唯一一场高频复盘）

```markdown
## T+48h 复盘（2026-10-04 晚）
### 1. 快照（会前采）
| | HN(72h) | Reddit#1(48h) | Reddit#2(24h) | X(3d) | IG(3d) | GH 累计 |
| points/upvotes | | | | — | — | UV: / stars: / clones: |
| 评论 | | | | | | issue/PR: |
| referral UV | | | | | | |
### 2. 目标 vs 实际（只列偏差 >±40% 的行，其余「符合」）
### 3. 三问（每渠道各答一轮，每答 ≤2 句）
- 有效（继续）：
- 失效（停止/改写）：
- 下一步（动作 + 日期）：
### 4. 预定义触发器核对
- [ ] HN 已出结果 → Reddit 跟发节奏是否符合「上首页当晚跟 / 没上错峰」
- [ ] Reddit 帖 #1 被 automod 移除？→ 走 reddit-engagement §七决策树（48h 内重发一次）
- [ ] 单帖破 100 upvote？→ 不追发，深耕该帖评论 48h
- [ ] 漏斗归因（§一基准表）：当前症状属于 渠道/落地页/首跑 哪一类？
- [ ] bug 指认出现？→ 话术⑦闭环状态：issue #___ → 修复 ETA ___ → 回评已贴 PR?
- [ ] PH（10/6）打法确认：X 主战 + Stories 跟随，Reddit 不动作（维持原案/调整）
### 5. 目标校准（先验 → 实测修正，写明改了哪几行、为什么）
### 6. 经验沉淀（→ 复用进下次 launch / 常态周排期）
```

### 模板 B · T+7（10/9，发布周收官——checklist D 节「一周复盘」的落地形态）

```markdown
## T+7 复盘（2026-10-09）
### 1. 快照（板 1 全量 7 行 + 板 3）
### 2. 基线对比（checklist 既有钩子）：3 UV/14d → ___ UV/7d，倍数 ___
### 3. 目标 vs 实际（§三 T+7 列全量打分：超/达/未达 + 偏差原因一句）
### 4. 渠道初排序（referral UV 降序 + 各渠道一句话定性）
### 5. 常态周决定
- 帖型 B 首发 sub 与日期（T2 轮换起点）：
- F5Bot / T3 评论层的每日配额是否达标（90/10 抽查）：
- awesome PR 提交状态与下一家：
### 6. 遗留 bug 指认闭环清单（issue → PR → 回评，逐条勾）
### 7. 经验沉淀
```

### 模板 C · T+14（10/16，渠道再平衡——数据已不可回采，快照必须已落盘 14 天）

```markdown
## T+14 复盘（2026-10-16）
### 1. 快照 + 7→14 天增量（第二周的斜率比绝对值重要：渠道是否衰减过快）
### 2. 目标 vs 实际（§三 T+14 列）
### 3. 渠道 ROI 排序（板 2 的 UV/小时 降序；<10 UV/小时的渠道降级为纯监测）
### 4. 漏斗终检（FUN-1~3 对照基准区间；异常行的归因与处方）
### 5. 再平衡决定（加码/维持/收缩，逐渠道一行，含放弃条件）
### 6. 经验沉淀
```

### 模板 D · T+30（11/1，月度——内容半衰期与 V2 输入）

```markdown
## T+30 复盘（2026-11-01）
### 1. 月度大盘（UV/stars/clones/issue 四线 30 天走势，从 metrics-log 汇总）
### 2. 半衰期验证（launch 帖的长尾回流：Reddit 帖 + awesome 合并后的周 referral 是否仍在贡献；「Reddit = 半衰期最长渠道」假设是否成立）
### 3. 90/10 纪律审计（RD-6：近 30 天自发内容占比实测）
### 4. 信任资产盘点（社区 issue/PR 总数、回头贡献者、被引用/被转载实例）
### 5. V2 输入（中文渠道是否加码、AMA 时机是否触发、帖型 D 是否启用过）
### 6. 下一月排期草案（直接进日历）
```

## 五、与上游文档的衔接（同源声明）

| 来源 | 本文件如何衔接 |
|---|---|
| 日历 §一消息屋 | 全部目标值挂日历 A/B/C 支柱，不新增叙事 |
| `reddit-engagement.md` §七 | RD-1~5 **原文继承不重定义**；其 T+48h 决策树在模板 A §4 被直接调用 |
| `checklist.md` D 节 | T+7 模板 §2 就是「对比 3 UV 基线」的结构化落地；24h issue 首响进 HL 线 |
| X 稿 §七红线 | HL 层全部继承（<30min 危机首响、不删负评等），未新增红线 |
| `show-hn.md` 发帖备注 | HN-2 首响覆盖率（前 2h 每条必回）即其「存亡在评论区」的量化形态 |

## 六、对上游的依赖与风险

1. **gh CLI 登录态**（traffic API 需 push 权限）——T-1 验证一次，失败则降级为
   GitHub 网页 Insights 人工周采（精度损失：referrers 归因变粗）。
2. **X Analytics / IG Insights 后台访问**——人工数，launch 周每日采。
3. **F5Bot 注册**（Reddit 计划已列，T-1）——HL-2 提及回复率的捕获源。
4. **14 天数据留存**是本体系最大单点风险：metrics-log 断采 >3 天即视为 T+14 复盘
   降级（渠道归因不可回采），需在 T+48h 复盘会上确认采集纪律执行人。
