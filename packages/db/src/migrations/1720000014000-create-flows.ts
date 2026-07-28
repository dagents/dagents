import type { MigrationInterface, QueryRunner } from 'typeorm'

/**
 * Create flows table for storing visual workflow definitions.
 *
 * Flows represent editable workflow diagrams with nodes and edges. Each flow
 * has a lifecycle state (draft, published, archived) and stores the complete
 * flow structure including node positions, edge connections, and viewport state.
 *
 * Indexes:
 *   - (status)  filtering by flow lifecycle state
 *   - (name)    search by flow name
 */
export class CreateFlows1720000014000 implements MigrationInterface {
  name = 'CreateFlows1720000014000'

  async up(qr: QueryRunner): Promise<void> {
    await qr.query(`
      CREATE TABLE "flows" (
        "id"          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        "name"        VARCHAR(255) NOT NULL,
        "description" TEXT,
        "flow_data"   JSONB NOT NULL,
        "status"      VARCHAR(32) NOT NULL DEFAULT 'draft',
        "created_at"  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        "updated_at"  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        CONSTRAINT flows_status_chk
          CHECK ("status" IN ('draft','published','archived'))
      )
    `)
    await qr.query(`CREATE INDEX idx_flows_status ON "flows" ("status")`)
    await qr.query(`CREATE INDEX idx_flows_name ON "flows" ("name")`)
  }

  async down(qr: QueryRunner): Promise<void> {
    await qr.query(`DROP TABLE IF EXISTS "flows"`)
  }
}
