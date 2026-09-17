/**
 * agent-daemons.repo.ts — `agent_daemons`（+ `daemons` 存在性）的数据访问层。
 *
 * agent_daemons：运行时注册表（与 agents 表共享主键的桥接行，携带
 * capability_descriptor / executable_path）。agents 目录的运行时 join 在
 * agents.repo.ts；这里只收「按名解析 / 按 kind 兜底 / CLI 运行时投影」等
 * 独立查找（@agent 命令、auto 路由、agent-invoke 的 legacy 回退）。
 * daemons 表本身的 CRUD 归 dispatch 族（routes/dispatch/），此处仅一个
 * 创建 agent 时的存在性检查。
 */
import { runQuery } from '@dagents/db'

/** agent-invoke 的 legacy 回退：agent_daemons 行的 kind + 可执行路径（缺省 ''）。 */
export async function getAgentDaemonRuntime(
  id: string,
): Promise<{ kind: string; executablePath: string } | null> {
  const { records } = await runQuery<{ kind: string; executable_path: string | null }>(
    `SELECT kind, executable_path FROM agent_daemons WHERE id = $1::uuid`,
    [id],
  )
  if (!records[0]) return null
  return { kind: records[0].kind, executablePath: records[0].executable_path ?? '' }
}

/** @agent 命令按名解析的回退（agents 表未命中时查 legacy 注册表）。 */
export async function findAgentDaemonIdByName(name: string): Promise<string | null> {
  const { records } = await runQuery<{ id: string }>(
    `SELECT id FROM agent_daemons WHERE name = $1 LIMIT 1`,
    [name],
  )
  return records[0]?.id ?? null
}

/** auto 路由兜底 ②：legacy 注册表里可本机执行的 CLI kind。 */
export async function findFirstAgentDaemonByKinds(kinds: string[]): Promise<string | null> {
  const { records } = await runQuery<{ id: string }>(
    `SELECT id FROM agent_daemons WHERE kind = ANY($1::text[]) ORDER BY created_at ASC LIMIT 1`,
    [kinds],
  )
  return records[0]?.id ?? null
}

/** auto 路由兜底 ④：legacy 注册表任意。 */
export async function findFirstAgentDaemonAny(): Promise<string | null> {
  const { records } = await runQuery<{ id: string }>(
    `SELECT id FROM agent_daemons ORDER BY created_at ASC LIMIT 1`,
  )
  return records[0]?.id ?? null
}

/** 创建 agent 时校验 daemon 存在（FK 提前变干净的 404）。 */
export async function daemonExists(id: string): Promise<boolean> {
  const { records } = await runQuery<{ id: string }>(`SELECT id FROM daemons WHERE id = $1`, [id])
  return !!records[0]
}
