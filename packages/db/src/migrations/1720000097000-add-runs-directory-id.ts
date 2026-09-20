import { MigrationInterface, QueryRunner } from 'typeorm'

/**
 * 运行 → 项目目录数据链（docs/design-terminal-anchors.md P0，2026-09-19）。
 *
 * directoryId 此前只在发起时解析 cwd 后即丢弃：GET /runs 与 node-spans 都
 * 不返回目录，断点续跑的 originalDirectoryId() 读 input.directoryId 更是
 * 一个无写入方的假设（靠 chat 回退撑着）。本迁移把目录锚持久化到 runs 行：
 *  - 写入：画布直跑（请求体 directoryId）/ chat 流式（chats.directory_id）/
 *    断点续跑（原 run 继承）
 *  - 读取：GET /runs 行响应 + node-spans 响应（旁看电视端「在项目目录打开
 *    终端」入口的数据源）
 */
export class AddRunsDirectoryId1720000097000 implements MigrationInterface {
  async up(qr: QueryRunner): Promise<void> {
    await qr.query(`ALTER TABLE "runs" ADD COLUMN IF NOT EXISTS "directory_id" UUID`)
  }

  async down(qr: QueryRunner): Promise<void> {
    await qr.query(`ALTER TABLE "runs" DROP COLUMN IF EXISTS "directory_id"`)
  }
}
