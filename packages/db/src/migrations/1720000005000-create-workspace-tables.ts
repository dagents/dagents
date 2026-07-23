import type { MigrationInterface, QueryRunner } from 'typeorm'

/**
 * M5b.1 — workspace collaboration tables (spec §5.3 + §6.2; plan M5b.1 /
 * P1.10.T6; dependency table P1.2.T8).
 *
 * The Workspace 项目对话页 is the per-project collaboration surface: a project
 * lists its members, associated flows, produced artifacts, and a monthly quota,
 * and carries a human↔agent conversation thread. Flowise has no notion of a
 * "project" or "membership", so the platform owns three tables:
 *   - workspaces          one row per project (name / owner / status / quota)
 *   - workspace_members   workspace ↔ member with a role (owner/editor/viewer)
 *   - workspace_flows     workspace ↔ Flowise flow binding (the linked flows)
 *
 * `runs.workspace_id` already exists (text, nullable) and references a row
 * here; conversation threads reuse `runs` (each run is one conversation turn
 * carrying run_id), so there is NO separate `workspace_threads` table — the
 * thread IS the run history scoped to the workspace + a chat role. This keeps
 * the conversation end-to-end traceable via the OTel run_id (M6.1) without a
 * parallel id space.
 *
 * Mirrors the raw-SQL-1:1 style of the audit_log / token_meta migrations: the
 * gateway queries these tables with parameterised raw SQL via `runQuery`; the
 * entity classes exist for the schema definition + repository typing and are
 * not loaded on the runtime query path.
 *
 * `owner_user_id` / `member_id` are free TEXT (no users table yet — P1.4.T2 /
 * P1.2.T6 land better-auth later). When the users table lands these can be
 * backfilled + constrained without a rewrite, the same open-id posture
 * `runs.created_by_user_id` takes.
 *
 * Indexes:
 *   - workspaces (status)                 active-vs-archived list filter
 *   - workspace_members (workspace_id)    "who's in this project"
 *   - workspace_members (member_id)       "which projects is this user in"
 *   - workspace_members (workspace_id, member_id) UNIQUE   no dup membership
 *   - workspace_flows (workspace_id)      "which flows does this project link"
 *   - workspace_flows (pipeline_id)       "which projects use this flow"
 *   - workspace_flows (workspace_id, pipeline_id) UNIQUE   idempotent linking
 */
export class CreateWorkspaceTables1720000005000 implements MigrationInterface {
  name = 'CreateWorkspaceTables1720000005000'

  async up(qr: QueryRunner): Promise<void> {
    await qr.query(`
      CREATE TABLE "workspaces" (
        "id"            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        "name"          TEXT NOT NULL,
        "description"   TEXT,
        "owner_user_id" TEXT,
        "status"        TEXT NOT NULL DEFAULT 'active',
        "quota"         JSONB NOT NULL DEFAULT '{}'::jsonb,
        "glyph"         TEXT,
        "created_at"    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        "updated_at"    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        CONSTRAINT workspaces_status_chk
          CHECK ("status" IN ('active','archived'))
      )
    `)
    await qr.query(`CREATE INDEX idx_workspaces_status ON "workspaces" ("status")`)

    await qr.query(`
      CREATE TABLE "workspace_members" (
        "id"           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        "workspace_id" UUID NOT NULL REFERENCES "workspaces"("id") ON DELETE CASCADE,
        "member_id"    TEXT NOT NULL,
        "display_name" TEXT,
        "initial"      TEXT,
        "role"         TEXT NOT NULL DEFAULT 'viewer',
        "created_at"   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        CONSTRAINT workspace_members_role_chk
          CHECK ("role" IN ('owner','editor','viewer'))
      )
    `)
    await qr.query(
      `CREATE INDEX idx_workspace_members_workspace ON "workspace_members" ("workspace_id")`,
    )
    await qr.query(
      `CREATE INDEX idx_workspace_members_member ON "workspace_members" ("member_id")`,
    )
    await qr.query(
      `CREATE UNIQUE INDEX idx_workspace_members_workspace_member ON "workspace_members" ("workspace_id", "member_id")`,
    )

    await qr.query(`
      CREATE TABLE "workspace_flows" (
        "id"           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        "workspace_id" UUID NOT NULL REFERENCES "workspaces"("id") ON DELETE CASCADE,
        "pipeline_id"  TEXT NOT NULL,
        "note"         TEXT,
        "created_at"   TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `)
    await qr.query(
      `CREATE INDEX idx_workspace_flows_workspace ON "workspace_flows" ("workspace_id")`,
    )
    await qr.query(
      `CREATE INDEX idx_workspace_flows_pipeline ON "workspace_flows" ("pipeline_id")`,
    )
    await qr.query(
      `CREATE UNIQUE INDEX idx_workspace_flows_workspace_pipeline ON "workspace_flows" ("workspace_id", "pipeline_id")`,
    )
  }

  async down(qr: QueryRunner): Promise<void> {
    await qr.query(`DROP TABLE IF EXISTS "workspace_flows"`)
    await qr.query(`DROP TABLE IF EXISTS "workspace_members"`)
    await qr.query(`DROP TABLE IF EXISTS "workspaces"`)
  }
}
