import { describe, expect, it } from 'vitest'
import { mkdtemp, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { delimiter, join } from 'node:path'
import { resolveCommand } from './resolve'

// 与蓝本 win-spawn.test.ts 同款契约（docs §3.3 最小副本须与蓝本行为一致）。

const isWin = process.platform === 'win32'

describe('resolveCommand — POSIX 恒等契约（全平台）', () => {
  it.skipIf(isWin)('裸名/路径一律原样返回', () => {
    expect(resolveCommand('pnpm')).toEqual({ path: 'pnpm', viaShell: false })
    expect(resolveCommand('/usr/local/bin/pnpm')).toEqual({ path: '/usr/local/bin/pnpm', viaShell: false })
  })

  it.skipIf(!isWin)('裸名未命中 PATH → 原名回落（spawn ENOENT 语义不漂移）', () => {
    const r = resolveCommand('definitely-not-a-real-cli-m2')
    expect(r).toEqual({ path: 'definitely-not-a-real-cli-m2', viaShell: false })
  })

  it.skipIf(!isWin)('显式扩展名/路径透传：.exe 直启，.cmd 标记 shell', () => {
    expect(resolveCommand('pnpm.exe')).toEqual({ path: 'pnpm.exe', viaShell: false })
    expect(resolveCommand('pnpm.cmd')).toEqual({ path: 'pnpm.cmd', viaShell: true })
    expect(resolveCommand('C:\\tools\\cli.cmd')).toEqual({ path: 'C:\\tools\\cli.cmd', viaShell: true })
    expect(resolveCommand('C:/tools/cli.exe')).toEqual({ path: 'C:/tools/cli.exe', viaShell: false })
  })

  it.skipIf(!isWin)('PATH 探测：.exe 优先于 .cmd', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'dagents-desktop-resolve-'))
    try {
      await writeFile(join(dir, 'fake-a.cmd'), '@echo off\r\n')
      await writeFile(join(dir, 'fake-a.exe'), 'MZ')
      await writeFile(join(dir, 'fake-b.cmd'), '@echo off\r\n')
      const saved = process.env.PATH
      process.env.PATH = `${dir}${delimiter}${saved ?? ''}`
      try {
        const a = resolveCommand('fake-a')
        expect(a.viaShell).toBe(false)
        expect(a.path.toLowerCase()).toContain('fake-a.exe')

        const b = resolveCommand('fake-b')
        expect(b.viaShell).toBe(true)
        expect(b.path.toLowerCase()).toContain('fake-b.cmd')
      } finally {
        process.env.PATH = saved
      }
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it.skipIf(!isWin)('PATHEXT 自定义顺序被尊重', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'dagents-desktop-resolve-pe-'))
    try {
      await writeFile(join(dir, 'fake-c.exe'), 'MZ')
      await writeFile(join(dir, 'fake-c.cmd'), '@echo off\r\n')
      const savedPath = process.env.PATH
      const savedExt = process.env.PATHEXT
      process.env.PATH = dir
      process.env.PATHEXT = '.CMD;.EXE'
      try {
        const r = resolveCommand('fake-c')
        expect(r.viaShell).toBe(true)
        expect(r.path.toLowerCase()).toContain('fake-c.cmd')
      } finally {
        process.env.PATH = savedPath
        if (savedExt === undefined) delete process.env.PATHEXT
        else process.env.PATHEXT = savedExt
      }
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it.skipIf(!isWin)('默认命令 pnpm 能解析到（真机 PATH 上应有 pnpm.cmd/exe）', () => {
    const r = resolveCommand('pnpm')
    // 只要命中了就不是原名回落
    expect(r.path.toLowerCase()).toMatch(/pnpm\.(cmd|exe)$/)
  })
})
