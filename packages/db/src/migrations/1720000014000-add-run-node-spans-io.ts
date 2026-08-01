import type { MigrationInterface, QueryRunner } from 'typeorm'

/**
 * Add input/output JSONB columns to run_node_spans so the gateway can
 * persist each node's actual input/output data (model config, prompt,
 * LLM response text, etc.) — not just status/duration/tokens.
 *
 * This brings the node span closer to Flowise's IAgentflowExecutedData
 * which stores full node I/O in its executionData JSON blob, but keeps
 * the columnar structure (queryable, indexable) rather than a single
 * opaque JSON column.
 */
export class AddRunNodeSpansIo1720000014000 implements MigrationInterface {
  name = 'AddRunNodeSpansIo1720000014000'

  async up(qr: QueryRunner): Promise<void> {
    await qr.query(`ALTER TABLE "run_node_spans" ADD COLUMN IF NOT EXISTS "input" JSONB`)
    await qr.query(`ALTER TABLE "run_node_spans" ADD COLUMN IF NOT EXISTS "output" JSONB`)
  }

  async down(qr: QueryRunner): Promise<void> {
    await qr.query(`ALTER TABLE "run_node_spans" DROP COLUMN IF EXISTS "output"`)
    await qr.query(`ALTER TABLE "run_node_spans" DROP COLUMN IF EXISTS "input"`)
  }
}
