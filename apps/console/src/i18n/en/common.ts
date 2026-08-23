/**
 * 英文词典 — 核心界面（侧栏 / 导航 / 首页 / composer / 目录选择）。
 * key 为现有中文文案（自然键）；zh-CN 模式直接显示 key，无需中文词典。
 */

export const common = {
  // ── 侧栏 ──
  '新建对话': 'New chat',
  '搜索对话…': 'Search chats…',
  '搜索对话': 'Search chats',
  '清空搜索': 'Clear search',
  '显示更多': 'Show more',
  '对话': 'Chats',
  '展开侧栏': 'Expand sidebar',
  '折叠侧栏': 'Collapse sidebar',
  '添加项目目录': 'Add project directory',
  '删除目录': 'Delete directory',
  '目录名称': 'Directory name',
  '目录操作': 'Directory actions',
  '重命名': 'Rename',
  删除: 'Delete',
  '删除中…': 'Deleting…',
  详情: 'Details',
  设置: 'Settings',
  概览: 'Overview',
  技能: 'Skills',
  '在「{name}」中新建对话': 'New chat in “{name}”',
  '本机模式 — 无需登录': 'Local mode — no login',
  本地工作台: 'Local workbench',
  本机模式: 'Local mode',

  // ── 导航（nav.ts 的 label 经 t() 包裹） ──
  Agent: 'Agents',
  Flow: 'Flows',
  Daemon: 'Daemons',

  // ── 首页 ──
  '开始对话': 'Start a conversation',
  '选择项目目录，输入指令，Agent 会理解你的意图并执行。':
    'Pick a project directory and type an instruction — the agent will understand and execute.',
  '开始前，请先添加一个项目目录': 'Add a project directory to get started',
  'DAgent 需要知道在哪里运行 Agent。添加一个本地目录即可开始对话。':
    'DAgent needs to know where to run agents. Add a local directory to start chatting.',
  '浏览本地目录…': 'Browse local directory…',
  '或前往目录管理页 →': 'Or open directory management →',
  '创建 Agent': 'Create an agent',
  '开始对话 ': 'Start chatting',
  '请先添加项目目录': 'Please add a project directory first',
  '等待选择…': 'Waiting for selection…',

  // ── Composer ──
  '发送消息…（输入 @ 触发命令）': 'Send a message… (type @ for commands)',
  发送消息: 'Send message',
  '停止生成': 'Stop generating',
  '消息输入框': 'Message input',
  '命令选择': 'Command picker',
  '插入 @ 命令': 'Insert @ command',
  '⏎ 发送 · ⇧⏎ 换行 · @ 命令': '⏎ Send · ⇧⏎ New line · @ Commands',
  '选择 ↑↓ · 确认 Tab · 关闭 Esc': 'Navigate ↑↓ · Confirm Tab · Close Esc',

  // ── 目录选择器 ──
  '选择目录': 'Select directory',
  '自动选择': 'Auto select',
  未绑定: 'Not bound',

  // ── 相对时间 ──
  刚刚: 'now',
  '{n}分': '{n}m',
  '{n}时': '{n}h',
  '{n}天': '{n}d',
  '{n}月': '{n}mo',
  '{n}年': '{n}y',

  // ── 通用状态 ──
  空闲: 'Idle',
  运行中: 'Running',
  已完成: 'Completed',
  失败: 'Failed',
  复制: 'Copy',
  已复制: 'Copied',
  '复制标题': 'Copy title',
  取消: 'Cancel',
  保存: 'Save',
  刷新: 'Refresh',

  // ── 建议卡片 ──
  '帮我理解这个项目的架构': 'Help me understand this project\'s architecture',
  '写一个单元测试': 'Write a unit test',
  '审查最近的代码变更': 'Review recent code changes',
  '帮我重构一个函数': 'Refactor a function for me',
  '如何添加我的第一个项目目录？': 'How do I add my first project directory?',
  '帮我创建第一个 Agent': 'Help me create my first agent',
  '什么是 AgentFlow？': 'What is an AgentFlow?',
  '这个平台能做什么？': 'What can this platform do?',
  '帮我创建一个批量推理的 AgentFlow': 'Create a batch-inference AgentFlow for me',
  '查看当前资源看板的 agent 状态': 'Show agent status on the resource board',
  '设计一个多步骤的 Workspace 任务': 'Design a multi-step workspace task',
  '测试新的 Agent prompt 模板': 'Test a new agent prompt template',

  // ── 侧栏补充 ──
  新对话: 'New chat',
  '加载中…': 'Loading…',
  '暂无项目目录，点击上方按钮添加': 'No project directories yet — click the button above to add one',
  '「{name}」目录操作': 'Directory actions for “{name}”',
  '删除此对话？': 'Delete this chat?',
  '重命名 {name}': 'Rename {name}',
  '删除 {name}': 'Delete {name}',
  '显示更多 {n} 个对话': 'Show {n} more chats',
  收起: 'Show less',
  '重命名目录': 'Rename directory',
  '删除目录…': 'Delete directory…',
  '删除目录「{name}」？': 'Delete directory “{name}”?',
  '将同时删除其中 {n} 个对话，此操作不可撤销。': 'This will also delete {n} chats inside it. This cannot be undone.',

  // ── @ 命令菜单 ──
  '指定 Agent 执行': 'Run with a specific agent',
  '触发工作流': 'Trigger a workflow',
  'AI 创建工作流': 'AI-generate a workflow',
  '发送 Daemon 命令': 'Send a daemon command',
  '覆盖当前默认 Agent，用指定 Agent 执行任务': 'Override the default agent for this task',
  '运行一个 AgentFlow 工作流，支持多步骤 DAG 编排': 'Run an AgentFlow workflow (multi-step DAG)',
  '用自然语言描述需求，AI 自动生成工作流画布': 'Describe your need — AI generates the workflow canvas',
  '向 Daemon 发送原始命令（如 shell 指令）': 'Send raw commands to a daemon (e.g. shell)',

  // ── 主题/通知/搜索/悬浮窗 ──
  跟随系统: 'Follow system',
  浅色: 'Light',
  深色: 'Dark',
  '主题：{label}（点击切换 · Shift+点击跟随系统）': 'Theme: {label} (click to toggle · Shift+click for system)',
  '切换主题，当前：{label}': 'Toggle theme, current: {label}',
  通知: 'Notifications',
  '关闭通知': 'Close notification',
  '搜索失败，请重试': 'Search failed, please retry',
  '搜索结果': 'Search results',
  '搜索中…': 'Searching…',
  '无匹配结果': 'No matches',
  '仅显示前 {n} 条，输入更精确的关键词可缩小范围': 'Showing first {n} results — refine your keywords to narrow down',
  '{n} 步骤': '{n} steps',
  思考中: 'Thinking',
  思考: 'Thought',
  '打开聊天': 'Open chat',
  '请先选择项目目录': 'Select a project directory first',
  聊天: 'Chat',
  关闭: 'Close',
  '实时连接断开，回退到轮询': 'Live connection lost — falling back to polling',
  实时连接断开: 'Live connection lost',
  '开始一段对话': 'Start a conversation',
  '选择目录与 Agent，发送消息即可触发任务': 'Pick a directory and agent, then send a message to trigger a task',
  '加载历史消息…': 'Loading history…',
  'Agent 执行中…': 'Agent running…',
  '发送消息给 Agent…': 'Message the agent…',
} as const
