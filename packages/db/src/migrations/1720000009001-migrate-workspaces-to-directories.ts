import type { MigrationInterface, QueryRunner } from 'typeorm'

export class MigrateWorkspacesToDirectories1720000009001 implements MigrationInterface {
  name = 'MigrateWorkspacesToDirectories1720000009001'

  async up(qr: QueryRunner): Promise<void> {
    const workspacesExists = await qr.query(
      `SELECT to_regclass('public.workspaces') IS NOT NULL AS exists`,
    )
    if (!workspacesExists[0]?.exists) {
      return
    }

    await qr.query(`
      INSERT INTO "directories" (id, path, name, settings, created_at, updated_at)
      SELECT
        w.id,
        COALESCE(w.name, w.id::text) AS path,
        COALESCE(w.name, w.id::text) AS name,
        jsonb_build_object(
          'quota', w.quota,
          'description', w.description,
          'glyph', w.glyph,
          'ownerUserId', w.owner_user_id
        ) AS settings,
        w.created_at,
        w.updated_at
      FROM "workspaces" w
      WHERE w.status = 'active'
      ON CONFLICT (id) DO NOTHING
    `)

    const runsExists = await qr.query(
      `SELECT to_regclass('public.runs') IS NOT NULL AS exists`,
    )
    if (!runsExists[0]?.exists) {
      return
    }

    await qr.query(`
      INSERT INTO "chats" (id, directory_id, title, status, last_run_id, created_at, updated_at)
      SELECT
        gen_random_uuid(),
        d.id AS directory_id,
        'Migrated from workspace' AS title,
        CASE
          WHEN latest_run.status IN ('completed') THEN 'done'
          WHEN latest_run.status IN ('running') THEN 'running'
          WHEN latest_run.status IN ('failed', 'cancelled') THEN 'failed'
          ELSE 'idle'
        END AS status,
        latest_run.id AS last_run_id,
        latest_run.created_at,
        COALESCE(latest_run.finished_at, latest_run.created_at, NOW()) AS updated_at
      FROM "directories" d
      INNER JOIN LATERAL (
        SELECT r.id, r.status, r.created_at, r.finished_at
        FROM "runs" r
        WHERE r.workspace_id = d.id::text
          AND r.parent_run_id IS NULL
        ORDER BY r.created_at DESC
        LIMIT 1
      ) latest_run ON TRUE
      WHERE d.id IN (
        SELECT r.workspace_id::uuid
        FROM "runs" r
        WHERE r.workspace_id IS NOT NULL
          AND r.parent_run_id IS NULL
          AND r.workspace_id ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
      )
      ON CONFLICT DO NOTHING
    `)

    await qr.query(`
      UPDATE "runs" r
      SET chat_id = c.id::text
      FROM "chats" c
      WHERE r.workspace_id = c.directory_id::text
        AND r.chat_id IS NULL
    `)
  }

  async down(qr: QueryRunner): Promise<void> {
    const runsExists = await qr.query(
      `SELECT to_regclass('public.runs') IS NOT NULL AS exists`,
    )
    if (runsExists[0]?.exists) {
      await qr.query(`UPDATE "runs" SET chat_id = NULL WHERE chat_id IS NOT NULL`)
    }

    await qr.query(`DELETE FROM "chat_messages"`)
    await qr.query(`DELETE FROM "chats"`)
    await qr.query(`DELETE FROM "directories"`)
  }
}
