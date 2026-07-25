# DAgent 控制台 -- 完整交互流程

## 页面清单

| # | 页面 | 文件 | 导航 ID | 说明 |
|---|------|------|---------|------|
| 1 | 概览 | `design/index.html` | overview | 首页，平台概览 + 模块入口 |
| 2 | Agents 列表 | `design/agents.html` | agents | Agent 注册列表，筛选/排序/批量操作 |
| 3 | Agent 详情 | `design/agent-detail.html` | agents | 单个 agent 属性/Activity/Instructions/Skills/Logs |
| 4 | AgentFlows 列表 | `design/agentflows.html` | flows | Flow 列表 + 展开 run 历史 |
| 5 | AgentFlows 详情 | `design/agentflows.html` (SPA 切换) | flows | DAG 画布 + 节点 Inspector |
| 6 | 新增 Task | `design/new-task.html` | new-task | 创建新任务/选目录/关联 flow+agent |
| 7 | Workspace | `design/workspace.html` | workspace | 项目频道对话 + 成员/flow/配额/产物 |
| 8 | 设置 | `design/settings.html` | settings | 网关连接/令牌 CRUD/模型/预算/通知 |
| 9 | 工作流编辑器 | `design/workflow-editor.html` | -- | 基于 Flowise 14 节点的 DAG 编辑器 |
| 10 | Daemon 执行视图 | `design/daemon-execution.html` | -- | Daemon 节点实时执行状态面板 |

---

## 一、全局导航架构

### 侧边栏 (Sidebar)

所有页面共享统一侧边栏 (`app.js` 渲染)：

```
[折叠按钮]
──────────
Agents          → agents.html
AgentFlows      → agentflows.html
──────────
Workspace
  [+] 新增 Task  → new-task.html
  ▸ 项目 A
    · 任务 1     → workspace.html?p=projA
    · 任务 2     → workspace.html?p=projA
  ▸ 项目 B
    · 任务 3     → workspace.html?p=projB
  ...
──────────
设置            → settings.html
```

### 侧边栏交互

1. **折叠/展开** -- 点击 `折叠` 按钮切换 `data-collapsed`，侧边栏从 248px 缩至 72px，仅保留图标
2. **项目展开** -- 点击项目头展开/折叠任务列表，同一时间只展开一个项目 (排他)
3. **任务跳转** -- 点击任务项：若当前在 `workspace.html` 则 SPA 内切换项目 (pushState + CustomEvent)；否则页面跳转
4. **移动端** -- 汉堡菜单按钮切换 `data-mobile-nav`，侧边栏覆盖弹出

### Topbar

- **面包屑** -- 每页显示层级路径
- **全局搜索** -- `⌘K` 聚焦搜索框，Esc 关闭
- **通知** -- 铃铛图标 + 红点提示
- **用户头像** -- 右下角 RZ

---

## 二、页面间导航关系

### 概览页 (index.html)

```
index.html
  ├── [查看 AgentFlows]   → agentflows.html
  ├── [管理 Agents]       → agents.html
  ├── [模块卡片: Agents]  → agents.html
  ├── [模块卡片: AgentFlows] → agentflows.html
  ├── [模块卡片: Workspace] → workspace.html
  └── [模块卡片: 设置]    → settings.html
```

### Agents 列表页 (agents.html)

```
agents.html
  ├── [点击整行]           → agent-detail.html?id={agentId}
  ├── [行操作 ⋯ → 查看详情] → agent-detail.html?id={agentId}
  ├── [行操作 ⋯ → 复制配置] → toast 提示 (演示)
  ├── [行操作 ⋯ → 归档]    → 状态切换为 archived，scope-tab 计数更新
  ├── [+ 注册 Agent]       → toast 提示 (演示)
  ├── [批量: 查看详情]      → agent-detail.html?id={id} (仅单个时跳转)
  ├── [批量: 复制/归档]     → toast 提示 (演示)
  ├── [scope tab: 我的/全部/已归档] → 本页筛选切换
  ├── [筛选: 状态/类型/角色/排序] → 本页筛选 + 徽标
  └── [返回 Agents]        ← agent-detail.html
```

### Agent 详情页 (agent-detail.html)

```
agent-detail.html?id={agentId}
  ├── [返回 Agents]        → agents.html
  ├── [Activity tab]       → 30 天运行 KPI + 柱状图 + 最近活动列表
  ├── [Instructions tab]   → 系统提示词 + 能力描述符
  ├── [Skills tab]         → 已挂载 Skills 网格卡片
  ├── [Logs tab]           → 日志列表 + 区域与资源信息
  └── [URL 参数]           → ?id=agent_01HFK (默认)
```

### AgentFlows 列表页 (agentflows.html)

```
agentflows.html
  ├── [展开 flow 卡片]      → 展开 run 历史列表
  ├── [点击 run 行]         → SPA 内切换到 DAG 详情视图 (#flow={id}&run={runId})
  ├── [编辑画布]           → alert 提示 (演示，应打开 Flowise 编辑器)
  ├── [▶ 运行]             → SPA 内切换到 DAG 详情视图 (最新 run)
  ├── [+ 新建 Flow]        → toast 提示 (演示)
  ├── [scope tab]          → 我的/全部/已归档 筛选
  ├── [filter chips]       → 运行中/已完成/已暂停/失败 筛选
  └── [返回 AgentFlows]     ← DAG 详情视图
```

### AgentFlows DAG 详情 (agentflows.html SPA)

```
agentflows.html#flow={id}&run={runId}
  ├── [返回 AgentFlows]     → 隐藏详情视图，回到列表页
  ├── [点击 DAG 节点]       → 右侧 Inspector 更新为节点信息
  │     Inspector 显示: 状态 / 所属 run / 耗时 / 调用 agent
  │                      输入 JSON / 输出 JSON
  │                      预算/已用 tokens/已用成本/超时
  │                      节点日志
  ├── [节点状态着色]        → 左侧 4px 彩色条 + 右上角圆点
  │     运行=绿 / 完成=深绿 / 排队=橙 / 失败=红 / 暂停=蓝 / 未触发=灰
  ├── [边状态]              → 活跃边=绿色加粗，其他=灰
  └── [legend]              → 底部图例
```

### 新增 Task 页 (new-task.html)

```
new-task.html
  ├── [上半部分]
  │     ├── [工作目录卡片]  → 选择关联目录 (虚线框提示)
  │     └── [关联 Flow]     → 选择关联的 flow (可选)
  ├── [下半部分]
  │     └── [建议 prompt]   → 预置任务模板 (点击填入)
  ├── [输入区域]
  │     ├── [任务描述 textarea] → 中央大输入框
  │     └── [关联 Agent]     → 选择参与的 agent
  └── [提交按钮]           → 跳转到 workspace.html?new=1&task=...&dir=...&flows=...&agents=...
```

### Workspace 页 (workspace.html)

```
workspace.html
  ├── [左侧: 对话频道]
  │     ├── [标题 + 描述]     → 项目名 + 成员数/flow/消息数
  │     ├── [filter chips]   → 全部 / @我 / 未读 / 含 run
  │     ├── [消息流]          → 按天分隔的人/agent 对话气泡
  │     └── [输入框 + 发送]   → 发送消息追加到流中
  ├── [右侧: 项目信息面板]
  │     ├── [成员列表]       → 头像 + 姓名 + 角色
  │     ├── [关联 flow]      → flow 名称 + 状态 + [在 AgentFlows 打开 →] → agentflows.html
  │     ├── [配额]          → 成本/runs/tokens 进度条
  │     └── [产物]          → 报告/数据集/代码 patch 计数
  └── [页头操作]
        ├── [归档]          → toast (演示)
        └── [+ 新建项目]    → toast (演示)
```

### 设置页 (settings.html)

```
settings.html
  ├── [左侧导航]
  │     ├── 网关连接
  │     ├── API 令牌
  │     ├── 模型
  │     ├── 预算与熔断
  │     └── 通知
  ├── [网关连接]
  │     └── 连接状态卡片 + 令牌数/日请求/日成本
  ├── [API 令牌]
  │     ├── [+ 创建令牌]    → Modal 弹窗 (名称/Key 前缀/分组/额度/过期)
  │     ├── [搜索/筛选]      → 本页筛选
  │     ├── [令牌行]         → 名称 / Key(隐藏) / 分组 / 额度进度条 / 创建日期 / 操作(编辑/复制Key/删除)
  │     └── [编辑令牌]       → Modal 弹窗 (同创建)
  ├── [模型]
  │     └── 模型行: 名称 / Provider / 价格 / 默认标记
  ├── [预算与熔断]
  │     ├── [开关行]         → 超额拒绝 / 超额预警 / webhook 通知 / 自动降低并发
  │     └── [月预算金额]
  └── [通知]
        ├── [开关行]         → 邮件通知 / Slack / Webhook
        └── [Webhook URL 输入]
```

### 工作流编辑器 (workflow-editor.html)

```
workflow-editor.html
  ├── [左侧: 节点面板]
  │     └── 14 种 Flowise 节点类型 (拖拽到画布)
  │         Start / Condition / Condition Agent / Iteration / Loop
  │         Direct Reply / Agent / LLM / Tool / Retriever
  │         HTTP / Human Input / Execute Flow / Custom Function
  ├── [中心: DAG 画布]
  │     ├── [节点拖放/连线]
  │     ├── [节点属性编辑]   → 点击节点弹出配置面板
  │     └── [缩放/平移]
  ├── [顶部工具栏]
  │     ├── [保存]
  │     ├── [撤销/重做]
  │     └── [运行工作流 ▶]   → daemon-execution.html
  └── [右侧: 属性面板]
        └── 选中节点的详细配置表单
```

### Daemon 执行视图 (daemon-execution.html)

```
daemon-execution.html
  ├── [顶部导航]
  │     └── [← 返回工作流编辑器] → workflow-editor.html
  ├── [中心: 执行状态面板]
  │     ├── [节点执行状态列表]    → 每个节点的运行/完成/失败状态
  │     ├── [实时日志输出]        → daemon 节点的 stdout/stderr
  │     ├── [进度条]             → 整体工作流完成百分比
  │     └── [耗时/成本统计]      → 实时更新
  └── [操作按钮]
        ├── [暂停执行]
        ├── [中止执行]
        └── [重新运行]
```

---

## 三、核心用户流程

### Flow 1: 创建任务到执行完成

```
概览页
  → 点击 [模块: Workspace] 或侧边栏 [+] 新增 Task
    → new-task.html
      → 填写任务描述 + 选目录 + 关联 flow/agent
        → 提交
          → workspace.html?new=1&task=...
            → 项目频道出现新消息
              → @agent 派发任务
                → agent 自动回复 (经网关注入 run_id)
                  → 点击关联 flow [在 AgentFlows 打开 →]
                    → agentflows.html
                      → 展开 flow 卡片
                        → 点击 run 行
                          → DAG 详情视图
                            → 点击节点查看 Inspector
                              → 查看输入/输出/日志
```

### Flow 2: Agent 管理流程

```
概览页
  → 点击 [模块: Agents] 或侧边栏 Agents
    → agents.html
      → 筛选 (状态/类型/角色) + 搜索
        → 点击某 agent 行
          → agent-detail.html
            → Activity tab: 查看运行统计和趋势
            → Instructions tab: 查看系统提示词
            → Skills tab: 查看已挂载技能
            → Logs tab: 查看日志和区域信息
      → 或: 勾选多个 → 底部批量操作栏 → 查看/复制/归档
```

### Flow 3: Flow 编排与运行

```
概览页
  → 点击 [模块: AgentFlows] 或侧边栏 AgentFlows
    → agentflows.html (列表视图)
      → 点击 [▶ 运行] 或展开卡片点击某个 run
        → SPA 切换到 DAG 详情视图
          → 点击各节点查看 Inspector
            → 状态/输入/输出/预算/日志
      → 或: 点击 [编辑画布] → 打开 Flowise 编辑器
```

### Flow 4: 工作流设计到 Daemon 执行

```
工作流编辑器 (workflow-editor.html)
  → 从左侧面板拖放 14 种节点到画布
    → 连线建立 DAG
      → 配置节点属性
        → 点击 [运行工作流 ▶]
          → daemon-execution.html
            → 实时查看各节点执行状态
              → 查看日志/进度/成本
                → 暂停/中止/重新运行
            → [← 返回工作流编辑器]
              → 回到 workflow-editor.html
```

### Flow 5: 工作流设计到 Daemon 执行

```
工作流编辑器 (workflow-editor.html)
  → 从左侧面板拖放 14 种节点到画布
    → 连线建立 DAG
      → 配置节点属性
        → 点击 [运行工作流 ▶]
          → daemon-execution.html
            → 实时查看各节点执行状态
              → 查看日志/进度/成本
                → 暂停/中止/重新运行
            → [← 返回工作流编辑器]
              → 回到 workflow-editor.html
```

### Flow 6: 系统配置

```
侧边栏 设置
  → settings.html
    → 网关连接: 查看 new-api 状态/令牌数/请求量/成本
    → API 令牌: 创建/编辑/复制/删除令牌 (Modal 弹窗)
    → 模型: 查看可用模型列表/价格/设置默认
    → 预算与熔断: 开关配置超额拒绝/预警/webhook/自动降并发
    → 通知: 配置邮件/Slack/Webhook 通知渠道
```

---

## 四、跨系统联动关系

```
┌──────────┐     run_id     ┌──────────┐     flow_id    ┌──────────┐
│ Workspace │ ←──────────── │ Agent    │ ←─────────── │ Agent    │
│ (对话)    │                │ Flows    │               │ Flows    │
└──────────┘                │ (DAG)    │               │ (列表)   │
     │                      └──────────┘               └──────────┘
     │ 关联 flow ↓              ↑ 节点使用 agent
     │                           │
     ▼                           ▼
┌──────────┐     daemon      ┌──────────┐
│ 工作流    │ ────────────→ │ Agents   │
│ 编辑器    │               │ (列表)   │
└──────────┘               └──────────┘
     │                           │
     │ 运行 →                    │ 详情 ↓
     ▼                           ▼
┌──────────┐               ┌──────────┐
│ Daemon    │               │ Agent    │
│ 执行视图  │               │ 详情     │
└──────────┘               └──────────┘

全局: 设置 (new-api 网关/令牌/模型/预算) → 所有页面受令牌和预算约束
全局: 概览页 → 所有模块的统一入口
```

---

## 五、通用交互模式

### 筛选/搜索
- 所有列表页支持实时搜索 + 多维筛选
- 筛选激活时显示徽标计数 + "清除筛选" 按钮
- 搜索框 `⌘K` 全局快捷键

### Skeleton 加载
- 列表页和详情页首次渲染显示 skeleton shimmer 动画
- ~200ms 后替换为真实数据 (模拟 fetch)

### Toast 通知
- 操作反馈 (复制/归档/注册) 通过右下角 toast 显示
- 2.4s 后自动淡出

### Modal 弹窗
- 设置页令牌 CRUD 使用 Modal (backdrop + 缩放入场)
- Escape 或点击 backdrop 关闭

### 批量操作
- Agents 列表支持 checkbox 多选 → 底部浮动操作栏
- 全选/半选/清除/查看详情/复制/归档

### SPA 内视图切换
- AgentFlows 列表 ↔ DAG 详情: 同页面 display 切换
- Workspace 项目切换: sidebar task click → pushState + CustomEvent
- URL hash 深链接: `#flow={id}&run={runId}`

### 响应式断点
- `> 1024px`: 完整多栏布局
- `640-1024px`: 双栏折叠为单栏，操作按钮隐藏
- `< 640px`: 全单栏，卡片操作栏隐藏
