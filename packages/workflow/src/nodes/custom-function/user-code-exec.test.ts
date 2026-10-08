import { describe, expect, it, vi } from 'vitest'
import { runUserCode } from './user-code-exec.js'

/**
 * CustomFunction worker 执行器（2026-09-06）：
 * 正常返回 / 死循环超时强杀（不再冻住事件循环）/ 危险全局遮蔽 /
 * 抛错回传 / AbortSignal 取消。约定的语义与旧同步 new Function 一致
 * （函数体同步 return，非对象由节点层包 { value }）。
 */

describe('runUserCode（worker 隔离执行）', () => {
  it('同步 return 正常回传（对象原样、标量原样）', async () => {
    const obj = await runUserCode(
      'return { result: $input, text: $inputText }',
      { a: 1 },
      '{"a":1}',
      { s: 1 },
    )
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
    await expect(
      runUserCode('return process.version', undefined, '', {}, { timeoutMs: 2000 }),
    ).rejects.toThrow(/custom function threw/)
    await expect(
      runUserCode('return typeof require', undefined, '', {}, { timeoutMs: 2000 }),
    ).resolves.toBe('undefined')
    await expect(
      runUserCode('return typeof globalThis', undefined, '', {}, { timeoutMs: 2000 }),
    ).resolves.toBe('undefined')
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

  // ── R4 $exec 受控命令通道（2026-10-07，AC-R4-2）───────────────────────

  it('异步 return Promise 正常回传（向后兼容契约扩展）', async () => {
    const out = await runUserCode(
      'return Promise.resolve(42).then((v) => v + 1)',
      undefined,
      '',
      {},
      { timeoutMs: 2000 },
    )
    expect(out).toBe(43)
  })

  it('无 allowedCommands → $exec 是 undefined（typeof === "undefined"）', async () => {
    const out = await runUserCode('return typeof $exec', undefined, '', {}, { timeoutMs: 2000 })
    expect(out).toBe('undefined')
  })

  it('无 allowedCommands 调用 $exec → 错误回传（节点层可识别 $exec is not a function）', async () => {
    await expect(
      runUserCode('return $exec("git", ["status"])', undefined, '', {}, { timeoutMs: 2000 }),
    ).rejects.toThrow(/\$exec is not a function/)
  })

  it('声明白名单 + 调用已列命令 → execRunner 收到请求且结果回流', async () => {
    const calls: Array<{ command: string; args: string[]; allowedCommands: string[] }> = []
    const out = await runUserCode(
      'return (async () => { const r = await $exec("git", ["status", "--short"]); return { code: r.code, out: r.stdout } })()',
      undefined,
      '',
      {},
      {
        timeoutMs: 5000,
        allowedCommands: ['git', 'rg'],
        execRunner: async (req) => {
          calls.push({ command: req.command, args: req.args, allowedCommands: req.allowedCommands })
          return { code: 0, stdout: 'M file.ts', stderr: '', truncated: false }
        },
      },
    )
    expect(out).toEqual({ code: 0, out: 'M file.ts' })
    expect(calls).toEqual([
      { command: 'git', args: ['status', '--short'], allowedCommands: ['git', 'rg'] },
    ])
  })

  it('调用未列命令 → 结构化错误（含已声明清单）且 execRunner 零调用', async () => {
    const runner = vi.fn(async () => ({ code: 0, stdout: '', stderr: '', truncated: false }))
    await expect(
      runUserCode(
        'return $exec("curl", ["http://x.test"]).then(() => "should not reach")',
        undefined,
        '',
        {},
        {
          timeoutMs: 5000,
          allowedCommands: ['git'],
          execRunner: runner,
        },
      ),
    ).rejects.toThrow(/curl 未在 allowedCommands 声明（已声明：git）/)
    expect(runner).not.toHaveBeenCalled()
  })

  it('declared-empty [] → 通道在但全拒', async () => {
    await expect(
      runUserCode(
        'return $exec("git", []).then(() => 1)',
        undefined,
        '',
        {},
        {
          timeoutMs: 5000,
          allowedCommands: [],
          execRunner: async () => ({ code: 0, stdout: '', stderr: '', truncated: false }),
        },
      ),
    ).rejects.toThrow(/git 未在 allowedCommands 声明（已声明：）/)
  })

  it('execRunner 未注入 → 宿主通道缺席的结构化错误', async () => {
    await expect(
      runUserCode(
        'return $exec("git", []).then(() => 1)',
        undefined,
        '',
        {},
        {
          timeoutMs: 5000,
          allowedCommands: ['git'],
        },
      ),
    ).rejects.toThrow(/宿主未提供受控执行通道/)
  })

  it('$exec 参数形状校验：非字符串 argv / 非字符串命令名 → worker 侧拒绝', async () => {
    await expect(
      runUserCode(
        'return $exec("git", [1, 2]).then(() => 1)',
        undefined,
        '',
        {},
        {
          timeoutMs: 5000,
          allowedCommands: ['git'],
          execRunner: async () => ({ code: 0, stdout: '', stderr: '', truncated: false }),
        },
      ),
    ).rejects.toThrow(/只接受字符串/)
    await expect(
      runUserCode(
        'return $exec("").then(() => 1)',
        undefined,
        '',
        {},
        {
          timeoutMs: 5000,
          allowedCommands: ['git'],
          execRunner: async () => ({ code: 0, stdout: '', stderr: '', truncated: false }),
        },
      ),
    ).rejects.toThrow(/非空命令名/)
  })

  it('onExecActivity 起止各一行（tool/tool_result 数据源）', async () => {
    const events: Array<{ phase: string; command: string }> = []
    await runUserCode(
      'return $exec("git", []).then((r) => r.code)',
      undefined,
      '',
      {},
      {
        timeoutMs: 5000,
        allowedCommands: ['git'],
        execRunner: async () => ({ code: 0, stdout: 'ok', stderr: '', truncated: false }),
        onExecActivity: (e) => events.push({ phase: e.phase, command: e.command }),
      },
    )
    expect(events).toEqual([
      { phase: 'start', command: 'git' },
      { phase: 'end', command: 'git' },
    ])
  })

  it('worker 超时 → 在途 exec 被 abort（execRunner 收到 signal abort）', async () => {
    let aborted = false
    const execRunner = (req: { signal?: AbortSignal }) =>
      new Promise((_resolve, reject) => {
        req.signal?.addEventListener('abort', () => {
          aborted = true
          reject(new Error('exec cancelled'))
        })
      })
    await expect(
      runUserCode(
        'return $exec("sleep-less", []).then(() => 1)',
        undefined,
        '',
        {},
        {
          timeoutMs: 300,
          allowedCommands: ['sleep-less'],
          execRunner: execRunner as never,
        },
      ),
    ).rejects.toThrow(/timed out after 300ms/)
    expect(aborted).toBe(true)
  })
})
