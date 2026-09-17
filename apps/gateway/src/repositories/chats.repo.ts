/**
 * chats.repo.ts — `chats` + `chat_messages` 两张表的数据访问层。
 *
 * chats：会话主档（目录归属 / 标题 / 绑定的 agent 与 flow / 最后一条消息与
 * 计数 / 运行状态机 idle|running|failed…）。chat_messages：会话消息流水
 * （role: user|assistant|system|tool，metadata JSONB 携带来源与 human_input
 * 溯源）。消息写入与 chats 的 last_message/message_count 联动在本层完成
 * （CTE 单语句保证原子）。
 *
 * 从 routes/chats.ts、routes/chat-execute.ts、routes/human-input.ts 抽出的
 * 全部裸 SQL 集中于此；SQL 文本与参数顺序原样搬移（行为逐字等价的重构）。
 */
import { runQuery } from '@dagents/db'

export interface ChatRow {
  id: string
  directory_id: string
  title: string
  status: string
  agent_id: string | null
  flow_id: string | null
  last_message: string | null
  message_count: number
  last_run_id: string | null
  created_at: Date
  updated_at: Date
}

export interface ChatMessageRow {
  id: string
  chat_id: string
  role: string
  content: string
  run_id: string | null
  metadata: unknown
  created_at: Date
}

export function normalizeChat(r: ChatRow) {
  return {
    id: r.id,
    directoryId: r.directory_id,
    title: r.title,
    status: r.status,
    agentId: r.agent_id,
    flowId: r.flow_id,
    lastMessage: r.last_message,
    messageCount: r.message_count,
    lastRunId: r.last_run_id,
    createdAt: r.created_at instanceof Date ? r.created_at.toISOString() : new Date(r.created_at).toISOString(),
    updatedAt: r.updated_at instanceof Date ? r.updated_at.toISOString() : new Date(r.updated_at).toISOString(),
  }
}

export function normalizeMsg(r: ChatMessageRow) {
  let metadata: Record<string, unknown> = {}
  if (typeof r.metadata === 'object' && r.metadata !== null && !Array.isArray(r.metadata)) {
    metadata = r.metadata as Record<string, unknown>
  }
  return {
    id: r.id,
    chatId: r.chat_id,
    role: r.role,
    content: r.content,
    runId: r.run_id,
    metadata,
    createdAt: r.created_at instanceof Date ? r.created_at.toISOString() : new Date(r.created_at).toISOString(),
  }
}

/** 会话列表：按目录过滤 / 按标题模糊 / 全量，三种形态共用 updated_at 倒序。 */
export async function listChats(opts: { directoryId?: string; q?: string; limit: number }): Promise<ChatRow[]> {
  if (opts.directoryId) {
    // Scope to a specific directory
    const { records } = await runQuery<ChatRow>(
      `SELECT id, directory_id, title, status, agent_id, flow_id,
              last_message, message_count, last_run_id,
              created_at, updated_at
         FROM chats
         WHERE directory_id = $1::uuid
         ORDER BY updated_at DESC
         LIMIT $2`,
      [opts.directoryId, opts.limit],
    )
    return records
  }
  if (opts.q) {
    // No directory filter — list all chats (optionally filtered by q)
    const { records } = await runQuery<ChatRow>(
      `SELECT id, directory_id, title, status, agent_id, flow_id,
              last_message, message_count, last_run_id,
              created_at, updated_at
         FROM chats
         WHERE title ILIKE '%' || $1 || '%'
         ORDER BY updated_at DESC
         LIMIT $2`,
      [opts.q, opts.limit],
    )
    return records
  }
  const { records } = await runQuery<ChatRow>(
    `SELECT id, directory_id, title, status, agent_id, flow_id,
            last_message, message_count, last_run_id,
            created_at, updated_at
       FROM chats
       ORDER BY updated_at DESC
       LIMIT $1`,
    [opts.limit],
  )
  return records
}

export interface ChatSearchRow {
  chat_id: string
  chat_title: string
  directory_id: string
  directory_name: string
  snippet_raw: string
  match_type: 'title' | 'content'
  created_at: Date
}

/**
 * 全文搜索：chats.title 与 chat_messages.content 的 UNION 匹配（标题优先，
 * 内容命中给出 ~200 字窗口）。likePattern 由调用方完成 LIKE 通配符转义；
 * <mark> 高亮等展示逻辑留在路由层。
 */
export async function searchChats(opts: {
  likePattern: string
  q: string
  directoryId?: string
  limit: number
}): Promise<ChatSearchRow[]> {
  const params: unknown[] = [opts.likePattern, opts.q]
  let dirFilter = ''
  if (opts.directoryId) {
    params.push(opts.directoryId)
    dirFilter = `AND ch.directory_id = $${params.length}::uuid`
  }
  params.push(opts.limit)
  const limitParam = `$${params.length}`

  const { records } = await runQuery<ChatSearchRow>(
    `
      -- The union is wrapped in a subselect: Postgres only allows the outer
      -- ORDER BY of a UNION to reference output columns directly, not
      -- expressions over them (the CASE below), so it must sort the wrapper.
      SELECT * FROM (
        -- Title matches: snippet_raw is the raw title (capped at 200 chars).
        SELECT ch.id            AS chat_id,
               ch.title         AS chat_title,
               ch.directory_id  AS directory_id,
               d.name           AS directory_name,
               left(ch.title, 200) AS snippet_raw,
               'title'::text    AS match_type,
               ch.created_at    AS created_at
          FROM chats ch
          JOIN directories d ON d.id = ch.directory_id
         WHERE ch.title ILIKE $1 ESCAPE '\\'
           ${dirFilter}
         UNION ALL
        -- Content matches: snippet_raw is a ~200-char window centered on the
        -- first hit (60 chars of context before, then the hit, then the tail).
          SELECT ch.id            AS chat_id,
                 ch.title         AS chat_title,
                 ch.directory_id  AS directory_id,
                 d.name           AS directory_name,
                 substring(cm.content
                          FROM GREATEST(1, POSITION(LOWER($2) IN LOWER(cm.content)) - 60)
                          FOR 200) AS snippet_raw,
                 'content'::text  AS match_type,
                 cm.created_at    AS created_at
            FROM chat_messages cm
            JOIN chats ch ON ch.id = cm.chat_id
            JOIN directories d ON d.id = ch.directory_id
           WHERE cm.content ILIKE $1 ESCAPE '\\'
             ${dirFilter}
      ) search_results
      ORDER BY
        CASE match_type WHEN 'title' THEN 0 ELSE 1 END,
        created_at DESC
      LIMIT ${limitParam}`,
    params,
  )
  return records
}

export async function getChatById(id: string): Promise<ChatRow | null> {
  const { records } = await runQuery<ChatRow>(
    `SELECT id, directory_id, title, status, agent_id, flow_id,
            last_message, message_count, last_run_id,
            created_at, updated_at
       FROM chats
       WHERE id = $1::uuid`,
    [id],
  )
  return records[0] ?? null
}

/** 轻量存在性检查（消息列表路由用它区分 404 与空列表）。 */
export async function chatExists(id: string): Promise<boolean> {
  const { records } = await runQuery<{ id: string }>(
    `SELECT id FROM chats WHERE id = $1::uuid`,
    [id],
  )
  return records.length > 0
}

export async function createChat(input: {
  directoryId: string
  title: string
  agentId?: string | null
  flowId?: string | null
}): Promise<ChatRow | null> {
  const { records } = await runQuery<ChatRow>(
    `INSERT INTO chats (directory_id, title, agent_id, flow_id)
     VALUES ($1::uuid, $2, $3, $4)
     RETURNING id, directory_id, title, status, agent_id, flow_id,
               last_message, message_count, last_run_id,
               created_at, updated_at`,
    [
      input.directoryId,
      input.title,
      input.agentId ?? null,
      input.flowId ?? null,
    ],
  )
  return records[0] ?? null
}

/** PATCH 动态更新：只写提供的列（顺序固定 title → status → agent_id → flow_id）。 */
export async function updateChatFields(
  id: string,
  patch: { title?: string; status?: string; agentId?: string | null; flowId?: string | null },
): Promise<ChatRow | null> {
  const sets: string[] = []
  const params: unknown[] = []

  if (patch.title !== undefined) {
    params.push(patch.title)
    sets.push(`title = $${params.length}`)
  }
  if (patch.status !== undefined) {
    params.push(patch.status)
    sets.push(`status = $${params.length}`)
  }
  if (patch.agentId !== undefined) {
    params.push(patch.agentId)
    sets.push(`agent_id = $${params.length}`)
  }
  if (patch.flowId !== undefined) {
    params.push(patch.flowId)
    sets.push(`flow_id = $${params.length}`)
  }

  sets.push(`updated_at = NOW()`)
  params.push(id)
  const idParam = `$${params.length}::uuid`

  const { records } = await runQuery<ChatRow>(
    `UPDATE chats
        SET ${sets.join(', ')}
      WHERE id = ${idParam}
     RETURNING id, directory_id, title, status, agent_id, flow_id,
               last_message, message_count, last_run_id,
               created_at, updated_at`,
    params,
  )
  return records[0] ?? null
}

/** 删除会话；返回被删 id（null = 不存在）。 */
export async function deleteChat(id: string): Promise<string | null> {
  const { records } = await runQuery<{ id: string }>(
    `DELETE FROM chats WHERE id = $1::uuid RETURNING id`,
    [id],
  )
  return records[0]?.id ?? null
}

export async function listChatMessages(chatId: string): Promise<ChatMessageRow[]> {
  const { records } = await runQuery<ChatMessageRow>(
    `SELECT id, chat_id, role, content, run_id, metadata, created_at
       FROM chat_messages
       WHERE chat_id = $1::uuid
       ORDER BY created_at ASC`,
    [chatId],
  )
  return records
}

/**
 * 追加一条消息并联动 chats 计数（CTE 单语句）：chat 不存在时插入静默落空
 * （返回 null）。POST /chats/:id/messages 的落库路径。
 */
export async function appendChatMessage(
  chatId: string,
  input: { role: string; content: string; runId?: string | null; metadataJson: string },
): Promise<ChatMessageRow | null> {
  const result = await runQuery<ChatMessageRow>(
    `WITH chat_check AS (
       SELECT id FROM chats WHERE id = $1::uuid
     ),
     inserted AS (
       INSERT INTO chat_messages (chat_id, role, content, run_id, metadata)
       SELECT $1::uuid, $2, $3, $4, $5
        FROM chat_check
       RETURNING id, chat_id, role, content, run_id, metadata, created_at
     ),
     updated AS (
       UPDATE chats
          SET last_message = $3,
              message_count = message_count + 1,
              updated_at = NOW()
        WHERE id = $1::uuid
     )
     SELECT * FROM inserted`,
    [
      chatId,
      input.role,
      input.content,
      input.runId ?? null,
      input.metadataJson,
    ],
  )
  return result.records[0] ?? null
}

/** 失败会话重置（幂等）：status 回 idle。 */
export async function resetChatToIdle(id: string): Promise<ChatRow | null> {
  const { records } = await runQuery<ChatRow>(
    `UPDATE chats
        SET status = 'idle', updated_at = NOW()
      WHERE id = $1::uuid
     RETURNING id, directory_id, title, status, agent_id, flow_id,
               last_message, message_count, last_run_id,
               created_at, updated_at`,
    [id],
  )
  return records[0] ?? null
}

/** 流结束后的 best-effort 状态回收（不改计数）。 */
export async function setChatStatusIdle(chatId: string): Promise<void> {
  await runQuery(
    `UPDATE chats SET status = 'idle', updated_at = NOW() WHERE id = $1::uuid`,
    [chatId],
  )
}

/** 进入执行态（agent/flow/daemon 路径共用）。 */
export async function setChatStatusRunning(chatId: string): Promise<void> {
  await runQuery(
    `UPDATE chats SET status = 'running', updated_at = NOW() WHERE id = $1::uuid`,
    [chatId],
  )
}

/** @flow 路径：置 running 并绑定 flow_id（text 列，接受任意字符串）。 */
export async function markChatRunningWithFlow(flowId: string, chatId: string): Promise<void> {
  await runQuery(
    `UPDATE chats SET status = 'running', flow_id = $1, updated_at = NOW() WHERE id = $2::uuid`,
    [flowId, chatId],
  )
}

/** 流式执行入口的绑定快照（agent/flow 分流判定）。 */
export async function getChatExecutionBinding(
  chatId: string,
): Promise<{ flow_id: string | null; agent_id: string | null; directory_id: string | null } | null> {
  const { records } = await runQuery<{ flow_id: string | null; agent_id: string | null; directory_id: string | null }>(
    `SELECT flow_id, agent_id, directory_id FROM chats WHERE id = $1::uuid`,
    [chatId],
  )
  return records[0] ?? null
}

/** 路由决策用的最小快照（routeMessage）。 */
export async function getChatRouting(
  chatId: string,
): Promise<{ id: string; agent_id: string | null; flow_id: string | null } | null> {
  const { records } = await runQuery<{ id: string; agent_id: string | null; flow_id: string | null }>(
    `SELECT id, agent_id, flow_id FROM chats WHERE id = $1::uuid`,
    [chatId],
  )
  return records[0] ?? null
}

/** 会话最新一条 user 消息（流式执行的 prompt 来源）。 */
export async function getLatestUserMessage(chatId: string): Promise<string | null> {
  const { records } = await runQuery<{ content: string }>(
    `SELECT content FROM chat_messages WHERE chat_id = $1::uuid AND role = 'user' ORDER BY created_at DESC LIMIT 1`,
    [chatId],
  )
  return records[0]?.content ?? null
}

/** auto 路由解析出 agent 后回写绑定（后续消息跳过查找）。 */
export async function bindChatAgent(chatId: string, agentId: string): Promise<void> {
  await runQuery(
    `UPDATE chats SET agent_id = $1::uuid, updated_at = NOW() WHERE id = $2::uuid`,
    [agentId, chatId],
  )
}

/**
 * 消息级 override 持久化（agentId/flowId 只写调用方判定需要落盘的项），
 * 让后续读取（流端点 / WS 订阅者）看到同一绑定。
 */
export async function persistChatBindingOverrides(
  chatId: string,
  overrides: { agentId?: string; flowId?: string },
): Promise<void> {
  const updates: string[] = []
  const params: unknown[] = []
  if (overrides.agentId !== undefined) {
    params.push(overrides.agentId)
    updates.push(`agent_id = $${params.length}::uuid`)
  }
  if (overrides.flowId !== undefined) {
    params.push(overrides.flowId)
    updates.push(`flow_id = $${params.length}::uuid`)
  }
  if (updates.length === 0) return
  params.push(chatId)
  await runQuery(
    `UPDATE chats SET ${updates.join(', ')}, updated_at = NOW() WHERE id = $${params.length}::uuid`,
    params,
  )
}

/** 会话绑定目录的绝对路径（INNER JOIN：无目录的会话返回 undefined）。 */
export async function getChatDirectoryPath(chatId: string): Promise<string | undefined> {
  const { records } = await runQuery<{ directory_path: string | null }>(
    `SELECT d.path AS directory_path
       FROM chats c
       JOIN directories d ON d.id = c.directory_id
      WHERE c.id = $1::uuid`,
    [chatId],
  )
  return records[0]?.directory_path ?? undefined
}

/** @daemon 路径：agent 绑定 + 目录路径一次取齐（LEFT JOIN 容忍无目录）。 */
export async function getChatAgentAndDirectoryPath(
  chatId: string,
): Promise<{ agent_id: string | null; directory_path: string | null } | undefined> {
  const { records } = await runQuery<{ agent_id: string | null; directory_path: string | null }>(
    `SELECT c.agent_id, d.path AS directory_path
       FROM chats c
       LEFT JOIN directories d ON d.id = c.directory_id
      WHERE c.id = $1::uuid`,
    [chatId],
  )
  return records[0]
}

/** 流式收尾：落 assistant 回复（历史在页面刷新后可回放）。 */
export async function insertAssistantChatMessage(
  chatId: string,
  content: string,
  runId: string,
  metadataJson: string,
): Promise<void> {
  await runQuery(
    `INSERT INTO chat_messages (chat_id, role, content, run_id, metadata)
     VALUES ($1::uuid, 'assistant', $2, $3, $4)`,
    [chatId, content, runId, metadataJson],
  )
}

/** assistant 回复落库后的会话联动（最后消息 + 计数 + 回 idle）。 */
export async function bumpChatAfterAssistantMessage(chatId: string, lastMessage: string): Promise<void> {
  await runQuery(
    `UPDATE chats
        SET last_message = $2, message_count = message_count + 1, status = 'idle', updated_at = NOW()
      WHERE id = $1::uuid`,
    [chatId, lastMessage],
  )
}

/** @-command 回执系统消息（返回 id 供客户端关联）。 */
export async function insertSystemMessageReturningId(
  chatId: string,
  content: string,
  metadataJson: string,
): Promise<string | undefined> {
  const { records } = await runQuery<{ id: string }>(
    `INSERT INTO chat_messages (chat_id, role, content, metadata)
     VALUES ($1::uuid, 'system', $2, $3)
     RETURNING id`,
    [chatId, content, metadataJson],
  )
  return records[0]?.id
}

/** 错误/中断类系统消息（created_at 显式 NOW()，不带 metadata/run_id）。 */
export async function insertSystemMessageDatedNow(chatId: string, content: string): Promise<void> {
  await runQuery(
    `INSERT INTO chat_messages (chat_id, role, content, created_at) VALUES ($1::uuid, 'system', $2, NOW())`,
    [chatId, content],
  )
}

/** HumanInput 提示消息（metadata.type='human_input' 是孤儿判定的锚）。 */
export async function insertHumanInputPromptMessage(
  chatId: string,
  content: string,
  runId: string,
  metadataJson: string,
): Promise<void> {
  await runQuery(
    `INSERT INTO chat_messages (chat_id, role, content, run_id, metadata)
     VALUES ($1::uuid, 'system', $2, $3, $4)`,
    [chatId, content, runId, metadataJson],
  )
}

/**
 * boot 清扫：最新一条消息仍是 human_input 系统提示的会话（用户还没回复过）
 * —— 挂起 Promise 活在进程内存，重启即死，需要补中断说明。
 */
export async function listChatsWithOrphanedHumanInput(): Promise<Array<{ chat_id: string }>> {
  const { records } = await runQuery<{ chat_id: string }>(
    `SELECT m.chat_id
       FROM chat_messages m
       JOIN (
         SELECT chat_id, MAX(created_at) AS last_at
           FROM chat_messages
          GROUP BY chat_id
       ) latest ON latest.chat_id = m.chat_id AND latest.last_at = m.created_at
      WHERE m.role = 'system'
        AND m.metadata->>'type' = 'human_input'`,
    [],
  )
  return records
}
