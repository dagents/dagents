import type { Context } from 'hono'
import type { ContentfulStatusCode } from 'hono/utils/http-status'

/**
 * 路由层共享微件 —— 错误信封 + UUID 校验（2026-09-17 评审收敛单源）。
 *
 * 此前 `ok`/`fail` 在 16 个路由文件各自复制、`UUID_RE` 在 8 个文件重复
 * （且 runs.ts 另有一个宽松变体会放过畸形 id 进 SQL）。横切语义（信封
 * 形状、校验强度）从此处唯一导出；新路由 import 这里，不要再本地定义。
 */

/** Canonical UUID shape（与既有 8 处实现同形态：不限版本位，测试里的
 * 全零/固定 UUID 也能通过；用于防畸形串进 `$1::uuid` SQL 即可）。 */
export const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export const ok = <T>(c: Context, data: T) => c.json({ success: true, data })

export const fail = (
  c: Context,
  status: ContentfulStatusCode,
  error: string,
  extra?: Record<string, unknown>,
) => c.json({ success: false, error, ...extra }, status)

/** 便捷守卫：id 参数不是 UUID 时直接回 400（终结「宽松 regex 放畸形 id 进 SQL」）。 */
export function requireUuid(c: Context, id: string, name = 'id'): Response | null {
  if (!UUID_RE.test(id)) {
    return fail(c, 400, `invalid ${name} (uuid expected)`, { [name]: id })
  }
  return null
}

/** UUID 参数清洗：非 UUID 值返回 null（供可空外键列使用，对齐 usage-events 语义）。 */
export function uuidOrNull(id: string | null | undefined): string | null {
  return id && UUID_RE.test(id) ? id : null
}
