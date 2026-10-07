#!/usr/bin/env node
/**
 * ensure-postgres.mjs —— 显式按需下载内嵌 Postgres 二进制（docs/desktop-architecture.md §10.1）。
 *
 * 供应链（对齐 ensure-electron.mjs 先例，constraints 第 1 条）：
 *   - 二进制来源 `@embedded-postgres/<platform>-<arch>@16.14.0-beta.17` npm tarball
 *     （主版本 16 对齐 infra postgres:16）。**不进 package.json / lockfile**——主包
 *     embedded-postgres 会把全 8 平台包（96/56/141/141MiB…）拉进 workspace，且平台包
 *     带 postinstall（hydrate-symlinks.js），进依赖图就得论证 install script。
 *   - 只在本脚本被显式调用时下载（dev 前置 / dist:win / CI 打包 job）；
 *     纯检查场景（vitest/tsc/eslint）零触碰；DAGENTS_DESKTOP_SKIP_POSTGRES=1 短路。
 *   - postinstall 的 hydrate-symlinks 由本脚本解包后**显式**以普通脚本方式执行
 *     （node scripts/hydrate-symlinks.js，非 npm 生命周期）——win 上 pg-symlinks.json
 *     为 []（no-op，实测），linux/darwin 可能非空（CI matrix 验证点）。
 *
 * 布局：缓存 tarball 于 stage/pg-cache/，解包于 stage/pg/（package/native/bin 即
 * initdb/postgres/pg_ctl 所在；M6 打包时 extraResources 取 stage/pg/native）。
 * stage/ 已进 .gitignore 与 .dockerignore（R13 双护）。
 */
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const PG_VERSION = '16.14.0-beta.17'

// 平台映射（CI matrix ↔ 包名；windows-arm64 包不存在于 registry——win 目标仅 x64）。
// arch 优先取 DAGENTS_DESKTOP_PG_ARCH（CI 交叉编译场景：desktop.yml 的 mac-x64 job
// 跑在 macos-latest（ARM runner）交叉出 x64 dmg——按运行器 arch 取包会把 darwin-arm64
// 的 PG 二进制打进 x64 安装包；workflow 显式传目标 arch，缺省回落运行器自身）。
function platformPackage() {
  const { platform } = process
  const arch = process.env.DAGENTS_DESKTOP_PG_ARCH || process.arch
  if (platform === 'win32' && arch === 'x64') return 'windows-x64'
  if (platform === 'linux' && arch === 'x64') return 'linux-x64'
  if (platform === 'darwin' && arch === 'x64') return 'darwin-x64'
  if (platform === 'darwin' && arch === 'arm64') return 'darwin-arm64'
  console.error(`[ensure-postgres] 不支持的平台组合：${platform}-${arch}（支持 win32-x64 / linux-x64 / darwin-x64 / darwin-arm64）`)
  process.exit(1)
}

const pkgName = platformPackage()
const scopedName = `@embedded-postgres/${pkgName}`
const mirror = process.env.DAGENTS_DESKTOP_PG_MIRROR || 'https://registry.npmmirror.com'
const pkgRoot = join(dirname(fileURLToPath(import.meta.url)), '..')
const cacheDir = join(pkgRoot, 'stage', 'pg-cache')
const unpackDir = join(pkgRoot, 'stage', 'pg')
const tarballFile = join(cacheDir, `${pkgName}-${PG_VERSION}.tgz`)

// postgres 主二进制名（win 为 postgres.exe，POSIX 为 postgres）
const postgresBin = join(unpackDir, 'native', 'bin', process.platform === 'win32' ? 'postgres.exe' : 'postgres')

function say(msg) {
  console.log(`[ensure-postgres] ${msg}`)
}

function fail(msg) {
  console.error(`[ensure-postgres] ✗ ${msg}`)
  process.exit(1)
}

if (process.env.DAGENTS_DESKTOP_SKIP_POSTGRES === '1') {
  say('DAGENTS_DESKTOP_SKIP_POSTGRES=1，跳过二进制检查')
  process.exit(0)
}

// 幂等：解包产物在位即短路
if (existsSync(postgresBin)) {
  say(`二进制已就位：${postgresBin}`)
  process.exit(0)
}

// registry 元数据（记录 unpackedSize 供体积对账；失败不阻断——下载与解包是硬校验）
// npm registry 约定：scope 保留 @，名字分隔符 %2F（/@embedded-postgres%2Fwindows-x64）
const metaUrl = `${mirror}/@embedded-postgres%2F${pkgName}`
let unpackedSize = null
try {
  const metaRes = await fetch(`${metaUrl}/${PG_VERSION}`, { signal: AbortSignal.timeout(15_000) })
  if (metaRes.ok) {
    const meta = await metaRes.json()
    unpackedSize = meta?.dist?.unpackedSize ?? null
    say(`registry 元数据：${scopedName}@${PG_VERSION} unpackedSize=${unpackedSize ?? '?'}B`)
  } else {
    say(`registry 元数据不可用（HTTP ${metaRes.status}）——继续尝试下载 tarball`)
  }
} catch (e) {
  say(`registry 元数据不可用（${e instanceof Error ? e.message : String(e)}）——继续尝试下载 tarball`)
}

// 下载（带缓存命中）
mkdirSync(cacheDir, { recursive: true })
const tarballUrl = `${mirror}/${scopedName}/-/${pkgName}-${PG_VERSION}.tgz`
if (existsSync(tarballFile)) {
  say(`缓存命中：${tarballFile}（${statSync(tarballFile).size}B）`)
} else {
  say(`下载 ${tarballUrl}（DAGENTS_DESKTOP_PG_MIRROR 可覆盖）`)
  try {
    const res = await fetch(tarballUrl, { signal: AbortSignal.timeout(600_000) })
    if (!res.ok) fail(`下载失败 HTTP ${res.status}——检查网络或用 DAGENTS_DESKTOP_PG_MIRROR 指定可达镜像`)
    const buf = Buffer.from(await res.arrayBuffer())
    writeFileSync(tarballFile, buf)
    say(`下载完成：${buf.length}B → ${tarballFile}`)
  } catch (e) {
    fail(`下载异常：${e instanceof Error ? e.message : String(e)}`)
  }
}

// 解包（系统 tar：win10+ 自带 bsdtar，linux/mac 原生；node 无内置 tar）。
// 坑：win 上 PATH 可能命中 GNU tar（Git 自带），它把 `C:\…` 的冒号解释为远程主机
// （"Cannot connect to C:"）——统一用 cwd + 相对路径（无盘符冒号），bsdtar/GNU 双兼容。
const tarbin = process.platform === 'win32' ? 'tar.exe' : 'tar'
const tarProbe = spawnSync(tarbin, ['--version'], { stdio: 'ignore', timeout: 10_000 })
if (tarProbe.error || tarProbe.status !== 0) {
  fail(`系统缺少 tar（${tarbin}）——win10 1803+ 自带 bsdtar，Linux/macOS 原生；请确认 PATH`)
}
mkdirSync(unpackDir, { recursive: true })
const relTarball = join('stage', 'pg-cache', `${pkgName}-${PG_VERSION}.tgz`)
const relUnpack = join('stage', 'pg')
const extract = spawnSync(
  tarbin,
  ['-xzf', relTarball.split('\\').join('/'), '-C', relUnpack.split('\\').join('/'), '--strip-components=1'],
  { cwd: pkgRoot, stdio: 'inherit', timeout: 300_000 }
)
if (extract.status !== 0) fail(`tar 解包退出码 ${extract.status}（缓存文件可能损坏，可删 ${tarballFile} 后重试）`)

// 结构校验：initdb / postgres / pg_ctl 三件必须在位（pg_isready/psql/createdb 不随包，实测）
const required = ['initdb', 'postgres', 'pg_ctl'].map((n) =>
  join(unpackDir, 'native', 'bin', process.platform === 'win32' ? `${n}.exe` : n)
)
for (const bin of required) {
  if (!existsSync(bin)) fail(`解包产物缺 ${bin}——tarball 结构与预期不符（版本 ${PG_VERSION}）`)
}

// hydrate-symlinks：显式以普通脚本执行（非 npm 生命周期；win 上 json=[] 为 no-op，实测）
const hydrate = [
  join(unpackDir, 'scripts', 'hydrate-symlinks.js'),
  join(unpackDir, 'hydrate-symlinks.js'),
].find((p) => existsSync(p))
if (hydrate) {
  say(`执行 hydrate-symlinks：${hydrate}`)
  const hydrateRes = spawnSync(process.execPath, [hydrate], {
    cwd: unpackDir,
    stdio: 'inherit',
    timeout: 60_000,
  })
  if (hydrateRes.status !== 0) fail(`hydrate-symlinks 退出码 ${hydrateRes.status}`)
} else {
  say('未发现 hydrate-symlinks 脚本——跳过（win 包实测本就为 no-op）')
}

say(`✅ 内嵌 Postgres ${PG_VERSION}（${pkgName}）就位：${join(unpackDir, 'native', 'bin')}`)
