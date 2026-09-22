#!/usr/bin/env node
/**
 * 孤儿 CSS 检测（2026-09-22 架构护栏）—— 防复发背景：
 * src/styles/canvas.css 从未被任何组件 import，里面「重跑/停止」按钮的
 * 样式裸渲染了四天才被发现（styles/ 目录与组件目录双真相源 + 无机器
 * 检查）。本脚本把「每个 css 文件必须被某个 ts/tsx 显式 import」变成
 * CI 可失败的硬约束。
 *
 * 用法：node scripts/check-orphan-css.mjs（挂 console 的 lint script）
 * 白名单 ORPHAN_CSS_ALLOWLIST：有意全局注入/构建器消费的文件名（无）。
 */
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'

const ROOT = join(import.meta.dirname, '..')
const ORPHAN_CSS_ALLOWLIST = new Set([])

function walk(dir, out = []) {
  for (const name of readdirSync(dir)) {
    if (name === 'node_modules' || name === '.next' || name.startsWith('.')) continue
    const p = join(dir, name)
    if (statSync(p).isDirectory()) walk(p, out)
    else out.push(p)
  }
  return out
}

const files = walk(join(ROOT, 'src'))
const cssFiles = files.filter((p) => p.endsWith('.css'))
const codeText = files
  .filter((p) => /\.(ts|tsx|mjs|js)$/.test(p))
  .map((p) => readFileSync(p, 'utf8'))
  .join('\n')

const orphans = cssFiles.filter((p) => {
  const name = p.split('/').pop()
  if (ORPHAN_CSS_ALLOWLIST.has(name)) return false
  // import 路径可带别名/相对前缀：匹配「/文件名'」或「"文件名"」——
  // 文件名前必须是 / 或引号（路径边界），canvas.css 不会被
  // canvas-results.css 的引用误命中
  const re = new RegExp(`["'/]${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}["']`)
  return !re.test(codeText)
})

if (orphans.length > 0) {
  console.error('✗ 孤儿 CSS（没有任何 ts/tsx import，样式不会生效）：')
  for (const p of orphans) console.error('  ' + relative(ROOT, p))
  console.error('修复：在消费它的组件里显式 import，或删除该文件。')
  console.error('（护栏背景见 scripts/check-orphan-css.mjs 头注释）')
  process.exit(1)
}
console.log(`✓ ${cssFiles.length} 个 css 文件全部被显式 import`)
