import type { MigrationInterface, QueryRunner } from 'typeorm'

export class CreateChatTables1720000009000 implements MigrationInterface {
  name = 'CreateChatTables1720000009000'

  async up(qr: QueryRunner): Promise<void> {
    await qr.query(`
      CREATE TABLE IF NOT EXISTS "directories" (
        "id"         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        "path"       TEXT NOT NULL,
        "name"       TEXT NOT NULL,
        "settings"   JSONB NOT NULL DEFAULT '{}'::jsonb,
        "created_at" TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        "updated_at" TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `)
    await qr.query(
      `CREATE UNIQUE INDEX IF NOT EXISTS idx_directories_path ON "directories" ("path")`,
    )
    await qr.query(
      `CREATE INDEX IF NOT EXISTS idx_directories_name ON "directories" ("name")`,
    )

    await qr.query(`
      CREATE TABLE IF NOT EXISTS "chats" (
        "id"              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        "directory_id"    UUID NOT NULL REFERENCES "directories"("id") ON DELETE CASCADE,
        "title"           TEXT NOT NULL,
        "status"          TEXT NOT NULL DEFAULT 'idle'::text,
        "agent_id"        UUID,
        "flow_id"         TEXT,
        "last_message"    TEXT,
        "message_count"   INTEGER NOT NULL DEFAULT 0,
        "last_run_id"     UUID,
        "created_at"      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        "updated_at"      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        CONSTRAINT chats_status_chk
          CHECK ("status" IN ('idle','running','done','failed'))
      )
    `)
    await qr.query(
      `CREATE INDEX IF NOT EXISTS idx_chats_directory ON "chats" ("directory_id", "updated_at" DESC)`,
    )
    await qr.query(
      `CREATE INDEX IF NOT EXISTS idx_chats_status ON "chats" ("status")`,
    )

    await qr.query(`
      CREATE TABLE IF NOT EXISTS "chat_messages" (
        "id"         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        "chat_id"    UUID NOT NULL REFERENCES "chats"("id") ON DELETE CASCADE,
        "role"       TEXT NOT NULL,
        "content"    TEXT NOT NULL,
        "run_id"     UUID,
        "metadata"   JSONB NOT NULL DEFAULT '{}'::jsonb,
        "created_at" TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        CONSTRAINT chat_messages_role_chk
          CHECK ("role" IN ('user','assistant','system','tool'))
      )
    `)
    await qr.query(
      `CREATE INDEX IF NOT EXISTS idx_chat_messages_chat ON "chat_messages" ("chat_id", "created_at")`,
    )
    await qr.query(
      `CREATE INDEX IF NOT EXISTS idx_chat_messages_run ON "chat_messages" ("run_id")`,
    )

    await qr.query(`ALTER TABLE "runs" ADD COLUMN IF NOT EXISTS "chat_id" TEXT`)
    await qr.query(
      `CREATE INDEX IF NOT EXISTS idx_runs_chat_status ON "runs" ("chat_id", "status")`,
    )
  }

  async down(qr: QueryRunner): Promise<void> {
    await qr.query(`DROP INDEX IF EXISTS idx_runs_chat_status`)
    await qr.query(`ALTER TABLE "runs" DROP COLUMN IF EXISTS "chat_id"`)
    await qr.query(`DROP INDEX IF EXISTS idx_chat_messages_run`)
    await qr.query(`DROP INDEX IF EXISTS idx_chat_messages_chat`)
    await qr.query(`DROP TABLE IF EXISTS "chat_messages"`)
    await qr.query(`DROP INDEX IF EXISTS idx_chats_status`)
    await qr.query(`DROP INDEX IF EXISTS idx_chats_directory`)
    await qr.query(`DROP TABLE IF EXISTS "chats"`)
    await qr.query(`DROP INDEX IF EXISTS idx_directories_name`)
    await qr.query(`DROP INDEX IF EXISTS idx_directories_path`)
    await qr.query(`DROP TABLE IF EXISTS "directories"`)
  }
}
