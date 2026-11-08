/**
 * 节点输入指纹单源（2026-10-07 可恢复性地基，design-recover §3.1(d) / AD-R3）。
 *
 * `computeInputHash` 的口径：SHA-1(canonical({ nodeType, resolvedConfig, nodeInput }))
 *  - `nodeType`：节点类型名（registry 查找键，`flowNode.data.name`）；
 *  - `resolvedConfig`：节点 mergedInputs **深拷贝后经 resolveVariables 预演解析**
 *    （只用于 hash，不改变传给节点的输入）——节点自身 prompt/配置改动经此
 *    进 hash（AC-R1-3）；未引用的 runtime 键不进 hash（不误杀）；
 *  - `nodeInput`：引擎 mergeInputs 结果原样——上游输出变化直接进 hash，暖缓存
 *    的保守传递闭包由此自动成立（R2.2），无需独立闭包算法。
 *
 * 引擎（种子校验、decision 行）与 gateway（暖缓存查找、resume 校验）共用本
 * 单源，不得出现第二套 hash（PRD R2 风险条款）。序列化写法对齐
 * computeTopoHash 的「排序序列化 + SHA-1」范式（resume-execution.ts:40-54）。
 */
import { createHash } from 'node:crypto'

/**
 * 非确定性键台账（PRD R2 风险条款）：实测发现配置里携带时间戳/随机值的键
 * 时，把键名记到这里——它们不进 hash（否则同配置两次运行永远 hash 不等）。
 * 初始为空：这是「发现的台账」，不是「穷举的清单」。
 */
export const NON_DETERMINISTIC_KEYS: ReadonlySet<string> = new Set<string>()

/** 值是否为不可序列化的运行时产物（undefined / 函数——canon 时跳过）。 */
function isSkippable(value: unknown): boolean {
  return value === undefined || typeof value === 'function'
}

/**
 * 确定性序列化：递归排序对象键；数组保序（序本身是语义）；undefined/函数
 * 跳过（对象键丢弃、数组位占 null 保长度）；NON_DETERMINISTIC_KEYS 命中的
 * 对象键跳过。Date 取 ISO 串（同一时刻同一串）。对象键排序用默认字典序——
 * 与插入序无关是全部要点。
 */
export function canonicalJson(value: unknown): string {
  const parts: string[] = []
  const walk = (v: unknown): void => {
    if (v === null) {
      parts.push('null')
      return
    }
    const t = typeof v
    if (t === 'string') {
      parts.push(JSON.stringify(v))
      return
    }
    if (t === 'number' || t === 'boolean' || t === 'bigint') {
      parts.push(String(v))
      return
    }
    if (t === 'object') {
      if (v instanceof Date) {
        parts.push(JSON.stringify(v.toISOString()))
        return
      }
      if (Array.isArray(v)) {
        parts.push('[')
        for (const item of v) {
          if (isSkippable(item)) {
            parts.push('null,')
          } else {
            walk(item)
            parts.push(',')
          }
        }
        parts.push(']')
        return
      }
      // 普通对象（含 Record / class 实例）：键排序后逐对序列化。
      const rec = v as Record<string, unknown>
      const keys = Object.keys(rec)
        .filter((k) => !NON_DETERMINISTIC_KEYS.has(k))
        .sort()
      parts.push('{')
      for (const k of keys) {
        const item = rec[k]
        if (isSkippable(item)) continue
        parts.push(JSON.stringify(k), ':')
        walk(item)
        parts.push(',')
      }
      parts.push('}')
      return
    }
    // undefined / function / symbol —— 顶层出现时占位 null（数组/对象位已处理）
    parts.push('null')
  }
  walk(value)
  return parts.join('')
}

/**
 * 节点输入指纹（AD-R3 口径）。参数是三个散件而非对象内嵌 runId 等上下文——
 * 同一节点定义 + 同一解析配置 + 同一上游输入 ⇒ 同 hash，跨 run 可比。
 */
export function computeInputHash(input: {
  nodeType: string
  resolvedConfig: unknown
  nodeInput: unknown
}): string {
  return createHash('sha1')
    .update(
      canonicalJson({
        nodeType: input.nodeType,
        resolvedConfig: input.resolvedConfig,
        nodeInput: input.nodeInput,
      }),
    )
    .digest('hex')
}
