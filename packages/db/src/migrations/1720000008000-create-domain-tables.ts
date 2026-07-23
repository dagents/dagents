import type { MigrationInterface, QueryRunner } from 'typeorm'

/**
 * v0.3 domain tables — the platform-owned `agents` catalogue table.
 *
 * The `agents` table is the source of truth for the v0.3 design's agent fleet
 * (plan v0.3-M9.1 / 后端契约 1; source of truth `design/js/agents-data.js`).
 * One row per agent carries the design's editorial fields 1:1 as top-level
 * columns (`name` / `kind` / `roles` / `instructions` / `skills` /
 * `visibility` / `concurrency` / `model` / `runtime` / `owner_id` /
 * `activity` / `status` / `availability`). The design's `summary` +
 * `inputSchema` + `outputSchema` are added on top by the companion migration
 * `AddAgentsCapabilityFields1720000008001` so this table is the base layer
 * 8001 extends.
 *
 * Why this migration exists now. The `agents` table was originally created by a
 * `CreateDomainTables1720000008000` migration that lived *outside* this repo's
 * migration set — its DDL was never in git, so a fresh DB (CI, a new dev
 * machine, a container recreated from scratch) could not rebuild it from the
 * repo alone. The `1720000008001` companion guarded its `ALTER TABLE agents`
 * with a table-existence check precisely because the create-table migration
 * was missing, which meant on a fresh DB 8001 was a silent no-op → the agents
 * table never got created → every `/api/v1/agents/*` route 502'd. This
 * migration brings the create-table DDL in-repo so the migration set is
 * self-contained and a fresh DB is rebuildable end-to-end.
 *
 * The DDL mirrors the deployed dev schema 1:1 (columns, defaults, CHECK
 * constraints, indexes) — reconstructed from the live `public.agents` catalog
 * so a fresh DB matches what the dev stack runs. `agent_type` is included
 * (nullable, currently unused by the gateway routes) to keep the fresh schema
 * byte-identical to dev.
 *
 * Idempotent (`CREATE TABLE IF NOT EXISTS` + `CREATE INDEX IF NOT EXISTS`):
 * the dev DB already has this table (the `migrations` table recorded
 * `CreateDomainTables1720000008000` before this file existed in-repo), so
 * re-running here is a safe no-op rather than a hard `relation already
 * exists` error. On a fresh DB the guards pass through and create everything.
 *
 * No FK cascade to `workspaces`. The deployed schema has `workspace_id` as a
 * plain indexed UUID (no `REFERENCES workspaces` / `ON DELETE CASCADE`), unlike
 * `workspace_members` / `workspace_flows` which do cascade. Cleaning up an
 * agent row when its workspace is deleted is therefore the application's
 * responsibility — `apps/gateway/src/__tests__/agents-shape.test.ts`'s
 * `cleanupSeeded()` deletes its seeded agents explicitly *before* the
 * workspace for exactly this reason (deleting the workspace first would
 * orphan the agents). A structural FK can be added in a later task if the
 * no-cascade posture is ever reconsidered; this migration reproduces the
 * deployed schema as-is.
 *
 * Indexes (mirror dev):
 *   - (workspace_id)   the agents list per-workspace filter (M5 will scope)
 *   - (kind)            the catalogue kind filter
 *   - (status)          the running/queued/idle/failed/paused filter
 *   - (daemon_id)       the daemon→agents back-reference lookup
 */
export class CreateDomainTables1720000008000 implements MigrationInterface {
  name = 'CreateDomainTables1720000008000'

  async up(qr: QueryRunner): Promise<void> {
    await qr.query(`
      CREATE TABLE IF NOT EXISTS "agents" (
        "id"            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        "workspace_id"  UUID NOT NULL,
        "name"          TEXT NOT NULL,
        "kind"          TEXT NOT NULL,
        "agent_type"    TEXT,
        "roles"         JSONB NOT NULL DEFAULT '[]'::jsonb,
        "instructions"  TEXT NOT NULL DEFAULT ''::text,
        "skills"        JSONB NOT NULL DEFAULT '[]'::jsonb,
        "visibility"    TEXT NOT NULL DEFAULT 'workspace'::text,
        "concurrency"   INTEGER NOT NULL DEFAULT 1,
        "model"         TEXT NOT NULL DEFAULT ''::text,
        "runtime"       TEXT NOT NULL DEFAULT ''::text,
        "owner_id"      TEXT NOT NULL,
        "daemon_id"     UUID,
        "flow_id"       TEXT,
        "activity"      JSONB NOT NULL DEFAULT '[]'::jsonb,
        "status"        TEXT NOT NULL DEFAULT 'idle'::text,
        "availability"  TEXT NOT NULL DEFAULT 'offline'::text,
        "created_at"    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        "updated_at"    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        CONSTRAINT agents_kind_chk
          CHECK ("kind" IN ('prompt','claude','codex','remote')),
        CONSTRAINT agents_status_chk
          CHECK ("status" IN ('running','queued','idle','failed','paused')),
        CONSTRAINT agents_availability_chk
          CHECK ("availability" IN ('online','unstable','offline')),
        CONSTRAINT agents_visibility_chk
          CHECK ("visibility" IN ('workspace','public'))
      )
    `)
    await qr.query(`CREATE INDEX IF NOT EXISTS idx_agents_workspace ON "agents" ("workspace_id")`)
    await qr.query(`CREATE INDEX IF NOT EXISTS idx_agents_kind ON "agents" ("kind")`)
    await qr.query(`CREATE INDEX IF NOT EXISTS idx_agents_status ON "agents" ("status")`)
    await qr.query(`CREATE INDEX IF NOT EXISTS idx_agents_daemon ON "agents" ("daemon_id")`)
  }

  async down(qr: QueryRunner): Promise<void> {
    await qr.query(`DROP TABLE IF EXISTS "agents"`)
  }
}
