import { describe, it, expect } from 'vitest'
import { detectRefusal } from '../refusal-detect'

describe('detectRefusal — 权限拒绝的诚实标注', () => {
  it('命中英文拒绝话术', () => {
    expect(detectRefusal('I cannot do this: Permission denied by system')).toBe('permission')
    expect(detectRefusal('This operation requires your approval to proceed')).toBe('permission')
    expect(detectRefusal("I don't have permission to write files")).toBe('permission')
  })

  it('命中中文拒绝话术', () => {
    expect(detectRefusal('抱歉，我没有权限执行这个操作')).toBe('permission')
    expect(detectRefusal('该操作需要您的批准，请在终端中手动确认')).toBe('permission')
    expect(detectRefusal('无法获得写入权限，文件未创建')).toBe('permission')
  })

  it('不误报：讨论权限的正常回复', () => {
    expect(detectRefusal('我检查了文件权限，当前是 644，建议改为 750')).toBeNull()
    expect(detectRefusal('Here is how Linux file permissions work: rwxr-xr-x')).toBeNull()
    expect(detectRefusal('已完成，文件已创建并写入成功')).toBeNull()
  })

  it('空值安全', () => {
    expect(detectRefusal(null)).toBeNull()
    expect(detectRefusal(undefined)).toBeNull()
    expect(detectRefusal('')).toBeNull()
  })
})

describe('detectRefusal — 真实事故话术（2026-08-24 采集）', () => {
  it('命中「权限未授予/安全策略拦截」变体', () => {
    expect(detectRefusal('Write 工具权限未授予，shell 重定向和 tee 也被安全策略拦截，因此无法创建文件')).toBe('permission')
    expect(detectRefusal('操作被应用策略拦截，无法继续')).toBe('permission')
  })
})
