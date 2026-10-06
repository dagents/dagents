import { appendFileSync, existsSync, mkdirSync, renameSync, statSync } from 'node:fs'
import { join } from 'node:path'

// 日志：环形缓冲（启动态页看尾）+ 落盘（排障定位「哪个服务+日志尾+下一步」）。
// 纯逻辑可测：环形缓冲零副作用；落盘 sink 用注入式 fs（单测用真 tmpdir + 小阈值）。

export interface RingLog {
  push(line: string): void
  tail(n: number): string[]
  size(): number
}

/** 定容环形日志：超出容量的最旧行被裁掉（FIFO）。 */
export function createRingLog(capacity: number): RingLog {
  const cap = Math.max(1, Math.floor(capacity))
  const lines: string[] = []
  return {
    push(line: string) {
      lines.push(line)
      if (lines.length > cap) lines.splice(0, lines.length - cap)
    },
    tail(n: number) {
      const k = Math.min(Math.max(1, n), lines.length)
      return lines.slice(-k)
    },
    size() {
      return lines.length
    },
  }
}

/** 超长行截断（esbuild 产物/大 JSON 行不该撑爆快照与磁盘）。 */
export function clampLine(line: string, maxChars = 2000): string {
  return line.length > maxChars ? `${line.slice(0, maxChars)}…(截断)` : line
}

export interface DiskSinkDeps {
  appendFileSync: (file: string, data: string) => void
  statSync: (path: string) => { size: number }
  existsSync: (path: string) => boolean
  renameSync: (from: string, to: string) => void
  mkdirSync: (dir: string, opts: { recursive: true }) => void
}

export const realDiskDeps: DiskSinkDeps = {
  appendFileSync,
  statSync,
  existsSync,
  renameSync,
  mkdirSync: (d, o) => mkdirSync(d, o),
}

/**
 * 落盘 sink：userData/logs/<svc>.log 追加写，超过 maxBytes 轮转成一个 .1
 * （单代轮转——桌面壳排障只需要「最近的完整一段」）。
 */
export function createDiskSink(
  dir: string,
  baseName: string,
  opts: { maxBytes?: number; deps?: DiskSinkDeps } = {}
) {
  const { maxBytes = 10 * 1024 * 1024, deps = realDiskDeps } = opts
  const file = join(dir, `${baseName}.log`)
  const rotated = `${file}.1`
  return {
    file,
    append(line: string): void {
      try {
        deps.mkdirSync(dir, { recursive: true })
        if (deps.existsSync(file)) {
          const size = deps.statSync(file).size
          if (size > maxBytes) {
            try {
              deps.renameSync(file, rotated)
            } catch {
              // 轮转失败不阻断日志写入
            }
          }
        }
        deps.appendFileSync(file, `${line}\n`)
      } catch {
        // 磁盘写失败不阻断编排（日志尽力而为）
      }
    },
  }
}
