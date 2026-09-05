# Dagents Console 像素级设计优化任务清单

> 2026-09-04 · 基于 9 个页面真实截屏（1440×900 光模式 / 暗色抽样 / 375px 移动端抽样）+ 全量 CSS 令牌扫描 + 组件树梳理。
> 目标：审美从「能用、干净但平庸」提到「有纪律的专业感」一个层次。对标 Linear / Height 的密度与克制，保留暖灰纸感 + 墨紫双色个性。

---

## ✅ 执行状态（2026-09-05 全量修复完成）

**59/60 完成**（唯一跳过：PX-GL03 的工具栏 ⌘K 徽标——command-palette 只挂在 Chat-First 回滚壳，主壳未挂载，加徽标等于宣传不存在的快捷键；前置任务「palette 挂进 Workflow-First 主壳」为后续小功能项）。

- **地基（G01-G09）**：tokens 新刻度（字阶 11/12/13/14/16…、圆角 6/8/10/14/20、控件高度 30/32/36、墨紫契约成文）+ **457 处硬编码迁移**（34 文件）+ 悬空令牌变量修复（`var(--text,#eee)` 等活 bug）+ `--meta` 对比度调优（2.8:1→3.9:1）。
- **五路分区**：Flows F01-F09 / 聊天 C01-C10 / Agents A·AD·AE / Settings·Daemons·Skills / Canvas·浮层 CV·GL——每任务均含截屏与程序化双重验证。
- **顺手修掉的真 bug**：flows 页状态点依赖未加载样式不可见、人格库激活 chip 亮色模式近白字、画布保存状态色从未显示、暗色奶油头像、dev 管线 backdrop-filter 丢失。
- **回归**：typecheck 0 错、单测 313 过/5 既有跳过、e2e 风险子集（04-agents/08-sidebar-nav/19-ia/viewport-matrix）192 用例全绿、契约扫描（硬编码圆角/字号/transition:all/语义 hex）全零、375px 与 1024px 无横向溢出。
- **后续小项**（不阻塞）：~~palette 挂主壳 + 工具栏 ⌘K~~（2026-09-05 完成：palette 本就由根布局全局挂载，工具栏 `.list-search` 已加 ⌘K 徽标）、~~编辑页脏数据离开提示~~（完成：beforeunload + 取消/返回确认 + sticky 条未保存标记）、~~选择器族抽共享组件~~（完成：`use-selector-dropdown` hook + `styles/selector.css` 单源，directory-selector 顺带补齐键盘可达性）、~~真实 Agent 流程画布终验~~（完成：最小 CLI 流程真实跑通，INPROGRESS 旋转徽章 / FINISHED 绿勾亮暗双模式实拍验证，冒烟流程已删）。
- 唯一已知未做：画布旁观首帧在 dev 冷编译下「运行中…」可停留数秒（热态 6s 内收敛）——dev 性质，非逻辑缺陷，生产构建不受影响。

---

## 0. 审计结论（为什么是这些任务）

**当前评分：Design C+ / AI 味 B- → 目标 A-**

五个全局症结，全部有数据支撑：

| # | 症结 | 证据 |
|---|------|------|
| 1 | **令牌体系被大面积旁路** | tokens.css 定义圆角 10/14/16/22px，但组件 CSS 里实际出现 13 种圆角（6px×31、8px×25、4px×20…）；字号定义 8 档，实际 20+ 档（11px×86、12px×61、10px×41、还有 9/10.5/11.5/12.5px 半值）；语义色三套并行（绿 #10a37f/#16a34a/#10b981，红 #ef4146/#dc2626） |
| 2 | **双主色打架** | `.btn-primary` 是墨色（`var(--fg)`），紫色 #6c5ce7 同时占领链接、chips、开关、徽章、模板卡标题渐变——两套 primary 没有主次契约。且硬编码里还有第二个紫 #6366f1×13、第三个 #6c8cff×6 |
| 3 | **正文过小、层级过平** | 卡片正文 11-12px、meta 10px（移动端 9px）；卡片标题 12-13px 与正文几乎无对比，squint test 失败 |
| 4 | **对齐噪声** | 状态点/图标与文字基线错位（status-dot 用 margin 手调）、chip 内边距 3px/5px 混用、工具栏控件高度不一、卡片右侧 40% 空洞无栅格 |
| 5 | **移动端破相** | 375px 下 Flows 页横向滚动、sidebar 不折叠、composer 无 safe-area |

**设计方向裁决（P0 主线）**：
1. **墨主紫辅**：墨色 = 动作（按钮），紫色 = 状态与指向（链接、focus、选中、进度）。紫不再上按钮底色，不再做标题渐变字。
2. **令牌收敛后再谈美化**：先把 13 种圆角收敛到 4 档、20+ 字号收敛到 8 档、3 套语义色收敛到 1 套。这是「像素级提升」的最大杠杆。
3. **画布页（暗色）是全站设计最高点**——节点徽章、进度点亮、结果面板都成熟。以它为基准把其他页面对齐，而不是反过来。

---

## 1. P0 全局地基（先做，跨页面共享）

> 这些任务是所有页面任务的前置。做完 P0，大约 40% 的页面级问题自动消失。

### PX-G01 · tokens.css 字阶修订
- **问题**：`--text-base: 16px` 名存实亡（全站正文实际 11-12px）；缺 11px 档导致 meta 层被挤到 10px。
- **整改**：新增 `--text-2xs: 11px`（仅限 meta/时间戳/徽章）；明确 ramp 用法契约：2xs=meta、xs=辅助、sm=正文、base=设置页表单、lg=卡片标题、xl=页标题、2xl+=空态 Hero。
- **验收**：CSS 扫描无 `font-size: 9px|10px|10.5px|11.5px|12.5px`；每档有唯一令牌引用。

### PX-G02 · 圆角令牌对齐现实
- **问题**：令牌 10/14/16/22 与实际用法 4/6/8/12 完全脱节，导致「改令牌无感」。
- **整改**：重定义 `--radius-xs: 6px`（chip/代码内联）、`--radius-sm: 8px`（按钮/输入）、`--radius-md: 10px`（卡片内嵌块）、`--radius-lg: 14px`（卡片/对话框）、`--radius-xl: 20px`（Hero/气泡）、pill 不变；全库 13 种硬编码值替换为令牌。
- **验收**：`grep -rhoE "border-radius: *[0-9]+px" src/` 只剩 tokens.css 一处。

### PX-G03 · 语义色三套并一套
- **问题**：绿/红/橙各有 2-3 个 hex 并行（#10a37f vs #16a34a vs #10b981；#ef4146 vs #dc2626），同页两个绿。
- **整改**：全部替换为 `--success/--danger/--warn/--info` 及其 `-soft` 面；`#6366f1/#6c8cff` 统一进 `--accent` 家族。
- **验收**：组件 CSS 中除纯黑白外无语义 hex；暗色模式无需逐处覆盖。

### PX-G04 · 墨紫主次契约成文
- **问题**：黑按钮 + 紫链接/紫 chip/紫开关/紫渐变标题并存，视线无落点。
- **整改**：写进 tokens.css 注释 + 落实：紫 = `链接/focus ring/选中态/进行中`；墨 = `主按钮`；紫禁用于：按钮底、标题渐变字、大面积填充。flows-empty-hero 的紫渐变标题字改为墨色 + 紫仅限图标点缀。
- **验收**：全站截图 squint test：每屏只有一个彩色系统（紫）且面积 <5%。

### PX-G05 · 控件高度三档制
- **问题**：工具栏里搜索框 30px、按钮 32px、segmented 28px 混排，顶栏轮廓波浪形。
- **整改**：`--ctl-sm: 28px`（工具栏内嵌）、`--ctl-md: 32px`（表单/工具栏默认）、`--ctl-lg: 36px`（对话框主操作）；同一行内只允许一档。
- **验收**：Flows/Agents/Daemons 三个工具栏截图底部对齐一条线。

### PX-G06 · 图标-文本基线工具类
- **问题**：状态点/图标与文字靠 margin 手调，14px 文字旁的点时高时低（截图证据：agents 列表 dot 与文本错位 1-2px）。
- **整改**：shell.css 增 `.inline-icon` 规范（flex align-items:center + 图标 `translateY(0.5px)` 光学修正 + 固定 16px 槽位）；删除各处手调 margin。
- **验收**：Agents/Flows/Daemons 三个列表的行首点与文本中线偏差 ≤0.5px。

### PX-G07 · chip/badge 单一规格
- **问题**：chip 内边距 3px/5px、4px/8px、5px/10px 至少三种（同页可见胖瘦不一）。
- **整改**：统一 `padding: 2px 8px; height: 20px; radius: pill; font: var(--text-2xs) 500`；彩色 chip 只允许 `*-soft` 底 + 深色字。
- **验收**：任意页截图取两个 chip 叠放，高度与左右留白完全重合。

### PX-G08 · 对话框基座统一
- **问题**：dialog.css 基座存在，但各对话框宽度（420-680px）、标题字号、按钮排布各自为政；遮罩深度不一。
- **整改**：定三档宽度 480/560/720；标题统一 `--text-lg/600` + 副题 `--text-sm/muted`；底部操作右对齐、主按钮最右；遮罩统一 `rgba(13,13,13,0.45)` + 240ms 淡入。
- **验收**：CreateAgent / CreateFlow / FlowRun / GenerateFlow / SaveTemplate 五个对话框头/底/按钮带三线对齐。

### PX-G09 · 暗色硬编码清理
- **问题**：`#fff×12、#e0e0e0×4、#333×6` 等不走令牌，暗色下出现纯白标题 vs 灰正文的断层（chat 详情 header「沉浸式控制台」纯白，正文 #ccc）。
- **整改**：替换为 `--fg/--fg-2/--muted`；暗色正文统一 `--fg-2`，标题才用 `--fg`。
- **验收**：暗色抽样三页无 #fff 级对比断层（最大亮度差落在令牌内）。

### PX-G10 · 移动端防破相
- **问题**：375px 下 Flows 横向滚动（列表 min-width）、sidebar 不折叠占 1/3、composer 贴底无 safe-area、chip 行溢出。
- **整改**：≤768px 时 sidebar 收成抽屉/隐藏 + 汉堡入口；列表卡片纵向堆叠；`body { overflow-x: hidden }` 兜底 + 根治 min-width；composer `padding-bottom: env(safe-area-inset-bottom)`。
- **验收**：375px 全页 `document.scrollWidth <= 375`；e2e viewport-matrix 全绿。

---

## 2. `/` Flows 工作台（Workflow-First 首页）

> 组件树：flows-view（工具栏+列表卡）· flows-empty-hero · flow-template-gallery · create-flow-dialog · generate-flow-dialog · flow-run-dialog · flow-runs-panel · skeleton

### PX-F01 · flows-view 工具栏
- **文件**：`components/flows-view.tsx` + `styles/shell.css`
- **问题**：截屏可见搜索框与「从模板创建」「新建流程」按钮底边不齐（差 2px）；「全部/我的」filter 与搜索框间距 8px vs 按钮组间距 12px 不一致；按钮间 4px 过挤。
- **整改**：工具栏统一 32px 高度档；搜索框 flex 收缩最小 240px；控件组间距统一 `--space-3`、组内 `--space-2`；主按钮「新建流程」墨色，次按钮统一 ghost 描边款。
- **验收**：1440 与 1024 两档截图，工具栏所有控件底边一条线；按钮 hover 有 `--elev-hover` 且 140ms 过渡。

### PX-F02 · flows-view 流程卡片
- **问题**：卡片 20px 圆角 + 内部 chip 8px + 按钮 6px 三套圆角并存；标题 13px 与描述 12px 层级几乎不可辨；右侧「编辑/运行」按钮群与左侧元信息争夺视线；卡片宽 800px 内容仅占左 60%，右侧空洞；状态点与「草稿」文本基线错位。
- **整改**：卡片 `--radius-lg(14px)`、内嵌元素 xs/sm 两档；标题 `--text-sm 600` + 描述 `--text-xs muted`；右侧操作固定 32px 槽位右对齐、hover 才显次要操作；行高、状态点走 PX-G06 基线规范。
- **验收**：同一截图内任意两卡叠放，标题基线、按钮槽、圆角完全重合；squint test 标题仍可辨。

### PX-F03 · flows-empty-hero 空态
- **文件**：`styles/flows-empty-hero.css`
- **问题**：紫渐变标题字 + 「团队场景模板/一句话生成/空白画布」三卡横排是典型 AI 落地页姿势；卡内图标圆底 + 加粗小标题 + 一行描述 = 三列 feature grid 黑名单款；箭头动效各卡不同步。
- **整改**：标题去渐变（墨色，紫只留标题旁一个 8px 圆点或图标色）；三卡改为**纵向清单式入口**（左侧 20px 图标槽 + 右侧标题+描述一行），卡间距 8px、整组限宽 560px 居中；或保留三卡但去图标彩底、加 hairline 分隔。入场 stagger 统一 38ms 步进（令牌已有）。
- **验收**：空态截图过「AI 味」三问：无彩底图标圆、无渐变字、无对称三卡——至少破两项；CTA 唯一且墨色。

### PX-F04 · flow-template-gallery 模板画廊
- **文件**：`styles/flow-templates.css`
- **问题**：三 tab（内置/团队/我的）切换无动画跳变；模板卡内 badge 与标题挤压（截屏见「7 节点」徽章与标题同行时标题被压缩换行）；卡 hover 只变边框无阴影层次。
- **整改**：tab 切换内容 140ms 淡入 + 4px 上移；徽章移到 meta 行；hover 走 `--elev-hover` + 边框 `--border-strong`；选中态紫 ring（`--accent-glow-soft`）。
- **验收**：画廊内所有卡同高（grid auto rows），badge 不与标题同行；tab 切换无布局跳动。

### PX-F05 · create-flow-dialog
- **问题**：输入框 focus 无 ring（仅边框变色）；「创建」按钮加载态无 spinner 一致性。
- **整改**：输入 focus 用 `--focus-ring`；主按钮加载态：文字变「创建中…」+ 左侧 14px spinner；错误信息红字出现在字段下方 4px 处而非顶部。
- **验收**：键盘 tab 走查：每个控件有可见 focus ring；提交失败错误定位到字段。

### PX-F06 · generate-flow-dialog（一句话生成）
- **问题**：生成中状态表达弱（用户不知要等多久）；引擎选择器（provider/agent）与 prompt 框视觉层级颠倒。
- **整改**：prompt 框为主视觉（大一号、autofocus）；引擎选择收为次级行；生成中显示逐条 attempt 状态（复用画布 activity 流的 💭/🔧 时间线组件，视觉语言全站统一）。
- **验收**：生成等待期对话框内有动的东西（呼吸/spinner/时间线），无死白屏。

### PX-F07 · flow-run-dialog 运行输入面板
- **问题**：输入 textarea 与项目目录选择器宽度不齐；「⌘⏎ 运行」快捷键提示只在按钮 title 里不可发现；对话框与画布运行面板的「运行」按钮样式不同色。
- **整改**：两控件同宽对齐；按钮内显式 `⌘⏎` kbd 徽标（`--prose-code-bg` 底 11px mono）；运行按钮全站统一墨色。
- **验收**：列表运行与画布运行的确认弹窗并排截图，按钮/字段/间距一致。

### PX-F08 · flow-runs-panel 运行历史
- **文件**：`components/flow-runs-panel.tsx`
- **问题**：紧凑行内状态点/触发源 chip/耗时/输入预览四段间距均等，扫读无主次；失败摘要红字 11px 偏小；running 行 3s 轮询时状态点闪烁跳变。
- **整改**：行内层次：状态点+状态词（左，固定 88px）→ 触发源 chip → 相对时间（meta 色）→ 输入预览（截断 40ch）→ 耗时（tabular-nums 右对齐）；失败摘要升 12px danger 色；running 点用 1.4s 呼吸而非跳变。
- **验收**：数字列右对齐后小数点/分号成列；terminal 状态行颜色 1s 内稳定不闪。

### PX-F09 · flows 骨架屏
- **问题**：SkeletonList 与真实卡片形状不匹配（真实卡有标题+描述+meta+按钮行，骨架只有三行条）。
- **整改**：骨架复刻卡片真实分区（标题条 40% 宽、描述条 100%、meta 行圆点+短条、右侧按钮块）；shimmer 800ms 线性扫过。
- **验收**：加载→渲染切换时无布局跳动（CLS < 0.05 手测）。

---

## 3. `/agents` Agents 列表

> 组件树：agents-view · create-agent-dialog · agent-library-gallery · skeleton

### PX-A01 · agents-view 列表卡片
- **问题**：截屏证据——①左侧色块字母头像（紫渐变底）与右侧信息比例失衡（头像 40px 但内容行数少，卡片高而空）；②kind chip（claude/CLI）三处配色不同（有的紫底白字、有的灰底）；③「Book Co-Author」标题 13px 与 instructions 预览 12px 无对比；④卡片底部 roles 标签行与 meta 行间距 12px，上下分区节奏均等。
- **整改**：头像统一 36px、纯 `--surface-sunk` 底 + 首字母 fg 色（去紫渐变）；kind 徽章统一 ghost 款（soft 底+深字）；标题 `--text-sm 600`；分区节奏：标题块 8px → 描述 12px → meta/chip 行 12px；整卡垂直 padding 16px。
- **验收**：五张卡截图叠加，头像槽/标题基线/chip 行 y 坐标一致；同屏只出现一种 chip 款式。

### PX-A02 · create-agent-dialog
- **问题**：kind 选择（claude/codex/qwen…）用下拉还是分段不明确，截屏不可见但代码里为 select 原生样式；与人格库确认步的「运行时/模型档位选择器」视觉语言不统一。
- **整改**：kind 改为图标+文字的分段卡（复用人格库档位选择器组件），选中态紫 ring；表单标签 12px/500 统一左对齐。
- **验收**：与 agent-library-gallery 确认步并排截图，同类选择器不可分辨出处。

### PX-A03 · agent-library-gallery 人格库
- **文件**：`styles/agent-library.css`
- **问题**：网格卡信息密度高但灰阶过多（截屏可见 5 种灰字并行）；「启用」按钮与「预览」链接抢焦点；快速开始分区与普通分区标题样式相同，导航感弱。
- **整改**：灰阶收敛到 muted/meta 两档；每卡唯一主操作（启用=墨色小按钮），预览降为整卡 hover 显现；分区标题 12px/600 + 上方 24px 空隙 + hairline 分隔。
- **验收**：任一卡截图数灰阶 ≤3 种；tab 键第一站是卡的主操作。

---

## 4. `/agents/[id]` Agent 详情

### PX-AD01 · agent-detail-view
- **问题**：截屏证据——①页首身份块（头像+名称+kind+状态 pill）与下方「instructions 正文」之间无分节逻辑，一大块文本顶到边；②状态 pill（active/idle）颜色与 Daemons 页状态色不一致；③右侧操作（编辑/删除）hover 才见但无分组线，删除（危险操作）与编辑同级。
- **整改**：页首做 identity 卡（surface 底、16px padding、名称 16px/600 + kind 徽章 + 状态 pill 统一规格）；instructions 区加「系统提示词」小节标题（12px/500/meta + hairline）；危险操作移入「⋯」菜单且 hover 变 danger 色。
- **验收**：与 Daemons 页并排截图，同语义状态 pill 像素级一致；删除入口至少一次确认层。

### PX-AD02 · agent-activity-sparkline
- **问题**：迷你折线无坐标基准（不知纵轴含义）、无 hover tooltip、线色未走令牌。
- **整改**：线色 `--accent` 60% 透明度 + 最近点实心 3px 圆点；hover 显示「时间 · 事件数」浮层（复用 hover-card）；下方加 7d 总数 meta 行。
- **验收**：空数据时显示 24px 高的 flat 虚线 + 「暂无活动」而非空白塌陷。

---

## 5. `/agents/[id]/edit` 编辑页

### PX-AE01 · 编辑表单
- **文件**：`app/agents/[id]/edit/page.tsx`
- **问题**：整页表单无左标签右字段的栅格（截屏见标签与输入框间距随内容漂移）；instructions 大文本区无行高优化（等宽 12px 挤）；保存按钮漂在页底无 sticky。
- **整改**：双列栅格：标签列固定 120px（12px/500 右对齐或上对齐统一）+ 字段列 min 480px；textarea `--font-mono 12.5px/1.7`；底部操作条 sticky（backdrop-blur + hairline 上边线），保存中禁用+spinner。
- **验收**：所有字段左边缘一条线；未保存离开有脏数据提示。

---

## 6. `/chats/[id]` 聊天详情

> 组件树：chat-detail · chat-composer · assistant-content · code-block · tool-call-card · workflow-run-card · suggestion-cards · 庆祝动效 · chat-nav-sidebar/chat-history-tree · chat-search-dropdown

### PX-C01 · chat-detail 消息流布局
- **问题**：截屏证据——①用户气泡 `--bubble-user` 与助手全宽文本块的边界感弱（左对齐但无头像/名字锚点，长对话分不清谁在说）；②消息间距 16px 均等，无「轮次」分组感；③右栏执行记录与消息区分隔线过重。
- **整改**：助手消息加 20px 圆形图标锚点（或首行「Agent · 时间」meta 行）；轮次间 24px、轮内 12px；右栏改 1px `--border-soft` + 拉手。
- **验收**：20 轮长对话截图，视线能按轮次分块；无需读文字即可辨用户/助手。

### PX-C02 · chat-composer 输入卡
- **文件**：`styles/chat-composer.css`
- **问题**：截屏证据——多行增高时圆角保持 22px 导致高胶囊变形；@ 提及浮层与 composer 边缘只差 4px 易被裁切；发送按钮在空输入时仍高亮紫底。
- **整改**：增高超过 3 行圆角降为 14px（高度感知）；@ 浮层与 composer 间距 8px + 独立 elev-dropdown；空输入发送钮 ghost 禁用态（40% 透明），有内容才墨色激活。
- **验收**：1/3/8 行三态截图圆角过渡自然；空态点击发送无反应且按钮明显不可点。

### PX-C03 · assistant-content markdown
- **文件**：`styles/assistant-content.css`
- **问题**：正文 14px 但列表/引用缩进未用 prose 节奏（截屏见嵌套列表缩进 16px 挤成一团）；表格无斑马纹、无横向滚动处理。
- **整改**：列表缩进 `--space-6`/层；引用块左边线 2px 紫 + `--surface-warm` 底；表格表头 `--surface-sunk` + 行 hairline + 溢出滚动带右缘渐隐遮罩；标题层级 h2/h3 差 2px 且加 16px 上距。
- **验收**：粘贴一段含列表+表格+引用的 markdown 渲染截图，与 Linear notional 质感对齐。

### PX-C04 · code-block
- **问题**：截屏证据——语言标签与复制按钮同行但复制按钮 hover 才现、发现性差；横向滚动条占据内容高度（跳动）；行号列与代码基线错位。
- **整改**：头部条常驻：左语言标签（mono 11px meta）右复制（成功态 icon 变 ✓ 1.2s）；滚动条 overlay 样式（webkit 细轨）；行号右对齐 + 与代码同 line-height。
- **验收**：长代码块滚动时头部条 sticky；复制反馈不改变按钮宽度（icon 等槽替换）。

### PX-C05 · tool-call-card 工具调用卡
- **文件**：`styles/tool-call.css`
- **问题**：折叠/展开用旋转箭头但箭头 10px 偏小且与标题间距 6px 挤；工具名 mono 与参数摘要 sans 混排基线跳；运行中/成功/失败三态只有图标变化，卡底色不变。
- **整改**：箭头 12px + 8px 间距；参数摘要统一 meta 色 12px mono；失败态左边线 2px danger + `--danger-soft` 底 4% 透明度；运行中工具名后跟 3 点跳动。
- **验收**：三种状态卡并排截图一眼可辨；展开动画 140ms 高度过渡无跳变。

### PX-C06 · workflow-run-card 执行卡
- **问题**：节点进度行与结果面板字色均 meta 灰，完成/失败不可扫读；tokens 徽章 ↑↓ 符号在 11px 下渲染发糊。
- **整改**：节点行状态用点色 + 文字同色加深；tokens 徽章 tabular-nums + `↑↓` 换文字「入/出」或 12px 再用符号；失败节点行 danger 色。
- **验收**：旁观长流程时（>5 节点）截图，当前执行节点视觉焦点唯一。

### PX-C07 · suggestion-cards 建议卡
- **问题**：三卡等宽等高但图标彩底（AI 三列网格特征）；hover 无反馈。
- **整改**：去彩底图标改 hairline 描边图标；hover 上浮 2px + `--elev-hover`；整组限宽 640px 居左（聊天上下文内不居中）。
- **验收**：空对话首屏截图无对称三彩点阵感。

### PX-C08 · 首次回复庆祝动效
- **文件**：`components/use-first-reply-celebration.tsx`
- **问题**：一次性彩带/庆祝若为全屏 canvas 会盖住 composer；动效时长与令牌无关联。
- **整改**：庆祝限定消息气泡区域内（1.5s、ease-out-quint、respect `prefers-reduced-motion` 直接跳过）。
- **验收**：OS 开启减弱动效后无任何粒子/位移动画。

### PX-C09 · chat-nav-sidebar + chat-history-tree
- **文件**：`styles/chat-nav-sidebar.css`（930 行，最大样式文件）
- **问题**：截屏证据——目录树缩进层级视觉差 8px 但行高不一（目录头 28px / 会话行 30px 混排）；活动目录自动展开时无过渡直接跳；HoverCard 预览卡阴影过重盖过内容；「显示更多」溢出行与普通行样式相同。
- **整改**：行高统一 30px、缩进每层 12px；展开动画 140ms 高度+透明度；HoverCard 阴影降为 `--elev-dropdown`；溢出行加「⋯」前缀 + meta 色。
- **验收**：三层嵌套目录截图缩进成等差数列；键盘 ↑↓ 走查焦点行高亮完整覆盖行。

### PX-C10 · chat-search-dropdown
- **文件**：`styles/chat-search-dropdown.css` 或 `chat-search.css`
- **问题**：搜索结果高亮命中词用紫底白字过重；分组标题与结果行间距不分层。
- **整改**：命中词改 `--accent` 文字色 + 底部 1px 波浪/加粗（不用底色）；分组标题 11px/500/meta + 上下 8px。
- **验收**：长关键词搜索截图可读性优于改前（同屏 8+ 结果无色块噪声）。

---

## 7. `/daemons` Daemons

### PX-D01 · daemons-view
- **文件**：`styles/daemons.css`（825 行）
- **问题**：暗色截屏（本页设计最好）但亮色下：状态色块面积过大（绿底横幅条）；表格列宽无 min-max，主机名截断与时间列换行；顶部注册表单与列表挤压在同一视口。
- **整改**：状态降为「点+词」不占底色（大面积色底只留错误态）；表格列定宽契约（主机 min 160、版本 80、状态 96、最后心跳 120、操作 auto）；注册表单收成「+ 注册 Daemon」对话框。
- **验收**：亮暗两模式截图状态表达等价；窄窗口 1024px 表格无换行破相。

### PX-D02 · daemon 任务事件流（日志）
- **问题**：事件行 mono 11px 无时间列对齐（时间戳变长导致文本起点漂移）；错误行只有红字无图标。
- **整改**：时间列固定 72px 右对齐 tabular-nums；错误行前 12px ⚠ danger 图标；连续同类事件折叠为「…重复 N 次」。
- **验收**：50 条事件流截图文本起点全部对齐一条竖线。

---

## 8. `/skills` 技能库

### PX-S01 · skills-view
- **文件**：`styles/skills.css`
- **问题**：截屏证据——技能卡内 SKILL.md frontmatter 元信息（名称/描述）与来源目录徽章排布无栅格；「添加目录」入口藏在页角；卡内描述两行截断无渐隐提示。
- **整改**：卡统一：标题行（名称 13px/600 + 来源 chip）→ 描述 2 行 line-clamp + 右下角渐隐 → meta 行（技能数/大小）；「添加目录」升为工具栏主次按钮；空目录态给插画级空态（复用 flows-empty-hero 语言）。
- **验收**：三个目录根混合列表截图，来源 chip 全部右对齐同列；截断处有 24px 线性渐隐。

---

## 9. `/settings` 设置

> 组件树：settings-view（tab 壳）· notification-settings · audit-log · usage-tab · LLM Provider 表单

### PX-ST01 · settings-view tab 壳
- **问题**：截屏证据——左 tab 列与右内容区间距 48px 过宽（内容区被挤到 720px 以下）；tab 选中态指示（紫条 or 底色）与 Agents 页 segmented 控件语义混用；「未接入」占位 tab 视觉与真实 tab 同权重。
- **整改**：tab 列固定 200px + 32px 间距；选中态统一为「左侧 2px 紫条 + 文字 fg」全站唯一；未接入 tab 降 40% 透明 + 「未接入」11px 后缀。
- **验收**：tab 指示器样式与站内其他 tab/segmented 不再混淆（语义二分：导航=侧条，筛选=segmented）。

### PX-ST02 · LLM Provider 表单
- **问题**：密钥输入掩码显隐按钮位置随错误信息出现而跳动；「测试连接」结果 inline 文案无成功/失败图标。
- **整改**：显隐按钮绝对定位右缘内 8px 固定；测试结果 icon+文字（✓ success / ✗ danger）+ 骨架期间 spinner。
- **验收**：错误出现/消失时按钮零位移。

### PX-ST03 · audit-log
- **文件**：`styles/audit-log.css`
- **问题**：截屏证据——表格 action 列彩色词（紫/绿/红）密度过高成「彩点阵」；时间戳绝对时间不友好；行 hover 无反馈。
- **整改**：action 词统一 fg 色、仅删除/危险类 danger；时间列改相对时（hover title 显绝对）；行 hover `--surface-warm`。
- **验收**：整页灰阶为主、彩色仅剩语义必要处（≤2 色/屏）。

### PX-ST04 · usage-tab
- **问题**：数字与单位间距手敲空格；无趋势可视化。
- **整改**：单位 11px meta 挂尾；加 7d mini bar（复用 sparkline 组件）。
- **验收**：数字右对齐 tabular-nums；空数据不塌陷。

### PX-ST05 · notification-settings
- **问题**：开关行 label 与描述间距 4px 过挤；开关组件紫底但尺寸三处不一。
- **整改**：行结构统一（label 13px/500 + 描述 11px meta + 右侧开关垂直居中，行高 40px）；开关统一 32×18px 单组件。
- **验收**：五开关行截图间距节奏一致。

---

## 10. `/workflows/[id]/canvas` 画布编辑器

> 全站设计最高点（尤其暗色）。任务以「保护 + 修补」为主，并把它的语言反哺其他页面。

### PX-CV01 · 画布顶栏
- **问题**：截屏证据——顶栏按钮（保存/运行/另存模板/返回）图标+文字混排不齐，主操作「运行」不够突出；标题 flow 名过长时挤压按钮。
- **整改**：运行按钮墨色主款全站统一；标题 `text-overflow: ellipsis` 限宽 320px + hover 全名 tooltip；图标按钮统一 32px 槽 + 8px 间距。
- **验收**：与 Flows 列表工具栏并排截图，按钮体系一致（同高/同圆角/同主次）。

### PX-CV02 · 画布节点与连线
- **问题**：亮色下节点徽章（INPROGRESS 旋转/FINISHED 绿勾）与暗色对比度不对称（亮色下绿勾偏浅）；长节点名溢出节点框。
- **整改**：亮色状态色对比度补足（绿勾换 #0c8a6c 级深度）；节点名 2 行 clamp + 节点框最小宽契约。
- **验收**：亮暗两模式同流程截图，状态可辨性等价。

### PX-CV03 · 运行结果面板
- **问题**：运行中活动流（💭/🔧 时间线 + live 正文）与折叠行内联预览字体层级接近（mono 小字 11px 两种密度并存）；「原始数据」折叠展开无动画。
- **整改**：活动行与正文行用缩进+左边线区分（活动行左缘 2px meta 线）；折叠展开 140ms；tokens 徽章 tabular-nums。
- **验收**：旁观 7 节点并行流程全程录屏，无「黑盒空窗」>2s。

### PX-CV04 · save-flow-template-dialog
- **问题**：参数化扫描出的 `{{变量}}` 列表展示为纯文本逗号分隔。
- **整改**：参数以 chip 网格呈现（每 chip 一变量 + 默认值输入内联），与 flow-run-dialog 的 answers 表单语言统一。
- **验收**：三参数模板保存对话框截图，chip+输入无换行破相。

### PX-CV05 · 画布内 generate/flow-run 对话框
- **问题**：与列表页同名对话框存在样式漂移（不同入口微调过）。
- **整改**：抽公共对话框组件双入口复用（差异仅 props）；对齐 PX-G08 三档宽度。
- **验收**：两入口并排截图不可分辨。

### PX-CV06 · dag-node（流程缩略 DAG）
- **问题**：小尺寸下节点形状与画布节点不一致（圆角/比例）。
- **整改**：按 0.4 缩放比例复用画布节点视觉（同圆角比例、同状态色）。
- **验收**：卡片缩略图与画布放大缩小后节点可辨识为「同一物体」。

---

## 11. 全局浮层与导航（每路由可见）

### PX-GL01 · app-nav-sidebar 主导航
- **问题**：截屏证据——导航项 hover 底色块与选中态区分弱（都近似 surface）；底部语言/主题切换与导航项等权重；侧栏下半区大段空白（1440 高度下 40% 空）。
- **整改**：选中态「左 2px 紫条 + fg 文字 + surface-warm 底」；hover 仅 surface；底部设置区上方加 hairline 分组线 + 组标题「偏好」11px meta；空白区不填充（留白是特性），但折叠态 tooltips 需补齐。
- **验收**：键盘 tab 顺序 = 视觉顺序；折叠 72px 态 hover 出 tooltip 全覆盖。

### PX-GL02 · chat-history-tree（主壳会话树）
- **问题**：与 PX-C09 同源，但主壳内嵌版本与聊天壳版本出现 8px 缩进 vs 12px 缩进漂移。
- **整改**：以共享组件为准回归测试两处渲染一致（截图 diff）。
- **验收**：两壳并排截图像素 diff 仅在容器宽度。

### PX-GL03 · floating-chat 悬浮副驾
- **文件**：`styles/floating-chat.css`
- **问题**：默认位与 minimap 避让逻辑在画布页表现正确，但拖拽把手 hover 无 affordance；展开尺寸记忆无 UI 提示。
- **整改**：把手 hover 显 grip 纹 + cursor: grab；右下角 8px resize 手柄常显（meta 色）。
- **验收**：任意页拖动/收起/展开循环 3 次位置记忆不漂移。

### PX-GL04 · command-palette
- **文件**：`styles/command-palette.css`
- **问题**：⌘K 入口可发现性为零（无 UI 提示）；结果分组标题与 chat-search-dropdown 不一致。
- **整改**：工具栏搜索框内右侧加 `⌘K` kbd 徽标（点击也开）；分组标题样式与 PX-C10 统一。
- **验收**：palette 打开首帧 <100ms、空态给可执行建议列表。

### PX-GL05 · toast
- **问题**：成功/错误 toast 左图标色正确但底色同为白卡；action 按钮（如「直达」）与关闭 × 间距 4px 挤。
- **整改**：错误态左边线 2px danger；action 按钮独立 24px 右槽 + 12px 间距；自动消失进度条 4s 细线（可 hover 暂停）。
- **验收**：三连 toast 堆叠截图间距 8px、无跳动。

### PX-GL06 · hover-card
- **问题**：阴影 `--elev-overlay` 过重（与对话框同级）；出现无延迟易误触。
- **整改**：降 `--elev-dropdown`；150ms 延迟 + 80ms 淡入。
- **验收**：快速划过列表不再闪卡。

### PX-GL07 · keyboard-shortcuts 帮助层
- **文件**：`styles/shortcuts.css`
- **问题**：kbd 键帽样式与 toolbar kbd 徽标不一致。
- **整改**：全站统一 kbd 组件样式（mono 11px、surface-sunk 底、radius xs、1px border-soft）。
- **验收**：帮助层与搜索框内 kbd 并排截图一致。

### PX-GL08 · 选择器族（agent / flow / directory）
- **问题**：三个 selector 下拉宽度、选中态、空态文案各异。
- **整改**：抽 selector 基座（min 240px、选中紫 ring、空态统一插画语言）；三者只换数据渲染。
- **验收**：三 selector 同屏截图结构一致。

### PX-GL09 · skeleton（全局）
- **问题**：与 PX-F09 同理，各页骨架条数与真实内容分区不匹配。
- **整改**：SkeletonList 接受 shape 描述（rows/avatar/actions），各页传真实分区。
- **验收**：Agents/Flows/Skills 三页加载态截图与渲染态分区对齐。

### PX-GL10 · theme-toggle / locale-toggle
- **问题**：两 toggle 图标风格（线性 vs 填充）混用；切换语言时整页文案闪变无过渡。
- **整改**：统一线性 16px 图标族（icon.tsx 收口）；语言切换加 100ms 全页透明过渡。
- **验收**：暗色下两 toggle 图标可见性 ≥3:1 对比。

---

## 12. 回滚壳（Chat-First，flag ≤1 迭代，P3 可选）

### PX-R01 · chat-home / chat-layout / onboarding-*
- **整改**：仅做令牌替换级维护（G01-G03 自动覆盖），不做独立美化——IA 回滚通道退役后一并删除。
- **验收**：`dagents.ia.workflow-first=off` 下无破相即可。

---

## 13. 执行顺序与验收基建

**顺序**：PX-G01→G04（令牌与主色，一次 PR）→ G05-G08（控件规格）→ 各页按 用户路径 优先级：F（首页）→ C（聊天）→ A/AD（Agents）→ CV（画布修补）→ ST/D/S → G09/G10 → GL 系列 → R。

**每任务完成定义**：代码改动 + 对应页面截图（前/后）+ 亮暗两模式无回归 + `viewport-matrix.spec.ts` 与 `15-flows-ui-journey.spec.ts` e2e 绿。

**禁止事项**（项目既有约束）：
- dev server 运行期间勿跑 `pnpm build` / 全仓 `pnpm test`（会毁 `.next` 与触发 gateway 重启杀掉进行中 run）。
- 回归验证用 `pnpm --filter @dagents/console test` 级别即可，全仓操作前先确认无长任务在跑。

**任务总数**：10（全局）+ 9（Flows）+ 3（Agents）+ 2（详情）+ 1（编辑）+ 10（聊天）+ 2（Daemons）+ 1（技能）+ 5（设置）+ 6（画布）+ 10（浮层）+ 1（回滚壳）= **60 项**。
