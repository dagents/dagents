# Skills Registry（技能运行时注册表）

> 设计参考 deepseek-harness 的 skill 能力族（registry-not-database）与
> `~/.agents/skills` 跨客户端目录约定（Cursor / Gemini CLI / GitHub Copilot
> CLI 均支持扫描该目录）。

## 设计决策

**注册表而非落库**：技能（SKILL.md 指令包）是 agent 的能力注入，不是可执行
agent，也不持久化为平台实体。文件系统是唯一真相源——`~/.agents/skills` 改了，
下一个请求就能看到（catalog 有 60s TTL 缓存，`?refresh=1` 强制重扫；详情每次
都重读磁盘，正文不缓存）。

## 发现根（rank 升序，同名低 rank 赢）

| Rank | 来源 | 根 |
|------|------|-----|
| 300+ | custom (env) | `DAGENTS_SKILL_DIRS`（冒号分隔，可多个，依次 300/301/…） |
| 400+ | custom (ui) | `~/.agents/skill-dirs.json`（console 界面添加，可多个） |
| 500 | user-agents | `~/.agents/skills` |

**UI 管理目录（2026-08-17）**：console `/skills` 页直接输入目录路径即可加载
——`POST /api/v1/skills/roots { dir }` 校验目录存在后持久化到
`~/.agents/skill-dirs.json` 并强制重扫，一次往返返回最新 `{ skills, roots }`，
无需重启网关。`DELETE /api/v1/skills/roots?dir=…` 移除（env 配置的目录
`removable: false`，界面不显示删除按钮）。env 与 UI 同路径时 env 优先
（去重，不重复注册）。UI 目录数上限 16。

接受的形态（不递归发现嵌套 SKILL.md，与 dsh 行为一致）：

- 目录包：`<root>/<name>/SKILL.md`
- 扁平文件：`<root>/<name>.md`

frontmatter 校验（warn-and-skip，单个技能非法不会让整次扫描失败）：

- `name` 必须 kebab-case（`^[a-z0-9]+(?:-[a-z0-9]+)*$`）
- `description` 必须非空（多行折叠会被归一化为单行空白）
- 其余键（`triggers`、`allowed-tools` 等）保留在详情接口的 `metadata` 里

## API

```
GET /api/v1/skills?refresh=1
→ { success, data: { skills: [{ name, description, source }], roots: [...] } }
   # 目录只含摘要 —— 不含正文、不含绝对路径（防泄漏，同 dsh 目录契约）
   # roots 项带 removable 标记（UI 管理的目录界面可删）

GET /api/v1/skills/:name
→ { success, data: { name, description, source, content, dir, metadata } }
   # 完整定义；正文每次重读磁盘。未知/非 kebab-case 名称 → 404

POST /api/v1/skills/roots { dir }
→ { success, data: { dir, skills, roots } }
   # 校验目录存在 → 持久化 + 强制重扫；非法目录 → 400

DELETE /api/v1/skills/roots?dir=…
→ { success, data: { dir, skills, roots } }
   # 移除 UI 管理的目录（env 配置的不可移除 → 400）
```

console 侧代理：`/api/skills`、`/api/skills/:name`、`/api/skills/roots`
（POST 透传 body；DELETE 走 query，gatewayProxy 不为 DELETE 转发请求体）→
gateway；页面 `/skills`（侧边栏「技能」入口 + ⌘K 命令面板）。

## 代码位置

| 文件 | 职责 |
|---|---|
| `apps/gateway/src/skills-registry.ts` | 扫描 / frontmatter 解析 / rank 合并 / TTL 缓存 |
| `apps/gateway/src/skill-injection.ts` | 执行侧消费：skills 名称 → SKILL.md 正文 → system prompt 组装（尺寸护栏） |
| `apps/gateway/src/routes/skills.ts` | 只读 HTTP 投影 |
| `apps/console/src/lib/skills.ts` | 客户端类型 + fetcher |
| `apps/console/src/components/skills-view.tsx` | 技能库页面（搜索 / 来源筛选 / 懒加载详情） |
| `apps/gateway/src/__tests__/skills.test.ts` | 回归测试（形态 / 校验 / rank / 缓存 / 路由） |
| `apps/gateway/src/__tests__/skill-injection.test.ts` | 注入回归（组装 / 缺失跳过 / 截断护栏） |

## Agent 挂载（2026-08-16）

Agent 详情页 Skills tab 支持从本地技能库导入：勾选 chip →「保存挂载」
PATCH `/api/v1/agents/:id` `{ skills: string[] }`（去重、仅存名称引用）。
技能本体始终以文件系统为真相源 —— 目录里删掉即失效，挂载只是名称引用。

## 执行侧消费（2026-08-17）

挂载的技能在两条执行路径上都注入 system prompt（`skill-injection.ts`
统一组装：instructions + `## Skills` 章节 + 各技能正文）：

- **inline chat**（默认路径）：`inline-executor` 读取 `agents.instructions +
  skills`，经 `ExecOptions.systemPrompt` 传给 CLI 适配器。claude/codebuddy/pi
  走 `--append-system-prompt`，openclaw 内联进消息；不支持系统提示的 CLI
  （cursor/antigravity/deveco）由适配器丢弃，行为与之前一致。
- **workflow PlatformAgent 节点**：`createAgentFetcher` 在网关侧预解析正文
  组装进 instructions，传给节点的 `skills` 为空数组（节点层的技能名清单
  只作为未预解析 fetcher 的兜底，避免重复声明）。

护栏：单技能正文 16k 字符、总计 48k 字符封顶（截断时标注来源目录）；
声明的技能名在注册表里找不到则 warn 跳过，不让执行失败。正文每次
`get()` 现读磁盘，改 SKILL.md 即时生效（详情不缓存）。

## 现状与限制

- 无 fs.watch：目录变化靠 60s TTL 或手动「刷新」（`?refresh=1`）。dsh 用
  chokidar 监听 + digest 去重，若后续要做模型侧 catalog 注入可参考。
- 注入是「整篇正文进 system prompt」的朴素模式：技能多/正文长时走截断
  护栏；dsh 式「catalog 索引 + 按需取正文」的两段式注入是后续演进。
- 项目级 `.agents/skills`（dsh rank 200/500 对应的 project 层）未实现 ——
  dagents 的 gateway 是单机平台服务，无「当前项目根」概念；如需可经
  `DAGENTS_SKILL_DIRS` 显式指定。
