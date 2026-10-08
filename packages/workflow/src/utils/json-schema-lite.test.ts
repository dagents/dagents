/**
 * json-schema-lite —— expected/got 填充（2026-10-07 R5）。
 *
 * 五类判定分支（type / enum / 长度 / 边界 / 必填缺失）逐项钉 expected 与
 * got 的紧凑表达；同时钉「旧消费方只读 path/message 不受影响」——可选字
 * 段追加不改变 message 语义与判定结果。
 */
import { describe, it, expect } from 'vitest'
import { validateAgainstSchema } from './json-schema-lite.js'

describe('json-schema-lite — SchemaIssue expected/got（R5）', () => {
  it('type 不匹配：expected=schema.type，got=typeName(value)', () => {
    const issues = validateAgainstSchema(
      { age: 'x' },
      { type: 'object', properties: { age: { type: 'number' } } },
    )
    expect(issues).toHaveLength(1)
    expect(issues[0]).toMatchObject({ path: '$.age', expected: 'number', got: 'string' })
    // message 语义不变（旧消费方回归锚）
    expect(issues[0]!.message).toBe('应为 number，实际是 string')
  })

  it('enum 未命中：expected=枚举数组原串，got=值的 80 字 JSON 摘要', () => {
    const issues = validateAgainstSchema(
      { decision: 'maybe' },
      { type: 'object', properties: { decision: { type: 'string', enum: ['accept', 'reject'] } } },
    )
    expect(issues).toHaveLength(1)
    expect(issues[0]).toMatchObject({
      path: '$.decision',
      expected: '["accept","reject"]',
      got: '"maybe"',
    })
  })

  it('minLength/maxLength：expected=长度约束表达，got=实际长度', () => {
    const short = validateAgainstSchema(
      { name: 'ab' },
      {
        type: 'object',
        properties: { name: { type: 'string', minLength: 3 } },
      },
    )
    expect(short[0]).toMatchObject({ path: '$.name', expected: '长度 ≥ 3', got: '长度 2' })
    const long = validateAgainstSchema(
      { name: 'abcd' },
      {
        type: 'object',
        properties: { name: { type: 'string', maxLength: 3 } },
      },
    )
    expect(long[0]).toMatchObject({ path: '$.name', expected: '长度 ≤ 3', got: '长度 4' })
  })

  it('minimum/maximum：expected=边界表达，got=值本身', () => {
    const min = validateAgainstSchema(
      { score: 3 },
      {
        type: 'object',
        properties: { score: { type: 'number', minimum: 5 } },
      },
    )
    expect(min[0]).toMatchObject({ path: '$.score', expected: '≥ 5', got: '3' })
    const max = validateAgainstSchema(
      { score: 9 },
      {
        type: 'object',
        properties: { score: { type: 'number', maximum: 5 } },
      },
    )
    expect(max[0]).toMatchObject({ path: '$.score', expected: '≤ 5', got: '9' })
  })

  it('必填缺失：expected=必填字段存在，got=缺失', () => {
    const issues = validateAgainstSchema(
      { decision: 'accept' },
      {
        type: 'object',
        properties: { reason: { type: 'string' } },
        required: ['decision', 'reason'],
      },
    )
    expect(issues).toHaveLength(1)
    expect(issues[0]).toMatchObject({
      path: '$.reason',
      expected: '必填字段存在',
      got: '缺失',
    })
  })

  it('合规产出：零 issue（expected/got 不出现）', () => {
    const issues = validateAgainstSchema(
      { decision: 'accept', reason: 'ok' },
      {
        type: 'object',
        properties: { decision: { type: 'string', enum: ['accept', 'reject'] } },
        required: ['decision'],
      },
    )
    expect(issues).toEqual([])
  })

  it('超长实际值：got 截到 80 字（防回喂消息被病态产出撑爆）', () => {
    const huge = 'x'.repeat(300)
    const issues = validateAgainstSchema(
      { v: huge },
      { type: 'object', properties: { v: { type: 'string', enum: ['ok'] } } },
    )
    expect(issues[0]!.got!.length).toBeLessThanOrEqual(81) // 80 字 + 省略号
    expect(issues[0]!.got!.endsWith('…')).toBe(true)
  })
})
