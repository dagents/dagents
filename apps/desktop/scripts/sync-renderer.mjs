#!/usr/bin/env node
/**
 * sync-renderer.mjs —— 把 src/renderer 的静态资产（*.html / *.css）拷进 dist/renderer。
 *
 * tsc 只编译 .ts，不会带 html/css；打包 files 只收 dist/**，Electron 主进程
 * loadFile 指向 dist/renderer/index.html —— 所以构建后必须同步一次。
 * 零依赖（node:fs），随 `pnpm build` 链尾执行。
 */
import { copyFileSync, existsSync, mkdirSync, readdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const pkgRoot = join(dirname(fileURLToPath(import.meta.url)), '..')
const srcDir = join(pkgRoot, 'src', 'renderer')
const outDir = join(pkgRoot, 'dist', 'renderer')

if (!existsSync(srcDir)) {
  console.error(`[sync-renderer] 缺少 ${srcDir}`)
  process.exit(1)
}

mkdirSync(outDir, { recursive: true })
const files = readdirSync(srcDir).filter((f) => /\.(html|css)$/.test(f))
for (const f of files) {
  copyFileSync(join(srcDir, f), join(outDir, f))
}
console.log(`[sync-renderer] 同步 ${files.length} 个静态文件 → dist/renderer/`)
