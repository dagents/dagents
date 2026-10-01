/**
 * codex 真机回归场景注册表（方案 C · spec §4「捕获注册表」）。
 *
 * 单源三用：
 *   - scripts/capture-real-cli.ts 按此构造生产同款 argv 捕获真机事件流
 *   - codex.fixtures.test.ts（L1）按此遍历夹具回放
 *   - codex.real.test.ts（L3）按此对活 CLI 跑同一套任务
 *
 * 提示词全部要求精确标记串（沿用 real-cli-smoke.sh 的 dagents-smoke-ok
 * 手法）——断言一律语义级（标记串包含 / 事件形状 / usage 字段映射），
 * 模型文本的其余部分天然不确定，绝不字节比对（spec D3）。
 */

/** 捕获/回归场景携带的 ExecOptions 子集（与生产 buildCodexArgs 的Owned 字段对齐）。 */
export interface CodexScenarioOpts {
  model?: string
  maxTurns?: number
}

export interface CodexCaptureScenario {
  /** fixtures/codex/ 下的目录名 —— 捕获产物、L1 场景表、L3 注册表共用的 key。 */
  dir: string
  /** spec §4 的五个类别标签。 */
  category: string
  prompt: string
  opts: CodexScenarioOpts
  /** 该场景钉住的行为（一句话；语义断言在 codex.assertions.ts）。 */
  pins: string
}

export const CODEX_SCENARIOS: CodexCaptureScenario[] = [
  {
    dir: 'single-turn',
    category: '单轮问答',
    prompt: 'Reply with exactly: dagents-codex-ok',
    opts: {},
    pins: 'thread.started→sessionId；agent_message→text；turn.completed usage；exit 0→completed',
  },
  {
    dir: 'long-output',
    category: '长输出',
    prompt: 'Print a numbered list from 1 to 120, one number per line, nothing else.',
    opts: {},
    pins: '长 text 的分段累积；reasoning item（若出现）→log 事件不丢',
  },
  {
    dir: 'tool-call-write',
    category: '工具调用+写文件',
    prompt:
      'Run the shell command "ls -la" in the current directory and write its full output into a file named out.txt. Then reply with exactly: dagents-codex-tool-ok',
    opts: {},
    pins: 'command_execution→tool-use+tool-result 对；file_change→log；非 git cwd 下 --skip-git-repo-check 生效（捕获 cwd 即非 git 临时目录）',
  },
  {
    dir: 'error-model-invalid',
    category: '报错退出',
    prompt: 'Reply with exactly: dagents-codex-ok',
    opts: { model: 'definitely-not-a-real-model' },
    pins: '非法模型的真实错误帧形状；finalStatus=failed；非零退出码（零 token 成本，建议最先捕获——同时验证捕获器对失败的正确记录）',
  },
  {
    dir: 'error-max-turns',
    category: '报错退出',
    prompt: 'Run the shell command "ls", then run "pwd", then reply with exactly: dagents-codex-maxturns-ok',
    opts: { maxTurns: 1 },
    pins: '--max-turns 1 截断的真实帧形状（文档最语焉不详处，重点取证）',
  },
  {
    dir: 'usage-multiround',
    category: '多轮 usage',
    prompt:
      'Run these shell commands as three separate invocations, one at a time: "echo one", "echo two", "echo three". After all three finish, reply with exactly: dagents-codex-usage-ok',
    opts: {},
    pins: 'usage 帧语义（会话累计快照、max 防重）、cached_input_tokens 字段映射（值可为 0，字段必须在）',
  },
]
