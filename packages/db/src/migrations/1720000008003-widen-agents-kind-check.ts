import type { MigrationInterface, QueryRunner } from 'typeorm'

/**
 * Widen `agents_kind_chk` to match the 19-type fleet in `AgentType`
 * (packages/contracts/src/agent.ts). The original constraint only allowed
 * ('prompt','claude','codex','remote') which blocked "click to create" for
 * every other agent type (hermes, gemini, copilot, …).
 */
export class WidenAgentsKindCheck1720000008003 implements MigrationInterface {
  name = 'WidenAgentsKindCheck1720000008003'

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE "agents"
        DROP CONSTRAINT IF EXISTS "agents_kind_chk",
        ADD CONSTRAINT "agents_kind_chk"
          CHECK ("kind" IN (
            'prompt','claude','codex','copilot','opencode','openclaw',
            'hermes','gemini','pi','cursor','kimi','kiro',
            'antigravity','codebuddy','qoder','qwen',
            'deveco','grok','traecli','remote'
          ))
    `)
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE "agents"
        DROP CONSTRAINT IF EXISTS "agents_kind_chk",
        ADD CONSTRAINT "agents_kind_chk"
          CHECK ("kind" IN ('prompt','claude','codex','remote'))
    `)
  }
}
