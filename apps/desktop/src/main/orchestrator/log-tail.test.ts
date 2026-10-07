import { describe, expect, it } from 'vitest'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { clampLine, createDiskSink, createRingLog } from './log-tail'

describe('createRingLog（环形缓冲）', () => {
  it('容量内全保留，超出裁最旧', () => {
    const ring = createRingLog(3)
    ring.push('a')
    ring.push('b')
    ring.push('c')
    expect(ring.size()).toBe(3)
    expect(ring.tail(3)).toEqual(['a', 'b', 'c'])
    ring.push('d')
    expect(ring.tail(3)).toEqual(['b', 'c', 'd'])
    expect(ring.size()).toBe(3)
  })

  it('tail(n) 取末 n 行；n 超过存量返回全部', () => {
    const ring = createRingLog(400)
    for (let i = 1; i <= 10; i++) ring.push(`line-${i}`)
    expect(ring.tail(3)).toEqual(['line-8', 'line-9', 'line-10'])
    expect(ring.tail(999)).toHaveLength(10)
  })

  it('容量 0/负数按 1 兜底（不炸）', () => {
    const ring = createRingLog(0)
    ring.push('x')
    ring.push('y')
    expect(ring.tail(1)).toEqual(['y'])
  })
})

describe('clampLine', () => {
  it('超长行截断并标记', () => {
    const long = 'x'.repeat(5000)
    const out = clampLine(long, 100)
    expect(out.length).toBeLessThan(120)
    expect(out.endsWith('…(截断)')).toBe(true)
  })

  it('正常行原样返回', () => {
    expect(clampLine('hello', 100)).toBe('hello')
  })
})

describe('createDiskSink（落盘 + 10MB 轮转语义）', () => {
  it('追加写入目标文件，目录自动创建', async () => {
    const dir = join(await mkdtemp(join(tmpdir(), 'dagents-desktop-log-')), 'sub', 'logs')
    try {
      const sink = createDiskSink(dir, 'gateway')
      sink.append('line-1')
      sink.append('line-2')
      const content = await readFile(sink.file, 'utf-8')
      expect(content).toBe('line-1\nline-2\n')
    } finally {
      await rm(join(dir, '..'), { recursive: true, force: true })
    }
  })

  it('超过 maxBytes 轮转到 .1（单代覆盖）', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'dagents-desktop-log-rot-'))
    try {
      const sink = createDiskSink(dir, 'console', { maxBytes: 30 })
      sink.append('0123456789012345678901234567890') // 30 字节 → 下一笔触发轮转
      sink.append('second-generation')
      const rotated = await readFile(join(dir, 'console.log.1'), 'utf-8')
      expect(rotated).toContain('0123456789012345678901234567890')
      const current = await readFile(join(dir, 'console.log'), 'utf-8')
      expect(current).toBe('second-generation\n')
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('写失败静默（磁盘满/目录不可写不阻断编排）', async () => {
    const broken = {
      appendFileSync: () => {
        throw new Error('EACCES')
      },
      statSync: () => ({ size: 0 }),
      existsSync: () => false,
      renameSync: () => {},
      mkdirSync: () => {},
    }
    const sink = createDiskSink('/definitely/not/writable', 'gateway', { deps: broken })
    expect(() => sink.append('x')).not.toThrow()
  })
})
