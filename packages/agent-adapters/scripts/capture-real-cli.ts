/**
 * codex 真机事件流捕获器（方案 C · spec §6.1）。
 *
 * 在装有真实 codex CLI（且已登录）的机器上运行：
 *   pnpm --filter @dagents/agent-adapters capture:real [--kind codex] [--scenario <name>] [--force]
 *
 * 关键设计：
 *   - argv 用生产同款 `buildCodexArgs`（spec D5：捕获意义在于回归生产
 *     argv，脚本里重拼 = 测了另一个东西）。
 *   - stdout 原样逐行 tee 到 raw.ndjson —— 含任何非 JSON 噪声行（解析器
 *     容错是被测行为，spec D2）。
 *   - meta.json 记录 provenance（cliVersion / model / sandbox / os /
 *     exitCode / lineCount / stderr 尾部）—— 格式漂移取证的最小集。
 *   - 夹具只能来自本脚本（spec D7：唯一合法来源是真实 CLI）。已存在同名
 *     夹具时拒绝覆盖，--force 显式重建。
 *   - 缺 CLI 如实 SKIP 退出 0（不伪装）；任一捕获失败非零退出；产物不
 *     完整即删（不留半截夹具）。
 *
 * adapter-generic：SCENARIOS 注册表先只有 codex（spec 非目标——qwen 等
 * 复用是副产品）。
 */
import { spawn, spawnSync } from 'node:child_process'
import { mkdtemp, mkdir, rm, writeFile, access } from 'node:fs/promises'
import { constants as fsConstants } from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import * as readline from 'node:readline'
import { fileURLToPath } from 'node:url'
import { buildCodexArgs } from '../src/codex.js'
import { CODEX_SCENARIOS } from '../src/codex.scenarios.js'

// ── argv（脚本自身，非生产） ────────────────────────────────────────────────

interface CliArgs {
  kind: string
  scenario?: string
  force: boolean
}

function parseCliArgs(argv: string[]): CliArgs {
  const args: CliArgs = { kind: 'codex', force: false }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === '--kind') args.kind = argv[++i] ?? ''
    else if (a === '--scenario') args.scenario = argv[++i] ?? ''
    else if (a === '--force') args.force = true
    else {
      console.error(`未知参数: ${a}\n用法: capture-real-cli.ts [--kind codex] [--scenario <name>] [--force]`)
      process.exit(2)
    }
  }
  return args
}

// ── 小工具 ──────────────────────────────────────────────────────────────────

async function exists(p: string): Promise<boolean> {
  try {
    await access(p, fsConstants.F_OK)
    return true
  } catch {
    return false
  }
}

function commandExists(cmd: string): boolean {
  const probe =
    process.platform === 'win32'
      ? spawnSync('where', [cmd], { stdio: 'ignore' })
      : spawnSync('/bin/sh', ['-c', `command -v ${cmd}`], { stdio: 'ignore' })
  return probe.status === 0
}

async function cliVersion(cmd: string): Promise<string> {
  return new Promise((resolve) => {
    const p = spawn(cmd, ['--version'], { stdio: ['ignore', 'pipe', 'ignore'] })
    let out = ''
    p.stdout.on('data', (d: Buffer) => (out += d.toString()))
    p.on('error', () => resolve('unknown'))
    p.on('close', () => resolve(out.trim() || 'unknown'))
  })
}

/** stderr 尾部截断（spec §6.1：meta.json 尾部字段截 2KB）。 */
const STDERR_TAIL_BYTES = 2 * 1024

// ── 捕获一个场景 ────────────────────────────────────────────────────────────

interface CaptureOutcome {
  exitCode: number | null
  lineCount: number
  stderrTail: string
}

/** spawn 生产同款 argv，stdout 逐行 tee 进 raw.ndjson（原样，不改一字节）。 */
async function captureOne(
  execPath: string,
  args: string[],
  cwd: string,
  rawPath: string,
  opts: { timeoutMs: number; inactivityTimeoutMs: number },
): Promise<CaptureOutcome> {
  const proc = spawn(execPath, args, { cwd, stdio: ['ignore', 'pipe', 'pipe'] })
  const chunks: Buffer[] = []
  let stderrTail = ''
  let lineCount = 0

  return new Promise<CaptureOutcome>((resolve, reject) => {
    const timeout = setTimeout(() => {
      proc.kill('SIGKILL')
      reject(new Error(`捕获超时（${opts.timeoutMs}ms）—— CLI 无终态`))
    }, opts.timeoutMs)

    proc.stdout.on('data', (d: Buffer) => chunks.push(d))
    proc.stderr.on('data', (d: Buffer) => {
      stderrTail = (stderrTail + d.toString()).slice(-STDERR_TAIL_BYTES)
    })
    proc.on('error', (err) => {
      clearTimeout(timeout)
      reject(err)
    })
    proc.on('close', (code) => {
      clearTimeout(timeout)
      const raw = Buffer.concat(chunks)
      // 逐行计数 + 原样写出（不 trim 单行内容 —— 噪声行是被测行为）。
      lineCount = raw.toString().split('\n').filter((l) => l.trim() !== '').length
      void (async () => {
        await writeFile(rawPath, raw)
        resolve({ exitCode: code, lineCount, stderrTail })
      })().catch(reject)
    })
  })
}

// ── main ────────────────────────────────────────────────────────────────────

interface MetaJson {
  kind: string
  scenario: string
  capturedAt: string
  cliVersion: string
  model: string
  sandbox: string
  os: string
  exitCode: number | null
  lineCount: number
  prompt: string
  argv: string[]
  cwdNote: string
  stderrTail?: string
}

async function main(): Promise<number> {
  const cli = parseCliArgs(process.argv.slice(2))

  if (cli.kind !== 'codex') {
    console.error(`本捕获器当前只支持 --kind codex（收到 "${cli.kind}"）—— qwen 等按 spec 为非目标`)
    return 2
  }

  const scenarios = cli.scenario
    ? CODEX_SCENARIOS.filter((s) => s.dir === cli.scenario)
    : CODEX_SCENARIOS
  if (scenarios.length === 0) {
    console.error(`未知场景 "${cli.scenario}"。可用: ${CODEX_SCENARIOS.map((s) => s.dir).join(', ')}`)
    return 2
  }

  const execPath = process.env.CODEX_BIN ?? 'codex'
  if (!commandExists(execPath)) {
    console.error(`SKIP  codex CLI 未安装（command -v ${execPath} 落空）—— 如实跳过，不伪装。`)
    console.error(`      安装后重跑：pnpm --filter @dagents/agent-adapters capture:real`)
    return 0
  }

  const here = path.dirname(fileURLToPath(import.meta.url))
  const fixturesRoot = path.resolve(here, '../fixtures/codex')
  const version = await cliVersion(execPath)
  const sandbox = process.env.DAGENTS_CODEX_SANDBOX ?? 'full-auto'

  console.log(`codex CLI: ${execPath} (${version})`)
  console.log(`沙箱: ${sandbox} · 夹具根: ${fixturesRoot}`)
  console.log('')

  let failures = 0
  for (const s of scenarios) {
    const dir = path.join(fixturesRoot, s.dir)
    const rawPath = path.join(dir, 'raw.ndjson')
    const metaPath = path.join(dir, 'meta.json')

    if ((await exists(metaPath)) && !cli.force) {
      console.log(`SKIP  ${s.dir}（夹具已存在，--force 重建）`)
      continue
    }

    // 临时 cwd（非 git，场景 3 语义 + --skip-git-repo-check 真实生效验证）。
    const cwd = await mkdtemp(path.join(os.tmpdir(), 'dagents-codex-capture-'))
    await mkdir(dir, { recursive: true })
    try {
      const opts = { ...s.opts }
      const args = buildCodexArgs(s.prompt, opts)
      console.log(`---- 捕获 ${s.dir}（${s.category}）----`)
      console.log(`     argv: ${args.join(' ')}`)

      const outcome = await captureOne(execPath, args, cwd, rawPath, {
        timeoutMs: 5 * 60_000,
        inactivityTimeoutMs: 60_000,
      })

      const meta: MetaJson = {
        kind: 'codex',
        scenario: s.dir,
        capturedAt: new Date().toISOString(),
        cliVersion: version,
        model: s.opts.model ?? '(cli default)',
        sandbox,
        os: `${os.type()} ${os.release()}`,
        exitCode: outcome.exitCode,
        lineCount: outcome.lineCount,
        prompt: s.prompt,
        argv: args,
        cwdNote: '非 git 临时目录（--skip-git-repo-check 生效验证）',
        ...(outcome.stderrTail ? { stderrTail: outcome.stderrTail.slice(0, STDERR_TAIL_BYTES) } : {}),
      }
      await writeFile(metaPath, JSON.stringify(meta, null, 2) + '\n')

      const status = outcome.exitCode === 0 ? 'exit 0' : `exit ${outcome.exitCode}`
      console.log(`     ${status} · ${outcome.lineCount} 行 → ${path.relative(process.cwd(), rawPath)}`)
      // 失败场景（error-*）非零退出是**预期产物**，不算捕获失败；捕获失败
      // = 异常/超时/产物写不出来（上面 throw / catch 路径）。
    } catch (err) {
      failures++
      console.error(`FAIL  ${s.dir}: ${(err as Error).message}`)
      // 产物不完整即删 —— 不留半截夹具（spec §6.1）。
      await rm(dir, { recursive: true, force: true }).catch(() => {})
    } finally {
      await rm(cwd, { recursive: true, force: true }).catch(() => {})
    }
  }

  console.log('')
  if (failures > 0) {
    console.error(`捕获完成：${failures} 个场景失败`)
    return 1
  }
  console.log('捕获完成。夹具已入位 —— commit 前跑 L1 回放：pnpm --filter @dagents/agent-adapters test')
  return 0
}

main().then(
  (code) => process.exit(code),
  (err) => {
    console.error('捕获器异常退出:', err)
    process.exit(1)
  },
)
