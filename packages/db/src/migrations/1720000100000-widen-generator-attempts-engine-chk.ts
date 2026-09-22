import { MigrationInterface, QueryRunner } from 'typeorm'

/**
 * 放宽 generator_attempts.engine 的 check 约束（2026-09-22）。
 *
 * 原约束只允许 ('cli','http','cli-then-http')，但实际值域还有两族：
 *  - 'n/a'：引擎首轮调用即抛（generateFlow 的 engineUsed ?? 'n/a'）——
 *    双引擎都挂时 llm_error 行整条被拒，遥测丢数据（实例：CLI 代理下线
 *    + 无 HTTP provider，插入报 engine_chk 违约）。
 *  - 'agent:<name>'：canvas 指定 Agent 人格生成（callEngine kind==='agent'）。
 */
export class WidenGeneratorAttemptsEngineChk1720000100000 implements MigrationInterface {
  async up(qr: QueryRunner): Promise<void> {
    await qr.query(
      `ALTER TABLE "generator_attempts" DROP CONSTRAINT IF EXISTS generator_attempts_engine_chk`,
    )
    await qr.query(`
      ALTER TABLE "generator_attempts"
        ADD CONSTRAINT generator_attempts_engine_chk
        CHECK ("engine" IN ('cli','http','cli-then-http','n/a') OR "engine" LIKE 'agent:%')
    `)
  }

  async down(qr: QueryRunner): Promise<void> {
    await qr.query(
      `ALTER TABLE "generator_attempts" DROP CONSTRAINT IF EXISTS generator_attempts_engine_chk`,
    )
    await qr.query(`
      ALTER TABLE "generator_attempts"
        ADD CONSTRAINT generator_attempts_engine_chk
        CHECK ("engine" IN ('cli','http','cli-then-http'))
    `)
  }
}
