#!/usr/bin/env node
/**
 * stage-stack.mjs —— 服务栈 staging（M6，docs/desktop-architecture.md §11.2–§11.4）。
 *
 * 产物（electron-builder extraResources 的直接来源）：
 *   stage/services/gateway/   pnpm deploy --prod --legacy 树（裁掉 src/tsconfig/vitest）
 *   stage/services/console/   Next standalone 三件套镜像树
 *     ├─ apps/console/.next-build/server.js        （standalone 树，入口）
 *     ├─ apps/console/.next-build/static/          （.next-build/static 摆到 server.js 旁）
 *     ├─ apps/console/public/
 *     ├─ packages/ node_modules/ package.json      （standalone 镜像 repo 布局自带）
 *   （stage/pg/native 由 ensure-postgres.mjs 产出，本脚本只做前置检查）
 *
 * 已知门（docs §11.3/R11）：win 本机无开发者模式时 Next copyTracedFiles 的
 * symlink 复建 EPERM——仓库以 pnpm patch（patches/next@15.5.20.patch）落了
 * win32+EPERM → junction/复制的兜底；本脚本仍检测 EPERM 输出并给出指引后非零退
 * （patch 未生效/未安装的场景）。CI linux/mac 无此问题。
 *
 * 本机 ~/.npmrc 失效代理（proxy=127.0.0.1:7890）：自动把用户 npmrc 过滤 proxy 行
 * 后经 NPM_CONFIG_USERCONFIG 注入（CI 无 ~/.npmrc，零影响）——M5 §16 #7 的
 * HOME 隔离在 win 的正确形态。
 */
import { spawnSync } from 'node:child_process'
import {
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

const pkgRoot = join(dirname(fileURLToPath(import.meta.url)), '..')
const repoRoot = join(pkgRoot, '..', '..')
const stageDir = join(pkgRoot, 'stage')
// 注意：staging 根名是 dist-services——本机曾因系统进程锁死旧 services/ 空目录壳
// （EBUSY 对删除/改名/rename 进内容全部免疫）整链绕道换名；electron-builder
// extraResources 的 from 与此处同源，改动需两处同步。
const servicesDir = join(stageDir, 'dist-services')

const DIST_DIR = process.env.NEXT_DIST_DIR || '.next-build'
const IS_LINUX = process.platform === 'linux'

function say(msg) {
  console.log(`[stage-stack] ${msg}`)
}
function fail(msg) {
  console.error(`[stage-stack] ✗ ${msg}`)
  process.exit(1)
}

/** 相对 repoRoot 的路径（spawn cwd=repoRoot，pnpm deploy 目标以相对路径最稳）。 */
function relativeFromRepo(p) {
  return p.slice(repoRoot.length + 1).split('\\').join('/')
}

function run(cmd, args, opts = {}) {
  say(`$ ${cmd} ${args.join(' ')}`)
  // win：pnpm 是 .cmd shim，Node spawn 不解析（须 shell）；POSIX 原生直跑
  const res = spawnSync(cmd, args, {
    cwd: repoRoot,
    stdio: ['ignore', 'pipe', 'pipe'],
    encoding: 'utf8',
    shell: process.platform === 'win32',
    ...opts,
  })
  if (res.error) {
    console.error(`[stage-stack] spawn 失败：${res.error.message}`)
  }
  if (res.stdout) process.stdout.write(res.stdout)
  if (res.stderr) process.stderr.write(res.stderr)
  return res
}

/**
 * pnpm → npm 平铺规整（in-place，全链实体化）：
 *   node_modules/.pnpm/<entry>/node_modules/<pkg> → node_modules/<pkg>（scoped 展开）
 * 关键背景（M6 实测）：pnpm 的 .pnpm 布局靠 junction/symlink 活着，而分发链
 * （cpSync → electron-builder → NSIS 安装）逐层 deref/丢弃链接——deref 后包从实体
 * 位置向上 resolve 不到 .pnpm 里的同胞依赖（packaged 安装树 Cannot find module
 * 'styled-jsx' 实证）。对策：顶层统一为实体，随后删 .pnpm。
 * 链接处理：dest 是链接 → 其目标即实体，O(1) move 实体替换（同卷 rename，无膨胀）；
 * src 是链接 → deref 拷贝。同名实体冲突保留首个并告警（traced 闭包内版本收敛）。
 */
function flattenPnpmToTopLevel(nodeModulesDir) {
  const pnpmDir = join(nodeModulesDir, '.pnpm')
  if (!existsSync(pnpmDir)) return
  const moved = []
  const conflicts = []
  for (const entry of readdirSync(pnpmDir)) {
    const inner = join(pnpmDir, entry, 'node_modules')
    if (!existsSync(inner)) continue
    for (const name of readdirSync(inner)) {
      if (name.startsWith('.')) continue
      const scopeDir = join(inner, name)
      if (name.startsWith('@')) {
        for (const pkg of existsSync(scopeDir) ? readdirSync(scopeDir) : []) {
          if (pkg.startsWith('.')) continue
          hoist(join(scopeDir, pkg), join(nodeModulesDir, name, pkg), `${name}/${pkg}`, moved, conflicts)
        }
      } else {
        hoist(scopeDir, join(nodeModulesDir, name), name, moved, conflicts)
      }
    }
  }
  rmSync(pnpmDir, { recursive: true, force: true })
  say(
    `pnpm 平铺规整 ${nodeModulesDir}：实体化 ${moved.length} 包` +
      (conflicts.length > 0 ? `，同名保留首个 ${conflicts.length} 处` : '')
  )
}

function isLink(p) {
  try {
    return lstatSync(p).isSymbolicLink()
  } catch {
    return false
  }
}

/** 自检：顶层残留死链（isSymbolicLink 且目标不存在）——分发链不容死链。 */
function assertNoDeadLinks(nodeModulesDir, label) {
  const dead = []
  const walk = (dir) => {
    for (const name of readdirSync(dir)) {
      if (name.startsWith('.')) continue
      const p = join(dir, name)
      if (isLink(p)) {
        if (!existsSync(p)) dead.push(p)
      } else {
        try {
          if (lstatSync(p).isDirectory()) walk(p)
        } catch {
          // 不可读跳过
        }
      }
    }
  }
  walk(nodeModulesDir)
  if (dead.length > 0) {
    fail(
      `${label} 平铺后残留 ${dead.length} 个死链（示例 ${dead.slice(0, 3).join('; ')}）——分发链（NSIS）不容死链`
    )
  }
}

/**
 * 逃逸符号链接/工作区自引用清扫（2026-10-07 CI win 打包三连败根因，M6 后补）：
 * pnpm deploy --legacy 在 link-workspace-packages=deep 下会把 file: 工作区依赖以嵌套
 * 落位泄漏进 deploy 树——node_modules/@dagents/<pkg>/node_modules/@dagents/<pkg2>，形态
 * 有二：绝对符号链接（指向 <repoRoot>/packages/*）或实体目录（连带 dev node_modules，
 * 实测 310MB：@dagents 各包的 node_modules 里含 tsup/typescript/@opentelemetry 等 dev 依赖）。
 * 本机构建时 electron-builder extraResources 把它们整体 deref 进安装包（dev 状态泄漏
 * +产物膨胀）；CI runner 上工作区 node_modules 的部分链接悬空 → 拷进 win-unpacked 后
 * 7za 报 "The system cannot find the path" exit 1。
 * 对策：两种形态一律删除——顶层 node_modules/@dagents/* 已是 deploy 的 prod 实体拷贝，
 * node 解析自动回退顶层（语义更正确，产物更小）；其余逃逸链接（今日无此形态）deref
 * 实体化兜底。
 */
function sweepEscapingLinks(rootDir, label) {
  let removedLinks = 0
  let removedDirs = 0
  let materialized = 0
  const selfRef = /node_modules[\\/]@dagents[\\/][^\\/]+[\\/]node_modules[\\/]@dagents[\\/][^\\/]+$/
  const walk = (dir) => {
    for (const name of readdirSync(dir)) {
      if (name.startsWith('.')) continue
      const p = join(dir, name)
      if (isLink(p)) {
        const target = resolve(dirname(p), readlinkSync(p))
        if (target.startsWith(rootDir + sep)) continue // 树内链接（平铺残留，分发链自会 deref）
        // 工作区泄漏链接（自引用形状，或目标在仓库内）直接删除——顶层 node_modules/@dagents/*
        // 已是 deploy 的 prod 实体拷贝，解析自动回退；不 deref（CI runner 上工作区链接
        // 的深层目标可能悬空，deref 拷贝会炸）
        if (selfRef.test(p) || target.startsWith(repoRoot + sep)) {
          rmSync(p, { force: true })
          removedLinks++
          continue
        }
        // 其余逃逸链接（今日无此形态）：deref 实体化兜底，并继续清扫实体化结果内部
        const tmp = p + '.materializing'
        cpSync(p, tmp, { recursive: true, dereference: true })
        rmSync(p, { force: true })
        renameSync(tmp, p)
        materialized++
        walk(p)
        continue
      }
      if (selfRef.test(p)) {
        rmSync(p, { recursive: true, force: true })
        removedDirs++
        continue
      }
      try {
        if (lstatSync(p).isDirectory()) walk(p)
      } catch {
        // 不可读跳过
      }
    }
  }
  walk(rootDir)
  if (removedLinks || removedDirs || materialized) {
    say(
      `${label} 逃逸链接清扫：删除工作区自引用链接 ${removedLinks} 个、自引用目录 ${removedDirs} 个` +
        (materialized ? `，实体化逃逸链接 ${materialized} 个` : '')
    )
  }
}

function hoist(src, dest, label, moved, conflicts) {
  const destExisted = existsSync(dest)
  if (destExisted || isLink(dest)) {
    if (isLink(dest)) {
      // 顶层链接（pnpm 布局常态）：其目标即实体——move 实体替换链接（O(1) 无膨胀）
      try {
        const abs = resolve(dirname(dest), readlinkSync(dest))
        rmSync(dest)
        if (existsSync(abs)) {
          renameSync(abs, dest)
          moved.push(label)
          return
        }
      } catch {
        // 链接目标已被先前的 move 拿走（多 entry 指向同一实体）——dest 已空，落下方提升
      }
    } else {
      conflicts.push(label)
      return
    }
  }
  mkdirSync(dirname(dest), { recursive: true })
  try {
    if (isLink(src)) cpSync(src, dest, { recursive: true }) // deref 实体化
    else renameSync(src, dest) // 同卷 O(1)
    moved.push(label)
  } catch {
    // src 实体已被先前的顶层替换 move 拿走——本 entry 的引用自然失效（.pnpm 终将删除）
  }
}

/**
 * 用户 npmrc 的失效本地代理探测（本机网络条件，docs §16 环境注记）：
 * 有 proxy=127.0.0.1（或 localhost）行 → 过滤 proxy/https-proxy 行写临时文件，
 * 经 NPM_CONFIG_USERCONFIG 注入（保留 registry/镜像配置，不动 pnpm store）。
 */
function pnpmEnv() {
  const env = { ...process.env }
  const userNpmrc = join(process.env.USERPROFILE || process.env.HOME || '', '.npmrc')
  try {
    if (!existsSync(userNpmrc)) return env
    const text = readFileSync(userNpmrc, 'utf8')
    const proxyBroken = /^proxy\s*=\s*https?:\/\/(127\.0\.0\.1|localhost)(:\d+)?\s*$/m.test(text)
    if (!proxyBroken) return env
    const filtered = text
      .split(/\r?\n/)
      .filter((l) => !/^(proxy|https-proxy)\s*=/i.test(l.trim()))
      .join('\n')
    const stub = join(mkdtempSync(join(tmpdir(), 'dagents-npmrc-')), 'npmrc')
    writeFileSync(stub, filtered)
    env.NPM_CONFIG_USERCONFIG = stub
    say(`检测到用户 .npmrc 失效本地代理——已过滤 proxy 行并注入 NPM_CONFIG_USERCONFIG=${stub}`)
    return env
  } catch {
    return env
  }
}

// ---------------------------------------------------------------------------
// 0. 前置检查
// ---------------------------------------------------------------------------
const pgBin = join(stageDir, 'pg', 'native', 'bin', process.platform === 'win32' ? 'postgres.exe' : 'postgres')
if (!existsSync(pgBin)) {
  fail(`内嵌 PG 二进制未就位（${pgBin}）——先跑 pnpm --filter @dagents/desktop run ensure:postgres`)
}
// deploy 拷贝的是 workspace 包当前状态——dist 必须已构建（turbo build --filter='!@dagents/desktop'）
for (const pkg of ['contracts', 'shared', 'db', 'workflow', 'agent-adapters']) {
  if (!existsSync(join(repoRoot, 'packages', pkg, 'dist', 'index.js'))) {
    fail(
      `packages/${pkg}/dist 缺失——先跑 pnpm run build --filter='!@dagents/desktop'（deploy 拷贝 workspace 包当前产物）`
    )
  }
}

// 幂等：services 全量重建。已知 win 噪声：偶发空目录被系统进程短暂锁住
// （EBUSY/另一个程序正在使用）——逐子项清理，EBUSY 且已空的子目录保留壳继续
// （deploy 会重建内容），非空残留才视为真失败（防新旧产物混装）。
mkdirSync(servicesDir, { recursive: true })
for (const child of readdirSync(servicesDir)) {
  const childPath = join(servicesDir, child)
  try {
    rmSync(childPath, { recursive: true, force: true })
  } catch (e) {
    const left = readdirSync(childPath)
    if (left.length > 0) {
      fail(
        `清理 ${childPath} 失败（${e.code}）且残留非空——请关闭占用该目录的程序（终端 cd / 资源管理器）后重试`
      )
    }
    say(`旧 ${child} 目录删除遇 ${e.code}（已空，保留壳继续——后续步骤将重建内容）`)
  }
}

// ---------------------------------------------------------------------------
// 1. gateway：pnpm deploy --prod --legacy（pnpm 10 语义；linux 加 ignore-scripts=false
//    让 onlyBuiltDependencies=[node-pty] 白名单放行编译——Dockerfile L47-48 同款）。
//    注意：deploy 目标必须直落最终路径——产出的绝对 junction 一经 move 目标即断。
// ---------------------------------------------------------------------------
say('== gateway：pnpm deploy --prod --legacy ==')
const gwDir = join(servicesDir, 'gateway')
const deployArgs = ['--filter', '@dagents/gateway', 'deploy', '--prod', '--legacy', relativeFromRepo(gwDir)]
if (IS_LINUX) deployArgs.push('--config.ignore-scripts=false')
const env = pnpmEnv()
const deploy = run('pnpm', deployArgs, { env })
if (deploy.status !== 0) fail(`gateway deploy 退出码 ${deploy.status}`)

// 裁剪：deploy 树携带了项目源文件（src/tsconfig/vitest.config）——运行时无用
for (const junk of ['src', 'tsconfig.json', 'vitest.config.ts']) {
  rmSync(join(gwDir, junk), { recursive: true, force: true })
}

// 结构断言（运行时编排的硬依赖：入口/迁移/库根/node-pty prebuilds）
for (const must of [
  join(gwDir, 'dist', 'index.js'),
  join(gwDir, 'node_modules', '@dagents', 'db', 'scripts', 'migrate.mjs'),
  join(gwDir, 'node_modules', 'pg'),
  join(gwDir, 'builtin-library'),
  join(gwDir, 'quickstart-library'),
  join(gwDir, 'node_modules', 'node-pty'),
]) {
  if (!existsSync(must)) fail(`gateway deploy 树缺 ${must}`)
}
// pnpm → npm 平铺（同 console：分发链 deref 链接后防断链；gateway 顶层多为直接依赖，
// 此步兜底间接依赖与懒加载模块）
flattenPnpmToTopLevel(join(gwDir, 'node_modules'))
sweepEscapingLinks(gwDir, 'gateway')
assertNoDeadLinks(join(gwDir, 'node_modules'), 'gateway')
say(`gateway 树就位：${gwDir}`)

// ---------------------------------------------------------------------------
// 2. console：NEXT_DIST_DIR=.next-build next build → standalone 三件套
// ---------------------------------------------------------------------------
say(`== console：standalone 构建（${DIST_DIR}）==`)
// next build 会自改 tsconfig 的 include（把 <distDir>/types 加进去）——构建前备份、
// 构建后还原，保持工作树干净（CI checkout 无所谓，本地反复 staging 不该弄脏 git status）
const tsconfigPath = join(repoRoot, 'apps', 'console', 'tsconfig.json')
const tsconfigBackup = existsSync(tsconfigPath) ? readFileSync(tsconfigPath, 'utf8') : null
const build = run('pnpm', ['--filter', '@dagents/console', 'exec', 'next', 'build'], {
  env: { ...process.env, NEXT_DIST_DIR: DIST_DIR },
})
if (tsconfigBackup !== null && existsSync(tsconfigPath)) {
  writeFileSync(tsconfigPath, tsconfigBackup)
}
if (build.status !== 0) {
  const out = `${build.stdout || ''}\n${build.stderr || ''}`
  if (/EPERM.*symlink|symlink.*EPERM/.test(out)) {
    fail(
      'standalone 构建踩中 win symlink 权限门（EPERM）——对策：确认 patches/next@15.5.20.patch 已应用' +
        '（git log 后跑 pnpm install），或开启一次 Windows 开发者模式（设置→隐私和安全性→开发者选项）；CI linux/mac 不受影响（docs §11.3/R11）'
    )
  }
  fail(`console 构建退出码 ${build.status}`)
}

const nextBuildDir = join(repoRoot, 'apps', 'console', DIST_DIR)
const standaloneDir = join(nextBuildDir, 'standalone')
// server.js 在 standalone 镜像树的 app 目录直下（distDir 层不镜像入口；server 产物在
// <app>/<distDir>/server/ —— 实测 .next-build/standalone/apps/console/{server.js,.next-build/server/}）
const serverJs = join(standaloneDir, 'apps', 'console', 'server.js')
if (!existsSync(serverJs)) {
  fail(`standalone 入口缺失：${serverJs}（构建 exit 0 但产物不在——检查 outputFileTracingRoot 修复是否在位）`)
}

const csDir = join(servicesDir, 'console')
mkdirSync(csDir, { recursive: true })
// 三件套（docs §11.4 布局）：standalone 镜像树放平 + static/public 摆到 server.js 旁
cpSync(standaloneDir, csDir, { recursive: true })
cpSync(join(nextBuildDir, 'static'), join(csDir, 'apps', 'console', DIST_DIR, 'static'), {
  recursive: true,
})
cpSync(join(repoRoot, 'apps', 'console', 'public'), join(csDir, 'apps', 'console', 'public'), {
  recursive: true,
})

// pnpm 布局规整（关键步骤，M6 实测踩坑）：copyTracedFiles 按 pnpm 原样复建的 junction
// 经 cpSync/electron-builder/NSIS 三层拷贝全部 deref 成实体——next 等包从实体位置向上
// resolve 不到 .pnpm 里的同胞依赖（packaged 安装树实测 Cannot find module 'styled-jsx'）。
// 对策：把 .pnpm/<pkg>@<ver>/node_modules/<pkg> 全量提升（move）到本层 node_modules 顶层
// （npm 平铺布局，同名先到先得并告警——standalone traced 闭包内版本收敛），提升后删 .pnpm。
for (const flatTarget of [
  join(csDir, 'apps', 'console', 'node_modules'),
  join(csDir, 'node_modules'),
]) {
  flattenPnpmToTopLevel(flatTarget)
  assertNoDeadLinks(flatTarget, 'console')
}
sweepEscapingLinks(csDir, 'console')
say(`console 树就位：${csDir}（server.js=${join('apps', 'console', 'server.js')}）`)

// 构建临时目录清理（不污染工作树；dev 的 .next 不受影响——NEXT_DIST_DIR 隔离）
rmSync(nextBuildDir, { recursive: true, force: true })

say(`✅ staging 完成：${servicesDir}（extraResources 取 stage/{pg/native, services} 进安装包）`)
