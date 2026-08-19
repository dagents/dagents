/**
 * 英文词典 — flows 界面模块。
 * key 为现有中文文案（自然键）；zh-CN 模式直接显示 key，无需中文词典。
 */

export const flows: Record<string, string> = {
  // ── 列表页：scope tabs / 工具栏 ──
  '我的': 'Mine',
  '全部': 'All',
  '已归档': 'Archived',
  'flow 范围': 'Flow scope',
  '搜索 flow 名称或 ID…': 'Search flow name or ID…',
  '搜索 flow': 'Search flows',
  '{n} / {total} 个 flow': '{n} / {total} flows',
  // 与 chat.ts 同 key 同值（跨模块共享词条，保持一致避免合并顺序歧义）
  '新建 Flow': 'New flow',
  '加载 flow 列表…': 'Loading flows…',

  // ── 列表页：空态 ──
  '还没有 Flow': 'No flows yet',
  '没有匹配的 Flow': 'No matching flows',
  '创建你的第一个 Flow，编排 Agent 协作流程。': 'Create your first Flow to orchestrate agent collaboration.',
  '试试调整筛选条件或清除搜索。': 'Try adjusting the filters or clearing the search.',
  '清除过滤器': 'Clear filters',

  // ── 列表页：flow 卡片 ──
  '展开 flow {name} 的运行记录': 'Expand run history of flow {name}',
  '{n} 节点': '{n} nodes',
  '{n} 次运行': '{n} runs',
  '尚无运行状态数据': 'No run status data yet',
  '在画布中编辑': 'Edit on the canvas',
  '编辑画布': 'Edit canvas',
  '运行此 flow': 'Run this flow',
  '运行中…': 'Running…',
  '▶ 运行': '▶ Run',
  '运行失败 ({status})': 'Run failed ({status})',
  '触发': 'Trigger',
  '暂无运行记录 — 从 Flow 详情页或画布触发运行': 'No runs yet — trigger one from the flow detail page or the canvas',

  // ── 详情页 ──
  '返回 AgentFlows 列表': 'Back to the AgentFlows list',
  '返回 Flow 列表': 'Back to the Flow list',
  '加载中…': 'Loading…',
  '加载 DAG…': 'Loading DAG…',
  '{type} 节点': '{type} node',
  'Flow 概览': 'Flow overview',

  // ── 状态标签（STATUS_CN / SPAN_STATUS_CN，渲染处 t(map[status])）──
  '运行': 'Running',
  '完成': 'Done',
  '排队': 'Queued',
  // 与 agents.ts 同 key 同值（跨模块共享词条，保持一致避免合并顺序歧义）
  '人工暂停': 'Paused (manual)',
  '未触发': 'Not triggered',
  '未知': 'Unknown',

  // ── 节点检查器 ──
  '节点不存在。': 'Node not found.',
  '状态': 'Status',
  '节点状态': 'Node status',
  '落库状态': 'Persisted status',
  '所属 run': 'Run',
  '所属 flow': 'Flow',
  '节点类型': 'Node type',
  '节点说明': 'Node description',
  '节点配置': 'Node config',
  '输入': 'Input',
  '输出': 'Output',
  '预算与计量': 'Budget & metering',
  '预算上限': 'Budget limit',
  '已用 tokens': 'Tokens used',
  '已用成本': 'Cost used',
  '耗时': 'Duration',
  '超时': 'Timeout',
  '节点错误：{msg}': 'Node error: {msg}',
  '节点级 token/成本/耗时来自 M6.4 节点级 trace 落库；该 run 暂无落库 span。':
    'Node-level token/cost/duration data comes from M6.4 node-level traces; this run has no persisted spans.',
  '日志': 'Logs',
  '暂无日志': 'No logs yet',

  // ── Flow 概览检查器 ──
  '选择一个 flow 查看概览。': 'Select a flow to see its overview.',
  'Flow 状态': 'Flow status',
  '整体状态': 'Overall status',
  '节点数': 'Nodes',
  '最近 run': 'Latest run',
  '更新时间': 'Updated at',
  '节点状态分布': 'Node status breakdown',
  '提示': 'Tip',
  '点击 DAG 中的节点查看其状态与日志。画布只读浏览；编排请在':
    'Click a node in the DAG to see its status and logs. This canvas is read-only; do your editing in the',
  '画布完成。': 'canvas.',

  // ── 运行表头 / 图例 ──
  '成本': 'Cost',
  '时间': 'Time',
  '滚轮缩放 · 拖拽平移': 'Scroll to zoom · drag to pan',

  // ── 画布节点类型描述（CANVAS_NODE_DESCRIPTIONS，渲染处 t(description)）──
  '工作流入口节点': 'Workflow entry node',
  '自主推理 Agent，可使用工具进行多轮推理': 'Autonomous agent that reasons over multiple turns with tools',
  '引用平台上的 Agent，使用其指令和模型配置': 'References a platform agent, reusing its instructions and model config',
  '大语言模型调用': 'LLM call',
  '自定义工具定义，包含处理代码': 'Custom tool definition with handler code',
  '发起 HTTP 请求': 'Send an HTTP request',
  '基于条件的分支': 'Condition-based branch',
  '基于 LLM 的场景路由': 'LLM-based scenario routing',
  '遍历列表项': 'Iterate over list items',
  '循环直到条件满足': 'Loop until a condition is met',
  '暂停等待人工输入': 'Pause and wait for human input',
  '直接回复用户': 'Reply directly to the user',
  '执行自定义 JavaScript 代码': 'Run custom JavaScript code',
  '执行子工作流': 'Run a sub-workflow',
  '从向量存储检索文档': 'Retrieve documents from a vector store',
}
