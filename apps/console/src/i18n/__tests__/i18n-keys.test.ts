import { describe, it, expect } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { en } from '@/i18n/en'

/**
 * 缺译扫描测试（2026-09-17 整改新增）：遍历 components/ 与 app/ 的源码，
 * 提取 t('字面量') 键，断言每个都在 en 词典（common/agents/flows/daemons/
 * settings/chat 合并后的键空间）里 —— 缺译从此 CI 可见，不再靠肉眼比对。
 *
 * 只认字面量键：t(variable) / t(`${...}`) 是动态键（如 SPAN_STATUS_CN
 * 映射），其词条由各自映射表保证，不在本测试范围。测试文件与 __tests__
 * 目录跳过（测试桩不是 UI 面）。
 */

const srcRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')

function walk(dir: string, out: string[]): string[] {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name.startsWith('__tests__') || entry.name.startsWith('_')) continue
    const p = path.join(dir, entry.name)
    if (entry.isDirectory()) walk(p, out)
    else if (/\.(tsx?|ts)$/.test(entry.name) && !/\.(test|spec)\./.test(entry.name)) out.push(p)
  }
  return out
}

/** 提取 t('...') / t("...") 的字面量键（含 \' 转义；跳过模板串与拼接）。 */
function extractLiteralKeys(source: string): string[] {
  const keys: string[] = []
  for (const m of source.matchAll(/\bt\(\s*'((?:[^'\\\n]|\\.)+)'\s*[,)]/g)) {
    keys.push(m[1]!.replace(/\\'/g, "'"))
  }
  for (const m of source.matchAll(/\bt\(\s*"((?:[^"\\\n]|\\.)+)"\s*[,)]/g)) {
    keys.push(m[1]!.replace(/\\"/g, '"'))
  }
  return keys
}

describe('i18n 缺译扫描（components/ + app/ 的 t() 字面键必须在 en 词典）', () => {
  it('扫描覆盖到了组件源码（防回归：walk 空转时测试失去意义）', () => {
    const files = [...walk(path.join(srcRoot, 'components'), []), ...walk(path.join(srcRoot, 'app'), [])]
    expect(files.length).toBeGreaterThan(50)
  })

  it('每个 t() 字面量键都有英文词条', () => {
    const files = [...walk(path.join(srcRoot, 'components'), []), ...walk(path.join(srcRoot, 'app'), [])]
    const missing: Array<{ key: string; file: string }> = []
    for (const f of files) {
      for (const key of extractLiteralKeys(fs.readFileSync(f, 'utf8'))) {
        if (!(key in en)) missing.push({ key, file: path.relative(srcRoot, f) })
      }
    }
    expect(
      missing,
      `以下 t() 键缺英文词条 —— 补到 src/i18n/en/ 对应模块（新增界面文案直接写中文并用 t('中文') 包裹，英文词条加到对应 en/*.ts）：\n${missing
        .map((m) => `  ${JSON.stringify(m.key)} <- ${m.file}`)
        .join('\n')}`,
    ).toEqual([])
  })
})
