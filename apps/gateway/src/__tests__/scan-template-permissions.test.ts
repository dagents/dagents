/**
 * scan-template-permissions 冒烟测试（R4 AC-R4-6 的清点仪器，2026-10-08
 * 测试补齐）：钉「脚本本身可用 + 内置模板零缺席 → exit 0」。
 *
 * env 剥离 POSTGRES_URL（flow_templates 表扫描按脚本语义跳过——本测不依赖
 * 任何库，只验内置 JSON 扫描路径与退出码契约。2026-10-08 OQ-4 终裁升级：
 * 内置模板缺席/非法 = CI 阻断 exit 1；flow_templates 用户数据侧维持报告
 * 不阻断；exit 1 另当扫描本身失败）。
 */

import { describe, it, expect } from 'vitest'
import { execFile } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'

const scriptPath = join(
  fileURLToPath(new URL('../../../../scripts/scan-template-permissions.mjs', import.meta.url)),
)

function runScript(): Promise<{ stdout: string; stderr: string; code: number | null }> {
  return new Promise((resolve) => {
    const child = execFile(
      process.execPath,
      [scriptPath],
      { env: { ...process.env, POSTGRES_URL: '' }, timeout: 30_000 },
      (err, stdout, stderr) => {
        const exitCode = typeof err?.code === 'number' ? err.code : 0
        resolve({ stdout: String(stdout), stderr: String(stderr), code: exitCode })
      },
    )
    // timeout 兜底 kill 由 execFile 自带；防悬挂
    child.on('error', () => {})
  })
}

describe('scripts/scan-template-permissions.mjs（R4 清点仪器）', () => {
  it('内置模板全量扫描 → 零缺席 → exit 0（AC-R4-6 内置半边的仪器可用性）', async () => {
    const { stdout, code } = await runScript()
    expect(code, `stderr/stdout 见下:\n${stdout}`).toBe(0)
    expect(stdout).toContain('内置模板：扫描 10 个文件')
    expect(stdout).toContain('flow_templates 表：跳过')
    expect(stdout).toContain('零缺席')
  })

  it('零缺席报告文案契约（2026-10-08 OQ-4 终裁后：内置缺席已是 CI 阻断层，本例钉干净态输出）', async () => {
    // 现状零缺席（builtin-templates.test.ts 的 gate 断言同款口径）；此处钉
    // 「零缺席时不出 ✗/⚠ 行」的反向契约 + 报告段落存在。内置侧有缺席时脚本
    // exit 1 + `✗` 行（CI 阻断）；flow_templates（用户数据）侧维持 ⚠ 报告
    // 不阻断——伪造 BUILTIN_DIR 不可行（路径硬编码仓库根），阻断侧行为由
    // ci.yml `Template permission scan` 步的退出码承担。
    const { stdout } = await runScript()
    expect(stdout).not.toContain('✗')
    expect(stdout).not.toContain('⚠')
    expect(stdout).toContain('内置模板：零缺席/零非法（CI 阻断层通过）')
  })
})
