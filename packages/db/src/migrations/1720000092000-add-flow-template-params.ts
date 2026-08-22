import { MigrationInterface, QueryRunner } from 'typeorm'

/**
 * flow_templates.params — 模板参数化（docs/product-plan.md 方案 G）。
 *
 * 「另存为模板」时扫描节点文案里的 `{{变量名}}` 占位符生成参数清单
 * （[{name, defaultValue?}]）；实例化时弹表单回填。与引擎既有的运行时
 * 变量解析（packages/workflow utils/variables.ts）共用 `{{}}` 语法。
 */
export class AddFlowTemplateParams1720000092000 implements MigrationInterface {
  name = 'AddFlowTemplateParams1720000092000'

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "flow_templates" ADD COLUMN IF NOT EXISTS "params" JSONB NOT NULL DEFAULT '[]'::jsonb`,
    )
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "flow_templates" DROP COLUMN IF EXISTS "params"`)
  }
}
