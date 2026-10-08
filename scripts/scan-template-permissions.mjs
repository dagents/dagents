#!/usr/bin/env node
/**
 * scan-template-permissions —— R4 AC-R4-6 的清点仪器（2026-10-07）。
 *
 * 扫描两处模板源的权限声明缺席情况并输出报告：
 *   1. 内置 JSON 模板（apps/gateway/src/flow-templates/builtin/*.json）；
 *   2. flow_templates 表（用户/团队保存的模板，需 POSTGRES_URL 指向目标库；
 *      未配置或库不可达时该部分跳过并标注，不算扫描失败）。
 *
 * 退出码语义（2026-10-08 OQ-4 终裁后升级为 CI 阻断层——验收遗留 #4）：
 *   - 0 = 扫描完成且**内置模板零缺席/零非法**（内置 JSON 归仓库管，随
 *     DAGENTS_HTTP_DOMAIN_POLICY=enforce 默认生效，缺席即 CI fail）；
 *     flow_templates 表（用户数据）的缺席仅报告不阻断——自动改写用户数据
 *     是臆测语义，补声明留给模板作者/实例化后的画布；
 *   - 1 = 内置模板存在缺席/非法声明，或扫描本身失败（JSON 解析错误 /
 *     内置目录不可读）。
 *
 * 判定规则与 @dagents/workflow utils/flow-permissions.ts 同源语义
 * （此处为脚本内镜像实现，避免 node 裸跑 TS 包）：
 *   - httpAgentflow 节点：allowedDomains 缺席（absent）→ 报缺席；invalid → 报非法；
 *   - customFunctionAgentflow 节点：代码含 $exec 且 allowedCommands absent → 报缺席。
 */

import { readFileSync, readdirSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const repoRoot = join(here, '..')
const BUILTIN_DIR = join(repoRoot, 'apps/gateway/src/flow-templates/builtin')

const HTTP_TYPE = 'httpAgentflow'
const CUSTOM_FN_TYPE = 'customFunctionAgentflow'

/** 双形态归一读（与 executor merge 同规则：嵌套 data.inputs 覆盖平铺）。 */
function readField(node, key) {
  const flat = node?.data ?? {}
  const nested = flat.inputs
  if (nested && typeof nested === 'object' && !Array.isArray(nested)) {
    const v = nested[key]
    if (v !== undefined) return v
  }
  return flat[key]
}

function resolveKind(node) {
  const fromData = node?.data?.name
  if (typeof fromData === 'string' && fromData.length > 0) return fromData
  return typeof node?.type === 'string' ? node.type : undefined
}

/** 声明状态：absent / declared / invalid（镜像 flow-permissions 语义阶梯）。 */
function permState(raw) {
  if (raw === undefined || raw === null) return { kind: 'absent' }
  if (typeof raw === 'string')
    return raw.trim() === '' ? { kind: 'absent' } : { kind: 'invalid', reason: '非空字符串' }
  if (!Array.isArray(raw)) return { kind: 'invalid', reason: '非数组' }
  for (const entry of raw) {
    if (typeof entry !== 'string' || entry.trim() === '')
      return { kind: 'invalid', reason: '含非字符串/空白条目' }
  }
  return { kind: 'declared', values: raw }
}

/** 扫描单个 flowData，返回问题清单（空数组 = 干净）。 */
function scanFlow(source, label, flowData) {
  const problems = []
  const nodes = Array.isArray(flowData?.nodes) ? flowData.nodes : []
  for (const node of nodes) {
    const kind = resolveKind(node)
    if (kind === HTTP_TYPE) {
      const state = permState(readField(node, 'allowedDomains'))
      if (state.kind === 'absent') {
        problems.push(
          `${label} · 节点 ${node.id}：http 节点未声明 allowedDomains（enforce 策略下拒跑——补域名清单声明）`,
        )
      } else if (state.kind === 'invalid') {
        problems.push(
          `${label} · 节点 ${node.id}：allowedDomains 非法（${state.reason}）——运行时 deny-all`,
        )
      }
    } else if (kind === CUSTOM_FN_TYPE) {
      const state = permState(readField(node, 'allowedCommands'))
      const code = String(readField(node, 'functionCode') ?? readField(node, 'code') ?? '')
      if (code.includes('$exec') && state.kind !== 'declared') {
        problems.push(
          `${label} · 节点 ${node.id}：代码使用 $exec 但 allowedCommands ${state.kind === 'invalid' ? '非法' : '未声明'}——运行时 $exec 不可用`,
        )
      } else if (state.kind === 'invalid') {
        problems.push(
          `${label} · 节点 ${node.id}：allowedCommands 非法（${state.reason}）——运行时 $exec 全拒`,
        )
      }
    }
  }
  return problems
}

// ── 1. 内置 JSON 模板 ────────────────────────────────────────────────────

let failed = false
const builtinProblems = []
const dbProblems = []

try {
  const files = readdirSync(BUILTIN_DIR).filter((f) => f.endsWith('.json'))
  for (const file of files) {
    const raw = readFileSync(join(BUILTIN_DIR, file), 'utf8')
    let parsed
    try {
      parsed = JSON.parse(raw)
    } catch (err) {
      console.error(`✗ 内置模板 JSON 解析失败：${file} — ${err.message}`)
      failed = true
      continue
    }
    const flowData = parsed?.flowData ?? parsed
    builtinProblems.push(...scanFlow('builtin', `builtin/${file.replace(/\.json$/, '')}`, flowData))
  }
  console.log(`内置模板：扫描 ${files.length} 个文件`)
} catch (err) {
  console.error(`✗ 内置模板目录不可读：${BUILTIN_DIR} — ${err.message}`)
  failed = true
}

// ── 2. flow_templates 表（POSTGRES_URL 可选）────────────────────────────

const pgUrl = process.env.POSTGRES_URL
if (!pgUrl) {
  console.log('flow_templates 表：跳过（未设 POSTGRES_URL）')
} else {
  try {
    const { Client } = await import('pg')
    const client = new Client({ connectionString: pgUrl })
    await client.connect()
    const { rows } = await client.query(
      `SELECT id, name, flow_data FROM flow_templates ORDER BY created_at DESC`,
    )
    for (const row of rows) {
      let flowData = row.flow_data
      if (typeof flowData === 'string') {
        try {
          flowData = JSON.parse(flowData)
        } catch {
          console.error(`✗ flow_templates ${row.id}（${row.name}）flow_data JSON 解析失败`)
          failed = true
          continue
        }
      }
      dbProblems.push(...scanFlow('flow_templates', `模板「${row.name}」(${row.id})`, flowData))
    }
    console.log(`flow_templates 表：扫描 ${rows.length} 行`)
    await client.end()
  } catch (err) {
    // 库不可达不算扫描失败（清点仪器对 dev 库缺席应保持可用）
    console.log(`flow_templates 表：跳过（库不可达：${err.message.split('\n')[0]}）`)
  }
}

// ── 报告 ────────────────────────────────────────────────────────────────

// 内置模板 = 仓库资产：缺席/非法即 CI 阻断（OQ-4 终裁，enforce 已默认生效）
if (builtinProblems.length > 0) {
  console.error(`\n✗ 内置模板缺席/非法声明 ${builtinProblems.length} 处（CI 阻断——内置模板必须全量声明）：`)
  for (const p of builtinProblems) console.error(`  ✗ ${p}`)
  failed = true
} else {
  console.log('内置模板：零缺席/零非法（CI 阻断层通过）')
}

// flow_templates 表 = 用户数据：报告不阻断（补声明留给模板作者/画布）
if (dbProblems.length > 0) {
  console.log(`\nflow_templates 缺席/非法声明 ${dbProblems.length} 处（用户数据，报告不阻断）：`)
  for (const p of dbProblems) console.log(`  ⚠ ${p}`)
}

process.exit(failed ? 1 : 0)
