import { describe, it, expect } from 'vitest'
import {
  parseEvalVerdict,
  buildGoalRoundInput,
  budgetExhausted,
} from '../goal-loop-service.js'
import type { GoalRow } from '../repositories/goals.repo.js'

/**
 * 目标环纯函数单测：判卷解析（JSON / 围栏 / 散文关键词降级——冒烟实测
 * judge 偶尔不按 JSON 输出）、轮次输入模板、预算判定。
 */

describe('parseEvalVerdict', () => {
  it('纯 JSON 对象 → 直接判', () => {
    expect(parseEvalVerdict('{"passed": true, "notes": "全部通过"}')).toEqual({
      passed: true,
      notes: '全部通过',
    })
  })

  it('围栏包裹的 JSON → 剥壳判', () => {
    expect(parseEvalVerdict('```json\n{"passed": false, "notes": "差回归"}\n```')).toEqual({
      passed: false,
      notes: '差回归',
    })
  })

  it('散文结论 → 关键词判卷（冒烟实测形态：「**结论：不通过（FAIL）**…」）', () => {
    const v = parseEvalVerdict('**结论：不通过（FAIL）**\n\n依据：零产出，无可验收内容。')
    expect(v?.passed).toBe(false)
    expect(v?.notes).toContain('零产出')
  })

  it('散文结论：显式失败词优先（「不通过」里含「通过」）', () => {
    expect(parseEvalVerdict('不通过：还差文档')?.passed).toBe(false)
    expect(parseEvalVerdict('验收通过，全部达标')?.passed).toBe(true)
  })

  it('空文本 → null（触发下个 tick 重试）', () => {
    expect(parseEvalVerdict('   ')).toBeNull()
  })

  it('无关键词的无关文本 → null', () => {
    expect(parseEvalVerdict('今天天气不错')).toBeNull()
  })
})

describe('buildGoalRoundInput', () => {
  const goal = {
    title: '旧官网重构',
    description: '落地页优先',
    acceptance: '1. 新站可跑\n2. 首屏 < 1s',
    round: 2,
    last_eval: '上轮差首屏性能',
  } as Pick<GoalRow, 'title' | 'description' | 'acceptance' | 'round' | 'last_eval'>

  it('含目标/验收标准/轮次/上轮差距/黑板纪律', () => {
    const input = buildGoalRoundInput(goal, '## 任务板\n- ◐ 实现中')
    expect(input).toContain('# 目标：旧官网重构')
    expect(input).toContain('第 3 轮')
    expect(input).toContain('不要自行放宽')
    expect(input).toContain('上一轮评估结论')
    expect(input).toContain('上轮差首屏性能')
    expect(input).toContain('任务板')
    expect(input).toContain('.agents/BOARD.md')
  })

  it('无验收标准/无上轮评估 → 诚实占位而非空段', () => {
    const input = buildGoalRoundInput(
      { ...goal, acceptance: '', last_eval: null },
      null,
    )
    expect(input).toContain('没有显式验收标准')
    expect(input).not.toContain('上一轮评估结论')
  })
})

describe('budgetExhausted', () => {
  it('无预算恒 false；花费超线 true', () => {
    expect(budgetExhausted(null, '999')).toBe(false)
    expect(budgetExhausted('10', '9.99')).toBe(false)
    expect(budgetExhausted('10', '10')).toBe(true)
    expect(budgetExhausted('10', 12)).toBe(true)
  })
})
