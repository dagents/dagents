/**
 * json-schema-lite —— JSON Schema 判定子集校验器（2026-10-04 输出契约）。
 *
 * 为什么手写而不是引 ajv：workflow 包的纪律是零运行时依赖（引擎 DB-free、
 * 宿主注入一切）；输出契约需要的是「LLM 产出是否符合约定形状」的判定，
 * 不是完整 JSON Draft 规范。支持的子集（够表达结构化产出的常见形态）：
 *   - type：object / array / string / number / integer / boolean（数组细粒度
 *     不区分——integer 在 JS 里按 Number.isInteger 判定）
 *   - properties / required / additionalProperties(仅提示不拒收)
 *   - items（单 schema 形式）
 *   - enum
 *   - minLength / maxLength / minimum / maximum
 *
 * 返回错误列表（空数组 = 通过）。错误消息面向「喂回给 LLM 做格式修复」，
 * 用可定位的路径表达（a.b[0].c）。
 */

export interface SchemaIssue {
  path: string
  message: string
}

export function validateAgainstSchema(
  value: unknown,
  schema: Record<string, unknown>,
): SchemaIssue[] {
  const issues: SchemaIssue[] = []
  walk(value, schema, '$', issues)
  return issues
}

function walk(
  value: unknown,
  schema: Record<string, unknown>,
  path: string,
  issues: SchemaIssue[],
): void {
  if (typeof schema !== 'object' || schema === null) return

  const type = schema.type
  if (typeof type === 'string' && !typeMatches(value, type)) {
    issues.push({ path, message: `应为 ${type}，实际是 ${typeName(value)}` })
    return // 类型不对，后续约束没意义
  }

  if (Array.isArray(schema.enum) && !schema.enum.some((v) => deepEqual(v, value))) {
    issues.push({ path, message: `应为枚举值 ${JSON.stringify(schema.enum)} 之一` })
  }

  if (typeof value === 'string') {
    const min = typeof schema.minLength === 'number' ? schema.minLength : null
    const max = typeof schema.maxLength === 'number' ? schema.maxLength : null
    if (min != null && value.length < min)
      issues.push({ path, message: `长度 ${value.length} 小于 minLength ${min}` })
    if (max != null && value.length > max)
      issues.push({ path, message: `长度 ${value.length} 大于 maxLength ${max}` })
  }

  if (typeof value === 'number') {
    const min = typeof schema.minimum === 'number' ? schema.minimum : null
    const max = typeof schema.maximum === 'number' ? schema.maximum : null
    if (min != null && value < min) issues.push({ path, message: `${value} 小于 minimum ${min}` })
    if (max != null && value > max) issues.push({ path, message: `${value} 大于 maximum ${max}` })
  }

  if (typeof value === 'object' && value !== null && !Array.isArray(value)) {
    const props = (schema.properties ?? {}) as Record<string, Record<string, unknown>>
    const required = Array.isArray(schema.required) ? (schema.required as string[]) : []
    const record = value as Record<string, unknown>
    for (const key of required) {
      if (!(key in record) || record[key] === undefined) {
        issues.push({ path: `${path}.${key}`, message: `缺少必填字段「${key}」` })
      }
    }
    for (const [key, childSchema] of Object.entries(props)) {
      if (record[key] !== undefined) walk(record[key], childSchema, `${path}.${key}`, issues)
    }
  }

  if (Array.isArray(value)) {
    const items = schema.items
    if (typeof items === 'object' && items !== null) {
      value.forEach((item, i) =>
        walk(item, items as Record<string, unknown>, `${path}[${i}]`, issues),
      )
    }
  }
}

function typeMatches(value: unknown, type: string): boolean {
  switch (type) {
    case 'object':
      return typeof value === 'object' && value !== null && !Array.isArray(value)
    case 'array':
      return Array.isArray(value)
    case 'string':
      return typeof value === 'string'
    case 'number':
      return typeof value === 'number' && Number.isFinite(value)
    case 'integer':
      return typeof value === 'number' && Number.isInteger(value)
    case 'boolean':
      return typeof value === 'boolean'
    case 'null':
      return value === null
    default:
      return true // 未知类型名不设限（宽容而非误杀）
  }
}

function typeName(value: unknown): string {
  if (value === null) return 'null'
  if (Array.isArray(value)) return 'array'
  return typeof value
}

function deepEqual(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b)
}

/** 从模型输出文本中剥出 JSON：容忍 ```json 围栏与前后的说明文字。 */
export function extractJsonFromText(text: string): unknown {
  const trimmed = text.trim()
  const fenced = /```(?:json)?\s*([\s\S]*?)```/.exec(trimmed)
  const candidate = fenced ? fenced[1].trim() : trimmed
  // 首个 { 或 [ 到末个 } 或 ] —— 模型爱在 JSON 前后写废话
  const first = candidate.search(/[{[]/)
  const lastBrace = candidate.lastIndexOf('}')
  const lastBracket = candidate.lastIndexOf(']')
  const last = Math.max(lastBrace, lastBracket)
  if (first === -1 || last === -1 || last <= first) {
    throw new Error('输出中找不到 JSON 结构（无 {…} 或 […]）')
  }
  return JSON.parse(candidate.slice(first, last + 1))
}
