import { createConnection } from 'node:net'

// 端口探测——scripts/guard-build.mjs:24-37 同款 socket 手法（docs §3.1 附加模式判定）。
// 只回答「有没有人在听」，不区分监听者是谁（编排器据此决定附加/接管）。

export function probePort(port: number, host = '127.0.0.1', timeoutMs = 300): Promise<boolean> {
  return new Promise((resolve) => {
    const sock = createConnection({ port, host })
    sock.once('connect', () => {
      sock.destroy()
      resolve(true)
    })
    sock.once('error', () => resolve(false))
    sock.setTimeout(timeoutMs, () => {
      sock.destroy()
      resolve(false)
    })
  })
}

/** 等待端口释放（停止验收口径：树终止后端口应释放；超时返回 false 只告警不扩杀）。 */
export async function waitForPortRelease(
  port: number,
  timeoutMs = 8_000,
  intervalMs = 400
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (!(await probePort(port))) return true
    await new Promise((r) => setTimeout(r, intervalMs))
  }
  return !(await probePort(port))
}
