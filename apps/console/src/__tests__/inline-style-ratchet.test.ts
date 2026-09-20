import { describe, it, expect } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

/**
 * 内联 style 棘轮（2026-09-17 新增）—— 遏制组件内联样式的增长。
 *
 * 基线：2026-09-17 测得 src/components 下全部 .tsx 共 **345** 处 `style={{`；
 * 同日消减两个最集中的静态样式文件（settings-view 51→0、
 * agent-detail-view 36→9，仅剩骨架形状尺寸与动态进度宽度）后收敛到
 * **267**。2026-09-19 设计走查再消 2 处（daemon 对话框关闭钮尺寸改 .ic-16、
 * create-agent 表单提示 inline 色改 .field-hint-warn 类）收紧到 **265**；2026-09-20 结果面板进度条 +2 处动态宽度、
 * 消减 2 处静态图标定寸（ic-12），收敛到 **264**。
 * 棘轮值：**只降不升** ——
 *   - 新样式一律走 CSS 类 / tokens.css 令牌（工具类 .t-xs/.ic-12/.ic-14/
 *     .ic-16 等见 shell.css「内联样式收敛工具」块）；
 *   - 动态计算值（进度宽度、拖拽坐标、sparkline 几何）允许保留内联，
 *     消减时新增的动态样式若推高总数，请同步消减等量静态样式并把
 *     基线数字改小后更新此处；
 *   - 数字下降时直接改小 BASELINE（棘轮只能单向收紧）。
 */

const BASELINE = 264

const componentsRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
  'components',
)

function countInlineStyles(dir: string): number {
  let total = 0
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name.startsWith('__tests__')) continue
    const p = path.join(dir, entry.name)
    if (entry.isDirectory()) total += countInlineStyles(p)
    else if (entry.name.endsWith('.tsx')) {
      const src = fs.readFileSync(p, 'utf8')
      total += (src.match(/style=\{\{/g) ?? []).length
    }
  }
  return total
}

describe('内联 style 棘轮（components 只降不升）', () => {
  it(`style={{ 总数 ≤ ${BASELINE}（超出即回退：新样式走 CSS/令牌）`, () => {
    const total = countInlineStyles(componentsRoot)
    expect(
      total,
      `内联 style 总数 ${total} 超过棘轮基线 ${BASELINE} —— 新样式请写入对应 CSS 文件或 tokens.css 令牌（工具类 .t-xs/.t-2xs/.ic-12/.ic-14/.btn-compact 见 shell.css）；动态计算值可保留内联。若本次改动确实消减了内联样式，请把本测试的 BASELINE 改小（棘轮单向收紧）。`,
    ).toBeLessThanOrEqual(BASELINE)
  })
})
