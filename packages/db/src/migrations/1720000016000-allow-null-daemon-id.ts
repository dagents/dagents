import type { MigrationInterface, QueryRunner } from 'typeorm'

/**
 * Allow NULL daemon_id on agent_daemons for inline-executor agents.
 *
 * In the inline-executor architecture (gateway spawns CLI directly, no daemon
 * process), agents are registered in agent_daemons WITHOUT a daemon_id.  This
 * migration drops the NOT NULL constraint so those rows can be inserted.
 */
export class AllowNullDaemonId1720000016000 implements MigrationInterface {
  name = 'AllowNullDaemonId1720000016000'

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "agent_daemons" ALTER COLUMN "daemon_id" DROP NOT NULL`)
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    // Delete inline-executor rows first (daemon_id IS NULL) then restore NOT NULL
    await queryRunner.query(`DELETE FROM "agent_daemons" WHERE "daemon_id" IS NULL`)
    await queryRunner.query(`ALTER TABLE "agent_daemons" ALTER COLUMN "daemon_id" SET NOT NULL`)
  }
}
