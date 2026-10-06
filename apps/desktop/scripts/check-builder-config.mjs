#!/usr/bin/env node
/**
 * check-builder-config.mjs —— electron-builder.yml 三平台打包配置齐备性校验。
 *
 * 挂在 `test` script（vitest run && node scripts/check-builder-config.mjs），于是
 * 本机根命令与 ci.yml 的 turbo 纯检查路径都覆盖「三 target 齐备且不签名」这一
 * 验收项；mac/linux 的真实出包归 desktop.yml CI matrix（约束：本机只断言配置）。
 *
 * 零依赖：手写只覆盖本文件语法子集的 YAML 读取器（两空格缩进嵌套映射 + 短横线
 * 标量序列 + 标量值 / 整行注释），遇到解析不了的行直接 fail——宁可误杀不可漏放。
 * 用法：node scripts/check-builder-config.mjs [可选：另一份 yml 路径，供负例自检]
 */
import { existsSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const configPath =
  process.argv[2] ??
  join(dirname(fileURLToPath(import.meta.url)), '..', 'electron-builder.yml')

function parseScalar(raw) {
  const s = raw.trim()
  if (/^".*"$/.test(s) || /^'.*'$/.test(s)) return s.slice(1, -1)
  if (s === 'true') return true
  if (s === 'false') return false
  if (s === 'null' || s === '~') return null
  if (/^-?\d+$/.test(s)) return Number(s)
  return s
}

function parseYaml(text) {
  const root = {}
  const stack = [{ indent: -1, node: root }]
  const lines = text.split(/\r?\n/)
  const handleKeyLine = (rawLine, indent, ln) => {
    const m = /^([^:]+):\s*(.*)$/.exec(rawLine.trim())
    if (!m) throw new Error(`第 ${ln} 行：无法解析「${rawLine.trim()}」`)
    const [, key, rawVal] = m
    // 弹栈规则：更浅层弹出；同缩进的「序列项容器」（seqItem）即本键的归属对象，停
    while (stack.length > 1) {
      const top = stack[stack.length - 1]
      if (top.indent < indent) break
      if (top.indent === indent && top.seqItem) break
      if (top.indent >= indent) {
        stack.pop()
        continue
      }
      break
    }
    const parent = stack[stack.length - 1].node
    if (Array.isArray(parent) || typeof parent !== 'object' || parent === null) {
      throw new Error(`第 ${ln} 行：键出现在非映射上下文「${rawLine.trim()}」`)
    }
    if (rawVal === '') {
      const sentinel = { __pending: true }
      parent[key] = sentinel
      stack.push({ indent, node: sentinel, parent, key })
    } else {
      parent[key] = parseScalar(rawVal)
    }
  }
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]
    if (!line.trim() || line.trim().startsWith('#')) continue
    const ln = i + 1

    if (/^\s*-\s+/.test(line)) {
      const rest = line.replace(/^\s*-\s+/, '')
      const dashIndent = line.length - line.trimStart().length
      const restCol = line.indexOf(rest)
      while (stack.length > 1 && stack[stack.length - 1].indent > dashIndent) stack.pop()
      const ctx = stack[stack.length - 1]
      if (ctx.node && ctx.node.__pending) {
        const arr = []
        ctx.parent[ctx.key] = arr
        ctx.node = arr
      }
      if (!Array.isArray(ctx.node)) {
        throw new Error(`第 ${ln} 行：序列项出现在非序列上下文「${line.trim()}」`)
      }
      if (/^[^:#]+:\s*/.test(rest)) {
        // 映射型序列项（extraResources 的 - from:/to: 形态）：对象入列，行内首键写入，
        // 对象以 restCol 压栈并标 seqItem（同缩进后续键归入同一项，见 handleKeyLine 弹栈规则）
        const obj = {}
        ctx.node.push(obj)
        stack.push({ indent: restCol, node: obj, seqItem: true })
        const m = /^([^:]+):\s*(.*)$/.exec(rest.trim())
        if (!m) throw new Error(`第 ${ln} 行：无法解析「${rest.trim()}」`)
        const [, key, rawVal] = m
        if (rawVal === '') {
          const sentinel = { __pending: true }
          obj[key] = sentinel
          stack.push({ indent: restCol, node: sentinel, parent: obj, key })
        } else {
          obj[key] = parseScalar(rawVal)
        }
      } else {
        ctx.node.push(parseScalar(rest))
      }
      continue
    }

    const indent = line.length - line.trimStart().length
    handleKeyLine(line, indent, ln)
  }

  // 空占位哨兵归一化：key: 后既无子映射也无序列项 → 空对象；
  // 已落到子节点 → 抹掉哨兵标记保留内容（否则整个子树会被误清空）
  const normalize = (node) => {
    if (Array.isArray(node)) return node
    if (node && typeof node === 'object') {
      for (const k of Object.keys(node)) {
        const v = node[k]
        if (v && typeof v === 'object') node[k] = normalize(v)
      }
      if (node.__pending) {
        if (Object.keys(node).length === 1) return {}
        delete node.__pending
      }
    }
    return node
  }
  normalize(root)
  return root
}

const SIGNING_KEYS = [
  'certificateFile',
  'certificatePassword',
  'certificateSubjectName',
  'certificateSha1',
  'signingHashAlgorithms',
  'signtoolOptions',
  'signAndEditExecutable',
  'sign',
  'signIgnore',
  'azureSignOptions',
  'rfc3161TimeStampServer',
  'identity',
  'entitlements',
  'entitlementsInherit',
  'hardenedRuntime',
  'gatekeeperAssess',
  'notarize',
  'notarizeOptions',
  'appleId',
  'appleIdPassword',
  'appleApiKey',
  'appleApiIssuer',
  'teamId',
  'provisioningProfile',
  'forceCodeSigning',
  'cscLink',
  'cscKeyPassword',
]

const failures = []
function assert(cond, message) {
  if (!cond) failures.push(message)
}

function findSigningKeys(node, prefix, hits) {
  if (Array.isArray(node)) return
  if (node && typeof node === 'object') {
    for (const k of Object.keys(node)) {
      const path = prefix ? `${prefix}.${k}` : k
      if (SIGNING_KEYS.includes(k)) hits.push(path)
      findSigningKeys(node[k], path, hits)
    }
  }
}

let config
try {
  config = parseYaml(readFileSync(configPath, 'utf-8'))
} catch (err) {
  console.error(`✗ ${configPath} 解析失败：${err.message}`)
  process.exit(1)
}

function targetNames(v) {
  // target 可能是字符串、字符串数组、或 { target, arch } 对象数组——统一取名
  if (typeof v === 'string') return [v]
  if (Array.isArray(v)) return v.map((t) => (typeof t === 'string' ? t : t?.target))
  if (v && typeof v === 'object') return [v.target]
  return []
}

assert(
  targetNames(config.win?.target).includes('nsis'),
  'win.target 缺 nsis（Windows 安装包 target）'
)
assert(targetNames(config.mac?.target).includes('dmg'), 'mac.target 缺 dmg（macOS 安装包 target）')
assert(
  targetNames(config.linux?.target).includes('AppImage'),
  'linux.target 缺 AppImage（Linux 安装包 target）'
)
assert(
  Array.isArray(config.files) &&
    config.files.includes('dist/**') &&
    config.files.includes('package.json'),
  'files 必须只含 dist/** 与 package.json（定位 main 入口，别把 src/node_modules 打进包）'
)
// M6 服务栈入包契约：extraResources 携带内嵌 PG 与 staged 服务栈（与 stage-stack.mjs
// 产物路径同源——改名需两处同步）
const extra = config.extraResources
const extraPairs = Array.isArray(extra) ? extra.filter((e) => e && typeof e === 'object') : []
assert(
  extraPairs.some((e) => e.from === 'stage/pg/native' && e.to === 'pg/native'),
  'extraResources 缺 pg/native 条目（内嵌 PG 二进制，from=stage/pg/native）'
)
assert(
  extraPairs.some((e) => e.from === 'stage/dist-services' && e.to === 'services'),
  'extraResources 缺 services 条目（staged 服务栈，from=stage/dist-services——与 stage-stack.mjs 同源）'
)
assert(config.directories?.output === 'release', 'directories.output 必须是 release（gitignore 已覆盖）')

// U1 真实图标契约（体验规格 D1）：三平台 icon 配置 + build/ 产物在位（提交进仓库）。
// 产物由 scripts/generate-icons.mjs 确定性生成（重跑同字节），此处只断言存在与引用。
assert(config.win?.icon === 'build/icon.ico', 'win.icon 必须是 build/icon.ico（真实图标，非 Electron 默认）')
assert(config.mac?.icon === 'build/icon.icns', 'mac.icon 必须是 build/icon.icns')
assert(config.linux?.icon === 'build/icon.png', 'linux.icon 必须是 build/icon.png（≥512）')
const buildDir = join(dirname(configPath), 'build')
for (const f of ['icon.ico', 'icon.icns', 'icon.png']) {
  assert(existsSync(join(buildDir, f)), `build/${f} 缺失——先跑 pnpm --filter @dagents/desktop icons（产物应提交进仓库）`)
}

const signingHits = []
findSigningKeys(config, '', signingHits)
assert(signingHits.length === 0, `发现签名相关配置（本设计全部不签名）：${signingHits.join(', ')}`)

if (failures.length > 0) {
  console.error(`✗ electron-builder.yml 配置校验未过（${configPath}）：`)
  for (const f of failures) console.error(`  - ${f}`)
  process.exit(1)
}

console.log('✓ electron-builder.yml：win nsis / mac dmg / linux AppImage 三 target 齐备，无签名配置')
