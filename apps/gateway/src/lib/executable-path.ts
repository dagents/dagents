import { statSync } from 'node:fs'
import { isAbsolute } from 'node:path'

/**
 * executablePath 输入面守卫。
 *
 * `agents.executablePath` / `agent_daemons.executable_path` 最终会成为
 * `createBackend` 的 spawn 可执行路径（inline-executor / agent-invoke 都读它）。
 * 默认无认证模式下 HTTP 调用者能直接 POST /agents —— 没有这层校验，
 * 等于「注册任意二进制为 Agent，下次触发即执行」的本机 RCE 面。
 *
 * 规则刻意保守：绝对路径 + 真实存在的普通文件（符号链接跟随后的目标
 * 也必须是文件）。不做 basename 白名单 —— 用户可能装了自定义包装脚本，
 * 单机本机姿态下「存在的文件」已是合理的最低门槛。
 */

export type ExecutablePathCheck =
  | { ok: true; path: string }
  | { ok: false; path: string; reason: string }

export function checkExecutablePath(raw: string): ExecutablePathCheck {
  const p = raw.trim()
  if (!p) return { ok: false, path: raw, reason: 'executablePath is empty' }
  if (p.includes('\0')) return { ok: false, path: raw, reason: 'executablePath contains null bytes' }
  if (!isAbsolute(p)) {
    return { ok: false, path: raw, reason: 'executablePath must be an absolute path (got a relative path — PATH lookup is not allowed)' }
  }
  let st: ReturnType<typeof statSync>
  try {
    st = statSync(p)
  } catch {
    return { ok: false, path: raw, reason: `executablePath does not exist on this machine: ${p}` }
  }
  if (!st.isFile()) {
    return { ok: false, path: raw, reason: `executablePath is not a regular file: ${p}` }
  }
  return { ok: true, path: p }
}
