/**
 * directories.repo.ts — `directories` 表的数据访问层。
 *
 * directories：项目目录注册表（绝对路径 + 展示名 + settings JSONB）。chat /
 * 画布运行 / agent-invoke 都通过 directoryId 间接解析工作目录（不信任 HTTP
 * 上的裸路径）。列表与详情附带 chats 表的会话计数（子查询）。
 */
import { runQuery } from '@dagents/db'

export interface DirectoryRow {
  id: string
  path: string
  name: string
  settings: unknown
  chat_count: string | null
  created_at: Date
  updated_at: Date
}

export function normalizeDir(r: DirectoryRow) {
  let settings: Record<string, unknown> = {}
  if (typeof r.settings === 'object' && r.settings !== null && !Array.isArray(r.settings)) {
    settings = r.settings as Record<string, unknown>
  }
  return {
    id: r.id,
    path: r.path,
    name: r.name,
    settings,
    chatCount: Number(r.chat_count ?? 0),
    createdAt: r.created_at instanceof Date ? r.created_at.toISOString() : new Date(r.created_at).toISOString(),
    updatedAt: r.updated_at instanceof Date ? r.updated_at.toISOString() : new Date(r.updated_at).toISOString(),
  }
}

export async function listDirectoriesWithCounts(limit: number): Promise<DirectoryRow[]> {
  const { records } = await runQuery<DirectoryRow>(
    `SELECT d.id, d.path, d.name, d.settings,
            (SELECT count(*)::text FROM chats ch WHERE ch.directory_id = d.id) AS chat_count,
            d.created_at, d.updated_at
       FROM directories d
       ORDER BY d.updated_at DESC
       LIMIT $1`,
    [limit],
  )
  return records
}

export async function getDirectoryById(id: string): Promise<DirectoryRow | null> {
  const { records } = await runQuery<DirectoryRow>(
    `SELECT d.id, d.path, d.name, d.settings,
            (SELECT count(*)::text FROM chats ch WHERE ch.directory_id = d.id) AS chat_count,
            d.created_at, d.updated_at
       FROM directories d
       WHERE d.id = $1`,
    [id],
  )
  return records[0] ?? null
}

/** 工作目录解析（画布运行 / chat 流式 / agent-invoke 共用）。 */
export async function getDirectoryPath(id: string): Promise<string | null> {
  const { records } = await runQuery<{ path: string }>(
    `SELECT path FROM directories WHERE id = $1::uuid`,
    [id],
  )
  return records[0]?.path ?? null
}

export async function createDirectory(input: {
  path: string
  name: string
  settingsJson: string
}): Promise<DirectoryRow | null> {
  const { records } = await runQuery<DirectoryRow>(
    `INSERT INTO directories (path, name, settings)
     VALUES ($1, $2, $3)
     RETURNING id, path, name, settings,
               (SELECT count(*)::text FROM chats ch WHERE ch.directory_id = directories.id) AS chat_count,
               created_at, updated_at`,
    [input.path, input.name, input.settingsJson],
  )
  return records[0] ?? null
}

/** PATCH 动态更新：只写提供的列（name → settings）。 */
export async function updateDirectoryFields(
  id: string,
  patch: { name?: string; settingsJson?: string },
): Promise<DirectoryRow | null> {
  const sets: string[] = []
  const params: unknown[] = []

  if (patch.name !== undefined) {
    params.push(patch.name)
    sets.push(`name = $${params.length}`)
  }
  if (patch.settingsJson !== undefined) {
    params.push(patch.settingsJson)
    sets.push(`settings = $${params.length}`)
  }

  params.push(id)
  const idParam = `$${params.length}`

  const { records } = await runQuery<DirectoryRow>(
    `UPDATE directories
     SET ${sets.join(', ')}, updated_at = NOW()
     WHERE id = ${idParam}
     RETURNING id, path, name, settings,
               (SELECT count(*)::text FROM chats ch WHERE ch.directory_id = directories.id) AS chat_count,
               created_at, updated_at`,
    params,
  )
  return records[0] ?? null
}

export async function deleteDirectory(id: string): Promise<string | null> {
  const { records } = await runQuery<{ id: string }>(
    `DELETE FROM directories WHERE id = $1 RETURNING id`,
    [id],
  )
  return records[0]?.id ?? null
}
