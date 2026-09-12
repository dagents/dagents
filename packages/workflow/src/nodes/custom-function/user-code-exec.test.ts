import { describe, expect, it } from 'vitest'
import { runUserCode } from './user-code-exec.js'

/**
 * CustomFunction worker 执行器（2026-09-06）：
 * 正常返回 / 死循环超时强杀（不再冻住事件循环）/ 危险全局遮蔽 /
 * 抛错回传 / AbortSignal 取消。约定的语义与旧同步 new Function 一致
 * （函数体同步 return，非对象由节点层包 { value }）。
 */

describe('runUserCode（worker 隔离执行）', () => {
  it('同步 return 正常回传（对象原样、标量原样）', async () => {
    const obj = await runUserCode('return { result: $input, text: $inputText }', { a: 1 }, '{"a":1}', { s: 1 })
    expect(obj).toEqual({ result: { a: 1 }, text: '{"a":1}' })
    const scalar = await runUserCode('return 41 + 1', undefined, '', {})
    expect(scalar).toBe(42)
  })

  it('$flow.state 可读写', async () => {
    const out = await runUserCode('return { saw: $flow.state.foo }', undefined, '', { foo: 'bar' })
    expect(out).toEqual({ saw: 'bar' })
  })

  it('死循环超时强杀 —— 只死节点不死进程（默认超时可注入覆盖）', async () => {
    await expect(
      runUserCode('while (true) {}', undefined, '', {}, { timeoutMs: 150 }),
    ).rejects.toThrow(/timed out after 150ms/)
  })

  it('危险全局被遮蔽：require/process/globalThis 直接访问即抛', async () => {
    await expect(runUserCode('return process.version', undefined, '', {}, { timeoutMs: 2000 })).rejects.toThrow(
      /custom function threw/,
    )
    await expect(runUserCode('return typeof require', undefined, '', {}, { timeoutMs: 2000 })).resolves.toBe('undefined')
    await expect(runUserCode('return typeof globalThis', undefined, '', {}, { timeoutMs: 2000 })).resolves.toBe('undefined')
  })

  it('用户函数抛错 → 错误栈回传', async () => {
    await expect(runUserCode('throw new Error("boom")', undefined, '', {})).rejects.toThrow(
      /custom function threw.*boom/,
    )
  })

  it('AbortSignal 取消 → worker 终止', async () => {
    const ac = new AbortController()
    const p = runUserCode('while (true) {}', undefined, '', {}, { timeoutMs: 0, signal: ac.signal })
    setTimeout(() => ac.abort(new Error('cancelled by caller')), 80)
    await expect(p).rejects.toThrow(/cancelled/)
  })
})
