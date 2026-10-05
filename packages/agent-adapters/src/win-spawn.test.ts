import { describe, it, expect } from 'vitest'
import { mkdtemp, writeFile, mkdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, delimiter } from 'node:path'
import { resolveCliExecutable } from './win-spawn.js'

/**
 * win32 spawn 兼容层单测（2026-10-05）。
 *
 * 覆盖矩阵：
 *   - POSIX 恒等返回（任何输入 → 原名 + 直启）
 *   - win32：PATH 探测顺序（.exe 优先于 .cmd）、显式扩展名透传、
 *     带路径透传、未命中回落原名（ENOENT 语义不漂移）、PATHEXT 覆盖
 *
 * win32 专属用例用 describe.skipIf 门控 —— 非 win32 上仍然验证「恒等」
 * 这一半契约。
 */
const isWin = process.platform === 'win32'

describe('resolveCliExecutable — POSIX 恒等契约（全平台）', () => {
  it.skipIf(isWin)('裸名/路径/扩展名一律原样返回', () => {
    expect(resolveCliExecutable('claude')).toEqual({ path: 'claude', viaShell: false })
    expect(resolveCliExecutable('/usr/local/bin/claude')).toEqual({
      path: '/usr/local/bin/claude',
      viaShell: false,
    })
    expect(resolveCliExecutable('./claude')).toEqual({ path: './claude', viaShell: false })
  })

  it.skipIf(!isWin)('裸名未命中 PATH → 原名回落（spawn ENOENT 语义不漂移）', () => {
    const r = resolveCliExecutable('definitely-not-a-real-cli-3f9a')
    expect(r.path).toBe('definitely-not-a-real-cli-3f9a')
    expect(r.viaShell).toBe(false)
  })

  it.skipIf(!isWin)('显式扩展名透传：.exe 直启，.cmd 标记 shell', () => {
    expect(resolveCliExecutable('claude.exe')).toEqual({ path: 'claude.exe', viaShell: false })
    expect(resolveCliExecutable('claude.cmd')).toEqual({ path: 'claude.cmd', viaShell: true })
    expect(resolveCliExecutable('C:\\tools\\codex.cmd')).toEqual({
      path: 'C:\\tools\\codex.cmd',
      viaShell: true,
    })
    expect(resolveCliExecutable('C:/tools/codex.exe')).toEqual({
      path: 'C:/tools/codex.exe',
      viaShell: false,
    })
  })

  it.skipIf(!isWin)('PATH 探测：.exe 优先于 .cmd（原生二进制面更小）', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'dagents-winspawn-'))
    try {
      await writeFile(join(dir, 'fake-a.cmd'), '@echo off\r\n')
      await writeFile(join(dir, 'fake-a.exe'), 'MZ') // 内容无所谓，isFile 即命中
      await writeFile(join(dir, 'fake-b.cmd'), '@echo off\r\n') // 只有 shim
      process.env.PATH = `${dir}${delimiter}${process.env.PATH ?? ''}`

      const a = resolveCliExecutable('fake-a')
      expect(a.viaShell).toBe(false)
      expect(a.path.toLowerCase()).toContain('fake-a.exe')

      const b = resolveCliExecutable('fake-b')
      expect(b.viaShell).toBe(true)
      expect(b.path.toLowerCase()).toContain('fake-b.cmd')
    } finally {
      await rmDir(dir)
    }
  })

  it.skipIf(!isWin)('PATHEXT 自定义顺序被尊重', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'dagents-winspawn-pe-'))
    try {
      await mkdir(dir, { recursive: true })
      await writeFile(join(dir, 'fake-c.exe'), 'MZ')
      await writeFile(join(dir, 'fake-c.cmd'), '@echo off\r\n')
      const savedPath = process.env.PATH
      const savedExt = process.env.PATHEXT
      process.env.PATH = dir
      // .cmd 排前 → shim 赢（运维显式配置优先于内建缺省）
      process.env.PATHEXT = '.CMD;.EXE'
      try {
        const r = resolveCliExecutable('fake-c')
        expect(r.viaShell).toBe(true)
        expect(r.path.toLowerCase()).toContain('fake-c.cmd')
      } finally {
        if (savedPath === undefined) delete process.env.PATH
        else process.env.PATH = savedPath
        if (savedExt === undefined) delete process.env.PATHEXT
        else process.env.PATHEXT = savedExt
      }
    } finally {
      await rmDir(dir)
    }
  })
})

async function rmDir(dir: string): Promise<void> {
  await import('node:fs/promises').then((f) => f.rm(dir, { recursive: true, force: true }))
}
