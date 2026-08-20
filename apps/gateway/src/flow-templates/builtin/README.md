# 内置流程模板（Built-in Flow Templates）

随仓库分发的官方流程模板，console `/flows` →「从模板创建」→「内置模板」tab 展示。
设计与契约见 `docs/flow-templates.md`。

## 新增一个内置模板（PR 指南）

1. 在本目录新增 `your-template.json`，格式：

```jsonc
{
  "name": "模板名（中文即可）",
  "description": "一句话说清场景；若含 agentRefs 注明需要人格库、未挂载时会降级",
  "icon": "🧩",
  "category": "dev | research | content | ops",
  "flowData": {
    "nodes": [ /* 画布节点，平铺 data.<field>；platformAgent 节点 inputs.agentId 留空 */ ],
    "edges": [ /* 连线 */ ]
  },
  "agentRefs": [
    { "nodeId": "node_2", "personaName": "Software Architect", "task": "该节点的任务指令" }
  ]
}
```

2. 在 `index.ts` 加一行 `import` 并加入 `FILES` 数组。
3. 若模板含 `agentRefs`：`personaName` 必须与挂载人格库（如
   [agency-agents](https://github.com/msitarzewski/agency-agents)）的 frontmatter
   `name` **完全一致** —— 未挂库时该节点自动降级为 LLM 节点（任务指令当
   systemPrompt），模板仍可运行。
4. 节点类型与 `data.<field>` 约定参考现有模板或
   `apps/console/tests/e2e/helpers/flow-builder.ts`。

## 约束

- 第一个节点必须是 `startAgentflow`；
- 不写任何本机状态（agentId / 运行输出）—— 模板要能在任何环境实例化；
- 节点任务指令用中文（与 @workflow 生成器的语言约定一致）。
