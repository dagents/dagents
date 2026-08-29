/**
 * 英文词典 — chat 界面模块（chat-detail / context-panel / command-palette /
 * keyboard-shortcuts / onboarding / selector 系列）。key 为现有中文文案
 * （自然键）；与 common.ts 重复的词条（如 保存/取消/复制）不在此重复维护。
 */
export const chat: Record<string, string> = {
  // ── chat-detail（对话详情） ──
  '实时连接断开 — 助手回复可能无法实时收到，正在尝试重连…':
    'Live connection lost — assistant replies may not stream in. Reconnecting…',
  '重新连接中…': 'Reconnecting…',
  '加载失败：{error}': 'Failed to load: {error}',
  '发送消息，或试试以下建议：': 'Send a message, or try one of these suggestions:',
  '建议提示': 'Suggested prompts',
  '列出这个目录的文件结构': "List this directory's file structure",
  '解释这个项目的架构': "Explain this project's architecture",
  '帮我写一个单元测试': 'Write a unit test for me',
  '查看当前 agent 的状态': 'Show current agent status',
  '解释这段代码的作用': 'Explain what this code does',
  '帮我调试一个错误': 'Help me debug an error',
  '未知错误': 'Unknown error',
  '执行失败': 'Execution failed',
  '检查 Agent 配置': 'Check agent configuration',
  '重试': 'Retry',
  '复制错误信息': 'Copy error details',
  '复制回复内容': 'Copy reply',
  '复制消息': 'Copy message',
  '正在执行…': 'Working…',
  '正在思考…': 'Thinking…',
  '滚动到最新消息': 'Scroll to latest message',
  '_(已停止)_': '_(stopped)_',
  '多次失败，请检查 Agent 配置（已重试 {n} 次）':
    'Failed repeatedly — please check the agent configuration (retried {n} times)',

  // ── flow-preview-card（@workflow 生成成功预览卡） ──
  '工作流已创建': 'Workflow created',
  '引擎 {engine}': 'engine {engine}',
  '自动修复 {n} 轮后通过': 'passed after {n} repair round(s)',
  '打开画布': 'Open canvas',
  '去 Flows 运行': 'Run in Flows',
  'AI 生成的工作流': 'AI-generated workflow',

  // ── chat-context-panel（上下文面板） ──
  '所属目录': 'Directory',
  '绑定 Agent': 'Bound agent',
  '编辑': 'Edit',
  '绑定 Flow': 'Bound flow',
  '统计': 'Stats',
  '消息数': 'Messages',
  '状态': 'Status',
  '执行记录': 'Run history',
  '暂无执行记录': 'No runs yet',

  // ── command-palette（命令面板） ──
  '命令面板': 'Command palette',
  '搜索页面、对话或操作…': 'Search pages, chats, or actions…',
  '搜索命令': 'Search commands',
  '没有匹配的命令': 'No matching commands',
  '导航': 'Navigate',
  '选择': 'Select',
  '跳转': 'Go to',
  '页面': 'Pages',
  '首页': 'Home',
  '操作': 'Actions',
  '新建 Agent': 'New agent',
  '新建 Flow': 'New flow',
  '无标题对话': 'Untitled chat',

  // ── keyboard-shortcuts（快捷键说明） ──
  '键盘快捷键': 'Keyboard shortcuts',
  '关闭': 'Close',
  '搜索和导航（命令面板）': 'Search and navigate (command palette)',
  '显示快捷键帮助': 'Show keyboard shortcuts help',
  '关闭弹窗 / 菜单': 'Close dialog / menu',
  '换行（不发送）': "New line (don't send)",
  '触发命令菜单': 'Open command menu',
  '前往首页': 'Go to Home',
  '前往 Agent': 'Go to Agents',
  '前往 Flow': 'Go to Flows',
  '前往 Daemon': 'Go to Daemons',
  '前往设置': 'Go to Settings',
  '全局': 'Global',
  '按': 'Press',
  '随时打开此面板': 'anytime to open this panel',

  // ── onboarding-checklist / onboarding-complete-banner ──
  '项目目录': 'Project directory',
  'CLI 已安装': 'CLI installed',
  'Agent 已创建': 'Agent created',
  '🚀 快速配置': '🚀 Quick setup',
  '一切就绪！试试发送你的第一条消息吧': 'All set! Try sending your first message',
  'Agent 已就绪，输入指令即可开始对话。':
    'Your agent is ready — type an instruction to start chatting.',

  // ── directory-selector ──
  '还没有项目目录，点击上方按钮添加':
    'No project directories yet — click the button above to add one',

  // ── flow-selector ──
  '选择 Flow': 'Select flow',
  '无 Flow': 'No flow',
  '不绑定工作流': 'No workflow bound',
  '还没有 Flow · 去创建': 'No flows yet · Create one',

  // ── agent-selector ──
  '选择 Agent': 'Select agent',
  '让 chat 自动选择': 'Let the chat pick automatically',
  '已安装的 CLI · 选中即自动创建': 'Installed CLIs · Select to auto-create',
  '创建中…': 'Creating…',
  '点击创建': 'Click to create',
  '未安装': 'Not installed',
  '还没有 Agent · 去创建': 'No agents yet · Create one',

  // ── 画布运行 ──
  '运行完成 · {n}s': 'Run finished · {n}s',
  '运行失败 · {reason}': 'Run failed · {reason}',
  '运行失败：{reason}': 'Run failed: {reason}',
  '▶ 运行': '▶ Run',
  '▶ 再次运行': '▶ Run again',
  '▶ 重试运行': '▶ Retry run',
  '在画布上运行此工作流，节点将实时显示执行进度': 'Run this workflow on the canvas — nodes show live execution progress',

  // ── 画布旁观入口 ──
  '画布查看': 'View on canvas',
  '在画布中查看此运行的节点级进度': 'Watch this run\'s node-level progress on the canvas',
  '运行完成': 'Run finished',
  '已取消': 'Cancelled',
  '运行失败': 'Run failed',

  // ── 画布运行输入/结果面板 ──
  '运行输入': 'Run input',
  '输入将作为 {{$start.input}} 传入（节点里可用 {{<节点id>.output}} 引用上游产出）':
    'Passed in as {{$start.input}} (nodes can reference upstream output via {{<nodeId>.output}})',
  '开始运行': 'Start run',
  '运行结果': 'Run results',
  '运行结果（{n}）': 'Results ({n})',
  '查看每个节点的执行状态与产出': 'Inspect per-node status and output',
  完成: 'Done',
  '（无产出）': '(no output)',
  产出: 'Output',

  // ── 异步运行/失败即时检测 ──
  '启动失败 · {reason}': 'Failed to start · {reason}',
  '启动失败：{reason}': 'Failed to start: {reason}',
  '运行失败 · {n}s': 'Run failed · {n}s',
  '运行失败 · {node}': 'Run failed · {node}',
  '运行失败 — 详见「运行结果」面板中红色节点': 'Run failed — see the red node in the results panel',
  '运行失败 — 详见红色节点的错误信息': 'Run failed — see the red node for the error',
  '节点 {node} 失败 — 展开运行结果查看详情': 'Node {node} failed — expand results for details',
  正在执行: 'Running',
  失败: 'failed',
  准备中: 'Preparing',
  收尾中: 'Finalizing',
  输入: 'Input',
  '已取消 · {n}s': 'Cancelled · {n}s',

  // ── 运行目录选择 ──
  '（无目录 — Agent 在网关目录运行）': '(no directory — agents run in the gateway dir)',
  'Agent 将在所选项目目录中读写文件、执行命令': 'Agents will read/write files and run commands inside the selected project',

  // ── 结果面板 v2 ──
  '原始数据': 'Raw data',
  '（执行中…）': '(running…)',
  'token 用量（输入/输出）': 'Token usage (input/output)',

  // ── 聊天内工作流执行卡 ──
  '工作流': 'Workflow',
  '（尚无节点执行记录）': '(no node executions yet)',
  '在画布中查看': 'View on canvas',
  '疑似权限受限': 'Possible permission refusal',
  'Agent': 'Agent',

  // ── 2026-08-26 全站 UX 优化新增词条 ──
  '输入消息，@ 呼出命令': 'Type a message, @ for commands',
  '🚀 第一个 Agent 回复已收到！': '🚀 First agent reply received!',
  '项目目录加载失败': 'Failed to load project directories',
  '项目目录刷新失败': 'Failed to refresh project directories',
  '添加项目目录失败': 'Failed to add project directory',
  '重命名失败': 'Rename failed',
  '删除对话失败': 'Failed to delete chat',
  '新建对话失败': 'Failed to create chat',
  '重命名目录失败': 'Failed to rename directory',
  '删除目录失败': 'Failed to delete directory',
  'Agent 绑定更新失败': 'Failed to update agent binding',
  'Flow 绑定更新失败': 'Failed to update flow binding',
  '取消请求发送失败，任务可能仍在后台执行': 'Cancel request failed — the task may still be running in the background',
  '查看 Agent「{name}」的运行状态': 'Check agent “{name}” status',
  '关闭错误提示': 'Dismiss error',
  '对话列表': 'Chat list',

'在详情页打开': 'Open in detail page',
'历史对话': 'Chat history',
'搜索会话…': 'Search chats…',
'没有匹配的会话': 'No matching chats',
'选择目录与 Agent，发送消息即可触发任务；@workflow 可一句话生成流程': 'Pick a directory and agent, then send; @workflow generates a flow in one sentence',
}
