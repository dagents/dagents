/**
 * 英文词典 — daemons 界面模块。
 * key 为现有中文文案（自然键）；zh-CN 模式直接显示 key，无需中文词典。
 */

export const daemons: Record<string, string> = {
  // ── daemon 列表：工具栏 / 筛选 ──
  'daemon 状态': 'Daemon status',
  '{n} / {total} 个 daemon': '{n} / {total} daemons',
  '活跃任务': 'Active tasks',
  '注册 Daemon': 'Register daemon',
  '查看全部': 'Show all',

  // ── 筛选 / 状态标签（DAEMON_FILTERS / DAEMON_STATUS_LABEL，渲染处 t()）──
  '全部': 'All',
  '在线': 'Online',
  '离线': 'Offline',
  '排空中': 'Draining',

  // ── 本机 CLI（自动检测）──
  '本机 CLI': 'Local CLIs',
  'Gateway 自动检测本机 PATH — 已安装的可直接在对话中使用（inline 执行，无需 daemon）':
    'The gateway auto-detects local PATH — installed CLIs can be used in chats directly (inline execution, no daemon needed)',
  '{n} 个可用': '{n} available',
  '重新检测': 'Re-detect',
  '重新检测本机 CLI': 'Re-detect local CLIs',
  '检测中…': 'Detecting…',
  '未安装': 'Not installed',
  '核心': 'Core',
  '社区适配器 — 按官方文档实现，未经真机回归': 'Community adapter — implemented from official docs, not regression-tested against the real CLI',
  '未安装 — {hint}': 'Not installed — {hint}',

  // ── 远程 daemon 区 ──
  '远程 Daemon': 'Remote daemons',
  '多机分发用的 worker 进程 — 启动后自动注册，靠心跳保持在线':
    'Worker processes for multi-machine dispatch — they self-register on start and stay online via heartbeats',

  // ── daemon 列表空态 ──
  '没有已注册的 daemon': 'No daemons registered',
  'Daemon 是执行 Agent 任务的 worker 进程。启动一个 daemon 后它会自动注册到这里。':
    'A daemon is a worker process that executes agent tasks. Start one and it will register itself here automatically.',
  '启动 daemon：': 'Start a daemon:',
  '当前过滤器下无 daemon': 'No daemons under the current filter',

  // ── 删除确认 ──
  '删除 Daemon': 'Delete daemon',
  '确定要删除「{name}」吗？此操作不可撤销。': 'Delete “{name}”? This cannot be undone.',
  '删除 daemon {label}': 'Delete daemon {label}',
  '删除失败（{status}）': 'Delete failed ({status})',
  '删除失败（{status}）：{msg}': 'Delete failed ({status}): {msg}',
  '确认删除': 'Confirm delete',

  // ── 相对时间 ──
  '{n} 分钟前': '{n} min ago',
  '{n} 小时前': '{n} hr ago',

  // ── 任务队列视图 ──
  '返回': 'Back',
  '任务状态': 'Task status',
  '{n} 个任务': '{n} tasks',
  '任务队列': 'Task queue',
  '暂无派发任务': 'No dispatched tasks',
  '当前过滤器下无任务': 'No tasks under the current filter',
  '任务由 Agent / Flow 运行时自动派发到此队列。':
    'Tasks are dispatched to this queue automatically by Agent / Flow runs.',
  '尝试切换到「全部」查看所有任务。': 'Try switching to “All” to see every task.',
  '查看全部任务': 'Show all tasks',
  '暂无任务': 'No tasks yet',
  '选择左侧任务查看详情': 'Select a task on the left to see its details',
  '点击队列中的任务卡片查看时间线、任务信息和任务事件。':
    'Click a task card in the queue to see its timeline, task info, and task events.',

  // ── 任务详情 ──
  '时间线': 'Timeline',
  '任务创建': 'Task created',
  '派发到 daemon': 'Dispatched to daemon',
  '执行失败': 'Execution failed',
  '执行完成': 'Execution done',
  '任务信息': 'Task info',
  '优先级': 'Priority',
  '描述': 'Description',
  '任务事件': 'Task events',
  '暂无事件记录': 'No event records',

  // ── 注册 Daemon 对话框 ──
  '请填写 daemon 标签': 'Please fill in a daemon label',
  '请至少选择一种 agent 类型': 'Please select at least one agent type',
  '启动命令已生成': 'Start commands generated',
  '复制以下命令到目标机器的 dagents 仓库根目录运行。daemon 启动后会自动注册并出现在列表中（无需提前注册）：':
    'Copy the command(s) below and run them from the dagents repo root on the target machine. The daemon self-registers on start and appears in the list (no pre-registration needed):',
  '全部复制': 'Copy all',
  '标签': 'Label',
  'Agent 类型': 'Agent types',
  '返回修改': 'Back to edit',
  '完成': 'Done',
  '名称': 'Name',
  '如：dev-laptop': 'e.g. dev-laptop',
  '可多选 — 每种类型生成一条启动命令（一个 daemon 进程对应一种 agent）':
    'Multi-select — one start command per type (one daemon process per agent)',
  '生成启动命令': 'Generate start commands',

  // ── 2026-08-26 全站 UX 优化新增词条 ──
  '任务队列（全局）': 'Task queue (global)',
  '当前为全平台任务视图，暂无按 daemon 过滤': 'Platform-wide task view — per-daemon filtering not available yet',
  '任务加载失败：{error}': 'Failed to load tasks: {error}',
  'CLI 检测失败：{error} — 下方「未安装」状态不可信': 'CLI detection failed: {error} — “not installed” below is unreliable',
  'CLI 检测失败：{error} — 表内「未安装」状态不可信': 'CLI detection failed: {error} — “not installed” in the table is unreliable',
  '已复制': 'Copied',

  // ── CLI 运行时卡片 tooltip（tiers.ts note + agents-catalog hint，2026-08-27）──
  '按官方文档实现，待真机回归（方案 C）':
    'Implemented from official docs; real-CLI regression pending',
  '通义千问编码助手': 'Tongyi Qwen coding assistant',
  '开源编码 agent': 'Open-source coding agent',
  '腾讯 CodeBuddy（Claude fork）': 'Tencent CodeBuddy (Claude fork)',
  '华为鸿蒙编码助手': 'Huawei HarmonyOS coding assistant',
  '字节 TRAE CLI': 'ByteDance TRAE CLI',
}
