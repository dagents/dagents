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
}
