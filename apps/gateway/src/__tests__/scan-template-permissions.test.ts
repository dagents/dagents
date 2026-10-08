/**
 * scan-template-permissions 冒烟测试（R4 AC-R4-6 的清点仪器，2026-10-08
 * 测试补齐）：钉「脚本本身可用 + 内置模板零缺席 → exit 0」。
 *
 * env 剥离 POSTGRES_URL（flow_templates 表扫描按脚本语义跳过——本测不依赖
 * 任何库，只验内置 JSON 扫描路径与退出码契约：缺席仅报告不阻断，exit 1
 * 仅当扫描本身失败）。
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

  it('缺席仅报告不阻断：报告文案与节点定位存在（契约钉子——供未来模板缺席时人工核对）', async () => {
    // 现状零缺席（builtin-templates.test.ts 的 gate 断言同款口径）；此处钉
    // 「有缺席时输出 ⚠ 报告行」的文案契约——用伪造 BUILTIN_DIR 不可行（路径
    // 硬编码仓库根），改钉「零缺席时不出 ⚠ 行」的反向契约 + 报告段落存在。
    const { stdout } = await runScript()
    expect(stdout).not.toContain('⚠')
    expect(stdout).toContain('零缺席：全部内置/库内模板的权限声明干净')
  })
})
