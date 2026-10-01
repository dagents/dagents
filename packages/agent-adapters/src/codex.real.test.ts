/**
 * L3 真机回归（方案 C · spec §6.4）—— env 门控 + CLI 存在性双条件。
 *
 * 运行方式（装有真实 codex CLI 且后端可用的机器）：
 *   REAL_CLI='codex' pnpm --filter @dagents/agent-adapters test:real
 * 缺 CLI / 未设 env ⇒ describe.skipIf 整组诚实跳过（「没测」不算「通过」）。
 *
 * 场景 = codex.scenarios.ts 注册表（与捕获器 / L1 同一单源），断言 = 与
 * L1 同一套语义断言模块（codex.assertions.ts，spec D6——两层断言漂移即
 * bug）。每次运行把 `codex --version` 打进报告（漂移取证第一现场）。
 *
 * 后端说明：断言与模型后端无关（钉的是 codex-rs 事件流语义）。测试跑在
 * 真实 codex CLI 上——后端由机器的 CODEX_HOME 配置决定（官方 ChatGPT
 * 登录或本地 Responses 兼容端点均可触发完整管线）。
 */
import { describe, it, expect, beforeAll } from 'vitest'
import { spawnSync } from 'node:child_process'
import { mkdtemp, rm, readFile } from 'node:fs/promises'
import * as os from 'node:os'
import * as path from 'node:path'
import type { AgentEvent } from '@dagents/contracts'
import { codexBackend } from './codex.js'
import { CODEX_SCENARIOS } from './codex.scenarios.js'
import { assertCodexScenario, type CodexRunObservation } from './codex.assertions.js'

const RUN = (process.env.REAL_CLI ?? '').split(/\s+/).filter(Boolean).includes('codex')
const CODEX_BIN = process.env.CODEX_BIN ?? 'codex'
const CLI_EXISTS = spawnSync('/bin/sh', ['-c', `command -v ${CODEX_BIN}`], { stdio: 'ignore' }).status === 0

/** 收集全部事件；单场景预算 = 墙钟 3 分钟（工具场景模型多轮推理）。 */
async function collect(stream: AsyncIterable<AgentEvent>): Promise<AgentEvent[]> {
  const out: AgentEvent[] = []
  for await (const ev of stream) out.push(ev)
  return out
}

describe.skipIf(!RUN || !CLI_EXISTS)('codex real-CLI regression (L3)', () => {
  let cliVersion = 'unknown'

  beforeAll(() => {
    const v = spawnSync(CODEX_BIN, ['--version'], { encoding: 'utf8' })
    cliVersion = (v.stdout ?? '').trim() || 'unknown'
    // 版本进报告输出 —— 格式漂移取证的第一现场（meta.json 的运行时对位）。
    console.log(`[L3] codex CLI: ${cliVersion}`)
  })

  // 每场景独立临时 cwd（非 git —— 同时持续验证 --skip-git-repo-check）。
  for (const s of CODEX_SCENARIOS) {
    it(`${s.dir}（${s.category}）: 真 CLI 语义断言`, { timeout: 180_000 }, async () => {
      const cwd = await mkdtemp(path.join(os.tmpdir(), 'dagents-codex-l3-'))
      try {
        const b = codexBackend({ executablePath: CODEX_BIN })
        const session = b.execute(s.prompt, { ...s.opts, cwd, timeoutMs: 150_000, inactivityTimeoutMs: 60_000 })
        const [events, result] = await Promise.all([collect(session.events), session.result])
        assertCodexScenario(s.dir, { events, result })
      } finally {
        await rm(cwd, { recursive: true, force: true }).catch(() => {})
      }
    })
  }

  it('tool-call-write 附加钉子: 工具通道存在时 out.txt 真实落盘（沙箱可写验证）', { timeout: 180_000 }, async () => {
    // 与注册表同 prompt 但检查文件系统副作用：-s workspace-write 下写文件
    // 必须成功（这是 argv 沙箱档位的真实验证，帧断言之外的物理证据）。
    const cwd = await mkdtemp(path.join(os.tmpdir(), 'dagents-codex-l3-tool-'))
    try {
      const b = codexBackend({ executablePath: CODEX_BIN })
      const s = CODEX_SCENARIOS.find((x) => x.dir === 'tool-call-write')!
      const session = b.execute(s.prompt, { ...s.opts, cwd, timeoutMs: 150_000, inactivityTimeoutMs: 60_000 })
      const result = await session.result
      // 模型行为（是否选择执行命令）不可强制，但若 completed 则文件应在。
      // 后端无 shell 工具通道时模型自述无法执行（仍 completed）——只对
      // 输出含成功标记的运行断言文件存在（有真工具通道的机器上生效）。
      if (result.output.includes('dagents-codex-tool-ok')) {
        const written = await readFile(path.join(cwd, 'out.txt'), 'utf8').catch(() => null)
        expect(written, 'out.txt 应已写入（workspace-write 沙箱）').toBeTruthy()
      } else {
        console.log('[L3] tool-call-write: 后端无工具通道（模型未执行命令）——文件断言跳过，帧断言已由上一用例覆盖')
      }
    } finally {
      await rm(cwd, { recursive: true, force: true }).catch(() => {})
    }
  })
})
