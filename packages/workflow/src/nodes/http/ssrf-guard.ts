/**
 * SSRF 守卫 —— HTTP 节点与 http_request 工具共用的目标地址校验。
 *
 * 威胁模型：flow 内容（模板 / AI 生成的图 / 用户粘贴的 JSON）是攻击面，
 * 不能信任其中携带的 URL。只挡「目标地址指向本机/内网」这一类：
 * 环回、私网、链路本地（含云元数据 169.254.169.254）、NAT 本地。
 * 协议白名单由调用方自行保证（http/https）。
 *
 * 明确不覆盖（已知取舍）：
 * - DNS rebinding：域名解析成公网 IP 过校验、实际连接时变内网 IP。
 *   封死需要 resolve-then-pin-IP，Node fetch 不支持；单机本机姿态下接受。
 * - 重定向：守卫在每一跳重定向上重复执行（见 http.node.ts 的手动跟随），
 *   但 3xx 跳转目标本身仍受同一校验约束，无额外逃逸面。
 *
 * 逃生门：`DAGENTS_HTTP_ALLOW_PRIVATE=1` 放行私网目标（本机 e2e /
 * 调试本地服务场景），不区分环境全局生效 —— 用完请关。
 */

const LOOPBACK_HOSTNAMES = new Set(['localhost', 'localhost.localdomain', 'ip6-localhost', 'ip6-loopback'])

/** IPv4 私网/环回/链路本地段的十进制判断（避免依赖 net.BlockList 的实例开销）。 */
function isPrivateIPv4(host: string): boolean {
  const parts = host.split('.')
  if (parts.length !== 4 || parts.some((p) => !/^\d{1,3}$/.test(p))) return false
  const octets = parts.map((p) => Number(p))
  if (octets.some((o) => o > 255)) return false
  const [a, b] = octets
  if (a === 0) return true // 0.0.0.0/8 "this network"
  if (a === 10) return true // 10/8 私网
  if (a === 127) return true // 127/8 环回
  if (a === 169 && b === 254) return true // 169.254/16 链路本地（含云元数据）
  if (a === 172 && b >= 16 && b <= 31) return true // 172.16/12 私网
  if (a === 192 && b === 168) return true // 192.168/16 私网
  if (a === 100 && b >= 64 && b <= 127) return true // 100.64/10 CGNAT 本地
  if (a === 192 && b === 0) return true // 192.0.0.0/24 与 192.0.2.0/24
  if (a === 198 && (b === 18 || b === 19)) return true // 198.18/15 基准测试段
  return false
}

/** IPv6 环回 / ULA / 链路本地 / v4-mapped 判断。 */
function isPrivateIPv6(host: string): boolean {
  let h = host.toLowerCase()
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(h)
  if (mapped) return isPrivateIPv4(mapped[1])
  h = h.replace(/^\[|\]$/g, '') // URL.hostname 会保留方括号
  if (h === '::1' || h === '::') return true
  // 展开首段判断前缀段：fc00::/7 (ULA)、fe80::/10 (链路本地)、ff00::/8 (组播)
  const firstGroup = Number.parseInt(h.split(':')[0] || '0', 16)
  if (Number.isFinite(firstGroup)) {
    if ((firstGroup & 0xfe00) === 0xfc00) return true
    if ((firstGroup & 0xffc0) === 0xfe80) return true
    if ((firstGroup & 0xff00) === 0xff00) return true
  }
  return false
}

/** hostname 是否指向本机/内网。接受 URL.hostname（IPv6 带方括号）或裸字符串。 */
export function isPrivateHttpHost(hostname: string): boolean {
  const h = hostname.toLowerCase().replace(/^\[|\]$/g, '')
  if (LOOPBACK_HOSTNAMES.has(h)) return true
  if (h.includes(':')) return isPrivateIPv6(h)
  if (/^\d+\.\d+\.\d+\.\d+$/.test(h)) return isPrivateIPv4(h)
  // .local / .internal 之类的本地解析后缀视为内网目标
  if (h.endsWith('.local') || h.endsWith('.internal') || h.endsWith('.localhost')) return true
  return false
}

/** 逃生门是否打开（全局放行私网目标）。 */
export function privateHttpAllowed(): boolean {
  return process.env.DAGENTS_HTTP_ALLOW_PRIVATE === '1'
}

/**
 * 校验 http(s) URL 不是本机/内网目标，不合法即抛错（错误信息面向
 * flow 作者，可直接出现在节点失败 span 上）。协议白名单由调用方前置。
 */
export function assertPublicHttpUrl(url: URL, what = 'HTTP Request'): void {
  if (privateHttpAllowed()) return
  if (isPrivateHttpHost(url.hostname)) {
    throw new Error(
      `${what} blocks private/local targets for SSRF safety: ${url.hostname} ` +
        `(set DAGENTS_HTTP_ALLOW_PRIVATE=1 to allow when you really mean it)`,
    )
  }
}
