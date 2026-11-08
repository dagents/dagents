/**
 * flow-permissions —— R4 声明式权限闭环的读 / 验 / 判 / 投影单源
 * （docs/zcode-borrow/design-permission.md §2.3）。
 *
 * 全仓权限语义只此一份实现，四类消费点全部 import 此处：
 *   1. 拓扑校验器（validate-topology.ts：声明非法 → error 带 node 定位）
 *   2. http 节点运行时守卫（http.node.ts：域名逐跳复检）
 *   3. customFunction 节点（custom-function.node.ts：$exec 白名单持有方）
 *   4. console 运行前确认面 + gateway preflight（extractFlowPermissions 投影）
 *
 * 安全立场（fail-closed）：
 *   - 缺席（undefined/null/空白串）= 通道不存在 —— 与现状零命令能力兼容；
 *   - `[]` = declared-empty = 显式声明空集 = 全拒（不是「当作未声明」）；
 *   - invalid（非数组 / 含非法条目 / 超限）= deny-all，与策略无关——
 *     恶意者把声明写成垃圾形状不能被当成「未声明」享受过渡期放行，
 *     这是封死「改一道 JSON 绕过」的运行时不变量。
 */

import type { FlowNode } from '../types/flow.js'
// 循环 import 说明：本模块与 validate-topology.ts 互相引用（后者运行时引
// 本模块的 validatePermissionDeclarations，本模块引其 resolveNodeType）。
// 两者均只在函数体内调用对方（函数声明提升，无顶层求值），ESM 循环安全；
// TopologyError 仅 import type（编译期擦除，零运行时环）。
import type { TopologyError } from './validate-topology.js'
import { resolveNodeType } from './validate-topology.js'
// 拒绝档词汇（集成裁决 2026-10-08：R4 白名单拒绝按 workflow-engine.md
// 「上限与失败语义对照表」的「节点拒绝」档对齐）——抛 NodeRejectedError，
// executor 管道据此落 span 'rejected' + isolateFailure → run partial_success。
// errors.ts 零依赖，不进本模块与 validate-topology 的既有循环。
import { NodeRejectedError } from '../engine/errors.js'

// ─── 共享词面（AC-R4-4「同源常量」的物理载体）───────────────────────────

export const PERMISSION_FIELDS = {
  command: 'allowedCommands',
  domain: 'allowedDomains',
} as const

export type PermissionField = (typeof PERMISSION_FIELDS)[keyof typeof PERMISSION_FIELDS]

// ─── 上限常量（防千条目清单；超限 → invalid → 拓扑 error + 运行时全拒）───

export const MAX_DOMAINS_PER_NODE = 32
export const MAX_COMMANDS_PER_NODE = 16
export const MAX_DOMAIN_ENTRY_LEN = 253 // RFC 1123 hostname 上限
export const MAX_COMMAND_ENTRY_LEN = 64 // 正则 {0,63} + 首字符

// ─── 条目格式 ──────────────────────────────────────────────────────────

const HOSTNAME_LABEL_RE = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/i

const IPV4_RE = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/

/** IPv6 字面量（裸写或带方括号）：仅 hex/冒号 + 至少两个冒号（区分 host:port）。 */
function isIpv6Literal(s: string): boolean {
  const bare = s.replace(/^\[|\]$/g, '')
  if (!/^[0-9a-f:.]+$/i.test(bare)) return false
  return (bare.match(/:/g) ?? []).length >= 2
}

/**
 * 域名条目格式：RFC 1123 hostname 或 IP 字面量，1-253 字符。
 * 禁 port/scheme/path/通配符（v1 无 `*.example.com`——通配符属 v2 扩展，
 * 届时回设计修订）。精确匹配是闭集语义。
 */
export function isValidDomainEntry(s: string): boolean {
  if (typeof s !== 'string' || s.length === 0 || s.length > MAX_DOMAIN_ENTRY_LEN) return false
  if (s !== s.trim()) return false // 前后空白 = 手滑，fail-closed 拒收
  if (s.includes('/') || s.includes('*') || s.includes('?') || s.includes('#')) return false
  if (s.includes(':')) return isIpv6Literal(s) // 唯一合法含冒号形态是 IPv6 字面量
  const ipv4 = IPV4_RE.exec(s)
  if (ipv4) return ipv4.slice(1).every((o) => Number(o) <= 255)
  if (/^\d+\.\d+\.\d+$/.test(s)) return false // 残缺 IPv4 形态（123.1.2）
  if (!s.includes('.')) return false // v1 要求 FQDN 或 IP 字面量（禁裸 'localhost' 类单标签）
  return s.split('.').every((label) => HOSTNAME_LABEL_RE.test(label))
}

const COMMAND_ENTRY_RE = /^[A-Za-z0-9][A-Za-z0-9._@:+-]{0,63}$/

/**
 * 命令条目格式：裸命令名（如 git / rg / docker）。禁路径分隔符 `/` `\`、
 * 禁空白——v1 不支持绝对路径白名单（PATH 解析语义由 resolveCliExecutable
 * 提供、模板可移植、白名单不绑定机器路径）。子命令属 args
 * （`docker compose` → 声明 `docker`）。
 */
export function isValidCommandEntry(s: string): boolean {
  if (typeof s !== 'string') return false
  return COMMAND_ENTRY_RE.test(s)
}

// ─── 声明读取与解析（语义阶梯）────────────────────────────────────────

export type NodePermissionState =
  { kind: 'absent' } | { kind: 'declared'; values: string[] } | { kind: 'invalid'; reason: string }

/**
 * 双形态归一读节点声明（嵌套 `data.inputs.<field>` 覆盖平铺 `data.<field>`）
 * —— 与 executor 的 mergedNodeInputs 同规则（executor.ts）、与
 * resolveAgentId / extractHumanInputPrompts 的 read 同款。
 */
export function readNodePermission(node: FlowNode, field: PermissionField): NodePermissionState {
  const flat = (node.data ?? {}) as Record<string, unknown>
  const nested = flat.inputs
  const raw =
    nested && typeof nested === 'object' && !Array.isArray(nested)
      ? ((nested as Record<string, unknown>)[field] ?? flat[field])
      : flat[field]
  return parsePermissionValue(raw, field)
}

/**
 * 解析声明值（http/customFunction 节点运行时守卫入口：executor 已把双形态
 * merge 进 nodeData.inputs，节点侧直接喂 merged 值，与 readNodePermission
 * 同一阶梯同一单源）。
 */
export function parsePermissionValue(raw: unknown, field: PermissionField): NodePermissionState {
  if (raw === undefined || raw === null) return { kind: 'absent' }
  if (typeof raw === 'string') {
    if (raw.trim() === '') return { kind: 'absent' } // '' / 空白串 = 未声明
    return {
      kind: 'invalid',
      reason: `应为字符串数组（如 ${
        field === PERMISSION_FIELDS.domain ? '["api.github.com"]' : '["git","rg"]'
      }），实际是非空字符串：${JSON.stringify(raw.slice(0, 60))}`,
    }
  }
  if (!Array.isArray(raw)) {
    return { kind: 'invalid', reason: `应为字符串数组，实际是 ${describeType(raw)}` }
  }
  const isDomain = field === PERMISSION_FIELDS.domain
  const maxEntries = isDomain ? MAX_DOMAINS_PER_NODE : MAX_COMMANDS_PER_NODE
  const maxLen = isDomain ? MAX_DOMAIN_ENTRY_LEN : MAX_COMMAND_ENTRY_LEN
  if (raw.length > maxEntries) {
    return { kind: 'invalid', reason: `条目数 ${raw.length} 超过上限 ${maxEntries}` }
  }
  const values: string[] = []
  for (const entry of raw) {
    if (typeof entry !== 'string') {
      return { kind: 'invalid', reason: `条目应为字符串，实际是 ${describeType(entry)}` }
    }
    if (entry.length === 0 || entry.length > maxLen) {
      return {
        kind: 'invalid',
        reason: `条目长度须在 1-${maxLen} 之间，实际 ${entry.length}：${JSON.stringify(entry.slice(0, 40))}`,
      }
    }
    if (isDomain ? !isValidDomainEntry(entry) : !isValidCommandEntry(entry)) {
      return {
        kind: 'invalid',
        reason: isDomain
          ? `条目 ${JSON.stringify(entry.slice(0, 60))} 不是合法 hostname/IP（禁 port、scheme、路径与通配符）`
          : `条目 ${JSON.stringify(entry.slice(0, 60))} 不是合法裸命令名（仅字母数字开头，可用 ._@:+- ，禁路径分隔符与空白）`,
      }
    }
    values.push(entry)
  }
  // `[]` → declared-empty（显式空集 = 全拒），不是 absent
  return { kind: 'declared', values }
}

function describeType(v: unknown): string {
  if (v === null) return 'null'
  if (Array.isArray(v)) return 'array'
  return typeof v
}

// ─── 域名判定 ──────────────────────────────────────────────────────────

/** hostname 是否在清单内（小写化精确匹配；IPv6 方括号归一）。 */
export function isDomainAllowed(hostname: string, values: string[]): boolean {
  const norm = (h: string): string => h.toLowerCase().replace(/^\[|\]$/g, '')
  const target = norm(hostname)
  return values.some((v) => norm(v) === target)
}

// ─── 网关策略 ──────────────────────────────────────────────────────────

export type HttpDomainPolicy = 'warn' | 'enforce' | 'off'

/**
 * http 域名策略开关：现读 `DAGENTS_HTTP_DOMAIN_POLICY`，**默认 `'enforce'`**
 * （2026-10-08 OQ-4 终裁，版本线裁决：enforce 随 R4 批次同版发布——模板中心
 * 与生成器产物已全量带声明、错误信息自带补声明指引；存量用户流程的迁移
 * 逃生门 = 显式设 `'warn'`（缺席放行 + 黄警留痕）或 `'off'`）。未知值回落
 * 默认 enforce（env 是运维旋钮非攻击面，回落取更严一侧；先例 ssrf-guard
 * 的 privateHttpAllowed 同为现读 env）。
 */
export function httpDomainPolicy(): HttpDomainPolicy {
  const raw = process.env.DAGENTS_HTTP_DOMAIN_POLICY
  return raw === 'warn' || raw === 'off' ? raw : 'enforce'
}

// ─── http 节点运行时守卫（判定表见设计 §2.3）──────────────────────────

export interface AssertDomainOptions {
  /** warn 期缺席放行的留痕回调（节点侧接 onNodeDelta，NFR-6 不静默）。 */
  onWarn?: (message: string) => void
}

/**
 * http 节点域名守卫：协议/SSRF 校验之后、fetch 之前调用（首跳与每一跳
 * 重定向同款）。declared-but-violated 在任何策略下都拒绝；invalid 一律
 * deny-all；off 跳过本守卫（SSRF 仍生效）。
 */
export function assertAllowedHttpDomain(
  url: URL,
  perm: NodePermissionState,
  what: string,
  opts: AssertDomainOptions = {},
): void {
  const policy = httpDomainPolicy()
  if (policy === 'off') return
  if (perm.kind === 'invalid') {
    throw new NodeRejectedError(
      `节点被拒绝：${what}：allowedDomains 声明非法（${perm.reason}）——修复格式；修复前本节点所有请求都被拒绝`,
    )
  }
  if (perm.kind === 'declared') {
    const host = url.hostname.toLowerCase()
    if (isDomainAllowed(host, perm.values)) return
    throw new NodeRejectedError(
      `节点被拒绝：${what}：目标域名 ${host} 未在 allowedDomains 声明（已声明：${perm.values.join(', ')}）` +
        `——在节点配置「域名清单」补充后重试`,
    )
  }
  // absent
  if (policy === 'enforce') {
    throw new NodeRejectedError(
      `节点被拒绝：${what}：未声明 allowedDomains（网关已启用 enforce 策略）——在节点配置中声明域名清单，格式 ["api.github.com"]`,
    )
  }
  opts.onWarn?.(`域名清单未声明（warn 策略放行——enforce 默认下会拒跑，建议补声明）: ${url.hostname.toLowerCase()}`)
}

// ─── 全图投影（确认面 / gateway preflight / 审计共用）─────────────────

export interface FlowCommandNodeSummary {
  nodeId: string
  label: string
  commands: string[]
}

export interface FlowDomainNodeSummary {
  nodeId: string
  label: string
  domains: string[]
  /** 节点配置的静态 URL 原文（含模板变量时由 UI 标注「运行时裁决」）。 */
  url?: string
}

export interface FlowPermissionProjection {
  commandNodes: FlowCommandNodeSummary[]
  domainNodes: FlowDomainNodeSummary[]
  /** 未声明 allowedDomains 的 http 节点 id（warn 期放行 + 黄警；enforce 拒跑）。 */
  undeclaredHttp: string[]
  /** 非法声明（与 validatePermissionDeclarations 同源产出）。 */
  invalid: TopologyError[]
  /** 图内存在 executeFlow 节点（子流程）——确认面据此标注「子流程声明以子流程画布为准」。 */
  hasSubflow: boolean
}

// 循环 import 说明：本模块与 validate-topology.ts 互相引用（后者运行时引
// validatePermissionDeclarations，本模块引其 resolveNodeType）。两者均只在
// 函数体内调用对方（函数声明提升），ESM 循环安全；类型仅 import type。

const HTTP_TYPE = 'httpAgentflow'
const CUSTOM_FN_TYPE = 'customFunctionAgentflow'

/** 读取节点的展示 label（与 gateway nodeLabelById 同规则：label ?? id）。 */
function nodeLabel(node: FlowNode): string {
  const label = (node.data as { label?: unknown } | undefined)?.label
  return typeof label === 'string' && label.length > 0 ? label : node.id
}

/**
 * 全图权限投影：逐节点 readNodePermission（同源），聚合出闭合命令集 /
 * 闭合域名集 / 缺席 http 清单 / 非法声明。console 确认面说的和执行层
 * 放行的是同一集合（AC-R4-4）。
 */
export function extractFlowPermissions(flowData: unknown): FlowPermissionProjection {
  const out: FlowPermissionProjection = {
    commandNodes: [],
    domainNodes: [],
    undeclaredHttp: [],
    invalid: [],
    hasSubflow: false,
  }
  const nodes = (flowData as { nodes?: unknown } | null | undefined)?.nodes
  if (!Array.isArray(nodes)) return out
  for (const n of nodes) {
    if (!n || typeof n !== 'object') continue
    const node = n as FlowNode
    if (typeof node.id !== 'string') continue
    const type = resolveNodeType(node)
    if (type === 'executeFlowAgentflow') out.hasSubflow = true
    if (type === HTTP_TYPE) {
      const perm = readNodePermission(node, PERMISSION_FIELDS.domain)
      if (perm.kind === 'invalid') {
        out.invalid.push({
          node: node.id,
          message: `节点 "${node.id}" 的 allowedDomains 声明非法：${perm.reason}`,
        })
        continue
      }
      if (perm.kind === 'declared') {
        const urlRaw = readFlatOrNested(node, 'url')
        out.domainNodes.push({
          nodeId: node.id,
          label: nodeLabel(node),
          domains: perm.values,
          ...(typeof urlRaw === 'string' && urlRaw.length > 0 ? { url: urlRaw } : {}),
        })
      } else {
        out.undeclaredHttp.push(node.id)
      }
    } else if (type === CUSTOM_FN_TYPE) {
      const perm = readNodePermission(node, PERMISSION_FIELDS.command)
      if (perm.kind === 'invalid') {
        out.invalid.push({
          node: node.id,
          message: `节点 "${node.id}" 的 allowedCommands 声明非法：${perm.reason}`,
        })
      } else if (perm.kind === 'declared') {
        out.commandNodes.push({ nodeId: node.id, label: nodeLabel(node), commands: perm.values })
      }
      // absent = 通道不存在 = 与现状零命令能力一致，无需投影
    }
  }
  return out
}

/** 双形态读任意字段（与 readNodePermission 同规则，非权限字段用）。 */
function readFlatOrNested(node: FlowNode, key: string): unknown {
  const flat = (node.data ?? {}) as Record<string, unknown>
  const nested = flat.inputs
  if (nested && typeof nested === 'object' && !Array.isArray(nested)) {
    const v = (nested as Record<string, unknown>)[key]
    if (v !== undefined) return v
  }
  return flat[key]
}

// ─── 拓扑校验产出（validateFlowTopology 内部调用 + gateway 保存/运行门）──

/**
 * 声明合法性 → TopologyError[]（带 node 定位）。只判 invalid（非法声明
 * 不可执行，error 级）；absent/declared 都合法——缺席策略由运行期网关
 * 策略裁决（warn/enforce/off），校验器不越权。
 */
export function validatePermissionDeclarations(flowData: unknown): TopologyError[] {
  const errors: TopologyError[] = []
  const nodes = (flowData as { nodes?: unknown } | null | undefined)?.nodes
  if (!Array.isArray(nodes)) return errors
  for (const n of nodes) {
    if (!n || typeof n !== 'object') continue
    const node = n as FlowNode
    if (typeof node.id !== 'string') continue
    const type = resolveNodeType(node)
    const field: PermissionField | undefined =
      type === HTTP_TYPE
        ? PERMISSION_FIELDS.domain
        : type === CUSTOM_FN_TYPE
          ? PERMISSION_FIELDS.command
          : undefined
    if (!field) continue
    const perm = readNodePermission(node, field)
    if (perm.kind === 'invalid') {
      errors.push({
        node: node.id,
        message: `节点 "${node.id}" 的 ${field} 声明非法：${perm.reason}（正确格式：${
          field === PERMISSION_FIELDS.domain ? '["api.github.com"]' : '["git","rg"]'
        }）`,
      })
    }
  }
  return errors
}
