#!/usr/bin/env node
/**
 * generate-icons.mjs —— 三平台真实应用图标生成（体验规格 visualNotes「图标」条 / 验收 D1，U1）。
 *
 * 图形：console 品牌三角标同源（apps/console/src/app/icon.svg 的 agent 三节点图几何），
 * 配色取壳层主题 token：#0f1115 底 + #7aa2f7 节点色（状态页 index.html 的 --bg/--accent，
 * 壳层页面与 console 主题互不影响的原则同样适用于图标）。
 *
 * 产物（electron-builder buildResources 目录 build/，提交进仓库保证 CI 出包确定性）：
 *   build/icon.png  512×512（linux AppImage；亦作 icns 源）
 *   build/icon.ico  16/24/32/48/64/128/256 多尺寸（win 任务栏/开始菜单/安装向导/快捷方式）
 *   build/icon.icns 16…512@2x（mac dock/Finder）
 *
 * 供应链纪律：零依赖（node:zlib + 手写 PNG/ICO/ICNS 编码 + 4×4 超采样软光栅化），
 * 确定性输出（无随机源）；重跑覆盖同字节。用法：node scripts/generate-icons.mjs
 * 自校验：写完逐文件回读（PNG 解码 IHDR/IDAT 抽样像素、ICO/ICNS 头结构）断言通过才退出 0。
 */
import { deflateSync, inflateSync } from 'node:zlib'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const pkgRoot = join(dirname(fileURLToPath(import.meta.url)), '..')
const outDir = join(pkgRoot, 'build')

// ---- 品牌几何（32 视口，与 console icon.svg 同参；颜色换壳层 token） ----
const BG = [0x0f, 0x11, 0x15] // --bg
const NODE = [0x7a, 0xa2, 0xf7] // --accent
const RECT_RADIUS = 7
const STROKE_HALF = 1 // stroke-width 2
const FILLED_CIRCLES = [
  { x: 10, y: 10, r: 2.6 },
  { x: 16, y: 23, r: 2.6 },
]
const STROKED_CIRCLES = [{ x: 22, y: 10, r: 2.6 }]
const SEGMENTS = [
  [11.2, 11.2, 14.8, 20.8],
  [20.8, 11.2, 17.2, 20.8],
  [12.5, 10, 19.5, 10],
]

function insideRoundedRect(px, py) {
  const dx = Math.max(Math.abs(px - 16) - (16 - RECT_RADIUS), 0)
  const dy = Math.max(Math.abs(py - 16) - (16 - RECT_RADIUS), 0)
  return dx * dx + dy * dy <= RECT_RADIUS * RECT_RADIUS
}

function distToSegment(px, py, [x1, y1, x2, y2]) {
  const vx = x2 - x1
  const vy = y2 - y1
  const len2 = vx * vx + vy * vy
  const t = len2 === 0 ? 0 : Math.max(0, Math.min(1, ((px - x1) * vx + (py - y1) * vy) / len2))
  const dx = px - (x1 + t * vx)
  const dy = py - (y1 + t * vy)
  return Math.sqrt(dx * dx + dy * dy)
}

function isGlyph(px, py) {
  for (const c of FILLED_CIRCLES) {
    const d = Math.hypot(px - c.x, py - c.y)
    if (d <= c.r) return true
  }
  for (const c of STROKED_CIRCLES) {
    const d = Math.hypot(px - c.x, py - c.y)
    if (Math.abs(d - c.r) <= STROKE_HALF) return true
  }
  for (const s of SEGMENTS) {
    if (distToSegment(px, py, s) <= STROKE_HALF) return true
  }
  return false
}

/** 软光栅化：size×size RGBA，4×4 超采样抗锯齿（sub = 采样密度，小图标加密到 8）。 */
function renderIcon(size) {
  const sub = size <= 32 ? 8 : 4
  const step = 32 / size
  const rgba = new Uint8Array(size * size * 4)
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      let bgCov = 0
      let glyphCov = 0
      const samples = sub * sub
      for (let sy = 0; sy < sub; sy++) {
        for (let sx = 0; sx < sub; sx++) {
          const px = (x + (sx + 0.5) / sub) * step
          const py = (y + (sy + 0.5) / sub) * step
          if (insideRoundedRect(px, py)) {
            bgCov++
            if (isGlyph(px, py)) glyphCov++
          }
        }
      }
      const bg = bgCov / samples
      const glyph = glyphCov / samples
      const alpha = bg + glyph * (1 - bg)
      const i = (y * size + x) * 4
      if (alpha <= 0) {
        rgba[i] = 0
        rgba[i + 1] = 0
        rgba[i + 2] = 0
        rgba[i + 3] = 0
      } else {
        // 预乘 over 合成：节点色 glyph 叠在底色 rect 之上
        for (let ch = 0; ch < 3; ch++) {
          const blended = (NODE[ch] * glyph + BG[ch] * bg * (1 - glyph)) / alpha
          rgba[i + ch] = Math.round(Math.min(255, Math.max(0, blended)))
        }
        rgba[i + 3] = Math.round(alpha * 255)
      }
    }
  }
  return rgba
}

// ---- PNG 编码（零依赖：IHDR/IDAT/IEND + CRC32 + zlib） ----
const CRC_TABLE = (() => {
  const t = new Uint32Array(256)
  for (let n = 0; n < 256; n++) {
    let c = n
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    t[n] = c >>> 0
  }
  return t
})()

function crc32(buf) {
  let c = 0xffffffff
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8)
  return (c ^ 0xffffffff) >>> 0
}

function chunk(type, data) {
  const out = Buffer.alloc(12 + data.length)
  out.writeUInt32BE(data.length, 0)
  out.write(type, 4, 'ascii')
  data.copy(out, 8)
  out.writeUInt32BE(crc32(out.subarray(4, 8 + data.length)), 8 + data.length)
  return out
}

function encodePNG(size, rgba) {
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(size, 0)
  ihdr.writeUInt32BE(size, 4)
  ihdr[8] = 8 // bit depth
  ihdr[9] = 6 // color type RGBA
  // 每行前置 filter byte 0（None）——本图标相邻行相关性低，None+deflate 足够小
  const raw = Buffer.alloc(size * (size * 4 + 1))
  for (let y = 0; y < size; y++) {
    const rowStart = y * (size * 4 + 1)
    raw[rowStart] = 0
    Buffer.from(rgba.subarray(y * size * 4, (y + 1) * size * 4)).copy(raw, rowStart + 1)
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ])
}

// ---- ICO（BMP DIB 条目：32bpp BGRA 自底向上 + 1bpp AND mask，全平台兼容） ----
function encodeICO(entries) {
  // entries: [{size, pngBuffer}] → 统一转 BMP DIB
  const dibs = entries.map(({ size, rgba }) => {
    const maskRowBytes = ((size + 31) >> 5) << 2
    const maskSize = maskRowBytes * size
    const buf = Buffer.alloc(40 + size * size * 4 + maskSize)
    buf.writeUInt32LE(40, 0) // biSize
    buf.writeInt32LE(size, 4) // biWidth
    buf.writeInt32LE(size * 2, 8) // biHeight（XOR + AND 各一半）
    buf.writeUInt16LE(1, 12) // biPlanes
    buf.writeUInt16LE(32, 14) // biBitCount
    buf.writeUInt32LE(size * size * 4 + maskSize, 20) // biSizeImage
    for (let y = 0; y < size; y++) {
      const srcY = size - 1 - y // 自底向上
      for (let x = 0; x < size; x++) {
        const src = (srcY * size + x) * 4
        const dst = 40 + (y * size + x) * 4
        buf[dst] = rgba[src + 2] // B
        buf[dst + 1] = rgba[src + 1] // G
        buf[dst + 2] = rgba[src] // R
        buf[dst + 3] = rgba[src + 3] // A
      }
    }
    // AND mask 全 0（alpha 由 BGRA 承载；全 0 = 不遮挡）
    return buf
  })
  const header = Buffer.alloc(6 + entries.length * 16)
  header.writeUInt16LE(0, 0) // reserved
  header.writeUInt16LE(1, 2) // type: icon
  header.writeUInt16LE(entries.length, 4)
  let offset = header.length
  const parts = [header]
  entries.forEach((e, i) => {
    const base = 6 + i * 16
    header[base] = e.size >= 256 ? 0 : e.size // width（0 = 256）
    header[base + 1] = e.size >= 256 ? 0 : e.size // height
    header[base + 2] = 0 // colorCount
    header[base + 3] = 0 // reserved
    header.writeUInt16LE(1, base + 4) // planes
    header.writeUInt16LE(32, base + 6) // bitCount
    header.writeUInt32LE(dibs[i].length, base + 8) // bytesInRes
    header.writeUInt32LE(offset, base + 12) // imageOffset
    offset += dibs[i].length
    parts.push(dibs[i])
  })
  return Buffer.concat(parts)
}

// ---- ICNS（PNG 条目：icp4/5/6 + ic07..ic14 覆盖 16…512@2x） ----
function icnsEntry(type, png) {
  const head = Buffer.alloc(8)
  head.write(type, 0, 'ascii')
  head.writeUInt32BE(8 + png.length, 4)
  return Buffer.concat([head, png])
}

function encodeICNS(pngs) {
  const body = Buffer.concat(
    pngs.map(([type, png]) => icnsEntry(type, png))
  )
  const head = Buffer.alloc(8)
  head.write('icns', 0, 'ascii')
  head.writeUInt32BE(8 + body.length, 4)
  return Buffer.concat([head, body])
}

// ---- 自校验：PNG 回读（IHDR 尺寸 + IDAT 解码抽样像素非空） ----
function verifyPNG(png, size) {
  if (png.length < 8 + 12 + 13 + 12 + 12) throw new Error('PNG 过短')
  if (!png.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) {
    throw new Error('PNG 签名错误')
  }
  let off = 8
  let idat = []
  let w = 0
  let h = 0
  while (off < png.length) {
    const len = png.readUInt32BE(off)
    const type = png.subarray(off + 4, off + 8).toString('ascii')
    const data = png.subarray(off + 8, off + 8 + len)
    const crc = png.readUInt32BE(off + 8 + len)
    if (crc32(png.subarray(off + 4, off + 8 + len)) !== crc) throw new Error(`PNG ${type} CRC 错误`)
    if (type === 'IHDR') {
      w = data.readUInt32BE(0)
      h = data.readUInt32BE(4)
      if (data[8] !== 8 || data[9] !== 6) throw new Error('IHDR 非 RGBA8')
    }
    if (type === 'IDAT') idat.push(data)
    off += 12 + len
  }
  if (w !== size || h !== size) throw new Error(`IHDR ${w}×${h} ≠ 期望 ${size}`)
  const raw = inflateSync(Buffer.concat(idat))
  if (raw.length !== size * (size * 4 + 1)) throw new Error('IDAT 解码长度错误')
  // 左上节点（32 视口 (10,10)）必为节点蓝；左上角像素必透明（圆角外）
  const px = Math.round((10 / 32) * size)
  const nodeIdx = px * (size * 4 + 1) + px * 4 + 1
  const [r, g, b] = [raw[nodeIdx], raw[nodeIdx + 1], raw[nodeIdx + 2]]
  if (b <= r) throw new Error(`节点像素 (${r},${g},${b}) 非节点蓝——图形缺失？`)
  const cornerAlpha = raw[1 + 3] // 首行第一像素 alpha
  if (cornerAlpha !== 0) throw new Error(`左上角 alpha=${cornerAlpha} 应为 0（圆角外透明）`)
  return true
}

function verifyICO(ico, sizes) {
  if (ico.readUInt16LE(2) !== 1) throw new Error('ICO type ≠ 1')
  const count = ico.readUInt16LE(4)
  if (count !== sizes.length) throw new Error(`ICO 条目数 ${count} ≠ ${sizes.length}`)
  for (let i = 0; i < count; i++) {
    const e = 6 + i * 16
    const dibSize = ico.readUInt32LE(e + 8) // bytesInRes
    const declared = ico.readUInt32LE(e + 12) // imageOffset
    const dib = ico.subarray(declared, declared + dibSize)
    if (dib.readUInt32LE(0) !== 40) throw new Error(`条目 ${i} 非 BITMAPINFOHEADER(40)`)
    const w = dib.readInt32LE(4)
    const hh = dib.readInt32LE(8)
    if (w !== sizes[i] || hh !== sizes[i] * 2) throw new Error(`条目 ${i} 尺寸 ${w}×${hh} 异常`)
  }
  return true
}

function verifyICNS(icns) {
  if (icns.subarray(0, 4).toString('ascii') !== 'icns') throw new Error('ICNS magic 错误')
  const total = icns.readUInt32BE(4)
  if (total !== icns.length) throw new Error(`ICNS 总长 ${total} ≠ ${icns.length}`)
  return true
}

// ---- 生成 ----
const ICO_SIZES = [16, 24, 32, 48, 64, 128, 256]
const ICON_PNG = 512
const cache = new Map() // size → rgba（同尺寸多格式复用）
const rgbaOf = (size) => {
  if (!cache.has(size)) cache.set(size, renderIcon(size))
  return cache.get(size)
}

mkdirSync(outDir, { recursive: true })

// linux 512 PNG（独立校验）
const png512 = encodePNG(ICON_PNG, rgbaOf(ICON_PNG))
verifyPNG(png512, ICON_PNG)
writeFileSync(join(outDir, 'icon.png'), png512)

// win ico 多尺寸
const ico = encodeICO(ICO_SIZES.map((size) => ({ size, rgba: rgbaOf(size) })))
verifyICO(ico, ICO_SIZES)
writeFileSync(join(outDir, 'icon.ico'), ico)

// mac icns（PNG 条目；1024 = 512@2x）
const icnsTypes = [
  ['icp4', 16],
  ['icp5', 32],
  ['icp6', 64],
  ['ic07', 128],
  ['ic08', 256],
  ['ic09', 512],
  ['ic10', 1024],
  ['ic11', 32],
  ['ic12', 64],
  ['ic13', 256],
  ['ic14', 512],
]
const icns = encodeICNS(icnsTypes.map(([type, size]) => [type, encodePNG(size, rgbaOf(size))]))
verifyICNS(icns)
writeFileSync(join(outDir, 'icon.icns'), icns)

// 顺带产出 favicon 尺寸给壳层启动页用（16/32，dist/renderer 由 sync-renderer 拷贝 html/css——
// 图标走 build/ 源目录由主进程 file:// 直接引用不便，启动页不需要 favicon，省略）

const kb = (buf) => `${(buf.length / 1024).toFixed(1)}KB`
console.log(
  `✓ 图标生成（build/）：icon.png 512×512 ${kb(png512)} · icon.ico ${ICO_SIZES.join('/')} ${kb(ico)} · icon.icns ${icnsTypes.length} 条目 ${kb(icns)}`
)
console.log(`  源自 console 品牌三角标几何（#0f1115 底 + #7aa2f7 节点）——确定性输出，重跑同字节`)
